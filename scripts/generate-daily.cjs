/**
 * Generate daily.json with 5 questions.
 * - Pulls from OpenTrivia API
 * - Deduplicates against used.json ledger
 * - Logs used questions in used.json (so they never repeat)
 * - Falls back to a static set if API fails, and still logs those
 */
const fs = require('fs');
const path = require('path');

const START_DAY = "20250824"; // Day 1 baseline

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

async function fetchWithTimeout(url, { timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchQuestions(retries = 3) {
  const url = 'https://opentdb.com/api.php?amount=5&type=multiple';
  for (let a = 1; a <= retries; a++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data?.results?.length) throw new Error('Bad payload');
      return data.results;
    } catch (e) {
      if (a === retries) throw e;
      await new Promise(r => setTimeout(r, 1200 * a));
    }
  }
}

function loadUsed() {
  const usedPath = path.resolve('used.json');
  if (fs.existsSync(usedPath)) {
    return JSON.parse(fs.readFileSync(usedPath, 'utf8'));
  }
  return [];
}

function saveUsed(used) {
  const usedPath = path.resolve('used.json');
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
}

(async () => {
  const day = yyyymmdd(); // ET
  const seed = Number(day);
  const outPath = path.resolve('daily.json');

  const diffDays = Math.max(0, Math.round(
    (toUTCDate(day) - toUTCDate(START_DAY)) / 86400000
  ));
  const dayIndex = 1 + diffDays;

  let used = loadUsed();
  let newQs = [];

  try {
    const results = await fetchQuestions(3);
    newQs = results.map((q, idx) => {
      const opts = seededShuffle([q.correct_answer, ...q.incorrect_answers], seed + idx * 7);
      const correctIdx = opts.indexOf(q.correct_answer);
      return { text: q.question, options: opts, correct: correctIdx };
    });

    // Filter out duplicates
    newQs = newQs.filter(q => !used.find(u => u.text === q.text));

    if (newQs.length < 5) {
      console.warn("Warning: not enough unique questions, filling with fallback.");
    }

  } catch (err) {
    console.warn('Fetch failed:', err.message, '— using fallback questions.');
    newQs = [
      { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0 },
      { text: "Who painted the Mona Lisa?", options: ["Leonardo da Vinci","Michelangelo","Raphael","Donatello"], correct: 0 },
      { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0 },
      { text: "What is H2O commonly known as?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0 },
      { text: "What is 9 × 9?", options: ["81","72","99","64"], correct: 0 }
    ];
  }

  // Save today’s set
  const payload = { day, dayIndex, questions: newQs };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log('Wrote daily.json for', day, 'with dayIndex', dayIndex);

  // Append to used.json
  used.push(...newQs);
  saveUsed(used);
})();
