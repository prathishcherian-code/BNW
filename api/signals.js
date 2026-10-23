// Vercel serverless function: Masscom Demand Forecast data (next 90 days).
// Read-only. The Supabase key stays in Vercel env vars and never reaches the browser.
module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) { res.status(500).json({ error: 'Server is not configured' }); return; }
  const h = { apikey: key, Accept: 'application/json' };
  const num = (v) => (v == null ? null : Number(v));
  try {
    const [a, b, c, d, e] = await Promise.all([
      fetch(`${url}/rest/v1/bnw_signal_weekly?select=market_key,week_start,score,fare_idx,cal_idx,search_idx,search_pct,fare_pct,fare_usd,cal_note&order=week_start.asc`, { headers: h }),
      fetch(`${url}/rest/v1/bnw_signal_meta?select=k,v`, { headers: h }),
      fetch(`${url}/rest/v1/bnw_footfall?select=market_key,place,reviews,busiest_day,quietest_day,busiest_hour,avg_pct`, { headers: h }),
      fetch(`${url}/rest/v1/bnw_competitor_events?select=developer,title,kind,city,country,lat,lng,precision,start_date,end_date,note,source_label,source_url,status&order=start_date.asc`, { headers: h }),
      fetch(`${url}/rest/v1/bnw_search_topics?select=geo,topic,week_start,idx,pct&order=week_start.asc`, { headers: h }),
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
        w: r.week_start, s: Number(r.score), fi: num(r.fare_idx), ci: num(r.cal_idx), si: num(r.search_idx),
        sp: num(r.search_pct), fp: num(r.fare_pct), fu: num(r.fare_usd), n: r.cal_note || '',
      });
    });
    const foot = {};
    if (c.ok) (await c.json()).forEach((r) => { foot[r.market_key] = r; });
    const topics = {};
    if (e.ok) (await e.json()).forEach((r) => { ((topics[r.geo] = topics[r.geo] || {})[r.topic] = topics[r.geo][r.topic] || []).push({ w: r.week_start, i: num(r.idx), p: num(r.pct) }); });
    const events = d.ok ? await d.json() : [];
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    res.status(200).json({ weeks, markets, meta, foot, events, topics });
  } catch (e) {
    res.status(502).json({ error: 'Data source unavailable' });
  }
};
