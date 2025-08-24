const { getStore } = require('@netlify/blobs');

function yyyymmdd(d = new Date(), tz = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}${parts.month}${parts.day}`;
}

exports.handler = async () => {
  try {
    // 👇 Use env vars you just set
    const store = getStore('daily5', {
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN,
    });

    const dayStr = yyyymmdd();
    const key = `daily-${dayStr}.json`;

    // Try cache
    const cached = await store.get(key);
    if (cached) {
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: cached };
    }

    // Fetch new questions
    const upstream = await fetch('https://opentdb.com/api.php?amount=5&type=multiple');
    const data = await upstream.json();

    const questions = (data.results || []).map(q => ({
      text: q.question,
      options: [q.correct_answer, ...q.incorrect_answers],
      correct: 0
    }));

    const payload = JSON.stringify({ day: dayStr, questions });

    // Cache for 3 days
    await store.set(key, payload, { metadata: { day: dayStr }, ttl: 60*60*24*3 });

    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: payload };
  } catch (e) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'internal', details: String(e) }) };
  }
};
