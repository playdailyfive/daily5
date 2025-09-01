/**
 * Daily Five generator
 * Priority: OpenTDB → local pools → tiny hardcoded fallback
 * Rules:
 * - 5 questions total: 2 easy, 2 medium, 1 hard
 * - Prefer ≥2 General Knowledge
 * - Max 2 from the same category (soft cap; relax if needed)
 * - No repeats (ledger in used.json)
 * - Deterministic per-day option shuffle; support REROLL_NONCE
 *
 * Node 20+ recommended (fetch is built-in).
 */

const fs = require('fs');
const path = require('path');

/* ===================== TUNABLES ===================== */

const START_DAY = '20250824';           // YYYYMMDD baseline (ET)
const ET_TZ     = 'America/New_York';

// Fetch sizes (larger pools give filter room)
const FETCH_SIZES = { easy: 25, medium: 22, hard: 18 };

// Category controls
const GK_NAME = 'General Knowledge';
const GK_MIN  = 2;                      // try to ensure at least 2 GK
const CATEGORY_CAP = 2;                 // soft cap per category

// Simplicity/ease filters
const EASY_FILTER = {
  MAX_QUESTION_LEN: 110,
  MAX_OPTION_LEN: 36,
  BAN_PATTERNS: [
    /\b(in|which|what)\s+year\b/i,
    /\bwhich of (the|these)\b/i,
    /\bfollowing\b/i,
    /\bNOT\b/, /\bEXCEPT\b/,
    /\broman\s+numeral\b/i,
    /\bchemical\b/i, /\bformula\b/i, /\bequation\b/i,
    /\bprime\s+number\b/i,
    /\b(nth|[0-9]{1,4}(st|nd|rd|th))\b.*\bcentury\b/i
  ],
  ALLOW_CATEGORIES: new Set([
    'General Knowledge',
    'Entertainment: Film',
    'Entertainment: Music',
    'Entertainment: Television',
    'Entertainment: Books',
    'Entertainment: Video Games',
    'Science & Nature',
    'Geography',
    'Sports',
    'Celebrities'
  ])
};

// Backoff/retries for OpenTDB
const RETRIES = 3;
const BASE_TIMEOUT_MS = 9000;

/* ===================== UTIL ===================== */

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

// Hash & keys for dedupe
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
function qKeyFromOpenTDB(q) {
  return fnv1a(normalizeText(q.question) + '|' + normalizeText(q.correct_answer || ''));
}
function qKeyFromOutput(q) {
  return fnv1a(normalizeText(q.text) + '|' + normalizeText(q.options[q.correct]));
}

// Deterministic PRNG + shuffle
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

/* ===================== FETCH HELPERS ===================== */

function ensureFetch() {
  if (typeof fetch === 'undefined') {
    throw new Error('fetch is not defined — please run on Node 20+ or enable fetch');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, { timeoutMs = BASE_TIMEOUT_MS, retries = RETRIES } = {}) {
  ensureFetch();
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'accept': 'application/json' } });
      clearTimeout(id);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      clearTimeout(id);
      if (attempt === retries) throw e;
      await sleep(900 * attempt);
    }
  }
}

function decodeHTMLEntities(s='') {
  return s
    .replace(/&quot;/g, '"').replace(/&#039;/g,"'")
    .replace(/&amp;/g,'&').replace(/&rsquo;/g,"'")
    .replace(/&ldquo;/g,'"').replace(/&rdquo;/g,'"')
    .replace(/&eacute;/g,'é').replace(/&hellip;/g,'…')
    .replace(/&mdash;/g,'—').replace(/&ndash;/g,'–')
    .replace(/&nbsp;/g,' ');
}

function cleanOpenTDB(q) {
  return {
    ...q,
    category: q.category,
    question: decodeHTMLEntities(q.question || ''),
    correct_answer: decodeHTMLEntities(q.correct_answer || ''),
    incorrect_answers: (q.incorrect_answers || []).map(decodeHTMLEntities),
    difficulty: (q.difficulty || '').toLowerCase()
  };
}

async function fetchPool(difficulty, amount) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  const data = await fetchJson(url);
  const list = Array.isArray(data?.results) ? data.results : [];
  return list.map(cleanOpenTDB);
}

/* ===================== FILTERS ===================== */

function isRelatableCategory(cat) {
  if (!cat) return true;
  return EASY_FILTER.ALLOW_CATEGORIES.has(cat);
}
function hasBannedPhrase(text) {
  return EASY_FILTER.BAN_PATTERNS.some(rx => rx.test(text));
}
function withinLength(q) {
  const qlen = (q.question || '').trim().length;
  if (qlen > EASY_FILTER.MAX_QUESTION_LEN) return false;
  const all = [q.correct_answer, ...(q.incorrect_answers || [])].filter(Boolean);
  return all.every(opt => String(opt).trim().length <= EASY_FILTER.MAX_OPTION_LEN);
}
function passEasyFilter(q) {
  const qt = q.question || '';
  if (!withinLength(q)) return false;
  if (hasBannedPhrase(qt)) return false;
  if (!isRelatableCategory(q.category)) return false;
  // avoid weird SHOUTING questions
  if ((qt.match(/[A-Z]/g) || []).length > (qt.match(/[a-z]/g) || []).length * 2) return false;
  return true;
}

/* ===================== BUILD SELECTION ===================== */

function pickN(arr, n) { return arr.slice(0, Math.max(0, Math.min(n, arr.length))); }

function buildFive({ easy, medium, hard, seenKeys }) {
  // Deduplicate against used.json and within pools
  const dedupe = (arr) => {
    const out = [];
    const local = new Set();
    for (const q of arr) {
      const key = qKeyFromOpenTDB(q);
      if (seenKeys.has(key) || local.has(key)) continue;
      local.add(key);
      out.push(q);
    }
    return out;
  };

  easy   = dedupe(easy);
  medium = dedupe(medium);
  hard   = dedupe(hard);

  // Prefer ≥2 General Knowledge (from any difficulty)
  const isGK = q => (q.category || '').trim() === GK_NAME;
  const gkPool = [...easy, ...medium, ...hard].filter(isGK);

  // Target counts
  const target = { easy: 2, medium: 2, hard: 1 };

  // Category cap tracker
  const catCount = new Map();
  const incCat = c => catCount.set(c, (catCount.get(c) || 0) + 1);
  const canTake = (c, cap) => (catCount.get(c) || 0) < cap;

  const taken = [];

  // 1) Take GK first up to GK_MIN, preferring easier ones
  const gkEasy   = easy.filter(isGK);
  const gkMedium = medium.filter(isGK);
  const gkHard   = hard.filter(isGK);

  for (const bucket of [gkEasy, gkMedium, gkHard]) {
    while (taken.filter(isGK).length < GK_MIN && bucket.length) {
      const q = bucket.shift();
      if (canTake(q.category || '', CATEGORY_CAP)) {
        taken.push(q);
        incCat(q.category || '');
        // Reduce target bucket count
        if (q.difficulty === 'easy'   && target.easy   > 0) target.easy--;
        else if (q.difficulty === 'medium' && target.medium > 0) target.medium--;
        else if (q.difficulty === 'hard'   && target.hard   > 0) target.hard--;
      }
    }
    if (taken.filter(isGK).length >= GK_MIN) break;
  }

  // 2) Fill remaining by difficulty with category cap
  function takeFrom(pool, howMany) {
    while (howMany > 0 && pool.length) {
      const q = pool.shift();
      if (canTake(q.category || '', CATEGORY_CAP)) {
        taken.push(q);
        incCat(q.category || '');
        howMany--;
      }
    }
    return howMany;
  }

  target.easy   = takeFrom(easy,   target.easy);
  target.medium = takeFrom(medium, target.medium);
  target.hard   = takeFrom(hard,   target.hard);

  // 3) If still short, relax cap and top up from remaining pools
  const remaining = [...easy, ...medium, ...hard];
  while (taken.length < 5 && remaining.length) {
    taken.push(remaining.shift());
  }

  if (taken.length < 5) throw new Error('Not enough questions after filtering/deduping');

  // Trim to exactly 5
  return taken.slice(0, 5);
}

/* ===================== MAIN ===================== */

(async () => {
  const today = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');
  const poolsDir = path.resolve('pools');

  // Manual reroll support (changes order & picks when possible)
  const REROLL_NONCE = process.env.REROLL_NONCE || '';

  // Load ledger
  let used = {};
  try {
    if (fs.existsSync(usedPath)) used = JSON.parse(fs.readFileSync(usedPath, 'utf8') || '{}');
  } catch (_) { used = {}; }
  used.seen = used.seen || [];
  const seenKeys = new Set(used.seen);

  let source = 'OPENTDB';

  try {
    // Try OpenTDB first unless explicitly skipped
    let easy = [], medium = [], hard = [];
    if (!process.env.SKIP_API) {
      const [ePool, mPool, hPool] = await Promise.all([
        fetchPool('easy',   FETCH_SIZES.easy),
        fetchPool('medium', FETCH_SIZES.medium),
        fetchPool('hard',   FETCH_SIZES.hard)
      ]);
      easy   = ePool.filter(passEasyFilter);
      medium = mPool.filter(passEasyFilter);
      hard   = hPool.filter(passEasyFilter);

      // If OpenTDB returned too few usable questions, force fallback to local pools
      if ([...easy, ...medium, ...hard].length < 15) {
        throw new Error('OpenTDB returned too few usable questions');
      }
    } else {
      throw new Error('SKIP_API set — forcing local pools');
    }

    // Build selection
    const chosen = buildFive({ easy, medium, hard, seenKeys });

    // Build final output (deterministic option order)
    const seedBase = Number(today) ^ (REROLL_NONCE ? (parseInt(fnv1a(REROLL_NONCE),16) >>> 0) : 0);
    const final = chosen.map((q, idx) => {
      const opts = seededShuffle([q.correct_answer, ...q.incorrect_answers], (seedBase + idx * 7) >>> 0);
      return {
        text: q.question,
        options: opts,
        correct: opts.indexOf(q.correct_answer),
        difficulty: (q.difficulty || '').toLowerCase() || (idx < 2 ? 'easy' : idx < 4 ? 'medium' : 'hard'),
        category: q.category || ''
      };
    });

    const payload = { day: today, dayIndex, reroll: Boolean(REROLL_NONCE), source, questions: final };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    const newKeys = final.map(q => qKeyFromOutput(q));
    used.seen = [...used.seen, ...newKeys];
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));

    console.log(`Wrote daily.json (${source}) for ${today} (dayIndex ${dayIndex}).`);
    return;
  } catch (apiErr) {
    console.warn('OpenTDB path failed:', apiErr.message);
  }

  // ===== Fallback: local pools =====
  try {
    const easyPath   = path.join(poolsDir, 'easy.json');
    const mediumPath = path.join(poolsDir, 'medium.json');
    const hardPath   = path.join(poolsDir, 'hard.json');

    if (!fs.existsSync(easyPath) || !fs.existsSync(mediumPath) || !fs.existsSync(hardPath)) {
      throw new Error('Local pools missing — expected pools/easy.json, pools/medium.json, pools/hard.json');
    }

    const easy   = JSON.parse(fs.readFileSync(easyPath, 'utf8')   || '[]').map(cleanOpenTDB).filter(passEasyFilter);
    const medium = JSON.parse(fs.readFileSync(mediumPath, 'utf8') || '[]').map(cleanOpenTDB).filter(passEasyFilter);
    const hard   = JSON.parse(fs.readFileSync(hardPath, 'utf8')   || '[]').map(cleanOpenTDB).filter(passEasyFilter);

    const chosen = buildFive({ easy, medium, hard, seenKeys });

    const seedBase = Number(today) ^ (REROLL_NONCE ? (parseInt(fnv1a(REROLL_NONCE),16) >>> 0) : 0);
    const final = chosen.map((q, idx) => {
      const opts = seededShuffle([q.correct_answer, ...q.incorrect_answers], (seedBase + idx * 7) >>> 0);
      return {
        text: q.question,
        options: opts,
        correct: opts.indexOf(q.correct_answer),
        difficulty: (q.difficulty || '').toLowerCase() || (idx < 2 ? 'easy' : idx < 4 ? 'medium' : 'hard'),
        category: q.category || ''
      };
    });

    const payload = { day: today, dayIndex, reroll: Boolean(REROLL_NONCE), source: 'LOCAL_POOLS', questions: final };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    const newKeys = final.map(q => qKeyFromOutput(q));
    used.seen = [...used.seen, ...newKeys];
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));

    console.log(`Wrote daily.json (LOCAL_POOLS) for ${today} (dayIndex ${dayIndex}).`);
    return;
  } catch (poolErr) {
    console.warn('Local pools path failed:', poolErr.message);
  }

  // ===== Last resort: tiny hardcoded demo =====
  try {
    const fallback = {
      day: today,
      dayIndex,
      reroll: Boolean(REROLL_NONCE),
      source: 'HARDCODED',
      questions: [
        { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0, difficulty: "easy", category: GK_NAME },
        { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0, difficulty: "easy", category: GK_NAME },
        { text: "What is H2O commonly called?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0, difficulty: "medium", category: GK_NAME },
        { text: "How many minutes are in an hour?", options: ["60","30","90","120"], correct: 0, difficulty: "medium", category: GK_NAME },
        { text: "Which number is a prime?", options: ["13","21","27","33"], correct: 0, difficulty: "hard", category: GK_NAME }
      ]
    };
    fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2));
    console.log(`Wrote fallback daily.json (HARDCODED) for ${today} (dayIndex ${dayIndex}).`);
  } catch (err) {
    console.error('Failed to write any daily.json:', err);
    process.exit(1);
  }
})();

