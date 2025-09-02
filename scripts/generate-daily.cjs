/**
 * Daily Five generator (OpenTDB-first; local fallback)
 * - Default: OpenTDB (with retries/backoff + light category shaping)
 * - Fallback: small built-in bank if API fails
 * - Filters for short/relatable, avoids trick-y formats
 * - 2 easy + 2 medium + 1 hard
 * - >=2 "General Knowledge" if possible, diversify categories
 * - No repeats via used.json hash ledger
 * - Deterministic options shuffle per day (+ optional reroll)
 */

const fs = require('fs');
const path = require('path');

// ---------- Tunables ----------
const ET_TZ = 'America/New_York';
const START_DAY = '20250824';       // ET baseline
const GK_CATEGORY_ID = 9;           // OpenTDB "General Knowledge"

const FETCH_SIZES = { easy: 24, medium: 20, hard: 16 }; // modest but enough to filter
const RETRIES = 6;                  // polite retries
const BASE_TIMEOUT_MS = 9000;

const EASY_FILTER = {
  MAX_Q_LEN: 110,
  MAX_OPT_LEN: 36,
  BAN_PATTERNS: [
    /\b(in|which|what)\s+year\b/i,
    /\bwhich of (the|these)\b/i,
    /\bfollowing\b/i,
    /\bNOT\b/, /\bEXCEPT\b/,
    /\broman\s+numeral\b/i,
    /\bchemical\b/i, /\bformula\b/i, /\bequation\b/i,
    /\bprime\s+number\b/i,
    /\b(nth|[0-9]{1,4}(st|nd|rd|th))\b.*\bcentury\b/i
  ],
  ALLOW_CATS: new Set([
    'General Knowledge',
    'Entertainment: Film',
    'Entertainment: Music',
    'Entertainment: Television',
    'Entertainment: Books',
    'Science & Nature',
    'Geography',
    'Sports',
    'Celebrities'
  ])
};

// ---------- Helpers ----------
function yyyymmdd(d = new Date(), tz = ET_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}${parts.month}${parts.day}`;
}
function toUTCDate(yyyyMMdd) {
  const y = +yyyyMMdd.slice(0,4), m = +yyyyMMdd.slice(4,6), d = +yyyyMMdd.slice(6,8);
  return new Date(Date.UTC(y, m-1, d));
}
function dayIndexFrom(startYmd, todayYmd) {
  const diffDays = Math.max(0, Math.round((toUTCDate(todayYmd) - toUTCDate(startYmd)) / 86400000));
  return 1 + diffDays;
}
function fnv1a(str){ let h=0x811c9dc5; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0;} return ('0000000'+h.toString(16)).slice(-8); }
function norm(s=''){ return String(s).replace(/\s+/g,' ').trim().toLowerCase(); }
function qKeyFromOTDB(q){ return fnv1a(norm(q.question)+'|'+norm(q.correct_answer||'')); }
function qKeyFromOut(q){ return fnv1a(norm(q.text)+'|'+norm(q.options[q.correct]||'')); }

function mulberry32(seed){ return function(){ let t=seed+=0x6D2B79F5; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }
function seededShuffle(arr, seedNum){
  const rand = mulberry32(seedNum>>>0); const out=[...arr];
  for(let i=out.length-1;i>0;i--){ const j=Math.floor(rand()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}

// Node 20 has global fetch; if not, bail early with clear message
if (typeof fetch !== 'function') {
  console.error('Node 20+ required: global fetch not found. Use nvm use 20.');
  process.exit(1);
}

function decodeHTMLEntities(s=''){
  return s
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&apos;/g,"'")
    .replace(/&amp;/g,'&').replace(/&rsquo;/g,"'").replace(/&lsquo;/g,"'")
    .replace(/&ldquo;/g,'"').replace(/&rdquo;/g,'"')
    .replace(/&eacute;/g,'é').replace(/&hellip;/g,'…')
    .replace(/&mdash;/g,'—').replace(/&ndash;/g,'–')
    .replace(/&nbsp;/g,' ');
}

function tidyFromOTDB(q){
  return {
    category: q.category || '',
    question: decodeHTMLEntities(q.question || ''),
    correct_answer: decodeHTMLEntities(q.correct_answer || ''),
    incorrect_answers: (q.incorrect_answers || []).map(decodeHTMLEntities),
    difficulty: (q.difficulty || '').toLowerCase()
  };
}

function passFilter(q){
  const qt = q.question || '';
  if (qt.trim().length === 0) return false;
  if (qt.length > EASY_FILTER.MAX_Q_LEN) return false;
  const opts = [q.correct_answer, ...(q.incorrect_answers||[])].filter(Boolean);
  if (!opts.every(o => String(o).trim().length <= EASY_FILTER.MAX_OPT_LEN)) return false;
  if (EASY_FILTER.BAN_PATTERNS.some(rx => rx.test(qt))) return false;
  if (q.category && !EASY_FILTER.ALLOW_CATS.has(q.category)) return false;
  const uppers = (qt.match(/[A-Z]/g)||[]).length, lowers = (qt.match(/[a-z]/g)||[]).length;
  if (uppers > lowers * 2) return false;
  return true;
}

async function fetchJsonWithBackoff(url){
  for(let attempt=1; attempt<=RETRIES; attempt++){
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), BASE_TIMEOUT_MS + attempt*500);
    try{
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(t);
      if (res.status === 429) {
        const back = Math.floor(1000 * (1.9 ** (attempt-1))) + Math.floor(Math.random()*2000);
        console.warn(`HTTP 429 on ${url} — backoff ${back}ms (attempt ${attempt}/${RETRIES})`);
        await new Promise(r=>setTimeout(r, back));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(e){
      clearTimeout(t);
      if (attempt === RETRIES) throw e;
      await new Promise(r=>setTimeout(r, 600 + attempt*400));
    }
  }
}

async function fetchPool(difficulty, amount, categoryId=null){
  const base = `https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  const url = categoryId ? `${base}&category=${categoryId}` : base;
  const data = await fetchJsonWithBackoff(url);
  const list = Array.isArray(data?.results) ? data.results : [];
  return list.map(tidyFromOTDB);
}

// Small, friendly built-in fallback if API is down
const FALLBACK_BANK = {
  easy: [
    ["What color is the sky on a clear day?","Blue","Yellow","Green","Red"],
    ["How many days are in a week?","7","6","5","8"],
    ["What do bees make?","Honey","Milk","Bread","Wool"],
  ],
  medium: [
    ["Which ocean is the largest?","Pacific Ocean","Atlantic Ocean","Indian Ocean","Arctic Ocean"],
    ["Which gas do plants take in from the air?","Carbon dioxide","Oxygen","Nitrogen","Helium"],
  ],
  hard: [
    ["Which city is home to Christ the Redeemer?","Rio de Janeiro","São Paulo","Lisbon","Buenos Aires"],
  ]
};
function fromFallback(){
  const pick = (arr,n)=>arr.slice(0,Math.min(n,arr.length));
  const e = pick(FALLBACK_BANK.easy,2).map(m=>({text:m[0],options:[m[1],m[2],m[3],m[4]],correct:0,difficulty:"easy",category:"General Knowledge"}));
  const md = pick(FALLBACK_BANK.medium,2).map(m=>({text:m[0],options:[m[1],m[2],m[3],m[4]],correct:0,difficulty:"medium",category:"Geography"}));
  const h = pick(FALLBACK_BANK.hard,1).map(m=>({text:m[0],options:[m[1],m[2],m[3],m[4]],correct:0,difficulty:"hard",category:"Geography"}));
  return [...e,...md,...h];
}

// ---------- MAIN ----------
(async () => {
  const today = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');
  const REROLL_NONCE = process.env.REROLL_NONCE || '';

  // load used ledger
  let used = {};
  try { if (fs.existsSync(usedPath)) used = JSON.parse(fs.readFileSync(usedPath,'utf8')||'{}'); } catch {}
  used.seen = used.seen || [];
  const seen = new Set(used.seen);

  let source = 'OPENTDB', chosen = [];
  try {
    console.log('Trying OpenTDB…');

    // pull a mix with GK preference (helps variety + approachability)
    const [easyA, easyGK, medA, medGK, hardA] = await Promise.all([
      fetchPool('easy',   Math.ceil(FETCH_SIZES.easy*0.7),  null),
      fetchPool('easy',   Math.floor(FETCH_SIZES.easy*0.3), GK_CATEGORY_ID),
      fetchPool('medium', Math.ceil(FETCH_SIZES.medium*0.7),null),
      fetchPool('medium', Math.floor(FETCH_SIZES.medium*0.3),GK_CATEGORY_ID),
      fetchPool('hard',   FETCH_SIZES.hard,                 null),
    ]);

    const allEasy   = [...easyGK, ...easyA].map(tidyFromOTDB);
    const allMedium = [...medGK,  ...medA].map(tidyFromOTDB);
    const allHard   = [...hardA].map(tidyFromOTDB);

    const filterMap = (arr)=>arr.filter(passFilter).filter(q=>!seen.has(qKeyFromOTDB(q)));

    let easy = filterMap(allEasy);
    let medium = filterMap(allMedium);
    let hard = filterMap(allHard);

    // ensure >=2 GK overall if possible
    const tagGK = q => (q.category||'').includes('General Knowledge');
    easy.sort((a,b)=> (tagGK(b)-tagGK(a)));   // GK first
    medium.sort((a,b)=> (tagGK(b)-tagGK(a)));

    // pick 2/2/1 with diversification
    const pickN = (arr,n)=>{
      const out=[], seenCats=new Set();
      for(const q of arr){
        const cat = q.category || 'Misc';
        if (!seenCats.has(cat) || out.length<Math.ceil(n/2)) { // prefer new cats first
          out.push(q); seenCats.add(cat);
        }
        if(out.length===n) break;
      }
      // top-up if short
      if(out.length<n){
        for(const q of arr){ if(!out.includes(q)){ out.push(q); if(out.length===n) break; } }
      }
      return out.slice(0,n);
    };

    let chosenOTDB = [
      ...pickN(easy, 2),
      ...pickN(medium, 2),
      ...pickN(hard, 1)
    ];

    // top up from leftovers if needed
    if (chosenOTDB.length < 5) {
      const have = new Set(chosenOTDB.map(q=>qKeyFromOTDB(q)));
      const rest = [...easy, ...medium, ...hard].filter(q=>!have.has(qKeyFromOTDB(q)));
      chosenOTDB = [...chosenOTDB, ...rest].slice(0,5);
    }
    if (chosenOTDB.length < 5) throw new Error('Not enough after filtering');

    // build output + deterministic option order
    const seedBase = Number(today) ^ (REROLL_NONCE ? (parseInt(fnv1a(REROLL_NONCE),16)>>>0) : 0);
    chosen = chosenOTDB.map((q, idx) => {
      const raw = [q.correct_answer, ...q.incorrect_answers];
      const opts = seededShuffle(raw, (seedBase + idx*7)>>>0);
      return {
        text: q.question,
        options: opts,
        correct: opts.indexOf(q.correct_answer),
        difficulty: (q.difficulty || '').toLowerCase() || (idx<2?'easy':idx<4?'medium':'hard'),
        category: q.category || 'General Knowledge'
      };
    });

  } catch (e) {
    console.warn('OpenTDB failed; using local fallback:', e.message);
    source = 'LOCAL_FALLBACK';
    chosen = fromFallback();
  }

  // write daily.json
  const payload = { day: today, dayIndex, reroll: Boolean(REROLL_NONCE), source, questions: chosen };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log('Wrote daily.json for', today, 'dayIndex', dayIndex, 'source', source);

  // update used.json (hash on text|correct)
  const newKeys = chosen.map(q => qKeyFromOut(q));
  used.seen = [...(used.seen||[]), ...newKeys];
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
  console.log('Updated used.json with', newKeys.length, 'entries');
})();
