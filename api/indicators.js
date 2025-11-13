// api/indicators-swing.js
// Full swing indicator engine — updated with corrected flip-zone logic

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload;

    // ---------- Utilities ----------
    function tryParseMaybeJson(input) {
      if (input === undefined || input === null) return null;
      if (Array.isArray(input)) return input;
      if (typeof input === 'string') {
        try { return JSON.parse(input); } catch { return input; }
      }
      if (typeof input === 'object') return input;
      return null;
    }

    function extractArrayFromPossibleWrapper(x) {
      if (x === undefined || x === null) return [];
      if (Array.isArray(x)) return x;
      if (typeof x === 'object') {
        if (Array.isArray(x.data)) return x.data;
        if (Array.isArray(x.body)) return x.body;
      }
      return [];
    }

    function parseInputField(field) {
      const p = tryParseMaybeJson(field);
      return extractArrayFromPossibleWrapper(p);
    }

    kline_15m = parseInputField(kline_15m);
    kline_1h  = parseInputField(kline_1h);
    kline_4h  = parseInputField(kline_4h);
    kline_1d  = parseInputField(kline_1d);

    const BINANCE_FIELDS = 12;
    function chunkFlatNumericArray(arr, fields = BINANCE_FIELDS) {
      if (!Array.isArray(arr)) return [];
      if (arr.length > 0 && !Array.isArray(arr[0]) && arr.length % fields === 0) {
        const out = [];
        for (let i = 0; i < arr.length; i += fields) out.push(arr.slice(i, i + fields));
        return out;
      }
      return arr;
    }

    function normalizeCandleRow(row) {
      if (!row) return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
      const safe = (v) => {
        if (v === undefined || v === null) return null;
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
      };
      if (Array.isArray(row)) {
        return {
          openTime: safe(row[0]),
          open: safe(row[1]),
          high: safe(row[2]),
          low: safe[row[3]],
          close: safe(row[4]),
          volume: safe(row[5]),
          closeTime: safe(row[6]),
          trades: safe(row[8]),
        };
      } else if (typeof row === 'object') {
        return {
          openTime: safe(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? null),
          open: safe(row.open ?? row.o ?? row.price ?? null),
          high: safe(row.high ?? row.h ?? null),
          low: safe(row.low ?? row.l ?? null),
          close: safe(row.close ?? row.c ?? null),
          volume: safe(row.volume ?? row.v ?? null),
          closeTime: safe(row.closeTime ?? null),
          trades: safe(row.trades ?? row.n ?? null),
        };
      }
      return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
    }

    function normalizeCandlesRaw(raw) {
      if (!raw) return [];
      if (Array.isArray(raw) && raw.length > 0 && !Array.isArray(raw[0])) {
        const chunked = chunkFlatNumericArray(raw, BINANCE_FIELDS);
        if (Array.isArray(chunked) && chunked.length > 0 && Array.isArray(chunked[0])) {
          return chunked.map(normalizeCandleRow);
        }
      }
      if (Array.isArray(raw)) return raw.map(normalizeCandleRow);
      if (typeof raw === 'object') {
        if (Array.isArray(raw.data)) return raw.data.map(normalizeCandleRow);
        if (Array.isArray(raw.body)) return raw.body.map(normalizeCandleRow);
      }
      return [];
    }

    // normalize and limit to last 500 candles
    function takeLast(arr, n = 500) {
      if (!Array.isArray(arr)) return [];
      if (arr.length <= n) return arr;
      return arr.slice(arr.length - n);
    }

    const normalized = {
      '15m': takeLast(normalizeCandlesRaw(kline_15m), 500),
      '1h' : takeLast(normalizeCandlesRaw(kline_1h), 500),
      '4h' : takeLast(normalizeCandlesRaw(kline_4h), 500),
      '1d' : takeLast(normalizeCandlesRaw(kline_1d), 500),
    };

    console.log('[swing] symbol=', symbol, 'lengths=', {
      '15m': normalized['15m'].length,
      '1h': normalized['1h'].length,
      '4h': normalized['4h'].length,
      '1d': normalized['1d'].length,
    });

    // ---------- Indicator helpers ----------
    const toNum = (v) => (v == null ? null : Number(v));

    function sma(values, period) {
      const out = new Array(values.length).fill(null);
      if (period <= 0) return out;
      let sum = 0;
      for (let i = 0; i < values.length; i++) {
        const v = values[i] == null ? 0 : values[i];
        sum += v;
        if (i >= period) sum -= (values[i - period] == null ? 0 : values[i - period]);
        if (i >= period - 1) out[i] = sum / period;
      }
      return out;
    }

    function ema(values, period) {
      const out = new Array(values.length).fill(null);
      if (period <= 0) return out;
      const k = 2 / (period + 1);
      let prev = null;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v == null) { out[i] = null; continue; }
        prev = prev == null ? v : v * k + prev * (1 - k);
        out[i] = prev;
      }
      for (let i = 0; i < period - 1 && i < out.length; i++) out[i] = null;
      return out;
    }

    function rsiWilder(values, period = 14) {
      const out = new Array(values.length).fill(null);
      if (values.length < period + 1) return out;
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const d = values[i] - values[i - 1];
        if (d > 0) gains += d; else losses += Math.abs(d);
      }
      let avgGain = gains / period, avgLoss = losses / period;
      out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
      for (let i = period + 1; i < values.length; i++) {
        const d = values[i] - values[i - 1];
        const g = d > 0 ? d : 0;
        const l = d < 0 ? Math.abs(d) : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
      }
      return out;
    }

    function macd(values, fast = 12, slow = 26, signal = 9) {
      const emaFast = ema(values, fast);
      const emaSlow = ema(values, slow);
      const macdLine = values.map((v, i) =>
        emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i]
      );
      const signalLine = ema(macdLine.map(v => v == null ? 0 : v), signal);
      const hist = macdLine.map((v, i) =>
        v == null || signalLine[i] == null ? null : v - signalLine[i]
      );
      return { macdLine, signalLine, hist };
    }

    function trueRange(highs, lows, closes) {
      const tr = [];
      for (let i = 0; i < highs.length; i++) {
        if (i === 0) tr.push(highs[i] - lows[i]);
        else {
          const a = highs[i] - lows[i];
          const b = Math.abs(highs[i] - closes[i - 1]);
          const c = Math.abs(lows[i] - closes[i - 1]);
          tr.push(Math.max(a, b, c));
        }
      }
      return tr;
    }

    function atr(highs, lows, closes, period = 14) {
      const tr = trueRange(highs, lows, closes);
      const out = new Array(tr.length).fill(null);
      let sum = 0;
      for (let i = 0; i < tr.length; i++) {
        if (i < period) { sum += tr[i]; if (i === period - 1) out[i] = sum / period; continue; }
        out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
      }
      return out;
    }

    function superTrend(highs, lows, closes, period = 10, mult = 3) {
      const atrArr = atr(highs, lows, closes, period);
      const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
      const upper = hl2.map((v, i) => v + mult * (atrArr[i] == null ? 0 : atrArr[i]));
      const lower = hl2.map((v, i) => v - mult * (atrArr[i] == null ? 0 : atrArr[i]));
      const finalUpper = new Array(closes.length).fill(null);
      const finalLower = new Array(closes.length).fill(null);
      const st = new Array(closes.length).fill(null);
      for (let i = 0; i < closes.length; i++) {
        if (i === 0) { finalUpper[i] = upper[i]; finalLower[i] = lower[i]; continue; }
        finalUpper[i] = Math.min(upper[i] == null ? Infinity : upper[i], finalUpper[i - 1] == null ? Infinity : finalUpper[i - 1]);
        finalLower[i] = Math.max(lower[i] == null ? -Infinity : lower[i], finalLower[i - 1] == null ? -Infinity : finalLower[i - 1]);
        if (finalLower[i] == null || finalUpper[i] == null) st[i] = null;
        else st[i] = closes[i] > finalLower[i] ? finalLower[i] : finalUpper[i];
      }
      return st;
    }

    // ---------- Micro-structure (swing points) ----------
    function findSwingPoints(candles, lookback = 3) {
      const highs = candles.map(c => c.high);
      const lows  = candles.map(c => c.low);
      const swingHighs = [], swingLows = [];
      for (let i = lookback; i < highs.length - lookback; i++) {
        const high = highs[i], low = lows[i];
        let isHigh = true, isLow = true;
        for (let j = 1; j <= lookback; j++) {
          if (!(high > highs[i - j] && high > highs[i + j])) isHigh = false;
          if (!(low  < lows [i - j] && low  < lows [i + j])) isLow = false;
        }
        if (isHigh) swingHighs.push({ index: i, price: high });
        if (isLow)  swingLows.push({ index: i, price: low });
      }
      return { swingHighs, swingLows };
    }

    function nearestSwingBelow(price, swings) {
      if (!swings || !swings.length) return null;
      const below = swings.filter(s => s.price < price).map(s => s.price);
      if (!below.length) return null;
      return Math.max(...below);
    }

    function nearestSwingAbove(price, swings) {
      if (!swings || !swings.length) return null;
      const above = swings.filter(s => s.price > price).map(s => s.price);
      if (!above.length) return null;
      return Math.min(...above);
    }

    // ---------- Analysis per timeframe ----------
    function analyzeTimeframe(tfName, candles) {
      const result = { tf: tfName, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };
      const closes = candles.map(c => toNum(c.close));
      const highs = candles.map(c => toNum(c.high));
      const lows = candles.map(c => toNum(c.low));
      const volumes = candles.map(c => toNum(c.volume));
      if (closes.length < 20) return result;

      const sma50 = sma(closes, 50);
      const sma200 = sma(closes, 200);
      const ema9 = ema(closes, 9);
      const ema21 = ema(closes, 21);
      const rsi14 = rsiWilder(closes, 14);
      const macdObj = macd(closes);
      const atr14 = atr(highs, lows, closes, 14);
      const st = superTrend(highs, lows, closes, 10, 3);
      const volSMA20 = sma(volumes, 20);

      const i = closes.length - 1;
      const last = { close: closes[i], high: highs[i], low: lows[i], volume: volumes[i], time: candles[i].openTime };
      result.last = last;

      result.indicators = {
        sma50: sma50[i], sma200: sma200[i],
        ema9: ema9[i], ema21: ema21[i],
        rsi14: rsi14[i],
        macd: macdObj.macdLine[i], macd_signal: macdObj.signalLine[i], macd_hist: macdObj.hist[i],
        atr14: atr14[i],
        supertrend: st[i],
        bb_upper: null, bb_mid: null, bb_lower: null,
        vol_sma20: volSMA20[i], volume: volumes[i]
      };

      let score = 0;
      const sf = 1.0;

      if (last.close != null && result.indicators.sma50 != null)
        score += (last.close > result.indicators.sma50 ? 6 : -6) * sf;

      if (result.indicators.sma50 != null && result.indicators.sma200 != null)
        score += (result.indicators.sma50 > result.indicators.sma200 ? 10 : -10) * sf;

      if (last.close != null && result.indicators.ema9 != null)
        score += (last.close > result.indicators.ema9 ? 5 : -5) * sf;

      if (result.indicators.ema9 != null && result.indicators.ema21 != null)
        score += (result.indicators.ema9 > result.indicators.ema21 ? 3 : -3) * sf;

      if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
        if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0)
          score += 12 * sf;
        else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0)
          score -= 12 * sf;
      }

      if (result.indicators.supertrend != null && last.close != null)
        score += (last.close > result.indicators.supertrend ? 8 : -8) * sf;

      if (result.indicators.rsi14 != null) {
        if (result.indicators.rsi14 < 30) score += 2 * sf;
        else if (result.indicators.rsi14 > 70) score -= 2 * sf;
      }

      if (result.indicators.volume != null && result.indicators.vol_sma20 != null) {
        if (result.indicators.volume > result.indicators.vol_sma20 * 1.3) score += 6 * sf;
        else if (result.indicators.volume < result.indicators.vol_sma20 * 0.7) score -= 3 * sf;
      }

      result.score = Math.max(-200, Math.min(200, Math.round(score)));

      if (result.score >= 40) result.signal = 'STRONG BUY';
      else if (result.score >= 16) result.signal = 'BUY';
      else if (result.score <= -40) result.signal = 'STRONG SELL';
      else if (result.score <= -16) result.signal = 'SELL';
      else result.signal = 'HOLD';

      return result;
    }

    const tfResults = {};
    for (const tf of Object.keys(normalized)) {
      tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);
    }

        console.log('[swing] tfResults sample:', {
      '1d_score': tfResults['1d']?.score, '4h_score': tfResults['4h']?.score,
      '1h_score': tfResults['1h']?.score
    });

    // ---------- Voting / weights ----------
    const tfWeight = { '15m': 0.5, '1h': 1.5, '4h': 3.0, '1d': 4.0 };
    const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };

    for (const tf of Object.keys(tfResults)) {
      const s = tfResults[tf].signal;
      const w = tfWeight[tf] || 1;
      tally[s] += w;
    }

    const strongBuyWeight = tally['STRONG BUY'], strongSellWeight = tally['STRONG SELL'];
    const buyWeight = tally['BUY'] + strongBuyWeight * 1.5;
    const sellWeight = tally['SELL'] + strongSellWeight * 1.5;

    let final_signal = 'HOLD';
    if (strongBuyWeight >= 4.0 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
    else if (strongSellWeight >= 4.0 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
    else if (buyWeight >= sellWeight && buyWeight >= 4.0) final_signal = 'BUY';
    else if (sellWeight > buyWeight && sellWeight >= 4.0) final_signal = 'SELL';
    else final_signal = 'HOLD';

    // ---------- Flip-zone logic (fully rewritten) ----------
    const fallbackPrice =
      tfResults['4h']?.last?.close ??
      tfResults['1h']?.last?.close ??
      tfResults['15m']?.last?.close ??
      null;

    // Unified current price: PRIORITY (15m → 1h → 4h → fallback)
    const currentPrice =
      tfResults['15m']?.last?.close ??
      tfResults['1h']?.last?.close ??
      tfResults['4h']?.last?.close ??
      fallbackPrice ??
      null;

    // Override rules
    const OVERRIDE_CONFIDENCE = 0.60;
    const OVERRIDE_MULTI_TF_COUNT = 2;

    // Swing structure
    const swings4h = findSwingPoints(normalized['4h'], 3);
    const swings1h = findSwingPoints(normalized['1h'], 3);
    const swings15 = findSwingPoints(normalized['15m'], 3);

    function lastImpulseFromSwings(sw) {
      if (!sw) return null;
      const highs = sw.swingHighs;
      const lows = sw.swingLows;
      if (!highs.length || !lows.length) return null;
      const lastHigh = highs[highs.length - 1];
      const lastLow = lows[lows.length - 1];
      if (lastLow.index < lastHigh.index) return { dir: 'UP', low: lastLow.price, high: lastHigh.price };
      if (lastHigh.index < lastLow.index) return { dir: 'DOWN', high: lastHigh.price, low: lastLow.price };
      return null;
    }

    const imp4 = lastImpulseFromSwings(swings4h);
    const imp1 = lastImpulseFromSwings(swings1h);
    const imp15 = lastImpulseFromSwings(swings15);
    let impulse = imp4 || imp1 || imp15;

    if (imp4 && imp1) {
      const size4 = Math.abs(imp4.high - imp4.low);
      const size1 = Math.abs(imp1.high - imp1.low);
      impulse = (size4 >= size1 * 0.8) ? imp4 : imp1;
    }

    function computeFibForImpulse(imp) {
      if (!imp || imp.low == null || imp.high == null) return null;
      const high = imp.high, low = imp.low;

      if (imp.dir === 'UP') {
        return {
          dir: 'UP',
          retr50: low + 0.5 * (high - low),
          retr618: low + 0.618 * (high - low),
          ext1382: low + 1.382 * (high - low),
          ext1618: low + 1.618 * (high - low),
          high, low
        };
      } else {
        return {
          dir: 'DOWN',
          retr50: high - 0.5 * (high - low),
          retr618: high - 0.618 * (high - low),
          ext1382: high - 1.382 * (high - low),
          ext1618: high - 1.618 * (high - low),
          high, low
        };
      }
    }

    const fib = computeFibForImpulse(impulse);

    let flip_zone_confidence = 0;
    let flip_zone_description = null;
    let flip_zone_price = null;

    if (fib && currentPrice != null) {

      function closenessScore(level) {
        if (!Number.isFinite(level) || level === 0) return 0;
        const pct = Math.abs((currentPrice - level) / level);
        if (pct <= 0.005) return 1.0;
        if (pct <= 0.015) return 0.7;
        if (pct <= 0.03) return 0.4;
        if (pct <= 0.06) return 0.15;
        return 0.0;
      }

      const candidates = [];

      candidates.push({
        name: 'retracement 0.5-0.618 zone',
        low: fib.retr50,
        high: fib.retr618,
        score: Math.max(closenessScore(fib.retr50), closenessScore(fib.retr618))
      });

      candidates.push({
        name: 'extension 1.382',
        low: fib.ext1382,
        high: fib.ext1382,
        score: closenessScore(fib.ext1382)
      });

      candidates.push({
        name: 'extension 1.618',
        low: fib.ext1618,
        high: fib.ext1618,
        score: closenessScore(fib.ext1618)
      });

      function structureAlignScore(level) {
        if (!Number.isFinite(level) || !swings4h) return 0;
        const sHigh = Array.isArray(swings4h.swingHighs) ? swings4h.swingHighs.map(s => s.price || 0) : [];
        const sLow = Array.isArray(swings4h.swingLows) ? swings4h.swingLows.map(s => s.price || 0) : [];
        const nearHigh = sHigh.some(p => p > 0 && Math.abs((p - level) / p) < 0.02);
        const nearLow = sLow.some(p => p > 0 && Math.abs((p - level) / p) < 0.02);
        return nearHigh || nearLow ? 0.6 : 0;
      }

      let smaGapFactor = 0.5;
      const s50 = tfResults['4h']?.indicators?.sma50;
      const s200 = tfResults['4h']?.indicators?.sma200;
      if (s50 != null && s200 != null) {
        const gapPct = Math.abs(s50 - s200) / Math.max(1, Math.abs(s200));
        if (gapPct < 0.008) smaGapFactor = 1.0;
        else if (gapPct < 0.02) smaGapFactor = 0.8;
        else smaGapFactor = 0.45;
      }

      let volFactor = 0.6;
      const vol4h = tfResults['4h']?.indicators?.volume;
      const volSma = tfResults['4h']?.indicators?.vol_sma20;
      if (vol4h != null && volSma != null) volFactor = vol4h > volSma * 1.2 ? 1.0 : 0.6;

      const marketTrend =
        final_signal.includes('SELL') ? 'DOWN' :
        final_signal.includes('BUY') ? 'UP' :
        null;

      const MAX_ACCEPT_PCT = 0.20;
      const VISIBILITY_THRESHOLD = 0.25;

      candidates.forEach(c => {
        const center = (c.low + c.high) / 2;
        const distPct = Math.abs((center - currentPrice) / Math.max(1, currentPrice));

        if (!Number.isFinite(center) || distPct > MAX_ACCEPT_PCT) {
          c.combined = -1;
          return;
        }

        const structScore = structureAlignScore(center);
        const dirPenalty =
          (marketTrend && fib.dir && marketTrend !== fib.dir) ? 0.25 : 1.0;

        c.combined =
          (c.score * 0.6 +
          structScore * 0.25 +
          smaGapFactor * 0.1 +
          volFactor * 0.05) * dirPenalty;
      });

      candidates.sort((a, b) => (b.combined || 0) - (a.combined || 0));

      const best = candidates.find(c => c.combined != null && c.combined >= VISIBILITY_THRESHOLD);

      if (best) {
        flip_zone_confidence = Math.max(0, Math.min(1, best.combined));
        flip_zone_price = (best.low + best.high) / 2;
        flip_zone_description = `${best.name} (${flip_zone_price.toFixed(2)})`;
      }
    }

    // ---------- DEBUG LOGGING ----------
    try {
      console.log('[indicators][debug] tfResults summary:', {
        '15m': tfResults['15m']?.score,
        '1h': tfResults['1h']?.score,
        '4h': tfResults['4h']?.score,
        '1d': tfResults['1d']?.score,
        final_signal_before: final_signal
      });
      console.log('[indicators][debug] last closes:', {
        '15m': tfResults['15m']?.last?.close,
        '1h': tfResults['1h']?.last?.close,
        '4h': tfResults['4h']?.last?.close,
        '1d': tfResults['1d']?.last?.close
      });
      console.log('[indicators][debug] flip zone:', {
        flip_zone_price,
        flip_zone_confidence,
        flip_zone_description,
        currentPrice
      });
    } catch (err) {}

    // ---------- Override Logic ----------
    if (flip_zone_price != null && flip_zone_confidence >= OVERRIDE_CONFIDENCE && currentPrice != null) {
      const dirFromFlip =
        currentPrice < flip_zone_price ? 'DOWN' :
        currentPrice > flip_zone_price ? 'UP' :
        null;

      if (dirFromFlip) {
        let alignCount = 0;

        const checkTfAlign = (tf) => {
          const s = tfResults[tf]?.signal || 'HOLD';
          if (dirFromFlip === 'DOWN' && (s.includes('SELL') || s.includes('STRONG SELL'))) return 1;
          if (dirFromFlip === 'UP' && (s.includes('BUY') || s.includes('STRONG BUY'))) return 1;
          return 0;
        };

        alignCount += checkTfAlign('1h');
        alignCount += checkTfAlign('4h');
        alignCount += checkTfAlign('1d');

        if (alignCount >= OVERRIDE_MULTI_TF_COUNT) {
          if (dirFromFlip === 'DOWN') final_signal = 'STRONG SELL';
          else if (dirFromFlip === 'UP') final_signal = 'STRONG BUY';
          console.log('[indicators][debug] final_signal OVERRIDDEN to', final_signal);
        }
      }
    }

    // ---------- ATR Blend ----------
    function pickAtrMulti() {
      const a1d = tfResults['1d']?.indicators?.atr14 ?? null;
      const a4h = tfResults['4h']?.indicators?.atr14 ?? null;
      const a1h = tfResults['1h']?.indicators?.atr14 ?? null;

      const w = { '1d': 0.45, '4h': 0.35, '1h': 0.2 };
      let sum = 0, denom = 0;

      if (a1d != null) { sum += a1d * w['1d']; denom += w['1d']; }
      if (a4h != null) { sum += a4h * w['4h']; denom += w['4h']; }
      if (a1h != null) { sum += a1h * w['1h']; denom += w['1h']; }

      if (denom === 0) return null;
      return sum / denom;
    }

    let atrRef = pickAtrMulti();
    if (atrRef == null && fallbackPrice != null) atrRef = Math.max(1, fallbackPrice * 0.005);

    // ---------- Entry / SL / TP ----------
    const refTf =
      tfResults['4h']?.last?.close ? '4h' :
      tfResults['1h']?.last?.close ? '1h' : '15m';

    const ref = tfResults[refTf];
    const lastClose = ref?.last?.close ?? fallbackPrice;

    const swingsUseLows =
      swings4h.swingLows?.length ? swings4h.swingLows :
      swings1h.swingLows;

    const swingsUseHighs =
      swings4h.swingHighs?.length ? swings4h.swingHighs :
      swings1h.swingHighs;

    const structureLow =
      nearestSwingBelow(lastClose, swingsUseLows) ??
      (lastClose - atrRef * 2);

    const structureHigh =
      nearestSwingAbove(lastClose, swingsUseHighs) ??
      (lastClose + atrRef * 2);

    let rawEntryLow = null;
    let rawEntryHigh = null;

    const ema9v = ref?.indicators?.ema9;
    const stv = ref?.indicators?.supertrend;

    if (final_signal.includes('BUY')) {
      if (ema9v != null && stv != null) {
        rawEntryLow = Math.min(ema9v, stv, structureLow);
        rawEntryHigh = Math.max(ema9v, structureLow);
      } else if (ema9v != null) {
        rawEntryLow = ema9v * 0.995;
        rawEntryHigh = ema9v * 1.002;
      } else {
        rawEntryLow = lastClose * 0.995;
        rawEntryHigh = lastClose * 1.002;
      }
    } else if (final_signal.includes('SELL')) {
      if (ema9v != null && stv != null) {
        rawEntryLow = Math.min(ema9v, structureHigh);
        rawEntryHigh = Math.max(ema9v, stv, structureHigh);
      } else if (ema9v != null) {
        rawEntryLow = ema9v * 0.998;
        rawEntryHigh = ema9v * 1.005;
      } else {
        rawEntryLow = lastClose * 0.998;
        rawEntryHigh = lastClose * 1.002;
      }
    } else {
      rawEntryLow = lastClose;
      rawEntryHigh = lastClose;
    }

    const MAX_ENTRY_PCT = 0.02;
    const MAX_ENTRY_PCT_L2 = 0.04;
    const MAX_ENTRY_PCT_L3 = 0.06;
    const MIN_ENTRY_PCT = 0.001;

    function clampEntryRange(rawLow, rawHigh, lastPrice, maxPct) {
      if (!lastPrice || rawLow == null || rawHigh == null)
        return { low: rawLow, high: rawHigh };

      if (rawLow > rawHigh) {
        const t = rawLow;
        rawLow = rawHigh;
        rawHigh = t;
      }

      const lowPct = Math.abs((rawLow - lastPrice) / lastPrice);
      const highPct = Math.abs((rawHigh - lastPrice) / lastPrice);

      const cappedLow =
        lowPct > maxPct
          ? (rawLow < lastPrice ? lastPrice * (1 - maxPct) : lastPrice * (1 + maxPct))
          : rawLow;

      const cappedHigh =
        highPct > maxPct
          ? (rawHigh < lastPrice ? lastPrice * (1 - maxPct) : lastPrice * (1 + maxPct))
          : rawHigh;

      let finalLow = Math.min(cappedLow, cappedHigh);
      let finalHigh = Math.max(cappedLow, cappedHigh);

      const widthPct = Math.abs((finalHigh - finalLow) / Math.max(1, lastPrice));
      if (widthPct < MIN_ENTRY_PCT) {
        const half = (MIN_ENTRY_PCT * lastPrice) / 2;
        finalLow = lastPrice - half;
        finalHigh = lastPrice + half;
      }

      return { low: finalLow, high: finalHigh };
    }

    const lvl1 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT);
    const lvl2 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT_L2);
    const lvl3 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT_L3);

    const entryPrice =
      lvl1.low != null && lvl1.high != null
        ? (lvl1.low + lvl1.high) / 2
        : lastClose ?? null;

    const slMultipliers = { level1: 1.0, level2: 1.6, level3: 2.6 };
    const suggestions = {};
    const levels = ['level1', 'level2', 'level3'];

    function computeFibTargets(trendDir) {
      if (!fib) return { tp1: null, tp2: null, refHigh: null, refLow: null };
      if (trendDir === 'UP')
        return { tp1: fib.high, tp2: fib.ext1618 || fib.ext1382, refHigh: fib.high, refLow: fib.low };
      if (trendDir === 'DOWN')
        return { tp1: fib.low, tp2: fib.ext1618 || fib.ext1382, refHigh: fib.high, refLow: fib.low };
      return { tp1: null, tp2: null, refHigh: null, refLow: null };
    }

    for (const lvl of levels) {
      const m = slMultipliers[lvl];
      let sl = null, tp1 = null, tp2 = null;

      const entry = entryPrice;

      if (entry == null || atrRef == null) {
        sl = entry ? entry - (entry * 0.02) : null;
        tp1 = entry ? entry + (entry * 0.03) : null;
        tp2 = entry ? entry + (entry * 0.06) : null;
      } else {
        if (final_signal.includes('BUY')) {
          const structural = (impulse && impulse.low != null)
            ? impulse.low * 0.995
            : (entry - atrRef * m);

          sl = Math.min(structural, entry - atrRef * m);

          const fibTargets = computeFibTargets('UP');
          tp1 = fibTargets.tp1 ?? (entry + atrRef * (m * 1.2));
          tp2 = fibTargets.tp2 ?? (entry + atrRef * (m * 2.6));

        } else if (final_signal.includes('SELL')) {

          const structural = (impulse && impulse.high != null)
            ? impulse.high * 1.005
            : (entry + atrRef * m);

          sl = Math.max(structural, entry + atrRef * m);

          const fibTargets = computeFibTargets('DOWN');
          tp1 = fibTargets.tp1 ?? (entry - atrRef * (m * 1.2));
          tp2 = fibTargets.tp2 ?? (entry - atrRef * (m * 2.6));

        } else {
          sl = entry - atrRef * m;
          tp1 = entry + atrRef * (m * 0.9);
          tp2 = entry + atrRef * (m * 1.8);
        }
      }

      function clamp(val, base, pct) {
        if (!Number.isFinite(val) || !Number.isFinite(base)) return val;
        const cap = Math.abs(base) * pct;
        if (Math.abs(val - base) > cap)
          return base + Math.sign(val - base) * cap;
        return val;
      }

      if (entry != null) {
        sl = clamp(sl, entry, 0.08);
        tp1 = clamp(tp1, entry, 0.12);
        tp2 = clamp(tp2, entry, 0.20);
      }

      suggestions[lvl] = {
        entry: entry,
        entry_range: {
          low: lvl === 'level1' ? lvl1.low : (lvl === 'level2' ? lvl2.low : lvl3.low),
          high: lvl === 'level1' ? lvl1.high : (lvl === 'level2' ? lvl2.high : lvl3.high)
        },
        stop_loss: sl,
        take_profit_1: tp1,
        take_profit_2: tp2,
        atr_used: atrRef,
        sl_multiplier: m
      };
    }

    // ---------- Compose output ----------
    const reasons = [];
    for (const tf of Object.keys(tfResults)) {
      const r = tfResults[tf];
      if (r.reasons?.length)
        reasons.push({ timeframe: tf, score: r.score, reasons: r.reasons.slice(0, 6) });
      else
        reasons.push({ timeframe: tf, score: r.score, reasons: [] });
    }

    reasons.push({
      flip_zone_confidence,
      flip_zone_price,
      flip_zone_description
    });

    const output = {
      symbol: symbol || null,
      exchangeSymbol: exchangeSymbol || null,
      final_signal,
      votesSummary: {
        weighted: {
          buyWeight,
          sellWeight,
          strongBuyWeight,
          strongSellWeight
        },
        byTf: Object.fromEntries(Object.keys(tfResults).map(k => [k, tfResults[k].signal]))
      },
      suggestions,
      reasons,
      details: tfResults
    };

    console.log('[swing] final output signal=', final_signal);
    return res.status(200).json(output);

  } catch (err) {
    console.error('[swing] error', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'internal error', detail: String(err && (err.stack || err.message || err)) });
  }
}
