/**
 * Generate Daily Five (easy-only version):
 * - Fetch a pool of easy questions from OpenTDB
 * - Filter for readability/ease (length, banned phrases, categories)
 * - Avoid repeats using used.json (hash ledger)
 * - Pick 5 easy questions
 * - Deterministically shuffle options per day
 * - Write daily.json (with day/dayIndex)
 * - Update used.json ledger
 */

const fs = require('fs');
const path = require('path');

const START_DAY = '20250824'; // Day 1
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
    /\bprime\s+number\b/i
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

const FETCH_SIZE = 40; // fetch a big pool of easy questions
const RETRIES = 3;
const BASE_TIMEOUT_MS = 9000;

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
function qKey(q) {
  return fnv1a(normalizeText(q.question) + '|' + normalizeText(q.correct_answer));
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
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

function basicClean(q) {
  const decode = (s='') => s
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'")
    .replace(/&amp;/g,'&');
  return {
    ...q,
    question: decode(q.question || ''),
    correct_answer: decode(q.correct_answer || ''),
    incorrect_answers: (q.incorrect_answers || []).map(decode)
  };
}
function withinLength(q) {
  const qlen = (q.question || '').length;
  if (qlen > EASY_FILTER.MAX_QUESTION_LEN) return false;
  const all = [q.correct_answer, ...(q.incorrect_answers||[])];
  return all.every(opt => String(opt).length <= EASY_FILTER.MAX_OPTION_LEN);
}
function hasBannedPhrase(text) {
  return EASY_FILTER.BAN_PATTERNS.some(rx => rx.test(text));
}
function passEasyFilter(q) {
  if (!withinLength(q)) return false;
  if (hasBannedPhrase(q.question)) return false;
  if (!EASY_FILTER.ALLOW_CATEGORIES.has(q.category)) return false;
  return true;
}

(async () => {
  const today = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');

  let used = {};
  try { if (fs.existsSync(usedPath)) used = JSON.parse(fs.readFileSync(usedPath,'utf8')); } catch {}
  used.seen = used.seen || [];

  try {
    const url = `https://opentdb.com/api.php?amount=${FETCH_SIZE}&type=multiple&difficulty=easy`;
    const pool = (await fetchJson(url))?.results || [];
    const cleaned = pool.map(basicClean).filter(passEasyFilter);

    // Dedupe against used
    const seen = new Set(used.seen);
    const unique = cleaned.filter(q => !seen.has(qKey(q)));

    if(unique.length < 5) throw new Error("Not enough fresh easy questions");

    const seed = Number(today);
    const chosen = unique.slice(0,5).map((q, idx) => {
      const opts = seededShuffle([q.correct_answer, ...q.incorrect_answers], seed+idx*7);
      return {
        text: q.question,
        options: opts,
        correct: opts.indexOf(q.correct_answer),
        difficulty: "easy"
      };
    });

    fs.writeFileSync(outPath, JSON.stringify({ day: today, dayIndex, questions: chosen }, null, 2));
    console.log("Wrote easy daily.json for", today);

    // update used.json
    used.seen.push(...chosen.map(q => qKey({ question:q.text, correct_answer:q.options[q.correct] })));
    fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
  } catch(e) {
    console.error("Failed to fetch/build:", e.message);
  }
})();
