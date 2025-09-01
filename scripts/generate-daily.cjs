/**
 * Generate Daily Five:
 * - Fetch pools from OpenTDB (by difficulty)
 * - Filter for readability/ease (length, banned phrases, category allowlist)
 * - Avoid repeats via used.json (stable FNV hash)
 * - Prefer >=2 General Knowledge, then diversify categories
 * - Pick 2 easy, 2 medium, 1 hard (fallbacks)
 * - Deterministically shuffle options per output (seeded; respects REROLL_NONCE)
 * - Write daily.json (with day/dayIndex/difficulty tags + reroll flag)
 * - Update used.json ledger
 * - Optional LLM fallback if OpenTDB is short (requires OPENAI_API_KEY)
 */

const fs = require('fs');
const path = require('path');

// --- fetch polyfill (works on any Node) ---
let fetchRef = globalThis.fetch;
if (!fetchRef) {
  try {
    // undici works with CommonJS require()
    fetchRef = require('undici').fetch;
  } catch (e) {
    console.error('Missing fetch. Run: npm i undici');
    process.exit(1);
  }
}

// ====== TUNABLES ======
const START_DAY = '20250824';                 // Day 1 (YYYYMMDD, ET baseline)
const ET_TZ = 'America/New_York';

const EASY_FILTER = {
  MAX_QUESTION_LEN: 110,
  MAX_OPTION_LEN: 36,
  BAN_PATTERNS: [
    /\b(in|which|what)\s+year\b/i,
    /\bwhich of (the|these)\b/i,
    /\bfollowing\b/i,
    /\bNOT\b/, /\bEXCEPT\b/,
    /\broman\s+numeral\b/i,
    /\bchemical\b/i,
    /\bformula\b/i,
    /\bequation\b/i,
    /\bprime\s+number\b/i,
    /\b(nth|[0-9]{1,4}(st|nd|rd|th))\b.*\bcentury\b/i
  ],
  // Allowed, friendly categories. We heavily favor "General Knowledge".
  ALLOW_CATEGORIES: new Set([
    'General Knowledge',
    'Geography',
    'Science & Nature',
    'Entertainment: Film',
    'Entertainment: Music',
    'Entertainment: Television',
    'Entertainment: Books',
    'Sports',
    'Celebrities'
  ])
};

// How many to fetch per difficulty before filtering
const FETCH_SIZES = { easy: 30, medium: 26, hard: 20 };

// Used ledger: keep everything (tiny file). If you want to trim, set MAX_LEDGER.
const MAX_LEDGER = null; // or a number, e.g., 2000

// Retry/backoff
const RETRIES = 3;
const BASE_TIMEOUT_MS = 9000;

// ====== UTIL ======
function yyyymmdd(d = new Date(), tz = ET_TZ) {
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
function dayIndexFrom(startYmd, todayYmd) {
  const diffDays = Math.max(0, Math.round(
    (toUTCDate(todayYmd) - toUTCDate(startYmd)) / 86400000
  ));
  return 1 + diffDays;
}

// Simple FNV-1a 32-bit hash for dedupe/ledger
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}
function normalizeText(s='') {
  return String(s).replace(/\s+/g,' ').trim().toLowerCase();
}
function qKeyFromRaw(question, correct) {
  return fnv1a(normalizeText(question) + '|' + normalizeText(correct));
}
function qKey(q) { // for OpenTDB objects (question + correct)
  return qKeyFromRaw(q.question || q.text || '', q.correct_answer || '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchJson(url, { timeoutMs = BASE_TIMEOUT_MS, retries = RETRIES } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchRef(url, { signal: ac.signal });
      clearTimeout(id);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      clearTimeout(id);
      if (attempt === retries) throw e;
      await sleep(1000 * attempt);
    }
  }
}

// PRNG + shuffle
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seedNum) {
  const rand = mulberry32(seedNum >>> 0);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ====== FILTERS ======
function isRelatableCategory(cat) {
  if (!cat) return true; // when missing, don’t exclude
  return EASY_FILTER.ALLOW_CATEGORIES.has(cat);
}
function hasBannedPhrase(text) {
  return EASY_FILTER.BAN_PATTERNS.some(rx => rx.test(text));
}
function withinLength(q) {
  const qlen = (q.question || q.text || '').trim().length;
  if (qlen > EASY_FILTER.MAX_QUESTION_LEN) return false;
  const all = [q.correct_answer, ...(q.incorrect_answers || [])].filter(Boolean);
  return all.every(opt => String(opt).trim().length <= EASY_FILTER.MAX_OPTION_LEN);
}
function basicClean(q) {
  // decode common HTML entities from OpenTDB
  const decode = (s='') => s
    .replace(/&quot;/g, '"').replace(/&#039;/g,"'")
    .replace(/&amp;/g,'&').replace(/&rsquo;/g,"'")
    .replace(/&ldquo;/g,'"').replace(/&rdquo;/g,'"')
    .replace(/&eacute;/g,'é').replace(/&hellip;/g,'…')
    .replace(/&mdash;/g,'—').replace(/&ndash;/g,'–')
    .replace(/&nbsp;/g,' ');
  return {
    ...q,
    category: q.category,
    question: decode(q.question || q.text || ''),
    correct_answer: decode(q.correct_answer || ''),
    incorrect_answers: (q.incorrect_answers || []).map(decode)
  };
}
function passEasyFilter(q) {
  const qt = q.question || '';
  if (!withinLength(q)) return false;
  if (hasBannedPhrase(qt)) return false;
  if (!isRelatableCategory(q.category)) return false;
  // avoid “trick” capitalization like ALL CAPS
  if ((qt.match(/[A-Z]/g) || []).length > (qt.match(/[a-z]/g) || []).length * 2) return false;
  return true;
}

// ====== FETCH POOLS ======
async function fetchPool(difficulty, amount) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  const data = await fetchJson(url);
  const list = Array.isArray(data?.results) ? data.results : [];
  return list.map(basicClean);
}

// ====== LLM BACKUP (optional) ======
async function generateWithLLM({ count = 24 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const sys = `You generate family-friendly pub-quiz questions.
Rules:
- Focus on broad, everyday knowledge. Strongly prefer "General Knowledge".
- Avoid niche gaming/anime/lore, ultra-specific dates, and trick questions.
- Keep questions <= 110 chars, options <= 36 chars.
- 4 options, exactly 1 correct (by index 0..3).
- Return ONLY JSON array with objects:
  {"text": "...", "options": ["A","B","C","D"], "correct": 0, "category": "General Knowledge", "difficulty": "easy|medium|hard"}
Generate at least ${count} items; skew EASY, then some MEDIUM, rare HARD.`;

  const payload = {
    model: 'gpt-4o-mini',
    temperature: 0.7,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: 'Output JSON array only. Keep it broad and friendly.' }
    ],
    response_format: { type: 'json_object' }
  };

  const res = await fetchRef('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('LLM HTTP ' + res.status);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '[]';
  let parsed = [];
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) parsed = JSON.parse(m[0]);
  }
  if (!Array.isArray(parsed)) parsed = [];

  // Normalize to our internal OpenTDB-like shape
  return parsed.map(q => ({
    category: q.category || 'General Knowledge',
    question: q.text,
    correct_answer: (q.options || [])[q.correct],
    incorrect_answers: (q.options || []).filter((_, idx) => idx !== q.correct),
    difficulty: (q.difficulty || 'easy').toLowerCase()
  }));
}
function validGen(q) {
  if (!q || !q.question || !q.correct_answer || !Array.isArray(q.incorrect_answers)) return false;
  if (q.incorrect_answers.length !== 3) return false;
  if (!isRelatableCategory(q.category)) return false;
  return passEasyFilter(q);
}

// ====== MAIN ======
(async () => {
  const today = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');

  // Reroll support (manual dispatch). Any non-empty nonce will force different selection.
  const REROLL_NONCE = process.env.REROLL_NONCE || '';

  // Load used ledger
  let used = {};
  try {
    if (fs.existsSync(usedPath)) {
      used = JSON.parse(fs.readFileSync(usedPath, 'utf8') || '{}');
    }
  } catch (_) { used = {}; }
  used.seen = used.seen || [];

  try {
    // 1) Fetch pools
    const [easyPool, medPool, hardPool] = await Promise.all([
      fetchPool('easy', FETCH_SIZES.easy),
      fetchPool('medium', FETCH_SIZES.medium),
      fetchPool('hard', FETCH_SIZES.hard)
    ]);

    // 2) Filter & de-duplicate against used.json
    const seen = new Set(used.seen || []);
    const dedupe = (arr) => {
      const out = [];
      const localSeen = new Set();
      for (const q of arr) {
        const key = qKey(q);
        if (seen.has(key) || localSeen.has(key)) continue;
        localSeen.add(key);
        out.push(q);
      }
      return out;
    };

    const ef = easyPool.filter(passEasyFilter);
    const mf = medPool.filter(passEasyFilter);
    const hf = hardPool.filter(passEasyFilter);

    let easy = dedupe(ef);
    let medium = dedupe(mf);
    let hard = dedupe(hf);

    // 2b) Prefer "General Knowledge" by moving them to the front of each pool
    const favorGK = (arr) => {
      const gk = arr.filter(q => (q.category || '').toLowerCase() === 'general knowledge');
      const rest = arr.filter(q => (q.category || '').toLowerCase() !== 'general knowledge');
      return [...gk, ...rest];
    };
    easy = favorGK(easy);
    medium = favorGK(medium);

    // 2c) If rerolling, reshuffle pools with nonce so repeated runs pick different items
    if (REROLL_NONCE) {
      const nonceSeed = parseInt(fnv1a(String(REROLL_NONCE) + today), 16) >>> 0;
      const mix = (arr, salt) => seededShuffle(arr, (nonceSeed ^ salt) >>> 0);
      easy = mix(easy, 0x1111);
      medium = mix(medium, 0x2222);
      hard = mix(hard, 0x3333);
    }

    // 3) Choose with GK guarantee & category diversity
    const pick = (arr, n) => arr.slice(0, Math.max(0, Math.min(n, arr.length)));

    // Ensure >= 2 GK total (draw from easy/medium first)
    const isGK = (q) => (q.category || '').toLowerCase() === 'general knowledge';
    const needGK = 2;

    const easyGK = easy.filter(isGK);
    const medGK  = medium.filter(isGK);
    const gkPicks = [...pick(easyGK, needGK), ...pick(medGK, Math.max(0, needGK - Math.min(needGK, easyGK.length)))];
    const uniqueGK = [];
    const seenKeysGK = new Set();
    for (const q of gkPicks) {
      const k = qKey(q);
      if (!seenKeysGK.has(k) && uniqueGK.length < needGK) {
        seenKeysGK.add(k);
        uniqueGK.push(q);
      }
    }

    // Fill remaining slots respecting difficulty targets: 2 easy, 2 medium, 1 hard
    const chosen = [];

    // Place guaranteed GK first (they may be easy or medium)
    for (const q of uniqueGK) {
      if (!chosen.find(x => qKey(x) === qKey(q))) chosen.push(q);
    }

    // Helper to add from a pool while avoiding duplicates and overfilling
    const addFrom = (pool, howMany) => {
      for (const q of pool) {
        if (chosen.length >= 5) break;
        const k = qKey(q);
        if (chosen.find(x => qKey(x) === k)) continue;
        chosen.push(q);
        if (--howMany <= 0) break;
      }
    };

    // Make working copies that exclude already-chosen GK
    const dropChosen = (arr) => arr.filter(q => !chosen.find(x => qKey(x) === qKey(q)));
    let easyAvail = dropChosen(easy);
    let medAvail  = dropChosen(medium);
    let hardAvail = dropChosen(hard);

    // Top-up to targets
    addFrom(easyAvail, 2);  // aim for 2 easy total
    easyAvail = dropChosen(easyAvail);

    addFrom(medAvail, 2);   // aim for 2 medium total
    medAvail = dropChosen(medAvail);

    addFrom(hardAvail, 1);  // aim for 1 hard
    hardAvail = dropChosen(hardAvail);

    // If still short, fill from what's left (easy→medium→hard)
    const remainder = [...easyAvail, ...medAvail, ...hardAvail];
    addFrom(remainder, 5 - chosen.length);

    // If still short, try LLM fallback
    if (chosen.length < 5 && process.env.OPENAI_API_KEY) {
      try {
        console.log('Attempting LLM fallback…');
        const gen = await generateWithLLM({ count: 24 });
        const seenAll = new Set([...(used.seen || [])]);
        const llmClean = gen
          .map(basicClean)
          .filter(validGen)
          .filter(q => !seenAll.has(qKey(q)));

        // Prefer GK then others
        const sorted = llmClean.sort((a, b) =>
          ((b.category||'') === 'General Knowledge') - ((a.category||'') === 'General Knowledge')
        );

        for (const q of sorted) {
          if (chosen.length >= 5) break;
          const k = qKey(q);
          if (!chosen.find(x => qKey(x) === k)) chosen.push(q);
        }
      } catch (e) {
        console.warn('LLM fallback failed:', e.message);
      }
    }

    if (chosen.length < 5) throw new Error('Not enough questions after filtering/fallback');

    // 4) Deterministic per-OUTPUT option shuffle.
    const seedBase = Number(today) ^ (REROLL_NONCE ? (parseInt(fnv1a(REROLL_NONCE),16) >>> 0) : 0);

    const final = chosen.slice(0, 5).map((q, idx) => {
      const rawOpts = [q.correct_answer, ...q.incorrect_answers];
      const opts = seededShuffle(rawOpts, (seedBase + idx * 7) >>> 0);
      const correctIdx = opts.indexOf(q.correct_answer);
      const posDiff = (idx < 2 ? 'easy' : idx < 4 ? 'medium' : 'hard');
      return {
        text: q.question,
        options: opts,
        correct: correctIdx,
        difficulty: (q.difficulty || '').toLowerCase() || posDiff,
        category: q.category || 'General Knowledge'
      };
    });

    // 5) Write daily.json
    const payload = { day: today, dayIndex, reroll: Boolean(REROLL_NONCE), questions: final };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('Wrote daily.json for', today, 'dayIndex', dayIndex, 'reroll', Boolean(REROLL_NONCE));

    // 6) Update used.json ledger
    const newKeys = final.map(q => qKeyFromRaw(q.text, q.options[q.correct]));
    const merged = [...(used.seen || []), ...newKeys];
    used.seen = MAX_LEDGER ? merged.slice(-MAX_LEDGER) : merged;
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
    console.log('Updated used.json with', newKeys.length, 'entries. Total seen =', used.seen.length);

  } catch (err) {
    console.warn('Fetch/Build failed:', err.message, '— preserving previous daily.json if present.');
    // If no daily.json exists yet, write a simple fallback so the site still works
    const outPath = path.resolve('daily.json');
    const today = yyyymmdd(new Date(), ET_TZ);
    const dayIndex = dayIndexFrom(START_DAY, today);
    if (!fs.existsSync(outPath)) {
      const fallback = {
        day: today,
        dayIndex,
        questions: [
          { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0, difficulty: "easy", category: "General Knowledge" },
          { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0, difficulty: "easy", category: "Science & Nature" },
          { text: "What is H2O commonly called?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0, difficulty: "medium", category: "Science & Nature" },
          { text: "How many minutes are in an hour?", options: ["60","30","90","120"], correct: 0, difficulty: "medium", category: "General Knowledge" },
          { text: "Which number is a prime?", options: ["13","21","27","33"], correct: 0, difficulty: "hard", category: "General Knowledge" }
        ]
      };
      fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2));
      console.log('Wrote fallback daily.json for', today, 'with dayIndex', dayIndex);
    }
  }
})();
