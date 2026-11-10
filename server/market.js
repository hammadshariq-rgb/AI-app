// ── Live candles for the website ─────────────────────────────────────────────
// The same thing the app's market_chart does, served to the website: real
// price history from Yahoo (a browser cannot ask Yahoo itself) plus a range
// for the next days worked out from how much the price has really moved.
// The range is statistics, not a forecast, and the page labels it so.
'use strict';

const CRYPTO = { bitcoin: 'BTC-USD', btc: 'BTC-USD', ethereum: 'ETH-USD', eth: 'ETH-USD', solana: 'SOL-USD', sol: 'SOL-USD', xrp: 'XRP-USD', ripple: 'XRP-USD', dogecoin: 'DOGE-USD', doge: 'DOGE-USD', bnb: 'BNB-USD', cardano: 'ADA-USD', ada: 'ADA-USD' };
const INDEXES = { 'nasdaq 100': '^NDX', nasdaq: '^IXIC', 's&p 500': '^GSPC', sp500: '^GSPC', 's&p': '^GSPC', dow: '^DJI', 'dow jones': '^DJI', 'ftse 100': '^FTSE', ftse: '^FTSE', nifty: '^NSEI', 'nifty 50': '^NSEI', sensex: '^BSESN', gold: 'GC=F', oil: 'CL=F', 'crude oil': 'CL=F', '10 year treasury': '^TNX', 'us 10 year': '^TNX', bonds: 'TLT', 'treasury bonds': 'TLT' };
const UA = { 'User-Agent': 'Mozilla/5.0' };
const _cache = new Map();

async function timed(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { headers: UA, signal: ctl.signal }); } finally { clearTimeout(t); }
}

async function resolve(q) {
  const low = q.toLowerCase();
  if (CRYPTO[low]) return CRYPTO[low];
  if (INDEXES[low]) return INDEXES[low];
  if (/^[\^A-Z0-9.=-]{1,12}$/.test(q)) return q.toUpperCase();
  try {
    const r = await timed(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=1&newsCount=0`, 4000);
    const d = await r.json();
    return (d && d.quotes && d.quotes[0] && d.quotes[0].symbol) || null;
  } catch (_) { return null; }
}

async function getCandles(query, range = '3mo', horizonDays = 10) {
  const q = String(query || '').trim().slice(0, 40);
  if (!q) return null;
  const R = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'].includes(range) ? range : '3mo';
  const H = Math.max(1, Math.min(30, Number(horizonDays) || 10));
  const key = q.toLowerCase() + '|' + R + '|' + H;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  const symbol = await resolve(q);
  if (!symbol) return null;
  const interval = R === '5d' ? '1h' : (R === '2y' || R === '5y') ? '1wk' : '1d';
  try {
    const res = await timed(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${R}`, 6000);
    const data = await res.json();
    const r = data && data.chart && data.chart.result && data.chart.result[0];
    const qd = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
    if (!r || !qd || !Array.isArray(r.timestamp)) return null;
    const candles = [];
    r.timestamp.forEach((t, i) => {
      const o = qd.open[i], h = qd.high[i], l = qd.low[i], c = qd.close[i];
      if ([o, h, l, c].every((v) => typeof v === 'number' && isFinite(v))) candles.push({ t: t * 1000, o, h, l, c });
    });
    if (candles.length < 5) return null;
    const keep = candles.slice(-90);
    const rets = [];
    for (let i = 1; i < candles.length; i++) rets.push(Math.log(candles[i].c / candles[i - 1].c));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, rets.length - 1));
    const drift = mean * 0.25;
    const last = keep[keep.length - 1].c;
    const stepMs = interval === '1h' ? 3600e3 : interval === '1wk' ? 7 * 86400e3 : 86400e3;
    const projection = [];
    for (let k = 1; k <= H; k++) {
      const m = drift * k, s = sd * Math.sqrt(k);
      projection.push({ t: keep[keep.length - 1].t + k * stepMs, base: last * Math.exp(m), lo: last * Math.exp(m - 1.2816 * s), hi: last * Math.exp(m + 1.2816 * s) });
    }
    const meta = r.meta || {};
    const out = {
      symbol: meta.symbol || symbol,
      name: meta.longName || meta.shortName || meta.symbol || symbol,
      currency: meta.currency || 'USD',
      interval, range: R, candles: keep, projection, last,
    };
    _cache.set(key, { at: Date.now(), data: out });
    if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
    return out;
  } catch (_) { return null; }
}

function mountMarket(app, { limiter } = {}) {
  const mw = limiter ? [limiter] : [];
  app.get('/web/candles', ...mw, async (req, res) => {
    const d = await getCandles(req.query.symbol, req.query.range, req.query.horizon).catch(() => null);
    if (!d) return res.status(404).json({ error: 'No live prices for that.' });
    res.json(d);
  });
}

module.exports = { getCandles, mountMarket };
