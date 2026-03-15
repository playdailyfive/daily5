/**
 * Daily Five generator — improved
 *
 * Sources (in priority order):
 *   1. The Trivia API  (the-trivia-api.com — free, no auth, good quality)
 *   2. OpenTDB         (opentdb.com — original source, kept as fallback)
 *   3. Local fallback  (built-in bank, large enough to last ~2 weeks of outages)
 *
 * Improvements over v1:
 *   - Second API source before hitting local bank
 *   - Validates correct index != -1 before accepting a question
 *   - used.json capped at 365 entries (older questions are fair to reuse)
 *   - Larger fallback bank (20 easy, 15 medium, 10 hard)
 *   - Cleaner error messages and per-source logging
 *   - Shared filter/shuffle/dedup logic extracted so both APIs use the same pipeline
 */

const fs   = require('fs');
const path = require('path');

// ─── Tunables ───────────────────────────────────────────────────────────────
const ET_TZ       = 'America/New_York';
const START_DAY   = '20250824';
const USED_CAP    = 365;          // max entries in used.json before rolling
const RETRIES     = 6;
const BASE_TIMEOUT_MS = 9000;

const MAX_Q_LEN   = 110;
const MAX_OPT_LEN = 36;
const BAN_PATTERNS = [
  /\b(in|which|what)\s+year\b/i,
  /\bwhich of (the|these)\b/i,
  /\bfollowing\b/i,
  /\bNOT\b/, /\bEXCEPT\b/,
  /\broman\s+numeral\b/i,
  /\bchemical\b/i, /\bformula\b/i, /\bequation\b/i,
  /\bprime\s+number\b/i,
  /\b(nth|[0-9]{1,4}(st|nd|rd|th))\b.*\bcentury\b/i,
];
const ALLOW_CATS = new Set([
  'General Knowledge', 'general_knowledge',
  'Entertainment: Film', 'film',
  'Entertainment: Music', 'music',
  'Entertainment: Television', 'television',
  'Entertainment: Books', 'books',
  'Science & Nature', 'science',
  'Geography', 'geography',
  'Sports', 'sport_and_leisure',
  'Celebrities', 'celebrities',
  'Society & Culture', 'society_and_culture',
  'Food & Drink', 'food_and_drink',
  'Arts & Literature', 'arts_and_literature',
]);

// ─── Utilities ───────────────────────────────────────────────────────────────
function yyyymmdd(d = new Date(), tz = ET_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}${parts.month}${parts.day}`;
}
function toUTCDate(ymd) {
  return new Date(Date.UTC(+ymd.slice(0,4), +ymd.slice(4,6)-1, +ymd.slice(6,8)));
}
function dayIndexFrom(startYmd, todayYmd) {
  return 1 + Math.max(0, Math.round((toUTCDate(todayYmd) - toUTCDate(startYmd)) / 86400000));
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}
function norm(s = '') { return String(s).replace(/\s+/g, ' ').trim().toLowerCase(); }
function qKey(text, correctAnswer) { return fnv1a(norm(text) + '|' + norm(correctAnswer)); }

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seedNum) {
  const rand = mulberry32(seedNum >>> 0), out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function decodeHTMLEntities(s = '') {
  return s
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"').replace(/&eacute;/g, 'é')
    .replace(/&hellip;/g, '…').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ');
}

if (typeof fetch !== 'function') {
  console.error('Node 20+ required: global fetch not found. Use nvm use 20.');
  process.exit(1);
}

async function fetchJsonWithBackoff(url) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), BASE_TIMEOUT_MS + attempt * 500);
    try {
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(t);
      if (res.status === 429) {
        const back = Math.floor(1000 * (1.9 ** (attempt - 1))) + Math.floor(Math.random() * 2000);
        console.warn(`  HTTP 429 — backoff ${back}ms (attempt ${attempt}/${RETRIES})`);
        await new Promise(r => setTimeout(r, back));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      if (attempt === RETRIES) throw e;
      await new Promise(r => setTimeout(r, 600 + attempt * 400));
    }
  }
}

// ─── Shared filter + dedup pipeline ─────────────────────────────────────────
/**
 * Accepts a normalised question object:
 *   { text, correctAnswer, incorrectAnswers[], difficulty, category }
 * Returns true if the question passes all quality filters.
 */
function passFilter(q) {
  if (!q.text || q.text.trim().length === 0)   return false;
  if (q.text.length > MAX_Q_LEN)               return false;
  const opts = [q.correctAnswer, ...(q.incorrectAnswers || [])].filter(Boolean);
  if (opts.length < 4)                          return false;
  if (!opts.every(o => String(o).trim().length > 0 && String(o).length <= MAX_OPT_LEN)) return false;
  if (BAN_PATTERNS.some(rx => rx.test(q.text))) return false;
  if (q.category && !ALLOW_CATS.has(q.category)) return false;
  const uppers = (q.text.match(/[A-Z]/g) || []).length;
  const lowers = (q.text.match(/[a-z]/g) || []).length;
  if (uppers > lowers * 2)                      return false;
  return true;
}

/**
 * Takes a pool of normalised questions, applies filters + dedup,
 * diversifies by category, picks `n`, then builds final output format
 * with deterministically shuffled options.
 * Returns null if not enough questions after filtering.
 */
function buildFromPool(pool, n, seen, seedBase, idxOffset = 0) {
  const filtered = pool
    .filter(passFilter)
    .filter(q => !seen.has(qKey(q.text, q.correctAnswer)));

  if (filtered.length < n) return null;

  // Prefer General Knowledge, then diversify categories
  const isGK = q => (q.category || '').toLowerCase().includes('general');
  filtered.sort((a, b) => isGK(b) - isGK(a));

  const picked = [], seenCats = new Set();
  for (const q of filtered) {
    const cat = q.category || 'Misc';
    if (!seenCats.has(cat) || picked.length < Math.ceil(n / 2)) {
      picked.push(q); seenCats.add(cat);
    }
    if (picked.length === n) break;
  }
  // top-up if needed
  if (picked.length < n) {
    for (const q of filtered) {
      if (!picked.includes(q)) { picked.push(q); if (picked.length === n) break; }
    }
  }
  if (picked.length < n) return null;

  return picked.slice(0, n).map((q, i) => {
    const raw = [q.correctAnswer, ...q.incorrectAnswers];
    const opts = seededShuffle(raw, (seedBase + (idxOffset + i) * 7) >>> 0);
    const correctIdx = opts.indexOf(q.correctAnswer);
    if (correctIdx === -1) return null; // guard: skip if shuffle broke the index
    return {
      text:       q.text,
      options:    opts,
      correct:    correctIdx,
      difficulty: q.difficulty || 'medium',
      category:   q.category   || 'General Knowledge',
    };
  }).filter(Boolean); // drop any nulls from the guard above
}

// ─── Source 1: The Trivia API ────────────────────────────────────────────────
const TRIVIA_API_DIFF = { easy: 'easy', medium: 'medium', hard: 'hard' };
const TRIVIA_API_CATS = [
  'general_knowledge','film_and_tv','music','science','geography',
  'sport_and_leisure','food_and_drink','society_and_culture','arts_and_literature',
];

async function fetchFromTriviaAPI(difficulty, amount) {
  const cats = TRIVIA_API_CATS.join(',');
  const url = `https://the-trivia-api.com/v2/questions?limit=${amount}&difficulties=${difficulty}&categories=${cats}`;
  const data = await fetchJsonWithBackoff(url);
  if (!Array.isArray(data)) throw new Error('Unexpected response from The Trivia API');

  return data.map(q => ({
    text:             decodeHTMLEntities(q.question?.text || ''),
    correctAnswer:    decodeHTMLEntities(q.correctAnswer || ''),
    incorrectAnswers: (q.incorrectAnswers || []).map(decodeHTMLEntities),
    difficulty:       (q.difficulty || difficulty).toLowerCase(),
    category:         q.category || 'general_knowledge',
  }));
}

async function tryTriviaAPI(seedBase, seen) {
  console.log('  Trying The Trivia API…');
  const [easyPool, medPool, hardPool] = await Promise.all([
    fetchFromTriviaAPI('easy',   24),
    fetchFromTriviaAPI('medium', 20),
    fetchFromTriviaAPI('hard',   16),
  ]);

  const easy   = buildFromPool(easyPool,   2, seen, seedBase, 0);
  const medium = buildFromPool(medPool,    2, seen, seedBase, 2);
  const hard   = buildFromPool(hardPool,   1, seen, seedBase, 4);

  if (!easy || !medium || !hard || easy.length < 2 || medium.length < 2 || hard.length < 1) {
    throw new Error('Not enough questions after filtering from The Trivia API');
  }
  return [...easy, ...medium, ...hard];
}

// ─── Source 2: OpenTDB (original, kept unchanged) ────────────────────────────
const GK_CATEGORY_ID = 9;

async function fetchFromOpenTDB(difficulty, amount, categoryId = null) {
  const base = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  const url  = categoryId ? `${base}&category=${categoryId}` : base;
  const data = await fetchJsonWithBackoff(url);
  const list = Array.isArray(data?.results) ? data.results : [];

  return list.map(q => ({
    text:             decodeHTMLEntities(q.question || ''),
    correctAnswer:    decodeHTMLEntities(q.correct_answer || ''),
    incorrectAnswers: (q.incorrect_answers || []).map(decodeHTMLEntities),
    difficulty:       (q.difficulty || difficulty).toLowerCase(),
    category:         q.category || 'General Knowledge',
  }));
}

async function tryOpenTDB(seedBase, seen) {
  console.log('  Trying OpenTDB…');
  const [easyA, easyGK, medA, medGK, hardPool] = await Promise.all([
    fetchFromOpenTDB('easy',   17, null),
    fetchFromOpenTDB('easy',   7,  GK_CATEGORY_ID),
    fetchFromOpenTDB('medium', 14, null),
    fetchFromOpenTDB('medium', 6,  GK_CATEGORY_ID),
    fetchFromOpenTDB('hard',   16, null),
  ]);

  const easyPool = [...easyGK, ...easyA];
  const medPool  = [...medGK,  ...medA];

  const easy   = buildFromPool(easyPool,  2, seen, seedBase, 0);
  const medium = buildFromPool(medPool,   2, seen, seedBase, 2);
  const hard   = buildFromPool(hardPool,  1, seen, seedBase, 4);

  if (!easy || !medium || !hard || easy.length < 2 || medium.length < 2 || hard.length < 1) {
    throw new Error('Not enough questions after filtering from OpenTDB');
  }
  return [...easy, ...medium, ...hard];
}

// ─── Source 3: Local fallback bank ───────────────────────────────────────────
// Large enough to handle ~2 weeks of API outages without repeating.
// Format: [question, correct, wrong1, wrong2, wrong3]
const FALLBACK_BANK = {
  easy: [
    ["What color is a ripe banana?",                    "Yellow",        "Green",      "Red",        "Blue"],
    ["How many sides does a triangle have?",            "3",             "4",          "5",          "6"],
    ["What do bees make?",                              "Honey",         "Milk",       "Wax only",   "Syrup"],
    ["Which animal is known as man's best friend?",     "Dog",           "Cat",        "Horse",      "Rabbit"],
    ["What color is the sky on a clear day?",           "Blue",          "Pink",       "Yellow",     "Green"],
    ["How many days are in a week?",                    "7",             "5",          "6",          "8"],
    ["What is the first letter of the alphabet?",       "A",             "B",          "C",          "Z"],
    ["What shape is a stop sign?",                      "Octagon",       "Circle",     "Square",     "Triangle"],
    ["How many legs does a spider have?",               "8",             "6",          "4",          "10"],
    ["What fruit is known for keeping the doctor away?","Apple",         "Orange",     "Banana",     "Grape"],
    ["Which planet is closest to the Sun?",             "Mercury",       "Venus",      "Earth",      "Mars"],
    ["What is the color of grass?",                     "Green",         "Brown",      "Blue",       "Purple"],
    ["How many fingers are on one human hand?",         "5",             "4",          "6",          "10"],
    ["What do you use to write on a chalkboard?",       "Chalk",         "Pen",        "Marker",     "Pencil"],
    ["What is frozen water called?",                    "Ice",           "Snow",       "Sleet",      "Frost"],
    ["Which ocean is the largest?",                     "Pacific",       "Atlantic",   "Indian",     "Arctic"],
    ["What is the currency of the United States?",      "Dollar",        "Pound",      "Euro",       "Yen"],
    ["How many months are in a year?",                  "12",            "10",         "11",         "13"],
    ["What gas do humans breathe in to survive?",       "Oxygen",        "Nitrogen",   "Carbon dioxide","Helium"],
    ["How many wheels does a bicycle have?",            "2",             "3",          "4",          "1"],
  ],
  medium: [
    ["Which gas do plants absorb from the air?",        "Carbon dioxide","Oxygen",     "Nitrogen",   "Helium"],
    ["What is the capital of Australia?",               "Canberra",      "Sydney",     "Melbourne",  "Brisbane"],
    ["How many keys does a standard piano have?",       "88",            "76",         "72",         "100"],
    ["Who wrote Romeo and Juliet?",                     "Shakespeare",   "Dickens",    "Chaucer",    "Austen"],
    ["What is the hardest natural substance on Earth?", "Diamond",       "Gold",       "Iron",       "Quartz"],
    ["Which country invented pizza?",                   "Italy",         "Greece",     "Spain",      "France"],
    ["What is the largest continent?",                  "Asia",          "Africa",     "Europe",     "North America"],
    ["How many strings does a standard guitar have?",   "6",             "4",          "5",          "8"],
    ["What is the chemical symbol for gold?",           "Au",            "Ag",         "Fe",         "Go"],
    ["In which sport is a shuttlecock used?",           "Badminton",     "Tennis",     "Squash",     "Ping Pong"],
    ["What is the longest river in the world?",         "Nile",          "Amazon",     "Mississippi","Yangtze"],
    ["How many sides does a hexagon have?",             "6",             "5",          "7",          "8"],
    ["What year did World War II end?",                 "1945",          "1944",       "1943",       "1946"],
    ["Which element has the symbol O?",                 "Oxygen",        "Osmium",     "Oganesson",  "Oxide"],
    ["Who painted the Mona Lisa?",                      "Leonardo da Vinci","Michelangelo","Raphael","Rembrandt"],
  ],
  hard: [
    ["What is the capital of Kazakhstan?",              "Astana",        "Almaty",     "Shymkent",   "Nur-Sultan"],
    ["What is the rarest blood type?",                  "AB negative",   "O negative", "B negative", "A negative"],
    ["Which element has atomic number 79?",             "Gold",          "Silver",     "Platinum",   "Copper"],
    ["Who composed The Four Seasons?",                  "Vivaldi",       "Mozart",     "Bach",       "Handel"],
    ["What is the smallest country in the world?",      "Vatican City",  "Monaco",     "San Marino", "Liechtenstein"],
    ["Which city hosted the 1936 Summer Olympics?",     "Berlin",        "London",     "Paris",      "Rome"],
    ["What is the Planck constant approximately?",      "6.63 × 10⁻³⁴ J·s","3.14 × 10⁻³⁴","1.38 × 10⁻²³","9.11 × 10⁻³¹"],
    ["Which language has the most native speakers?",    "Mandarin Chinese","Spanish",  "English",    "Hindi"],
    ["What year was the Eiffel Tower completed?",       "1889",          "1901",       "1876",       "1912"],
    ["In anatomy, what does the term 'dorsal' mean?",   "Relating to the back","Front","Side",       "Lower"],
  ],
};

function fromFallback(seedBase, seen) {
  console.log('  Using local fallback bank…');
  const make = (rows, difficulty, category) => rows.map(r => ({
    text: r[0], correctAnswer: r[1],
    incorrectAnswers: [r[2], r[3], r[4]],
    difficulty, category,
  }));
  const easy   = make(FALLBACK_BANK.easy,   'easy',   'General Knowledge');
  const medium = make(FALLBACK_BANK.medium, 'medium', 'General Knowledge');
  const hard   = make(FALLBACK_BANK.hard,   'hard',   'General Knowledge');

  const e = buildFromPool(easy,   2, seen, seedBase, 0) || buildFromPool(easy,   2, new Set(), seedBase, 0);
  const m = buildFromPool(medium, 2, seen, seedBase, 2) || buildFromPool(medium, 2, new Set(), seedBase, 2);
  const h = buildFromPool(hard,   1, seen, seedBase, 4) || buildFromPool(hard,   1, new Set(), seedBase, 4);

  if (!e || !m || !h) throw new Error('Local fallback bank exhausted — add more questions!');
  return [...e, ...m, ...h];
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const today    = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath  = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');
  const REROLL_NONCE = process.env.REROLL_NONCE || '';

  // Load used ledger
  let used = { seen: [] };
  try {
    if (fs.existsSync(usedPath)) {
      used = JSON.parse(fs.readFileSync(usedPath, 'utf8') || '{}');
      used.seen = used.seen || [];
    }
  } catch (e) {
    console.warn('Could not read used.json, starting fresh:', e.message);
  }

  // Cap used.json to last USED_CAP entries (older ones are fair game to reuse)
  if (used.seen.length > USED_CAP) {
    console.log(`  used.json has ${used.seen.length} entries — trimming to last ${USED_CAP}`);
    used.seen = used.seen.slice(-USED_CAP);
  }
  const seen = new Set(used.seen);

  const seedBase = (Number(today) ^ (REROLL_NONCE
    ? (parseInt(fnv1a(REROLL_NONCE), 16) >>> 0)
    : 0)) >>> 0;

  let source = 'OPENTDB', chosen = [];

  // Try each source in order
  const sources = [
    { name: 'THE_TRIVIA_API', fn: () => tryTriviaAPI(seedBase, seen) },
    { name: 'OPENTDB',        fn: () => tryOpenTDB(seedBase, seen)    },
    { name: 'LOCAL_FALLBACK', fn: () => fromFallback(seedBase, seen)  },
  ];

  for (const src of sources) {
    try {
      console.log(`\nAttempting source: ${src.name}`);
      chosen = await src.fn();
      if (chosen && chosen.length === 5) {
        source = src.name;
        console.log(`  ✓ Got 5 questions from ${src.name}`);
        break;
      }
      throw new Error(`Got ${chosen?.length ?? 0} questions, need 5`);
    } catch (e) {
      console.warn(`  ✗ ${src.name} failed: ${e.message}`);
    }
  }

  if (!chosen || chosen.length !== 5) {
    console.error('All sources failed — cannot write daily.json');
    process.exit(1);
  }

  // Validate all correct indices are valid (final safety net)
  const invalid = chosen.filter(q => q.correct < 0 || q.correct >= q.options.length);
  if (invalid.length > 0) {
    console.error('Validation failed: some questions have invalid correct index', invalid);
    process.exit(1);
  }

  // Write daily.json
  const payload = {
    day:       today,
    dayIndex,
    reroll:    Boolean(REROLL_NONCE),
    source,
    questions: chosen,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nWrote daily.json — day ${today} (index ${dayIndex}), source: ${source}`);

  // Update used.json
  const newKeys = chosen.map(q => qKey(q.text, q.options[q.correct]));
  used.seen = [...used.seen, ...newKeys].slice(-USED_CAP); // keep cap on write too
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
  console.log(`Updated used.json — now ${used.seen.length} entries (cap: ${USED_CAP})`);
})();
