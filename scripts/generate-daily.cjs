/* scripts/generate-daily.cjs
 * Daily Five generator: relatable + easier mix, no repeats, ET-based, deterministic option shuffle
 */
const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');

// ----- CONFIG -----
const START_DAY = "20250824"; // Day 1 (ET). Keep this fixed once launched.
const LEDGER_MAX = 365 * 2;   // keep ~2 years of hashes

// OpenTDB categories we’ll use (relatable first)
const CATS = {
  GK: 9,   // General Knowledge
  FILM: 11,
  MUSIC: 12,
  TV: 14,
  COMP: 18,
  SPORTS: 21,
  GEO: 22,
  HIST: 23,
};

// The exact daily lineup (easier skew)
const LINEUP = [
  { difficulty: 'easy',   pools: [CATS.GK, CATS.FILM, CATS.TV, CATS.MUSIC] },           // Q1: gimme/pop
  { difficulty: 'easy',   pools: [CATS.SPORTS, CATS.GK, CATS.MUSIC, CATS.TV] },         // Q2: easy sports/brand-ish
  { difficulty: 'medium', pools: [CATS.GEO, CATS.HIST, CATS.GK] },                      // Q3: medium geo/history
  { difficulty: 'medium', pools: [CATS.FILM, CATS.TV, CATS.MUSIC, CATS.COMP, CATS.GK] },// Q4: medium pop/culture
  { difficulty: 'hard',   pools: [CATS.GK, CATS.GEO, CATS.HIST, CATS.SPORTS] },         // Q5: “hard” but still relatable
];

// ----- ET day helpers -----
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

// ----- small utilities -----
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
// tiny entity decode (enough for OpenTDB payload)
function decodeEntities(s='') {
  return s
    .replace(/&quot;/g,'"')
    .replace(/&#039;/g,"'")
    .replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/&eacute;/g,'é')
    .replace(/&ldquo;/g,'“')
    .replace(/&rdquo;/g,'”')
    .replace(/&lsquo;/g,'‘')
    .replace(/&rsquo;/g,'’');
}
// quick stable-ish hash of the question text
function hashText(s) {
  let h = 2166136261 >>> 0; // FNV-1a base
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ----- I/O helpers -----
const ROOT = process.cwd();
const DAILY_PATH = path.resolve(ROOT, 'daily.json');
const USED_PATH  = path.resolve(ROOT, 'used.json');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// ----- OpenTDB fetch with retries/429 handling -----
async function fetchWithTimeout(url, { timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(id); }
}
async function getFromOTDB({ amount = 10, category, difficulty }, retries = 3) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}&category=${category}`;
  for (let a = 1; a <= retries; a++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 9000 });
      if (res.status === 429) throw new Error('429');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data?.results) throw new Error('bad payload');
      return data.results.map(r => ({
        text: decodeEntities(r.question),
        correct_answer: decodeEntities(r.correct_answer),
        incorrect_answers: r.incorrect_answers.map(decodeEntities),
        category,
        difficulty
      }));
    } catch (e) {
      if (a === retries) throw e;
      await new Promise(r => setTimeout(r, 1200 * a)); // backoff
    }
  }
}

// Try to pick one question for a slot, avoiding repeats
async function pickForSlot(slot, usedSet) {
  // shuffle category pool to spread variety day-to-day
  const cats = seededShuffle(slot.pools, Number(yyyymmdd()));
  for (const cat of cats) {
    // fetch a small batch from this category/difficulty
    const batch = await getFromOTDB({ amount: 10, category: cat, difficulty: slot.difficulty });
    // filter out used, prefer broad/short questions
    const fresh = batch.filter(q => !usedSet.has(hashText(q.text)));
    // soft sort: shorter, simpler first
    fresh.sort((a,b) => a.text.length - b.text.length);
    if (fresh.length) {
      const q = fresh[0];
      const options = seededShuffle([q.correct_answer, ...q.incorrect_answers], Number(yyyymmdd()) + cat);
      return {
        text: q.text,
        options,
        correct: options.indexOf(q.correct_answer),
        difficulty: slot.difficulty
      };
    }
    // else try next category
  }
  return null;
}

(async () => {
  const day = yyyymmdd(); // ET today
  const seed = Number(day);
  const diffDays = Math.max(0, Math.round((toUTCDate(day) - toUTCDate(START_DAY)) / 86400000));
  const dayIndex = 1 + diffDays;

  // read used ledger (array of {h, t, d?})
  const used = readJSON(USED_PATH, []);
  const usedSet = new Set(used.map(x => x.h));

  try {
    const chosen = [];
    for (let s = 0; s < LINEUP.length; s++) {
      const slot = LINEUP[s];
      const pick = await pickForSlot(slot, usedSet);
      if (!pick) throw new Error(`no fresh question for slot ${s+1}`);
      chosen.push(pick);
      // reserve its hash immediately to avoid duplicates inside the same day
      const h = hashText(pick.text);
      usedSet.add(h);
      used.push({ h, t: pick.text, d: day });
    }

    // cap ledger size
    if (used.length > LEDGER_MAX) {
      used.splice(0, used.length - LEDGER_MAX);
    }

    // write outputs
    writeJSON(DAILY_PATH, { day, dayIndex, questions: chosen });
    writeJSON(USED_PATH, used);

    console.log(`Wrote daily.json for ${day} (Day #${dayIndex}) with ${chosen.length} questions.`);
  } catch (err) {
    console.warn('Fetch/Build failed:', err.message, '— preserving previous daily.json if present.');
    // If daily.json missing entirely, write a simple fallback so site still works
    if (!fs.existsSync(DAILY_PATH)) {
      const fallback = {
        day, dayIndex,
        questions: [
          { text: "Which city is home to the Eiffel Tower?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0, difficulty: "easy" },
          { text: "What do bees make?", options: ["Honey","Milk","Silk","Oil"], correct: 0, difficulty: "easy" },
          { text: "Which planet is called the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0, difficulty: "medium" },
          { text: "Who painted the Mona Lisa?", options: ["Leonardo da Vinci","Michelangelo","Raphael","Donatello"], correct: 0, difficulty: "medium" },
          { text: "What is H2O commonly known as?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0, difficulty: "hard" }
        ]
      };
      writeJSON(DAILY_PATH, fallback);
      console.log('Wrote fallback daily.json.');
    }
    process.exitCode = 0; // don’t fail the Action if we still have yesterday’s file
  }
})();

