/**
 * Generate Daily Five:
 * - Fetch a pool from OpenTDB (by difficulty)
 * - Filter for readability/ease (length, banned phrases)
 * - Avoid repeats using used.json (hash ledger)
 * - Pick 2 easy, 2 medium, 1 hard
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
  // Nicer/more relatable categories; OpenTDB names
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

// How many to fetch per difficulty before filtering
const FETCH_SIZES = { easy: 25, medium: 22, hard: 18 };

// Used ledger: keep everything (tiny file). If you want to trim, set MAX_LEDGER.
const MAX_LEDGER = null; // or a number, e.g., 2000

// Retry/backoff
const RETRIES = 3;
const BASE_TIMEOUT_MS = 9000;

// ====== SMALL BUILT-IN FALLBACK BANK ======
// If OpenTDB fails (rate limit, network), we *still* ship new questions today.
// 10 easy, 8 medium, 6 hard — all short & friendly.
const FALLBACK_BANK = [
  // --- EASY (10) ---
  {t:"What color are bananas when ripe?",o:["Yellow","Blue","Purple","Black"],c:0,d:"easy"},
  {t:"How many days are in a week?",o:["7","5","10","8"],c:0,d:"easy"},
  {t:"Which animal says 'meow'?",o:["Cat","Dog","Cow","Sheep"],c:0,d:"easy"},
  {t:"What do bees make?",o:["Honey","Cheese","Jam","Butter"],c:0,d:"easy"},
  {t:"Which is the largest planet?",o:["Jupiter","Mars","Earth","Venus"],c:0,d:"easy"},
  {t:"What is H2O commonly called?",o:["Water","Oxygen","Salt","Hydrogen"],c:0,d:"easy"},
  {t:"How many minutes are in an hour?",o:["60","30","90","120"],c:0,d:"easy"},
  {t:"What is 2 + 2?",o:["4","3","5","6"],c:0,d:"easy"},
  {t:"Which season is the coldest (in most places)?",o:["Winter","Summer","Spring","Fall"],c:0,d:"easy"},
  {t:"Which shape has 3 sides?",o:["Triangle","Square","Circle","Pentagon"],c:0,d:"easy"},
  // --- MEDIUM (8) ---
  {t:"Which ocean is the largest?",o:["Pacific","Atlantic","Indian","Arctic"],c:0,d:"medium"},
  {t:"What gas do plants breathe in?",o:["Carbon dioxide","Oxygen","Nitrogen","Helium"],c:0,d:"medium"},
  {t:"Which country gifted the Statue of Liberty to the USA?",o:["France","Spain","UK","Canada"],c:0,d:"medium"},
  {t:"How many continents are there?",o:["7","5","6","8"],c:0,d:"medium"},
  {t:"Which instrument has keys, pedals, and strings?",o:["Piano","Flute","Drum","Violin"],c:0,d:"medium"},
  {t:"Which sport uses a shuttlecock?",o:["Badminton","Tennis","Cricket","Baseball"],c:0,d:"medium"},
  {t:"Which metal is liquid at room temperature?",o:["Mercury","Iron","Gold","Aluminum"],c:0,d:"medium"},
  {t:"Which planet is known as the Red Planet?",o:["Mars","Neptune","Saturn","Mercury"],c:0,d:"medium"},
  // --- HARD (6) ---
  {t:"Which country has the most natural lakes?",o:["Canada","USA","Russia","Brazil"],c:0,d:"hard"},
  {t:"Which vitamin do we mainly get from sunlight?",o:["Vitamin D","Vitamin C","Vitamin A","Vitamin B12"],c:0,d:"hard"},
  {t:"The Great Barrier Reef is off the coast of which country?",o:["Australia","New Zealand","Fiji","Indonesia"],c:0,d:"hard"},
  {t:"What is the tallest mammal?",o:["Giraffe","Elephant","Moose","Camel"],c:0,d:"hard"},
  {t:"Which language has the most native speakers?",o:["Mandarin Chinese","English","Spanish","Hindi"],c:0,d:"hard"},
  {t:"What is the capital of Canada?",o:["Ottawa","Toronto","Vancouver","Montreal"],c:0,d:"hard"},
];

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
    question: decode(q.question || q.text || ''),
    correct_answer: decode(q.correct_answer || ''),
    incorrect_answers: (q.incorrect_answers || []).map(decode),
    difficulty: (q.difficulty || q.d || '').toString().toLowerCase()
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

// ====== FALLBACK BUILDER ======
function buildFallback(today, dayIndex, used) {
  // deterministically rotate the fallback bank by dayIndex
  const start = (dayIndex * 3) % FALLBACK_BANK.length;
  const rotated = [...FALLBACK_BANK.slice(start), ...FALLBACK_BANK.slice(0, start)];

  const easy = rotated.filter(q => q.d === 'easy').slice(0, 2);
  const med  = rotated.filter(q => q.d === 'medium').slice(0, 2);
  const hard = rotated.filter(q => q.d === 'hard').slice(0, 1);

  let chosen = [...easy, ...med, ...hard];
  if (chosen.length < 5) {
    const already = new Set(chosen.map(q => q.t + '|' + q.o[q.c]));
    for (const q of rotated) {
      const key = q.t + '|' + q.o[q.c];
      if (!already.has(key)) { chosen.push(q); if (chosen.length >= 5) break; }
    }
  }

  const seed = Number(today);
  const final = chosen.slice(0,5).map((q, idx) => {
    const opts = seededShuffle(q.o, seed + idx * 7);
    const correctIdx = opts.indexOf(q.o[q.c]);
    return { text: q.t, options: opts, correct: correctIdx, difficulty: q.d };
  });

  // update used ledger keys
  const newKeys = final.map(q => fnv1a(normalizeText(q.text) + '|' + normalizeText(q.options[q.correct])));
  const merged = [...(used.seen || []), ...newKeys];
  used.seen = MAX_LEDGER ? merged.slice(-MAX_LEDGER) : merged;

  return { final, used };
}

// ====== MAIN ======
(async () => {
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

    const easy = dedupe(ef);
    const medium = dedupe(mf);
    const hard = dedupe(hf);

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

    // 4) Build output: deterministic shuffle of options per day
    const seed = Number(today);
    const final = chosen.slice(0, 5).map((q, idx) => {
      const rawOpts = [q.correct_answer, ...q.incorrect_answers];
      const opts = seededShuffle(rawOpts, seed + idx * 7);
      const correctIdx = opts.indexOf(q.correct_answer);
      // carry through difficulty if OpenTDB included it; else label by slot
      const diff = (q.difficulty || '').toLowerCase();
      const fallbackDiff = (idx < 2 ? 'easy' : idx < 4 ? 'medium' : 'hard');
      return {
        text: q.question,
        options: opts,
        correct: correctIdx,
        difficulty: diff || fallbackDiff
      };
    });

    // 5) Write daily.json
    const payload = { day: today, dayIndex, questions: final };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('Wrote daily.json for', today, 'with dayIndex', dayIndex);

    // 6) Update used.json ledger
    const newKeys = final.map(q => fnv1a(normalizeText(q.text) + '|' + normalizeText(q.options[q.correct])));
    const merged = [...(used.seen || []), ...newKeys];
    used.seen = MAX_LEDGER ? merged.slice(-MAX_LEDGER) : merged;
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
    console.log('Updated used.json with', newKeys.length, 'entries');

  } catch (err) {
    console.warn('Fetch/Build failed:', err.message, '— switching to FALLBACK bank for today.');
    // NEW: Always write a fresh daily.json even on failure, using fallback bank
    const { final, used: usedAfter } = buildFallback(today, dayIndex, used);

    const payload = { day: today, dayIndex, questions: final };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(usedPath, JSON.stringify(usedAfter, null, 2));

    console.log('Wrote fallback daily.json for', today, 'with dayIndex', dayIndex, '(no API).');
  }
})();
