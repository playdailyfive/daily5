/**
 * Fetch 5 questions from OpenTrivia, normalize, deterministically shuffle
 * options per-day (ET), and write daily.json with a GLOBAL dayIndex.
 * - dayIndex starts at 1 on START_DAY and increments daily for everyone.
 */
const fs = require('fs');
const path = require('path');

// ⬇️ Set this ONCE to the YYYYMMDD of "Day 1"
const START_DAY = "20250824"; // Day 1 = Aug 24, 2025

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

// decode url3986 to plain text
const decode = (s) => decodeURIComponent(s);

async function fetchQuestions(retries = 3) {
  const url = 'https://opentdb.com/api.php?amount=5&type=multiple&encode=url3986';
  for (let a = 1; a <= retries; a++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data?.results?.length) throw new Error('Bad payload');
      return data.results.map(r => {
        const text = decode(r.question);
        const correct = decode(r.correct_answer);
        const incorrect = r.incorrect_answers.map(decode);
        return { text, correct, incorrect };
      });
    } catch (e) {
      if (a === retries) throw e;
      await new Promise(r => setTimeout(r, 1200 * a));
    }
  }
}

(async () => {
  const day = yyyymmdd(); // ET
  const seed = Number(day);
  const outPath = path.resolve('daily.json');

  const diffDays = Math.max(0, Math.round(
    (toUTCDate(day) - toUTCDate(START_DAY)) / 86400000
  ));
  const dayIndex = 1 + diffDays;

  try {
    const results = await fetchQuestions(3);
    const questions = results.map((q, idx) => {
      const opts = seededShuffle([q.correct, ...q.incorrect], seed + idx * 7);
      const correctIdx = opts.indexOf(q.correct);
      return { text: q.text, options: opts, correct: correctIdx };
    });

    const payload = { day, dayIndex, questions };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('Wrote daily.json for', day, 'with dayIndex', dayIndex);

  } catch (err) {
    console.warn('Fetch failed:', err.message, '— preserving previous daily.json if present.');
    if (!fs.existsSync(outPath)) {
      const fallback = {
        day, dayIndex,
        questions: [
          { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0 },
          { text: "Who painted the Mona Lisa?", options: ["Leonardo da Vinci","Michelangelo","Raphael","Donatello"], correct: 0 },
          { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0 },
          { text: "What is H2O commonly known as?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0 },
          { text: "What is 9 × 9?", options: ["81","72","99","64"], correct: 0 }
        ]
      };
      fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2));
      console.log('Wrote fallback daily.json for', day, 'with dayIndex', dayIndex);
    }
    process.exitCode = 1; // mark failure but keep logs
  }
})();
