/**
 * Generate today's questions in progressive difficulty:
 * Q1–Q2 = easy, Q3–Q4 = medium, Q5 = hard.
 *
 * - Deterministic option order per-day (stable share grids).
 * - Global dayIndex starts at 1 on START_DAY (ET) and increments daily.
 * - If fetching fails, keep existing daily.json (or write a progressive fallback).
 */

const fs = require('fs');
const path = require('path');

// ⬇️ Set this ONCE to the YYYYMMDD of “Day 1” (Eastern Time)
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

// Deterministic RNG + shuffle (mulberry32)
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

// Timed fetch with retries
async function fetchWithTimeout(url, { timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}
async function fetchJSON(url, retries = 3) {
  for (let a = 1; a <= retries; a++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 9000 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data;
    } catch (e) {
      if (a === retries) throw e;
      await new Promise(r => setTimeout(r, 1200 * a));
    }
  }
}

// Fetch N questions of a given difficulty from OpenTDB
async function fetchSet(difficulty, amount) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&encode=url3986&difficulty=${difficulty}`;
  const data = await fetchJSON(url, 3);
  if (!data?.results?.length || data.response_code !== 0) {
    throw new Error(`OpenTDB error for ${difficulty} x${amount}`);
  }
  // Keep URL-encoded form now, decode later in a consistent way
  return data.results.map(q => ({
    text: decodeURIComponent(q.question),
    correct_answer: decodeURIComponent(q.correct_answer),
    incorrect_answers: q.incorrect_answers.map(decodeURIComponent),
    difficulty
  }));
}

(async () => {
  const day = yyyymmdd(); // Eastern Time
  const seed = Number(day);
  const outPath = path.resolve('daily.json');

  // Compute GLOBAL day index (1-based) from START_DAY → today
  const diffDays = Math.max(0, Math.round(
    (toUTCDate(day) - toUTCDate(START_DAY)) / 86400000
  ));
  const dayIndex = 1 + diffDays;

  try {
    // Progressive set: 2 easy, 2 medium, 1 hard (in that order)
    const [easy, medium, hard] = await Promise.all([
      fetchSet('easy', 2),
      fetchSet('medium', 2),
      fetchSet('hard', 1),
    ]);

    const ordered = [...easy, ...medium, ...hard];

    // Deterministic per-day option order; keep `correct` index aligned
    const questions = ordered.map((q, idx) => {
      const opts = seededShuffle(
        [q.correct_answer, ...q.incorrect_answers],
        seed + idx * 7
      );
      const correctIdx = opts.indexOf(q.correct_answer);
      return {
        text: q.text,
        options: opts,
        correct: correctIdx,
        difficulty: q.difficulty // nice-to-have; frontend can ignore
      };
    });

    const payload = { day, dayIndex, questions };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log('Wrote daily.json for', day, 'with dayIndex', dayIndex);

  } catch (err) {
    console.warn('Fetch failed:', err.message, '— preserving previous daily.json if present.');

    // If daily.json exists, keep it. Otherwise write a progressive fallback.
    if (!fs.existsSync(outPath)) {
      const fallback = {
        day, dayIndex,
        questions: [
          // Q1–Q2 easy
          { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0, difficulty: "easy" },
          { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0, difficulty: "easy" },
          // Q3–Q4 medium
          { text: "Who painted the Mona Lisa?", options: ["Leonardo da Vinci","Michelangelo","Raphael","Donatello"], correct: 0, difficulty: "medium" },
          { text: "What is H2O commonly known as?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0, difficulty: "medium" },
          // Q5 hard
          { text: "What is 9 × 9?", options: ["81","72","99","64"], correct: 0, difficulty: "hard" }
        ]
      };
      fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2));
      console.log('Wrote fallback daily.json for', day, 'with dayIndex', dayIndex);
    }
  }
})();
