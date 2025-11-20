// api/indicators-swing.js
// Full swing indicator engine — copy/paste ready
// --------- Lightweight in-memory store (cooldown; best-effort in serverless) ---------
const COOLDOWN_STATE = new Map();
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d, tickSize, priceTickSize } = payload;

    // -------- Feature Flags and cooldown client-assist --------
    const inputFlags = (payload && typeof payload.flags === 'object') ? payload.flags : {};
    const flags = {
      instrumentation: !!inputFlags.instrumentation,
      ltf_stability:   !!inputFlags.ltf_stability,
      adaptive_proximity: !!inputFlags.adaptive_proximity,
      regime_filter:      !!inputFlags.regime_filter,
      zone_quality:       !!inputFlags.zone_quality,
      tp_sl_refine:       !!inputFlags.tp_sl_refine,
      cooldown:           !!inputFlags.cooldown,
    };
    const clientLastReadyIndex = Number.isFinite(Number(payload?.lastReadyIndex)) ? Number(payload.lastReadyIndex) : null;
    const clientLastReadyTime  = Number.isFinite(Number(payload?.lastReadyTime))  ? Number(payload.lastReadyTime)  : null;

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
          low: safe(row[3]),
          close: safe(row[4]),
          volume: safe(row[5]),
        };
      } else if (typeof row === 'object') {
        return {
          openTime: safe(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? null),
          open: safe(row.open ?? row.o ?? row.price ?? null),
          high: safe(row.high ?? row.h ?? null),
          low: safe(row.low ?? row.l ?? null),
          close: safe(row.close ?? row.c ?? null),
          volume: safe(row.volume ?? row.v ?? null),
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

    // normalize and limit to last 500 candles as you said
    function takeLast(arr, n = 500) {
      if (!Array.isArray(arr)) return [];
      if (arr.length <= n) return arr;
      return arr.slice(arr.length - n);
    }

    // Ensure ascending sort by openTime, dedupe by openTime
    // KEEP in-progress candles for real-time price calculation
    function finalizeCandles(rawArr) {
      if (!Array.isArray(rawArr)) return [];
      const arr = rawArr
        .filter(c => c && c.openTime != null && Number.isFinite(Number(c.openTime)));
      arr.sort((a, b) => Number(a.openTime) - Number(b.openTime));
      // dedupe by openTime (keep first after sorting)
      const out = [];
      const seen = new Set();
      for (let i = 0; i < arr.length; i++) {
        const ot = Number(arr[i].openTime);
        if (seen.has(ot)) continue;
        seen.add(ot);
        out.push(arr[i]);
      }
      // DO NOT drop in-progress candles - we need real-time price
      return out;
    }

    const normalized = {
      '15m': takeLast(finalizeCandles(normalizeCandlesRaw(kline_15m)), 500),
      '1h' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_1h)), 500),
      '4h' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_4h)), 500),
      '1d' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_1d)), 500),
    };

    console.log('[swing] symbol=', symbol, 'lengths=', {
      '15m': normalized['15m'].length,
      '1h': normalized['1h'].length,
      '4h': normalized['4h'].length,
      '1d': normalized['1d'].length,
    });

    // Get the last closed 15m candle price (used for all calculations)
    function getCurrentPrice() {
      const candles15m = normalized['15m'] || [];
      if (candles15m.length > 0) {
        const last15m = candles15m[candles15m.length - 1];
        if (last15m && last15m.close != null && Number.isFinite(last15m.close)) {
          return last15m.close;
        }
      }
      return null;
    }

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

    function superTrendCanonical(highs, lows, closes, period = 10, mult = 3) {
      const len = closes.length;
      const atrArr = atr(highs, lows, closes, period);
      const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
      const upperBasic = hl2.map((v, i) => v + mult * (atrArr[i] == null ? 0 : atrArr[i]));
      const lowerBasic = hl2.map((v, i) => v - mult * (atrArr[i] == null ? 0 : atrArr[i]));
      const finalUpper = new Array(len).fill(null);
      const finalLower = new Array(len).fill(null);
      const st = new Array(len).fill(null);
      const trend = new Array(len).fill(null); // 1 up, -1 down
      for (let i = 0; i < len; i++) {
        if (i === 0) {
          finalUpper[i] = upperBasic[i];
          finalLower[i] = lowerBasic[i];
          st[i] = null;
          trend[i] = null;
          continue;
        }
        // Carry-forward logic (classic ST)
        finalUpper[i] = (upperBasic[i] < (finalUpper[i - 1] == null ? Infinity : finalUpper[i - 1]) || closes[i - 1] > (finalUpper[i - 1] == null ? Infinity : finalUpper[i - 1]))
          ? upperBasic[i]
          : finalUpper[i - 1];
        finalLower[i] = (lowerBasic[i] > (finalLower[i - 1] == null ? -Infinity : finalLower[i - 1]) || closes[i - 1] < (finalLower[i - 1] == null ? -Infinity : finalLower[i - 1]))
          ? lowerBasic[i]
          : finalLower[i - 1];
        // Determine current ST band and trend state
        if (st[i - 1] == null) {
          st[i] = closes[i] >= finalLower[i] ? finalLower[i] : finalUpper[i];
        } else if (st[i - 1] === finalUpper[i - 1]) {
          st[i] = closes[i] <= finalUpper[i] ? finalUpper[i] : finalLower[i];
        } else {
          st[i] = closes[i] >= finalLower[i] ? finalLower[i] : finalUpper[i];
        }
        trend[i] = (st[i] === finalLower[i]) ? 1 : -1;
      }
      return { st, trend };
    }

    // ---------- Micro-structure (swing points) ----------
    // Improved swing point detection with timeframe-aware lookback and ATR validation
    function findSwingPoints(candles, lookback = 3, atrValue = null, minSeparationMultiplier = 2.0) {
      if (!candles || candles.length < lookback * 2 + 1) {
        return { swingHighs: [], swingLows: [] };
      }
      
      const highs = candles.map(c => toNum(c.high));
      const lows  = candles.map(c => toNum(c.low));
      const closes = candles.map(c => toNum(c.close));
      
      // Calculate ATR if not provided (fallback for validation)
      let atrVal = atrValue;
      if (atrVal == null && closes.length >= 14) {
        const atrArr = atr(highs, lows, closes, 14);
        atrVal = atrArr[atrArr.length - 1];
      }
      // Fallback: use 0.3% of current price if ATR unavailable
      if (atrVal == null && closes.length > 0) {
        const lastClose = closes[closes.length - 1];
        atrVal = lastClose != null ? lastClose * 0.003 : null;
      }
      
      const swingHighs = [], swingLows = [];
      const minSeparation = (atrVal != null && Number.isFinite(atrVal)) ? atrVal * minSeparationMultiplier : null;
      
      for (let i = lookback; i < highs.length - lookback; i++) {
        const high = highs[i], low = lows[i];
        
        // Skip if price data is invalid
        if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
        
        let isHigh = true, isLow = true;
        
        // Check if this candle's high/low is higher/lower than surrounding candles
        for (let j = 1; j <= lookback; j++) {
          const prevHigh = highs[i - j], nextHigh = highs[i + j];
          const prevLow = lows[i - j], nextLow = lows[i + j];
          
          // Validate high: must be higher than all surrounding candles
          if (!Number.isFinite(prevHigh) || !Number.isFinite(nextHigh) || 
              !(high > prevHigh && high > nextHigh)) {
            isHigh = false;
          }
          
          // Validate low: must be lower than all surrounding candles
          if (!Number.isFinite(prevLow) || !Number.isFinite(nextLow) || 
              !(low < prevLow && low < nextLow)) {
            isLow = false;
          }
        }
        
        // Additional validation: ensure swing point has significant price separation
        if (isHigh && minSeparation != null) {
          // Check separation from nearest swing high
          if (swingHighs.length > 0) {
            const lastHigh = swingHighs[swingHighs.length - 1];
            const separation = Math.abs(high - lastHigh.price);
            if (separation < minSeparation) {
              // Keep the higher one
              if (high > lastHigh.price) {
                swingHighs.pop();
              } else {
                isHigh = false;
              }
            }
          }
        }
        
        if (isLow && minSeparation != null) {
          // Check separation from nearest swing low
          if (swingLows.length > 0) {
            const lastLow = swingLows[swingLows.length - 1];
            const separation = Math.abs(low - lastLow.price);
            if (separation < minSeparation) {
              // Keep the lower one
              if (low < lastLow.price) {
                swingLows.pop();
              } else {
                isLow = false;
              }
            }
          }
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

    // ---------- Analysis per timeframe (swing optimized) ----------
    function analyzeTimeframe(tfName, candles) {
      const result = { tf: tfName, indicators: {}, last: {}, score: 0, signal: 'HOLD' };
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
      const stObj = superTrendCanonical(highs, lows, closes, 10, 3);
      const st = stObj.st;
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
        vol_sma20: volSMA20[i], volume: volumes[i]
      };

      let score = 0;
      if (last.close != null && result.indicators.sma50 != null) score += (last.close > result.indicators.sma50 ? 6 : -6);
      if (result.indicators.sma50 != null && result.indicators.sma200 != null) score += (result.indicators.sma50 > result.indicators.sma200 ? 10 : -10);
      if (last.close != null && result.indicators.ema9 != null) score += (last.close > result.indicators.ema9 ? 5 : -5);
      if (result.indicators.ema9 != null && result.indicators.ema21 != null) score += (result.indicators.ema9 > result.indicators.ema21 ? 3 : -3);
      if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
        if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0) score += 12;
        else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0) score -= 12;
      }
      if (result.indicators.supertrend != null && last.close != null) score += (last.close > result.indicators.supertrend ? 8 : -8);
      if (result.indicators.rsi14 != null) {
        if (result.indicators.rsi14 < 30) score += 2; else if (result.indicators.rsi14 > 70) score -= 2;
      }
      if (result.indicators.volume != null && result.indicators.vol_sma20 != null) {
        if (result.indicators.volume > result.indicators.vol_sma20 * 1.3) score += 6;
        else if (result.indicators.volume < result.indicators.vol_sma20 * 0.7) score -= 3;
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

    // ---------- Voting / weights (swing) ----------
    // Timeframe roles:
    // - 1d  : trend filter only (NOT part of vote; used elsewhere for alignment)
    // - 4h  : PRIMARY swing timeframe for bias
    // - 1h  : CONFIRMATION timeframe
    // - 15m : EXECUTION / fine-tune timeframe
    const tfWeight = { '15m': 0.5, '1h': 1.0, '4h': 3.0, '1d': 0.0 };
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

    const currentPrice = getCurrentPrice();
    
    let flip_zone_price = null;
    let flip_zone_confidence = 0;
    let flip_zone_description = null;

    const OVERRIDE_CONFIDENCE = 0.60;
    const OVERRIDE_MULTI_TF_COUNT = 2;
    
    if (flip_zone_price != null && flip_zone_confidence >= OVERRIDE_CONFIDENCE && currentPrice != null) {
      const dirFromFlip = currentPrice < flip_zone_price ? 'DOWN' : (currentPrice > flip_zone_price ? 'UP' : null);
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
        }
      }
    }
    

    let atrRef = tfResults['4h']?.indicators?.atr14 ?? null;
    if (atrRef == null && currentPrice != null) atrRef = currentPrice * 0.003;

    // ---------- Swing structure & Fibonacci projections ----------
    // Prefer 4h for swing structure, fallback to 1h then 15m
    // Timeframe-specific lookback: 4h=6 (5-7 range), 1h=5 (4-5 range), 15m=3 (appropriate for lower TF)
    // ATR validation ensures minimum 2x ATR separation between swing points
    const atr4h = tfResults['4h']?.indicators?.atr14 ?? null;
    const atr1h = tfResults['1h']?.indicators?.atr14 ?? null;
    const atr15m = tfResults['15m']?.indicators?.atr14 ?? null;
    
    const swings4h = findSwingPoints(normalized['4h'], 6, atr4h, 2.0);
    const swings1h = findSwingPoints(normalized['1h'], 5, atr1h, 2.0);
    const swings15 = findSwingPoints(normalized['15m'], 3, atr15m, 2.0);

    // Break-of-Structure detection with comprehensive validation
    // Validates: volume confirmation, time persistence, closing candle break, HTF alignment, liquidity sweep
    function detectBosFromSwings(candles, swings, tfName, tfResults, minHoldCandles = 2) {
      if (!candles || !candles.length || !swings) return null;
      
      const closes = candles.map(c => toNum(c.close));
      const highs = candles.map(c => toNum(c.high));
      const lows = candles.map(c => toNum(c.low));
      const volumes = candles.map(c => toNum(c.volume));
      const opens = candles.map(c => toNum(c.open));
      
      if (closes.length < minHoldCandles + 1) return null;
      
      const sh = (swings.swingHighs || []).map(x => x.index).sort((a,b)=>a-b);
      const sl = (swings.swingLows  || []).map(x => x.index).sort((a,b)=>a-b);
      if (!sh.length || !sl.length) return null;
      
      const lastHighIdx = sh[sh.length - 1];
      const lastLowIdx  = sl[sl.length - 1];
      const lastHighVal = toNum(candles[lastHighIdx]?.high);
      const lastLowVal  = toNum(candles[lastLowIdx]?.low);
      
      if (!Number.isFinite(lastHighVal) || !Number.isFinite(lastLowVal)) return null;
      
      const i = closes.length - 1;
      const lastClose = closes[i];
      const lastHigh = highs[i];
      const lastLow = lows[i];
      
      if (!Number.isFinite(lastClose)) return null;
      
      // Check for potential BOS direction
      // BOS requires CLOSING candle break (not just wick) - close must break the level
      let dir = null, brokenLevel = null, breakCandleIdx = null;
      
      // Check UP BOS: closing price broke above last swing high
      if (lastClose > lastHighVal) {
        dir = 'UP';
        brokenLevel = lastHighVal;
        breakCandleIdx = i;
      }
      // Check DOWN BOS: closing price broke below last swing low
      else if (lastClose < lastLowVal) {
        dir = 'DOWN';
        brokenLevel = lastLowVal;
        breakCandleIdx = i;
      }
      
      if (!dir || breakCandleIdx == null) return null;
      
      // VALIDATION 1: Time persistence - BOS must hold for minimum candles AFTER the break
      // Check if price reversed back through broken level in candles after the break
      const candlesAfterBreak = i - breakCandleIdx;
      let validHold = true;
      
      // Check all candles from break candle onwards to ensure no reversal
      for (let k = breakCandleIdx; k <= i; k++) {
        if (dir === 'UP') {
          // For UP BOS, price must stay above broken level
          if (closes[k] <= brokenLevel) {
            validHold = false;
            break;
          }
        } else {
          // For DOWN BOS, price must stay below broken level
          if (closes[k] >= brokenLevel) {
            validHold = false;
            break;
          }
        }
      }
      
      // Time confirmation: need at least minHoldCandles candles after break to confirm persistence
      // If break just happened (last candle), it's not time-confirmed yet
      const timeConfirmed = candlesAfterBreak >= minHoldCandles - 1;
      
      // Reject if price reversed back through broken level
      if (!validHold) return null;
      
      // For swing trading: prefer time-confirmed BOS, but allow recent breaks if other validations are strong
      // However, if break happened less than 1 candle ago, it's too fresh - wait for confirmation
      if (candlesAfterBreak < 1) return null;
      const tfResult = tfResults[tfName];
      const avgVolume = tfResult?.indicators?.vol_sma20;
      const breakVolume = volumes[breakCandleIdx];
      const volumeRatio = (Number.isFinite(avgVolume) && Number.isFinite(breakVolume) && avgVolume > 0) 
        ? breakVolume / avgVolume 
        : null;
      
      const tf1d = tfResults['1d'];
      let htfAligned = true;
      if (tf1d) {
        const price1d = tf1d.last?.close;
        const ema21_1d = tf1d.indicators?.ema21;
        const rsi14_1d = tf1d.indicators?.rsi14;
        if (Number.isFinite(price1d) && Number.isFinite(ema21_1d)) {
          if (dir === 'UP') {
            if (price1d < ema21_1d) htfAligned = false;
            if (Number.isFinite(rsi14_1d) && rsi14_1d < 50) htfAligned = false;
          } else {
            if (price1d > ema21_1d) htfAligned = false;
            if (Number.isFinite(rsi14_1d) && rsi14_1d > 50) htfAligned = false;
          }
        }
      }
      if (!htfAligned) return null;
      
      let liquiditySwept = false;
      const lookbackForSweep = Math.min(10, breakCandleIdx);
      if (dir === 'UP') {
        for (let k = Math.max(0, breakCandleIdx - lookbackForSweep); k < breakCandleIdx; k++) {
          if (lows[k] < lastLowVal * 0.999) {
            liquiditySwept = true;
            break;
          }
        }
      } else {
        for (let k = Math.max(0, breakCandleIdx - lookbackForSweep); k < breakCandleIdx; k++) {
          if (highs[k] > lastHighVal * 1.001) {
            liquiditySwept = true;
            break;
          }
        }
      }
      
      // Impulse causing BOS: last opposite swing to broken swing
      let startIdx = null, endIdx = null, low = null, high = null;
      
      if (dir === 'UP') {
        // from last swing low up to the broken swing high
        const prevLowIdx = sl[sl.length - 1];
        startIdx = prevLowIdx; 
        endIdx = lastHighIdx;
        low = toNum(candles[startIdx]?.low); 
        high = toNum(candles[endIdx]?.high);
      } else {
        const prevHighIdx = sh[sh.length - 1];
        startIdx = prevHighIdx; 
        endIdx = lastLowIdx;
        high = toNum(candles[startIdx]?.high); 
        low = toNum(candles[endIdx]?.low);
      }
      
      if (!Number.isFinite(low) || !Number.isFinite(high) || startIdx == null || endIdx == null) {
        return null;
      }
      
      return { 
        dir, 
        brokenLevel, 
        startIdx, 
        endIdx, 
        low, 
        high,
        breakCandleIdx,
        candlesAfterBreak,
        timeConfirmed,
        volumeConfirmed: volumeRatio != null && volumeRatio >= 1.5,
        volumeRatio: volumeRatio,
        liquiditySwept,
        htfAligned: true, // Already validated above
        valid: true // All critical validations passed
      };
    }
    const bos = detectBosFromSwings(normalized['4h'], swings4h, '4h', tfResults, 2);

    // Dominant impulse detection from swings with ATR/recency threshold (prefer 4h)
    function dominantImpulseFromSwings(sw, atrVal, refPrice, maxLegs = 12) {
      if (!sw || !Array.isArray(sw.swingHighs) || !Array.isArray(sw.swingLows)) return null;
      const highs = sw.swingHighs.slice();
      const lows = sw.swingLows.slice();
      if (!highs.length || !lows.length) return null;
      // Merge pivots by index
      const pivots = [
        ...highs.map(h => ({ type: 'H', index: h.index, price: h.price })),
        ...lows.map(l => ({ type: 'L', index: l.index, price: l.price })),
      ].sort((a, b) => a.index - b.index);
      // Build legs between alternating pivot types
      const legs = [];
      for (let i = 1; i < pivots.length; i++) {
        const a = pivots[i - 1], b = pivots[i];
        if (a.type === b.type) continue;
        if (a.type === 'L' && b.type === 'H') {
          legs.push({ dir: 'UP', low: a.price, high: b.price, start: a.index, end: b.index });
        } else if (a.type === 'H' && b.type === 'L') {
          legs.push({ dir: 'DOWN', high: a.price, low: b.price, start: a.index, end: b.index });
        }
      }
      if (!legs.length) return null;
      // Consider only the last N legs
      const recent = legs.slice(-maxLegs);
      const price = refPrice != null ? refPrice : (recent.length ? (recent[recent.length - 1].high + recent[recent.length - 1].low) / 2 : null);
      const atr = atrVal != null ? atrVal : (price != null ? price * 0.003 : 0);
      const sizeThreshold = Math.max(atr * 2.5, (price != null ? price * 0.003 : 0));
      // Pick the most recent leg meeting threshold; else pick the largest recent leg
      for (let i = recent.length - 1; i >= 0; i--) {
        const leg = recent[i];
        const sz = Math.abs((leg.high ?? 0) - (leg.low ?? 0));
        if (sz >= sizeThreshold && Number.isFinite(sz) && sz > 0) return leg;
      }
      // Fallback: largest leg among recent
      let best = null, bestSize = -Infinity;
      for (const leg of recent) {
        const sz = Math.abs((leg.high ?? 0) - (leg.low ?? 0));
        if (Number.isFinite(sz) && sz > bestSize) { best = leg; bestSize = sz; }
      }
      return best;
    }

    let impulse =
      dominantImpulseFromSwings(swings4h, atrRef, currentPrice) ||
      dominantImpulseFromSwings(swings1h, atrRef, currentPrice) ||
      dominantImpulseFromSwings(swings15, atrRef, currentPrice) ||
      null;
    if (bos && Number.isFinite(bos.low) && Number.isFinite(bos.high)) {
      impulse = { dir: bos.dir, low: bos.low, high: bos.high, start: bos.startIdx, end: bos.endIdx };
    }

    function computeFibForImpulse(imp) {
      if (!imp || imp.low == null || imp.high == null) return null;
      const high = imp.high, low = imp.low;
      const leg = Math.abs(high - low);
      if (!isFinite(leg) || leg === 0) return null;
      if (imp.dir === 'UP') {
        const ext1272 = low + 1.272 * (high - low);
        const ext1382 = low + 1.382 * (high - low);
        const ext1414 = low + 1.414 * (high - low);
        const ext1618 = low + 1.618 * (high - low);
        const retr382 = low + 0.382 * (high - low);
        const retr50  = low + 0.5   * (high - low);
        const retr618 = low + 0.618 * (high - low);
        const retr705 = low + 0.705 * (high - low);
        const retr786 = low + 0.786 * (high - low);
        return { dir: 'UP', retr382, retr50, retr618, retr705, retr786, ext1272, ext1382, ext1414, ext1618, low, high };
      } else {
        const ext1272 = high - 1.272 * (high - low);
        const ext1382 = high - 1.382 * (high - low);
        const ext1414 = high - 1.414 * (high - low);
        const ext1618 = high - 1.618 * (high - low);
        const retr382 = high - 0.382 * (high - low);
        const retr50  = high - 0.5   * (high - low);
        const retr618 = high - 0.618 * (high - low);
        const retr705 = high - 0.705 * (high - low);
        const retr786 = high - 0.786 * (high - low);
        return { dir: 'DOWN', retr382, retr50, retr618, retr705, retr786, ext1272, ext1382, ext1414, ext1618, low, high };
      }
    }

    const fib = computeFibForImpulse(impulse);

    flip_zone_confidence = 0;
    flip_zone_description = null;
    flip_zone_price = null;
    if (fib && currentPrice != null) {
      function closenessScore(level) {
        if (!Number.isFinite(level) || level === 0) return 0;
        const pct = Math.abs((currentPrice - level) / level);
        // if within 0.5% -> 1.0 ; within 1.5% -> 0.7 ; within 3% -> 0.4 ; else smaller
        if (pct <= 0.005) return 1.0;
        if (pct <= 0.015) return 0.7;
        if (pct <= 0.03) return 0.4;
        if (pct <= 0.06) return 0.15;
        return 0.0;
      }
      const candidates = [];
      const pushRetr = (name, lo, hi) => candidates.push({ type: 'retracement', name, low: lo, high: hi, score: Math.max(closenessScore(lo), closenessScore(hi)) });
      const pushExt  = (name, lv)      => candidates.push({ type: 'extension',   name, low: lv, high: lv, score: closenessScore(lv) });
      // Retracement zones
      pushRetr('retracement 0.382', fib.retr382, fib.retr382);
      pushRetr('retracement 0.5-0.618 zone', fib.retr50, fib.retr618);
      pushRetr('retracement 0.705-0.786 zone', fib.retr705, fib.retr786);
      // Extensions
      pushExt('extension 1.272', fib.ext1272);
      pushExt('extension 1.382', fib.ext1382);
      pushExt('extension 1.414', fib.ext1414);
      pushExt('extension 1.618', fib.ext1618);

      // structural support/resistance alignment: check if fib candidate sits near 4h swing high/low
      function structureAlignScore(level) {
        if (!Number.isFinite(level)) return 0;
        const sHigh = swings4h.swingHighs.map(s => s.price || 0);
        const sLow = swings4h.swingLows.map(s => s.price || 0);
        const nearHigh = sHigh.some(p => Math.abs((p - level) / Math.max(1, p)) < 0.02);
        const nearLow = sLow.some(p => Math.abs((p - level) / Math.max(1, p)) < 0.02);
        return nearHigh || nearLow ? 0.6 : 0;
      }

      // SMA gap factor: if SMA50 vs SMA200 on 4h is wide -> less likely immediate flip; if close -> more likely
      let smaGapFactor = 0.5;
      const s50 = tfResults['4h']?.indicators?.sma50, s200 = tfResults['4h']?.indicators?.sma200;
      if (s50 != null && s200 != null) {
        const gapPct = Math.abs(s50 - s200) / Math.max(1, Math.abs(s200));
        if (gapPct < 0.008) smaGapFactor = 1.0;
        else if (gapPct < 0.02) smaGapFactor = 0.8;
        else smaGapFactor = 0.45;
      }

      // volume factor: heavy volume on impulse increases flip validity
      let volFactor = 0.6;
      const vol4h = tfResults['4h']?.indicators?.volume, volSma = tfResults['4h']?.indicators?.vol_sma20;
      if (vol4h != null && volSma != null) volFactor = vol4h > volSma * 1.2 ? 1.0 : 0.6;

      // Combine candidate scores
      candidates.forEach(c => {
        const structScore = structureAlignScore((c.low + c.high) / 2);
        c.combined = (c.score * 0.55 + structScore * 0.25 + smaGapFactor * 0.12 + volFactor * 0.08);
      });
      // pick best candidate
      candidates.sort((a,b) => b.combined - a.combined);
      if (candidates.length) {
        const best = candidates[0];
        flip_zone_confidence = Math.max(0, Math.min(1, best.combined));
      
        // Compute the midpoint of the flip zone (exact price)
        const flipMid = (best.low + best.high) / 2;
        flip_zone_price = flipMid;
        flip_zone_description = `${best.name} (${flipMid ? flipMid.toFixed(2) : 'n/a'})`;
        // Determine recommended action at flip zone
        let flip_zone_action = null;
        let direction_after_flip = null;
        if (best.type === 'retracement') {
          if (fib.dir === 'UP') { flip_zone_action = 'LONG'; direction_after_flip = 'BUY'; }
          else { flip_zone_action = 'SHORT'; direction_after_flip = 'SELL'; }
        } else if (best.type === 'extension') {
          if (fib.dir === 'UP') { flip_zone_action = 'SHORT'; direction_after_flip = 'SELL'; }
          else { flip_zone_action = 'LONG'; direction_after_flip = 'BUY'; }
        }
        var _flip_meta = {
          low: best.low, high: best.high, action: flip_zone_action, direction_after_flip,
          type: best.type, name: best.name
        };
      }
    }


    // ---------- Multi-impulse confluence (golden pocket + 0.714 focus) ----------
    function buildImpulseList(sw) {
      if (!sw || !sw.swingHighs || !sw.swingLows) return [];
      const pivots = [
        ...sw.swingHighs.map(h => ({ t: 'H', i: h.index, p: h.price })),
        ...sw.swingLows.map(l => ({ t: 'L', i: l.index, p: l.price })),
      ].sort((a,b)=>a.i-b.i);
      const legs = [];
      for (let k = 1; k < pivots.length; k++) {
        const a = pivots[k-1], b = pivots[k];
        if (a.t === b.t) continue;
        if (a.t === 'L' && b.t === 'H') legs.push({ dir:'UP', low:a.p, high:b.p, start:a.i, end:b.i });
        if (a.t === 'H' && b.t === 'L') legs.push({ dir:'DOWN', high:a.p, low:b.p, start:a.i, end:b.i });
      }
      return legs.slice(-6);
    }
    function fibsForLeg(leg) {
      return computeFibForImpulse(leg);
    }
    const legs4h = buildImpulseList(swings4h);
    const fibsList = legs4h.map(fibsForLeg).filter(Boolean);
    // Build candidate zones emphasizing golden pocket (0.618-0.65) and 0.714; plus 1.382/1.618 extensions
    function zonesFromFib(f) {
      const zones = [];
      const gpLow = f.dir === 'UP' ? (f.low + 0.618*(f.high - f.low)) : (f.high - 0.65*(f.high - f.low)); // compute properly
      const gpHigh = f.dir === 'UP' ? (f.low + 0.65*(f.high - f.low)) : (f.high - 0.618*(f.high - f.low));
      const z_gp = { label:'golden_pocket_0.618_0.65', type:'retracement', low: Math.min(gpLow,gpHigh), high: Math.max(gpLow,gpHigh), dir:f.dir };
      const z_0714 = { label:'retracement_0.714', type:'retracement',
        low: f.dir==='UP' ? (f.low + 0.714*(f.high - f.low)) : (f.high - 0.714*(f.high - f.low)),
        high: f.dir==='UP' ? (f.low + 0.714*(f.high - f.low)) : (f.high - 0.714*(f.high - f.low)),
        dir:f.dir };
      const z_ext1382 = { label:'extension_1.382', type:'extension',
        low: f.ext1382, high: f.ext1382, dir:f.dir };
      const z_ext1618 = { label:'extension_1.618', type:'extension',
        low: f.ext1618, high: f.ext1618, dir:f.dir };
      zones.push(z_gp, z_0714, z_ext1382, z_ext1618);
      return zones;
    }
    const allZones = fibsList.flatMap(zonesFromFib).filter(z => Number.isFinite(z.low) && Number.isFinite(z.high));
    // Merge overlaps into hot zones
    function overlapRange(a,b) {
      const lo = Math.max(Math.min(a.low,a.high), Math.min(b.low,b.high));
      const hi = Math.min(Math.max(a.low,a.high), Math.max(b.low,b.high));
      return lo <= hi ? { low: lo, high: hi } : null;
    }
    const hotZones = [];
    for (let i = 0; i < allZones.length; i++) {
      for (let j = i+1; j < allZones.length; j++) {
        const o = overlapRange(allZones[i], allZones[j]);
        if (o) {
          const includes0714 = (allZones[i].label.includes('0.714') || allZones[j].label.includes('0.714')) ? true : false;
          const includesExt = (allZones[i].type === 'extension' || allZones[j].type === 'extension');
          hotZones.push({
            low:o.low, high:o.high,
            includes0714,
            includesExt,
            labels:[allZones[i].label, allZones[j].label],
            dirs:[allZones[i].dir, allZones[j].dir]
          });
        }
      }
    }
    // ---------- FVG detection on 4h and 1h ----------
    function detectFVG(candles) {
      const out = [];
      if (!Array.isArray(candles) || candles.length < 3) return out;
      for (let i = 1; i < candles.length - 1; i++) {
        const prev = candles[i-1], cur = candles[i], next = candles[i+1];
        if (!prev || !cur || !next) continue;
        const prevHigh = toNum(prev.high), prevLow = toNum(prev.low);
        const nextHigh = toNum(next.high), nextLow = toNum(next.low);
        // Bullish FVG: nextLow > prevHigh
        if (Number.isFinite(nextLow) && Number.isFinite(prevHigh) && nextLow > prevHigh) {
          out.push({ type:'bull', low: prevHigh, high: nextLow, center: (prevHigh + nextLow)/2, index:i, mitigated:false });
        }
        // Bearish FVG: nextHigh < prevLow
        if (Number.isFinite(nextHigh) && Number.isFinite(prevLow) && nextHigh < prevLow) {
          out.push({ type:'bear', low: nextHigh, high: prevLow, center: (nextHigh + prevLow)/2, index:i, mitigated:false });
        }
      }
      return out;
    }

    // Mark FVGs as mitigated when price trades back through the gap
    function markFvgMitigated(candles, fvgList) {
      if (!Array.isArray(candles) || !Array.isArray(fvgList) || !fvgList.length) return [];
      const highs = candles.map(c => toNum(c.high));
      const lows  = candles.map(c => toNum(c.low));
      const n = candles.length;
      return fvgList.map(fvg => {
        let mitigated = false;
        // Check from FVG index forward for price filling the gap
        for (let i = Math.max(fvg.index, 0); i < n; i++) {
          const h = highs[i], l = lows[i];
          if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
          // Mitigated when candle range fully covers the gap
          if (l <= fvg.low && h >= fvg.high) {
            mitigated = true;
            break;
          }
        }
        return { ...fvg, mitigated };
      });
    }

    const rawFvg4h = detectFVG(normalized['4h']);
    const rawFvg1h = detectFVG(normalized['1h']);
    const fvg4hAll = markFvgMitigated(normalized['4h'], rawFvg4h);
    const fvg1hAll = markFvgMitigated(normalized['1h'], rawFvg1h);
    // Use only unmitigated FVGs for confluence/zone scoring
    const fvg4h = fvg4hAll.filter(f => !f.mitigated);
    const fvg1h = fvg1hAll.filter(f => !f.mitigated);
    function zoneHasFvgOverlap(z) {
      const has = (arr) => arr.some(g => !(z.high < g.low || z.low > g.high));
      return has(fvg4h) || has(fvg1h);
    }

    // ---------- Order Block detection (institutional entry zones) ----------
    // Order Blocks: Last bullish/bearish candle before strong move (institutional entry zones)
    function detectOrderBlocks(candles, minMoveMultiplier = 1.5) {
      if (!candles || candles.length < 5) return [];
      const out = [];
      const closes = candles.map(c => toNum(c.close));
      const highs = candles.map(c => toNum(c.high));
      const lows = candles.map(c => toNum(c.low));
      const volumes = candles.map(c => toNum(c.volume));
      
      // Calculate ATR for move size validation
      const atrArr = atr(highs, lows, closes, 14);
      const avgVolume = volumes.slice(-20).filter(Number.isFinite).reduce((a,b)=>a+b,0) / 20;
      
      for (let i = 1; i < candles.length - 2; i++) {
        const cur = candles[i];
        const next = candles[i+1];
        if (!cur || !next) continue;
        
        const curHigh = toNum(cur.high), curLow = toNum(cur.low);
        const curClose = toNum(cur.close), curOpen = toNum(cur.open);
        const nextClose = toNum(next.close);
        const curVolume = toNum(cur.volume);
        const atrVal = atrArr[i] ?? (curClose * 0.003);
        
        if (!Number.isFinite(curHigh) || !Number.isFinite(curLow) || 
            !Number.isFinite(curClose) || !Number.isFinite(nextClose)) continue;
        
        // Bullish Order Block: Last bullish candle before strong move up
        const isBullishCandle = curClose > curOpen;
        if (isBullishCandle) {
          // Check if next candles show strong upward move
          let strongMove = false;
          const moveSize = nextClose - curClose;
          if (moveSize > atrVal * minMoveMultiplier) {
            // Verify move continues for at least 1-2 more candles
            for (let j = i + 1; j < Math.min(i + 3, candles.length); j++) {
              const jClose = toNum(candles[j]?.close);
              if (Number.isFinite(jClose) && jClose > curHigh) {
                strongMove = true;
                break;
              }
            }
          }
          
          if (strongMove && curVolume > avgVolume * 0.8) {
            out.push({
              type: 'bull',
              low: curLow,
              high: curHigh,
              center: (curLow + curHigh) / 2,
              index: i,
              mitigated: false // Will check mitigation later
            });
          }
        }
        
        // Bearish Order Block: Last bearish candle before strong move down
        const isBearishCandle = curClose < curOpen;
        if (isBearishCandle) {
          // Check if next candles show strong downward move
          let strongMove = false;
          const moveSize = curClose - nextClose;
          if (moveSize > atrVal * minMoveMultiplier) {
            // Verify move continues for at least 1-2 more candles
            for (let j = i + 1; j < Math.min(i + 3, candles.length); j++) {
              const jClose = toNum(candles[j]?.close);
              if (Number.isFinite(jClose) && jClose < curLow) {
                strongMove = true;
                break;
              }
            }
          }
          
          if (strongMove && curVolume > avgVolume * 0.8) {
            out.push({
              type: 'bear',
              low: curLow,
              high: curHigh,
              center: (curLow + curHigh) / 2,
              index: i,
              mitigated: false // Will check mitigation later
            });
          }
        }
      }
      
      // Check mitigation: Order blocks get mitigated when price sweeps through them
      const lastClose = closes[closes.length - 1];
      for (const ob of out) {
        if (ob.type === 'bull') {
          // Bullish OB mitigated if price closes below its low
          ob.mitigated = lastClose < ob.low;
        } else {
          // Bearish OB mitigated if price closes above its high
          ob.mitigated = lastClose > ob.high;
        }
      }
      
      // Return only unmitigated order blocks (still valid)
      return out.filter(ob => !ob.mitigated).slice(-10); // Keep last 10 unmitigated OBs
    }
    
    const ob4h = detectOrderBlocks(normalized['4h'], 1.5);
    const ob1h = detectOrderBlocks(normalized['1h'], 1.5);
    
    function zoneHasObOverlap(z) {
      const has = (arr) => arr.some(ob => !(z.high < ob.low || z.low > ob.high));
      return has(ob4h) || has(ob1h);
    }
    
    function findNearestOrderBlock(price, direction) {
      // Find nearest unmitigated order block for given direction
      const relevant = [...ob4h, ...ob1h].filter(ob => 
        (direction === 'UP' && ob.type === 'bull') || 
        (direction === 'DOWN' && ob.type === 'bear')
      );
      if (!relevant.length) return null;
      
      // Find closest OB to price
      let nearest = null;
      let minDist = Infinity;
      for (const ob of relevant) {
        const dist = Math.abs(price - ob.center);
        if (dist < minDist) {
          minDist = dist;
          nearest = ob;
        }
      }
      return nearest;
    }

    // Score hot zones with order block and FVG weighting
    function scoreHotZone(z) {
      const a = Number.isFinite(atrRef) ? atrRef : (currentPrice*0.003);
      const width = Math.max(1e-9, z.high - z.low);
      const widthScore = Math.max(0, 1 - (width / (a*1.2))); // narrower zones get higher score
      // Structure proximity: distance to nearest 4h swing high/low price
      const structScore = (() => {
        const highs = (swings4h?.swingHighs || []).map(s => Number(s.price)).filter(Number.isFinite);
        const lows  = (swings4h?.swingLows  || []).map(s => Number(s.price)).filter(Number.isFinite);
        const refList = highs.concat(lows);
        if (!refList.length) return 0;
        const mid = (z.low + z.high)/2;
        const d = Math.min(...refList.map(p => Math.abs(mid - p)));
        const sigma = a * 1.5;
        return Math.exp(-(d*d)/(2*sigma*sigma));
      })();
      // Order blocks are institutional zones - highest priority
      const obScore = zoneHasObOverlap(z) ? 0.30 : 0;
      const fvgScore = zoneHasFvgOverlap(z) ? 0.20 : 0;
      const inc0714 = z.includes0714 ? 0.15 : 0;
      const incExt  = z.includesExt  ? 0.10 : 0;
      // Weighted scoring: OB > Structure > FVG > Width > Fib levels
      return Math.max(0, Math.min(1, 
        0.30*widthScore + 
        0.25*structScore + 
        obScore + 
        fvgScore + 
        inc0714 + 
        incExt
      ));
    }
    const scoredHot = hotZones.map(z => ({ ...z, score: scoreHotZone(z) }))
                              .sort((a,b)=>b.score-a.score)
                              .slice(0, 5);

    // Declare bestHot and bestDir early so they can be used in confidence calculations
    const bestHot = scoredHot[0] || null;
    const bestDir = bos?.dir || (final_signal.includes('BUY') ? 'UP' : (final_signal.includes('SELL') ? 'DOWN' : null));

    // ---------- Entry & TP/SL construction ----------
    // Reference timeframe for entry: prefer 4h structural last close
    const refTf = tfResults['4h']?.last?.close ? '4h'
                : tfResults['1h']?.last?.close ? '1h'
                : tfResults['15m']?.last?.close ? '15m' : '4h';
    const ref = tfResults[refTf];
    const lastClose = currentPrice ?? (ref?.last?.close ?? null);

    // structure-based levels: nearest swing support/resistance
    const lowsPool =
      (Array.isArray(swings4h?.swingLows) && swings4h.swingLows.length) ? swings4h.swingLows :
      (Array.isArray(swings1h?.swingLows) && swings1h.swingLows.length) ? swings1h.swingLows :
      (Array.isArray(swings15?.swingLows) && swings15.swingLows.length) ? swings15.swingLows : [];
    const highsPool =
      (Array.isArray(swings4h?.swingHighs) && swings4h.swingHighs.length) ? swings4h.swingHighs :
      (Array.isArray(swings1h?.swingHighs) && swings1h.swingHighs.length) ? swings1h.swingHighs :
      (Array.isArray(swings15?.swingHighs) && swings15.swingHighs.length) ? swings15.swingHighs : [];
    const structureLow = nearestSwingBelow(lastClose, lowsPool) ?? ((lastClose != null && atrRef != null) ? (lastClose - atrRef * 2) : null);
    const structureHigh = nearestSwingAbove(lastClose, highsPool) ?? ((lastClose != null && atrRef != null) ? (lastClose + atrRef * 2) : null);

    // ---------- Market structure (HH/HL vs LH/LL) ----------
    // Simple 4h market structure classification: 'bullish', 'bearish', or 'range'
    function inferMarketStructure(sw) {
      if (!sw || !Array.isArray(sw.swingHighs) || !Array.isArray(sw.swingLows)) return 'neutral';
      if (sw.swingHighs.length < 2 || sw.swingLows.length < 2) return 'neutral';
      const hLen = sw.swingHighs.length;
      const lLen = sw.swingLows.length;
      const lastHigh = sw.swingHighs[hLen - 1].price;
      const prevHigh = sw.swingHighs[hLen - 2].price;
      const lastLow  = sw.swingLows[lLen - 1].price;
      const prevLow  = sw.swingLows[lLen - 2].price;
      if (![lastHigh, prevHigh, lastLow, prevLow].every(v => Number.isFinite(v))) return 'neutral';
      const higherHigh  = lastHigh > prevHigh;
      const higherLow   = lastLow  > prevLow;
      const lowerHigh   = lastHigh < prevHigh;
      const lowerLow    = lastLow  < prevLow;
      if (higherHigh && higherLow) return 'bullish';
      if (lowerHigh && lowerLow)   return 'bearish';
      return 'range';
    }
    const marketStructure = inferMarketStructure(swings4h);

    // Build entry zones with tight padding (5-10% ATR max) and order block integration
    // Entry zones now include: Fib golden pocket, EMA confluence, Order Blocks, FVG
    function buildConfluenceBands() {
      if (lastClose == null) return null;
      const closesRef = (normalized[refTf] || []).map(c => toNum(c.close));
      const ema21Arr = ema(closesRef, 21);
      const ema50Arr = ema(closesRef, 50);
      const ema21v = ema21Arr[ema21Arr.length - 1];
      const ema50v = ema50Arr[ema50Arr.length - 1];
      const emaBand = (ema21v != null && ema50v != null)
        ? { low: Math.min(ema21v, ema50v), high: Math.max(ema21v, ema50v) }
        : null;
      
      // Prefer golden pocket band from impulse if available
      let fibBand = null;
      if (fib && Number.isFinite(fib.low) && Number.isFinite(fib.high)) {
        const low = fib.low, high = fib.high;
        const gpA = low < high
          ? { lo: low + 0.618 * (high - low), hi: low + 0.65 * (high - low) }
          : { lo: high + 0.618 * (low - high), hi: high + 0.65 * (low - high) };
        const gpLow = Math.min(gpA.lo, gpA.hi);
        const gpHigh = Math.max(gpA.lo, gpA.hi);
        fibBand = { low: gpLow, high: gpHigh };
        // optional 0.714 emphasis: lightly pull the band towards 0.714
        const p0714 = low < high ? (low + 0.714 * (high - low)) : (high + 0.714 * (low - high));
        const mid = (fibBand.low + fibBand.high) / 2;
        const bias = (p0714 - mid) * 0.15;
        fibBand = { low: fibBand.low + bias, high: fibBand.high + bias };
      }
      
      // Find relevant order block for current direction
      const direction = final_signal.includes('BUY') ? 'UP' : (final_signal.includes('SELL') ? 'DOWN' : null);
      const nearestOB = direction ? findNearestOrderBlock(lastClose, direction) : null;
      const obBand = nearestOB ? { low: nearestOB.low, high: nearestOB.high } : null;
      
      // Find unmitigated FVG near entry zone
      const relevantFVGs = [...fvg4h, ...fvg1h].filter(fvg => {
        if (!direction) return false;
        if (direction === 'UP' && fvg.type === 'bull') return true;
        if (direction === 'DOWN' && fvg.type === 'bear') return true;
        return false;
      });
      const nearestFVG = relevantFVGs.length > 0 ? relevantFVGs[relevantFVGs.length - 1] : null;
      const fvgBand = nearestFVG ? { low: nearestFVG.low, high: nearestFVG.high } : null;
      
      function overlap(a, b) {
        if (!a || !b) return null;
        const lo = Math.max(a.low, b.low);
        const hi = Math.min(a.high, b.high);
        return lo <= hi ? { low: lo, high: hi } : null;
      }
      
      // Build confluence: prioritize order blocks and FVG, then Fib, then EMA
      // Order blocks and FVG are institutional zones - highest priority
      let base = null;
      
      // Try to find overlap between multiple factors (confluence)
      if (obBand && fibBand) base = overlap(obBand, fibBand);
      if (!base && obBand && fvgBand) base = overlap(obBand, fvgBand);
      if (!base && fibBand && fvgBand) base = overlap(fibBand, fvgBand);
      if (!base && obBand && emaBand) base = overlap(obBand, emaBand);
      if (!base && fibBand && emaBand) base = overlap(fibBand, emaBand);
      
      // If no confluence, prioritize: OB > FVG > Fib > EMA
      if (!base) {
        if (obBand) base = obBand;
        else if (fvgBand) base = fvgBand;
        else if (fibBand) base = fibBand;
        else if (emaBand) base = emaBand;
        else base = { low: lastClose, high: lastClose };
      }
      
      // If multiple options exist without overlap, pick closest to price
      if (!base || (base.low === base.high && base.low === lastClose)) {
        const candidates = [obBand, fvgBand, fibBand, emaBand].filter(Boolean);
        if (candidates.length > 0) {
          let closest = null;
          let minDist = Infinity;
          for (const cand of candidates) {
            const mid = (cand.low + cand.high) / 2;
            const dist = Math.abs(lastClose - mid);
            if (dist < minDist) {
              minDist = dist;
              closest = cand;
            }
          }
          base = closest || { low: lastClose, high: lastClose };
        } else {
          base = { low: lastClose, high: lastClose };
        }
      }
      
      const a = Number.isFinite(atrRef) ? atrRef : (lastClose * 0.003);
      // TIGHTENED PADDING: 5%, 7%, 10% ATR (was 15%, 25%, 40%)
      const pad1 = a * 0.05;  // Level 1: tight zone
      const pad2 = a * 0.07;  // Level 2: normal zone
      const pad3 = a * 0.10;  // Level 3: wider zone (max)
      
      function expand(band, pad) {
        if (!band || band.low == null || band.high == null) return { low: lastClose, high: lastClose };
        let lo = Math.min(band.low, band.high) - pad;
        let hi = Math.max(band.low, band.high) + pad;
        // Ensure non-zero width: at least 0.05 * ATR (tighter minimum)
        const minW = Math.max(a * 0.05, lastClose * 0.0003);
        if ((hi - lo) < minW) {
          const mid = (lo + hi) / 2;
          lo = mid - minW / 2;
          hi = mid + minW / 2;
        }
        return { low: lo, high: hi };
      }
      
      return {
        level1: expand(base, pad1),
        level2: expand(base, pad2),
        level3: expand(base, pad3),
        base: base, // Store base for optimal entry calculation
        hasOB: !!obBand,
        hasFVG: !!fvgBand,
        hasFib: !!fibBand,
        hasEMA: !!emaBand
      };
    }
    const bands = buildConfluenceBands() || { 
      level1: { low: lastClose, high: lastClose }, 
      level2: { low: lastClose, high: lastClose }, 
      level3: { low: lastClose, high: lastClose },
      base: { low: lastClose, high: lastClose },
      hasOB: false, hasFVG: false, hasFib: false, hasEMA: false
    };
    const lvl1 = bands.level1, lvl2 = bands.level2, lvl3 = bands.level3;
    const baseZone = bands.base || { low: lastClose, high: lastClose };
    
    // Optimal entry price: prefer base zone center (confluence), not padded zone midpoint
    // This ensures entry happens at actual confluence, not at edge of padded zone
    const optimalEntry = (baseZone.low != null && baseZone.high != null) 
      ? (baseZone.low + baseZone.high) / 2 
      : (lvl1.low != null && lvl1.high != null) 
        ? (lvl1.low + lvl1.high) / 2 
        : (lastClose != null ? lastClose : null);
    const entryPrice = optimalEntry;
    
    // ---------- Liquidity sweep validation for entry ----------
    // Entry requires liquidity sweep before price reaches entry zone
    function checkLiquiditySwept(entryPrice, direction, lookbackCandles = 20) {
      if (!entryPrice || !direction) return false;
      
      const candlesToCheck = normalized['4h'] || normalized['1h'] || normalized['15m'] || [];
      if (candlesToCheck.length < 3) return false;
      
      const recent = candlesToCheck.slice(-lookbackCandles);
      const entryIdx = recent.length - 1;
      
      if (direction === 'UP') {
        // For LONG: check if price swept swing low (liquidity below) before reaching entry zone
        const swingLows = swings4h.swingLows.length ? swings4h.swingLows : 
                         (swings1h.swingLows.length ? swings1h.swingLows : swings15.swingLows);
        if (!swingLows.length) return false;
        
        const nearestLow = Math.max(...swingLows.map(s => s.price).filter(p => p < entryPrice));
        if (!Number.isFinite(nearestLow)) return false;
        
        // Check if any recent candle's low swept below nearest swing low
        for (let i = Math.max(0, entryIdx - 10); i < entryIdx; i++) {
          const low = toNum(recent[i]?.low);
          if (Number.isFinite(low) && low < nearestLow * 0.999) {
            return true; // Liquidity swept
          }
        }
      } else if (direction === 'DOWN') {
        // For SHORT: check if price swept swing high (liquidity above) before reaching entry zone
        const swingHighs = swings4h.swingHighs.length ? swings4h.swingHighs : 
                          (swings1h.swingHighs.length ? swings1h.swingHighs : swings15.swingHighs);
        if (!swingHighs.length) return false;
        
        const nearestHigh = Math.min(...swingHighs.map(s => s.price).filter(p => p > entryPrice));
        if (!Number.isFinite(nearestHigh)) return false;
        
        // Check if any recent candle's high swept above nearest swing high
        for (let i = Math.max(0, entryIdx - 10); i < entryIdx; i++) {
          const high = toNum(recent[i]?.high);
          if (Number.isFinite(high) && high > nearestHigh * 1.001) {
            return true; // Liquidity swept
          }
        }
      }
      
      return false;
    }
    
    const direction = final_signal.includes('BUY') ? 'UP' : (final_signal.includes('SELL') ? 'DOWN' : null);
    const liquiditySweptForEntry = checkLiquiditySwept(entryPrice, direction);
    
    // Calculate liquidity pools early (needed for confidence calculations)
    const { liquidityPool, recentWick } = findLiquidityPoolsAndWicks(entryPrice, direction);
    const relevantOB = findRelevantOrderBlocks(entryPrice, direction);

    // ---------- SL/TP via ATR and Fib with liquidity pool protection ----------
    const slMultipliers = { level1: 1.5, level2: 2.0, level3: 2.5 }; // Increased minimums (was 1.0, 1.6, 2.6)
    const suggestions = {};
    const levels = ['level1', 'level2', 'level3'];

    // Find liquidity pools (swing points where stops cluster) and recent wicks
    function findLiquidityPoolsAndWicks(entry, direction, lookbackCandles = 30) {
      const candles = normalized['4h'] || normalized['1h'] || [];
      if (candles.length < 5) return { liquidityPool: null, recentWick: null };
      
      let liquidityPool = null;
      let recentWick = null;
      const recent = candles.slice(-lookbackCandles);
      
      if (direction === 'UP') {
        // For LONG: liquidity pools are swing lows (where long stops cluster)
        const swingLows = swings4h.swingLows.length ? swings4h.swingLows : 
                         (swings1h.swingLows.length ? swings1h.swingLows : swings15.swingLows);
        if (swingLows.length) {
          // Find nearest swing low below entry
          const below = swingLows.filter(s => s.price < entry).map(s => s.price);
          if (below.length) {
            liquidityPool = Math.max(...below);
          }
        }
        
        // Find lowest recent wick (will get swept)
        let lowestWick = Infinity;
        for (let i = Math.max(0, recent.length - 10); i < recent.length; i++) {
          const low = toNum(recent[i]?.low);
          if (Number.isFinite(low) && low < entry && low < lowestWick) {
            lowestWick = low;
          }
        }
        if (Number.isFinite(lowestWick) && lowestWick < Infinity) {
          recentWick = lowestWick;
        }
      } else if (direction === 'DOWN') {
        // For SHORT: liquidity pools are swing highs (where short stops cluster)
        const swingHighs = swings4h.swingHighs.length ? swings4h.swingHighs : 
                          (swings1h.swingHighs.length ? swings1h.swingHighs : swings15.swingHighs);
        if (swingHighs.length) {
          // Find nearest swing high above entry
          const above = swingHighs.filter(s => s.price > entry).map(s => s.price);
          if (above.length) {
            liquidityPool = Math.min(...above);
          }
        }
        
        // Find highest recent wick (will get swept)
        let highestWick = -Infinity;
        for (let i = Math.max(0, recent.length - 10); i < recent.length; i++) {
          const high = toNum(recent[i]?.high);
          if (Number.isFinite(high) && high > entry && high > highestWick) {
            highestWick = high;
          }
        }
        if (Number.isFinite(highestWick) && highestWick > -Infinity) {
          recentWick = highestWick;
        }
      }
      
      return { liquidityPool, recentWick };
    }
    
    // Find order blocks that might affect SL placement
    function findRelevantOrderBlocks(entry, direction) {
      if (!direction) return null;
      
      const relevant = [...ob4h, ...ob1h].filter(ob => {
        if (direction === 'UP') {
          // For LONG: find bearish OB below entry (support level)
          return ob.type === 'bear' && ob.high < entry;
        } else {
          // For SHORT: find bullish OB above entry (resistance level)
          return ob.type === 'bull' && ob.low > entry;
        }
      });
      
      if (!relevant.length) return null;
      
      // Find closest OB to entry
      let closest = null;
      let minDist = Infinity;
      for (const ob of relevant) {
        const dist = direction === 'UP' 
          ? Math.abs(entry - ob.high) 
          : Math.abs(ob.low - entry);
        if (dist < minDist) {
          minDist = dist;
          closest = ob;
        }
      }
      return closest;
    }

    // Comprehensive TP target calculation: swing structure, liquidity zones, order blocks, Fib extensions
    function computeTakeProfitTargets(entry, trendDir, atrVal) {
      if (!entry || !trendDir || !atrVal) {
        return { tp1: null, tp2: null, tp1_source: null, tp2_source: null };
      }
      
      let tp1 = null, tp2 = null;
      let tp1_source = null, tp2_source = null;
      
      if (trendDir === 'UP') {
        // For LONG trades: TP targets are swing highs and liquidity zones above entry
        
        // TP1: Previous swing high (primary target - most reliable)
        const swingHighs = swings4h.swingHighs.length ? swings4h.swingHighs : 
                          (swings1h.swingHighs.length ? swings1h.swingHighs : swings15.swingHighs);
        if (swingHighs.length) {
          const above = swingHighs.filter(s => s.price > entry).map(s => s.price);
          if (above.length) {
            tp1 = Math.min(...above); // Nearest swing high above entry
            tp1_source = 'swing_high';
          }
        }
        
        // TP1 alternative: Order block in opposite direction (bearish OB = resistance)
        const bearishOBs = [...ob4h, ...ob1h].filter(ob => ob.type === 'bear' && ob.low > entry);
        if (bearishOBs.length && !tp1) {
          const nearestOB = bearishOBs.reduce((closest, ob) => 
            (!closest || ob.low < closest.low) ? ob : closest
          );
          tp1 = nearestOB.low; // Enter bearish OB zone
          tp1_source = 'order_block_bear';
        }
        
        // TP1 fallback: Fib extension 1.272 or 1.382
        if (!tp1 && fib) {
          tp1 = fib.ext1272 || fib.ext1382;
          tp1_source = 'fib_extension';
        }
        
        // TP1 final fallback: ATR-based
        if (!tp1) {
          tp1 = entry + atrVal * 1.5;
          tp1_source = 'atr_based';
        }
        
        // TP2: Next swing high or major liquidity zone (secondary target)
        // Must be beyond TP1
        const above = swingHighs.length ? swingHighs.filter(s => s.price > entry).map(s => s.price) : [];
        if (above.length > 1) {
          // Sort and get second nearest swing high (must be > TP1)
          const sorted = [...above].sort((a, b) => a - b);
          const secondHigh = sorted[1];
          if (secondHigh > tp1) {
            tp2 = secondHigh;
            tp2_source = 'swing_high_secondary';
          }
        }
        
        // TP2 alternative: Fib extension 1.618 (if no second swing high or if second high <= TP1)
        if (!tp2 && fib && fib.ext1618 && fib.ext1618 > tp1) {
          tp2 = fib.ext1618;
          tp2_source = 'fib_extension_1618';
        }
        
        // TP2 fallback: ATR-based (reduced aggressiveness, must be > TP1)
        if (!tp2) {
          const atrBasedTP2 = entry + atrVal * 2.0; // Reduced from 2.6x ATR
          tp2 = Math.max(atrBasedTP2, tp1 + atrVal * 0.5); // Ensure TP2 > TP1
          tp2_source = 'atr_based';
        }
        
      } else if (trendDir === 'DOWN') {
        // For SHORT trades: TP targets are swing lows and liquidity zones below entry
        
        // TP1: Previous swing low (primary target - most reliable)
        const swingLows = swings4h.swingLows.length ? swings4h.swingLows : 
                         (swings1h.swingLows.length ? swings1h.swingLows : swings15.swingLows);
        if (swingLows.length) {
          const below = swingLows.filter(s => s.price < entry).map(s => s.price);
          if (below.length) {
            tp1 = Math.max(...below); // Nearest swing low below entry
            tp1_source = 'swing_low';
          }
        }
        
        // TP1 alternative: Order block in opposite direction (bullish OB = support)
        const bullishOBs = [...ob4h, ...ob1h].filter(ob => ob.type === 'bull' && ob.high < entry);
        if (bullishOBs.length && !tp1) {
          const nearestOB = bullishOBs.reduce((closest, ob) => 
            (!closest || ob.high > closest.high) ? ob : closest
          );
          tp1 = nearestOB.high; // Enter bullish OB zone
          tp1_source = 'order_block_bull';
        }
        
        // TP1 fallback: Fib extension 1.272 or 1.382
        if (!tp1 && fib) {
          tp1 = fib.ext1272 || fib.ext1382;
          tp1_source = 'fib_extension';
        }
        
        // TP1 final fallback: ATR-based
        if (!tp1) {
          tp1 = entry - atrVal * 1.5;
          tp1_source = 'atr_based';
        }
        
        // TP2: Next swing low or major liquidity zone (secondary target)
        // Must be below TP1
        const below = swingLows.length ? swingLows.filter(s => s.price < entry).map(s => s.price) : [];
        if (below.length > 1) {
          // Sort and get second nearest swing low (must be < TP1)
          const sorted = [...below].sort((a, b) => b - a);
          const secondLow = sorted[1];
          if (secondLow < tp1) {
            tp2 = secondLow;
            tp2_source = 'swing_low_secondary';
          }
        }
        
        // TP2 alternative: Fib extension 1.618 (if no second swing low or if second low >= TP1)
        if (!tp2 && fib && fib.ext1618 && fib.ext1618 < tp1) {
          tp2 = fib.ext1618;
          tp2_source = 'fib_extension_1618';
        }
        
        // TP2 fallback: ATR-based (reduced aggressiveness, must be < TP1)
        if (!tp2) {
          const atrBasedTP2 = entry - atrVal * 2.0; // Reduced from 2.6x ATR
          tp2 = Math.min(atrBasedTP2, tp1 - atrVal * 0.5); // Ensure TP2 < TP1
          tp2_source = 'atr_based';
        }
      }
      
      return { tp1, tp2, tp1_source, tp2_source };
    }

    // liquidityPool, recentWick, and relevantOB already declared earlier (after direction)

    for (const lvl of levels) {
      const m = slMultipliers[lvl];
      let sl = null, tp1 = null, tp2 = null;
      let tp1_source = null, tp2_source = null;
      const entry = entryPrice;

      if (entry == null || atrRef == null) {
        sl = entry ? entry - (entry * 0.02) : null;
        tp1 = entry ? entry + (entry * 0.03) : null;
        tp2 = entry ? entry + (entry * 0.06) : null;
      } else {
        if (final_signal.includes('BUY')) {
          // Calculate multiple SL candidates and use the WIDER (farther) one
          const atrBasedSL = entry - atrRef * m;
          
          // Structural SL: below swing low with buffer
          const structuralSL = (impulse && impulse.low != null) 
            ? impulse.low - (atrRef * 0.1) // 10% ATR buffer below swing low
            : null;
          
          // Liquidity pool SL: below liquidity pool with buffer
          const liquiditySL = liquidityPool 
            ? liquidityPool - (atrRef * 0.15) // 15% ATR buffer below liquidity pool
            : null;
          
          // Recent wick SL: below recent wick with buffer
          const wickSL = recentWick 
            ? recentWick - (atrRef * 0.1) // 10% ATR buffer below wick
            : null;
          
          // Order block SL: below order block low
          const obSL = relevantOB 
            ? relevantOB.low - (atrRef * 0.05) // 5% ATR buffer below OB
            : null;
          
          // Collect all valid SL candidates
          const candidates = [atrBasedSL, structuralSL, liquiditySL, wickSL, obSL]
            .filter(sl => Number.isFinite(sl) && sl < entry);
          
          // Use the LOWEST (widest/farthest) SL to avoid liquidity sweeps
          // This ensures SL is beyond all potential liquidity grab zones
          sl = candidates.length > 0 
            ? Math.min(...candidates) 
            : atrBasedSL;
          
          // Ensure minimum 1.5x ATR distance (critical for swing trading)
          const minSL = entry - (atrRef * 1.5);
          if (sl > minSL) {
            sl = minSL; // Use minimum if calculated SL is too tight
          }
          
          const tpTargets = computeTakeProfitTargets(entry, 'UP', atrRef);
          tp1 = tpTargets.tp1 ?? (entry + atrRef * (m * 1.2));
          tp2 = tpTargets.tp2 ?? (entry + atrRef * (m * 2.0)); // Reduced from 2.6x
          tp1_source = tpTargets.tp1_source;
          tp2_source = tpTargets.tp2_source;
        } else if (final_signal.includes('SELL')) {
          // Calculate multiple SL candidates and use the WIDER (farther) one
          const atrBasedSL = entry + atrRef * m;
          
          // Structural SL: above swing high with buffer
          const structuralSL = (impulse && impulse.high != null) 
            ? impulse.high + (atrRef * 0.1) // 10% ATR buffer above swing high
            : null;
          
          // Liquidity pool SL: above liquidity pool with buffer
          const liquiditySL = liquidityPool 
            ? liquidityPool + (atrRef * 0.15) // 15% ATR buffer above liquidity pool
            : null;
          
          // Recent wick SL: above recent wick with buffer
          const wickSL = recentWick 
            ? recentWick + (atrRef * 0.1) // 10% ATR buffer above wick
            : null;
          
          // Order block SL: above order block high
          const obSL = relevantOB 
            ? relevantOB.high + (atrRef * 0.05) // 5% ATR buffer above OB
            : null;
          
          // Collect all valid SL candidates
          const candidates = [atrBasedSL, structuralSL, liquiditySL, wickSL, obSL]
            .filter(sl => Number.isFinite(sl) && sl > entry);
          
          // Use the HIGHEST (widest/farthest) SL to avoid liquidity sweeps
          // This ensures SL is beyond all potential liquidity grab zones
          sl = candidates.length > 0 
            ? Math.max(...candidates) 
            : atrBasedSL;
          
          // Ensure minimum 1.5x ATR distance (critical for swing trading)
          const minSL = entry + (atrRef * 1.5);
          if (sl < minSL) {
            sl = minSL; // Use minimum if calculated SL is too tight
          }
          
          const tpTargets = computeTakeProfitTargets(entry, 'DOWN', atrRef);
          tp1 = tpTargets.tp1 ?? (entry - atrRef * (m * 1.2));
          tp2 = tpTargets.tp2 ?? (entry - atrRef * (m * 2.0)); // Reduced from 2.6x
          tp1_source = tpTargets.tp1_source;
          tp2_source = tpTargets.tp2_source;
        } else {
          sl = entry - atrRef * m;
          tp1 = entry + atrRef * (m * 0.9);
          tp2 = entry + atrRef * (m * 1.8);
        }
      }
      // Regime-based TP refinement (swing) - Conservative adjustments
      // DO NOT tighten SL in chop (dangerous!) - only adjust TP
      if (flags.tp_sl_refine && regimeContext && regimeContext.score != null && atrRef != null && entry != null) {
        if (regimeContext.regime === 'trend') {
          // In trending markets, extend TP2 slightly (but not too aggressive)
          tp2 = Number.isFinite(tp2) ? (tp2 + atrRef * 0.15 * (final_signal.includes('BUY') ? 1 : -1)) : tp2;
          // Reduced from 0.25 to 0.15 ATR - less aggressive
        } else if (regimeContext.regime === 'chop') {
          // In choppy markets, reduce TP2 to realistic levels
          tp2 = Number.isFinite(tp2) ? (tp2 - atrRef * 0.15 * (final_signal.includes('BUY') ? 1 : -1)) : tp2;
          // Reduced from 0.2 to 0.15 ATR - more conservative
          // REMOVED: Tightening SL in chop is dangerous - can cause premature stops
          // Keep SL wide to avoid liquidity sweeps even in chop
        }
      }

      // Safety clamps: ensure SL is not too far (but respect liquidity protection)
      // For swing trading, allow wider SL (up to 10%) to protect against sweeps
      function clampSL(val, base, maxPct) {
        if (!Number.isFinite(val) || !Number.isFinite(base)) return val;
        const cap = Math.abs(base) * maxPct;
        // For LONG: val should be < base, so cap the distance
        if (base > val && Math.abs(base - val) > cap) {
          return base - cap;
        }
        // For SHORT: val should be > base, so cap the distance
        if (base < val && Math.abs(val - base) > cap) {
          return base + cap;
        }
        return val;
      }
      
      function clampTP(val, base, maxPct) {
        if (!Number.isFinite(val) || !Number.isFinite(base)) return val;
        const cap = Math.abs(base) * maxPct;
        if (Math.abs(val - base) > cap) return base + Math.sign(val - base) * cap;
        return val;
      }
      
      if (entry != null) {
        // Allow wider SL (10% max) for swing trading to protect against liquidity sweeps
        sl = clampSL(sl, entry, 0.10); // Increased from 8% to 10%
        tp1 = clampTP(tp1, entry, 0.12);
        tp2 = clampTP(tp2, entry, 0.2);
      }

      // Quantize to inferred tick size
      function inferTickSize(tfName) {
        const arr = normalized[tfName] || [];
        const vals = [];
        const push = (v) => { const n = Number(v); if (Number.isFinite(n)) vals.push(n); };
        for (let i = Math.max(0, arr.length - 200); i < arr.length; i++) {
          const c = arr[i];
          push(c.close); push(c.open); push(c.high); push(c.low);
        }
        if (vals.length < 2) return 0.01;
        vals.sort((a,b)=>a-b);
        let minStep = Infinity;
        for (let i = 1; i < vals.length; i++) {
          const d = Math.abs(vals[i] - vals[i-1]);
          if (d > 0) minStep = Math.min(minStep, d);
        }
        if (!Number.isFinite(minStep) || minStep === 0) return 0.01;
        // normalize to a clean decimal step
        const exp = Math.ceil(-Math.log10(minStep));
        const tick = Math.pow(10, -Math.max(0, Math.min(8, exp)));
        // snap to common BTCUSDT steps where applicable
        if (tick < 0.01) return 0.01;
        if (tick > 1) return 0.1;
        return tick;
      }
      // Prefer provided tickSize (tickSize or priceTickSize) if valid
      const providedTick = (() => {
        const v = Number(tickSize ?? priceTickSize);
        return (Number.isFinite(v) && v > 0) ? v : null;
      })();
      const tick = providedTick ?? inferTickSize(refTf);
      const side = final_signal.includes('BUY') ? 'LONG' : (final_signal.includes('SELL') ? 'SHORT' : 'FLAT');
      const floorToTick = (p) => (p == null ? p : Math.floor(p / tick) * tick);
      const ceilToTick  = (p) => (p == null ? p : Math.ceil(p / tick) * tick);
      const roundToTick = (p) => (p == null ? p : Math.round(p / tick) * tick);

      const qEntry = roundToTick(entry);
      let qSL = sl;
      let qTP1 = tp1;
      let qTP2 = tp2;
      if (side === 'LONG') {
        qSL  = floorToTick(sl);
        qTP1 = floorToTick(tp1);
        qTP2 = floorToTick(tp2);
      } else if (side === 'SHORT') {
        qSL  = ceilToTick(sl);
        qTP1 = ceilToTick(tp1);
        qTP2 = ceilToTick(tp2);
      } else {
        qSL  = roundToTick(sl);
        qTP1 = roundToTick(tp1);
        qTP2 = roundToTick(tp2);
      }

      const qBandLow  = floorToTick(lvl === 'level1' ? lvl1.low : (lvl === 'level2' ? lvl2.low : lvl3.low));
      const qBandHigh = ceilToTick (lvl === 'level1' ? lvl1.high: (lvl === 'level2' ? lvl2.high: lvl3.high));

      // Calculate SL placement metadata for transparency
      const slDistance = entry != null && qSL != null ? Math.abs(entry - qSL) : null;
      const slDistanceATR = (slDistance != null && atrRef != null) ? slDistance / atrRef : null;
      const slProtectionFactors = [];
      if (liquidityPool != null) {
        const distToPool = direction === 'UP' 
          ? Math.abs(liquidityPool - qSL) 
          : Math.abs(qSL - liquidityPool);
        if (distToPool < atrRef * 0.2) {
          slProtectionFactors.push('liquidity_pool');
        }
      }
      if (recentWick != null) {
        const distToWick = direction === 'UP'
          ? Math.abs(recentWick - qSL)
          : Math.abs(qSL - recentWick);
        if (distToWick < atrRef * 0.15) {
          slProtectionFactors.push('recent_wick');
        }
      }
      if (relevantOB != null) {
        const distToOB = direction === 'UP'
          ? Math.abs(relevantOB.low - qSL)
          : Math.abs(qSL - relevantOB.high);
        if (distToOB < atrRef * 0.1) {
          slProtectionFactors.push('order_block');
        }
      }
      if (impulse && ((direction === 'UP' && impulse.low != null) || (direction === 'DOWN' && impulse.high != null))) {
        const distToStructure = direction === 'UP'
          ? Math.abs(impulse.low - qSL)
          : Math.abs(qSL - impulse.high);
        if (distToStructure < atrRef * 0.15) {
          slProtectionFactors.push('swing_structure');
        }
      }
      
      // Calculate TP distances and partial profit taking strategy
      const tp1Distance = entry != null && qTP1 != null ? Math.abs(qTP1 - entry) : null;
      const tp2Distance = entry != null && qTP2 != null ? Math.abs(qTP2 - entry) : null;
      const tp1DistanceATR = (tp1Distance != null && atrRef != null) ? tp1Distance / atrRef : null;
      const tp2DistanceATR = (tp2Distance != null && atrRef != null) ? tp2Distance / atrRef : null;
      
      // Partial profit taking strategy: 50% at TP1, 50% at TP2
      // After TP1 hit, move SL to breakeven and let remaining 50% run to TP2
      const profitTakingStrategy = {
        tp1_close_percent: 50, // Close 50% at TP1
        tp2_close_percent: 50, // Close remaining 50% at TP2
        breakeven_after_tp1: true, // Move SL to breakeven after TP1 hit
        trail_stop_after_tp1: true // Trail stop using 4H swing structure after TP1
      };

      suggestions[lvl] = {
        entry: qEntry,
        entry_range: { low: qBandLow, high: qBandHigh },
        stop_loss: qSL,
        take_profit_1: qTP1,
        take_profit_2: qTP2,
        tp1_source: tp1_source,
        tp2_source: tp2_source,
        tp1_distance_atr: tp1DistanceATR != null ? Number(tp1DistanceATR.toFixed(2)) : null,
        tp2_distance_atr: tp2DistanceATR != null ? Number(tp2DistanceATR.toFixed(2)) : null,
        profit_taking_strategy: profitTakingStrategy,
        atr_used: atrRef,
        sl_multiplier: m,
        sl_distance_atr: slDistanceATR != null ? Number(slDistanceATR.toFixed(2)) : null,
        sl_protection_factors: slProtectionFactors,
        liquidity_pool: liquidityPool,
        recent_wick: recentWick,
        min_sl_distance_atr: 1.5 // Minimum required distance
      };
    }

    // ---------- Confidence scoring (continuous 0..1) ----------
    function clamp01(x) { return Math.max(0, Math.min(1, x)); }
    // Signal confidence from vote dominance, reference TF score, and market structure alignment
    const totalW = Object.keys(tfResults).reduce((s, tf) => s + (tfWeight[tf] || 0), 0);
    const voteDominance = totalW ? Math.abs((buyWeight ?? 0) - (sellWeight ?? 0)) / totalW : 0;
    const refScore = Math.abs(ref?.score ?? 0);
    const scoreNorm = clamp01(refScore / 60);
    // Market structure alignment: bias vs 4h structure and BOS direction
    const msAlignment = (() => {
      // Map bias to directional expectation (using final_signal since bias is defined later)
      const wantUp   = final_signal.includes('BUY');
      const wantDown = final_signal.includes('SELL');
      let score = 0.5; // neutral baseline
      if (marketStructure === 'bullish') {
        if (wantUp) score = 1.0;
        else if (wantDown) score = 0.1;
      } else if (marketStructure === 'bearish') {
        if (wantDown) score = 1.0;
        else if (wantUp) score = 0.1;
      } else if (marketStructure === 'range') {
        score = 0.4;
      }
      // BOS direction agreement boosts confidence
      if (bos && bos.dir) {
        if ((bos.dir === 'UP' && wantUp) || (bos.dir === 'DOWN' && wantDown)) {
          score = Math.min(1.0, score + 0.15);
        } else {
          score = Math.max(0.0, score - 0.25);
        }
      }
      return clamp01(score);
    })();
    const signal_confidence = clamp01(0.5 * voteDominance + 0.3 * scoreNorm + 0.2 * msAlignment);

    // Entry confidence from band proximity, structure alignment, supertrend, order blocks, and FVGs
    function gaussian(x, s) { if (!Number.isFinite(x) || !Number.isFinite(s) || s <= 0) return 0; return Math.exp(-(x*x)/(2*s*s)); }
    const bandMid = (lvl1.low != null && lvl1.high != null) ? (lvl1.low + lvl1.high) / 2 : lastClose;
    const distToBand = (lastClose != null && bandMid != null) ? Math.abs(lastClose - bandMid) : null;
    const bandProx = distToBand == null ? 0 : gaussian(distToBand, (atrRef ?? (lastClose*0.003)) * 0.6);
    const structProx = (() => {
      if (bandMid == null) return 0;
      const candidates = [];
      if (Number.isFinite(structureLow)) candidates.push(Math.abs(bandMid - structureLow));
      if (Number.isFinite(structureHigh)) candidates.push(Math.abs(bandMid - structureHigh));
      if (!candidates.length) return 0;
      const d = Math.min(...candidates);
      const s = (atrRef ?? (lastClose*0.003)) * 1.2;
      return gaussian(d, s);
    })();
    const stAlign = (() => {
      const stv = ref?.indicators?.supertrend ?? null;
      if (stv == null || lastClose == null) return 0.4;
      if (final_signal.includes('BUY'))  return lastClose > stv ? 1.0 : 0.2;
      if (final_signal.includes('SELL')) return lastClose < stv ? 1.0 : 0.2;
      return 0.5;
    })();
    let entry_confidence = clamp01(0.45 * bandProx + 0.25 * structProx + 0.20 * stAlign);
    // Balanced tweak: MACD acts as a small positive boost, not a hard gate
    const macdBoostAligned = (() => {
      const tf15 = tfResults['15m'];
      if (!tf15) return false;
      const macd = tf15.indicators?.macd, macdSig = tf15.indicators?.macd_signal;
      if (!Number.isFinite(macd) || !Number.isFinite(macdSig)) return false;
      if (final_signal.includes('BUY')) return macd > macdSig;
      if (final_signal.includes('SELL')) return macd < macdSig;
      return false;
    })();
    if (macdBoostAligned) entry_confidence = clamp01(entry_confidence + 0.05);

    // Pullback volume context: prefer lower volume on pullbacks vs prior impulse
    function pullbackVolumeScore(direction) {
      try {
        const arr = normalized[refTf] || [];
        if (arr.length < 20) return 0;
        const n = arr.length;
        // Last 4 candles vs previous 10 candles
        const recent = arr.slice(n - 4, n);
        const prior  = arr.slice(n - 14, n - 4);
        const volRecent = recent.map(c => toNum(c.volume)).filter(Number.isFinite);
        const volPrior  = prior.map(c => toNum(c.volume)).filter(Number.isFinite);
        if (!volRecent.length || !volPrior.length) return 0;
        const avgRecent = volRecent.reduce((a,b)=>a+b,0) / volRecent.length;
        const avgPrior  = volPrior.reduce((a,b)=>a+b,0) / volPrior.length;
        if (!Number.isFinite(avgRecent) || !Number.isFinite(avgPrior) || avgPrior <= 0) return 0;
        const ratio = avgRecent / avgPrior;
        // For longs: want lower volume on pullback
        if (direction === 'UP' && ratio < 0.9) return 0.05;
        // For shorts: want lower volume on pullback
        if (direction === 'DOWN' && ratio < 0.9) return 0.05;
        return 0;
      } catch {
        return 0;
      }
    }
    if (bestDir) {
      entry_confidence = clamp01(entry_confidence + pullbackVolumeScore(bestDir));
    }

    // Order block & FVG confluence bonus (institutional context)
    const obFvgBonus = (() => {
      let bonus = 0;
      // Use bestHot directly since primaryZone is declared later
      if (bands.hasOB && bestHot && zoneHasObOverlap(bestHot)) bonus += 0.08;
      if (bands.hasFVG && bestHot && zoneHasFvgOverlap(bestHot)) bonus += 0.05;
      // Liquidity pool proximity: band mid near liquidity pool
      if (Number.isFinite(liquidityPool) && bandMid != null && atrRef != null) {
        const d = Math.abs(bandMid - liquidityPool);
        const s = atrRef * 1.0;
        bonus += gaussian(d, s) * 0.05;
      }
      return bonus;
    })();
    entry_confidence = clamp01(entry_confidence + obFvgBonus);

    // Zone quality bonus (4h/1h sweeps and wicks near best hot zone)
    if (flags.zone_quality && bestHot) {
      let bonus = 0;
      const mid = (bestHot.low + bestHot.high) / 2;
      const a = Number.isFinite(atrRef) ? atrRef : ((currentPrice ?? 0) * 0.003);
      const eps = a * 0.2;
      function addBonusFrom(arr) {
        let eq=0, wick=0;
        for (let k = Math.max(0, arr.length - 40); k < arr.length; k++) {
          const c = arr[k];
          const h = toNum(c?.high), l = toNum(c?.low), o = toNum(c?.open), cl = toNum(c?.close);
          if (!Number.isFinite(h)||!Number.isFinite(l)||!Number.isFinite(o)||!Number.isFinite(cl)) continue;
          const nearHigh = Math.abs(h - mid) <= eps || Math.abs(h - bestHot.high) <= eps;
          const nearLow  = Math.abs(l - mid) <= eps || Math.abs(l - bestHot.low)  <= eps;
          if (nearHigh || nearLow) eq++;
          const body = Math.abs(cl - o);
          const upperW = h - Math.max(cl, o);
          const lowerW = Math.min(cl, o) - l;
          if ((nearHigh && upperW > body * 1.2) || (nearLow && lowerW > body * 1.2)) wick++;
        }
        return {eq, wick};
      }
      const s4 = addBonusFrom(normalized['4h'] || []);
      const s1 = addBonusFrom(normalized['1h'] || []);
      if ((s4.eq + s1.eq) >= 2) bonus += 0.02;
      if ((s4.wick + s1.wick) >= 2) bonus += 0.02;
      entry_confidence = clamp01(entry_confidence + Math.min(0.05, bonus));
    }

    // Volume confirmation near entry zone (relative to recent history)
    const volEntryFactor = (() => {
      const v = ref?.indicators?.volume;
      const vSma = ref?.indicators?.vol_sma20;
      if (!Number.isFinite(v) || !Number.isFinite(vSma) || vSma <= 0) return 0;
      const r = v / vSma;
      const isStrong = final_signal === 'STRONG BUY' || final_signal === 'STRONG SELL';
      // Strong trend / breakout: want clearly elevated volume
      if (isStrong) {
        if (r >= 1.5) return 0.05;
        if (r <= 0.7) return -0.05;
      } else {
        if (r >= 1.3) return 0.03;
        if (r <= 0.7) return -0.03;
      }
      return 0;
    })();
    entry_confidence = clamp01(entry_confidence + volEntryFactor);

    // Institutional candle patterns (engulfing / pin bars) near zone on ref TF
    function institutionalCandleScore(direction) {
      try {
        const arr = normalized[refTf] || [];
        if (arr.length < 3) return 0;
        const i = arr.length - 1;
        const cur = arr[i], prev = arr[i-1];
        const cOpen = toNum(cur.open), cClose = toNum(cur.close), cHigh = toNum(cur.high), cLow = toNum(cur.low);
        const pOpen = toNum(prev.open), pClose = toNum(prev.close);
        if (![cOpen,cClose,cHigh,cLow,pOpen,pClose].every(Number.isFinite)) return 0;
        const body = Math.abs(cClose - cOpen);
        const range = Math.abs(cHigh - cLow);
        if (!Number.isFinite(range) || range === 0) return 0;
        const upperWick = cHigh - Math.max(cOpen, cClose);
        const lowerWick = Math.min(cOpen, cClose) - cLow;
        let score = 0;
        // Bullish engulfing / hammer near support
        if (direction === 'UP') {
          const bullishEngulf = (cClose > cOpen) && (pClose < pOpen) && (cClose >= pOpen) && (cOpen <= pClose);
          const hammer = (cClose > cOpen) && (lowerWick > body * 2) && (upperWick < body * 0.5);
          if (bullishEngulf || hammer) score = 0.07;
        }
        // Bearish engulfing / shooting star near resistance
        if (direction === 'DOWN') {
          const bearishEngulf = (cClose < cOpen) && (pClose > pOpen) && (cClose <= pOpen) && (cOpen >= pClose);
          const shootingStar = (cClose < cOpen) && (upperWick > body * 2) && (lowerWick < body * 0.5);
          if (bearishEngulf || shootingStar) score = 0.07;
        }
        return score;
      } catch {
        return 0;
      }
    }
    if (bestDir) {
      entry_confidence = clamp01(entry_confidence + institutionalCandleScore(bestDir));
    }

    // ---------- LTF confirmation near best hot zone ----------
    function ltfConfirm(dir) {
      const tf = tfResults['15m'];
      if (!tf) return false;
      const ema9 = tf.indicators?.ema9, ema21 = tf.indicators?.ema21;
      if (!Number.isFinite(ema9) || !Number.isFinite(ema21)) return false;
      if (dir === 'UP') return (ema9 > ema21);
      if (dir === 'DOWN') return (ema9 < ema21);
      return false;
    }
    function ltfConfirm1hStable(dir) {
      try {
        const arr = normalized['1h'] || [];
        if (arr.length < 5) return false;
        const closes = arr.map(c => toNum(c.close));
        const ema9A = ema(closes, 9);
        const ema21A = ema(closes, 21);
        const macdObj = macd(closes);
        const i = closes.length - 1;
        const lagIdx = i - 1;
        if (lagIdx < 0) return false;
        const m = macdObj.macdLine[lagIdx];
        const s = macdObj.signalLine[lagIdx];
        const macdAligned = (Number.isFinite(m) && Number.isFinite(s)) ? ((dir === 'UP') ? (m > s) : (m < s)) : false;
        const required = macdAligned ? 1 : 2;
        const start = lagIdx - required + 1;
        if (start < 0) return false;
        for (let k=start; k<=lagIdx; k++) {
          const e9 = ema9A[k], e21 = ema21A[k];
          if (!Number.isFinite(e9) || !Number.isFinite(e21)) return false;
          if (dir === 'UP' && !(e9 > e21)) return false;
          if (dir === 'DOWN' && !(e9 < e21)) return false;
        }
        return true;
      } catch { return false; }
    }
    const zoneReady = bestDir ? (flags.ltf_stability ? ltfConfirm1hStable(bestDir) : ltfConfirm(bestDir)) : false;
    const sizeFactor = clamp01(
      (bestHot?.score ?? 0) * 0.6 +
      (entry_confidence) * 0.25 +
      (zoneReady ? 0.15 : 0)
    );
    const sizeTier = sizeFactor >= 0.7 ? 'large' : (sizeFactor >= 0.4 ? 'normal' : 'small');

    // -------- Phase 2: Adaptive proximity (4h ATR percentile buckets) --------
    const arr4h = normalized['4h'] || [];
    const closes4h = arr4h.map(c=>toNum(c.close));
    const highs4h  = arr4h.map(c=>toNum(c.high));
    const lows4h   = arr4h.map(c=>toNum(c.low));
    const atr4hArr = atr(highs4h, lows4h, closes4h, 14);
    let hvpPercentile4h = null;
    if (flags.adaptive_proximity && atr4hArr.filter(Number.isFinite).length >= 40) {
      const sample = atr4hArr.slice(-120).filter(Number.isFinite);
      if (sample.length >= 20) {
        const lastAtr = sample[sample.length - 1];
        const sorted = [...sample].sort((a,b)=>a-b);
        const idx = sorted.findIndex(v => v >= lastAtr);
        const pct = idx < 0 ? 1 : (idx / Math.max(1, sorted.length - 1));
        hvpPercentile4h = Math.max(0, Math.min(1, pct));
      }
    }
    const atrBucket = (hvpPercentile4h == null) ? 'medium' : (hvpPercentile4h <= 0.33 ? 'low' : (hvpPercentile4h <= 0.66 ? 'medium' : 'high'));
    let padMul = flags.adaptive_proximity ? (atrBucket === 'low' ? 0.20 : (atrBucket === 'medium' ? 0.25 : 0.35)) : 0.25;
    let nearHalfMul = flags.adaptive_proximity ? (atrBucket === 'low' ? 0.40 : (atrBucket === 'medium' ? 0.50 : 0.60)) : 0.50;

    // -------- Regime filter (4h EMA21 slope + ATR percentile + BB width expansion) --------
    let regimeContext = { score: null, regime: 'neutral' };
    if (flags.regime_filter || flags.tp_sl_refine) {
      try {
        if (closes4h.length >= 40) {
          const ema21_4h = ema(closes4h, 21);
          const i = closes4h.length - 1;
          const lb = Math.max(0, i - 10);
          const price4h = closes4h[i];
          const slope = (Number.isFinite(ema21_4h[i]) && Number.isFinite(ema21_4h[lb]) && Number.isFinite(price4h))
            ? ((ema21_4h[i] - ema21_4h[lb]) / Math.max(1e-9, price4h))
            : 0;
          const slopeScore = Math.max(0, Math.min(1, Math.abs(slope) / 0.004));
          // BB width proxy via stddev (20)
          const win = 20;
          let widths = [];
          for (let k = Math.max(0, closes4h.length - 120); k < closes4h.length; k++) {
            const s = Math.max(0, k - win + 1);
            const seg = closes4h.slice(s, k+1).filter(Number.isFinite);
            if (seg.length >= 5) {
              const mean = seg.reduce((a,b)=>a+b,0)/seg.length;
              const variance = seg.reduce((a,b)=>a + Math.pow(b-mean,2),0)/seg.length;
              const std = Math.sqrt(variance);
              widths.push(2*std);
            }
          }
          const curW = widths[widths.length-1] ?? 0;
          const medW = widths.length ? [...widths].sort((a,b)=>a-b)[Math.floor(widths.length/2)] : 0;
          const widthRatio = (Number.isFinite(curW) && Number.isFinite(medW) && medW > 0) ? (curW/medW) : 1;
          const widthScore = Math.max(0, Math.min(1, (widthRatio - 0.8) / 0.7));
          let score = Math.max(0, Math.min(1, (slopeScore*0.5 + (hvpPercentile4h ?? 0.5)*0.25 + widthScore*0.25)));
          // RSI21 slope agreement on 4h
          const rsi21_4h = rsiWilder(closes4h, 21);
          const rlb = Math.max(0, i - 10);
          const rsiSlope = (Number.isFinite(rsi21_4h[i]) && Number.isFinite(rsi21_4h[rlb])) ? (rsi21_4h[i] - rsi21_4h[rlb]) : 0;
          const rsiAgree = (rsiSlope > 0 && slope > 0) || (rsiSlope < 0 && slope < 0);
          if (rsiAgree && Math.abs(rsiSlope) >= 3) score = Math.min(1, score + 0.1);
          // Alternation penalty during expansion
          let alternations = 0, dir = null;
          for (let k = Math.max(1, i-6); k <= i; k++) {
            const d = closes4h[k] - closes4h[k-1];
            const sgn = d >= 0 ? 1 : -1;
            if (dir != null && sgn !== dir) alternations++;
            dir = sgn;
          }
          if (widthRatio > 1.0 && alternations >= 3) score = Math.max(0, score - 0.1);
          regimeContext = { score, regime: (score >= 0.6 ? 'trend' : (score <= 0.4 ? 'chop' : 'neutral')) };
          // Bias pad slightly
          if (flags.regime_filter) {
            if (regimeContext.regime === 'trend') padMul *= 0.95;
            else if (regimeContext.regime === 'chop') padMul *= 1.08;
          }
        }
      } catch {}
    }

    function mapBias(sig) {
      if (sig.includes('STRONG BUY') || sig === 'BUY') return 'BUY';
      if (sig.includes('STRONG SELL') || sig === 'SELL') return 'SELL';
      return 'HOLD';
    }
    const bias = mapBias(final_signal);
    const primaryZone = bestHot ? {
      range_low: bestHot.low,
      range_high: bestHot.high,
      mid: (bestHot.low + bestHot.high)/2,
      includes_0714: !!bestHot.includes0714,
      includes_extension: !!bestHot.includesExt,
      fvg_overlap: zoneHasFvgOverlap(bestHot),
      ob_overlap: zoneHasObOverlap(bestHot),
      confluence_factors: [
        bands.hasOB ? 'order_block' : null,
        bands.hasFVG ? 'fvg' : null,
        bands.hasFib ? 'fib_golden_pocket' : null,
        bands.hasEMA ? 'ema_confluence' : null
      ].filter(Boolean),
      score: Number((bestHot.score ?? 0).toFixed(3)),
      action: (bestDir === 'UP') ? 'LONG' : (bestDir === 'DOWN' ? 'SHORT' : null),
      ltf_ready: zoneReady,
      liquidity_swept: liquiditySweptForEntry
    } : null;
    const altZones = scoredHot.slice(1,3).map(z => ({
      range_low: z.low, range_high: z.high, mid: (z.low+z.high)/2,
      includes_0714: !!z.includes0714,
      includes_extension: !!z.includesExt,
      fvg_overlap: zoneHasFvgOverlap(z),
      ob_overlap: zoneHasObOverlap(z),
      score: Number((z.score ?? 0).toFixed(3))
    }));
    const order_plan = {
      side: (() => {
        if (final_signal === 'STRONG BUY') return 'STRONG BUY';
        if (final_signal === 'BUY') return 'BUY';
        if (final_signal === 'STRONG SELL') return 'STRONG SELL';
        if (final_signal === 'SELL') return 'SELL';
        return 'HOLD';
      })(),
      entry_range: { low: suggestions.level1.entry_range.low, high: suggestions.level1.entry_range.high },
      entry: suggestions.level1.entry,
      stop: suggestions.level1.stop_loss,
      tp1: suggestions.level1.take_profit_1,
      tp2: suggestions.level1.take_profit_2,
      tp1_source: suggestions.level1.tp1_source,
      tp2_source: suggestions.level1.tp2_source,
      tp1_distance_atr: suggestions.level1.tp1_distance_atr,
      tp2_distance_atr: suggestions.level1.tp2_distance_atr,
      profit_taking_strategy: suggestions.level1.profit_taking_strategy,
      atr_used: suggestions.level1.atr_used
    };
    const pad = Number.isFinite(atrRef) ? atrRef * padMul : ((currentPrice ?? 0) * 0.0006);
    const lp = currentPrice ?? null;
    const zoneWithin = (primaryZone && lp != null)
      ? (lp >= (primaryZone.range_low - pad) && lp <= (primaryZone.range_high + pad))
      : false;
    // Balanced: allow near-zone if within 0.5*pad and moving toward band mid
    const nearZone = (() => {
      if (!primaryZone || lp == null) return false;
      if (zoneWithin) return false;
      const halfPad = pad * (nearHalfMul ?? 0.5);
      const lower = primaryZone.range_low - halfPad;
      const upper = primaryZone.range_high + halfPad;
      if (!(lp >= lower && lp <= upper)) return false;
      const mid = (primaryZone.range_low + primaryZone.range_high) / 2;
      const prev =
        normalized['4h']?.[normalized['4h'].length - 2]?.close ??
        normalized['1h']?.[normalized['1h'].length - 2]?.close ??
        normalized['15m']?.[normalized['15m'].length - 2]?.close ?? null;
      if (!Number.isFinite(prev)) return true;
      const dNow = Math.abs(lp - mid);
      const dPrev = Math.abs(prev - mid);
      return dNow < dPrev;
    })();
    const bypassLtf = (signal_confidence >= 0.8) && (entry_confidence >= 0.8);
    const ltfOk = bypassLtf ? true : !!(primaryZone && primaryZone.ltf_ready);
    
    // Entry readiness requires liquidity sweep (critical for swing trading)
    // Liquidity must be swept before entry to avoid early entries
    const liquidityReady = liquiditySweptForEntry || 
                          (bos && bos.liquiditySwept) || 
                          false; // Allow if BOS already validated liquidity

    // Require at least 2 confluence factors (OB/FVG/Fib/EMA) for a valid zone
    const confluenceCount = [
      bands.hasOB,
      bands.hasFVG,
      bands.hasFib,
      bands.hasEMA
    ].filter(Boolean).length;
    const confluenceReady = confluenceCount >= 2;

    // Market structure must not be clearly opposite to bias
    const msAlignedForEntry = (() => {
      if (marketStructure === 'bullish' && bias === 'SELL') return false;
      if (marketStructure === 'bearish' && bias === 'BUY') return false;
      return true; // neutral or range allowed
    })();
    
    const ready =
      (signal_confidence >= 0.7) &&  // require higher confidence (was 0.6)
      (entry_confidence >= 0.7) &&   // require higher confidence (was 0.6)
      ltfOk &&
      liquidityReady &&          // REQUIRED: Liquidity must be swept
      confluenceReady &&         // REQUIRED: at least 2 confluence factors
      msAlignedForEntry &&       // REQUIRED: market structure not opposite to bias
      (zoneWithin || nearZone);
    let readyFinal = !!ready;
    // Cooldown (longer horizon)
    if (flags.cooldown && symbol) {
      const lastIdx4h = normalized['4h']?.length ? (normalized['4h'].length - 1) : null;
      const lastTs4h = normalized['4h']?.[lastIdx4h]?.openTime ?? Date.now();
      const key = `${symbol}|${bias}`;
      const state = COOLDOWN_STATE.get(key);
      const prevIdx = Number.isInteger(clientLastReadyIndex) ? clientLastReadyIndex : (Number.isInteger(state?.idx) ? state.idx : null);
      const prevTs = Number.isFinite(clientLastReadyTime) ? clientLastReadyTime : (Number.isFinite(state?.ts) ? state.ts : null);
      const M = 2; // 2x4h bars
      const T = 8 * 60 * 60 * 1000; // 8 hours
      const tooSoonByBars = Number.isInteger(prevIdx) && Number.isInteger(lastIdx4h) && ((lastIdx4h - prevIdx) < M);
      const tooSoonByTime = Number.isFinite(prevTs) && ((Number(lastTs4h) - prevTs) < T);
      if (readyFinal && (tooSoonByBars || tooSoonByTime)) readyFinal = false;
      if (readyFinal && Number.isInteger(lastIdx4h)) COOLDOWN_STATE.set(key, { idx: lastIdx4h, ts: Number(lastTs4h) });
    }
    order_plan.ready = !!readyFinal;
    const structure = {
      bos: bos ? { 
        dir: bos.dir, 
        broken_level: bos.brokenLevel, 
        impulse_low: bos.low, 
        impulse_high: bos.high,
        break_candle_idx: bos.breakCandleIdx ?? null,
        candles_after_break: bos.candlesAfterBreak ?? null,
        time_confirmed: bos.timeConfirmed ?? false,
        volume_confirmed: bos.volumeConfirmed ?? false,
        volume_ratio: bos.volumeRatio ?? null,
        liquidity_swept: bos.liquiditySwept ?? false,
        htf_aligned: bos.htfAligned ?? false,
        valid: bos.valid ?? false
      } : null,
      swing_support: structureLow ?? null,
      swing_resistance: structureHigh ?? null,
      market_structure: marketStructure
    };
    // Confidence classification helpers and displays
    function confidenceLabel(x) {
      const v = Number(x);
      if (!Number.isFinite(v)) return 'low';
      if (v >= 0.70) return 'high';
      if (v >= 0.40) return 'medium';
      return 'low';
    }
    const bias_conf_label = confidenceLabel(signal_confidence);
    const entry_conf_label = confidenceLabel(entry_confidence);
    const flip_conf_label  = confidenceLabel(flip_zone_confidence ?? 0);
    const bias_conf_pretty  = `${signal_confidence.toFixed(3)} (${bias_conf_label})`;
    const entry_conf_pretty = `${entry_confidence.toFixed(3)} (${entry_conf_label})`;
    const flip_conf_pretty  = `${(flip_zone_confidence ?? 0).toFixed(3)} (${flip_conf_label})`;
    
    const last_price = currentPrice;
    
    const output = {
      symbol: symbol || null,
      exchangeSymbol: exchangeSymbol || null,
      timestamp: normalized['4h']?.[normalized['4h'].length-1]?.openTime ?? null,
      last_price: last_price ?? null,
      tf_used: '4h',
      bias,
      bias_confidence: Number(signal_confidence.toFixed(3)),
      entry_confidence: Number(entry_confidence.toFixed(3)),
      bias_confidence_label: bias_conf_label,
      entry_confidence_label: entry_conf_label,
      bias_confidence_pretty: bias_conf_pretty,
      entry_confidence_pretty: entry_conf_pretty,
      position_size_factor: Number(sizeFactor.toFixed(3)),
      position_size_tier: sizeTier,
      primary_zone: primaryZone,
      alt_zones: altZones,
      order_plan,
      flip_zone: {
        price: flip_zone_price,
        description: flip_zone_description,
        action: (typeof _flip_meta === 'object' ? _flip_meta.action : null),
        direction_after: (typeof _flip_meta === 'object' ? _flip_meta.direction_after_flip : null),
        confidence: Number((flip_zone_confidence ?? 0).toFixed(3)),
        confidence_label: flip_conf_label,
        confidence_pretty: flip_conf_pretty
      },
      structure
    };

    if (flags.instrumentation && Math.random() < 0.2) {
      console.log('[swing][instrumentation] readiness', {
        symbol,
        bias,
        signal_confidence: Number(signal_confidence.toFixed(3)),
        entry_confidence: Number(entry_confidence.toFixed(3)),
        ltf_ok: !!ltfOk,
        zone_within: !!zoneWithin,
        near_zone: !!nearZone,
        ready: !!readyFinal,
        padMul,
        nearHalfMul,
        regime: regimeContext
      });
    }
    return res.status(200).json(output);

  } catch (err) {
    console.error('[swing] error', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'internal error', detail: String(err && (err.stack || err.message || err)) });
  }
}

