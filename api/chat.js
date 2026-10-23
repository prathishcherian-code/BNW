// Chat assistant for the BNW Developers DOOH plan.
// The Anthropic key and the Supabase key stay in Vercel env vars and never reach the browser.
// The assistant answers questions about the plan and models what-if scenarios only.
// It never changes the proposed plan.
const { FLIGHT, PLAN, CPM, NOTES } = require('./_plan.js');

const KEYS = Object.keys(PLAN);
const MODEL = process.env.CHAT_MODEL || 'claude-haiku-5-5';
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 2000) hits.clear();
  return arr.length > 20;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) + 1;
}
function validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00Z'));
}

function baseScenario() {
  const budgets = {};
  KEYS.forEach((k) => (budgets[k] = PLAN[k].budget));
  return { start: FLIGHT.start, end: FLIGHT.end, budgets };
}

function totals(sc) {
  let tb = 0;
  let ti = 0;
  KEYS.forEach((k) => {
    tb += sc.budgets[k];
    ti += (PLAN[k].imp * sc.budgets[k]) / PLAN[k].budget;
  });
  const days = daysBetween(sc.start, sc.end);
  return {
    total_budget_usd: Math.round(tb),
    forecast_impressions: Math.round(ti),
    blended_cpm_usd: ti ? Math.round((tb / ti) * 100000) / 100 : null,
    flight_start: sc.start,
    flight_end: sc.end,
    flight_days: days,
    average_daily_spend_usd: Math.round(tb / days),
  };
}

function applyChanges(sc0, input) {
  let sc = input.reset ? baseScenario() : { start: sc0.start, end: sc0.end, budgets: Object.assign({}, sc0.budgets) };
  const notes = [];
  (input.set_budgets || []).forEach((c) => {
    if (PLAN[c.market] && typeof c.budget_usd === 'number' && c.budget_usd >= 0 && c.budget_usd < 1e9) {
      sc.budgets[c.market] = c.budget_usd;
    } else notes.push('Ignored an invalid budget entry: ' + JSON.stringify(c));
  });
  (input.shift_budget || []).forEach((c) => {
    const amt = c.amount_usd;
    if (PLAN[c.from] && PLAN[c.to] && c.from !== c.to && typeof amt === 'number' && amt > 0) {
      const mv = Math.min(amt, sc.budgets[c.from]);
      if (mv < amt) notes.push('Only ' + mv + ' USD was available to move from ' + c.from + '.');
      sc.budgets[c.from] -= mv;
      sc.budgets[c.to] += mv;
    } else notes.push('Ignored an invalid shift entry: ' + JSON.stringify(c));
  });
  if (typeof input.scale_total_to_usd === 'number' && input.scale_total_to_usd > 0) {
    const cur = KEYS.reduce((a, k) => a + sc.budgets[k], 0);
    if (cur > 0) KEYS.forEach((k) => (sc.budgets[k] = (sc.budgets[k] * input.scale_total_to_usd) / cur));
  }
  if (input.start_date || input.end_date) {
    const s = input.start_date || sc.start;
    const e = input.end_date || sc.end;
    if (validDate(s) && validDate(e) && e >= s && daysBetween(s, e) <= 366) {
      sc.start = s;
      sc.end = e;
    } else notes.push('Ignored invalid flight dates.');
  }
  KEYS.forEach((k) => (sc.budgets[k] = Math.round(sc.budgets[k] * 100) / 100));
  return { sc, notes };
}

function describe(sc) {
  const t = totals(sc);
  const changed = KEYS.filter((k) => Math.abs(sc.budgets[k] - PLAN[k].budget) > 0.5).map((k) => ({
    market: k,
    budget_usd: sc.budgets[k],
    forecast_impressions: Math.round((PLAN[k].imp * sc.budgets[k]) / PLAN[k].budget),
    cpm_usd: PLAN[k].cpm,
  }));
  return { scenario_totals: t, original_totals: totals(baseScenario()), changed_markets: changed };
}

let ctxCache = { at: 0, text: '' };
async function screenContext() {
  if (Date.now() - ctxCache.at < 5 * 60 * 1000 && ctxCache.text) return ctxCache.text;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return '';
  try {
    const r = await fetch(`${url}/rest/v1/bnw_sites?select=category,market,city,screens&order=market.asc`, {
      headers: { apikey: key, Accept: 'application/json' },
    });
    if (!r.ok) return '';
    const rows = await r.json();
    const by = {};
    rows.forEach((s) => {
      const k = s.category + '|' + s.market;
      (by[k] = by[k] || []).push(...(s.screens || []));
    });
    const lines = [];
    Object.keys(by).forEach((k) => {
      lines.push('Screens in ' + k + ':');
      by[k].forEach((x) => {
        lines.push(
          '- ' + [x.name, x.venue, x.format, CPM[x.ref] != null ? 'CPM $' + CPM[x.ref] : null, x.weekly ? 'weekly audience ' + Math.round(x.weekly) : null].filter(Boolean).join(' | ')
        );
      });
    });
    ctxCache = { at: Date.now(), text: lines.join('\n') };
    return ctxCache.text;
  } catch (e) {
    return '';
  }
}

let sigCache = { at: 0, text: '' };
async function signalContext() {
  if (Date.now() - sigCache.at < 10 * 60 * 1000 && sigCache.text) return sigCache.text;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return '';
  const h = { apikey: key, Accept: 'application/json' };
  const get = async (q) => {
    const r = await fetch(`${url}/rest/v1/${q}`, { headers: h });
    return r.ok ? r.json() : [];
  };
  try {
    const [wk, tp, ft, ev, meta] = await Promise.all([
      get('bnw_signal_weekly?select=market_key,week_start,score,fare_pct,fare_usd,search_pct,cal_note&order=week_start.asc'),
      get('bnw_search_topics?select=geo,topic,week_start,pct&order=week_start.asc'),
      get('bnw_footfall?select=market_key,place,busiest_day,quietest_day,busiest_hour,avg_pct'),
      get('bnw_competitor_events?select=developer,title,kind,city,country,start_date,end_date,note,precision&order=start_date.asc'),
      get('bnw_signal_meta?select=k,v'),
    ]);
    if (!wk.length) return '';
    const L = [];
    const by = {};
    wk.forEach((r) => (by[r.market_key] = by[r.market_key] || []).push(r));
    L.push('MASSCOM HNWI SIGNALS (timing guide, scores 0 to 100 per week, weeks start Monday, window ' + wk[0].week_start + ' to ' + wk[wk.length - 1].week_start + '). The score blends travel demand 40% (airfares into the market vs normal), search intel 35% (online searches for Dubai property and luxury real estate, seasonal lift vs the last 4 years) and the event and holiday calendar 25%. Footfall and competitor activity are shown separately and are not in the score.');
    L.push('Weekly scores by market (week start: score):');
    Object.keys(by).forEach((k) => {
      const a = by[k];
      const pk = a.reduce((m, x) => (x.score > m.score ? x : m), a[0]);
      const notes = [...new Set(a.map((x) => x.cal_note).filter(Boolean).flatMap((n) => n.split('; ')))].slice(0, 4).join('; ');
      const fares = a.filter((x) => x.fare_pct != null).reduce((m, x) => (x.fare_pct > m.fare_pct ? x : m), a[0]);
      L.push('- ' + k + ': ' + a.map((x) => x.week_start.slice(5) + ' ' + x.score).join(', ') + '. Peak week ' + pk.week_start + ' (' + pk.score + '). Highest fares vs normal: ' + (fares.fare_pct >= 0 ? '+' : '') + fares.fare_pct + '% in week ' + fares.week_start + '.' + (notes ? ' Calendar: ' + notes + '.' : ''));
    });
    const gname = { US: 'US', GB: 'UK', AE: 'UAE' };
    L.push('Search Intel by country: peak seasonal lift vs the usual autumn level, with the week (online searches):');
    const tg = {};
    tp.forEach((r) => ((tg[r.geo] = tg[r.geo] || {})[r.topic] = tg[r.geo][r.topic] || []).push(r));
    Object.keys(tg).forEach((g) => {
      L.push('- ' + (gname[g] || g) + ': ' + Object.keys(tg[g]).map((t) => {
        const pk = tg[g][t].reduce((m, x) => (Number(x.pct) > Number(m.pct) ? x : m), tg[g][t][0]);
        return t + ' ' + (pk.pct >= 0 ? '+' : '') + Math.round(pk.pct) + '% (week ' + pk.week_start + ')';
      }).join('; '));
    });
    L.push('Footfall profiles (typical week, not a forecast):');
    ft.forEach((f) => L.push('- ' + f.market_key + ' (' + f.place + '): busiest ' + f.busiest_day + ' around ' + f.busiest_hour + ':00, quietest ' + f.quietest_day + '; average hourly crowd ' + f.avg_pct + '% of the peak hour.'));
    L.push('Publicly announced developer events and roadshows (not a complete list):');
    ev.forEach((e) => L.push('- ' + e.developer + ': ' + e.title + ' (' + e.kind + '), ' + e.city + ', ' + e.country + ', ' + e.start_date + (e.end_date ? ' to ' + e.end_date : ' (open ended)') + (e.precision === 'city' ? ', city-level location' : '') + '. ' + (e.note || '')));
    sigCache = { at: Date.now(), text: L.join('\n') };
    return sigCache.text;
  } catch (e) {
    return '';
  }
}

function systemPrompt(screens, signals) {
  const mk = KEYS.map(
    (k) =>
      `- ${k}: budget $${PLAN[k].budget}, forecast impressions ${PLAN[k].imp}, average CPM $${PLAN[k].cpm}, ${PLAN[k].screens} screens, ${PLAN[k].venues} venue types${PLAN[k].areas ? ', areas: ' + PLAN[k].areas : ''}. Why it matters: ${NOTES[k] || ''}`
  ).join('\n');
  return `You are the plan assistant on the BNW Developers programmatic DOOH plan page, prepared by Masscom Global.
You help BNW's head of marketing understand the recommended plan: where the screens are, the budget per market, CPMs, forecast impressions, and why each location suits reaching high-net-worth buyers of Dubai property.

Rules:
- Answer only from the plan data and the Masscom HNWI Signals data below. If something is not in the data (for example delivery limits, creative specs, taxes, other markets), say you do not have it and that Masscom Global will confirm.
- CPM means cost per 1,000 impressions, in USD. Forecast impressions are projections for the flight, not guarantees. Audience figures are weekly averages per screen and are not de-duplicated.
- The original plan is: flight ${FLIGHT.start} to ${FLIGHT.end} (7 days), $50,000 per market across ${KEYS.length} markets, $850,000 in total.
- You can model what-if scenarios with the update_scenario tool: changing a market's budget, moving budget between markets, scaling the total, or changing the flight dates. Always use the tool for any scenario change and report numbers from its result. Never do the arithmetic yourself.
- Scenarios are illustrative only. They do not change the proposed plan. Say so briefly when you show one. Impressions in a scenario assume the same CPM as the plan and available inventory; Masscom Global confirms availability and final pricing. Changing dates changes daily spend, not the impressions bought for a given budget.
- You can advise on timing: the best weeks to advertise, how markets compare week by week, travel demand, Search Intel (online searches for Dubai property, luxury watches, luxury cars and international investment), footfall at airports and city locations, and publicly announced competitor developer events. Use the Masscom HNWI Signals data below. Present travel, search, calendar, footfall and competitor activity as separate signals in plain language, and give the 0 to 100 score as the combined timing guide. Say these are a guide to timing and not a forecast of impressions or results. Competitor events are publicly announced items only and the list is not complete. Never name the search engines, social networks, event sites or data providers behind the signals; say online searches, public listings or published reports instead. If asked how a signal is sourced, say it comes from Masscom's own market intelligence.
- Never mention supplier costs, margins, publishers, SSPs or how CPMs were derived. Do not discuss anything unrelated to this plan.
- Be concise and plain. Use short paragraphs or simple lists. No em dashes. Use $ and thousands separators. Today's date is ${new Date().toISOString().slice(0, 10)}.

MARKETS (use these exact keys in tool calls):
${mk}

${screens}

${signals || ''}`;
}

const TOOL = {
  name: 'update_scenario',
  description:
    'Create or modify the what-if scenario shown to the user. All amounts are USD. Dates are YYYY-MM-DD. This never changes the official plan. Returns scenario totals, original totals and the markets that differ from the plan.',
  input_schema: {
    type: 'object',
    properties: {
      reset: { type: 'boolean', description: 'Start again from the original plan before applying other changes.' },
      set_budgets: {
        type: 'array',
        items: {
          type: 'object',
          properties: { market: { type: 'string', enum: KEYS }, budget_usd: { type: 'number' } },
          required: ['market', 'budget_usd'],
        },
      },
      shift_budget: {
        type: 'array',
        items: {
          type: 'object',
          properties: { from: { type: 'string', enum: KEYS }, to: { type: 'string', enum: KEYS }, amount_usd: { type: 'number' } },
          required: ['from', 'to', 'amount_usd'],
        },
      },
      scale_total_to_usd: { type: 'number', description: 'Scale every market proportionally so the total budget equals this amount.' },
      start_date: { type: 'string' },
      end_date: { type: 'string' },
    },
  },
};

function cleanScenario(s) {
  const base = baseScenario();
  if (!s || typeof s !== 'object' || !s.budgets) return base;
  const out = { start: validDate(s.start) ? s.start : base.start, end: validDate(s.end) ? s.end : base.end, budgets: {} };
  if (out.end < out.start) {
    out.start = base.start;
    out.end = base.end;
  }
  KEYS.forEach((k) => {
    const v = s.budgets[k];
    out.budgets[k] = typeof v === 'number' && v >= 0 && v < 1e9 ? v : base.budgets[k];
  });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'The assistant is not switched on yet.' });
    return;
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    res.status(429).json({ error: 'Too many questions in a short time. Please try again in a few minutes.' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = null;
    }
  }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    res.status(400).json({ error: 'No question received.' });
    return;
  }
  const msgs = body.messages
    .slice(-10)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
    res.status(400).json({ error: 'No question received.' });
    return;
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();

  let scenario = cleanScenario(body.scenario);
  const [screens, signals] = await Promise.all([screenContext(), signalContext()]);
  const system = [{ type: 'text', text: systemPrompt(screens, signals), cache_control: { type: 'ephemeral' } }];
  const convo = msgs.slice();

  try {
    for (let i = 0; i < 4; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 900, system, tools: [TOOL], messages: convo }),
      });
      if (!r.ok) {
        let detail = 'anthropic ' + r.status;
        try {
          const ej = await r.json();
          const em = ej && ej.error ? ej.error : {};
          detail += ' ' + (em.type || '') + ' ' + String(em.message || '').slice(0, 160);
        } catch (e) {}
        console.error('chat upstream error', detail);
        res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.', detail });
        return;
      }
      const data = await r.json();
      const uses = (data.content || []).filter((b) => b.type === 'tool_use');
      if (data.stop_reason === 'tool_use' && uses.length) {
        convo.push({ role: 'assistant', content: data.content });
        const results = uses.map((u) => {
          const out = applyChanges(scenario, u.input || {});
          scenario = out.sc;
          const d = describe(scenario);
          if (out.notes.length) d.notes = out.notes;
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(d) };
        });
        convo.push({ role: 'user', content: results });
        continue;
      }
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      res.status(200).json({ reply: text || 'Sorry, I could not answer that.', scenario });
      return;
    }
    res.status(200).json({ reply: 'Sorry, that request was too complex. Please try a simpler change.', scenario });
  } catch (e) {
    console.error('chat error', e && e.message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.', detail: 'exception ' + String((e && e.message) || '').slice(0, 160) });
  }
};
