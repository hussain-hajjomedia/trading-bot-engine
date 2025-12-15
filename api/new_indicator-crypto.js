// api/new_indicator-crypto.js
// Crypto Trading Strategy Engine
// Implements strict market structure (valid swings), supply/demand zones, and R:R filtering.
// Follows strictly instructions/crypto_strategy.md

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload;

    // --------------------------------------------------------------------------
    // 1. INPUT PARSING & NORMALIZATION
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
            // Confirm Low by breaking High (UP Trend condition part)
            if (c.close > prev.price) {
              broken = true;
              breakIndex = k;
              break;
            }
          } else {
            // Confirm High by breaking Low (DOWN Trend condition part)
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
      
      const events = [...confirmedStruct].sort((a,b) => a.confirmedAt - b.confirmedAt);
      const lastEvent = events[events.length - 1];
      
      // Strict Trend Definition from Markdown:
      // Uptrend: Confirmed valid low exists. Price broke previous valid high. Price NOT broken below current valid low.
      // Downtrend: Confirmed valid high exists. Price broke previous valid low. Price NOT broken above current valid high.
      
      // Default neutral
      let calculatedTrend = 'neutral';
      
      // Check last confirmed event to set BASE trend
      if (lastEvent) {
         calculatedTrend = lastEvent.type === 'L' ? 'up' : 'down';
      }
      
      // Check for LIVE breaks (Switching logic)
      // "Trend switches to downtrend when price breaks the current valid low."
      // "Trend switches to uptrend when price breaks the current valid high."
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
      
      // Strict Definition:
      // Consolidation (N candles) -> Impulse
      // Demand Zone = Low of last consolidation candle to High of last consolidation candle before impulse.
      
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
        
        // Check previous N candles
        for (let j = 1; j <= CONSOLIDATION_LEN; j++) {
          const c = candles[i - j];
          const range = c.high - c.low;
          if (range > prevATR * CONSOL_RANGE_MULT) {
            isConsolidation = false;
            break;
          }
          if (j === 1) { // The one right before impulse
             lastConsolCandleHigh = c.high;
             lastConsolCandleLow = c.low;
          }
        }
        
        if (isConsolidation) {
          if (isBullishImpulse) {
            demandZones.push({
              low: lastConsolCandleLow,
              high: lastConsolCandleHigh,
              impulseIdx: i
            });
          } else {
             supplyZones.push({
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
      // Zone is invalid if price broke it in opposite direction AFTER formation
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
    // 4. SIGNAL GENERATION (STRICT)
    // --------------------------------------------------------------------------
    
    let signal = 'HOLD';
    let entryPrice = null;
    let stopLoss = null;
    let takeProfit1 = null;
    let takeProfit2 = null;
    let tradeRR = null;
    let confidenceScore = 0;
    let confluenceScore = 0;
    
    const MIN_RR = 2.5;
    const currentPrice = entryTF.lastPrice;
    const trendDirection = trendTF.structure.trend; // 'up' or 'down'

    // Confluence Score Calculation:
    // +1 for 1D Trend Alignment
    // +1 for 1H Trend Alignment
    // +1 for 15M Trend Alignment
    if (tf1d && tf1d.structure.trend === trendDirection) confluenceScore++;
    if (tf1h && tf1h.structure.trend === trendDirection) confluenceScore++;
    if (tf15m && tf15m.structure.trend === trendDirection) confluenceScore++;
    
    // Confidence Score Calculation (0-100) based on factors
    // Base: 50
    // +20 if Confluence >= 2
    // +10 if Entry is in very tight zone (Zone range < 0.5% price)
    // +20 if High RR (> 4)
    let baseConfidence = 50;
    if (confluenceScore >= 2) baseConfidence += 20;

    // --- TRADE EXECUTION LOGIC ---
    
    if (trendDirection === 'up') {
      // 1. Detect Trend -> UP (Done)
      // 2. Identify Valid Low (Done in structure)
      // 3. Detect Demand Zone (Done)
      // 4. Wait for price retrace into demand zone
      
      const sortedDemand = entryTF.zones.demand.sort((a,b) => b.low - a.low); // Nearest (highest) first
      
      for (const z of sortedDemand) {
        // Condition: Price retraces into zone
        // We define "retrace into zone" as:
        // Current Price <= Zone High AND Current Price >= Zone Low * 0.99 (slight buffer for wick)
        // OR simply Price is currently INSIDE the zone.
        
        // Strict Check: Price needs to be inside or just touching the zone top
        // If price is way below zone low, zone is broken (already filtered in validDemand, but double check live price)
        if (currentPrice < z.low) continue; // Broken live
        
        if (currentPrice <= z.high * 1.001) { // touched zone
           const potentialEntry = currentPrice;
           
           // 5. Set SL = demand_zone_low
           const potentialSL = z.low; 
           
           // 5. Set TP = previous_valid_high
           // We prioritize the Entry Timeframe structure for initial targets as per standard scalp rules
           // But if undefined, check Trend TF
           let targetPrice = entryTF.structure.validHigh ? entryTF.structure.validHigh.price : null;
           
           if (!targetPrice || targetPrice <= potentialEntry) {
              targetPrice = trendTF.structure.validHigh ? trendTF.structure.validHigh.price : null;
           }
           
           // If still no valid high above (blue sky breakout), use 3R
           if (!targetPrice || targetPrice <= potentialEntry) {
              targetPrice = potentialEntry + (potentialEntry - potentialSL) * 3;
           }

           // 6. Check R:R >= 2.5
           const risk = Math.abs(potentialEntry - potentialSL);
           const reward = Math.abs(targetPrice - potentialEntry);
           
           if (risk > 0) {
             const rr = reward / risk;
             if (rr >= MIN_RR) {
               // 7. Execute Long
               signal = 'LONG';
               entryPrice = potentialEntry;
               stopLoss = potentialSL;
               takeProfit1 = targetPrice;
               takeProfit2 = targetPrice + (targetPrice - potentialEntry) * 0.5; // Extension
               tradeRR = Number(rr.toFixed(2));
               
               // Confidence Adjustments
               if ((z.high - z.low) / potentialEntry < 0.005) baseConfidence += 10; // Tight zone
               if (rr > 4) baseConfidence += 20;
               confidenceScore = Math.min(100, baseConfidence);
               
               break; // Found valid setup
             }
           }
        }
      }
      
    } else if (trendDirection === 'down') {
      // 1. Detect Trend -> DOWN (Done)
      // 2. Identify Valid High (Done)
      // 3. Detect Supply Zone (Done)
      // 4. Wait for price retrace into supply zone
      
      const sortedSupply = entryTF.zones.supply.sort((a,b) => a.high - b.high); // Lowest (closest) first
      
      for (const z of sortedSupply) {
        if (currentPrice > z.high) continue; // Broken live
        
        if (currentPrice >= z.low * 0.999) { // touched zone
           const potentialEntry = currentPrice;
           
           // 5. Set SL = supply_zone_high
           const potentialSL = z.high;
           
           // 5. Set TP = previous_valid_low
           let targetPrice = entryTF.structure.validLow ? entryTF.structure.validLow.price : null;
           
           if (!targetPrice || targetPrice >= potentialEntry) {
              targetPrice = trendTF.structure.validLow ? trendTF.structure.validLow.price : null;
           }
           
           if (!targetPrice || targetPrice >= potentialEntry) {
              targetPrice = potentialEntry - (potentialSL - potentialEntry) * 3;
           }
           
           // 6. Check R:R >= 2.5
           const risk = Math.abs(potentialSL - potentialEntry);
           const reward = Math.abs(potentialEntry - targetPrice);
           
           if (risk > 0) {
             const rr = reward / risk;
             if (rr >= MIN_RR) {
               // 7. Execute Short
               signal = 'SHORT';
               entryPrice = potentialEntry;
               stopLoss = potentialSL;
               takeProfit1 = targetPrice;
               takeProfit2 = targetPrice - (potentialEntry - targetPrice) * 0.5;
               tradeRR = Number(rr.toFixed(2));
               
               if ((z.high - z.low) / potentialEntry < 0.005) baseConfidence += 10;
               if (rr > 4) baseConfidence += 20;
               confidenceScore = Math.min(100, baseConfidence);
               
               break;
             }
           }
        }
      }
    }

    // --------------------------------------------------------------------------
    // 5. FINAL OUTPUT
    // --------------------------------------------------------------------------
    const output = {
      "Final Signal": signal,
      "Trade Close Price": entryPrice ? Number(entryPrice.toFixed(5)) : 0,
      "Stop Loss": stopLoss ? Number(stopLoss.toFixed(5)) : 0,
      "Take Profit 1": takeProfit1 ? Number(takeProfit1.toFixed(5)) : 0,
      "Take Profit 2": takeProfit2 ? Number(takeProfit2.toFixed(5)) : 0,
      "Trade Confidence Score": signal !== 'HOLD' ? confidenceScore : 0,
      "Confluence Score": confluenceScore,
      "RR": tradeRR ? tradeRR : 0
    };

    return res.status(200).json([output]);

  } catch (err) {
    console.error('[crypto-indicator] error', err);
    return res.status(500).json({ error: 'Internal Error', details: err.message });
  }
};
