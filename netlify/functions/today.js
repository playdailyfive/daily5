// netlify/functions/today.js
// CommonJS Netlify Function using Netlify Blobs with explicit credentials.
// Ensure these env vars are set in Netlify project settings:
//   NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN
// Also ensure package.json has: "@netlify/blobs": "^6.0.0"

const { getStore } = require('@netlify/blobs');

function yyyymmdd(d = new Date(), tz = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}${parts.month}${parts.day}`; // YYYYMMDD
}

exports.handler = async () => {
  try {
    // 👇 Explicit config fixes MissingBlobsEnvironmentError
    const store = getStore('daily5', {
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN,
    });

    const dayStr = yyyymmdd();
    const key = `daily-${dayStr}.json`;

    // 1) Try cache
    const cached = await store.get(key);
    if (cached) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: cached,
      };
    }

    // 2) Fetch new questions
    const upstream = await fetch('https://opentdb.com/api.php?amount=5&type=multiple');
    if (!upstream.ok) {
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
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(fallback) };
    }

    const data = await upstream.json();
    const questions = (data.results || []).map(q => ({
      text: q.question,
      options: [q.correct_answer, ...q.incorrect_answers],
      correct: 0, // correct first; client shuffles per-day but keeps answer
      category: q.category || '',
      difficulty: q.difficulty || '',
    }));

    const payload = JSON.stringify({ day: dayStr, questions });

    // 3) Cache for 3 days
    await store.set(key, payload, { metadata: { day: dayStr }, ttl: 60 * 60 * 24 * 3 });

    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: payload };
  } catch (e) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'internal', details: String(e) }) };
  }
};
