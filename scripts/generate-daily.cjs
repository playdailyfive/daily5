/**
 * Daily Five generator — resilient & easy-mode
 * - Tries OpenTDB (easy) first; filters out repeats using used.json.
 * - Tops up from local easy bank if API returns too few fresh ones.
 * - Deterministically shuffles options per day for stability.
 */

const fs = require('fs');
const path = require('path');

const START_DAY = "20250824"; // Day 1 baseline (ET)

// ---------- Time helpers (ET-local day) ----------
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
function dayIndexFrom(startYmd, todayYmd) {
  const diffDays = Math.max(0, Math.round(
    (toUTCDate(todayYmd) - toUTCDate(startYmd)) / 86400000
  ));
  return 1 + diffDays;
}

// ---------- Deterministic shuffle ----------
function mulberry32(seed) {
  return function() {
    let t = (seed += 0x6D2B79F5) >>> 0;
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

// ---------- IO helpers ----------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- Local EASY fallback bank ----------
const LOCAL_BANK = [
  { text: "What color is the sky on a clear day?", options: ["Blue","Green","Red","Purple"], correctAnswer: "Blue" },
  { text: "How many days are in a week?", options: ["7","5","10","6"], correctAnswer: "7" },
  { text: "Which animal says 'meow'?", options: ["Cat","Dog","Cow","Sheep"], correctAnswer: "Cat" },
  { text: "What is 2 + 2?", options: ["4","3","5","6"], correctAnswer: "4" },
  { text: "Which season is the coldest?", options: ["Winter","Summer","Spring","Autumn"], correctAnswer: "Winter" },
  { text: "What is the first month of the year?", options: ["January","December","March","June"], correctAnswer: "January" },
  { text: "What do bees make?", options: ["Honey","Milk","Wool","Silk"], correctAnswer: "Honey" },
  { text: "Which shape has 3 sides?", options: ["Triangle","Square","Circle","Rectangle"], correctAnswer: "Triangle" },
  { text: "Which planet do we live on?", options: ["Earth","Mars","Jupiter","Venus"], correctAnswer: "Earth" },
  { text: "What is H2O commonly called?", options: ["Water","Oxygen","Hydrogen","Salt"], correctAnswer: "Water" },
  { text: "How many letters are in the English alphabet?", options: ["26","24","30","20"], correctAnswer: "26" },
  { text: "What color are bananas when ripe?", options: ["Yellow","Blue","Red","Purple"], correctAnswer: "Yellow" },
  { text: "Which animal is known as man’s best friend?", options: ["Dog","Cat","Horse","Rabbit"], correctAnswer: "Dog" },
  { text: "What do you call baby cats?", options: ["Kittens","Puppies","Cubs","Calves"], correctAnswer: "Kittens" },
  { text: "How many wheels does a tricycle have?", options: ["3","2","4","1"], correctAnswer: "3" },
  { text: "Which sport uses a bat and a ball?", options: ["Baseball","Soccer","Tennis","Hockey"], correctAnswer: "Baseball" },
  { text: "Which ocean is on the U.S. West Coast?", options: ["Pacific","Atlantic","Indian","Arctic"], correctAnswer: "Pacific" },
  { text: "Which fruit keeps the doctor away?", options: ["Apple","Banana","Orange","Grapes"], correctAnswer: "Apple" },
  { text: "What is the capital of France?", options: ["Paris","Rome","Berlin","Madrid"], correctAnswer: "Paris" },
  { text: "What do cows drink?", options: ["Water","Milk","Juice","Soda"], correctAnswer: "Water" },
  { text: "How many minutes are in an hour?", options: ["60","30","90","45"], correctAnswer: "60" },
  { text: "Which animal is the largest land animal?", options: ["Elephant","Rhino","Hippo","Giraffe"], correctAnswer: "Elephant" },
  { text: "What gas do we breathe to live?", options: ["Oxygen","Carbon dioxide","Nitrogen","Helium"], correctAnswer: "Oxygen" },
  { text: "Which direction does the sun rise?", options: ["East","West","North","South"], correctAnswer: "East" },
  { text: "Which holiday has a tree and gifts?", options: ["Christmas","Easter","Halloween","Thanksgiving"], correctAnswer: "Christmas" },
  { text: "What is the opposite of hot?", options: ["Cold","Warm","Boiling","Spicy"], correctAnswer: "Cold" },
  { text: "Which animal has a long neck?", options: ["Giraffe","Lion","Zebra","Bear"], correctAnswer: "Giraffe" },
  { text: "What color are strawberries?", options: ["Red","Blue","Green","Black"], correctAnswer: "Red" },
  { text: "Which device do you use to make a phone call?", options: ["Phone","Camera","Microwave","Keyboard"], correctAnswer: "Phone" },
  { text: "What currency is used in the USA?", options: ["Dollar","Euro","Pound","Yen"], correctAnswer: "Dollar" }
];

// ---------- OpenTDB fetch with retry ----------
async function fetchOpenTDBEasy(count = 5, retries = 3) {
  const url = `https://opentdb.com/api.php?amount=${count}&type=multiple&difficulty=easy`;
  let lastErr;
  for (let a = 1; a <= retries; a++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data?.results?.length) throw new Error('Bad payload');
      return data.results.map(q => ({
        text: q.question,
        options: [q.correct_answer, ...q.incorrect_answers],
        correctAnswer: q.correct_answer
      }));
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 800 * a));
    }
  }
  throw lastErr;
}

// ---------- Select 5 (preferring fresh), top-up if needed ----------
function pickFiveFresh(preferredPool, usedSet, fallbackPool) {
  const fresh = preferredPool.filter(q => !usedSet.has(q.text));
  const picked = [...fresh];
  if (picked.length < 5) {
    const fallbackFresh = fallbackPool.filter(q => !usedSet.has(q.text));
    // Fill from fallback
    while (picked.length < 5 && fallbackFresh.length) {
      picked.push(fallbackFresh.shift());
    }
  }
  // If STILL short (very unlikely), fill from anything left to reach 5
  const all = [...preferredPool, ...fallbackPool];
  let idx = 0;
  while (picked.length < 5 && idx < all.length) {
    const candidate = all[idx++];
    if (!picked.some(p => p.text === candidate.text)) picked.push(candidate);
  }
  return picked.slice(0,5);
}

// ---------- Main ----------
(async () => {
  const day = yyyymmdd();           // ET day
  const seed = Number(day);         // per-day seed for option shuffle
  const dayIndex = dayIndexFrom(START_DAY, day);
  const outDaily = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');

  const usedLedger = readJSON(usedPath, {});
  usedLedger.used = Array.isArray(usedLedger.used) ? usedLedger.used : [];
  const usedSet = new Set(usedLedger.used);

  let pickedRaw;

  try {
    const fromApi = await fetchOpenTDBEasy(10, 3); // ask for more to improve freshness
    pickedRaw = pickFiveFresh(fromApi, usedSet, LOCAL_BANK);
  } catch (e) {
    // API failed → all from local bank (fresh-first)
    pickedRaw = pickFiveFresh([], usedSet, LOCAL_BANK);
  }

  // Normalize + deterministic option order
  const picked = pickedRaw.map(q => {
    const options = seededShuffle(q.options, seed + q.text.length);
    const correctIdx = options.indexOf(q.correctAnswer);
    return { text: q.text, options, correct: correctIdx, difficulty: "easy" };
  });

  // Update used ledger
  const todays = picked.map(q => q.text);
  usedLedger.used = Array.from(new Set([...usedLedger.used, ...todays]));

  // Write outputs
  writeJSON(outDaily, { day, dayIndex, questions: picked });
  writeJSON(usedPath, usedLedger);

  console.log('Wrote daily.json for', day, 'dayIndex', dayIndex, '— questions:', picked.length);
})();
