// netlify/functions/today.js
// Node 18+ runtime (Netlify default). Uses Netlify Blobs for a tiny daily cache.
// Make sure your package.json includes: { "dependencies": { "@netlify/blobs": "^6.0.0" } }

import { getStore } from '@netlify/blobs';

// Helper: get YYYYMMDD in your timezone
function yyyymmdd(d = new Date(), tz = 'America/New_York') {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
  return `${p.year}${p.month}${p.day}`;
}

export const handler = async () => {
  try {
    const store = getStore('daily5');   // name of your blob storage bucket
    const dayStr = yyyymmdd();          // today's date in ET
    const key = `daily-${dayStr}.json`;

    // 1. Check cache first
    const cached = await store.get(key);
    if (cached) {
      return new Response(cached, { headers: { 'content-type': 'application/json' }});
    }

    // 2. Fetch 5 multiple-choice questions from Open Trivia DB
    const res = await fetch('https://opentdb.com/api.php?amount=5&type=multiple');
    if (!res.ok) {
      // fallback set if API fails
      const fallback = {
        day: dayStr,
        questions: [
          { text: "What is the capital of France?", options: ["Paris","Rome","Madrid","Berlin"], correct: 0 },
          { text: "Who painted the Mona Lisa?", options: ["Leonardo da Vinci","Michelangelo","Raphael","Donatello"], correct: 0 },
          { text: "Which planet is known as the Red Planet?", options: ["Mars","Jupiter","Venus","Saturn"], correct: 0 },
          { text: "What is H2O commonly known as?", options: ["Water","Hydrogen","Oxygen","Salt"], correct: 0 },
          { text: "What is 9 × 9?", options: ["81","72","99","64"], correct: 0 }
        ]
      };
      return new Response(JSON.stringify(fallback), { headers: { 'content-type': 'application/json' }});
    }

    const data = await res.json();

    // 3. Normalize results
    const questions = (data.results || []).map(q => {
      const options = [q.correct_answer, ...q.incorrect_answers];
      return {
        text: q.question,
        options,
        correct: 0, // correct is always first
        category: q.category || '',
        difficulty: q.difficulty || ''
      };
    });

    const payload = JSON.stringify({ day: dayStr, questions });

    // 4. Store in Netlify Blobs with 3-day TTL
    await store.set(key, payload, { metadata: { day: dayStr }, ttl: 60 * 60 * 24 * 3 });

    return new Response(payload, { headers: { 'content-type': 'application/json' }});
  } catch (e) {
    return new Response(JSON.stringify({ error: 'internal', details: String(e) }), { status: 500 });
  }
};
