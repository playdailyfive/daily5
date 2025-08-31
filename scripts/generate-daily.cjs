/**
 * Generate Daily Five:
 * - Fetch a pool from OpenTDB (by difficulty)
 * - Filter for readability/ease (length, banned phrases)
 * - Avoid repeats using used.json (hash ledger)
 * - Pick >=2 from "General Knowledge" (prefer easy→medium→hard), then diversify others
 * - Deterministically shuffle options per day
 * - Write daily.json (with day/dayIndex/difficulty tags)
 * - Update used.json ledger
 *
 * Node 20+ / CommonJS
 */

const fs = require('fs');
const path = require('path');

// ====== TUNABLES ======
const START_DAY = '20250824';                 // Day 1 (YYYYMMDD, ET baseline)
const ET_TZ = 'America/New_York';

// Make questions broadly easier & relatable
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
  // Allowed OpenTDB categories (removed Books + Video Games)
  ALLOW_CATEGORIES: new Set([
    'General Knowledge',
    'Entertainment: Film',
    'Entertainment: Music',
    'Entertainment: Television',
    'Science & Nature',
    'Geography',
    'Sports',
    'Celebrities'
  ])
};

// How many to fetch per difficulty before filtering
const FETCH_SIZES = { easy: 28, medium: 24, hard: 18 };

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
function qKey(q) { // stable key from text + correct answer
  return fnv1a(normalizeText(q.question || q.text) + '|' + normalizeText(q.correct_answer || ''));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchJson(url, { timeoutMs = BASE_TIMEOUT_MS, retries = RETRIES } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
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

// Deterministic per-day option shuffle
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
    difficulty: (q.difficulty || '').toLowerCase(),
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
  // Pull a broad pool to allow filtering
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  const data = await fetchJson(url);
  const list = Array.isArray(data?.results) ? data.results : [];
  return list.map(basicClean);
}

// ====== SELECTION HELPERS ======
function dedupeAgainstSeen(arr, seenGlobal) {
  const out = [];
  const localSeen = new Set();
  for (const q of arr) {
    const key = qKey(q);
    if (seenGlobal.has(key) || localSeen.has(key)) continue;
    localSeen.add(key);
    out.push(q);
  }
  return out;
}

function takeUpTo(arr, n) {
  return arr.slice(0, Math.max(0, Math.min(n, arr.length)));
}

function gradeLabel(d) {
  // normalize difficulty to one of easy/medium/hard
  return d === 'easy' || d === 'medium' || d === 'hard' ? d : 'medium';
}

// Force ≥2 General Knowledge. Prefer easy→medium→hard for GK.
// Diversify remaining picks across categories (avoid dupes when possible).
function pickFive(easy, medium, hard) {
  const all = [...easy, ...medium, ...hard];

  const isGK = q => (q.category || '').trim() === 'General Knowledge';

  const gkEasy = easy.filter(isGK);
  const gkMed  = medium.filter(isGK);
  const gkHard = hard.filter(isGK);

  const picks = [];

  // 1) Force 2 General Knowledge
  const needGK = 2;
  let gkTaken = 0;

  for (const source of [gkEasy, gkMed, gkHard]) {
    for (const q of source) {
      if (gkTaken >= needGK) break;
      picks.push(q); gkTaken++;
    }
    if (gkTaken >= needGK) break;
  }

  // 2) Fill remaining slots (3) from non-GK with diversity
  const remainingSlots = Math.max(0, 5 - picks.length);
  const already = new Set(picks.map(q => qKey(q)));

  // Build a list of non-GK candidates, easy-first bias, then medium, then hard
  const nonGK = [
    ...easy.filter(q => !isGK(q)),
    ...medium.filter(q => !isGK(q)),
    ...hard.filter(q => !isGK(q))
  ];

  const usedCats = new Set(picks.map(q => q.category || ''));
  for (const q of nonGK) {
    if (picks.length >= 5) break;
    const key = qKey(q);
    if (already.has(key)) continue;
    const cat = q.category || '';
    // Try to avoid duplicate categories among non-GK picks
    if (!usedCats.has(cat)) {
      picks.push(q);
      already.add(key);
      usedCats.add(cat);
    }
  }

  // If still short, allow same-category fills
  if (picks.length < 5) {
    for (const q of nonGK) {
      if (picks.length >= 5) break;
      const key = qKey(q);
      if (!already.has(key)) {
        picks.push(q);
        already.add(key);
      }
    }
  }

  // Final guard: still short? Top up from any remaining pool
  if (picks.length < 5) {
    for (const q of all) {
      if (picks.length >= 5) break;
      const key = qKey(q);
      if (!already.has(key)) {
        picks.push(q);
        already.add(key);
      }
    }
  }

  return picks.slice(0, 5);
}

// ====== MAIN ======
;(async () => {
  const today = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');

  // Load used ledger
  let used = {};
  try {
    if (fs.existsSync(usedPath)) {
      used = JSON.parse(fs.readFileSync(usedPath, 'utf8') || '{}');
    }
  } catch (_) { used = {}; }
  used.seen = used.seen || []; // array of hashes

  try {
    // 1) Fetch pools
    const [easyPool, medPool, hardPool] = await Promise.all([
      fetchPool('easy', FETCH_SIZES.easy),
      fetchPool('medium', FETCH_SIZES.medium),
      fetchPool('hard', FETCH_SIZES.hard)
    ]);

    // 2) Filter & de-duplicate
    const seen = new Set(used.seen || []);
    const ef = easyPool.filter(passEasyFilter);
    const mf = medPool.filter(passEasyFilter);
    const hf = hardPool.filter(passEasyFilter);

    const easy   = dedupeAgainstSeen(ef, seen);
    const medium = dedupeAgainstSeen(mf, seen);
    const hard   = dedupeAgainstSeen(hf, seen);

    // 3) Choose 5 with ≥2 General Knowledge and diversified others
    let chosen = pickFive(easy, medium, hard);

    if (chosen.length < 5) throw new Error('Not enough questions after filtering');

    // 4) Build output: deterministic shuffle of options per day
    const seed = Number(today);
    const final = chosen.slice(0, 5).map((q, idx) => {
      const rawOpts = [q.correct_answer, ...q.incorrect_answers];
      const opts = seededShuffle(rawOpts, seed + idx * 7);
      const correctIdx = opts.indexOf(q.correct_answer);
      return {
        text: q.question,
        options: opts,
        correct: correctIdx,
        // keep original difficulty if present; otherwise infer by position
        difficulty: gradeLabel(q.difficulty || (idx < 2 ? 'easy' : idx < 4 ? 'medium' : 'hard'))
      };
    });

    // 5) Write daily.json
    const payload = { day: today, dayIndex, questions: final };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('Wrote daily.json for', today, 'with dayIndex', dayIndex);

    // 6) Update used.json ledger
    const newKeys = final.map(q =>
      fnv1a(normalizeText(q.text) + '|' + normalizeText(q.options[q.correct]))
    );
    const merged = [...(used.seen || []), ...newKeys];
    used.seen = MAX_LEDGER ? merged.slice(-MAX_LEDGER) : merged;
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
    console.log('Updated used.json with', newKeys.length, 'entries');

  } catch (err) {
    console.warn('Fetch/Build failed:', err.message, '— preserving previous daily.json if present.');
    // If no daily.json exists yet, write a simple fallback so the site still works
    if (!fs.existsSync(outPath)) {
      const fallback = {
        day: today,
        dayIndex,
        questions: [
          { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0, difficulty: "easy" },
          { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0, difficulty: "easy" },
          { text: "What is H2O commonly called?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0, difficulty: "medium" },
          { text: "How many minutes are in an hour?", options: ["60","30","90","120"], correct: 0, difficulty: "medium" },
          { text: "Which number is a prime?", options: ["13","21","27","33"], correct: 0, difficulty: "hard" }
        ]
      };
      fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2));
      console.log('Wrote fallback daily.json for', today, 'with dayIndex', dayIndex);
    }
  }
})();
