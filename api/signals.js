// Vercel serverless function: weekly demand-signal scores per market (next 90 days).
// Read-only. The Supabase key stays in Vercel env vars and never reaches the browser.
module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) { res.status(500).json({ error: 'Server is not configured' }); return; }
  const h = { apikey: key, Accept: 'application/json' };
  try {
    const [a, b] = await Promise.all([
      fetch(`${url}/rest/v1/bnw_signal_weekly?select=market_key,week_start,score,fare_pct,fare_usd,cal_note&order=week_start.asc`, { headers: h }),
      fetch(`${url}/rest/v1/bnw_signal_meta?select=k,v`, { headers: h }),
    ]);
    if (!a.ok || !b.ok) { res.status(502).json({ error: 'Data source unavailable' }); return; }
    const rows = await a.json();
    const meta = {};
    (await b.json()).forEach((r) => { meta[r.k] = r.v; });
    const markets = {};
    const weeks = [];
    rows.forEach((r) => {
      if (weeks.indexOf(r.week_start) < 0) weeks.push(r.week_start);
      (markets[r.market_key] = markets[r.market_key] || []).push({
        w: r.week_start, s: Number(r.score), fp: r.fare_pct == null ? null : Number(r.fare_pct),
        fu: r.fare_usd == null ? null : Number(r.fare_usd), n: r.cal_note || '',
      });
    });
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    res.status(200).json({ weeks, markets, meta });
  } catch (e) {
    res.status(502).json({ error: 'Data source unavailable' });
  }
};
