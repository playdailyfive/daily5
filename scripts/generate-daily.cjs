/**
 * Generate 5 daily trivia questions:
 * - 2 easy, 2 medium, 1 hard
 * - Deterministically shuffled per-day
 * - Tracks previously used questions in used.json to avoid repeats
 */

const fs = require('fs');
const path = require('path');

const START_DAY = "20250824"; // Day 1 baseline
const outPath = path.resolve('daily.json');
const usedPath = path.resolve('used.json');

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

async function fetchSet(difficulty, amount) {
  const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data?.results?.length) throw new Error('Bad payload');
  return data.results.map(q => ({ ...q, difficulty }));
}

(async () => {
  const day = yyyymmdd();
  const seed = Number(day);

  const diffDays = Math.max(0, Math.round(
    (toUTCDate(day) - toUTCDate(START_DAY)) / 86400000
  ));
  const dayIndex = 1 + diffDays;

  // load used ledger
  let used = [];
  try { used = JSON.parse(fs.readFileSync(usedPath,'utf8')); }
  catch { used = []; }

  try {
    const easy = await fetchSet("easy", 5);
    const medium = await fetchSet("medium", 5);
    const hard = await fetchSet("hard", 5);

    // filter out used questions
    const filterUsed = arr => arr.filter(q => !used.includes(q.question));
    const eAvail = filterUsed(easy);
    const mAvail = filterUsed(medium);
    const hAvail = filterUsed(hard);

    // pick in order: 2 easy, 2 medium, 1 hard
    const pick = (arr, n) => arr.slice(0, n);
    const selected = [
      ...pick(eAvail, 2),
      ...pick(mAvail, 2),
      ...pick(hAvail, 1),
    ];

    const questions = selected.map((q, idx) => {
      const opts = seededShuffle([q.correct_answer, ...q.incorrect_answers], seed + idx * 7);
      const correctIdx = opts.indexOf(q.correct_answer);
      return { text: q.question, options: opts, correct: correctIdx, difficulty: q.difficulty };
    });

    const payload = { day, dayIndex, questions };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    // update used ledger
    const newUsed = [...used, ...selected.map(q => q.question)];
    fs.writeFileSync(usedPath, JSON.stringify(newUsed, null, 2));

    console.log(`Wrote daily.json for ${day} (Day ${dayIndex}) with ${questions.length} questions`);

  } catch (err) {
    console.warn("Fetch failed:", err.message);

    // fallback sample if daily.json missing
    if (!fs.existsSync(outPath)) {
      const fallback = {
        day, dayIndex,
        questions: [
          { text:"What is the capital of France?", options:["Paris","Rome","Madrid","Berlin"], correct:0, difficulty:"easy" },
          { text:"Who painted the Mona Lisa?", options:["Leonardo da Vinci","Michelangelo","Raphael","Donatello"], correct:0, difficulty:"easy" },
          { text:"Which planet is known as the Red Planet?", options:["Mars","Jupiter","Venus","Saturn"], correct:0, difficulty:"medium" },
          { text:"What is H2O commonly known as?", options:["Water","Hydrogen","Oxygen","Salt"], correct:0, difficulty:"medium" },
          { text:"What is 9 × 9?", options:["81","72","99","64"], correct:0, difficulty:"hard" }
        ]
      };
      fs.writeFileSync(outPath, JSON.stringify(fallback, null, 2));
      console.log("Wrote fallback daily.json");
    }
  }
})();
