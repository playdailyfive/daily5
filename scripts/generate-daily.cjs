/**
 * Daily Five question generator (easier + diverse)
 * - Fetches EASY questions from multiple OpenTDB categories
 * - Scores questions by "simplicity" and prefers easier ones
 * - Ensures diversity across categories (aims 1 per category)
 * - Dedupes against used.json (no repeats)
 * - Deterministically shuffles options per-day (stable for all users)
 * - Writes daily.json with {day, dayIndex, questions}
 *
 * Run locally:  node scripts/generate-daily.cjs
 * GitHub Action: daily-questions.yml already runs this daily on ET midnight
 */
const fs = require('fs');
const path = require('path');

// ---- Configure once ----
const START_DAY = "20250824"; // Day 1 baseline (ET start date)

// Categories to mix in (OpenTDB IDs)
const CATS = [
  9,   // General Knowledge
  22,  // Geography
  21,  // Sports
  17,  // Science & Nature
  18,  // Science: Computers
  11,  // Entertainment: Film
  12,  // Entertainment: Music
  23,  // History
  27   // Animals
];

// How many to pool per category (we’ll fetch more than needed and then pick 5)
const PULL_PER_CAT = 6; // small and quick, total ~54 questions

// ---------------- Utility ----------------
function yyyymmdd(d = new Date(), tz = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}${parts.month}${parts.day}`;
}
function toUTCDate(yyyyMMdd) {
  const y = Number(yyyyMMdd.slice(0,4));
  const m = Number(yyyyMMdd.slice(4,6));
  const d = Number(yyyyMMdd.slice(6,8));
  return new Date(Date.UTC(y, m - 1, d));
}
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seedNum) {
  const rand = mulberry32(seedNum);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Minimal HTML entities decode (OpenTDB encodes some)
function decodeHTMLEntities(str='') {
  const map = {
    '&quot;':'"', '&#039;':"'", '&amp;':'&', '&eacute;':'é',
    '&rsquo;':"’", '&lsquo;':"‘", '&ldquo;':'“', '&rdquo;':'”',
    '&hellip;':'…', '&lt;':'<', '&gt;':'>', '&uuml;':'ü', '&ouml;':'ö',
    '&auml;':'ä', '&ntilde;':'ñ', '&deg;':'°'
  };
  return str.replace(/&[a-zA-Z#0-9]+;/g, m => map[m] || m);
}

async function fetchWithTimeout(url, { timeoutMs = 9000 } = {}) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchCategory(catId, amount = 10, difficulty = 'easy', retries = 2) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}&category=${catId}`;
  for (let a=0; a<=retries; a++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 9000 });
      if (!res.ok) throw new Error('HTTP '+res.status);
      const data = await res.json();
      return data?.results || [];
    } catch (e) {
      if (a === retries) throw e;
      await new Promise(r => setTimeout(r, 700*(a+1)));
    }
  }
}

// ---------- Simplicity scoring (lower = easier) ----------
function simplicityScore(qText, options) {
  const text = qText;
  const len = text.length;

  // Penalize year-like numbers (often trivia that’s harder)
  const hasYear = /\b(18|19|20)\d{2}\b/.test(text);

  // Proper-noun weight: count capitalized words of length >= 3 (rough heuristic)
  const properCount = (text.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;

  // Options average length
  const avgOptLen = options.reduce((a,b)=>a+b.length,0) / Math.max(1,options.length);

  // Punctuation complexity (quotes/colon/parentheses)
  const punct = (text.match(/["“”'’:():-]/g) || []).length;

  // Base = length + options length
  let score = 0.015*len + 0.02*avgOptLen + 0.8*punct + 0.9*properCount;
  if (hasYear) score += 6;               // push down questions with years
  if (len > 120) score += 4;             // long questions feel harder
  if (avgOptLen > 22) score += 2;        // long options can feel harder
  return score;
}

// ---------- Main ----------
(async () => {
  const day = yyyymmdd(); // ET
  const seed = Number(day);
  const outPath = path.resolve('daily.json');

  // GLOBAL day index (1-based) from START_DAY → today
  const diffDays = Math.max(0, Math.round((toUTCDate(day) - toUTCDate(START_DAY)) / 86400000));
  const dayIndex = 1 + diffDays;

  // used.json ledger
  const usedPath = path.resolve('used.json');
  let used = [];
  if (fs.existsSync(usedPath)) {
    try { used = JSON.parse(fs.readFileSync(usedPath, 'utf-8')) || []; }
    catch { used = []; }
  }

  try {
    // 1) Fetch pools from multiple categories (easy only)
    const pools = await Promise.all(CATS.map(id => fetchCategory(id, PULL_PER_CAT, 'easy')));
    // Flatten & normalize
    let all = [];
    pools.forEach((arr, idxCat) => {
      const catId = CATS[idxCat];
      for (const q of arr) {
        const text = decodeHTMLEntities(q.question);
        const optsRaw = [q.correct_answer, ...q.incorrect_answers].map(decodeHTMLEntities);
        all.push({
          catId,
          category: q.category,
          qText: text,
          correctAnswer: decodeHTMLEntities(q.correct_answer),
          optionsRaw: optsRaw
        });
      }
    });

    // 2) Filter out repeats and obvious bad payloads
    all = all.filter(x => x.qText && Array.isArray(x.optionsRaw) && x.optionsRaw.length === 4);
    all = all.filter(x => !used.includes(x.qText));

    if (all.length < 5) {
      // As a safety, if too few remain, refetch a bigger general pool (easy)
      const fallback = await fetchCategory(9, 15, 'easy'); // GK
      const more = fallback.map(q => ({
        catId: 9,
        category: q.category,
        qText: decodeHTMLEntities(q.question),
        correctAnswer: decodeHTMLEntities(q.correct_answer),
        optionsRaw: [q.correct_answer, ...q.incorrect_answers].map(decodeHTMLEntities)
      }));
      all = [...all, ...more].filter(x => !used.includes(x.qText));
    }

    if (all.length === 0) throw new Error("No fresh questions available.");

    // 3) Score by "simplicity"
    for (const q of all) {
      q.score = simplicityScore(q.qText, q.optionsRaw);
    }

    // 4) Prefer lower scores (easier), but keep category diversity
    all.sort((a,b)=> a.score - b.score);

    const chosen = [];
    const seenCats = new Set();

    // First pass: pick easiest unique categories
    for (const q of all) {
      if (chosen.length >= 5) break;
      if (!seenCats.has(q.catId)) {
        chosen.push(q);
        seenCats.add(q.catId);
      }
    }
    // If still < 5, relax category constraint (still easiest-first)
    if (chosen.length < 5) {
      for (const q of all) {
        if (chosen.length >= 5) break;
        if (!chosen.find(x => x.qText === q.qText)) {
          chosen.push(q);
        }
      }
    }

    // 5) Deterministic option shuffle per-day, and build final shape
    const finalQuestions = chosen.slice(0,5).map((q, idx) => {
      const opts = seededShuffle(q.optionsRaw, seed + idx * 7);
      const correctIdx = opts.indexOf(q.correctAnswer);
      return { text: q.qText, options: opts, correct: correctIdx };
    });

    // 6) Write daily.json
    const payload = { day, dayIndex, questions: finalQuestions };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    // 7) Update used.json ledger
    used.push(...finalQuestions.map(q => q.text));
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));

    console.log(`Wrote daily.json for ${day} (dayIndex ${dayIndex}). Picked ${finalQuestions.length} easy & diverse questions.`);
  } catch (err) {
    console.warn('Fetch/Build failed:', err.message, '— preserving previous daily.json if present.');
    if (!fs.existsSync(outPath)) {
      const fallback = {
        day, dayIndex,
        questions: [
          { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0 },
          { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0 },
          { text: "What is H2O commonly known as?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0 },
          { text: "Which animal barks?", options: ["Dog","Cat","Cow","Duck"], correct: 0 },
          { text: "How many days are in a week?", options: ["7","5","6","8"], correct: 0 }
        ]
      };
      fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2));
      console.log('Wrote fallback daily.json for', day, 'with dayIndex', dayIndex);
    }
  }
})();

// touch: force commit
