// api/indicators.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const payload = req.body || {};
  let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload;

  // ----------------- Utility functions -----------------
  const tryParseMaybeJson = (input) => {
    if (input == null) return null;
    if (Array.isArray(input)) return input;
    if (typeof input === 'string') {
      try { return JSON.parse(input); } catch { return input; }
    }
    if (typeof input === 'object') return input;
    return null;
  };

  const extractArray = (x) => {
    if (Array.isArray(x)) return x;
    if (typeof x === 'object') {
      if (Array.isArray(x.data)) return x.data;
      if (Array.isArray(x.body)) return x.body;
    }
    return [];
  };

  const parseInput = (f) => extractArray(tryParseMaybeJson(f));
  kline_15m = parseInput(kline_15m);
  kline_1h = parseInput(kline_1h);
  kline_4h = parseInput(kline_4h);
  kline_1d = parseInput(kline_1d);

  const normalizeCandleRow = (r) => {
    if (!r) return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
    const n = (v) => (v == null ? null : Number(v));
    if (Array.isArray(r)) {
      return { openTime: n(r[0]), open: n(r[1]), high: n(r[2]), low: n(r[3]), close: n(r[4]), volume: n(r[5]) };
    }
    return {
      openTime: n(r.openTime ?? r.t ?? r.time),
      open: n(r.open ?? r.o),
      high: n(r.high ?? r.h),
      low: n(r.low ?? r.l),
      close: n(r.close ?? r.c),
      volume: n(r.volume ?? r.v)
    };
  };

  const normalize = (arr) => (Array.isArray(arr) ? arr.map(normalizeCandleRow) : []);
  const normalized = { '15m': normalize(kline_15m), '1h': normalize(kline_1h), '4h': normalize(kline_4h), '1d': normalize(kline_1d) };

  // ----------------- Indicator Functions -----------------
  const sma = (v, p) => {
    const o = Array(v.length).fill(null);
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i] || 0;
      if (i >= p) s -= v[i - p] || 0;
      if (i >= p - 1) o[i] = s / p;
    }
    return o;
  };

  const ema = (v, p) => {
    const o = Array(v.length).fill(null);
    const k = 2 / (p + 1);
    let prev = null;
    for (let i = 0; i < v.length; i++) {
      const val = v[i];
      if (val == null) continue;
      if (prev == null) prev = val;
      else prev = val * k + prev * (1 - k);
      o[i] = prev;
    }
    return o;
  };

  const rsi = (v, p = 14) => {
    const o = Array(v.length).fill(null);
    if (v.length < p + 1) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) {
      const d = v[i] - v[i - 1];
      if (d > 0) g += d; else l += -d;
    }
    let ag = g / p, al = l / p;
    o[p] = 100 - 100 / (1 + ag / al);
    for (let i = p + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
      ag = (ag * (p - 1) + gain) / p;
      al = (al * (p - 1) + loss) / p;
      o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return o;
  };

  const trueRange = (h, l, c) => h.map((v, i) => (i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));

  const atr = (h, l, c, p = 14) => {
    const tr = trueRange(h, l, c);
    const o = Array(tr.length).fill(null);
    let s = 0;
    for (let i = 0; i < tr.length; i++) {
      if (i < p) { s += tr[i]; if (i === p - 1) o[i] = s / p; }
      else o[i] = ((o[i - 1] * (p - 1)) + tr[i]) / p;
    }
    return o;
  };

  const superTrend = (h, l, c, p = 10, m = 3) => {
    const a = atr(h, l, c, p);
    const hl2 = h.map((v, i) => (h[i] + l[i]) / 2);
    const upper = hl2.map((v, i) => v + m * a[i]);
    const lower = hl2.map((v, i) => v - m * a[i]);
    const st = Array(c.length).fill(null);
    const fu = Array(c.length).fill(null);
    const fl = Array(c.length).fill(null);
    for (let i = 0; i < c.length; i++) {
      if (i === 0) { fu[i] = upper[i]; fl[i] = lower[i]; continue; }
      fu[i] = Math.min(upper[i], fu[i - 1]);
      fl[i] = Math.max(lower[i], fl[i - 1]);
      if (st[i - 1] === fu[i - 1]) st[i] = c[i] < fu[i] ? fu[i] : fl[i];
      else st[i] = c[i] > fl[i] ? fl[i] : fu[i];
    }
    return st;
  };

  // ----------------- Timeframe Analysis -----------------
  function analyze(tf, candles) {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    if (closes.length < 20) return { signal: 'HOLD', score: 0, reasons: [] };
    const i = closes.length - 1;
    const ema9 = ema(closes, 9), ema21 = ema(closes, 21);
    const sma50 = sma(closes, 50), sma200 = sma(closes, 200);
    const rsi14 = rsi(closes, 14);
    const st = superTrend(highs, lows, closes, 10, 3);
    const atr14 = atr(highs, lows, closes, 14);
    const last = closes[i];

    let score = 0, reasons = [];

    if (last > ema9[i]) { score += 5; reasons.push('price > EMA9'); } else { score -= 5; reasons.push('price < EMA9'); }
    if (ema9[i] > ema21[i]) { score += 8; reasons.push('EMA9 > EMA21'); } else { score -= 8; reasons.push('EMA9 < EMA21'); }
    if (last > sma50[i]) { score += 5; } else { score -= 5; }
    if (sma50[i] > sma200[i]) { score += 6; } else { score -= 6; }
    if (st[i] && last > st[i]) { score += 8; } else if (st[i]) { score -= 8; }
    if (rsi14[i] > 70) { score -= 4; } else if (rsi14[i] < 30) { score += 4; }

    let signal = 'HOLD';
    if (score >= 35) signal = 'STRONG BUY';
    else if (score >= 15) signal = 'BUY';
    else if (score <= -35) signal = 'STRONG SELL';
    else if (score <= -15) signal = 'SELL';

    return { tf, signal, score, ema9: ema9[i], supertrend: st[i], atr: atr14[i], last, reasons };
  }

  const tfResults = {};
  for (const tf of Object.keys(normalized)) tfResults[tf] = analyze(tf, normalized[tf]);

  // ----------------- Weighted Signal -----------------
  const weight = { '15m': 1, '1h': 2, '4h': 3, '1d': 4 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };
  for (const tf in tfResults) tally[tfResults[tf].signal] += weight[tf];
  const buyW = tally['BUY'] + tally['STRONG BUY'] * 1.5;
  const sellW = tally['SELL'] + tally['STRONG SELL'] * 1.5;
  let final_signal = 'HOLD';
  if (buyW > sellW && buyW >= 4) final_signal = buyW > 6 ? 'STRONG BUY' : 'BUY';
  else if (sellW > buyW && sellW >= 4) final_signal = sellW > 6 ? 'STRONG SELL' : 'SELL';

  // ----------------- Entry Range & TP/SL -----------------
  const ref = tfResults['1h'] ?? tfResults['15m'];
  const { ema9, supertrend, atr, last } = ref;
  const trend = final_signal.includes('BUY') ? 'UP' : final_signal.includes('SELL') ? 'DOWN' : 'SIDEWAYS';

  let entryLow, entryHigh;
  if (trend === 'UP') { entryLow = Math.min(ema9, supertrend); entryHigh = ema9; }
  else if (trend === 'DOWN') { entryLow = ema9; entryHigh = Math.max(ema9, supertrend); }
  else { entryLow = entryHigh = last; }

  const entryRange = entryLow && entryHigh ? `${entryLow.toFixed(2)} - ${entryHigh.toFixed(2)}` : `${last?.toFixed(2)}`;
  const atrRef = atr || last * 0.005;
  const mult = { level1: 1.2, level2: 1.8, level3: 2.8 };
  const suggestions = {};
  for (const [k, m] of Object.entries(mult)) {
    const sl = trend === 'UP' ? entryLow - atrRef * m : entryHigh + atrRef * m;
    const tp1 = trend === 'UP' ? entryHigh + atrRef * (m * 1.5) : entryLow - atrRef * (m * 1.5);
    const tp2 = trend === 'UP' ? entryHigh + atrRef * (m * 3) : entryLow - atrRef * (m * 3);
    suggestions[k] = { stop_loss: sl, take_profit_1: tp1, take_profit_2: tp2, atr_used: atrRef };
  }

  // ----------------- Final Output for Sheet -----------------
  const out = {
    timestamp_utc: new Date().toISOString(),
    symbol,
    exchangeSymbol,
    final_signal,
    close_price: entryRange,

    votes_15m: tfResults['15m']?.signal ?? '',
    votes_1h: tfResults['1h']?.signal ?? '',
    votes_4h: tfResults['4h']?.signal ?? '',
    votes_1d: tfResults['1d']?.signal ?? '',

    score_15m: tfResults['15m']?.score ?? '',
    score_1h: tfResults['1h']?.score ?? '',
    score_4h: tfResults['4h']?.score ?? '',
    score_1d: tfResults['1d']?.score ?? '',

    ATR_used: suggestions.level1.atr_used,

    Level1_SL: suggestions.level1.stop_loss,
    Level1_TP2: suggestions.level1.take_profit_2,

    Level2_SL: suggestions.level2.stop_loss,
    Level2_TP1: suggestions.level2.take_profit_1,
    Level2_TP2: suggestions.level2.take_profit_2,

    Level3_SL: suggestions.level3.stop_loss,
    Level3_TP1: suggestions.level3.take_profit_1,
    Level3_TP2: suggestions.level3.take_profit_2,

    top_reason_15m: tfResults['15m']?.reasons?.[0] ?? '',
    top_reason_1h: tfResults['1h']?.reasons?.[0] ?? '',
    top_reason_4h: tfResults['4h']?.reasons?.[0] ?? '',
    top_reason_1d: tfResults['1d']?.reasons?.[0] ?? '',

    chart_img_url: '',
    notes: ''
  };

  console.log('[indicators] ✅', final_signal, out.close_price);
  return res.status(200).json(out);
}
