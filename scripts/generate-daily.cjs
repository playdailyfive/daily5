/**
 * Generate Daily Five:
 * - Fetch pools from OpenTDB (by difficulty)
 * - Filter for readability/ease
 * - Avoid repeats using used.json (hash ledger)
 * - Pick 2 easy, 2 medium, 1 hard (fallbacks)
 * - Deterministically shuffle options per output (seeded)
 * - Write daily.json (with day/dayIndex/difficulty tags + reroll flag)
 * - Update used.json ledger
 */

const fs = require('fs');
const path = require('path');

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

const FETCH_SIZES = { easy: 25, medium: 22, hard: 18 };
const MAX_LEDGER = null;
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

// FNV-1a
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
  if (!cat) return true;
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

    // 2) Filter & de-duplicate
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

    // 2b) If rerolling, randomize the order of each pool with a nonce
    if (REROLL_NONCE) {
      const nonceSeed = fnv1a(String(REROLL_NONCE) + today);
      const ns = parseInt(nonceSeed, 16) >>> 0;
      const mix = (arr, salt) => seededShuffle(arr, (ns ^ salt) >>> 0);
      easy = mix(easy, 0x1111);
      medium = mix(medium, 0x2222);
      hard = mix(hard, 0x3333);
    }

    // 3) Pick 2 easy, 2 medium, 1 hard (fallbacks if scarce)
    const pick = (arr, n) => arr.slice(0, Math.max(0, Math.min(n, arr.length)));
    let chosen = [
      ...pick(easy, 2),
      ...pick(medium, 2),
      ...pick(hard, 1)
    ];

    if (chosen.length < 5) {
      const already = new Set(chosen.map(q => qKey(q)));
      const rest = [...easy, ...medium, ...hard].filter(q => !already.has(qKey(q)));
      chosen = [...chosen, ...pick(rest, 5 - chosen.length)];
    }

    if (chosen.length < 5) {
      const rawRest = [...easyPool, ...medPool, ...hardPool];
      const already = new Set(chosen.map(q => qKey(q)));
      for (const q of rawRest) {
        const key = qKey(q);
        if (!already.has(key) && !seen.has(key)) {
          chosen.push(q);
          if (chosen.length >= 5) break;
        }
      }
    }

    if (chosen.length < 5) throw new Error('Not enough questions after filtering');

    // 4) Deterministic per-OUTPUT option shuffle.
    //    Use today plus an optional nonce so manual rerolls change the options order too.
    const seedBase = Number(today) ^ (REROLL_NONCE ? (parseInt(fnv1a(REROLL_NONCE),16) >>> 0) : 0);

    const final = chosen.slice(0, 5).map((q, idx) => {
      const rawOpts = [q.correct_answer, ...q.incorrect_answers];
      const opts = seededShuffle(rawOpts, (seedBase + idx * 7) >>> 0);
      const correctIdx = opts.indexOf(q.correct_answer);
      return {
        text: q.question,
        options: opts,
        correct: correctIdx,
        difficulty: (q.difficulty || '').toLowerCase() || (idx < 2 ? 'easy' : idx < 4 ? 'medium' : 'hard')
      };
    });

    // 5) Write daily.json
    const payload = { day: today, dayIndex, reroll: Boolean(REROLL_NONCE), questions: final };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('Wrote daily.json for', today, 'dayIndex', dayIndex, 'reroll', Boolean(REROLL_NONCE));

    // 6) Update used.json ledger
    const newKeys = final.map(q => fnv1a(normalizeText(q.text) + '|' + normalizeText(q.options[q.correct])));
    const merged = [...(used.seen || []), ...newKeys];
    used.seen = MAX_LEDGER ? merged.slice(-MAX_LEDGER) : merged;
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
    console.log('Updated used.json with', newKeys.length, 'entries');

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
