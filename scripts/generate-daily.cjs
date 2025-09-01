/**
 * Daily Five generator with local fallback
 * - Tries OpenTDB politely (sequential + backoff)
 * - If SKIP_API=1 or API keeps 429ing, uses local pools in /pools
 * - Filters/cleans, avoids repeats via used.json, picks 2E/2M/1H
 * - Deterministic option shuffle; writes daily.json (+reroll flag); updates used.json
 * Requires Node >= 20 (native fetch).
 */

const fs = require('fs');
const path = require('path');

// ====== TUNABLES ======
const START_DAY = '20250824';
const ET_TZ = 'America/New_York';
const MAX_LEDGER = null;            // keep all; or set a number
const BASE_TIMEOUT_MS = 12000;
const MAX_RETRIES = 6;
const BACKOFF_BASE_MS = 1000;
const LOCAL_POOLS_DIR = path.resolve('pools'); // <-- local fallback

// Friendly chunk sizes to avoid bursts
const CHUNK_SIZES = { easy: [8], medium: [8], hard: [8] };

// Category allowlist for approachable content
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
function qKeyFromOTDB(q) { // key from OpenTDB shape
  return fnv1a(normalizeText(q.question) + '|' + normalizeText(q.correct_answer));
}
function qKeyFromFinal(q) { // key from final shape
  return fnv1a(normalizeText(q.text) + '|' + normalizeText(q.options[q.correct]));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithBackoff(url, { timeoutMs = BASE_TIMEOUT_MS } = {}) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(id);

      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const base = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 400);
        const wait = Math.max(base + jitter, retryAfter * 1000);
        console.warn(`HTTP ${res.status} on ${url} — backoff ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
        if (attempt === MAX_RETRIES) throw new Error('HTTP ' + res.status);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      clearTimeout(id);
      if (attempt === MAX_RETRIES) throw e;
      const wait = BACKOFF_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
      console.warn(`Fetch error "${e.message}" — retry in ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(wait);
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

// Filters
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

// Fetch OpenTDB (sequential, chunked)
async function fetchPoolFromAPI(difficulty, chunks) {
  const all = [];
  for (const amt of chunks) {
    const url = `https://opentdb.com/api.php?amount=${amt}&type=multiple&difficulty=${difficulty}`;
    const data = await fetchJsonWithBackoff(url);
    const list = Array.isArray(data?.results) ? data.results : [];
    for (const q of list) all.push(basicClean(q));
    await sleep(300);
  }
  return all;
}

// Load local pools
function loadLocalPool(name) {
  const file = path.join(LOCAL_POOLS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr.map(basicClean) : [];
  } catch { return []; }
}

(async () => {
  const today = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');
  const REROLL_NONCE = process.env.REROLL_NONCE || '';
  const SKIP_API = process.env.SKIP_API === '1';

  // Load used ledger
  let used = {};
  try { if (fs.existsSync(usedPath)) used = JSON.parse(fs.readFileSync(usedPath, 'utf8') || '{}'); }
  catch { used = {}; }
  used.seen = used.seen || [];

  let easyPool = [], medPool = [], hardPool = [];
  let apiOk = false;

  try {
    if (!SKIP_API) {
      console.log('Trying OpenTDB…');
      easyPool = await fetchPoolFromAPI('easy', CHUNK_SIZES.easy);
      medPool  = await fetchPoolFromAPI('medium', CHUNK_SIZES.medium);
      hardPool = await fetchPoolFromAPI('hard', CHUNK_SIZES.hard);
      apiOk = true;
    }
  } catch (e) {
    console.warn('OpenTDB failed:', e.message);
  }

  if (!apiOk) {
    console.log('Using LOCAL POOLS from /pools');
    easyPool = loadLocalPool('easy');
    medPool  = loadLocalPool('medium');
    hardPool = loadLocalPool('hard');

    if (easyPool.length + medPool.length + hardPool.length === 0) {
      console.error('No local pools found. Aborting.');
      process.exit(1);
    }
  }

  const seen = new Set(used.seen || []);
  const dedupe = (arr) => {
    const out = [];
    const localSeen = new Set();
    for (const q of arr) {
      const key = qKeyFromOTDB(q);
      if (seen.has(key) || localSeen.has(key)) continue;
      localSeen.add(key);
      out.push(q);
    }
    return out;
  };

  let easy = dedupe(easyPool.filter(passEasyFilter));
  let medium = dedupe(medPool.filter(passEasyFilter));
  let hard = dedupe(hardPool.filter(passEasyFilter));

  // Optional reroll reshuffle
  if (REROLL_NONCE) {
    const ns = parseInt(fnv1a(String(REROLL_NONCE) + today), 16) >>> 0;
    const mix = (arr, salt) => seededShuffle(arr, (ns ^ salt) >>> 0);
    easy = mix(easy, 0x1111);
    medium = mix(medium, 0x2222);
    hard = mix(hard, 0x3333);
  }

  const pick = (arr, n) => arr.slice(0, Math.max(0, Math.min(n, arr.length)));
  let chosen = [
    ...pick(easy, 2),
    ...pick(medium, 2),
    ...pick(hard, 1)
  ];

  if (chosen.length < 5) {
    const already = new Set(chosen.map(qKeyFromOTDB));
    const rest = [...easy, ...medium, ...hard].filter(q => !already.has(qKeyFromOTDB(q)));
    chosen = [...chosen, ...pick(rest, 5 - chosen.length)];
  }

  if (chosen.length < 5) {
    console.error('Not enough questions after filtering. Add more items to /pools.');
    process.exit(1);
  }

  const seedBase = Number(today) ^ (REROLL_NONCE ? (parseInt(fnv1a(REROLL_NONCE),16) >>> 0) : 0);
  const final = chosen.slice(0, 5).map((q, idx) => {
    const rawOpts = [q.correct_answer, ...(q.incorrect_answers || [])];
    const opts = seededShuffle(rawOpts, (seedBase + idx * 7) >>> 0);
    return {
      text: q.question,
      options: opts,
      correct: opts.indexOf(q.correct_answer),
      difficulty: (idx < 2 ? 'easy' : idx < 4 ? 'medium' : 'hard')
    };
  });

  const payload = { day: today, dayIndex, reroll: Boolean(REROLL_NONCE), questions: final };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log('Wrote daily.json for', today, 'dayIndex', dayIndex, 'reroll', Boolean(REROLL_NONCE));

  // Update used.json ledger with final Q keys
  const newKeys = final.map(qKeyFromFinal);
  const merged = [...(used.seen || []), ...newKeys];
  used.seen = MAX_LEDGER ? merged.slice(-MAX_LEDGER) : merged;
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
  console.log('Updated used.json with', newKeys.length, 'entries');
})();
