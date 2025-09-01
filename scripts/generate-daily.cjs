/**
 * Daily Five generator
 * - Try OpenTDB first (primary)
 * - If API errors / rate-limits / not enough after filtering → fallback to local pools in /pools
 * - 2 easy, 2 medium, 1 hard
 * - Prefer ≥2 "General Knowledge" and diversify categories
 * - Avoid repeats via used.json ledger (hash of Q + correct)
 * - Deterministic option order per day (and reroll nonce)
 */

const fs = require('fs');
const path = require('path');

// Use global fetch if present (Node 18+/20+), otherwise polyfill with undici (if available)
let _fetch = globalThis.fetch;
try { if (!_fetch) _fetch = require('undici').fetch; } catch (_) {}
if (!_fetch) throw new Error('No fetch available. Use Node 20+ or install undici.');

const ET_TZ = 'America/New_York';
const START_DAY = '20250824'; // ET baseline (YYYYMMDD)

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
    'General Knowledge',                 // we prefer this
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

const FETCH_SIZES = { easy: 30, medium: 26, hard: 22 };
const MAX_LEDGER = null; // keep all
const RETRIES = 3;
const BASE_TIMEOUT_MS = 9000;

// ---------- utils ----------
function yyyymmdd(d = new Date(), tz = ET_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA',{
    timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${parts.year}${parts.month}${parts.day}`;
}
function toUTCDate(yyyyMMdd){
  const y=+yyyyMMdd.slice(0,4), m=+yyyyMMdd.slice(4,6), d=+yyyyMMdd.slice(6,8);
  return new Date(Date.UTC(y,m-1,d));
}
function dayIndexFrom(start,today){
  const diff = Math.max(0, Math.round((toUTCDate(today)-toUTCDate(start))/86400000));
  return 1+diff;
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchJson(url, { timeoutMs=BASE_TIMEOUT_MS, retries=RETRIES } = {}){
  for(let a=1;a<=retries;a++){
    const ac=new AbortController();
    const id=setTimeout(()=>ac.abort(), timeoutMs);
    try{
      const res=await _fetch(url,{signal:ac.signal});
      clearTimeout(id);
      if(!res.ok) throw new Error('HTTP '+res.status);
      return await res.json();
    }catch(e){
      clearTimeout(id);
      if(a===retries) throw e;
      await sleep(1000*a);
    }
  }
}

function fnv1a(str){
  let h=0x811c9dc5>>>0;
  for(let i=0;i<str.length;i++){
    h^=str.charCodeAt(i);
    h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0;
  }
  return ('0000000'+h.toString(16)).slice(-8);
}
function normalizeText(s=''){ return String(s).replace(/\s+/g,' ').trim().toLowerCase(); }
function qKey(q){ return fnv1a(normalizeText(q.question||q.text)+'|'+normalizeText(q.correct_answer||'')); }

function mulberry32(seed){ return function(){ let t=seed+=0x6D2B79F5; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }
function seededShuffle(arr,seedNum){
  const rand=mulberry32(seedNum>>>0), out=[...arr];
  for(let i=out.length-1;i>0;i--){ const j=Math.floor(rand()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}

function basicClean(q){
  const decode=(s='')=>s
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'")
    .replace(/&amp;/g,'&').replace(/&rsquo;/g,"'")
    .replace(/&ldquo;/g,'"').replace(/&rdquo;/g,'"')
    .replace(/&eacute;/g,'é').replace(/&hellip;/g,'…')
    .replace(/&mdash;/g,'—').replace(/&ndash;/g,'–')
    .replace(/&nbsp;/g,' ');
  return {
    ...q,
    category: q.category,
    question: decode(q.question||q.text||''),
    correct_answer: decode(q.correct_answer||''),
    incorrect_answers: (q.incorrect_answers||[]).map(decode)
  };
}
function withinLength(q){
  const qlen=(q.question||q.text||'').trim().length;
  if(qlen>EASY_FILTER.MAX_QUESTION_LEN) return false;
  const all=[q.correct_answer,...(q.incorrect_answers||[])].filter(Boolean);
  return all.every(o=>String(o).trim().length<=EASY_FILTER.MAX_OPTION_LEN);
}
function hasBannedPhrase(text){ return EASY_FILTER.BAN_PATTERNS.some(rx=>rx.test(text)); }
function isRelatableCategory(cat){ return !cat || EASY_FILTER.ALLOW_CATEGORIES.has(cat); }
function passEasyFilter(q){
  const qt=q.question||'';
  if(!withinLength(q)) return false;
  if(hasBannedPhrase(qt)) return false;
  if(!isRelatableCategory(q.category)) return false;
  if((qt.match(/[A-Z]/g)||[]).length > (qt.match(/[a-z]/g)||[]).length*2) return false;
  return true;
}

// ---------- sources ----------
async function fetchPoolFromAPI(difficulty, amount){
  const url=`https://opentdb.com/api.php?amount=${amount}&type=multiple&difficulty=${difficulty}`;
  const data=await fetchJson(url);
  const list=Array.isArray(data?.results)?data.results:[];
  return list.map(basicClean);
}
function readLocalPool(difficulty){
  const p=path.resolve(`pools/${difficulty}.json`);
  if(!fs.existsSync(p)) return [];
  try{ return JSON.parse(fs.readFileSync(p,'utf8')||'[]').map(basicClean); }
  catch(_){ return []; }
}

// pick helpers
function dedupeAgainstLedger(arr, seen){
  const out=[], local=new Set();
  for(const q of arr){
    const key=qKey(q);
    if(seen.has(key) || local.has(key)) continue;
    local.add(key); out.push(q);
  }
  return out;
}
function preferGeneralKnowledge(list){
  // sort so GK floats up, but keep original relative order otherwise
  return [...list].sort((a,b)=>{
    const ag = (a.category||'')==='General Knowledge';
    const bg = (b.category||'')==='General Knowledge';
    return (ag===bg)?0 : ag? -1 : 1;
  });
}
function ensureDiversity(chosen, pool){
  // if all 5 are same category (rare), try to swap last with another category
  const cats=chosen.map(q=>q.category||'');
  const allSame=cats.every(c=>c===cats[0]);
  if(!allSame) return chosen;
  const usedKeys=new Set(chosen.map(q=>qKey(q)));
  const alt = pool.find(q=>q.category && q.category!==cats[0] && !usedKeys.has(qKey(q)));
  if(alt){ chosen[chosen.length-1]=alt; }
  return chosen;
}
function ensureAtLeastTwoGK(chosen, pool){
  const gkCount=chosen.filter(q=> (q.category||'')==='General Knowledge').length;
  if(gkCount>=2) return chosen;
  const usedKeys=new Set(chosen.map(q=>qKey(q)));
  const gkCandidates=pool.filter(q=> (q.category||'')==='General Knowledge' && !usedKeys.has(qKey(q)));
  let idxToSwap = chosen.findIndex(q=> (q.category||'')!=='General Knowledge');
  if(idxToSwap>=0 && gkCandidates.length){
    chosen[idxToSwap]=gkCandidates[0];
  }
  return chosen;
}

// ---------- main ----------
(async ()=>{
  const today = yyyymmdd(new Date(), ET_TZ);
  const dayIndex = dayIndexFrom(START_DAY, today);
  const outPath = path.resolve('daily.json');
  const usedPath = path.resolve('used.json');
  const REROLL_NONCE = process.env.REROLL_NONCE || '';

  // load ledger
  let used={};
  try{ if(fs.existsSync(usedPath)) used=JSON.parse(fs.readFileSync(usedPath,'utf8')||'{}'); } catch(_){ used={}; }
  used.seen = used.seen || [];
  const seen = new Set(used.seen);

  // try API first, then fallback to local pools if needed
  let easy=[], medium=[], hard=[];
  let fromAPI = true;
  try{
    const [ep, mp, hp] = await Promise.all([
      fetchPoolFromAPI('easy',   FETCH_SIZES.easy),
      fetchPoolFromAPI('medium', FETCH_SIZES.medium),
      fetchPoolFromAPI('hard',   FETCH_SIZES.hard)
    ]);
    easy   = dedupeAgainstLedger(ep.filter(passEasyFilter), seen);
    medium = dedupeAgainstLedger(mp.filter(passEasyFilter), seen);
    hard   = dedupeAgainstLedger(hp.filter(passEasyFilter), seen);

    // if the API gave us too few after filtering, fallback to pools
    if ([easy.length, medium.length, hard.length].some(n=>n===0)) throw new Error('API produced too few questions after filtering');
  }catch(err){
    fromAPI = false;
    console.warn('OpenTDB failed or insufficient:', err.message, '— using LOCAL POOLS');
    const ep = readLocalPool('easy');
    const mp = readLocalPool('medium');
    const hp = readLocalPool('hard');

    if (!ep.length && !mp.length && !hp.length) {
      throw new Error('No local pools found. Create pools/easy.json, pools/medium.json, pools/hard.json');
    }

    easy   = dedupeAgainstLedger(ep.filter(passEasyFilter), seen);
    medium = dedupeAgainstLedger(mp.filter(passEasyFilter), seen);
    hard   = dedupeAgainstLedger(hp.filter(passEasyFilter), seen);
  }

  // prefer GK inside each bucket
  easy   = preferGeneralKnowledge(easy);
  medium = preferGeneralKnowledge(medium);
  hard   = preferGeneralKnowledge(hard);

  const pick = (arr,n)=>arr.slice(0, Math.max(0, Math.min(n, arr.length)));
  let chosen = [
    ...pick(easy,2),
    ...pick(medium,2),
    ...pick(hard,1),
  ];

  // top up if needed
  if (chosen.length < 5) {
    const already=new Set(chosen.map(q=>qKey(q)));
    const rest=[...easy,...medium,...hard].filter(q=>!already.has(qKey(q)));
    chosen = [...chosen, ...pick(rest, 5-chosen.length)];
  }
  if (chosen.length < 5) throw new Error('Not enough questions after filtering/dedupe.');

  // diversity + GK floor
  const allFilteredPool = [...easy, ...medium, ...hard];
  chosen = ensureAtLeastTwoGK(chosen, allFilteredPool);
  chosen = ensureDiversity(chosen, allFilteredPool);

  // seeded option shuffle per day (+ nonce)
  const seedBase = Number(today) ^ (REROLL_NONCE ? (parseInt(fnv1a(REROLL_NONCE),16)>>>0) : 0);
  const final = chosen.slice(0,5).map((q,idx)=>{
    const rawOpts=[q.correct_answer, ...(q.incorrect_answers||[])];
    const opts = seededShuffle(rawOpts, (seedBase + idx*7)>>>0);
    const correctIdx = opts.indexOf(q.correct_answer);
    return {
      text: q.question,
      options: opts,
      correct: correctIdx,
      difficulty: (idx<2?'easy': idx<4?'medium':'hard'),
      category: q.category || ''
    };
  });

  // write daily.json
  const payload = { day: today, dayIndex, reroll: Boolean(REROLL_NONCE), source: fromAPI?'opentdb':'local-pools', questions: final };
  fs.writeFileSync(outPath, JSON.stringify(payload,null,2));
  console.log('Wrote daily.json', { day: today, dayIndex, source: payload.source });

  // update ledger
  const newKeys = final.map(q=>fnv1a(normalizeText(q.text)+'|'+normalizeText(q.options[q.correct])));
  const merged = [...(used.seen||[]), ...newKeys];
  used.seen = MAX_LEDGER ? merged.slice(-MAX_LEDGER) : merged;
  fs.writeFileSync(usedPath, JSON.stringify(used,null,2));
  console.log('Updated used.json with', newKeys.length, 'entries');
})().catch(err=>{
  console.error('Build failed:', err.message);
  process.exit(1);
});
