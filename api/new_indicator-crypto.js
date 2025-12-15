// api/new_indicator-crypto.js
// Crypto Trading Strategy Engine
// Implements strict market structure (valid swings), supply/demand zones, and R:R filtering.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload;

    // --------------------------------------------------------------------------
    // 1. INPUT PARSING & NORMALIZATION (Matching api/indicators.js)
    // --------------------------------------------------------------------------
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
      if (!row) return null;
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
      return null;
    }

    function normalizeCandlesRaw(raw) {
      if (!raw) return [];
      if (Array.isArray(raw) && raw.length > 0 && !Array.isArray(raw[0])) {
        const chunked = chunkFlatNumericArray(raw, BINANCE_FIELDS);
        if (Array.isArray(chunked) && chunked.length > 0 && Array.isArray(chunked[0])) {
          return chunked.map(normalizeCandleRow).filter(Boolean);
        }
      }
      if (Array.isArray(raw)) return raw.map(normalizeCandleRow).filter(Boolean);
      return [];
    }

    function finalizeCandles(rawArr) {
      if (!Array.isArray(rawArr)) return [];
      const arr = rawArr.filter(c => c && c.openTime != null && Number.isFinite(c.close));
      arr.sort((a, b) => a.openTime - b.openTime);
      // Dedupe
      const out = [];
      const seen = new Set();
      for (const c of arr) {
        if (seen.has(c.openTime)) continue;
        seen.add(c.openTime);
        out.push(c);
      }
      return out;
    }

    // --------------------------------------------------------------------------
    // 2. HELPER FUNCTIONS (Technical Analysis & Structure)
    // --------------------------------------------------------------------------
    function calculateATR(candles, period = 14) {
      if (candles.length < period + 1) return new Array(candles.length).fill(0);
      const out = new Array(candles.length).fill(0);
      const trs = [];
      for(let i=0; i<candles.length; i++) {
        const c = candles[i];
        const prev = i > 0 ? candles[i-1] : null;
        const hl = c.high - c.low;
        const hc = prev ? Math.abs(c.high - prev.close) : 0;
        const lc = prev ? Math.abs(c.low - prev.close) : 0;
        trs.push(Math.max(hl, hc, lc));
      }
      let sum = 0;
      for (let i = 0; i < period; i++) sum += trs[i];
      out[period - 1] = sum / period;
      for (let i = period; i < candles.length; i++) {
        out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
      }
      return out;
    }

    function findPivots(candles) {
      const pivots = []; 
      // Using 5-candle fractal (2 left, 2 right)
      for (let i = 2; i < candles.length - 2; i++) {
        const c = candles[i];
        const h = c.high;
        const l = c.low;
        if (h > candles[i-1].high && h > candles[i-2].high && 
            h > candles[i+1].high && h > candles[i+2].high) {
          pivots.push({ index: i, type: 'H', price: h, time: c.openTime });
        }
        if (l < candles[i-1].low && l < candles[i-2].low && 
            l < candles[i+1].low && l < candles[i+2].low) {
          pivots.push({ index: i, type: 'L', price: l, time: c.openTime });
        }
      }
      return pivots;
    }

    function determineStructure(candles, pivots) {
      let validHighs = [];
      let validLows = [];
      let trend = 'neutral';
      
      const cleanPivots = [];
      if(pivots.length > 0) cleanPivots.push(pivots[0]);
      for(let i=1; i<pivots.length; i++) {
        const prev = cleanPivots[cleanPivots.length-1];
        const curr = pivots[i];
        if (curr.type !== prev.type) {
           cleanPivots.push(curr);
        } else {
           if (curr.type === 'H' && curr.price > prev.price) cleanPivots[cleanPivots.length-1] = curr;
           if (curr.type === 'L' && curr.price < prev.price) cleanPivots[cleanPivots.length-1] = curr;
        }
      }

      const confirmedStruct = [];
      for (let i = 1; i < cleanPivots.length; i++) {
        const curr = cleanPivots[i];
        const prev = cleanPivots[i-1];
        let broken = false;
        let breakIndex = -1;
        
        for (let k = curr.index + 1; k < candles.length; k++) {
          const c = candles[k];
          if (curr.type === 'L') {
            // Confirm Low by breaking High
            if (c.close > prev.price) {
              broken = true;
              breakIndex = k;
              break;
            }
          } else {
            // Confirm High by breaking Low
            if (c.close < prev.price) {
              broken = true;
              breakIndex = k;
              break;
            }
          }
        }
        
        if (broken) {
          if (curr.type === 'L') validLows.push({ ...curr, confirmedAt: breakIndex });
          else validHighs.push({ ...curr, confirmedAt: breakIndex });
          confirmedStruct.push({ ...curr, confirmedAt: breakIndex });
        }
      }
      
      const lastValidHigh = validHighs.length > 0 ? validHighs[validHighs.length-1] : null;
      const lastValidLow  = validLows.length > 0 ? validLows[validLows.length-1] : null;
      
      // Determine trend from last confirmed event
      const events = [...confirmedStruct].sort((a,b) => a.confirmedAt - b.confirmedAt);
      const lastEvent = events[events.length - 1];
      
      let calculatedTrend = 'neutral';
      if (lastEvent) {
         // If last event was Low (confirmed by breaking High), we are UP
         calculatedTrend = lastEvent.type === 'L' ? 'up' : 'down';
      }
      
      // Check for live breaks of valid structure
      const lastClose = candles[candles.length-1].close;
      if (calculatedTrend === 'up' && lastValidLow && lastClose < lastValidLow.price) {
        calculatedTrend = 'down';
      }
      if (calculatedTrend === 'down' && lastValidHigh && lastClose > lastValidHigh.price) {
        calculatedTrend = 'up';
      }
      
      return {
        trend: calculatedTrend,
        validHigh: lastValidHigh,
        validLow: lastValidLow,
        history: events
      };
    }

    function findZones(candles, atrValues) {
      const demandZones = [];
      const supplyZones = [];
      
      const CONSOLIDATION_LEN = 3; 
      const IMPULSE_MULT = 1.5; 
      const CONSOL_RANGE_MULT = 0.8;
      
      for (let i = CONSOLIDATION_LEN; i < candles.length - 1; i++) {
        const impulse = candles[i];
        const prevATR = atrValues[i-1] || (impulse.close * 0.01);
        
        const isBullishImpulse = (impulse.close > impulse.open) && 
                                 (Math.abs(impulse.close - impulse.open) > prevATR * IMPULSE_MULT);
        
        const isBearishImpulse = (impulse.close < impulse.open) && 
                                 (Math.abs(impulse.open - impulse.close) > prevATR * IMPULSE_MULT);
                                 
        if (!isBullishImpulse && !isBearishImpulse) continue;
        
        let isConsolidation = true;
        let lastConsolCandleHigh = -Infinity;
        let lastConsolCandleLow = Infinity;
        
        for (let j = 1; j <= CONSOLIDATION_LEN; j++) {
          const c = candles[i - j];
          const range = c.high - c.low;
          if (range > prevATR * CONSOL_RANGE_MULT) {
            isConsolidation = false;
            break;
          }
          if (j === 1) { 
             lastConsolCandleHigh = c.high;
             lastConsolCandleLow = c.low;
          }
        }
        
        if (isConsolidation) {
          if (isBullishImpulse) {
            demandZones.push({
              startIdx: i - 1,
              endIdx: i - 1,
              low: lastConsolCandleLow,
              high: lastConsolCandleHigh,
              impulseIdx: i
            });
          } else {
             supplyZones.push({
              startIdx: i - 1,
              endIdx: i - 1,
              low: lastConsolCandleLow,
              high: lastConsolCandleHigh,
              impulseIdx: i
            });
          }
        }
      }
      return { demandZones, supplyZones };
    }

    // Process a single timeframe
    function analyzeTimeframe(rawCandles, tfName) {
      const candles = finalizeCandles(normalizeCandlesRaw(rawCandles));
      if (candles.length < 20) return null;
      
      const atrValues = calculateATR(candles, 14);
      const pivots = findPivots(candles);
      const structure = determineStructure(candles, pivots);
      const { demandZones, supplyZones } = findZones(candles, atrValues);
      
      // Filter invalidated zones
      const validDemand = demandZones.filter(z => {
         for (let k = z.impulseIdx + 1; k < candles.length; k++) {
           if (candles[k].close < z.low) return false;
         }
         return true;
      });
      const validSupply = supplyZones.filter(z => {
         for (let k = z.impulseIdx + 1; k < candles.length; k++) {
           if (candles[k].close > z.high) return false;
         }
         return true;
      });
      
      return {
        tf: tfName,
        candles,
        atr: atrValues[atrValues.length-1],
        structure,
        zones: { demand: validDemand, supply: validSupply },
        lastPrice: candles[candles.length-1].close
      };
    }

    // --------------------------------------------------------------------------
    // 3. MULTI-TIMEFRAME ANALYSIS
    // --------------------------------------------------------------------------
    const tf15m = analyzeTimeframe(kline_15m, '15m');
    const tf1h  = analyzeTimeframe(kline_1h,  '1h');
    const tf4h  = analyzeTimeframe(kline_4h,  '4h');
    const tf1d  = analyzeTimeframe(kline_1d,  '1d');

    // fallback for trend if 4h missing
    const trendTF = tf4h || tf1h || tf15m;
    // fallback for entry if 15m missing
    const entryTF = tf15m || tf1h;
    
    if (!trendTF || !entryTF) {
       return res.status(400).json({ error: 'Insufficient data for analysis' });
    }

    // --------------------------------------------------------------------------
    // 4. SIGNAL GENERATION (MTF LOGIC)
    // --------------------------------------------------------------------------
    // Rule: Trend from HTF (4h), Entry from LTF (15m)
    
    let signal = 'HOLD';
    let entry = null;
    let sl = null;
    let tp1 = null;
    let tp2 = null;
    let rr = 0;
    let activeZone = null;
    
    const MIN_RR = 2.5;
    const currentPrice = entryTF.lastPrice;
    const trendDirection = trendTF.structure.trend; // 'up' or 'down'

    // Confluence Score (Optional, for output)
    let confluence = 0;
    if (tf1d && tf1d.structure.trend === trendDirection) confluence++;
    if (tf1h && tf1h.structure.trend === trendDirection) confluence++;
    
    // Trade Logic
    if (trendDirection === 'up') {
      // Look for Demand Zones on Entry Timeframe
      const sortedDemand = entryTF.zones.demand.sort((a,b) => b.low - a.low);
      
      for (const z of sortedDemand) {
        // Condition: Price retraces into zone
        // Strict: currentPrice <= z.high
        if (currentPrice <= z.high * 1.001 && currentPrice >= z.low * 0.999) {
           const potentialEntry = currentPrice;
           const potentialSL = z.low * 0.999; 
           
           // TP from Structure (HTF or LTF?)
           // Strategy says: "TP: the most recent valid swing high."
           // Usually we target the LTF swing high for a scalp, or HTF for a swing.
           // Since entry is LTF, let's use LTF structure first.
           let targetPrice = entryTF.structure.validHigh ? entryTF.structure.validHigh.price : null;
           
           // If LTF target is too close or undefined, try HTF target
           if (!targetPrice || targetPrice <= potentialEntry) {
              targetPrice = trendTF.structure.validHigh ? trendTF.structure.validHigh.price : null;
           }
           
           // Fallback TP: 3R
           if (!targetPrice || targetPrice <= potentialEntry) {
              targetPrice = potentialEntry + (potentialEntry - potentialSL) * 3;
           }

           const risk = Math.abs(potentialEntry - potentialSL);
           const reward = Math.abs(targetPrice - potentialEntry);
           
           if (risk > 0 && (reward / risk) >= MIN_RR) {
             signal = confluence >= 1 ? 'STRONG BUY' : 'BUY';
             entry = potentialEntry;
             sl = potentialSL;
             tp1 = targetPrice;
             tp2 = targetPrice + (targetPrice - potentialEntry) * 0.5; // Extension
             rr = reward / risk;
             activeZone = z;
             break;
           }
        }
      }
    } else if (trendDirection === 'down') {
      // Look for Supply Zones on Entry Timeframe
      const sortedSupply = entryTF.zones.supply.sort((a,b) => a.high - b.high);
      
      for (const z of sortedSupply) {
        if (currentPrice >= z.low * 0.999 && currentPrice <= z.high * 1.001) {
           const potentialEntry = currentPrice;
           const potentialSL = z.high * 1.001;
           
           let targetPrice = entryTF.structure.validLow ? entryTF.structure.validLow.price : null;
           
           if (!targetPrice || targetPrice >= potentialEntry) {
              targetPrice = trendTF.structure.validLow ? trendTF.structure.validLow.price : null;
           }
           
           if (!targetPrice || targetPrice >= potentialEntry) {
              targetPrice = potentialEntry - (potentialSL - potentialEntry) * 3;
           }
           
           const risk = Math.abs(potentialSL - potentialEntry);
           const reward = Math.abs(potentialEntry - targetPrice);
           
           if (risk > 0 && (reward / risk) >= MIN_RR) {
             signal = confluence >= 1 ? 'STRONG SELL' : 'SELL';
             entry = potentialEntry;
             sl = potentialSL;
             tp1 = targetPrice;
             tp2 = targetPrice - (potentialEntry - targetPrice) * 0.5;
             rr = reward / risk;
             activeZone = z;
             break;
           }
        }
      }
    }

    // Output Formatting
    const output = {
      symbol,
      main_trend_tf: trendTF.tf,
      entry_tf: entryTF.tf,
      trend: trendDirection.toUpperCase(),
      current_price: currentPrice,
      signal,
      entry: entry ? Number(entry.toFixed(5)) : null,
      stop_loss: sl ? Number(sl.toFixed(5)) : null,
      take_profit_1: tp1 ? Number(tp1.toFixed(5)) : null,
      take_profit_2: tp2 ? Number(tp2.toFixed(5)) : null,
      rr: rr ? Number(rr.toFixed(2)) : null,
      
      mtf_analysis: {
        '15m': tf15m ? { trend: tf15m.structure.trend, valid_high: tf15m.structure.validHigh?.price, valid_low: tf15m.structure.validLow?.price } : null,
        '1h':  tf1h  ? { trend: tf1h.structure.trend,  valid_high: tf1h.structure.validHigh?.price,  valid_low: tf1h.structure.validLow?.price } : null,
        '4h':  tf4h  ? { trend: tf4h.structure.trend,  valid_high: tf4h.structure.validHigh?.price,  valid_low: tf4h.structure.validLow?.price } : null,
        '1d':  tf1d  ? { trend: tf1d.structure.trend,  valid_high: tf1d.structure.validHigh?.price,  valid_low: tf1d.structure.validLow?.price } : null,
      },
      
      zones: {
        active_demand: entryTF.zones.demand.length,
        active_supply: entryTF.zones.supply.length,
        nearest_demand: entryTF.zones.demand.length ? entryTF.zones.demand[entryTF.zones.demand.length-1] : null,
        nearest_supply: entryTF.zones.supply.length ? entryTF.zones.supply[entryTF.zones.supply.length-1] : null
      }
    };

    return res.status(200).json(output);

  } catch (err) {
    console.error('[crypto-indicator] error', err);
    return res.status(500).json({ error: 'Internal Error', details: err.message });
  }
};

