// Vercel serverless function: reads the public-safe view from Supabase.
// The Supabase key stays in Vercel env vars and never reaches the browser.
module.exports = async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    res.status(500).json({ error: 'Server is not configured' });
    return;
  }
  try {
    const r = await fetch(`${url}/rest/v1/bnw_sites?select=*&order=market.asc`, {
      headers: { apikey: key, Accept: 'application/json' },
    });
    if (!r.ok) {
      res.status(502).json({ error: 'Data source unavailable' });
      return;
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Data source unavailable' });
  }
};
