// api/indicators.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  const payload = req.body;
  let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload || {};

  // --- Normalize all 4 klines (handle stringified JSON too) ---
  function parseMaybeJson(input) {
    if (input === null || input === undefined) return [];
    if (Array.isArray(input)) return input;
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.data)) return parsed.data;
        if (parsed && Array.isArray(parsed.body)) return parsed.body;
      } catch (err) {
        console.error('Failed to parse kline string:', err.message);
      }
    }
    if (typeof input === 'object') {
      if (Array.isArray(input.data)) return input.data;
      if (Array.isArray(input.body)) return input.body;
    }
    return [];
  }

  kline_15m = parseMaybeJson(kline_15m);
  kline_1h = parseMaybeJson(kline_1h);
  kline_4h = parseMaybeJson(kline_4h);
  kline_1d = parseMaybeJson(kline_1d);

  // --- Helper: convert any array-of-arrays to normalized candle objects ---
  function normalizeArrayCandleRowToObject(row) {
    const safe = (v) => {
      if (v === undefined || v === null) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    };
    return {
      openTime: safe(row[0]),
      open: safe(row[1]),
      high: safe(row[2]),
      low: safe(row[3]),
      close: safe(row[4]),
      volume: safe(row[5]),
      closeTime: safe(row[6]),
      quoteAssetVolume: safe(row[7]),
      trades: safe(row[8]),
      tbBaseVolume: safe(row[9]),
      tbQuoteVolume: safe(row[10]),
      ignore: safe(row[11]),
    };
  }

  function normalizeCandles(raw) {
    if (!Array.isArray(raw)) return [];
    if (raw.length > 0 && Array.isArray(raw[0])) {
      return raw.map(normalizeArrayCandleRowToObject);
    } else if (raw.length > 0 && typeof raw[0] === 'object') {
      return raw.map((o) => ({
        openTime: Number(o.openTime ?? o.t ?? null),
        open: Number(o.open ?? o.o ?? null),
        high: Number(o.high ?? o.h ?? null),
        low: Number(o.low ?? o.l ?? null),
        close: Number(o.close ?? o.c ?? null),
        volume: Number(o.volume ?? o.v ?? null),
        closeTime: Number(o.closeTime ?? null),
        trades: Number(o.trades ?? o.n ?? null),
      }));
    }
    return [];
  }

  // --- Normalize each timeframe separately ---
  const normalized = {
    '15m': normalizeCandles(kline_15m),
    '1h': normalizeCandles(kline_1h),
    '4h': normalizeCandles(kline_4h),
    '1d': normalizeCandles(kline_1d),
  };

  console.log(`[indicators] symbol=${symbol} lengths=`, Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, v.length])));

  // --- Indicator math helpers ---
  const toNum = (v) => (v == null ? null : Number(v));

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      const slice = values.slice(i - period + 1, i + 1);
      const valid = slice.filter((x) => x != null);
      if (valid.length === period) out[i] = valid.reduce((a, b) => a + b, 0) / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) {
        out[i] = null;
        continue;
      }
      if (prev == null) {
        prev = v;
      } else {
        prev = v * k + prev * (1 - k);
      }
      out[i] = prev;
    }
    for (let i = 0; i < period - 1; i++) out[i] = null;
    return out;
  }

  function rsi(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length < period + 1) return out;
    let gains = 0,
      losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
    return out;
  }

  function macd(values, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const macdLine = values.map((v, i) =>
      emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i]
    );
    const signalLine = ema(macdLine.map((v) => v ?? 0), signal);
    const hist = macdLine.map((v, i) =>
      v == null || signalLine[i] == null ? null : v - signalLine[i]
    );
    return { macdLine, signalLine, hist };
  }

  function atr(highs, lows, closes, period = 14) {
    const tr = [];
    for (let i = 0; i < highs.length; i++) {
      if (i === 0) tr.push(highs[i] - lows[i]);
      else
        tr.push(
          Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
          )
        );
    }
    const out = sma(tr, period);
    return out;
  }

  function superTrend(highs, lows, closes, period = 10, mult = 3) {
    const atrArr = atr(highs, lows, closes, period);
    const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
    const upper = hl2.map((v, i) => v + mult * atrArr[i]);
    const lower = hl2.map((v, i) => v - mult * atrArr[i]);
    const final = [];
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) final.push(null);
      else final.push(closes[i] > lower[i] ? lower[i] : upper[i]);
    }
    return final;
  }

  // --- Compute indicators for each timeframe ---
  const result = {
    symbol,
    final_signal: 'HOLD',
    votes: { BUY: 0, SELL: 0, HOLD: 0 },
    details: { symbol, exchangeSymbol, timeframes: {} },
  };

  for (const tf of Object.keys(normalized)) {
    const candles = normalized[tf];
    const closes = candles.map((c) => toNum(c.close));
    const highs = candles.map((c) => toNum(c.high));
    const lows = candles.map((c) => toNum(c.low));
    const volumes = candles.map((c) => toNum(c.volume));
    const lastIdx = closes.length - 1;

    if (closes.length < 26) {
      result.details.timeframes[tf] = {
        last: { open: null, high: null, low: null, close: null, volume: null },
        indicators: { sma50: null, ema9: null, rsi14: null, macd: null, signal: null, hist: null, atr14: null },
        signal: 'HOLD',
      };
      result.votes.HOLD++;
      continue;
    }

    const sma50Arr = sma(closes, 50);
    const ema9Arr = ema(closes, 9);
    const rsi14Arr = rsi(closes, 14);
    const macdObj = macd(closes);
    const atr14Arr = atr(highs, lows, closes);
    const stArr = superTrend(highs, lows, closes);

    const last = candles[lastIdx];
    const indicators = {
      sma50: sma50Arr[lastIdx],
      ema9: ema9Arr[lastIdx],
      rsi14: rsi14Arr[lastIdx],
      macd: macdObj.macdLine[lastIdx],
      signal: macdObj.signalLine[lastIdx],
      hist: macdObj.hist[lastIdx],
      atr14: atr14Arr[lastIdx],
      supertrend: stArr[lastIdx],
    };

    // --- Simple signal logic ---
    let signal = 'HOLD';
    const macdBull = indicators.macd > indicators.signal && indicators.hist > 0;
    const macdBear = indicators.macd < indicators.signal && indicators.hist < 0;
    const superBull = closes[lastIdx] > indicators.supertrend;
    const superBear = closes[lastIdx] < indicators.supertrend;

    if (macdBull && superBull && closes[lastIdx] > indicators.ema9) signal = 'BUY';
    else if (macdBear && superBear && closes[lastIdx] < indicators.ema9) signal = 'SELL';

    result.details.timeframes[tf] = { last, indicators, signal };
    result.votes[signal]++;
  }

  // --- Final decision based on votes ---
  if (result.votes.BUY > result.votes.SELL && result.votes.BUY >= 2) result.final_signal = 'BUY';
  else if (result.votes.SELL > result.votes.BUY && result.votes.SELL >= 2) result.final_signal = 'SELL';
  else result.final_signal = 'HOLD';

  res.status(200).json(result);
}
