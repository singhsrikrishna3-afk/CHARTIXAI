"use client";

import { useEffect, useRef, useState, useCallback, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import styles from "./charts.module.css";

const TIMEFRAMES = [
  { label: "D", value: "D" },
  { label: "W", value: "W" },
  { label: "M", value: "M" },
];

const BEARISH_PATTERNS = new Set([
  "double_top", "triple_top", "head_shoulders", "desc_triangle",
  "rising_wedge", "bear_flag"
]);

const CHART_STYLES = [
  { id: "candles", label: "Candles", icon: "🕯️" },
  { id: "bars", label: "Bars", icon: "📊" },
  { id: "hollow_candles", label: "Hollow candles", icon: "🕯️" },
  { id: "volume_candles", label: "Volume candles", icon: "🕯️" },
  { id: "line", label: "Line", icon: "📈" },
  { id: "line_markers", label: "Line with markers", icon: "📈" },
  { id: "step_line", label: "Step line", icon: "📈" },
  { id: "area", label: "Area", icon: "📈" },
  { id: "hlc_area", label: "HLC area", icon: "📈" },
  { id: "baseline", label: "Baseline", icon: "📈" },
  { id: "columns", label: "Columns", icon: "📊" },
  { id: "high_low", label: "High-low", icon: "📊" },
  { id: "heikin_ashi", label: "Heikin Ashi", icon: "🕯️" },
  { id: "renko", label: "Renko", icon: "🧱" },
  { id: "line_break", label: "Line break", icon: "📈" },
];


const INDICATOR_OPTIONS = [
  { key: "sma20", label: "SMA 20", color: "#f59e0b", period: 20, type: "sma" },
  { key: "sma50", label: "SMA 50", color: "#06b6d4", period: 50, type: "sma" },
  { key: "sma200", label: "SMA 200", color: "#f43f5e", period: 200, type: "sma" },
  { key: "ema20", label: "EMA 20", color: "#a78bfa", period: 20, type: "ema" },
  { key: "ema50", label: "EMA 50", color: "#34d399", period: 50, type: "ema" },
  { key: "rsi14", label: "RSI 14", color: "#ec4899", period: 14, type: "rsi" },
  { key: "macd", label: "MACD", color: "#8b5cf6", period: 0, type: "macd" },
];

const PATTERN_COLORS = {
  double_top: "#f43f5e",
  double_bottom: "#10b981",
  head_shoulders: "#f43f5e",
  inv_head_shoulders: "#10b981",
  asc_triangle: "#10b981",
  desc_triangle: "#f43f5e",
  sym_triangle: "#f59e0b",
  rising_wedge: "#f43f5e",
  falling_wedge: "#10b981",
  rectangle: "#06b6d4",
  triple_top: "#f43f5e",
  triple_bottom: "#10b981",
  bull_flag: "#10b981",
  bear_flag: "#f43f5e",
};

// ── MATH UTILS ─────────────────────────────────────
function computeHeikinAshi(data) {
  const result = [];
  if (data.length === 0) return result;
  
  let prevOpen = data[0].open;
  let prevClose = data[0].close;
  
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const haClose = (d.open + d.high + d.low + d.close) / 4;
    const haOpen = (prevOpen + prevClose) / 2;
    const haHigh = Math.max(d.high, haOpen, haClose);
    const haLow = Math.min(d.low, haOpen, haClose);
    
    result.push({
      time: d.time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      volume: d.volume,
    });
    
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return result;
}

function computeRenko(data, brickSize) {
  if (data.length === 0) return [];
  const result = [];
  let prevClose = data[0].close;
  let brickPrice = Math.round(prevClose / brickSize) * brickSize;
  
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const price = d.close;
    const diff = price - brickPrice;
    
    if (Math.abs(diff) >= brickSize) {
      const numBricks = Math.floor(Math.abs(diff) / brickSize);
      const direction = diff > 0 ? 1 : -1;
      for (let j = 0; j < numBricks; j++) {
        const open = brickPrice;
        const close = brickPrice + direction * brickSize;
        const high = Math.max(open, close);
        const low = Math.min(open, close);
        
        result.push({
          time: d.time,
          open,
          high,
          low,
          close,
          volume: d.volume / numBricks,
        });
        
        brickPrice = close;
      }
    }
  }
  
  const finalResult = [];
  if (result.length > 0) {
    const firstTime = result[0].time;
    const isNumber = typeof firstTime === "number";
    
    if (isNumber) {
      let lastTimeVal = firstTime;
      finalResult.push({
        ...result[0],
        time: firstTime
      });
      for (let i = 1; i < result.length; i++) {
        let currTimeVal = result[i].time;
        if (currTimeVal <= lastTimeVal) {
          currTimeVal = lastTimeVal + 1;
        }
        finalResult.push({
          ...result[i],
          time: currTimeVal
        });
        lastTimeVal = currTimeVal;
      }
    } else {
      const parseUTCDate = (dateStr) => {
        const parts = dateStr.split("-");
        if (parts.length !== 3) return new Date(dateStr);
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        return new Date(Date.UTC(year, month, day));
      };
      let lastTime = parseUTCDate(firstTime);
      finalResult.push({
        ...result[0],
        time: firstTime
      });
      for (let i = 1; i < result.length; i++) {
        let currTime = parseUTCDate(result[i].time);
        if (currTime <= lastTime) {
          currTime = new Date(lastTime.getTime() + 24 * 60 * 60 * 1000); // add 1 day
        }
        const yyyy = currTime.getUTCFullYear();
        const mm = String(currTime.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(currTime.getUTCDate()).padStart(2, '0');
        const timeStr = `${yyyy}-${mm}-${dd}`;
        
        finalResult.push({
          ...result[i],
          time: timeStr
        });
        lastTime = currTime;
      }
    }
  }
  return finalResult;
}

function computeLineBreak(data, numLines = 3) {
  if (data.length === 0) return [];
  const result = [];
  
  let lastBlock = {
    open: data[0].open,
    close: data[0].close,
    high: Math.max(data[0].open, data[0].close),
    low: Math.min(data[0].open, data[0].close),
    time: data[0].time,
    volume: data[0].volume
  };
  result.push(lastBlock);
  
  for (let i = 1; i < data.length; i++) {
    const d = data[i];
    const price = d.close;
    
    const lastBlocks = result.slice(-numLines);
    const extremeHigh = Math.max(...lastBlocks.map(b => Math.max(b.open, b.close)));
    const extremeLow = Math.min(...lastBlocks.map(b => Math.min(b.open, b.close)));
    
    const lastClose = lastBlock.close;
    const lastOpen = lastBlock.open;
    const isLastUp = lastClose > lastOpen;
    
    let newBlock = null;
    
    if (isLastUp) {
      if (price > lastClose) {
        newBlock = { open: lastClose, close: price };
      } else if (price < extremeLow) {
        newBlock = { open: lastClose, close: price };
      }
    } else {
      if (price < lastClose) {
        newBlock = { open: lastClose, close: price };
      } else if (price > extremeHigh) {
        newBlock = { open: lastClose, close: price };
      }
    }
    
    if (newBlock) {
      newBlock.high = Math.max(newBlock.open, newBlock.close);
      newBlock.low = Math.min(newBlock.open, newBlock.close);
      newBlock.time = d.time;
      newBlock.volume = d.volume;
      result.push(newBlock);
      lastBlock = newBlock;
    }
  }
  
  const finalResult = [];
  if (result.length > 0) {
    const firstTime = result[0].time;
    const isNumber = typeof firstTime === "number";
    
    if (isNumber) {
      let lastTimeVal = firstTime;
      finalResult.push({
        ...result[0],
        time: firstTime
      });
      for (let i = 1; i < result.length; i++) {
        let currTimeVal = result[i].time;
        if (currTimeVal <= lastTimeVal) {
          currTimeVal = lastTimeVal + 1;
        }
        finalResult.push({
          ...result[i],
          time: currTimeVal
        });
        lastTimeVal = currTimeVal;
      }
    } else {
      const parseUTCDate = (dateStr) => {
        const parts = dateStr.split("-");
        if (parts.length !== 3) return new Date(dateStr);
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        return new Date(Date.UTC(year, month, day));
      };
      let lastTime = parseUTCDate(firstTime);
      finalResult.push({
        ...result[0],
        time: firstTime
      });
      for (let i = 1; i < result.length; i++) {
        let currTime = parseUTCDate(result[i].time);
        if (currTime <= lastTime) {
          currTime = new Date(lastTime.getTime() + 24 * 60 * 60 * 1000); // add 1 day
        }
        const yyyy = currTime.getUTCFullYear();
        const mm = String(currTime.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(currTime.getUTCDate()).padStart(2, '0');
        const timeStr = `${yyyy}-${mm}-${dd}`;
        
        finalResult.push({
          ...result[i],
          time: timeStr
        });
        lastTime = currTime;
      }
    }
  }
  return finalResult;
}

function computeSMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j].close;
    result.push({ time: data[i].time, value: sum / period });
  }
  return result;
}

function computeEMA(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < data.length; i++) {
    if (ema === null) {
      if (i < period - 1) continue;
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j].close;
      ema = sum / period;
    } else {
      ema = data[i].close * k + ema * (1 - k);
    }
    result.push({ time: data[i].time, value: ema, close: ema });
  }
  return result;
}

function computeRSI(data, period) {
  const result = [];
  if (data.length < period) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    let rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
    result.push({ time: data[i].time, value: rsi });
  }
  return result;
}

function computeMACD(data, fast=12, slow=26, signal=9) {
  const fastEma = computeEMA(data, fast);
  const slowEma = computeEMA(data, slow);
  const macdLineData = [];
  for(let i=0; i<data.length; i++){
    const t = data[i].time;
    const f = fastEma.find(e => e.time === t);
    const s = slowEma.find(e => e.time === t);
    if(f && s) macdLineData.push({time: t, value: f.value - s.value, close: f.value - s.value});
  }
  const signalEma = computeEMA(macdLineData, signal);
  const result = [];
  for(let i=0; i<signalEma.length; i++) {
    const t = signalEma[i].time;
    const m = macdLineData.find(e => e.time === t).value;
    const s = signalEma[i].value;
    result.push({ time: t, value: m - s, macd: m, signal: s, hist: m - s });
  }
  return result;
}

function computeBB(data, period=20, mult=2) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1).map(d => d.close);
    const mean = slice.reduce((a,b) => a+b, 0) / period;
    const sd = Math.sqrt(slice.reduce((a,b) => a + (b-mean)**2, 0) / period);
    result.push({ time: data[i].time, upper: mean + mult*sd, middle: mean, lower: mean - mult*sd });
  }
  return result;
}

function computeWeeklyMonthlySRLevels(rawCandleData, currentPrice) {
  if (!rawCandleData || rawCandleData.length < 10) {
    return { weeklyHighs: [], weeklyLows: [], monthlyHighs: [], monthlyLows: [] };
  }

  // Aggregate daily data to Weekly and Monthly
  const weeklyCandles = aggregateTimeframe(rawCandleData, "W");
  const monthlyCandles = aggregateTimeframe(rawCandleData, "M");

  const getPivots = (candles, lb, isHigh) => {
    if (candles.length < 2 * lb + 1) return [];
    const vals = candles.map(c => isHigh ? c.high : c.low);
    const pivots = [];
    for (let i = lb; i < candles.length - lb; i++) {
      const val = vals[i];
      const slice = vals.slice(i - lb, i + lb + 1);
      const target = isHigh ? Math.max(...slice) : Math.min(...slice);
      if (val === target) {
        pivots.push(val);
      }
    }
    return pivots;
  };

  const wHighPivots = getPivots(weeklyCandles, 2, true);
  const wLowPivots = getPivots(weeklyCandles, 2, false);

  const mLb = monthlyCandles.length < 6 ? 1 : 2;
  const mHighPivots = getPivots(monthlyCandles, mLb, true);
  const mLowPivots = getPivots(monthlyCandles, mLb, false);

  const clusterAndFilter = (pivots, maxCount = 3, threshold = 0.015) => {
    if (pivots.length === 0) return [];
    const clusters = [];
    pivots.forEach(p => {
      let found = false;
      for (const c of clusters) {
        if (Math.abs(c.price - p) / p < threshold) {
          c.count += 1;
          c.price = (c.price * (c.count - 1) + p) / c.count;
          found = true;
          break;
        }
      }
      if (!found) {
        clusters.push({ price: p, count: 1 });
      }
    });
    // Sort by proximity to currentPrice so we display levels close to current price
    clusters.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
    return clusters.slice(0, maxCount).map(c => c.price);
  };

  return {
    weeklyHighs: clusterAndFilter(wHighPivots, 3),
    weeklyLows: clusterAndFilter(wLowPivots, 3),
    monthlyHighs: clusterAndFilter(mHighPivots, 3),
    monthlyLows: clusterAndFilter(mLowPivots, 3)
  };
}

// ── Auto Trendlines ───────────────────────────────────────────
// Accurate diagonal trendlines from pivot points: detect fractal swing
// highs/lows, try every meaningful pivot pair, score each candidate line by how
// many pivots it TOUCHES (within an ATR-based tolerance) minus how often price
// CLOSED through it, and keep the best non-duplicate support + resistance lines.
// Pure function of the loaded candles, so it works for every stock and index.
function computeAutoTrendlines(candles) {
  const N = Math.min(candles.length, 250);
  const bars = candles.slice(-N);
  if (bars.length < 40) return [];
  const last = bars.length - 1;
  const px = bars[last].close;

  // ATR(14) → touch tolerance that adapts to each stock's volatility
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const tol = Math.max(atr * 0.35, px * 0.0015);

  // fractal pivots (strict high/low vs k neighbours each side)
  const k = 3, pivH = [], pivL = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low <= bars[i].low) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) pivH.push(i);
    if (isL) pivL.push(i);
  }

  const bestLines = (piv, kind) => {
    const val = (i) => (kind === "res" ? bars[i].high : bars[i].low);
    const cands = [];
    for (let a = 0; a < piv.length; a++) {
      for (let b = a + 1; b < piv.length; b++) {
        const i = piv[a], j = piv[b];
        if (j - i < 12) continue;                      // too short to mean anything
        const slope = (val(j) - val(i)) / (j - i);
        // touches: pivots sitting on the line (anchors included)
        let touches = 0;
        for (const p of piv) {
          if (p < i) continue;
          if (Math.abs(val(p) - (val(i) + slope * (p - i))) <= tol) touches++;
        }
        // violations: closes THROUGH the line after it starts
        let viol = 0;
        for (let t = i; t <= last; t++) {
          const y = val(i) + slope * (t - i);
          if (kind === "res" ? bars[t].close > y + tol : bars[t].close < y - tol) viol++;
        }
        if (touches < 2 || viol > 1) continue;          // accuracy gate
        const yLast = val(i) + slope * (last - i);
        if (Math.abs(yLast - px) > px * 0.12) continue; // must be actionable near current price
        cands.push({
          kind, i, j, slope, touches, yLast,
          score: touches * 3 - viol * 2 + (j - i) / 60 - (last - j) / 80,
        });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    // dedupe: two lines are "the same" if they sit within tolerance of each
    // other at BOTH the last bar and 40 bars back (visually one line)
    const near = Math.max(tol * 2.5, px * 0.008);
    const at = (c, t) => c.yLast - c.slope * (last - t);
    const sel = [];
    for (const c of cands) {
      if (sel.length >= 2) break;                       // top 2 per side
      const dup = sel.some(s =>
        Math.abs(s.yLast - c.yLast) <= near &&
        Math.abs(at(s, last - 40) - at(c, last - 40)) <= near * 1.6);
      if (!dup) sel.push(c);
    }
    return sel;
  };

  return [...bestLines(pivH, "res"), ...bestLines(pivL, "sup")].map(L => ({
    kind: L.kind,
    touches: L.touches,
    p1: { time: bars[L.i].time, value: +((L.kind === "res" ? bars[L.i].high : bars[L.i].low)).toFixed(2) },
    p2: { time: bars[last].time, value: +L.yLast.toFixed(2) },
  }));
}

function computeStochastic(data, kPeriod=14, dPeriod=3) {
  const result = [];
  for (let i = kPeriod - 1; i < data.length; i++) {
    const slice = data.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...slice.map(d => d.high));
    const lowest  = Math.min(...slice.map(d => d.low));
    const k = highest === lowest ? 0 : ((data[i].close - lowest) / (highest - lowest)) * 100;
    result.push({ time: data[i].time, k, close: k });
  }
  if (result.length < dPeriod) return result;
  for (let i = dPeriod - 1; i < result.length; i++) {
    result[i].d = result.slice(i - dPeriod + 1, i + 1).reduce((a,b) => a + b.k, 0) / dPeriod;
    result[i].value = result[i].k;
  }
  return result.filter(r => r.d !== undefined);
}

function computeATR(data, period=14) {
  const trs = data.map((d, i) => {
    if (i === 0) return d.high - d.low;
    return Math.max(d.high - d.low, Math.abs(d.high - data[i-1].close), Math.abs(d.low - data[i-1].close));
  });
  const result = [];
  let atr = trs.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < data.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result.push({ time: data[i].time, value: atr });
  }
  return result;
}

function computeCCI(data, period=20) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const tp = slice.map(d => (d.high + d.low + d.close) / 3);
    const mean = tp.reduce((a,b) => a+b, 0) / period;
    const md = tp.reduce((a,b) => a + Math.abs(b - mean), 0) / period;
    result.push({ time: data[i].time, value: md === 0 ? 0 : (tp[tp.length-1] - mean) / (0.015 * md) });
  }
  return result;
}

function computeWilliamsR(data, period=14) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const hh = Math.max(...slice.map(d => d.high));
    const ll = Math.min(...slice.map(d => d.low));
    result.push({ time: data[i].time, value: hh === ll ? -50 : ((hh - data[i].close) / (hh - ll)) * -100 });
  }
  return result;
}

function computeADX(data, period=14) {
  if (data.length < period + 1) return [];
  const result = [];
  const pDM = [], nDM = [], tr = [];
  for (let i = 1; i < data.length; i++) {
    const upMove = data[i].high - data[i-1].high;
    const downMove = data[i-1].low - data[i].low;
    pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i-1].close), Math.abs(data[i].low - data[i-1].close)));
  }
  let atr14 = tr.slice(0,period).reduce((a,b) => a+b,0);
  let pDM14 = pDM.slice(0,period).reduce((a,b) => a+b,0);
  let nDM14 = nDM.slice(0,period).reduce((a,b) => a+b,0);
  const dxArr = [];
  for (let i = period; i < tr.length; i++) {
    atr14 = atr14 - atr14/period + tr[i];
    pDM14 = pDM14 - pDM14/period + pDM[i];
    nDM14 = nDM14 - nDM14/period + nDM[i];
    const pDI = (pDM14/atr14)*100, nDI = (nDM14/atr14)*100;
    const dx = pDI+nDI === 0 ? 0 : (Math.abs(pDI-nDI)/(pDI+nDI))*100;
    if (i + 1 < data.length) dxArr.push({ time: data[i+1].time, dx });
  }
  let adx = dxArr.slice(0,period).reduce((a,b) => a+b.dx,0)/period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx*(period-1) + dxArr[i].dx)/period;
    result.push({ time: dxArr[i].time, value: adx });
  }
  return result;
}

function computeVWAP(data) {
  let cumTPV = 0, cumVol = 0;
  return data.map(d => {
    const tp = (d.high + d.low + d.close) / 3;
    cumTPV += tp * (d.volume || 0);
    cumVol += (d.volume || 0);
    return { time: d.time, value: cumVol === 0 ? tp : cumTPV / cumVol };
  });
}

function computeOBV(data) {
  let obv = 0;
  return data.map((d, i) => {
    if (i === 0) return { time: d.time, value: 0 };
    obv += d.close > data[i-1].close ? (d.volume||0) : d.close < data[i-1].close ? -(d.volume||0) : 0;
    return { time: d.time, value: obv };
  });
}

function computeWMA(data, period) {
  const result = [];
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < data.length; i++) {
    let wsum = 0;
    for (let j = 0; j < period; j++) wsum += data[i - j].close * (period - j);
    result.push({ time: data[i].time, value: wsum / denom });
  }
  return result;
}

function computeDEMA(data, period) {
  const ema1 = computeEMA(data, period);
  const ema2 = computeEMA(ema1.map(d => ({ ...d, close: d.value })), period);
  const result = [];
  for (let i = 0; i < ema2.length; i++) {
    const t = ema2[i].time;
    const e1 = ema1.find(d => d.time === t);
    if (e1) result.push({ time: t, value: 2 * e1.value - ema2[i].value });
  }
  return result;
}

function computeTEMA(data, period) {
  const ema1 = computeEMA(data, period);
  const ema2 = computeEMA(ema1.map(d => ({ ...d, close: d.value })), period);
  const ema3 = computeEMA(ema2.map(d => ({ ...d, close: d.value })), period);
  const result = [];
  for (let i = 0; i < ema3.length; i++) {
    const t = ema3[i].time;
    const e1 = ema1.find(d => d.time === t);
    const e2 = ema2.find(d => d.time === t);
    if (e1 && e2) result.push({ time: t, value: 3 * e1.value - 3 * e2.value + ema3[i].value });
  }
  return result;
}

function computeHMA(data, period) {
  // Hull MA = WMA(2*WMA(n/2) - WMA(n), sqrt(n))
  const half = Math.floor(period / 2);
  const sqrtP = Math.round(Math.sqrt(period));
  const wmaFull = computeWMA(data, period);
  const wmaHalf = computeWMA(data, half);
  const diff = [];
  for (let i = 0; i < wmaFull.length; i++) {
    const t = wmaFull[i].time;
    const h = wmaHalf.find(d => d.time === t);
    if (h) diff.push({ time: t, close: 2 * h.value - wmaFull[i].value });
  }
  return computeWMA(diff, sqrtP);
}

function computeMFI(data, period=14) {
  const result = [];
  for (let i = period; i < data.length; i++) {
    const slice = data.slice(i - period, i + 1);
    let posFlow = 0, negFlow = 0;
    for (let j = 1; j < slice.length; j++) {
      const tp = (slice[j].high + slice[j].low + slice[j].close) / 3;
      const prevTp = (slice[j-1].high + slice[j-1].low + slice[j-1].close) / 3;
      const mf = tp * (slice[j].volume||0);
      if (tp > prevTp) posFlow += mf; else negFlow += mf;
    }
    result.push({ time: data[i].time, value: negFlow === 0 ? 100 : 100 - (100 / (1 + posFlow / negFlow)) });
  }
  return result;
}

function computeSuperTrend(data, period=7, mult=3) {
  const atr = computeATR(data, period);
  if (!atr.length) return [];
  const result = [];
  let trend = 1, prevUpper = 0, prevLower = 0;
  for (let i = 0; i < atr.length; i++) {
    const idx = data.length - atr.length + i;
    const d = data[idx];
    const hl2 = (d.high + d.low) / 2;
    let upper = hl2 + mult * atr[i].value;
    let lower = hl2 - mult * atr[i].value;
    if (i > 0) {
      lower = lower > prevLower || data[idx-1].close < prevLower ? lower : prevLower;
      upper = upper < prevUpper || data[idx-1].close > prevUpper ? upper : prevUpper;
    }
    trend = d.close > upper ? 1 : d.close < lower ? -1 : trend;
    result.push({ time: d.time, value: trend === 1 ? lower : upper, color: trend === 1 ? '#00AA00' : '#FF0000' });
    prevUpper = upper; prevLower = lower;
  }
  return result;
}

function computePSAR(data, step=0.02, max=0.2) {
  if (data.length < 2) return [];
  let bull = true, af = step, ep = data[0].high, psar = data[0].low;
  const result = [{ time: data[0].time, value: psar }];
  for (let i = 1; i < data.length; i++) {
    psar = psar + af * (ep - psar);
    if (bull) {
      if (data[i].low < psar) { bull = false; psar = ep; ep = data[i].low; af = step; }
      else if (data[i].high > ep) { ep = data[i].high; af = Math.min(af + step, max); }
    } else {
      if (data[i].high > psar) { bull = true; psar = ep; ep = data[i].high; af = step; }
      else if (data[i].low < ep) { ep = data[i].low; af = Math.min(af + step, max); }
    }
    result.push({ time: data[i].time, value: psar, color: bull ? '#00AA00' : '#FF0000' });
  }
  return result;
}

function computeROC(data, period = 12) {
  const out = [];
  for (let i = period; i < data.length; i++) {
    const prev = data[i - period].close;
    if (prev) out.push({ time: data[i].time, value: (data[i].close - prev) / prev * 100 });
  }
  return out;
}

function computeAroon(data, period = 25) {
  const up = [], down = [];
  for (let i = period; i < data.length; i++) {
    let hi = -Infinity, lo = Infinity, hiIdx = i, loIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (data[j].high >= hi) { hi = data[j].high; hiIdx = j; }
      if (data[j].low <= lo) { lo = data[j].low; loIdx = j; }
    }
    up.push({ time: data[i].time, value: ((period - (i - hiIdx)) / period) * 100 });
    down.push({ time: data[i].time, value: ((period - (i - loIdx)) / period) * 100 });
  }
  return { up, down };
}

function computeKeltner(data, period = 20, mult = 2) {
  const ema = computeEMA(data, period);
  const atr = computeATR(data, period);
  const atrMap = new Map(atr.map(d => [d.time, d.value]));
  const out = [];
  for (const e of ema) {
    const a = atrMap.get(e.time);
    if (a != null) out.push({ time: e.time, middle: e.value, upper: e.value + mult * a, lower: e.value - mult * a });
  }
  return out;
}

function computeDonchian(data, period = 20) {
  const out = [];
  for (let i = period - 1; i < data.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, data[j].high);
      lo = Math.min(lo, data[j].low);
    }
    out.push({ time: data[i].time, upper: hi, lower: lo, middle: (hi + lo) / 2 });
  }
  return out;
}

function emaArr(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function computeTRIX(data, period = 15) {
  const closes = data.map(d => d.close);
  const e1 = emaArr(closes, period), e2 = emaArr(e1, period), e3 = emaArr(e2, period);
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (e3[i - 1]) out.push({ time: data[i].time, value: (e3[i] - e3[i - 1]) / e3[i - 1] * 100 });
  }
  return out.slice(period * 3);
}

function computeUO(data, p1 = 7, p2 = 14, p3 = 28) {
  const bp = [], tr = [];
  for (let i = 1; i < data.length; i++) {
    const prevClose = data[i - 1].close;
    bp.push(data[i].close - Math.min(data[i].low, prevClose));
    tr.push(Math.max(data[i].high, prevClose) - Math.min(data[i].low, prevClose));
  }
  const out = [];
  for (let i = p3 - 1; i < bp.length; i++) {
    const sum = (arr, n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += arr[j]; return s; };
    const a1 = sum(bp, p1) / (sum(tr, p1) || 1);
    const a2 = sum(bp, p2) / (sum(tr, p2) || 1);
    const a3 = sum(bp, p3) / (sum(tr, p3) || 1);
    out.push({ time: data[i + 1].time, value: 100 * (4 * a1 + 2 * a2 + a3) / 7 });
  }
  return out;
}

function computeCMF(data, period = 20) {
  const out = [];
  for (let i = period - 1; i < data.length; i++) {
    let mfv = 0, vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = data[j];
      const hl = d.high - d.low;
      const mult = hl ? ((d.close - d.low) - (d.high - d.close)) / hl : 0;
      mfv += mult * (d.volume || 0);
      vol += (d.volume || 0);
    }
    out.push({ time: data[i].time, value: vol ? mfv / vol : 0 });
  }
  return out;
}

function computeADL(data) {
  let adl = 0;
  const out = [];
  for (const d of data) {
    const hl = d.high - d.low;
    const mult = hl ? ((d.close - d.low) - (d.high - d.close)) / hl : 0;
    adl += mult * (d.volume || 0);
    out.push({ time: d.time, value: adl });
  }
  return out;
}

function computeChaikinOsc(data, fast = 3, slow = 10) {
  const adl = computeADL(data).map(d => d.value);
  const e1 = emaArr(adl, fast), e2 = emaArr(adl, slow);
  return data.map((d, i) => ({ time: d.time, value: e1[i] - e2[i] })).slice(slow);
}

function computeVortex(data, period = 14) {
  const plus = [], minus = [];
  for (let i = period; i < data.length; i++) {
    let vmP = 0, vmM = 0, trS = 0;
    for (let j = i - period + 1; j <= i; j++) {
      vmP += Math.abs(data[j].high - data[j - 1].low);
      vmM += Math.abs(data[j].low - data[j - 1].high);
      trS += Math.max(data[j].high, data[j - 1].close) - Math.min(data[j].low, data[j - 1].close);
    }
    plus.push({ time: data[i].time, value: trS ? vmP / trS : 0 });
    minus.push({ time: data[i].time, value: trS ? vmM / trS : 0 });
  }
  return { plus, minus };
}

function computeMomentum(data, period = 10) {
  const out = [];
  for (let i = period; i < data.length; i++) out.push({ time: data[i].time, value: data[i].close - data[i - period].close });
  return out;
}

function computeDPO(data, period = 20) {
  const shift = Math.floor(period / 2) + 1;
  const out = [];
  for (let i = period - 1; i < data.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += data[j].close;
    const idx = i - shift;
    if (idx >= 0) out.push({ time: data[i].time, value: data[idx].close - s / period });
  }
  return out;
}

function computeAO(data) {
  const med = data.map(d => (d.high + d.low) / 2);
  const out = [];
  for (let i = 33; i < data.length; i++) {
    let s5 = 0, s34 = 0;
    for (let j = i - 4; j <= i; j++) s5 += med[j];
    for (let j = i - 33; j <= i; j++) s34 += med[j];
    out.push({ time: data[i].time, value: s5 / 5 - s34 / 34 });
  }
  return out;
}

function computeEFI(data, period = 13) {
  const raw = [];
  for (let i = 1; i < data.length; i++) raw.push((data[i].close - data[i - 1].close) * (data[i].volume || 0));
  const sm = emaArr(raw, period);
  return raw.map((_, i) => ({ time: data[i + 1].time, value: sm[i] })).slice(period);
}

function computeStochRSI(data, rsiP = 14, stochP = 14, kSmooth = 3, dSmooth = 3) {
  const rsi = computeRSI(data, rsiP);
  const kRaw = [];
  for (let i = stochP - 1; i < rsi.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - stochP + 1; j <= i; j++) { hi = Math.max(hi, rsi[j].value); lo = Math.min(lo, rsi[j].value); }
    kRaw.push({ time: rsi[i].time, value: hi === lo ? 0 : (rsi[i].value - lo) / (hi - lo) * 100 });
  }
  const smooth = (arr, n) => arr.map((d, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += arr[j].value;
    return { time: d.time, value: s / n };
  }).filter(Boolean);
  const kLine = smooth(kRaw, kSmooth);
  const dLine = smooth(kLine, dSmooth);
  return { k: kLine, d: dLine };
}

function computeIchimokuChart(data, tenkanP = 9, kijunP = 26, senkouP = 52) {
  const hl = (i, n) => {
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { hi = Math.max(hi, data[j].high); lo = Math.min(lo, data[j].low); }
    return (hi + lo) / 2;
  };
  const tenkan = [], kijun = [], spanA = [], spanB = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= tenkanP - 1) tenkan.push({ time: data[i].time, value: hl(i, tenkanP) });
    if (i >= kijunP - 1) kijun.push({ time: data[i].time, value: hl(i, kijunP) });
    // Senkou spans are shifted forward kijunP bars (plotted only within available data)
    const target = i + kijunP;
    if (target < data.length) {
      if (i >= kijunP - 1 && i >= tenkanP - 1) spanA.push({ time: data[target].time, value: (hl(i, tenkanP) + hl(i, kijunP)) / 2 });
      if (i >= senkouP - 1) spanB.push({ time: data[target].time, value: hl(i, senkouP) });
    }
  }
  return { tenkan, kijun, spanA, spanB };
}

function computeAlligator(data) {
  const med = data.map(d => (d.high + d.low) / 2);
  const smma = (n) => {
    const out = [];
    let prev;
    med.forEach((v, i) => {
      prev = i === 0 ? v : (prev * (n - 1) + v) / n;
      out.push(prev);
    });
    return out;
  };
  const jaw = smma(13), teeth = smma(8), lips = smma(5);
  return data.map((d, i) => ({ time: d.time, jaw: jaw[i], teeth: teeth[i], lips: lips[i] })).slice(13);
}

const ensureDateString = (timeVal) => {
  if (!timeVal) return "";
  if (typeof timeVal === "number") {
    const dateObj = new Date(timeVal * 1000);
    const yyyy = dateObj.getUTCFullYear();
    const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  if (typeof timeVal === "string") {
    return timeVal.split("T")[0];
  }
  return String(timeVal);
};

const parseTime = (timeStr) => {
  if (!timeStr) return null;
  if (typeof timeStr === "number") return timeStr;
  if (typeof timeStr !== "string") return null;

  // Try standard parsing first
  let ms = Date.parse(timeStr);
  if (!isNaN(ms)) return Math.floor(ms / 1000);

  // Manual robust parsing for Safari / timezone offsets
  // Format: YYYY-MM-DD[THH:MM:SS] and optional offset [Z or +HH:MM or -HH:MM]
  const match = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] ? Number(match[4]) : 0;
    const minute = match[5] ? Number(match[5]) : 0;
    const second = match[6] ? Number(match[6]) : 0;
    const offset = match[7];

    let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);

    if (offset && offset !== "Z") {
      const offsetSign = offset[0] === "+" ? 1 : -1;
      const offsetParts = offset.slice(1).split(":");
      const offsetHours = Number(offsetParts[0]);
      const offsetMinutes = offsetParts[1] ? Number(offsetParts[1]) : 0;
      const offsetMs = (offsetHours * 60 + offsetMinutes) * 60 * 1000;
      utcMs -= offsetSign * offsetMs;
    }

    return Math.floor(utcMs / 1000);
  }

  return null;
};

const formatBarTime = (timeVal) => {
  if (!timeVal) return "--";
  if (typeof timeVal === "number") {
    const dateObj = new Date(timeVal * 1000);
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(dateObj).replace(/,/g, "");
  }
  return timeVal;
};

function aggregateTimeframe(data, tf) {
  if (tf !== "W" && tf !== "M") return data;
  const result = [];
  let currentGroup = null;

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const dateStr = ensureDateString(d.time);
    const parts = dateStr.split("-");
    if (parts.length !== 3) continue;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const dateObj = new Date(Date.UTC(year, month, day));
    
    let groupKey;
    if (tf === "W") {
      // Find the Friday of the current date's week (using UTC methods)
      const dayOfWeek = dateObj.getUTCDay();
      const diff = 5 - dayOfWeek; // 5 is Friday
      const fridayDate = new Date(dateObj.getTime() + diff * 24 * 60 * 60 * 1000);
      const yyyy = fridayDate.getUTCFullYear();
      const mm = String(fridayDate.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(fridayDate.getUTCDate()).padStart(2, '0');
      groupKey = `${yyyy}-${mm}-${dd}`;
    } else {
      // Find the last day of the current date's month (using UTC methods)
      const nextMonthFirst = new Date(Date.UTC(year, month + 1, 1));
      const lastDayDate = new Date(nextMonthFirst.getTime() - 24 * 60 * 60 * 1000);
      const yyyy = lastDayDate.getUTCFullYear();
      const mm = String(lastDayDate.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(lastDayDate.getUTCDate()).padStart(2, '0');
      groupKey = `${yyyy}-${mm}-${dd}`;
    }

    if (!currentGroup || currentGroup.key !== groupKey) {
      if (currentGroup) result.push(currentGroup.candle);
      currentGroup = { key: groupKey, candle: { ...d, time: groupKey } };
    } else {
      currentGroup.candle.high = Math.max(currentGroup.candle.high, d.high);
      currentGroup.candle.low = Math.min(currentGroup.candle.low, d.low);
      currentGroup.candle.close = d.close;
      currentGroup.candle.volume += d.volume;
    }
  }
  if (currentGroup) result.push(currentGroup.candle);
  return result;
}

// Module-scope defaults so their identity is stable across renders. The prefs
// save-effect compares state against these by identity (===) to detect "state
// was never customized or loaded this mount" and preserves previously stored
// values instead of clobbering them with defaults (the bug that wiped saved MAs).
// Default MA ribbon for every account: fast SMA 9/13/21 for swing timing,
// EMA 50/100/200 for the higher-timeframe trend. Users can edit/replace/save
// their own — this is only the starting point for accounts with no saved layout.
const DEFAULT_MA_LINES = [
  { id: 1, type: 'SMA', period: 9,   color: '#f97316', visible: true },
  { id: 2, type: 'SMA', period: 13,  color: '#ef4444', visible: true },
  { id: 3, type: 'SMA', period: 21,  color: '#14b8a6', visible: true },
  { id: 4, type: 'EMA', period: 50,  color: '#fb7185', visible: true },
  { id: 5, type: 'EMA', period: 100, color: '#4ade80', visible: true },
  { id: 6, type: 'EMA', period: 200, color: '#22c55e', visible: true },
];
const DEFAULT_ACTIVE_INDICATORS = ['rsi', 'macd'];

const INDICES = {
  "NIFTY 50": [
    "NIFTY_50",
    "RELIANCE",
    "TCS",
    "HDFCBANK",
    "INFY",
    "ICICIBANK",
    "BAJAJ-AUTO",
    "ITC",
    "SBIN",
    "BHARTIARTL",
    "KOTAKBANK",
    "LT",
    "ASIANPAINT",
    "AXISBANK",
    "MARUTI",
    "SUNPHARMA",
    "BAJFINANCE",
    "TITAN",
    "ULTRACEMCO",
    "BAJAJFINSV",
    "TATASTEEL",
    "ADANIENT",
    "ADANIPORTS",
    "APOLLOHOSP",
    "BEL",
    "CIPLA",
    "COALINDIA",
    "DRREDDY",
    "EICHERMOT",
    "ETERNAL",
    "GRASIM",
    "HCLTECH",
    "HDFCLIFE",
    "HINDALCO",
    "HINDUNILVR",
    "INDIGO",
    "JSWSTEEL",
    "JIOFIN",
    "M&M",
    "MAXHEALTH",
    "NTPC",
    "NESTLEIND",
    "ONGC",
    "POWERGRID",
    "SBILIFE",
    "SHRIRAMFIN",
    "TATACONSUM",
    "TMPV",
    "TECHM",
    "TRENT",
    "WIPRO"
  ],
  "NIFTY AUTO": [
    "NIFTY_AUTO",
    "ASHOKLEY",
    "BAJAJ-AUTO",
    "BHARATFORG",
    "BOSCHLTD",
    "EICHERMOT",
    "EXIDEIND",
    "HEROMOTOCO",
    "M&M",
    "MARUTI",
    "MOTHERSON",
    "SONACOMS",
    "TVSMOTOR",
    "TMPV",
    "TIINDIA",
    "UNOMINDA"
  ],
  "NIFTY BANK": [
    "NIFTY_BANK",
    "AUBANK",
    "AXISBANK",
    "BANKBARODA",
    "CANBK",
    "FEDERALBNK",
    "HDFCBANK",
    "ICICIBANK",
    "IDFCFIRSTB",
    "INDUSINDBK",
    "KOTAKBANK",
    "PNB",
    "SBIN",
    "UNIONBANK",
    "YESBANK"
  ],
  "NIFTY CEMENT": [
    "NIFTY_CEMENT",
    "ULTRACEMCO",
    "GRASIM",
    "AMBUJACEM",
    "SHREECEM",
    "JKCEMENT",
    "DALBHARAT",
    "ACC",
    "RAMCOCEM",
    "JSWCEMENT",
    "NUVOCO",
    "INDIACEM",
    "JKLAKSHMI",
    "STARCEMENT",
    "BIRLACORPN",
    "PRSMJOHNSN",
    "ORIENTCEM"
  ],
  "NIFTY CHEMICALS": [
    "NIFTY_CHEMICALS",
    "AARTIIND",
    "ATUL",
    "BAYERCROP",
    "CHAMBLFERT",
    "COROMANDEL",
    "DEEPAKNTR",
    "EIDPARRY",
    "FLUOROCHEM",
    "GNFC",
    "HSCL",
    "LINDEINDIA",
    "NAVINFLUOR",
    "PCBL",
    "PIIND",
    "PIDILITIND",
    "SRF",
    "SOLARINDS",
    "SUMICHEM",
    "TATACHEM",
    "UPL"
  ],
  "NIFTY FINANCIAL SERVICES": [
    "NIFTY_FIN_SERVICES",
    "AXISBANK",
    "BSE",
    "BAJFINANCE",
    "BAJAJFINSV",
    "CHOLAFIN",
    "HDFCBANK",
    "HDFCLIFE",
    "ICICIBANK",
    "ICICIGI",
    "JIOFIN",
    "KOTAKBANK",
    "LICHSGFIN",
    "MFSL",
    "MUTHOOTFIN",
    "PFC",
    "RECLTD",
    "SBICARD",
    "SBILIFE",
    "SHRIRAMFIN",
    "SBIN"
  ],
  "NIFTY FINANCIAL SERVICES 25/50": [
    "NIFTY_FIN_SERVICES_25_50",
    "AXISBANK",
    "BAJFINANCE",
    "BAJAJFINSV",
    "CHOLAFIN",
    "HDFCAMC",
    "HDFCBANK",
    "HDFCLIFE",
    "ICICIBANK",
    "ICICIGI",
    "ICICIPRULI",
    "IEX",
    "KOTAKBANK",
    "LICHSGFIN",
    "MUTHOOTFIN",
    "PFC",
    "RECLTD",
    "SBICARD",
    "SBILIFE",
    "SHRIRAMFIN",
    "SBIN"
  ],
  "NIFTY FINANCIAL SERVICES EX-BANK": [
    "NIFTY_FIN_SERVICES_EX_BANK",
    "360ONE",
    "ABCAPITAL",
    "ANGELONE",
    "BSE",
    "BAJFINANCE",
    "BAJAJFINSV",
    "BAJAJHLDNG",
    "CDSL",
    "CHOLAFIN",
    "CAMS",
    "HDFCAMC",
    "HDFCLIFE",
    "ICICIGI",
    "ICICIPRULI",
    "IRFC",
    "JIOFIN",
    "LTF",
    "LICHSGFIN",
    "LICI",
    "MFSL",
    "MCX",
    "MUTHOOTFIN",
    "PAYTM",
    "POLICYBZR",
    "PNBHOUSING",
    "PFC",
    "RECLTD",
    "SBICARD",
    "SBILIFE",
    "SHRIRAMFIN"
  ],
  "NIFTY FMCG": [
    "NIFTY_FMCG",
    "BRITANNIA",
    "COLPAL",
    "DABUR",
    "EMAMILTD",
    "GODREJCP",
    "HINDUNILVR",
    "ITC",
    "MARICO",
    "NESTLEIND",
    "PATANJALI",
    "RADICO",
    "TATACONSUM",
    "UBL",
    "UNITDSPR",
    "VBL"
  ],
  "NIFTY HEALTHCARE": [
    "NIFTY_HEALTHCARE",
    "ABBOTINDIA",
    "ALKEM",
    "APOLLOHOSP",
    "AUROPHARMA",
    "BIOCON",
    "CIPLA",
    "DIVISLAB",
    "DRREDDY",
    "FORTIS",
    "GLENMARK",
    "IPCALAB",
    "LAURUSLABS",
    "LUPIN",
    "MANKIND",
    "MAXHEALTH",
    "PPLPHARMA",
    "SUNPHARMA",
    "SYNGENE",
    "TORNTPHARM",
    "ZYDUSLIFE"
  ],
  "NIFTY IT": [
    "NIFTY_IT",
    "COFORGE",
    "HCLTECH",
    "INFY",
    "LTM",
    "MPHASIS",
    "OFSS",
    "PERSISTENT",
    "TCS",
    "TECHM",
    "WIPRO"
  ],
  "NIFTY MEDIA": [
    "NIFTY_MEDIA",
    "DBCORP",
    "HATHWAY",
    "NAZARA",
    "NETWORK18",
    "PVRINOX",
    "PFOCUS",
    "SAREGAMA",
    "SUNTV",
    "TIPSMUSIC",
    "ZEEL"
  ],
  "NIFTY METAL": [
    "NIFTY_METAL",
    "APLAPOLLO",
    "ADANIENT",
    "HINDALCO",
    "HINDCOPPER",
    "HINDZINC",
    "JSWSTEEL",
    "JSL",
    "JINDALSTEL",
    "LLOYDSME",
    "NMDC",
    "NATIONALUM",
    "SAIL",
    "TATASTEEL",
    "VAML",
    "VISL",
    "VEDL",
    "VOGL",
    "VEDPOWER",
    "WELCORP"
  ],
  "NIFTY PHARMA": [
    "NIFTY_PHARMA",
    "ABBOTINDIA",
    "AJANTPHARM",
    "ALKEM",
    "AUROPHARMA",
    "BIOCON",
    "CIPLA",
    "DIVISLAB",
    "DRREDDY",
    "GLAND",
    "GLENMARK",
    "IPCALAB",
    "JBCHEPHARM",
    "LAURUSLABS",
    "LUPIN",
    "MANKIND",
    "PPLPHARMA",
    "SUNPHARMA",
    "TORNTPHARM",
    "WOCKPHARMA",
    "ZYDUSLIFE"
  ],
  "NIFTY PRIVATE BANK": [
    "NIFTY_PRIVATE_BANK",
    "AXISBANK",
    "BANDHANBNK",
    "FEDERALBNK",
    "HDFCBANK",
    "ICICIBANK",
    "IDFCFIRSTB",
    "INDUSINDBK",
    "KOTAKBANK",
    "RBLBANK",
    "YESBANK"
  ],
  "NIFTY PSU BANK": [
    "NIFTY_PSU_BANK",
    "BANKBARODA",
    "BANKINDIA",
    "MAHABANK",
    "CANBK",
    "CENTRALBK",
    "INDIANB",
    "IOB",
    "PSB",
    "PNB",
    "SBIN",
    "UCOBANK",
    "UNIONBANK"
  ],
  "NIFTY REALTY": [
    "NIFTY_REALTY",
    "ABREL",
    "ANANTRAJ",
    "BRIGADE",
    "DLF",
    "GODREJPROP",
    "LODHA",
    "OBEROIRLTY",
    "PHOENIXLTD",
    "PRESTIGE",
    "SOBHA"
  ],
  "NIFTY REITS & REALTY": [
    "NIFTY_REITS_REALTY",
    "DLF",
    "LODHA",
    "PRESTIGE",
    "PHOENIXLTD",
    "GODREJPROP",
    "OBEROIRLTY",
    "KRT",
    "EMBASSY",
    "MINDSPACE",
    "NXST",
    "BIRET",
    "BRIGADE",
    "ANANTRAJ",
    "SOBHA",
    "EMBDL"
  ],
  "NIFTY CONSUMER DURABLES": [
    "NIFTY_CONSUMER_DURABLES",
    "AMBER",
    "BATAINDIA",
    "BLUESTARCO",
    "CROMPTON",
    "DIXON",
    "HAVELLS",
    "KAJARIACER",
    "KALYANKJIL",
    "LGEINDIA",
    "PGEL",
    "TITAN",
    "VOLTAS",
    "WHIRLPOOL"
  ],
  "NIFTY OIL AND GAS": [
    "NIFTY_OIL_GAS",
    "ATGL",
    "AEGISLOG",
    "AEGISVOPAK",
    "BPCL",
    "CASTROLIND",
    "CHENNPETRO",
    "GAIL",
    "HINDPETRO",
    "IOC",
    "IGL",
    "MGL",
    "ONGC",
    "OIL",
    "PETRONET",
    "RELIANCE"
  ],
  "NIFTY500 HEALTHCARE": [
    "NIFTY_500_HEALTHCARE",
    "ABBOTINDIA",
    "AJANTPHARM",
    "APLLTD",
    "ALIVUS",
    "ALKEM",
    "APOLLOHOSP",
    "ASTERDM",
    "ASTRAZEN",
    "AUROPHARMA",
    "BIOCON",
    "CAPLIPOINT",
    "CIPLA",
    "COHANCE",
    "CONCORDBIO",
    "DIVISLAB",
    "LALPATHLAB",
    "DRREDDY",
    "EMCURE",
    "ERIS",
    "FORTIS",
    "GLAND",
    "GLAXO",
    "GLENMARK",
    "MEDANTA",
    "GRANULES",
    "INDGN",
    "IPCALAB",
    "JBCHEPHARM",
    "JUBLPHARMA",
    "KIMS",
    "LAURUSLABS",
    "LUPIN",
    "MANKIND",
    "MAXHEALTH",
    "METROPOLIS",
    "NATCOPHARM",
    "NH",
    "NEULANDLAB",
    "PFIZER",
    "PPLPHARMA",
    "POLYMED",
    "RAINBOW",
    "SAILIFE",
    "SUNPHARMA",
    "SYNGENE",
    "TORNTPHARM",
    "VIJAYA",
    "ZYDUSLIFE"
  ],
  "NIFTY MIDSMALL FINANCIAL SERVICES": [
    "NIFTY_MIDSMALL_FIN_SERVICES",
    "360ONE",
    "AUBANK",
    "ABCAPITAL",
    "ANGELONE",
    "BSE",
    "BANDHANBNK",
    "BANKINDIA",
    "CDSL",
    "CAMS",
    "FEDERALBNK",
    "HUDCO",
    "ICICIGI",
    "ICICIPRULI",
    "IDFCFIRSTB",
    "INDIANB",
    "IEX",
    "INDUSINDBK",
    "KFINTECH",
    "LTF",
    "LICHSGFIN",
    "LICI",
    "MANAPPURAM",
    "MFSL",
    "MCX",
    "PAYTM",
    "POLICYBZR",
    "PNBHOUSING",
    "RBLBANK",
    "SBICARD",
    "YESBANK"
  ],
  "NIFTY MIDSMALL HEALTHCARE": [
    "NIFTY_MIDSMALL_HEALTHCARE",
    "ABBOTINDIA",
    "AJANTPHARM",
    "ALKEM",
    "ASTERDM",
    "AUROPHARMA",
    "BIOCON",
    "COHANCE",
    "LALPATHLAB",
    "FORTIS",
    "GLAND",
    "GLAXO",
    "GLENMARK",
    "MEDANTA",
    "GRANULES",
    "IPCALAB",
    "JBCHEPHARM",
    "KIMS",
    "LAURUSLABS",
    "LUPIN",
    "MANKIND",
    "NATCOPHARM",
    "NH",
    "NEULANDLAB",
    "ONESOURCE",
    "PFIZER",
    "PPLPHARMA",
    "POLYMED",
    "SAILIFE",
    "SYNGENE",
    "WOCKPHARMA"
  ],
  "NIFTY MIDSMALL IT & TELECOM": [
    "NIFTY_MIDSMALL_IT_TELECOM",
    "AFFLE",
    "BHARTIHEXA",
    "COFORGE",
    "CYIENT",
    "HFCL",
    "HEXT",
    "INDUSTOWER",
    "INTELLECT",
    "KPITTECH",
    "LTTS",
    "MPHASIS",
    "OFSS",
    "PERSISTENT",
    "SAGILITY",
    "SONATSOFTW",
    "TATACOMM",
    "TATAELXSI",
    "TATATECH",
    "IDEA",
    "ZENSARTECH"
  ],
  "NIFTY NEXT 50": [
    "NIFTY_NEXT_50",
    "ABB",
    "ADANIENSOL",
    "ADANIGREEN",
    "ADANIPOWER",
    "AMBUJACEM",
    "BAJAJHLDNG",
    "BANKBARODA",
    "BOSCHLTD",
    "BPCL",
    "BRITANNIA",
    "CANBK",
    "CGPOWER",
    "CHOLAFIN",
    "CUMMINSIND",
    "DIVISLAB",
    "DLF",
    "DMART",
    "ENRIN",
    "GAIL",
    "GODREJCP",
    "HAL",
    "HDFCAMC",
    "HINDZINC",
    "HYUNDAI",
    "INDHOTEL",
    "IOC",
    "IRFC",
    "JINDALSTEL",
    "LODHA",
    "LTM",
    "MAZDOCK",
    "MOTHERSON",
    "MUTHOOTFIN",
    "PFC",
    "PIDILITIND",
    "PNB",
    "RECLTD",
    "SHREECEM",
    "SIEMENS",
    "SOLARINDS",
    "TATACAP",
    "TATAPOWER",
    "TMCV",
    "TORNTPHARM",
    "TVSMOTOR",
    "UNIONBANK",
    "UNITDSPR",
    "VBL",
    "VEDL",
    "ZYDUSLIFE",
  ],
  "NIFTY 100": [
    "NIFTY_100",
    "ABB",
    "ADANIENSOL",
    "ADANIENT",
    "ADANIGREEN",
    "ADANIPORTS",
    "ADANIPOWER",
    "AMBUJACEM",
    "APOLLOHOSP",
    "ASIANPAINT",
    "AXISBANK",
    "BAJAJ-AUTO",
    "BAJAJFINSV",
    "BAJAJHLDNG",
    "BAJFINANCE",
    "BANKBARODA",
    "BEL",
    "BHARTIARTL",
    "BOSCHLTD",
    "BPCL",
    "BRITANNIA",
    "CANBK",
    "CGPOWER",
    "CHOLAFIN",
    "CIPLA",
    "COALINDIA",
    "CUMMINSIND",
    "DIVISLAB",
    "DLF",
    "DMART",
    "DRREDDY",
    "EICHERMOT",
    "ENRIN",
    "ETERNAL",
    "GAIL",
    "GODREJCP",
    "GRASIM",
    "HAL",
    "HCLTECH",
    "HDFCAMC",
    "HDFCBANK",
    "HDFCLIFE",
    "HINDALCO",
    "HINDUNILVR",
    "HINDZINC",
    "HYUNDAI",
    "ICICIBANK",
    "INDHOTEL",
    "INDIGO",
    "INFY",
    "IOC",
    "IRFC",
    "ITC",
    "JINDALSTEL",
    "JIOFIN",
    "JSWSTEEL",
    "KOTAKBANK",
    "LODHA",
    "LT",
    "LTM",
    "M&M",
    "MARUTI",
    "MAXHEALTH",
    "MAZDOCK",
    "MOTHERSON",
    "MUTHOOTFIN",
    "NESTLEIND",
    "NTPC",
    "ONGC",
    "PFC",
    "PIDILITIND",
    "PNB",
    "POWERGRID",
    "RECLTD",
    "RELIANCE",
    "SBILIFE",
    "SBIN",
    "SHREECEM",
    "SHRIRAMFIN",
    "SIEMENS",
    "SOLARINDS",
    "SUNPHARMA",
    "TATACAP",
    "TATACONSUM",
    "TATAPOWER",
    "TATASTEEL",
    "TCS",
    "TECHM",
    "TITAN",
    "TMCV",
    "TMPV",
    "TORNTPHARM",
    "TRENT",
    "TVSMOTOR",
    "ULTRACEMCO",
    "UNIONBANK",
    "UNITDSPR",
    "VBL",
    "VEDL",
    "WIPRO",
    "ZYDUSLIFE",
  ],
  "NIFTY 200": [
    "NIFTY_200",
    "360ONE",
    "ABB",
    "ABCAPITAL",
    "ADANIENSOL",
    "ADANIENT",
    "ADANIGREEN",
    "ADANIPORTS",
    "ADANIPOWER",
    "ALKEM",
    "AMBUJACEM",
    "APLAPOLLO",
    "APOLLOHOSP",
    "ASHOKLEY",
    "ASIANPAINT",
    "ASTRAL",
    "ATGL",
    "AUBANK",
    "AUROPHARMA",
    "AXISBANK",
    "BAJAJ-AUTO",
    "BAJAJFINSV",
    "BAJAJHLDNG",
    "BAJFINANCE",
    "BANKBARODA",
    "BANKINDIA",
    "BDL",
    "BEL",
    "BHARATFORG",
    "BHARTIARTL",
    "BHEL",
    "BIOCON",
    "BLUESTARCO",
    "BOSCHLTD",
    "BPCL",
    "BRITANNIA",
    "BSE",
    "CANBK",
    "CGPOWER",
    "CHOLAFIN",
    "CIPLA",
    "COALINDIA",
    "COCHINSHIP",
    "COFORGE",
    "COLPAL",
    "CONCOR",
    "COROMANDEL",
    "CUMMINSIND",
    "DABUR",
    "DIVISLAB",
    "DIXON",
    "DLF",
    "DMART",
    "DRREDDY",
    "EICHERMOT",
    "ENRIN",
    "ETERNAL",
    "EXIDEIND",
    "FEDERALBNK",
    "FORTIS",
    "GAIL",
    "GLENMARK",
    "GMRAIRPORT",
    "GODFRYPHLP",
    "GODREJCP",
    "GODREJPROP",
    "GRASIM",
    "GROWW",
    "GVT&D",
    "HAL",
    "HAVELLS",
    "HCLTECH",
    "HDFCAMC",
    "HDFCBANK",
    "HDFCLIFE",
    "HEROMOTOCO",
    "HINDALCO",
    "HINDPETRO",
    "HINDUNILVR",
    "HINDZINC",
    "HUDCO",
    "HYUNDAI",
    "ICICIAMC",
    "ICICIBANK",
    "ICICIGI",
    "IDEA",
    "IDFCFIRSTB",
    "INDHOTEL",
    "INDIANB",
    "INDIGO",
    "INDUSINDBK",
    "INDUSTOWER",
    "INFY",
    "IOC",
    "IRCTC",
    "IREDA",
    "IRFC",
    "ITC",
    "JINDALSTEL",
    "JIOFIN",
    "JSWENERGY",
    "JSWSTEEL",
    "JUBLFOOD",
    "KALYANKJIL",
    "KEI",
    "KOTAKBANK",
    "KPITTECH",
    "LAURUSLABS",
    "LENSKART",
    "LGEINDIA",
    "LICHSGFIN",
    "LODHA",
    "LT",
    "LTF",
    "LTM",
    "LUPIN",
    "M&M",
    "M&MFIN",
    "MANKIND",
    "MARICO",
    "MARUTI",
    "MAXHEALTH",
    "MAZDOCK",
    "MCX",
    "MFSL",
    "MOTHERSON",
    "MOTILALOFS",
    "MPHASIS",
    "MRF",
    "MUTHOOTFIN",
    "NATIONALUM",
    "NAUKRI",
    "NESTLEIND",
    "NHPC",
    "NMDC",
    "NTPC",
    "NYKAA",
    "OBEROIRLTY",
    "OFSS",
    "OIL",
    "ONGC",
    "PAGEIND",
    "PATANJALI",
    "PAYTM",
    "PERSISTENT",
    "PFC",
    "PHOENIXLTD",
    "PIDILITIND",
    "PIIND",
    "PNB",
    "POLICYBZR",
    "POLYCAB",
    "POWERGRID",
    "POWERINDIA",
    "PREMIERENE",
    "PRESTIGE",
    "RADICO",
    "RECLTD",
    "RELIANCE",
    "RVNL",
    "SAIL",
    "SBICARD",
    "SBILIFE",
    "SBIN",
    "SHREECEM",
    "SHRIRAMFIN",
    "SIEMENS",
    "SOLARINDS",
    "SRF",
    "SUNPHARMA",
    "SUPREMEIND",
    "SUZLON",
    "SWIGGY",
    "TATACAP",
    "TATACOMM",
    "TATACONSUM",
    "TATAELXSI",
    "TATAINVEST",
    "TATAPOWER",
    "TATASTEEL",
    "TCS",
    "TECHM",
    "TIINDIA",
    "TITAN",
    "TMCV",
    "TMPV",
    "TORNTPHARM",
    "TRENT",
    "TVSMOTOR",
    "ULTRACEMCO",
    "UNIONBANK",
    "UNITDSPR",
    "UPL",
    "VBL",
    "VEDL",
    "VMM",
    "VOLTAS",
    "WAAREEENER",
    "WIPRO",
    "YESBANK",
    "ZYDUSLIFE",
  ],
  "NIFTY 500": [
    "NIFTY_500",
    "360ONE",
    "3MINDIA",
    "AADHARHFC",
    "AARTIIND",
    "AAVAS",
    "ABB",
    "ABBOTINDIA",
    "ABCAPITAL",
    "ABDL",
    "ABFRL",
    "ABLBL",
    "ABREL",
    "ABSLAMC",
    "ACC",
    "ACE",
    "ACMESOLAR",
    "ACUTAAS",
    "ADANIENSOL",
    "ADANIENT",
    "ADANIGREEN",
    "ADANIPORTS",
    "ADANIPOWER",
    "AEGISLOG",
    "AEGISVOPAK",
    "AFCONS",
    "AFFLE",
    "AIAENG",
    "AIIL",
    "AJANTPHARM",
    "ALKEM",
    "AMBER",
    "AMBUJACEM",
    "ANANDRATHI",
    "ANANTRAJ",
    "ANGELONE",
    "ANTHEM",
    "ANURAS",
    "APARINDS",
    "APLAPOLLO",
    "APOLLOHOSP",
    "APOLLOTYRE",
    "APTUS",
    "ARE&M",
    "ASAHIINDIA",
    "ASHOKLEY",
    "ASIANPAINT",
    "ASTERDM",
    "ASTRAL",
    "ATGL",
    "ATHERENERG",
    "ATUL",
    "AUBANK",
    "AUROPHARMA",
    "AWL",
    "AXISBANK",
    "BAJAJ-AUTO",
    "BAJAJFINSV",
    "BAJAJHFL",
    "BAJAJHLDNG",
    "BAJFINANCE",
    "BALKRISIND",
    "BALRAMCHIN",
    "BANDHANBNK",
    "BANKBARODA",
    "BANKINDIA",
    "BATAINDIA",
    "BAYERCROP",
    "BBTC",
    "BDL",
    "BEL",
    "BELRISE",
    "BEML",
    "BERGEPAINT",
    "BHARATFORG",
    "BHARTIARTL",
    "BHARTIHEXA",
    "BHEL",
    "BIKAJI",
    "BIOCON",
    "BLS",
    "BLUEDART",
    "BLUEJET",
    "BLUESTARCO",
    "BOSCHLTD",
    "BPCL",
    "BRIGADE",
    "BRITANNIA",
    "BSE",
    "BSOFT",
    "CAMS",
    "CANBK",
    "CANFINHOME",
    "CANHLIFE",
    "CAPLIPOINT",
    "CARBORUNIV",
    "CARTRADE",
    "CASTROLIND",
    "CCL",
    "CDSL",
    "CEATLTD",
    "CEMPRO",
    "CENTRALBK",
    "CESC",
    "CGCL",
    "CGPOWER",
    "CHALET",
    "CHAMBLFERT",
    "CHENNPETRO",
    "CHOICEIN",
    "CHOLAFIN",
    "CHOLAHLDNG",
    "CIEINDIA",
    "CIPLA",
    "CLEAN",
    "COALINDIA",
    "COCHINSHIP",
    "COFORGE",
    "COHANCE",
    "COLPAL",
    "CONCOR",
    "CONCORDBIO",
    "COROMANDEL",
    "CPPLUS",
    "CRAFTSMAN",
    "CREDITACC",
    "CRISIL",
    "CROMPTON",
    "CUB",
    "CUMMINSIND",
    "CYIENT",
    "DABUR",
    "DALBHARAT",
    "DATAPATTNS",
    "DCMSHRIRAM",
    "DEEPAKFERT",
    "DEEPAKNTR",
    "DELHIVERY",
    "DEVYANI",
    "DIVISLAB",
    "DIXON",
    "DLF",
    "DMART",
    "DOMS",
    "DRREDDY",
    "ECLERX",
    "EICHERMOT",
    "EIDPARRY",
    "EIHOTEL",
    "ELECON",
    "ELGIEQUIP",
    "EMAMILTD",
    "EMCURE",
    "EMMVEE",
    "ENDURANCE",
    "ENGINERSIN",
    "ENRIN",
    "ERIS",
    "ESCORTS",
    "ETERNAL",
    "EXIDEIND",
    "FACT",
    "FEDERALBNK",
    "FINCABLES",
    "FIRSTCRY",
    "FIVESTAR",
    "FLUOROCHEM",
    "FORCEMOT",
    "FORTIS",
    "FSL",
    "GABRIEL",
    "GAIL",
    "GALLANTT",
    "GESHIP",
    "GICRE",
    "GILLETTE",
    "GLAND",
    "GLAXO",
    "GLENMARK",
    "GMDCLTD",
    "GMRAIRPORT",
    "GODFRYPHLP",
    "GODIGIT",
    "GODREJCP",
    "GODREJIND",
    "GODREJPROP",
    "GPIL",
    "GRANULES",
    "GRAPHITE",
    "GRASIM",
    "GRAVITA",
    "GROWW",
    "GRSE",
    "GVT&D",
    "HAL",
    "HAVELLS",
    "HBLENGINE",
    "HCLTECH",
    "HDBFS",
    "HDFCAMC",
    "HDFCBANK",
    "HDFCLIFE",
    "HEG",
    "HEROMOTOCO",
    "HEXT",
    "HFCL",
    "HINDALCO",
    "HINDCOPPER",
    "HINDPETRO",
    "HINDUNILVR",
    "HINDZINC",
    "HOMEFIRST",
    "HONASA",
    "HONAUT",
    "HSCL",
    "HUDCO",
    "HYUNDAI",
    "ICICIAMC",
    "ICICIBANK",
    "ICICIGI",
    "ICICIPRULI",
    "IDBI",
    "IDEA",
    "IDFCFIRSTB",
    "IEX",
    "IFCI",
    "IGIL",
    "IGL",
    "IIFL",
    "IKS",
    "INDGN",
    "INDHOTEL",
    "INDIACEM",
    "INDIAMART",
    "INDIANB",
    "INDIGO",
    "INDUSINDBK",
    "INDUSTOWER",
    "INFY",
    "INOXWIND",
    "INTELLECT",
    "IOB",
    "IOC",
    "IPCALAB",
    "IRB",
    "IRCON",
    "IRCTC",
    "IREDA",
    "IRFC",
    "ITC",
    "ITCHOTELS",
    "ITI",
    "J&KBANK",
    "JAINREC",
    "JBCHEPHARM",
    "JBMA",
    "JINDALSAW",
    "JINDALSTEL",
    "JIOFIN",
    "JKCEMENT",
    "JKTYRE",
    "JMFINANCIL",
    "JPPOWER",
    "JSL",
    "JSWCEMENT",
    "JSWDULUX",
    "JSWENERGY",
    "JSWINFRA",
    "JSWSTEEL",
    "JUBLFOOD",
    "JUBLINGREA",
    "JUBLPHARMA",
    "JWL",
    "JYOTICNC",
    "KAJARIACER",
    "KALYANKJIL",
    "KARURVYSYA",
    "KAYNES",
    "KEC",
    "KEI",
    "KFINTECH",
    "KIMS",
    "KIRLOSENG",
    "KOTAKBANK",
    "KPIL",
    "KPITTECH",
    "KPRMILL",
    "LALPATHLAB",
    "LATENTVIEW",
    "LAURUSLABS",
    "LEMONTREE",
    "LENSKART",
    "LGEINDIA",
    "LICHSGFIN",
    "LICI",
    "LINDEINDIA",
    "LLOYDSME",
    "LODHA",
    "LT",
    "LTF",
    "LTFOODS",
    "LTM",
    "LTTS",
    "LUPIN",
    "M&M",
    "M&MFIN",
    "MAHABANK",
    "MANAPPURAM",
    "MANKIND",
    "MAPMYINDIA",
    "MARICO",
    "MARUTI",
    "MAXHEALTH",
    "MAZDOCK",
    "MCX",
    "MEDANTA",
    "MEESHO",
    "MFSL",
    "MGL",
    "MINDACORP",
    "MMTC",
    "MOTHERSON",
    "MOTILALOFS",
    "MPHASIS",
    "MRF",
    "MRPL",
    "MSUMI",
    "MUTHOOTFIN",
    "NAM-INDIA",
    "NATCOPHARM",
    "NATIONALUM",
    "NAUKRI",
    "NAVA",
    "NAVINFLUOR",
    "NBCC",
    "NCC",
    "NESTLEIND",
    "NETWEB",
    "NEULANDLAB",
    "NEWGEN",
    "NH",
    "NHPC",
    "NIACL",
    "NIVABUPA",
    "NLCINDIA",
    "NMDC",
    "NSLNISP",
    "NTPC",
    "NTPCGREEN",
    "NUVAMA",
    "NUVOCO",
    "NYKAA",
    "OBEROIRLTY",
    "OFSS",
    "OIL",
    "OLAELEC",
    "OLECTRA",
    "ONESOURCE",
    "ONGC",
    "PAGEIND",
    "PARADEEP",
    "PATANJALI",
    "PAYTM",
    "PCBL",
    "PERSISTENT",
    "PETRONET",
    "PFC",
    "PFIZER",
    "PGEL",
    "PHOENIXLTD",
    "PIDILITIND",
    "PIIND",
    "PINELABS",
    "PIRAMALFIN",
    "PNB",
    "PNBHOUSING",
    "POLICYBZR",
    "POLYCAB",
    "POLYMED",
    "POONAWALLA",
    "POWERGRID",
    "POWERINDIA",
    "PPLPHARMA",
    "PREMIERENE",
    "PRESTIGE",
    "PTCIL",
    "PVRINOX",
    "PWL",
    "RADICO",
    "RAILTEL",
    "RAINBOW",
    "RAMCOCEM",
    "RBLBANK",
    "RECLTD",
    "REDINGTON",
    "RELIANCE",
    "RHIM",
    "RITES",
    "RKFORGE",
    "RPOWER",
    "RRKABEL",
    "RVNL",
    "SAGILITY",
    "SAIL",
    "SAILIFE",
    "SAMMAANCAP",
    "SAPPHIRE",
    "SARDAEN",
    "SAREGAMA",
    "SBFC",
    "SBICARD",
    "SBILIFE",
    "SBIN",
    "SCHAEFFLER",
    "SCHNEIDER",
    "SCI",
    "SHREECEM",
    "SHRIRAMFIN",
    "SHYAMMETL",
    "SIEMENS",
    "SIGNATURE",
    "SJVN",
    "SOBHA",
    "SOLARINDS",
    "SONACOMS",
    "SONATSOFTW",
    "SPLPETRO",
    "SRF",
    "STARHEALTH",
    "SUMICHEM",
    "SUNDARMFIN",
    "SUNPHARMA",
    "SUNTV",
    "SUPREMEIND",
    "SUZLON",
    "SWANCORP",
    "SWIGGY",
    "SYNGENE",
    "SYRMA",
    "TARIL",
    "TATACAP",
    "TATACHEM",
    "TATACOMM",
    "TATACONSUM",
    "TATAELXSI",
    "TATAINVEST",
    "TATAPOWER",
    "TATASTEEL",
    "TATATECH",
    "TBOTEK",
    "TCS",
    "TECHM",
    "TECHNOE",
    "TEGA",
    "TEJASNET",
    "TENNIND",
    "THELEELA",
    "THERMAX",
    "TIINDIA",
    "TIMKEN",
    "TITAGARH",
    "TITAN",
    "TMCV",
    "TMPV",
    "TORNTPHARM",
    "TORNTPOWER",
    "TRAVELFOOD",
    "TRENT",
    "TRIDENT",
    "TRITURBINE",
    "TTML",
    "TVSMOTOR",
    "UBL",
    "UCOBANK",
    "ULTRACEMCO",
    "UNIONBANK",
    "UNITDSPR",
    "UNOMINDA",
    "UPL",
    "URBANCO",
    "USHAMART",
    "UTIAMC",
    "VBL",
    "VEDL",
    "VIJAYA",
    "VMM",
    "VOLTAS",
    "VTL",
    "WAAREEENER",
    "WELCORP",
    "WELSPUNLIV",
    "WHIRLPOOL",
    "WIPRO",
    "WOCKPHARMA",
    "YESBANK",
    "ZEEL",
    "ZENSARTECH",
    "ZENTEC",
    "ZFCVINDIA",
    "ZYDUSLIFE",
    "ZYDUSWELL",
  ],
  "NIFTY MIDCAP 50": [
    "NIFTY_MIDCAP_50",
    "ALKEM",
    "APLAPOLLO",
    "ASHOKLEY",
    "AUBANK",
    "AUROPHARMA",
    "BHARATFORG",
    "BHEL",
    "BSE",
    "COFORGE",
    "COLPAL",
    "DABUR",
    "DIXON",
    "FEDERALBNK",
    "FORTIS",
    "GMRAIRPORT",
    "GODREJPROP",
    "HAVELLS",
    "HEROMOTOCO",
    "HINDPETRO",
    "ICICIGI",
    "IDFCFIRSTB",
    "INDUSINDBK",
    "INDUSTOWER",
    "LAURUSLABS",
    "LUPIN",
    "MANKIND",
    "MARICO",
    "MCX",
    "MFSL",
    "MPHASIS",
    "NAUKRI",
    "NHPC",
    "NMDC",
    "NYKAA",
    "OIL",
    "PAYTM",
    "PERSISTENT",
    "PHOENIXLTD",
    "POLICYBZR",
    "POLYCAB",
    "PRESTIGE",
    "SBICARD",
    "SRF",
    "SUPREMEIND",
    "SUZLON",
    "SWIGGY",
    "TIINDIA",
    "UPL",
    "WAAREEENER",
    "YESBANK",
  ],
  "NIFTY MIDCAP 100": [
    "NIFTY_MIDCAP_100",
    "360ONE",
    "ABCAPITAL",
    "ALKEM",
    "APLAPOLLO",
    "ASHOKLEY",
    "ASTRAL",
    "ATGL",
    "AUBANK",
    "AUROPHARMA",
    "BANKINDIA",
    "BDL",
    "BHARATFORG",
    "BHEL",
    "BIOCON",
    "BLUESTARCO",
    "BSE",
    "COCHINSHIP",
    "COFORGE",
    "COLPAL",
    "CONCOR",
    "COROMANDEL",
    "DABUR",
    "DIXON",
    "EXIDEIND",
    "FEDERALBNK",
    "FORTIS",
    "GLENMARK",
    "GMRAIRPORT",
    "GODFRYPHLP",
    "GODREJPROP",
    "GROWW",
    "GVT&D",
    "HAVELLS",
    "HEROMOTOCO",
    "HINDPETRO",
    "HUDCO",
    "ICICIAMC",
    "ICICIGI",
    "IDEA",
    "IDFCFIRSTB",
    "INDIANB",
    "INDUSINDBK",
    "INDUSTOWER",
    "IRCTC",
    "IREDA",
    "JSWENERGY",
    "JUBLFOOD",
    "KALYANKJIL",
    "KEI",
    "KPITTECH",
    "LAURUSLABS",
    "LENSKART",
    "LGEINDIA",
    "LICHSGFIN",
    "LTF",
    "LUPIN",
    "M&MFIN",
    "MANKIND",
    "MARICO",
    "MCX",
    "MFSL",
    "MOTILALOFS",
    "MPHASIS",
    "MRF",
    "NATIONALUM",
    "NAUKRI",
    "NHPC",
    "NMDC",
    "NYKAA",
    "OBEROIRLTY",
    "OFSS",
    "OIL",
    "PAGEIND",
    "PATANJALI",
    "PAYTM",
    "PERSISTENT",
    "PHOENIXLTD",
    "PIIND",
    "POLICYBZR",
    "POLYCAB",
    "POWERINDIA",
    "PREMIERENE",
    "PRESTIGE",
    "RADICO",
    "RVNL",
    "SAIL",
    "SBICARD",
    "SRF",
    "SUPREMEIND",
    "SUZLON",
    "SWIGGY",
    "TATACOMM",
    "TATAELXSI",
    "TATAINVEST",
    "TIINDIA",
    "UPL",
    "VMM",
    "VOLTAS",
    "WAAREEENER",
    "YESBANK",
  ],
  "NIFTY SMALLCAP 50": [
    "NIFTY_SMALLCAP_50",
    "AEGISLOG",
    "AFFLE",
    "AMBER",
    "ANANDRATHI",
    "ANGELONE",
    "ARE&M",
    "ASTERDM",
    "BANDHANBNK",
    "CAMS",
    "CASTROLIND",
    "CDSL",
    "CESC",
    "CHOLAHLDNG",
    "COHANCE",
    "CROMPTON",
    "CUB",
    "DELHIVERY",
    "FIVESTAR",
    "GLAND",
    "HINDCOPPER",
    "HSCL",
    "IGL",
    "IIFL",
    "INOXWIND",
    "KARURVYSYA",
    "KAYNES",
    "KEC",
    "KFINTECH",
    "LALPATHLAB",
    "MANAPPURAM",
    "NATCOPHARM",
    "NAVINFLUOR",
    "NBCC",
    "NEULANDLAB",
    "NH",
    "PGEL",
    "PIRAMALFIN",
    "PNBHOUSING",
    "POONAWALLA",
    "PPLPHARMA",
    "RBLBANK",
    "REDINGTON",
    "RPOWER",
    "SAILIFE",
    "SONACOMS",
    "SYNGENE",
    "TATACHEM",
    "TATATECH",
    "WELCORP",
    "WOCKPHARMA",
  ],
  "NIFTY SMALLCAP 100": [
    "NIFTY_SMALLCAP_100",
    "AARTIIND",
    "ABREL",
    "AEGISLOG",
    "AFCONS",
    "AFFLE",
    "AMBER",
    "ANANDRATHI",
    "ANANTRAJ",
    "ANGELONE",
    "APTUS",
    "ARE&M",
    "ASTERDM",
    "ATHERENERG",
    "BANDHANBNK",
    "BEML",
    "BLS",
    "BRIGADE",
    "CAMS",
    "CASTROLIND",
    "CDSL",
    "CESC",
    "CGCL",
    "CHAMBLFERT",
    "CHOLAHLDNG",
    "COHANCE",
    "CREDITACC",
    "CROMPTON",
    "CUB",
    "DATAPATTNS",
    "DEEPAKFERT",
    "DELHIVERY",
    "DEVYANI",
    "FIRSTCRY",
    "FIVESTAR",
    "FORCEMOT",
    "FSL",
    "GESHIP",
    "GLAND",
    "GMDCLTD",
    "GPIL",
    "GRSE",
    "HBLENGINE",
    "HINDCOPPER",
    "HSCL",
    "IDBI",
    "IFCI",
    "IGL",
    "IIFL",
    "IKS",
    "INOXWIND",
    "IRCON",
    "ITI",
    "JBMA",
    "JMFINANCIL",
    "JSWCEMENT",
    "JYOTICNC",
    "KARURVYSYA",
    "KAYNES",
    "KEC",
    "KFINTECH",
    "LALPATHLAB",
    "MANAPPURAM",
    "MEESHO",
    "MRPL",
    "NATCOPHARM",
    "NAVINFLUOR",
    "NBCC",
    "NETWEB",
    "NEULANDLAB",
    "NH",
    "NUVAMA",
    "OLAELEC",
    "PGEL",
    "PINELABS",
    "PIRAMALFIN",
    "PNBHOUSING",
    "POONAWALLA",
    "PPLPHARMA",
    "PWL",
    "RAMCOCEM",
    "RBLBANK",
    "REDINGTON",
    "RPOWER",
    "SAGILITY",
    "SAILIFE",
    "SARDAEN",
    "SIGNATURE",
    "SONACOMS",
    "STARHEALTH",
    "SWANCORP",
    "SYNGENE",
    "TATACHEM",
    "TATATECH",
    "TENNIND",
    "TRITURBINE",
    "URBANCO",
    "WELCORP",
    "WHIRLPOOL",
    "WOCKPHARMA",
    "ZENSARTECH",
  ],
  "NIFTY MIDSMALLCAP 400": [
    "NIFTY_MIDSMALL_400",
    "360ONE",
    "3MINDIA",
    "AADHARHFC",
    "AARTIIND",
    "AAVAS",
    "ABBOTINDIA",
    "ABCAPITAL",
    "ABDL",
    "ABFRL",
    "ABLBL",
    "ABREL",
    "ABSLAMC",
    "ACC",
    "ACE",
    "ACMESOLAR",
    "ACUTAAS",
    "AEGISLOG",
    "AEGISVOPAK",
    "AFCONS",
    "AFFLE",
    "AIAENG",
    "AIIL",
    "AJANTPHARM",
    "ALKEM",
    "AMBER",
    "ANANDRATHI",
    "ANANTRAJ",
    "ANGELONE",
    "ANTHEM",
    "ANURAS",
    "APARINDS",
    "APLAPOLLO",
    "APOLLOTYRE",
    "APTUS",
    "ARE&M",
    "ASAHIINDIA",
    "ASHOKLEY",
    "ASTERDM",
    "ASTRAL",
    "ATGL",
    "ATHERENERG",
    "ATUL",
    "AUBANK",
    "AUROPHARMA",
    "AWL",
    "BAJAJHFL",
    "BALKRISIND",
    "BALRAMCHIN",
    "BANDHANBNK",
    "BANKINDIA",
    "BATAINDIA",
    "BAYERCROP",
    "BBTC",
    "BDL",
    "BELRISE",
    "BEML",
    "BERGEPAINT",
    "BHARATFORG",
    "BHARTIHEXA",
    "BHEL",
    "BIKAJI",
    "BIOCON",
    "BLS",
    "BLUEDART",
    "BLUEJET",
    "BLUESTARCO",
    "BRIGADE",
    "BSE",
    "BSOFT",
    "CAMS",
    "CANFINHOME",
    "CANHLIFE",
    "CAPLIPOINT",
    "CARBORUNIV",
    "CARTRADE",
    "CASTROLIND",
    "CCL",
    "CDSL",
    "CEATLTD",
    "CEMPRO",
    "CENTRALBK",
    "CESC",
    "CGCL",
    "CHALET",
    "CHAMBLFERT",
    "CHENNPETRO",
    "CHOICEIN",
    "CHOLAHLDNG",
    "CIEINDIA",
    "CLEAN",
    "COCHINSHIP",
    "COFORGE",
    "COHANCE",
    "COLPAL",
    "CONCOR",
    "CONCORDBIO",
    "COROMANDEL",
    "CPPLUS",
    "CRAFTSMAN",
    "CREDITACC",
    "CRISIL",
    "CROMPTON",
    "CUB",
    "CYIENT",
    "DABUR",
    "DALBHARAT",
    "DATAPATTNS",
    "DCMSHRIRAM",
    "DEEPAKFERT",
    "DEEPAKNTR",
    "DELHIVERY",
    "DEVYANI",
    "DIXON",
    "DOMS",
    "ECLERX",
    "EIDPARRY",
    "EIHOTEL",
    "ELECON",
    "ELGIEQUIP",
    "EMAMILTD",
    "EMCURE",
    "EMMVEE",
    "ENDURANCE",
    "ENGINERSIN",
    "ERIS",
    "ESCORTS",
    "EXIDEIND",
    "FACT",
    "FEDERALBNK",
    "FINCABLES",
    "FIRSTCRY",
    "FIVESTAR",
    "FLUOROCHEM",
    "FORCEMOT",
    "FORTIS",
    "FSL",
    "GABRIEL",
    "GALLANTT",
    "GESHIP",
    "GICRE",
    "GILLETTE",
    "GLAND",
    "GLAXO",
    "GLENMARK",
    "GMDCLTD",
    "GMRAIRPORT",
    "GODFRYPHLP",
    "GODIGIT",
    "GODREJIND",
    "GODREJPROP",
    "GPIL",
    "GRANULES",
    "GRAPHITE",
    "GRAVITA",
    "GROWW",
    "GRSE",
    "GVT&D",
    "HAVELLS",
    "HBLENGINE",
    "HDBFS",
    "HEG",
    "HEROMOTOCO",
    "HEXT",
    "HFCL",
    "HINDCOPPER",
    "HINDPETRO",
    "HOMEFIRST",
    "HONASA",
    "HONAUT",
    "HSCL",
    "HUDCO",
    "ICICIAMC",
    "ICICIGI",
    "ICICIPRULI",
    "IDBI",
    "IDEA",
    "IDFCFIRSTB",
    "IEX",
    "IFCI",
    "IGIL",
    "IGL",
    "IIFL",
    "IKS",
    "INDGN",
    "INDIACEM",
    "INDIAMART",
    "INDIANB",
    "INDUSINDBK",
    "INDUSTOWER",
    "INOXWIND",
    "INTELLECT",
    "IOB",
    "IPCALAB",
    "IRB",
    "IRCON",
    "IRCTC",
    "IREDA",
    "ITCHOTELS",
    "ITI",
    "J&KBANK",
    "JAINREC",
    "JBCHEPHARM",
    "JBMA",
    "JINDALSAW",
    "JKCEMENT",
    "JKTYRE",
    "JMFINANCIL",
    "JPPOWER",
    "JSL",
    "JSWCEMENT",
    "JSWDULUX",
    "JSWENERGY",
    "JSWINFRA",
    "JUBLFOOD",
    "JUBLINGREA",
    "JUBLPHARMA",
    "JWL",
    "JYOTICNC",
    "KAJARIACER",
    "KALYANKJIL",
    "KARURVYSYA",
    "KAYNES",
    "KEC",
    "KEI",
    "KFINTECH",
    "KIMS",
    "KIRLOSENG",
    "KPIL",
    "KPITTECH",
    "KPRMILL",
    "LALPATHLAB",
    "LATENTVIEW",
    "LAURUSLABS",
    "LEMONTREE",
    "LENSKART",
    "LGEINDIA",
    "LICHSGFIN",
    "LICI",
    "LINDEINDIA",
    "LLOYDSME",
    "LTF",
    "LTFOODS",
    "LTTS",
    "LUPIN",
    "M&MFIN",
    "MAHABANK",
    "MANAPPURAM",
    "MANKIND",
    "MAPMYINDIA",
    "MARICO",
    "MCX",
    "MEDANTA",
    "MEESHO",
    "MFSL",
    "MGL",
    "MINDACORP",
    "MMTC",
    "MOTILALOFS",
    "MPHASIS",
    "MRF",
    "MRPL",
    "MSUMI",
    "NAM-INDIA",
    "NATCOPHARM",
    "NATIONALUM",
    "NAUKRI",
    "NAVA",
    "NAVINFLUOR",
    "NBCC",
    "NCC",
    "NETWEB",
    "NEULANDLAB",
    "NEWGEN",
    "NH",
    "NHPC",
    "NIACL",
    "NIVABUPA",
    "NLCINDIA",
    "NMDC",
    "NSLNISP",
    "NTPCGREEN",
    "NUVAMA",
    "NUVOCO",
    "NYKAA",
    "OBEROIRLTY",
    "OFSS",
    "OIL",
    "OLAELEC",
    "OLECTRA",
    "ONESOURCE",
    "PAGEIND",
    "PARADEEP",
    "PATANJALI",
    "PAYTM",
    "PCBL",
    "PERSISTENT",
    "PETRONET",
    "PFIZER",
    "PGEL",
    "PHOENIXLTD",
    "PIIND",
    "PINELABS",
    "PIRAMALFIN",
    "PNBHOUSING",
    "POLICYBZR",
    "POLYCAB",
    "POLYMED",
    "POONAWALLA",
    "POWERINDIA",
    "PPLPHARMA",
    "PREMIERENE",
    "PRESTIGE",
    "PTCIL",
    "PVRINOX",
    "PWL",
    "RADICO",
    "RAILTEL",
    "RAINBOW",
    "RAMCOCEM",
    "RBLBANK",
    "REDINGTON",
    "RHIM",
    "RITES",
    "RKFORGE",
    "RPOWER",
    "RRKABEL",
    "RVNL",
    "SAGILITY",
    "SAIL",
    "SAILIFE",
    "SAMMAANCAP",
    "SAPPHIRE",
    "SARDAEN",
    "SAREGAMA",
    "SBFC",
    "SBICARD",
    "SCHAEFFLER",
    "SCHNEIDER",
    "SCI",
    "SHYAMMETL",
    "SIGNATURE",
    "SJVN",
    "SOBHA",
    "SONACOMS",
    "SONATSOFTW",
    "SPLPETRO",
    "SRF",
    "STARHEALTH",
    "SUMICHEM",
    "SUNDARMFIN",
    "SUNTV",
    "SUPREMEIND",
    "SUZLON",
    "SWANCORP",
    "SWIGGY",
    "SYNGENE",
    "SYRMA",
    "TARIL",
    "TATACHEM",
    "TATACOMM",
    "TATAELXSI",
    "TATAINVEST",
    "TATATECH",
    "TBOTEK",
    "TECHNOE",
    "TEGA",
    "TEJASNET",
    "TENNIND",
    "THELEELA",
    "THERMAX",
    "TIINDIA",
    "TIMKEN",
    "TITAGARH",
    "TORNTPOWER",
    "TRAVELFOOD",
    "TRIDENT",
    "TRITURBINE",
    "TTML",
    "UBL",
    "UCOBANK",
    "UNOMINDA",
    "UPL",
    "URBANCO",
    "USHAMART",
    "UTIAMC",
    "VIJAYA",
    "VMM",
    "VOLTAS",
    "VTL",
    "WAAREEENER",
    "WELCORP",
    "WELSPUNLIV",
    "WHIRLPOOL",
    "WOCKPHARMA",
    "YESBANK",
    "ZEEL",
    "ZENSARTECH",
    "ZENTEC",
    "ZFCVINDIA",
    "ZYDUSWELL",
  ],
  "MCX_ICOMDEX": [
    "MCX_ICOMDEX",
    "BULLDEX_MCX",
    "METLDEX_MCX"
  ],
  "BULLION": [
    "BULLION",
    "GOLD_MCX",
    "GOLDMINI_MCX",
    "GOLD10_MCX",
    "GOLDGUINEA_MCX",
    "GOLDPETAL_MCX",
    "SILVER_MCX",
    "SILVERMINI_MCX",
    "SILVERMICRO_MCX",
    "SILVER100_MCX",
    "GC=F",
    "SI=F"
  ],
  "BASE_METALS": [
    "BASE_METALS",
    "ALUMINIUM_MCX",
    "ALUMINIUMMINI_MCX",
    "COPPER_MCX",
    "LEAD_MCX",
    "LEADMINI_MCX",
    "NICKEL_MCX",
    "STEELREBAR_MCX",
    "ZINC_MCX",
    "ZINCMINI_MCX",
    "HG=F",
    "ALI=F",
    "ZNC=F",
    "LED=F"
  ],
  "ENERGY": [
    "ENERGY",
    "CRUDEOIL_MCX",
    "CRUDEOILMINI_MCX",
    "ELECTRICITY_MCX",
    "NATURALGAS_MCX",
    "NATURALGASMINI_MCX",
    "CL=F",
    "NG=F"
  ],
  "AGRI": [
    "AGRI",
    "CARDAMOM_MCX",
    "COTTON_MCX",
    "COTTONSEEDWASHOIL_MCX",
    "CRUDEPALMOIL_MCX",
    "KAPAS_MCX",
    "MENTHAOIL_MCX"
  ],
  "FOREX": [
    "FOREX",
    "USDINR=X",
    "EURINR=X",
    "GBPINR=X",
    "JPYINR=X",
    "EURUSD=X",
    "GBPUSD=X",
    "USDJPY=X"
  ]
};

export default function ChartsPage() {
  return (
    <Suspense fallback={<div style={{padding: "2rem", color: "#94a3b8"}}>Loading charts...</div>}>
      <ChartsPageContent />
    </Suspense>
  );
}

// One-click indicator presets shown as tabs under the chart. Each applies a
// small, coherent set of indicators for a specific style of analysis.
const BOTTOM_TABS = [
  { id: "momentum",   label: "⚡ Momentum",      indicators: ["rsi", "macd"] },
  { id: "trend",      label: "📈 Trend",         indicators: ["supertrend", "adx"] },
  { id: "ma_bb",      label: "〰 MA + Bollinger", indicators: ["sma20", "bb"] },
  { id: "volume",     label: "📊 Volume Flow",   indicators: ["obv", "mfi"] },
  { id: "volatility", label: "🌪 Volatility",    indicators: ["bb", "atr"] },
  { id: "sr",         label: "📏 S/R Levels",    indicators: ["sr_levels", "sma200"] },
  { id: "stoch",      label: "🎯 Stochastic",    indicators: ["stoch", "williams"] },
  { id: "candles",    label: "🕯 Candle Patterns", indicators: ["pattern_hammer", "pattern_doji", "pattern_engulfing"] },
  { id: "vwap",       label: "⚖ VWAP",           indicators: ["vwap", "cci"] },
  { id: "trendlines", label: "📐 Trendlines",     indicators: ["auto_trendlines"] },
  { id: "clean",      label: "✨ Clean Chart",    indicators: [] },
];

function ChartsPageContent() {
  const chartRef = useRef(null);
  const chartWrapRef = useRef(null);
  const chartInstance = useRef(null);
  const seriesRefs = useRef({});
  const draggingPanel = useRef(null);
  const overlayRef = useRef(null);
  const legendRef = useRef(null);
  const searchParams = useSearchParams();

  const [symbol, setSymbol] = useState(searchParams.get("symbol")?.toUpperCase() || "RELIANCE");

  // Scan-results navigator: when a scanner's "View All on Charts" button sent us
  // here (?scanlist=1), load its symbol list and show prev/next controls.
  const [scanList, setScanList] = useState(null); // { label, symbols: [] }
  useEffect(() => {
    if (searchParams.get("scanlist") !== "1") return;
    try {
      const raw = localStorage.getItem("chartix_scan_list");
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d.symbols) && d.symbols.length) setScanList(d);
      }
    } catch (e) { /* no list — nothing to navigate */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const scanIdx = scanList ? scanList.symbols.indexOf(symbol) : -1;
  const scanGo = (d) => {
    if (!scanList) return;
    const i = Math.min(Math.max(scanIdx + d, 0), scanList.symbols.length - 1);
    const s = scanList.symbols[i];
    if (s && s !== symbol) setSymbol(s);
  };
  const dismissScanList = () => {
    setScanList(null);
    try { localStorage.removeItem("chartix_scan_list"); } catch (e) {}
  };

  const [instruments, setInstruments] = useState([]);
  const [chartData, setChartData] = useState([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartStyle, setChartStyle] = useState("candles");
  const [showStyleMenu, setShowStyleMenu] = useState(false);
  const [showTfMenu, setShowTfMenu] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [watchlistData, setWatchlistData] = useState([]);
  const [sidebarTab, setSidebarTab] = useState("sectors"); // "sectors" | "personal" | "holidays"
  const [myWatchlist, setMyWatchlist] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [holidaysLoading, setHolidaysLoading] = useState(false);
  const [holidaysSyncing, setHolidaysSyncing] = useState(false);
  const [headerSymbol, setHeaderSymbol] = useState(symbol);
  const [activePattern, setActivePattern] = useState(null);
  const patternFitRef = useRef(null);

  useEffect(() => {
    setHeaderSymbol(symbol);
  }, [symbol]);

  // Load the pattern to overlay, if the page was opened via a "Chart →" link
  useEffect(() => {
    const patternId = searchParams.get("pattern");
    if (!patternId) { setActivePattern(null); return; }
    api.getPattern(patternId)
      .then((p) => {
        setActivePattern(p);
        if (p && p.timeframe) {
          setActiveTimeframe(p.timeframe);
        }
      })
      .catch(() => setActivePattern(null));
  }, [searchParams]);

  // Close chart style dropdown when clicking outside
  useEffect(() => {
    if (!showStyleMenu) return;
    const handleClose = () => setShowStyleMenu(false);
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
  }, [showStyleMenu]);

  // Close timeframe dropdown when clicking outside
  useEffect(() => {
    if (!showTfMenu) return;
    const handleClose = () => setShowTfMenu(false);
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
  }, [showTfMenu]);
  const [activeTimeframe, setActiveTimeframe] = useState(() => {
    const tf = searchParams?.get("timeframe") || searchParams?.get("tf") || "D";
    const upperTf = tf.toUpperCase();
    return ["D", "W", "M"].includes(upperTf) ? upperTf : "D";
  });
  const [subscription, setSubscription] = useState(null);
  const [premiumUpgradeMessage, setPremiumUpgradeMessage] = useState(null);

  useEffect(() => {
    // Use /subscription/status (best active tier via _best_live_tier), NOT
    // /subscription/ (latest raw record). The raw record can resolve to a
    // stale/lower tier, which wrongly blocked W/M for AI EOD Pro users even
    // though the sidebar — which already uses status — showed the right plan.
    api.getSubscriptionStatus().then(data => setSubscription(data)).catch(() => {});
  }, []);

  const handleTimeframeChange = (newTf) => {
    const tier = subscription?.tier?.toLowerCase() || "free";
    if (["free", "eod_basic"].includes(tier) && ["W", "M"].includes(newTf)) {
      setPremiumUpgradeMessage("Weekly and Monthly timeframes are only available on the EOD Pro plan. Please upgrade your plan.");
      return;
    }
    setActiveTimeframe(newTf);
  };

  useEffect(() => {
    const tf = searchParams.get("timeframe") || searchParams.get("tf");
    if (tf) {
      const upperTf = tf.toUpperCase();
      if (["D", "W", "M"].includes(upperTf)) {
        setActiveTimeframe(upperTf);
      }
    }
  }, [searchParams]);

  const [drawingMode, setDrawingMode] = useState(null);
  const [userDrawings, setUserDrawings] = useState([]);
  const drawState = useRef({ step: 0, p1: null, p2: null, tempSeries: [] });

  // Double-click tool menu
  const [toolMenu, setToolMenu] = useState(null); // {x, y} screen coords
  const [activeTool, setActiveTool] = useState(null); // selected tool name
  const [drawings, setDrawings] = useState([]); // [{id,type,x1,y1,x2,y2,color,text,selected}]
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [drawStep, setDrawStep] = useState(0);
  const [tempStart, setTempStart] = useState(null);
  const [tempEnd, setTempEnd] = useState(null);
  const nextId = useRef(1);
  const lastFetched = useRef({ symbol: "", timeframe: "" });
  const eodCacheRef = useRef(new Map()); // symbol → { data, t } session cache

  // ── Persist drawings PER USER, PER SYMBOL (server + local cache) ──
  // Trendlines, support/resistance and annotations belong to a specific stock,
  // so they're keyed by symbol. Only this user can see or change their own.
  const drawingsSymRef = useRef(null);
  const drawingsReady = useRef(false);
  const drawSaveTimer = useRef(null);

  useEffect(() => {
    if (!symbol) return;
    drawingsReady.current = false;   // saving disabled until a load succeeds
    drawingsSymRef.current = symbol;
    // paint from local cache first
    try {
      const cached = localStorage.getItem(`chartix_drawings_${symbol}`);
      setDrawings(cached ? JSON.parse(cached) : []);
    } catch (e) { setDrawings([]); }
    // reconcile with the account copy, with retries. Saving only turns on after
    // a SUCCESSFUL load — a failed load can't wipe your saved drawings.
    (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await api.getPref(`drawings:${symbol}`);
          if (drawingsSymRef.current !== symbol) return; // user switched away
          if (res && Array.isArray(res.value)) {
            setDrawings(res.value);
            try { localStorage.setItem(`chartix_drawings_${symbol}`, JSON.stringify(res.value)); } catch (_) {}
          }
          skipNextDrawSave.current = true;               // don't re-save loaded data
          drawingsReady.current = true;
          return;
        } catch (e) {
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      // never reached server → leave saving OFF so stored drawings stay safe
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const skipNextDrawSave = useRef(false);
  useEffect(() => {
    if (!symbol || !drawingsReady.current) return;
    try { localStorage.setItem(`chartix_drawings_${symbol}`, JSON.stringify(drawings)); } catch (e) {}
    if (skipNextDrawSave.current) { skipNextDrawSave.current = false; return; }
    clearTimeout(drawSaveTimer.current);
    const sym = symbol;
    drawSaveTimer.current = setTimeout(() => {
      api.putPref(`drawings:${sym}`, drawings).catch(() =>
        api.putPref(`drawings:${sym}`, drawings).catch(() => {}));
    }, 700);
    return () => clearTimeout(drawSaveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawings, symbol]);

  const TOOLS = [
    { id: 'trendline',   icon: '╱',  label: 'Trend Line' },
    { id: 'hline',       icon: '—',  label: 'Horiz Line' },
    { id: 'vline',       icon: '|',  label: 'Vert Line' },
    { id: 'ray',         icon: '→',  label: 'Ray' },
    { id: 'rectangle',   icon: '▭',  label: 'Rectangle' },
    { id: 'channel',     icon: '⫢',  label: 'Channel' },
    { id: 'fibonacci',   icon: '≡',  label: 'Fibonacci' },
    { id: 'pitchfork',   icon: '⌥',  label: 'Pitchfork' },
    { id: 'arrow',       icon: '↗',  label: 'Arrow' },
    { id: 'text',        icon: 'T',  label: 'Text' },
    { id: 'circle',      icon: '○',  label: 'Circle' },
    { id: 'eraser',      icon: '✕',  label: 'Delete All' },
  ];

  // All available indicators for the menu
  const INDICATOR_GROUPS = [
    { group: 'Trend', items: [
      { id:'sma20',    label:'SMA 20',       color:'#f59e0b', panel:'main' },
      { id:'sma44',    label:'SMA 44',       color:'#ef4444', panel:'main' },
      { id:'sma50',    label:'SMA 50',       color:'#a78bfa', panel:'main' },
      { id:'sma200',   label:'SMA 200',      color:'#3b82f6', panel:'main' },
      { id:'ema9',     label:'EMA 9',        color:'#06b6d4', panel:'main' },
      { id:'ema20',    label:'EMA 20',       color:'#fb923c', panel:'main' },
      { id:'ema50',    label:'EMA 50',       color:'#c084fc', panel:'main' },
      { id:'supertrend', label:'SuperTrend', color:'#10b981', panel:'main' },
      { id:'psar',     label:'Parabolic SAR',color:'#f43f5e', panel:'main' },
      { id:'vwap',     label:'VWAP',         color:'#60a5fa', panel:'main' },
      { id:'sr_levels', label:'S&R Auto Levels', color:'#e879f9', panel:'main' },
      { id:'auto_trendlines', label:'Auto Trendlines', color:'#22d3ee', panel:'main' },
      { id:'ichimoku', label:'Ichimoku Cloud', color:'#2962ff', panel:'main' },
      { id:'alligator', label:'Williams Alligator', color:'#22d3ee', panel:'main' },
      { id:'ema_ribbon', label:'EMA Ribbon', color:'#a78bfa', panel:'main' },
    ]},
    { group: 'Volatility', items: [
      { id:'bb',       label:'Bollinger Bands', color:'#60a5fa', panel:'main' },
      { id:'keltner',  label:'Keltner Channel', color:'#14b8a6', panel:'main' },
      { id:'donchian', label:'Donchian Channel', color:'#f472b6', panel:'main' },
      { id:'atr',      label:'ATR (14)',      color:'#fb923c', panel:'sub' },
    ]},
    { group: 'Momentum', items: [
      { id:'rsi',      label:'RSI (14)',      color:'#a78bfa', panel:'sub' },
      { id:'macd',     label:'MACD',          color:'#60a5fa', panel:'sub' },
      { id:'stoch',    label:'Stochastic',    color:'#34d399', panel:'sub' },
      { id:'cci',      label:'CCI (20)',      color:'#f87171', panel:'sub' },
      { id:'williams', label:'Williams %R',   color:'#4ade80', panel:'sub' },
      { id:'mfi',      label:'Money Flow Index', color:'#c084fc', panel:'sub' },
      { id:'roc',      label:'Rate of Change', color:'#38bdf8', panel:'sub' },
      { id:'aroon',    label:'Aroon',          color:'#fbbf24', panel:'sub' },
      { id:'stochrsi', label:'Stochastic RSI', color:'#e879f9', panel:'sub' },
      { id:'trix',     label:'TRIX',           color:'#818cf8', panel:'sub' },
      { id:'uo',       label:'Ultimate Oscillator', color:'#fb7185', panel:'sub' },
      { id:'momentum', label:'Momentum',       color:'#5eead4', panel:'sub' },
      { id:'dpo',      label:'Detrended Price Osc', color:'#fdba74', panel:'sub' },
      { id:'ao',       label:'Awesome Oscillator', color:'#34d399', panel:'sub' },
      { id:'vortex',   label:'Vortex',         color:'#93c5fd', panel:'sub' },
    ]},
    { group: 'Volume', items: [
      { id:'obv',      label:'On-Balance Vol', color:'#38bdf8', panel:'sub' },
      { id:'adx',      label:'ADX (14)',      color:'#fbbf24', panel:'sub' },
      { id:'cmf',      label:'Chaikin Money Flow', color:'#4ade80', panel:'sub' },
      { id:'chaikin_osc', label:'Chaikin Oscillator', color:'#f0abfc', panel:'sub' },
      { id:'adl',      label:'Accum/Dist Line', color:'#7dd3fc', panel:'sub' },
      { id:'efi',      label:'Elder Force Index', color:'#fca5a5', panel:'sub' },
    ]},
    { group: 'Candlestick Patterns', items: [
      { id:'pattern_doji',      label:'Doji Pattern',      color:'#FF6600', panel:'main' },
      { id:'pattern_hammer',    label:'Hammer Pattern',    color:'#00AA00', panel:'main' },
      { id:'pattern_engulfing', label:'Engulfing Pattern', color:'#0000FF', panel:'main' },
    ]},
    { group: 'AI / Forecast', items: [
      { id:'forecast_lstm', label:'AI Forecast (LSTM)', color:'#22d3ee', panel:'main' },
    ]},
  ];

  const SIGNAL_LIST = [
    { id:'golden_cross', label:'Golden Cross (SMA50×200)', color:'#FFD700' },
    { id:'death_cross',  label:'Death Cross (SMA50×200)',  color:'#FF0000' },
    { id:'rsi_oversold', label:'RSI Oversold (<30)',        color:'#00AA00' },
    { id:'rsi_overbought',label:'RSI Overbought (>70)',    color:'#FF4400' },
    { id:'bb_squeeze',   label:'BB Squeeze Signal',        color:'#0088FF' },
    { id:'macd_cross',   label:'MACD Cross Signal',        color:'#AA00FF' },
    { id:'supertrend_buy',label:'SuperTrend Buy',          color:'#00CC44' },
    { id:'supertrend_sell',label:'SuperTrend Sell',        color:'#FF2200' },
    { id:'stoch_oversold', label:'Stoch Oversold (<20)',   color:'#00BB44' },
    { id:'stoch_overbought',label:'Stoch Overbought (>80)',color:'#FF5500' },
    { id:'vwap_cross',   label:'Price × VWAP Cross',       color:'#0044AA' },
    { id:'obv_divergence',label:'OBV Divergence',          color:'#8800AA' },
  ];

  const [activeIndicators, setActiveIndicators] = useState(DEFAULT_ACTIVE_INDICATORS); // rsi+macd enabled by default, can be toggled

  // Momentum / oscillator indicators live in their own sub-panels. Like
  // TradingView you can stack several (RSI + MACD + Stoch + …); the panes pack
  // tightly via stretch factors. A generous cap just prevents runaway stacking;
  // beyond it the oldest is evicted.
  const MOMENTUM_MAX = 6;
  const MOMENTUM_IDS = new Set([
    'rsi', 'macd', 'stoch', 'atr', 'cci', 'williams', 'obv', 'mfi', 'adx', 'roc',
    'aroon', 'stochrsi', 'trix', 'uo', 'momentum', 'dpo', 'ao', 'vortex', 'cmf',
    'chaikin_osc', 'adl', 'efi',
  ]);

  const handleToggleIndicator = (id) => {
    const isOn = activeIndicators.includes(id);
    if (!isOn && id === 'forecast_lstm') {
      const tier = subscription?.tier?.toLowerCase() || "free";
      if (!["ai_eod_pro", "intraday_pro"].includes(tier)) {
        setPremiumUpgradeMessage("AI Price Forecast (LSTM) is only available on the AI EOD Pro plan. Please upgrade your plan.");
        return;
      }
    }

    let next;
    if (isOn) {
      next = activeIndicators.filter(x => x !== id);
    } else {
      next = [...activeIndicators, id];
      // Safety cap: evict the oldest momentum indicator(s) past the limit.
      if (MOMENTUM_IDS.has(id)) {
        const active = next.filter(x => MOMENTUM_IDS.has(x));
        if (active.length > MOMENTUM_MAX) {
          const evict = new Set(active.slice(0, active.length - MOMENTUM_MAX));
          next = next.filter(x => !evict.has(x));
        }
      }
    }
    setActiveIndicators(next);
  };

  // Editable parameters for every indicator (period, multipliers, etc.)
  const DEFAULT_INDICATOR_PARAMS = {
    sma20:  { period: 20 },  sma44:  { period: 44 },
    sma50:  { period: 50 },  sma200: { period: 200 },
    ema9:   { period: 9 },   ema20:  { period: 20 },  ema50: { period: 50 },
    bb:     { period: 20, std: 2 },
    atr:    { period: 14 },
    rsi:    { period: 14 },
    macd:   { fast: 12, slow: 26, signal: 9 },
    stoch:  { k: 14, d: 3 },
    cci:    { period: 20 },
    williams: { period: 14 },
    mfi:    { period: 14 },
    adx:    { period: 14 },
    supertrend: { period: 10, mult: 3 },
    psar:   { step: 0.02, max: 0.2 },
    keltner:  { period: 20, mult: 2 },
    donchian: { period: 20 },
    roc:      { period: 12 },
    aroon:    { period: 25 },
    trix:     { period: 15 },
    uo:       { p1: 7, p2: 14, p3: 28 },
    cmf:      { period: 20 },
    chaikin_osc: { fast: 3, slow: 10 },
    vortex:   { period: 14 },
    momentum: { period: 10 },
    dpo:      { period: 20 },
    efi:      { period: 13 },
    stochrsi: { rsi: 14, stoch: 14, k: 3, d: 3 },
    ichimoku: { tenkan: 9, kijun: 26, senkou: 52 },
  };
  const [indicatorParams, setIndicatorParams] = useState(DEFAULT_INDICATOR_PARAMS);
  const [editingIndicator, setEditingIndicator] = useState(null); // indicator id being edited, or null
  const getParams = (id) => indicatorParams[id] || DEFAULT_INDICATOR_PARAMS[id] || {};

  // Per-indicator style overrides (color, line width)
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [indicatorStyles, setIndicatorStyles] = useState({});
  const getCol = (id, fallback) => indicatorStyles[id]?.color || fallback;
  const getW = (id, fallback) => indicatorStyles[id]?.width ?? fallback;
  const setIndicatorStyle = (id, key, value) => {
    setIndicatorStyles(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: value } }));
  };

  // Price scale mode: 0 = normal, 1 = logarithmic, 2 = percentage
  const [priceScaleMode, setPriceScaleMode] = useState(0);

  const rsiPeriod = getParams('rsi').period;
  const macdFast = getParams('macd').fast;
  const macdSlow = getParams('macd').slow;
  const macdSignal = getParams('macd').signal;
  const setIndicatorParam = (id, key, value) => {
    setIndicatorParams(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: value } }));
  };
  const [menuTab, setMenuTab] = useState('tools'); // 'tools' | 'indicators' | 'signals'
  const maLineIdRef = useRef(10);
  // Must be STATE (not a ref): with a ref, the save effect runs in the same
  // commit as the load effect — after the ref is already true but before the
  // loaded setState calls have applied — and clobbers saved prefs with the
  // defaults. Under React StrictMode's dev double-mount, the second mount then
  // re-loads those clobbered defaults, losing the user's settings on refresh.
  const [chartPrefsLoaded, setChartPrefsLoaded] = useState(false);

  // ── Named layouts (per account): save / rename / copy / load / delete ──
  // Stored under the user's prefs key "chart_layouts" as
  // { active: "My Layout", layouts: { name: {maLines, activeIndicators, …} } }
  const [layoutName, setLayoutName] = useState("Default");
  const [layoutNames, setLayoutNames] = useState([]);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [scansMenuOpen, setScansMenuOpen] = useState(false);
  const [layoutSavedTick, setLayoutSavedTick] = useState(false);
  const layoutsRef = useRef({ active: "Default", layouts: {} });

  const currentLayoutPayload = () => ({
    maLines, activeIndicators, indicatorParams, indicatorStyles, priceScaleMode,
  });

  const persistLayouts = async () => {
    try {
      await api.putPref("chart_layouts", layoutsRef.current);
      setLayoutSavedTick(true);
      setTimeout(() => setLayoutSavedTick(false), 1800);
    } catch (e) { alert("Could not save layout (server unreachable). Try again."); }
  };

  const saveLayout = async (name = layoutName) => {
    layoutsRef.current.layouts[name] = currentLayoutPayload();
    layoutsRef.current.active = name;
    setLayoutName(name);
    setLayoutNames(Object.keys(layoutsRef.current.layouts));
    await persistLayouts();
  };

  const saveLayoutAs = async () => {
    const name = (prompt("Save layout as:", layoutName + " copy") || "").trim();
    if (!name) return;
    await saveLayout(name);
  };

  const renameLayout = async () => {
    const name = (prompt("Rename layout to:", layoutName) || "").trim();
    if (!name || name === layoutName) return;
    layoutsRef.current.layouts[name] = layoutsRef.current.layouts[layoutName] || currentLayoutPayload();
    delete layoutsRef.current.layouts[layoutName];
    layoutsRef.current.active = name;
    setLayoutName(name);
    setLayoutNames(Object.keys(layoutsRef.current.layouts));
    await persistLayouts();
  };

  const loadLayout = (name) => {
    const p = layoutsRef.current.layouts[name];
    if (!p) return;
    applyLayout(p);
    layoutsRef.current.active = name;
    setLayoutName(name);
    setLayoutMenuOpen(false);
    persistLayouts();
  };

  const deleteLayout = async (name) => {
    if (!confirm(`Delete layout "${name}"?`)) return;
    delete layoutsRef.current.layouts[name];
    const remaining = Object.keys(layoutsRef.current.layouts);
    setLayoutNames(remaining);
    if (layoutName === name) {
      const next = remaining[0] || "Default";
      layoutsRef.current.active = next;
      setLayoutName(next);
      if (layoutsRef.current.layouts[next]) applyLayout(layoutsRef.current.layouts[next]);
    }
    await persistLayouts();
  };

  // Close the layout/scans menus on any outside click
  useEffect(() => {
    if (!layoutMenuOpen && !scansMenuOpen) return;
    const close = () => { setLayoutMenuOpen(false); setScansMenuOpen(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [layoutMenuOpen, scansMenuOpen]);

  // Load the user's named layouts once (after auth)
  useEffect(() => {
    (async () => {
      try {
        const res = await api.getPref("chart_layouts");
        if (res && res.value && res.value.layouts) {
          layoutsRef.current = res.value;
          setLayoutNames(Object.keys(res.value.layouts));
          if (res.value.active) setLayoutName(res.value.active);
        }
      } catch (e) { /* offline — layouts unavailable this session */ }
    })();
  }, []);
  const [maLines, setMALines] = useState(DEFAULT_MA_LINES);
  const chartDataRef = useRef([]); // for OHLC snap

  // ── Persist chart layout PER USER (server) with a localStorage fast-cache ──
  // localStorage gives an instant paint; the server copy makes the layout follow
  // the account across devices and browsers, and only this user can change it.
  const applyLayout = (prefs) => {
    if (!prefs) return;
    if (Array.isArray(prefs.maLines) && prefs.maLines.length) {
      setMALines(prefs.maLines);
      maLineIdRef.current = Math.max(10, ...prefs.maLines.map(m => m.id || 0));
    }
    if (Array.isArray(prefs.activeIndicators)) setActiveIndicators(prefs.activeIndicators);
    if (prefs.indicatorParams) setIndicatorParams(prev => ({ ...prev, ...prefs.indicatorParams }));
    if (prefs.indicatorStyles) setIndicatorStyles(prefs.indicatorStyles);
    if (typeof prefs.priceScaleMode === "number") setPriceScaleMode(prefs.priceScaleMode);
  };

  useEffect(() => {
    // 1) paint from the local cache immediately
    try {
      const cached = localStorage.getItem("chartix_chart_prefs");
      if (cached) applyLayout(JSON.parse(cached));
    } catch (e) { /* ignore */ }
    // 2) reconcile with the account copy — with RETRIES, because the tunnel is
    //    flaky. Saving is enabled ONLY after a successful load, so a failed
    //    load can never overwrite the stored layout with defaults.
    (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await api.getPref("chart_layout");
          if (res && res.value) {
            applyLayout(res.value);
            try { localStorage.setItem("chartix_chart_prefs", JSON.stringify(res.value)); } catch (_) {}
          }
          setChartPrefsLoaded(true); // success (value or confirmed-empty) → safe to save
          return;
        } catch (e) {
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      // Never reached the server after retries → DO NOT enable saving.
      // The stored layout stays intact; we just show the cached view.
    })();
  }, []);

  const layoutSaveTimer = useRef(null);
  const skipNextLayoutSave = useRef(true); // don't re-save the values we just loaded
  useEffect(() => {
    if (!chartPrefsLoaded) return; // only after a confirmed successful load
    const payload = { maLines, activeIndicators, indicatorParams, indicatorStyles, priceScaleMode };
    try { localStorage.setItem("chartix_chart_prefs", JSON.stringify(payload)); } catch (e) {}
    if (skipNextLayoutSave.current) { skipNextLayoutSave.current = false; return; }
    // debounce the server write so dragging a slider doesn't spam the API
    clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = setTimeout(() => {
      // retry once on transient failure so a tunnel blip doesn't lose the change
      api.putPref("chart_layout", payload).catch(() =>
        api.putPref("chart_layout", payload).catch(() => {}));
    }, 700);
    return () => clearTimeout(layoutSaveTimer.current);
  }, [chartPrefsLoaded, maLines, activeIndicators, indicatorParams, indicatorStyles, priceScaleMode]);

  // Flush any pending layout save when leaving the page (quick refresh safety)
  useEffect(() => {
    const flush = () => {
      if (!chartPrefsLoaded) return;
      try {
        const payload = { maLines, activeIndicators, indicatorParams, indicatorStyles, priceScaleMode };
        const url = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api") + "/prefs/chart_layout";
        const tok = localStorage.getItem("peestock_token");
        // fetch with keepalive survives the page unload
        fetch(url, { method: "PUT", keepalive: true,
          headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
          body: JSON.stringify({ value: payload }) }).catch(() => {});
      } catch (e) {}
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [chartPrefsLoaded, maLines, activeIndicators, indicatorParams, indicatorStyles, priceScaleMode]);

  // AI Forecast (LSTM) overlay
  const [forecastData, setForecastData] = useState(null);

  // Fundamentals snapshot for the active symbol (null = none ingested/available)
  const [fundamentals, setFundamentals] = useState(null);
  useEffect(() => {
    let alive = true;
    setFundamentals(null);
    if (!symbol) return;
    api.getFundamentals(symbol)
      .then(d => { if (alive) setFundamentals(d); })
      .catch(() => { if (alive) setFundamentals(null); });
    return () => { alive = false; };
  }, [symbol]);

  // Delivery money flow for the active symbol (null = no data / not on plan)
  const [deliveryFlow, setDeliveryFlow] = useState(null);
  useEffect(() => {
    let alive = true;
    setDeliveryFlow(null);
    if (!symbol) return;
    api.getDelivery(symbol, 60)
      .then(d => { if (alive) setDeliveryFlow(d); })
      .catch(() => { if (alive) setDeliveryFlow(null); });
    return () => { alive = false; };
  }, [symbol]);

  const [showCustomQuery, setShowCustomQuery] = useState(false);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryMatches, setQueryMatches] = useState([]);
  const [queryParam, setQueryParam] = useState("sma_cross");
  // Scan History
  const [showScanHistory, setShowScanHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [scanHistory, setScanHistory] = useState([]);
  const [selectedHistory, setSelectedHistory] = useState(null);
  // Result navigator — step through a scan's matches on the chart one by one
  const [resultNav, setResultNav] = useState(null); // { symbols:[], index:0, label:"" }

  const [activeSector, setActiveSector] = useState("NIFTY 50");
  const [searchQuery, setSearchQuery] = useState("");

  // ── Sidebar: the stock list is the primary control ──
  // The fundamentals/delivery cards used to sit above it and ate the whole
  // column, leaving the list ~0px tall and unusable. They're collapsible now
  // and live below the list; these remember the user's choice.
  const [showFundaCard, setShowFundaCard] = useState(false);
  const [showDeliveryCard, setShowDeliveryCard] = useState(false);
  useEffect(() => {
    try {
      setShowFundaCard(localStorage.getItem("chartix_side_funda") === "1");
      setShowDeliveryCard(localStorage.getItem("chartix_side_deliv") === "1");
    } catch (e) {}
  }, []);
  const toggleCard = (which) => {
    if (which === "funda") {
      setShowFundaCard((v) => {
        try { localStorage.setItem("chartix_side_funda", v ? "0" : "1"); } catch (e) {}
        return !v;
      });
    } else {
      setShowDeliveryCard((v) => {
        try { localStorage.setItem("chartix_side_deliv", v ? "0" : "1"); } catch (e) {}
        return !v;
      });
    }
  };

  // Keyboard navigation for the sidebar list (↑/↓ move + load the chart).
  // No cursor state on purpose: the charted `symbol` IS the cursor, so the two
  // can never drift apart and there's no effect to keep them in sync.
  const listBoxRef = useRef(null);

  useEffect(() => {
    setSearchQuery("");
  }, [activeSector]);
  
  // New UI feature states
  const [activeMainTab, setActiveMainTab] = useState("Main"); // 'Main' | 'Multiple Charts'
  const [showRiskCalc, setShowRiskCalc] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState("momentum");
  const [riskData, setRiskData] = useState({ capital: 100000, riskPct: 2, entry: 0, stop: 0 });
  const [showSettings, setShowSettings] = useState(false);
  const [showVideos, setShowVideos] = useState(null); // 'basic' | 'help'
  const [showWatchlistMgr, setShowWatchlistMgr] = useState(null); // 'new' | 'manage'
  const [showAnalysisSearch, setShowAnalysisSearch] = useState(false);
  const [chartBars, setChartBars] = useState(50); // bars to show (▶ button input)

  // Panel split points (fractions 0–1 of chart height) — candle/vol | vol/RSI | RSI/MACD
  const [panelSplits, setPanelSplits] = useState({ v1: 0.60, v2: 0.72, v3: 0.86 });
  
  // Data sync & Alerts states
  const [dataFeedStatus, setDataFeedStatus] = useState(null); // 'Connecting...' | 'Downloading Data...' | 'Complete'
  const [showAlerts, setShowAlerts] = useState(false);
  const [alertsList, setAlertsList] = useState([
    { id: 1, symbol: "HDFCBANK", condition: "Crosses Above 1600", status: "Triggered", time: "10:15 AM" },
    { id: 2, symbol: "RELIANCE", condition: "Volume Spike > 500k", status: "Active", time: "--:--" }
  ]);

  // Dedicated MA Analysis States
  const [showMAAnalysis, setShowMAAnalysis] = useState(false);
  const [maLoading, setMALoading] = useState(false);
  const [maMatches, setMAMatches] = useState([]);
  const [maConfig, setMAConfig] = useState({
    type: "sma", // sma | ema
    period1: 20,
    operator: "crosses_above", // crosses_above | crosses_below | gt | lt
    compareType: "price", // price | ma
    period2: 50
  });

  const loadWatchlist = useCallback(async () => {
    try {
      const data = await api.getWatchlist();
      setWatchlistData(data);
    } catch (err) {}
  }, []);

  // Load Watchlist (From DB watchlist endpoint)
  useEffect(() => {
    loadWatchlist();
  }, [loadWatchlist]);

  const loadMyWatchlist = useCallback(async () => {
    try {
      const data = await api.getMyWatchlist();
      setMyWatchlist(data || []);
    } catch (err) {
      console.warn("Failed to load personal watchlist:", err);
    }
  }, []);

  useEffect(() => {
    loadMyWatchlist();
  }, [loadMyWatchlist]);

  const loadHolidays = useCallback(async () => {
    setHolidaysLoading(true);
    try {
      const data = await api.getHolidays();
      setHolidays(data || []);
    } catch (err) {
      console.warn("Failed to load holidays:", err);
    } finally {
      setHolidaysLoading(false);
    }
  }, []);

  const handleSyncHolidays = useCallback(async () => {
    setHolidaysSyncing(true);
    try {
      const res = await api.syncHolidays();
      setHolidays(res.holidays || []);
    } catch (err) {
      console.warn("Failed to sync holidays:", err);
    } finally {
      setHolidaysSyncing(false);
    }
  }, []);

  useEffect(() => {
    loadHolidays();
  }, [loadHolidays]);

  const toggleWatchlist = async (sym) => {
    if (!sym) return;
    const cleanSym = sym.toUpperCase();
    const isAdded = myWatchlist.some(w => w.symbol === cleanSym);
    try {
      if (isAdded) {
        await api.removeFromWatchlist(cleanSym);
        setMyWatchlist(prev => prev.filter(w => w.symbol !== cleanSym));
      } else {
        await api.addToWatchlist(cleanSym);
        await loadMyWatchlist();
      }
    } catch (err) {
      console.error("Watchlist toggle failed:", err);
    }
  };

  // Escape key cancels active drawing tool
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { setActiveTool(null); setDrawStep(0); setTempStart(null); setTempEnd(null); setToolMenu(null); setSelectedId(null); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const loadChart = useCallback(async (sym, tf) => {
    if (!sym) return;
    const sameSymbol = lastFetched.current.symbol === sym;

    // D/W/M all derive from the same EOD dataset — skip refetch if we already have it
    if (sameSymbol && lastFetched.current.timeframe !== "") {
      return;
    }

    // In-memory cache: switching back to a symbol viewed this session is instant
    // (no tunnel round-trip). Entries kept ~10 min.
    const cache = eodCacheRef.current;
    const cached = cache.get(sym);
    if (cached && (Date.now() - cached.t) < 600000) {
      setChartData(cached.data);
      setUserDrawings([]);
      lastFetched.current = { symbol: sym, timeframe: tf };
      setChartLoading(false);
      return;
    }

    setChartLoading(true);
    try {
      const data = await api.getEod(sym);
      setChartData(data || []);
      setUserDrawings([]);
      lastFetched.current = { symbol: sym, timeframe: tf };
      cache.set(sym, { data: data || [], t: Date.now() });
      if (cache.size > 40) cache.delete(cache.keys().next().value); // cap memory
    } catch (err) {
      setChartData([]);
    } finally {
      setChartLoading(false);
    }
  }, []);

  useEffect(() => {
    loadChart(symbol, activeTimeframe);
  }, [symbol, activeTimeframe, loadChart]);

  // Fetch AI Forecast (LSTM) when the toggle is active or the symbol changes
  useEffect(() => {
    if (!activeIndicators.includes('forecast_lstm') || !symbol) {
      setForecastData(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getForecast(symbol);
        if (!cancelled) setForecastData(data || null);
      } catch (err) {
        console.warn("Failed to load forecast for", symbol, err);
        if (!cancelled) setForecastData(null);
      }
    })();
    return () => { cancelled = true; };
  }, [symbol, activeIndicators]);

  // Initialize and update chart
  useEffect(() => {
    if (!chartRef.current) return;
    
    if (chartData.length === 0) {
      if (chartInstance.current) {
        chartInstance.current.remove();
        chartInstance.current = null;
      }
      return;
    }

    const initChart = async () => {
      const { createChart, CrosshairMode, ColorType, LineStyle, CandlestickSeries, HistogramSeries, LineSeries, BarSeries, AreaSeries, BaselineSeries, LineType, createSeriesMarkers } = await import("lightweight-charts");

      const visibleLogicalRange = chartInstance.current ? chartInstance.current.timeScale().getVisibleLogicalRange() : null;

      if (chartInstance.current) {
        chartInstance.current.remove();
      }
      seriesRefs.current = {};

      const chart = createChart(chartRef.current, {
        width: chartRef.current.clientWidth,
        height: chartRef.current.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: isDarkMode ? "#0f1117" : "#FFFFFF" },
          textColor: isDarkMode ? "#c9d1d9" : "#333333",
          fontFamily: "'Inter', 'Segoe UI', 'Arial', sans-serif",
          fontSize: 11,
          // No TradingView logo/link on the canvas (credit is given in app docs).
          attributionLogo: false,
          panes: {
            // Pane sizes are managed by applyPaneStretchFactors (auto-adjusting
            // pixel layout); manual separator dragging would fight it.
            enableResize: false,
            separatorColor: isDarkMode ? '#2a2f3a' : '#C0C0C0',
          },
        },
        localization: {
          timeFormatter: (timestamp) => {
            // 1. Handle BusinessDay object (EOD)
            if (timestamp && typeof timestamp === "object" && "year" in timestamp && "month" in timestamp && "day" in timestamp) {
              const year = timestamp.year;
              const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
              const month = monthNames[timestamp.month - 1] || "";
              const day = String(timestamp.day).padStart(2, '0');
              return `${day} ${month} ${year}`;
            }

            // 2. Handle string date (EOD: YYYY-MM-DD)
            if (typeof timestamp === "string") {
              const parts = timestamp.split("-");
              if (parts.length === 3) {
                const year = parts[0];
                const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const mIdx = parseInt(parts[1], 10) - 1;
                const month = monthNames[mIdx] || "";
                const day = parts[2];
                return `${day} ${month} ${year}`;
              }
              return timestamp;
            }

            // 3. Handle numeric timestamp (Intraday / Unix seconds)
            if (typeof timestamp === "number") {
              // Convert to Asia/Kolkata (+5:30 = +19800 seconds) for consistent Indian market hours
              const kolkataTimestamp = timestamp + 19800;
              const date = new Date(kolkataTimestamp * 1000);
              const year = date.getUTCFullYear();
              const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
              const month = monthNames[date.getUTCMonth()] || "";
              const day = String(date.getUTCDate()).padStart(2, '0');
              const hours = String(date.getUTCHours()).padStart(2, '0');
              const minutes = String(date.getUTCMinutes()).padStart(2, '0');
              return `${day} ${month} ${year} ${hours}:${minutes}`;
            }

            return String(timestamp);
          },
        },
        grid: {
          vertLines: { color: isDarkMode ? "#1e2030" : "#E8E8E8", style: LineStyle.Dotted },
          horzLines: { color: isDarkMode ? "#1e2030" : "#E8E8E8", style: LineStyle.Dotted },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: isDarkMode ? '#4a5568' : '#909090',
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: isDarkMode ? '#2d3748' : '#606060',
          },
          horzLine: {
            color: isDarkMode ? '#4a5568' : '#909090',
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: isDarkMode ? '#2d3748' : '#606060',
          },
        },
        rightPriceScale: { borderColor: isDarkMode ? "#1e2030" : "#C0C0C0", mode: priceScaleMode },
        timeScale: {
          borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
          rightOffset: 6,
          fixRightEdge: false,
          tickMarkFormatter: (time, tickMarkType, locale) => {
            // 1. Handle BusinessDay object (EOD)
            if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
              const year = time.year;
              const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
              const month = monthNames[time.month - 1] || "";
              const day = String(time.day).padStart(2, '0');
              if (tickMarkType === 0 || tickMarkType === 1) {
                return `${month} ${year}`;
              }
              return `${day} ${month}`;
            }

            // 2. Handle string date (EOD: YYYY-MM-DD)
            if (typeof time === "string") {
              const parts = time.split("-");
              if (parts.length === 3) {
                const year = parts[0];
                const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const mIdx = parseInt(parts[1], 10) - 1;
                const month = monthNames[mIdx] || "";
                const day = parts[2];
                if (tickMarkType === 0 || tickMarkType === 1) {
                  return `${month} ${year}`;
                }
                return `${day} ${month}`;
              }
              return time;
            }

            // 3. Handle numeric timestamp (Intraday / Unix seconds)
            if (typeof time === "number") {
              // Convert to Asia/Kolkata (+5:30 = +19800 seconds) for consistent Indian market hours
              const kolkataTimestamp = time + 19800;
              const date = new Date(kolkataTimestamp * 1000);
              const year = date.getUTCFullYear();
              const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
              const month = monthNames[date.getUTCMonth()] || "";
              const day = String(date.getUTCDate()).padStart(2, '0');
              
              if (tickMarkType === 0 || tickMarkType === 1) {
                return `${month} ${year}`;
              } else if (tickMarkType === 2) {
                return `${day} ${month}`;
              } else {
                const hours = String(date.getUTCHours()).padStart(2, '0');
                const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                return `${hours}:${minutes}`;
              }
            }

            return String(time);
          }
        },
      });

      chartInstance.current = chart;

      // In this lightweight-charts build, addSeriesInPane(def, opts, paneIndex)
      // registers the series but NEVER creates the pane's DOM (sub-panes render
      // with zero height). The working, documented path is chart.addPane() +
      // pane.addSeries(def, opts) — verified in an isolated harness. This helper
      // routes every series creation through the working path; all former
      // addSeriesInPane(...) call sites now use it (same signature).
      const __rawAddSeries = chart.addSeries.bind(chart);
      const addSeriesInPane = (definition, options, paneIndex) => {
        if (!paneIndex) return __rawAddSeries(definition, options);
        while (chart.panes().length <= paneIndex) chart.addPane(true);
        return chart.panes()[paneIndex].addSeries(definition, options);
      };

      const rawCandleData = chartData
        .map((d) => {
          const formattedTime = ensureDateString(d.time);
          if (formattedTime === null || (typeof formattedTime === "number" && isNaN(formattedTime))) {
            return null;
          }
          return {
            time: formattedTime,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.volume,
          };
        })
        .filter(Boolean);

      // Deduplicate and sort chronologically to prevent lightweight-charts strictly-increasing crashes
      const seenTimes = new Set();
      const uniqueCandles = [];
      for (let i = 0; i < rawCandleData.length; i++) {
        const d = rawCandleData[i];
        if (!seenTimes.has(d.time)) {
          seenTimes.add(d.time);
          uniqueCandles.push(d);
        }
      }
      uniqueCandles.sort((a, b) => {
        if (typeof a.time === "number" && typeof b.time === "number") {
          return a.time - b.time;
        }
        return String(a.time).localeCompare(String(b.time));
      });

      const baseCandleData = aggregateTimeframe(uniqueCandles, activeTimeframe);
      
      let displayData = baseCandleData;
      let candleSeries;

      if (chartStyle === "heikin_ashi") {
        displayData = computeHeikinAshi(baseCandleData);
      } else if (chartStyle === "renko") {
        const avgPrice = baseCandleData.length > 0 ? baseCandleData.reduce((sum, d) => sum + d.close, 0) / baseCandleData.length : 100;
        const brickSize = avgPrice * 0.015; // 1.5% brick size
        displayData = computeRenko(baseCandleData, brickSize);
      } else if (chartStyle === "line_break") {
        displayData = computeLineBreak(baseCandleData, 3);
      }

      const candleData = displayData;
      chartDataRef.current = candleData; // expose for OHLC snap

      if (chartStyle === "bars") {
        candleSeries = addSeriesInPane(BarSeries, {
          upColor: "#26a69a",
          downColor: "#ef5350",
          openVisible: true,
          thinBars: false,
        }, 0);
      } else if (chartStyle === "hollow_candles") {
        candleSeries = addSeriesInPane(CandlestickSeries, {
          upColor: "rgba(0,0,0,0)",
          downColor: "#ef5350",
          borderVisible: true,
          borderUpColor: "#26a69a",
          borderDownColor: "#ef5350",
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350",
        }, 0);
        displayData = candleData.map((d, idx) => {
          const prev = idx > 0 ? candleData[idx - 1] : null;
          const isUp = d.close >= d.open;
          const isBullishColor = d.close >= (prev ? prev.close : d.open);
          const colorVal = isBullishColor ? "#26a69a" : "#ef5350";
          return {
            ...d,
            color: isUp ? "rgba(0,0,0,0)" : colorVal,
            borderColor: colorVal,
            wickColor: colorVal,
          };
        });
      } else if (chartStyle === "volume_candles") {
        const avgVol = candleData.reduce((sum, d) => sum + (d.volume || 0), 0) / (candleData.length || 1);
        candleSeries = addSeriesInPane(CandlestickSeries, {
          borderVisible: true,
        }, 0);
        displayData = candleData.map(d => {
          const isUp = d.close >= d.open;
          const isHighVol = (d.volume || 0) > avgVol * 1.5;
          const color = isUp 
            ? (isHighVol ? "#089981" : "#83d6c9") 
            : (isHighVol ? "#f23645" : "#fca9b0");
          return {
            ...d,
            color,
            borderColor: color,
            wickColor: color,
          };
        });
      } else if (chartStyle === "line") {
        candleSeries = addSeriesInPane(LineSeries, {
          color: "#26a69a",
          lineWidth: 2,
        }, 0);
      } else if (chartStyle === "line_markers") {
        candleSeries = addSeriesInPane(LineSeries, {
          color: "#26a69a",
          lineWidth: 2,
        }, 0);
      } else if (chartStyle === "step_line") {
        candleSeries = addSeriesInPane(LineSeries, {
          color: "#26a69a",
          lineWidth: 2,
          lineType: LineType.WithSteps,
        }, 0);
      } else if (chartStyle === "area") {
        candleSeries = addSeriesInPane(AreaSeries, {
          topColor: "rgba(38, 166, 154, 0.4)",
          bottomColor: "rgba(38, 166, 154, 0.0)",
          lineColor: "#26a69a",
          lineWidth: 2,
        }, 0);
      } else if (chartStyle === "hlc_area") {
        candleSeries = addSeriesInPane(AreaSeries, {
          topColor: "rgba(38, 166, 154, 0.3)",
          bottomColor: "rgba(38, 166, 154, 0.0)",
          lineColor: "#26a69a",
          lineWidth: 2,
        }, 0);
      } else if (chartStyle === "baseline") {
        const avgPrice = candleData.reduce((sum, d) => sum + d.close, 0) / (candleData.length || 1);
        candleSeries = addSeriesInPane(BaselineSeries, {
          baseValue: { type: 'price', price: avgPrice },
          topFillColor1: 'rgba(38, 166, 154, 0.28)',
          topFillColor2: 'rgba(38, 166, 154, 0.05)',
          topLineColor: '#26a69a',
          bottomFillColor1: 'rgba(239, 83, 80, 0.05)',
          bottomFillColor2: 'rgba(239, 83, 80, 0.28)',
          bottomLineColor: '#ef5350',
          lineWidth: 2,
        }, 0);
      } else if (chartStyle === "columns") {
        candleSeries = addSeriesInPane(HistogramSeries, {
          color: "#26a69a",
          priceFormat: { type: "price" },
        }, 0);
      } else if (chartStyle === "high_low") {
        candleSeries = addSeriesInPane(CandlestickSeries, {
          upColor: "rgba(0,0,0,0)",
          downColor: "rgba(0,0,0,0)",
          borderVisible: false,
          wickVisible: true,
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350",
        }, 0);
      } else {
        // default candles / heikin_ashi / renko / line_break
        candleSeries = addSeriesInPane(CandlestickSeries, {
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderVisible: true,
          borderUpColor: "#26a69a",
          borderDownColor: "#ef5350",
          wickDownColor: "#ef5350",
          wickUpColor: "#26a69a",
        }, 0);
      }

      // Identify active sub-indicators in order
      const activeSubs = activeIndicators.filter(id => ['rsi', 'macd', 'stoch', 'atr', 'cci', 'williams', 'obv', 'mfi', 'adx', 'roc', 'aroon', 'stochrsi', 'trix', 'uo', 'momentum', 'dpo', 'ao', 'vortex', 'cmf', 'chaikin_osc', 'adl', 'efi'].includes(id));
      const subCount = activeSubs.length;

      const paneIndices = {
        price: 0,
        volume: 1,
      };
      activeSubs.forEach((id, idx) => {
        paneIndices[id] = 2 + idx;
      });

      // Candle series scale margins (fits cleanly in pane 0)
      candleSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.05, bottom: 0.05 },
        ticksVisible: true,
      });

      // ── Set pane stretch factors for proper proportions ──
      // Price pane = dominant, volume = small, sub-indicators = medium

      // Helper: apply stretch factors after all series are added
      const applyPaneStretchFactors = () => {
        try {
          // 1) Self-heal: drop any sub-pane that ended up with no series.
          let panes = chart.panes();
          for (let i = panes.length - 1; i >= 2; i--) {
            try {
              if (panes[i] && panes[i].getSeries().length === 0) chart.removePane(i);
            } catch (_) { /* pane already gone */ }
          }
          panes = chart.panes();
          if (!chartRef.current || panes.length < 2) return;

          // 2) TradingView-style proportions. Panes now have real DOM (created
          //    via chart.addPane + pane.addSeries), so stretch factors work.
          //    NOTE: do NOT sequentially setHeight() every pane — each call
          //    rebalances the others and the earlier ones get crushed.
          const nSubs = Math.max(panes.length - 2, 0);
          const subW = nSubs > 0 ? Math.min(16, 44 / nSubs) : 0;
          const weights = [100 - 10 - subW * nSubs, 10];
          for (let i = 0; i < nSubs; i++) weights.push(subW);
          panes.forEach((p, i) => { try { p.setStretchFactor(weights[i] || 1); } catch (_) {} });

          // 3) Pane labels ("RSI 14", "MACD 12 26 9") aligned to the ACTUAL
          //    rendered pane rows (measured from the DOM after layout applies).
          const PANE_LABEL_NAMES = {
            rsi:'RSI', macd:'MACD', stoch:'Stoch', atr:'ATR', cci:'CCI',
            williams:'Williams %R', mfi:'MFI', adx:'ADX', roc:'ROC', aroon:'Aroon',
            stochrsi:'Stoch RSI', trix:'TRIX', uo:'Ultimate Osc', momentum:'Momentum',
            dpo:'DPO', ao:'Awesome Osc', vortex:'Vortex', cmf:'CMF',
            chaikin_osc:'Chaikin Osc', adl:'A/D Line', obv:'OBV', efi:'Elder FI',
          };
          requestAnimationFrame(() => {
            try {
              const root = chartRef.current;
              if (!root) return;
              if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
              root.querySelectorAll('[data-pane-label]').forEach(el => el.remove());
              const rootTop = root.getBoundingClientRect().top;
              // Pane rows are the tall table rows (separators are ~1px, axis last).
              const rows = [...root.querySelectorAll('table tr')]
                .map(tr => ({ top: tr.getBoundingClientRect().top - rootTop, h: tr.getBoundingClientRect().height }))
                .filter(r => r.h > 12);
              const paneRows = rows.slice(0, rows.length - 1); // drop time axis row
              const putLabel = (topPx, text, editId, dotColor) => {
                const d = document.createElement('div');
                d.setAttribute('data-pane-label', '');
                d.style.cssText = 'position:absolute;left:8px;z-index:5;font-size:11px;font-weight:500;'
                  + `top:${Math.round(topPx) + 5}px;color:${isDarkMode ? '#9aa4b2' : '#555'};font-family:inherit;`
                  + 'display:flex;align-items:center;gap:5px;'
                  + (editId ? 'pointer-events:auto;cursor:pointer;' : 'pointer-events:none;');
                if (dotColor) {
                  const dot = document.createElement('span');
                  dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${dotColor};flex-shrink:0;`;
                  d.appendChild(dot);
                }
                d.appendChild(document.createTextNode(text));
                if (editId) {
                  d.title = 'Click to edit parameters & color';
                  d.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    setLegendCollapsed(false);
                    setEditingIndicator(editId);
                  });
                  d.addEventListener('mouseenter', () => { d.style.textDecoration = 'underline'; });
                  d.addEventListener('mouseleave', () => { d.style.textDecoration = 'none'; });
                }
                root.appendChild(d);
              };
              if (paneRows[1]) putLabel(paneRows[1].top, 'Volume', null, null);
              activeSubs.forEach((id, k) => {
                const row = paneRows[2 + k];
                if (!row) return;
                const p = getParams(id) || {};
                const nums = Object.values(p).filter(v => typeof v === 'number').join(' ');
                putLabel(row.top, `${PANE_LABEL_NAMES[id] || id.toUpperCase()}${nums ? ' ' + nums : ''}`,
                         id, getCol(id, '#9aa4b2'));
              });
            } catch (labelErr) { console.warn('pane labels failed:', labelErr); }
          });
        } catch(e) { console.warn('pane layout failed:', e); }
      };
      // Registered BEFORE any indicator series is added: even if an indicator
      // block throws below, these still fire and the layout self-heals.
      const layoutTimers = [setTimeout(applyPaneStretchFactors, 60), setTimeout(applyPaneStretchFactors, 400)];
      
      // Set the appropriate data based on series type
      if (["line", "line_markers", "step_line", "area", "baseline"].includes(chartStyle)) {
        candleSeries.setData(displayData.map(d => ({ time: d.time, value: d.close })));
        if (chartStyle === "line_markers") {
          // Set markers along the line
          candleSeries.setMarkers(displayData.filter((_, idx) => idx % 5 === 0).map(d => ({
            time: d.time,
            position: "inBar",
            color: "#26a69a",
            shape: "circle",
            size: 0.5,
          })));
        }
      } else if (chartStyle === "hlc_area") {
        candleSeries.setData(displayData.map(d => ({ time: d.time, value: (d.high + d.low + d.close) / 3 })));
      } else if (chartStyle === "columns") {
        candleSeries.setData(displayData.map(d => ({
          time: d.time,
          value: d.close,
          color: d.close >= d.open ? "#26a69a" : "#f23645",
        })));
      } else {
        candleSeries.setData(displayData);
      }
      
      seriesRefs.current.candles = candleSeries;

      // Volume series (Pane 1)
      if (paneIndices['volume'] !== undefined) {
        const volumeSeries = addSeriesInPane(HistogramSeries, {
          color: "#26a69a",
          priceFormat: { type: "volume" },
          lastValueVisible: false,
        }, paneIndices['volume']);
        volumeSeries.priceScale().applyOptions({
          visible: true,
          scaleMargins: { top: 0.1, bottom: 0.05 },
          borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
          ticksVisible: true,
        });
        volumeSeries.setData(candleData.map((d) => ({
          time: d.time, value: d.volume, color: d.close >= d.open ? "#26a69a" : "#f23645",
        })));
      }

      // RSI series (Pane 2)
      if (activeIndicators.includes('rsi') && paneIndices['rsi'] !== undefined) {
        const rsiData = computeRSI(candleData, rsiPeriod);
        if (rsiData.length > 0) {
          const rsiPaneIndex = paneIndices['rsi'];
          const rsiSeries = addSeriesInPane(LineSeries, {
            color: getCol('rsi', '#a78bfa'), lineWidth: getW('rsi', 1.5), lastValueVisible: true,
            priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
          }, rsiPaneIndex);
          rsiSeries.priceScale().applyOptions({
            visible: true,
            autoScale: false,
            borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.05, bottom: 0.05 },
            ticksVisible: true,
          });
          // Fix RSI Y-axis to 0-100 range
          rsiSeries.priceScale().setVisibleRange({ from: 0, to: 100 });
          rsiSeries.setData(rsiData);
          const line70 = addSeriesInPane(LineSeries, { color:'rgba(248,113,113,0.4)', lineWidth:1, lineStyle:2, lastValueVisible: false }, rsiPaneIndex);
          line70.setData(rsiData.map(d => ({ time: d.time, value: 70 })));
          const line30 = addSeriesInPane(LineSeries, { color:'rgba(52,211,153,0.4)', lineWidth:1, lineStyle:2, lastValueVisible: false }, rsiPaneIndex);
          line30.setData(rsiData.map(d => ({ time: d.time, value: 30 })));
        }
      }

      // MACD series (Pane 3)
      if (activeIndicators.includes('macd') && paneIndices['macd'] !== undefined) {
        const macdData = computeMACD(candleData, macdFast, macdSlow, macdSignal);
        if (macdData.length > 0) {
          const macdPaneIndex = paneIndices['macd'];
          const macdSeries = addSeriesInPane(HistogramSeries, {
            title: 'MACD',
            lastValueVisible: true,
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
          }, macdPaneIndex);
          macdSeries.priceScale().applyOptions({
            visible: true,
            borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.1, bottom: 0.1 },
            ticksVisible: true,
          });
          macdSeries.setData(macdData.map(d => ({
            time: d.time, value: d.hist, color: d.hist >= 0 ? 'rgba(8,153,129,0.55)' : 'rgba(242,54,69,0.55)'
          })));

          // MACD line + signal line over the histogram
          const macdLine = addSeriesInPane(LineSeries, {
            color: getCol('macd', '#2962ff'), lineWidth: getW('macd', 1.5),
            title: '', lastValueVisible: true, priceLineVisible: false,
          }, macdPaneIndex);
          macdLine.setData(macdData.map(d => ({ time: d.time, value: d.macd })));

          const signalLine = addSeriesInPane(LineSeries, {
            color: '#ff9800', lineWidth: getW('macd', 1.5),
            title: '', lastValueVisible: true, priceLineVisible: false,
          }, macdPaneIndex);
          signalLine.setData(macdData.map(d => ({ time: d.time, value: d.signal })));
        }
      }

      // ── Candlestick Pattern markers ──
      let markers = [];
      const showDoji = activeIndicators.includes('pattern_doji');
      const showHammer = activeIndicators.includes('pattern_hammer');
      const showEngulfing = activeIndicators.includes('pattern_engulfing');

      if (showDoji || showHammer || showEngulfing) {
        for (let i = 0; i < candleData.length; i++) {
          const c = candleData[i];
          const body = Math.abs(c.close - c.open);
          const hlRange = c.high - c.low;

          if (showDoji && hlRange > 0 && body <= (hlRange * 0.1)) {
            markers.push({
              time: c.time,
              position: 'inBar',
              color: '#f59e0b',
              shape: 'circle',
              text: 'Doji',
              size: 1
            });
          }

          if (showHammer && hlRange > 0) {
            const lowerShadow = c.close > c.open ? (c.open - c.low) : (c.close - c.low);
            const upperShadow = c.close > c.open ? (c.high - c.close) : (c.high - c.open);
            if (lowerShadow > 2 * body && upperShadow < 0.1 * hlRange) {
              markers.push({
                time: c.time,
                position: 'belowBar',
                color: '#10b981',
                shape: 'arrowUp',
                text: 'Hammer',
                size: 1
              });
            }
          }

          if (showEngulfing && i > 0) {
            const prev = candleData[i - 1];
            const prevBody = Math.abs(prev.close - prev.open);
            const currBody = Math.abs(c.close - c.open);

            if (prev.close < prev.open && c.close > c.open && c.open <= prev.close && c.close >= prev.open && currBody > prevBody) {
              markers.push({
                time: c.time,
                position: 'belowBar',
                color: '#60a5fa',
                shape: 'arrowUp',
                text: 'B.Engulfing',
                size: 1
              });
            } else if (prev.close > prev.open && c.close < c.open && c.open >= prev.close && c.close <= prev.open && currBody > prevBody) {
              markers.push({
                time: c.time,
                position: 'aboveBar',
                color: '#FF0000',
                shape: 'arrowDown',
                text: 'Bear.Engulfing',
                size: 1
              });
            }
          }
        }
      }

      const markersPlugin = createSeriesMarkers(candleSeries);
      markersPlugin.setMarkers(markers);

      // ── S&R Auto Levels ──
      if (activeIndicators.includes('sr_levels') && candleData.length > 0) {
        const currentPrice = candleData[candleData.length - 1].close;
        const sr = computeWeeklyMonthlySRLevels(rawCandleData, currentPrice);

        // Find bounds of recent candles to prevent lines from overflowing into other panes (e.g. RSI, MACD)
        const recentCandles = candleData.slice(-150);
        const minPrice = Math.min(...recentCandles.map(d => d.low));
        const maxPrice = Math.max(...recentCandles.map(d => d.high));
        const buffer = (maxPrice - minPrice) * 0.05;
        const inBounds = (price) => price >= (minPrice - buffer) && price <= (maxPrice + buffer);

        // Draw Monthly Highs (Resistance/Higher Highs)
        sr.monthlyHighs.filter(inBounds).forEach(level => {
          candleSeries.createPriceLine({
            price: level,
            color: '#FF0000',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: 'Monthly High',
          });
        });

        // Draw Monthly Lows (Support/Lower Lows)
        sr.monthlyLows.filter(inBounds).forEach(level => {
          candleSeries.createPriceLine({
            price: level,
            color: '#00AA00',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: 'Monthly Low',
          });
        });

        // Draw Weekly Highs (Resistance/Higher Highs)
        sr.weeklyHighs.filter(inBounds).forEach(level => {
          candleSeries.createPriceLine({
            price: level,
            color: '#FF0000',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Weekly High',
          });
        });

        // Draw Weekly Lows (Support/Lower Lows)
        sr.weeklyLows.filter(inBounds).forEach(level => {
          candleSeries.createPriceLine({
            price: level,
            color: '#00AA00',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Weekly Low',
          });
        });
      }

      // ── Auto Trendlines (📐 tab): pivot-fitted diagonal support/resistance ──
      if (activeIndicators.includes('auto_trendlines') && candleData.length >= 40) {
        const tls = computeAutoTrendlines(candleData);
        tls.forEach(L => {
          const s = addSeriesInPane(LineSeries, {
            color: L.kind === 'sup' ? '#10b981' : '#ef4444',
            lineWidth: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
            title: `${L.kind === 'sup' ? 'Support' : 'Resistance'} (${L.touches} touches)`,
          }, 0);
          s.setData([L.p1, L.p2]);
        });
      }

      // ── Editable MA Lines from maLines state ──
      for (const ma of maLines) {
        if (!ma.visible) continue;
        let maData = [];
        const p = parseInt(ma.period, 10) || 20;
        if (ma.type === 'SMA')  maData = computeSMA(candleData, p);
        else if (ma.type === 'EMA')  maData = computeEMA(candleData, p);
        else if (ma.type === 'WMA')  maData = computeWMA(candleData, p);
        else if (ma.type === 'DEMA') maData = computeDEMA(candleData, p);
        else if (ma.type === 'TEMA') maData = computeTEMA(candleData, p);
        else if (ma.type === 'HMA')  maData = computeHMA(candleData, p);
        else if (ma.type === 'VWAP') maData = computeVWAP(candleData);
        else if (ma.type === 'BB') {
          const bbData = computeBB(candleData, p);
          if (bbData.length) {
            const bbUpper = addSeriesInPane(LineSeries, { color: ma.color, lineWidth: 1, title: '', lastValueVisible: true, priceLineVisible: false }, 0);
            bbUpper.setData(bbData.map(d => ({ time: d.time, value: d.upper })));
            const bbMid = addSeriesInPane(LineSeries, { color: ma.color, lineWidth: 1, lineStyle: 2, title: '', lastValueVisible: true, priceLineVisible: false }, 0);
            bbMid.setData(bbData.map(d => ({ time: d.time, value: d.middle })));
            const bbLower = addSeriesInPane(LineSeries, { color: ma.color, lineWidth: 1, title: '', lastValueVisible: true, priceLineVisible: false }, 0);
            bbLower.setData(bbData.map(d => ({ time: d.time, value: d.lower })));
          }
          continue;
        }
        if (maData.length) {
          const maSeries = addSeriesInPane(LineSeries, {
            color: ma.color, lineWidth: 1.5, title: '',
            lastValueVisible: true,
            priceLineVisible: false,
          }, 0);
          maSeries.setData(maData.map(d => ({ time: d.time, value: d.value ?? d })));
        }
      }

      // ── Render all active indicators ──
      const addLine = (data, color, w=1, id='', margins=null, title='') => {
        if (!data || data.length === 0) return;
        const paneIndex = paneIndices[id] !== undefined ? paneIndices[id] : 0;
        const options = {
          color: id ? getCol(id, color) : color,
          lineWidth: id ? getW(id, w) : w,
          title: '',
          lastValueVisible: true,
          priceLineVisible: false,
          priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        };
        const s = addSeriesInPane(LineSeries, options, paneIndex);
        if (paneIndex > 1) {
          s.priceScale().applyOptions({
            visible: true,
            borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.08, bottom: 0.08 },
            ticksVisible: true,
          });
        } else if (paneIndex === 1) {
          s.priceScale().applyOptions({
            visible: true,
            borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.1, bottom: 0.05 },
            ticksVisible: true,
          });
        }
        s.setData(data.map(d => ({ time: d.time, value: d.value ?? d })));
      };

      if (activeIndicators.includes('sma20')) addLine(computeSMA(candleData,getParams('sma20').period), '#f59e0b', 1.5, 'sma20', null, `SMA${getParams('sma20').period}`);
      if (activeIndicators.includes('sma44')) addLine(computeSMA(candleData,getParams('sma44').period), '#ef4444', 1.5, 'sma44', null, `SMA${getParams('sma44').period}`);
      if (activeIndicators.includes('sma50')) addLine(computeSMA(candleData,getParams('sma50').period), '#a78bfa', 1.5, 'sma50', null, `SMA${getParams('sma50').period}`);
      if (activeIndicators.includes('sma200')) addLine(computeSMA(candleData,getParams('sma200').period), '#3b82f6', 2, 'sma200', null, `SMA${getParams('sma200').period}`);
      if (activeIndicators.includes('ema9')) addLine(computeEMA(candleData,getParams('ema9').period), '#06b6d4', 1, 'ema9', null, `EMA${getParams('ema9').period}`);
      if (activeIndicators.includes('ema20')) addLine(computeEMA(candleData,getParams('ema20').period), '#fb923c', 1.5, 'ema20', null, `EMA${getParams('ema20').period}`);
      if (activeIndicators.includes('ema50')) addLine(computeEMA(candleData,getParams('ema50').period), '#c084fc', 1.5, 'ema50', null, `EMA${getParams('ema50').period}`);
      if (activeIndicators.includes('vwap')) addLine(computeVWAP(candleData), '#60a5fa', 1.5, 'vwap', null, 'VWAP');
      if (activeIndicators.includes('psar')) {
        const psarData = computePSAR(candleData, getParams('psar').step, getParams('psar').max);
        if (psarData.length) {
          const ps = addSeriesInPane(LineSeries, { color:'#f43f5e', lineWidth:2, lineStyle:3, title: '', lastValueVisible: true, priceLineVisible: false }, 0);
          ps.setData(psarData.map(d => ({ time: d.time, value: d.value })));
        }
      }
      if (activeIndicators.includes('supertrend')) {
        const st = computeSuperTrend(candleData, getParams('supertrend').period, getParams('supertrend').mult);
        if (st.length) {
          const stS = addSeriesInPane(LineSeries, { color:'#10b981', lineWidth:2, title: '', lastValueVisible: true, priceLineVisible: false }, 0);
          stS.setData(st.map(d => ({ time: d.time, value: d.value })));
        }
      }
      if (activeIndicators.includes('bb')) {
        const bbData = computeBB(candleData, getParams('bb').period, getParams('bb').std);
        if (bbData.length) {
          const upper = addSeriesInPane(LineSeries, { color:'#60a5fa', lineWidth:1, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          upper.setData(bbData.map(d => ({ time:d.time, value:d.upper })));
          const mid = addSeriesInPane(LineSeries, { color:'#60a5fa', lineWidth:1, lineStyle:2, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          mid.setData(bbData.map(d => ({ time:d.time, value:d.middle })));
          const lower = addSeriesInPane(LineSeries, { color:'#60a5fa', lineWidth:1, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          lower.setData(bbData.map(d => ({ time:d.time, value:d.lower })));
        }
      }
      if (activeIndicators.includes('keltner')) {
        const kc = computeKeltner(candleData, getParams('keltner').period, getParams('keltner').mult);
        if (kc.length) {
          const col = getCol('keltner', '#14b8a6');
          const w = getW('keltner', 1);
          const kcU = addSeriesInPane(LineSeries, { color: col, lineWidth: w, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          kcU.setData(kc.map(d => ({ time: d.time, value: d.upper })));
          const kcM = addSeriesInPane(LineSeries, { color: col, lineWidth: w, lineStyle: 2, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          kcM.setData(kc.map(d => ({ time: d.time, value: d.middle })));
          const kcL = addSeriesInPane(LineSeries, { color: col, lineWidth: w, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          kcL.setData(kc.map(d => ({ time: d.time, value: d.lower })));
        }
      }
      if (activeIndicators.includes('donchian')) {
        const dc = computeDonchian(candleData, getParams('donchian').period);
        if (dc.length) {
          const col = getCol('donchian', '#f472b6');
          const w = getW('donchian', 1);
          const dcU = addSeriesInPane(LineSeries, { color: col, lineWidth: w, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          dcU.setData(dc.map(d => ({ time: d.time, value: d.upper })));
          const dcM = addSeriesInPane(LineSeries, { color: col, lineWidth: w, lineStyle: 2, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          dcM.setData(dc.map(d => ({ time: d.time, value: d.middle })));
          const dcL = addSeriesInPane(LineSeries, { color: col, lineWidth: w, title:'', lastValueVisible: true, priceLineVisible: false }, 0);
          dcL.setData(dc.map(d => ({ time: d.time, value: d.lower })));
        }
      }
      if (activeIndicators.includes('roc')) {
        const rc = computeROC(candleData, getParams('roc').period);
        addLine(rc, '#38bdf8', 1.5, 'roc', null, `ROC ${getParams('roc').period}`);
      }
      if (activeIndicators.includes('aroon') && paneIndices['aroon'] !== undefined) {
        const ar = computeAroon(candleData, getParams('aroon').period);
        if (ar.up.length) {
          const arPane = paneIndices['aroon'];
          const upS = addSeriesInPane(LineSeries, { color: '#10b981', lineWidth: getW('aroon', 1.5), title:'', lastValueVisible: true }, arPane);
          upS.priceScale().applyOptions({
            visible: true, autoScale: false,
            borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.05, bottom: 0.05 }, ticksVisible: true,
          });
          upS.priceScale().setVisibleRange({ from: 0, to: 100 });
          upS.setData(ar.up);
          const dnS = addSeriesInPane(LineSeries, { color: '#ef4444', lineWidth: getW('aroon', 1.5), title:'', lastValueVisible: true }, arPane);
          dnS.setData(ar.down);
        }
      }
      if (activeIndicators.includes('ichimoku')) {
        const ich = computeIchimokuChart(candleData, getParams('ichimoku').tenkan, getParams('ichimoku').kijun, getParams('ichimoku').senkou);
        const w = getW('ichimoku', 1);
        const mk = (data, color, style) => {
          if (!data.length) return;
          const s = addSeriesInPane(LineSeries, { color, lineWidth: w, lineStyle: style || 0, title:'', lastValueVisible: false, priceLineVisible: false }, 0);
          s.setData(data);
        };
        mk(ich.tenkan, '#2962ff');
        mk(ich.kijun, '#ef4444');
        mk(ich.spanA, 'rgba(16,185,129,0.7)', 2);
        mk(ich.spanB, 'rgba(245,158,11,0.7)', 2);
      }
      if (activeIndicators.includes('alligator')) {
        const al = computeAlligator(candleData);
        if (al.length) {
          const w = getW('alligator', 1.5);
          const mk = (key, color) => {
            const s = addSeriesInPane(LineSeries, { color, lineWidth: w, title:'', lastValueVisible: false, priceLineVisible: false }, 0);
            s.setData(al.map(d => ({ time: d.time, value: d[key] })));
          };
          mk('jaw', '#3b82f6');
          mk('teeth', '#ef4444');
          mk('lips', '#10b981');
        }
      }
      if (activeIndicators.includes('ema_ribbon')) {
        const ribbonPeriods = [8, 13, 21, 34, 55];
        const shades = ['#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9'];
        ribbonPeriods.forEach((p, i) => {
          const e = computeEMA(candleData, p);
          if (e.length) {
            const s = addSeriesInPane(LineSeries, { color: shades[i], lineWidth: 1, title:'', lastValueVisible: false, priceLineVisible: false }, 0);
            s.setData(e);
          }
        });
      }
      if (activeIndicators.includes('trix')) {
        addLine(computeTRIX(candleData, getParams('trix').period), '#818cf8', 1.5, 'trix', null, 'TRIX');
      }
      if (activeIndicators.includes('uo')) {
        addLine(computeUO(candleData, getParams('uo').p1, getParams('uo').p2, getParams('uo').p3), '#fb7185', 1.5, 'uo', null, 'UO');
      }
      if (activeIndicators.includes('momentum')) {
        addLine(computeMomentum(candleData, getParams('momentum').period), '#5eead4', 1.5, 'momentum', null, 'MOM');
      }
      if (activeIndicators.includes('dpo')) {
        addLine(computeDPO(candleData, getParams('dpo').period), '#fdba74', 1.5, 'dpo', null, 'DPO');
      }
      if (activeIndicators.includes('cmf')) {
        addLine(computeCMF(candleData, getParams('cmf').period), '#4ade80', 1.5, 'cmf', null, 'CMF');
      }
      if (activeIndicators.includes('chaikin_osc')) {
        addLine(computeChaikinOsc(candleData, getParams('chaikin_osc').fast, getParams('chaikin_osc').slow), '#f0abfc', 1.5, 'chaikin_osc', null, 'Chaikin');
      }
      if (activeIndicators.includes('adl')) {
        addLine(computeADL(candleData), '#7dd3fc', 1.5, 'adl', null, 'ADL');
      }
      if (activeIndicators.includes('efi')) {
        addLine(computeEFI(candleData, getParams('efi').period), '#fca5a5', 1.5, 'efi', null, 'EFI');
      }
      if (activeIndicators.includes('ao') && paneIndices['ao'] !== undefined) {
        const aoData = computeAO(candleData);
        if (aoData.length) {
          const aoSeries = addSeriesInPane(HistogramSeries, {
            title: '', lastValueVisible: true,
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
          }, paneIndices['ao']);
          aoSeries.priceScale().applyOptions({
            visible: true, borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.1, bottom: 0.1 }, ticksVisible: true,
          });
          aoSeries.setData(aoData.map((d, i) => ({
            time: d.time, value: d.value,
            color: i > 0 && d.value >= aoData[i - 1].value ? '#26a69a' : '#ef5350',
          })));
        }
      }
      if (activeIndicators.includes('vortex') && paneIndices['vortex'] !== undefined) {
        const vx = computeVortex(candleData, getParams('vortex').period);
        if (vx.plus.length) {
          const vxPane = paneIndices['vortex'];
          const w = getW('vortex', 1.5);
          const plusS = addSeriesInPane(LineSeries, { color: '#10b981', lineWidth: w, title:'', lastValueVisible: true }, vxPane);
          plusS.priceScale().applyOptions({
            visible: true, borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.08, bottom: 0.08 }, ticksVisible: true,
          });
          plusS.setData(vx.plus);
          const minusS = addSeriesInPane(LineSeries, { color: '#ef4444', lineWidth: w, title:'', lastValueVisible: true }, vxPane);
          minusS.setData(vx.minus);
        }
      }
      if (activeIndicators.includes('stochrsi') && paneIndices['stochrsi'] !== undefined) {
        const sr = computeStochRSI(candleData, getParams('stochrsi').rsi, getParams('stochrsi').stoch, getParams('stochrsi').k, getParams('stochrsi').d);
        if (sr.k.length) {
          const srPane = paneIndices['stochrsi'];
          const w = getW('stochrsi', 1.5);
          const kS = addSeriesInPane(LineSeries, { color: getCol('stochrsi', '#e879f9'), lineWidth: w, title:'', lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } }, srPane);
          kS.priceScale().applyOptions({
            visible: true, autoScale: false,
            borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.05, bottom: 0.05 }, ticksVisible: true,
          });
          kS.priceScale().setVisibleRange({ from: 0, to: 100 });
          kS.setData(sr.k);
          const dS = addSeriesInPane(LineSeries, { color: '#fb923c', lineWidth: w, title:'', lastValueVisible: true }, srPane);
          dS.setData(sr.d);
          const l80 = addSeriesInPane(LineSeries, { color: 'rgba(248,113,113,0.4)', lineWidth: 1, lineStyle: 3, lastValueVisible: false }, srPane);
          l80.setData(sr.k.map(d => ({ time: d.time, value: 80 })));
          const l20 = addSeriesInPane(LineSeries, { color: 'rgba(52,211,153,0.4)', lineWidth: 1, lineStyle: 3, lastValueVisible: false }, srPane);
          l20.setData(sr.k.map(d => ({ time: d.time, value: 20 })));
        }
      }
      // RSI and MACD are always rendered above with paneIndex — skip here to avoid duplicates
      if (activeIndicators.includes('stoch') && paneIndices['stoch'] !== undefined) {
        const st = computeStochastic(candleData, getParams('stoch').k, getParams('stoch').d);
        if (st.length) {
          const stPaneIndex = paneIndices['stoch'];
          const s = addSeriesInPane(LineSeries, {
            color: getCol('stoch', '#34d399'), lineWidth: getW('stoch', 1.5), title: '', lastValueVisible: true,
            priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
          }, stPaneIndex);
          s.priceScale().applyOptions({
            visible: true,
            autoScale: false,
            borderColor: isDarkMode ? "#1e2030" : "#C0C0C0",
            scaleMargins: { top: 0.05, bottom: 0.05 },
            ticksVisible: true,
          });
          // Fix Stochastic Y-axis to 0-100 range
          s.priceScale().setVisibleRange({ from: 0, to: 100 });
          s.setData(st.map(d=>({time:d.time,value:d.k})));
          
          const dLine = addSeriesInPane(LineSeries, {
            color:'#fb923c', lineWidth: 1.5, title: '', lastValueVisible: true,
          }, stPaneIndex);
          dLine.setData(st.map(d=>({time:d.time,value:d.d})));

          const line80 = addSeriesInPane(LineSeries, { color: 'rgba(248,113,113,0.4)', lineWidth: 1, lineStyle: 3, lastValueVisible: false }, stPaneIndex);
          line80.setData(st.map(d => ({ time: d.time, value: 80 })));
          const line20 = addSeriesInPane(LineSeries, { color: 'rgba(52,211,153,0.4)', lineWidth: 1, lineStyle: 3, lastValueVisible: false }, stPaneIndex);
          line20.setData(st.map(d => ({ time: d.time, value: 20 })));
        }
      }
      if (activeIndicators.includes('atr')) {
        const at = computeATR(candleData, getParams('atr').period);
        addLine(at, '#fb923c', 1.5, 'atr', null, `ATR ${getParams('atr').period}`);
      }
      if (activeIndicators.includes('cci')) {
        const cc = computeCCI(candleData, getParams('cci').period);
        addLine(cc, '#f87171', 1.5, 'cci', null, `CCI ${getParams('cci').period}`);
      }
      if (activeIndicators.includes('williams')) {
        const wr = computeWilliamsR(candleData, getParams('williams').period);
        addLine(wr, '#4ade80', 1.5, 'williams', null, 'Williams %R');
      }
      if (activeIndicators.includes('obv')) {
        const ob = computeOBV(candleData);
        addLine(ob, '#38bdf8', 1.5, 'obv', null, 'OBV');
      }
      if (activeIndicators.includes('mfi')) {
        const mf = computeMFI(candleData, getParams('mfi').period);
        addLine(mf, '#c084fc', 1.5, 'mfi', null, `MFI ${getParams('mfi').period}`);
      }
      if (activeIndicators.includes('adx')) {
        const adxD = computeADX(candleData, getParams('adx').period);
        addLine(adxD, '#fbbf24', 1.5, 'adx', null, `ADX ${getParams('adx').period}`);
      }

      // ── AI Forecast (LSTM) overlay ──
      if (activeIndicators.includes('forecast_lstm') && forecastData && Array.isArray(forecastData.days) && forecastData.days.length > 0 && candleData.length > 0) {
        const lastBarLocal = candleData[candleData.length - 1];
        // candleData.time is either a unix-second number (intraday) or a YYYY-MM-DD string (EOD)
        const isNumericTime = typeof lastBarLocal.time === "number";
        const lastTimeSeconds = isNumericTime ? lastBarLocal.time : parseTime(lastBarLocal.time);

        const toSeriesTime = (secs) => {
          return isNumericTime ? secs : ensureDateString(secs);
        };

        const forecastLineData = [
          { time: lastBarLocal.time, value: lastBarLocal.close },
          ...forecastData.days.map((d, i) => ({
            time: toSeriesTime(lastTimeSeconds + (i + 1) * 86400),
            value: d.predicted_close,
          })),
        ];
        const upperBandData = [
          { time: lastBarLocal.time, value: lastBarLocal.close },
          ...forecastData.days.map((d, i) => ({
            time: toSeriesTime(lastTimeSeconds + (i + 1) * 86400),
            value: d.upper_band,
          })),
        ];
        const lowerBandData = [
          { time: lastBarLocal.time, value: lastBarLocal.close },
          ...forecastData.days.map((d, i) => ({
            time: toSeriesTime(lastTimeSeconds + (i + 1) * 86400),
            value: d.lower_band,
          })),
        ];

        const forecastUpper = addSeriesInPane(LineSeries, {
          color: 'rgba(34, 211, 238, 0.4)', lineWidth: 1, lineStyle: LineStyle.Dotted,
          title: '', lastValueVisible: false, priceLineVisible: false,
        }, 0);
        forecastUpper.setData(upperBandData);

        const forecastLower = addSeriesInPane(LineSeries, {
          color: 'rgba(34, 211, 238, 0.4)', lineWidth: 1, lineStyle: LineStyle.Dotted,
          title: '', lastValueVisible: false, priceLineVisible: false,
        }, 0);
        forecastLower.setData(lowerBandData);

        const forecastLine = addSeriesInPane(LineSeries, {
          color: '#22d3ee', lineWidth: 2, lineStyle: LineStyle.Dashed,
          title: '', lastValueVisible: true, priceLineVisible: false,
        }, 0);
        forecastLine.setData(forecastLineData);
      }

      // ── Apply pane stretch factors now that all series/panes are created ──
      applyPaneStretchFactors();

      // ── Legend Update Logic with Separators & Moving Averages ──
      const updateLegend = (time) => {
        if (!legendRef.current) return;
        
        const idx = candleData.findIndex(d => {
          if (typeof d.time === 'number' && typeof time === 'number') {
            return d.time === time;
          }
          const t1 = typeof d.time === 'string' ? d.time.split("T")[0] : String(d.time);
          const t2 = typeof time === 'string' ? time.split("T")[0] : String(time);
          return t1 === t2;
        });
        const bar = idx !== -1 ? candleData[idx] : candleData[candleData.length - 1];
        if (!bar) return;
        
        const prevBar = idx > 0 ? candleData[idx - 1] : null;
        
        const barTimeStr = typeof bar.time === 'number' ? formatBarTime(bar.time) : (typeof bar.time === 'string' ? bar.time.split("T")[0] : bar.time);
        const openVal = bar.open !== undefined ? bar.open.toFixed(2) : "--";
        const highVal = bar.high !== undefined ? bar.high.toFixed(2) : "--";
        const lowVal = bar.low !== undefined ? bar.low.toFixed(2) : "--";
        const closeVal = bar.close !== undefined ? bar.close.toFixed(2) : "--";
        const volumeVal = bar.volume !== undefined ? bar.volume.toLocaleString("en-IN") : "--";
        
        const change = prevBar ? (bar.close - prevBar.close) : (bar.close - bar.open);
        const pct = prevBar ? ((bar.close - prevBar.close) / prevBar.close * 100) : ((bar.close - bar.open) / bar.open * 100);
        const changeSign = change >= 0 ? "+" : "";
        const changeColor = change >= 0 ? "#089981" : "#ef5350";
        
        let legendHtml = `
          ${symbol} (${["D", "W", "M"].includes(activeTimeframe) ? (activeTimeframe === 'D' ? 'Daily' : activeTimeframe === 'W' ? 'Weekly' : 'Monthly') : activeTimeframe}) | 
          Date: ${barTimeStr} | 
          Open: <span style="font-weight: bold;">${openVal}</span> | 
          High: <span style="font-weight: bold;">${highVal}</span> | 
          Low: <span style="font-weight: bold;">${lowVal}</span> | 
          Close: <span style="font-weight: bold;">${closeVal}</span> | 
          Volume: <span style="font-weight: bold;">${volumeVal}</span>
        `;
        
        const findItemByTime = (arr, targetTime) => {
          if (!arr) return null;
          if (typeof targetTime === 'number') {
            return arr.find(d => d.time === targetTime);
          }
          const targetStr = typeof targetTime === 'string' ? targetTime.split("T")[0] : String(targetTime);
          return arr.find(d => {
            const t = typeof d.time === 'string' ? d.time.split("T")[0] : String(d.time);
            return t === targetStr;
          });
        };
        
        // 1. Custom MA Lines from maLines state
        for (const ma of maLines) {
          if (!ma.visible) continue;
          let maData = [];
          const p = parseInt(ma.period, 10) || 20;
          if (ma.type === 'SMA')  maData = computeSMA(candleData, p);
          else if (ma.type === 'EMA')  maData = computeEMA(candleData, p);
          else if (ma.type === 'WMA')  maData = computeWMA(candleData, p);
          else if (ma.type === 'DEMA') maData = computeDEMA(candleData, p);
          else if (ma.type === 'TEMA') maData = computeTEMA(candleData, p);
          else if (ma.type === 'HMA')  maData = computeHMA(candleData, p);
          else if (ma.type === 'VWAP') maData = computeVWAP(candleData);
          else if (ma.type === 'BB') {
            const bbData = computeBB(candleData, p);
            const bbItem = findItemByTime(bbData, bar.time);
            if (bbItem) {
              legendHtml += ` | <span style="color: ${ma.color}; font-weight: bold;">BB(${p}):</span> U ${bbItem.upper.toFixed(2)} M ${bbItem.middle.toFixed(2)} L ${bbItem.lower.toFixed(2)}`;
            }
            continue;
          }
          
          const maItem = findItemByTime(maData, bar.time);
          const maVal = maItem ? (maItem.value ?? maItem).toFixed(2) : "--";
          legendHtml += ` | <span data-ma="${ma.id}" title="Click to edit" style="color: ${ma.color}; font-weight: bold; cursor: pointer;">${ma.type}(${p}):</span> ${maVal}`;
        }

        // 2. Preset active indicator MAs — live params + click-to-edit
        [['sma20', 'SMA', '#f59e0b'], ['sma44', 'SMA', '#ef4444'], ['sma50', 'SMA', '#a78bfa'],
         ['sma200', 'SMA', '#3b82f6'], ['ema9', 'EMA', '#06b6d4'], ['ema20', 'EMA', '#fb923c'],
         ['ema50', 'EMA', '#c084fc']].forEach(([iid, kind, defCol]) => {
          if (!activeIndicators.includes(iid)) return;
          const p = getParams(iid).period;
          const data = kind === 'SMA' ? computeSMA(candleData, p) : computeEMA(candleData, p);
          const item = findItemByTime(data, bar.time);
          legendHtml += ` | <span data-ind="${iid}" title="Click to edit" style="color: ${getCol(iid, defCol)}; font-weight: bold; cursor: pointer;">${kind}(${p}):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        });
        if (activeIndicators.includes('vwap')) {
          const item = findItemByTime(computeVWAP(candleData), bar.time);
          legendHtml += ` | <span style="color: ${getCol('vwap', '#60a5fa')}; font-weight: bold;">VWAP:</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        
        legendHtml += `
          <br />
          <span style="font-size: 19px; font-weight: 800; color: var(--text-color); letter-spacing: 0.2px;">${symbol}</span>
          <span style="font-size: 19px; font-weight: 800; color: ${changeColor}; margin-left: 10px;">${closeVal}</span>
          <span style="font-size: 11.5px; font-weight: 700; color: ${changeColor}; background: ${change >= 0 ? 'rgba(8,153,129,0.15)' : 'rgba(239,83,80,0.15)'}; padding: 2px 8px; border-radius: 10px; margin-left: 8px; vertical-align: 2px;">${changeSign}${pct.toFixed(2)}%</span>
        `;
        
        legendRef.current.innerHTML = legendHtml;
      };

      // Initial draw
      updateLegend(candleData[candleData.length - 1]?.time);

      // Restore visible logical range if it was preserved to maintain zoom/scroll
      if (visibleLogicalRange) {
        try {
          chart.timeScale().setVisibleLogicalRange(visibleLogicalRange);
        } catch (e) {}
      } else if (candleData.length > 0) {
        try {
          // Default to showing the last 150 bars on initial load so candles are readable
          const toIdx = candleData.length - 1;
          const fromIdx = Math.max(0, toIdx - 150);
          chart.timeScale().setVisibleLogicalRange({
            from: fromIdx,
            to: toIdx + 3,
          });
        } catch (e) {}
      }

      // ── Pattern Overlay (clicked from the Patterns screener) ──
      if (activePattern && activePattern.symbol === symbol && activePattern.key_points?.pivots?.length) {
        const pivots = activePattern.key_points.pivots
          .filter(pv => pv.time)
          .map(pv => ({ time: pv.time, value: pv.price }))
          .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

        const isBearishPattern = BEARISH_PATTERNS.has(activePattern.pattern_type);
        const patternColor = isBearishPattern ? '#CC0000' : '#008800';

        if (pivots.length >= 2) {
          const patternLine = addSeriesInPane(LineSeries, {
            color: patternColor,
            lineWidth: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
            title: activePattern.pattern_type?.replace(/_/g, " "),
          }, 0);
          patternLine.setData(pivots);

          const patternMarkers = createSeriesMarkers(patternLine);
          patternMarkers.setMarkers(pivots.map(pv => ({
            time: pv.time,
            position: 'inBar',
            color: patternColor,
            shape: 'circle',
            size: 1,
          })));

          // Snap the visible range to the pattern the first time it loads,
          // without fighting the user's zoom on later re-renders.
          if (patternFitRef.current !== activePattern.id) {
            patternFitRef.current = activePattern.id;
            try {
              const firstIdx = candleData.findIndex(c => c.time === pivots[0].time);
              const lastIdx = candleData.findIndex(c => c.time === pivots[pivots.length - 1].time);
              if (firstIdx !== -1 && lastIdx !== -1) {
                const pad = Math.max(5, Math.round((lastIdx - firstIdx) * 0.25));
                chart.timeScale().setVisibleLogicalRange({
                  from: Math.max(0, firstIdx - pad),
                  to: Math.min(candleData.length - 1, lastIdx + pad),
                });
              }
            } catch (e) {}
          }
        }

        if (activePattern.target_price != null) {
          candleSeries.createPriceLine({
            price: activePattern.target_price,
            color: '#008800',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Pattern Target',
          });
        }
        if (activePattern.stop_loss != null) {
          candleSeries.createPriceLine({
            price: activePattern.stop_loss,
            color: '#CC0000',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Pattern Stop',
          });
        }
      }

      // Subscribe to hover crosshair moves
      chart.subscribeCrosshairMove(param => {
        if (!param.time || param.point === undefined) {
          updateLegend(candleData[candleData.length - 1]?.time);
        } else {
          updateLegend(param.time);
        }
      });

      // Re-assert tight pane packing after the chart lays out. Uses stretch
      // factors (which fill 100% with no gaps) instead of absolute setHeight,
      // which previously left an empty pane at the bottom.
      setTimeout(applyPaneStretchFactors, 30);

      const handleResize = () => {
        if (chartRef.current && chart) {
          chart.applyOptions({ width: chartRef.current.clientWidth, height: chartRef.current.clientHeight });
          applyPaneStretchFactors();
        }
      };
      window.addEventListener("resize", handleResize);
      // Container can resize without a window resize (e.g. dashboard sidebar collapse)
      const resizeObserver = new ResizeObserver(handleResize);
      if (chartRef.current) resizeObserver.observe(chartRef.current);
      return () => {
         window.removeEventListener("resize", handleResize);
         resizeObserver.disconnect();
         layoutTimers.forEach(clearTimeout);
         if (chart) {
            try { chart.remove(); } catch(e) {}
         }
         chartInstance.current = null;
      };
    };

    const cleanup = initChart();
    return () => {
       cleanup.then(clean => { if(clean) clean(); });
    };
  }, [chartData, activeTimeframe, activeMainTab, activeIndicators, maLines, indicatorParams, indicatorStyles, priceScaleMode, activeBottomTab, chartStyle, isDarkMode, activePattern, forecastData]);

  const selectSymbol = (sym) => {
    setSymbol(sym);
  };

  // Rows currently shown in the sidebar list, in display order. Single source
  // of truth for both the rendered rows and ↑/↓ navigation, so the two can't
  // disagree about what "the next stock" is.
  const visibleRows = useMemo(() => {
    const q = searchQuery.toLowerCase();
    if (sidebarTab === "sectors") {
      return (INDICES[activeSector] || []).slice(1)
        .filter((s) => s.toLowerCase().includes(q))
        .map((s) => ({ symbol: s, item: watchlistData.find((w) => w.symbol === s) }));
    }
    if (sidebarTab === "personal") {
      return myWatchlist.filter((w) => w.symbol.toLowerCase().includes(q))
        .map((w) => ({ symbol: w.symbol, item: w }));
    }
    return [];
  }, [sidebarTab, activeSector, searchQuery, watchlistData, myWatchlist]);

  const moveCursor = useCallback((delta) => {
    if (!visibleRows.length) return;
    const cur = visibleRows.findIndex((r) => r.symbol === symbol);
    // Nothing charted from this list yet: ↓ starts at the top, ↑ at the bottom.
    const next = cur < 0
      ? (delta > 0 ? 0 : visibleRows.length - 1)
      : Math.min(visibleRows.length - 1, Math.max(0, cur + delta));  // clamp, don't wrap
    const row = visibleRows[next];
    if (!row) return;
    setSymbol(row.symbol);               // arrows load the chart directly
    requestAnimationFrame(() => {
      listBoxRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }, [visibleRows, symbol]);

  const onListKeyDown = useCallback((e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); }
  }, [moveCursor]);

  // Keep the chart in sync when the URL ?symbol= changes while already on this
  // page — e.g. picking a stock from the top-bar search doesn't remount us.
  useEffect(() => {
    const urlSym = searchParams.get("symbol")?.toUpperCase();
    if (urlSym && urlSym !== symbol) setSymbol(urlSym);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Result navigator: flip through a scan's matches on the chart ──
  const startResultNav = (matches, startIndex = 0, label = "Scan results") => {
    const symbols = (matches || []).map(m => m && m.symbol).filter(Boolean);
    if (symbols.length === 0) return;
    const idx = Math.min(Math.max(startIndex, 0), symbols.length - 1);
    setResultNav({ symbols, index: idx, label });
    selectSymbol(symbols[idx]);
    // close scan panels so the chart is fully visible
    setShowCustomQuery(false);
    setShowScanHistory(false);
  };

  // Cross-page handoff: other pages (e.g. Scan Assistant) drop their results in
  // sessionStorage and navigate here; we pick them up and start stepping through.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("chartix_result_nav");
      if (!raw) return;
      sessionStorage.removeItem("chartix_result_nav"); // consume once
      const { matches, label, index } = JSON.parse(raw);
      if (Array.isArray(matches) && matches.length) {
        startResultNav(matches, index || 0, label || "Scan results");
      }
    } catch (e) { /* malformed handoff — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navResult = (delta) => {
    setResultNav(prev => {
      if (!prev) return prev;
      const n = prev.symbols.length;
      const next = (prev.index + delta + n) % n; // wrap around
      selectSymbol(prev.symbols[next]);
      return { ...prev, index: next };
    });
  };

  const closeResultNav = () => setResultNav(null);

  // Arrow-key navigation while the navigator is active
  useEffect(() => {
    if (!resultNav) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); navResult(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); navResult(-1); }
      else if (e.key === "Escape") { closeResultNav(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resultNav]);

  const runCustomQuery = async () => {
    setQueryLoading(true);
    try {
      let conditions = [];
      if (queryParam === "sma_cross") {
        conditions = [{
          indicator: "sma",
          params: { period: 20 },
          operator: "crosses_above",
          compare_to: { indicator: "sma", params: { period: 50 } }
        }];
      } else if (queryParam === "rsi_oversold") {
        conditions = [{
          indicator: "rsi",
          params: { period: 14 },
          operator: "lt",
          value: 30
        }];
      } else if (queryParam === "volume_spike") {
        conditions = [{
          indicator: "volume",
          operator: "gt",
          value: 1000000
        }];
      } else if (queryParam === "double_bottom") {
         // Pattern scans aren't standard mathematical indicators, but we can mock or do price comparison
         conditions = [{
           indicator: "price",
           operator: "gt",
           value: 0
         }];
      } else if (queryParam === "lifetime_high") {
         conditions = [{
           indicator: "price",
           operator: "gte",
           compare_to: { indicator: "high_n", params: { n: 252 } }
         }];
      } else if (queryParam === "price_ma_cross") {
         conditions = [{
           indicator: "price",
           operator: "crosses_above",
           compare_to: { indicator: "sma", params: { period: 20 } }
         }];
      } else if (queryParam === "macd_divergence") {
         conditions = [{
           indicator: "macd",
           params: { fast: 12, slow: 26, component: "macd" },
           operator: "crosses_above",
           compare_to: { indicator: "macd", params: { fast: 12, slow: 26, component: "signal" } }
         }];
      } else if (queryParam === "ma_slope") {
         conditions = [{
           indicator: "slope",
           params: { of: "sma", of_params: { period: 20 }, period: 5 },
           operator: "gt",
           value: 0
         }];
      } else if (queryParam === "candle_pattern") {
         conditions = [{
           indicator: "engulfing",
           operator: "eq",
           value: 1
         }];
      } else if (queryParam === "price_vol_gainers") {
         conditions = [
           { indicator: "price", operator: "slope_up", params: { slope_period: 1 } },
           { indicator: "volume", operator: "slope_up", params: { slope_period: 1 } }
         ];
      } else if (queryParam === "combine_scans") {
         conditions = [
           { indicator: "rsi", params: { period: 14 }, operator: "gt", value: 60 },
           { indicator: "macd", params: { fast: 12, slow: 26, component: "macd" }, operator: "gt", value: 0 }
         ];
      } else if (queryParam === "breakout") {
         conditions = [{
           indicator: "price",
           operator: "crosses_above",
           compare_to: { indicator: "high_n", params: { n: 20 } }
         }];
      } else if (queryParam === "pullback") {
         conditions = [
           { indicator: "price", operator: "lt", compare_to: { indicator: "sma", params: { period: 20 } } },
           { indicator: "price", operator: "gt", compare_to: { indicator: "sma", params: { period: 50 } } }
         ];
      } else if (queryParam === "supertrend_buy") {
         conditions = [{
           indicator: "supertrend",
           params: { period: 10, multiplier: 3.0, component: "trend" },
           operator: "eq",
           value: 1
         }];
      } else if (queryParam === "supertrend_sell") {
         conditions = [{
           indicator: "supertrend",
           params: { period: 10, multiplier: 3.0, component: "trend" },
           operator: "eq",
           value: -1
         }];
      } else if (queryParam === "bb_squeeze") {
         conditions = [{
           indicator: "bbands",
           params: { period: 20, std_dev: 2.0, component: "bandwidth" },
           operator: "lt",
           value: 0.05
         }];
      } else if (queryParam === "adx_trend") {
         conditions = [{
           indicator: "adx",
           params: { period: 14, component: "adx" },
           operator: "gt",
           value: 25
         }];
      } else if (queryParam === "golden_cross") {
         conditions = [{
           indicator: "sma",
           params: { period: 50 },
           operator: "crosses_above",
           compare_to: { indicator: "sma", params: { period: 200 } }
         }];
      } else if (queryParam === "death_cross") {
         conditions = [{
           indicator: "sma",
           params: { period: 50 },
           operator: "crosses_below",
           compare_to: { indicator: "sma", params: { period: 200 } }
         }];
      } else if (queryParam === "rsi_overbought") {
         conditions = [{
           indicator: "rsi",
           params: { period: 14 },
           operator: "gt",
           value: 70
         }];
      } else if (queryParam === "nr7") {
         conditions = [{ indicator: "nr7", params: {}, operator: "eq", value: 1 }];
      } else if (queryParam === "inside_bar") {
         conditions = [{ indicator: "inside_bar", params: {}, operator: "eq", value: 1 }];
      } else if (queryParam === "hammer") {
         conditions = [{ indicator: "hammer", params: {}, operator: "eq", value: 1 }];
      } else if (queryParam === "gap_up") {
         conditions = [{ indicator: "gap_up", params: { min_percent: 1.0 }, operator: "eq", value: 1 }];
      }

      // Scope the scan to the selected Index/Sector (its constituents only).
      // INDICES[activeSector][0] is the backend index symbol (e.g. "NIFTY_50").
      const scanIndex = (INDICES[activeSector] || [])[0];
      // Single round-trip (the API client auto-retries transient network errors)
      const res = await api.previewScan(conditions, "AND", undefined, scanIndex);
      setQueryMatches(res.matches || []);
    } catch (e) {
      console.error(e);
      if (e instanceof TypeError) {
        alert("Could not reach the API server at " + (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000") + ".\nMake sure the backend is running, then try again.");
      } else {
        alert("Error running query: " + e.message);
      }
    } finally {
      setQueryLoading(false);
    }
  };

  const openScanHistory = async () => {
    setShowScanHistory(true);
    setSelectedHistory(null);
    setHistoryLoading(true);
    try {
      const rows = await api.getScanHistory({ limit: 50, includeMatches: true });
      setScanHistory(rows || []);
    } catch (e) {
      console.error(e);
      alert("Could not load scan history: " + (e.message || e));
    } finally {
      setHistoryLoading(false);
    }
  };

  const fmtHistoryTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  };

  const summarizeHistoryParams = (p) => {
    if (!p || typeof p !== "object") return "";
    if (Array.isArray(p.conditions)) {
      return p.conditions.map(c => `${c.indicator || "?"} ${c.operator || ""}`.trim()).join(" & ");
    }
    return Object.entries(p)
      .filter(([k, v]) => v !== null && v !== undefined && v !== "" && !["sector"].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  };

  const runMAAnalysis = async () => {
    setMALoading(true);
    try {
      let condition = {};
      if (maConfig.compareType === "price") {
        condition = {
           indicator: "price",
           operator: maConfig.operator,
           compare_to: { indicator: maConfig.type, params: { period: parseInt(maConfig.period1) } }
        };
      } else {
        condition = {
           indicator: maConfig.type,
           params: { period: parseInt(maConfig.period1) },
           operator: maConfig.operator,
           compare_to: { indicator: maConfig.type, params: { period: parseInt(maConfig.period2) } }
        };
      }

      const scanIndex = (INDICES[activeSector] || [])[0];
      const res = await api.previewScan([condition], "AND", undefined, scanIndex);
      setMAMatches(res.matches || []);
    } catch (e) {
      console.error(e);
      if (e instanceof TypeError) {
        alert("Could not reach the API server. Make sure the backend is running, then try again.");
      } else {
        alert("Error running MA scan: " + e.message);
      }
    } finally {
      setMALoading(false);
    }
  };

  const handleUpdateData = async () => {
    setDataFeedStatus("Connecting to Server...");
    try {
      setDataFeedStatus("Downloading EOD Bhavcopy from NSE...");
      await api.triggerSyncData();

      // The actual download + pattern/trendline scan runs for a few
      // minutes in the background — poll status instead of pretending
      // it's done right away.
      setDataFeedStatus("Scanning patterns & trendlines...");
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const { in_progress } = await api.getSyncStatus();
        if (!in_progress) break;
      }

      setDataFeedStatus("Update Complete");
      loadWatchlist();
      setTimeout(() => {
        setDataFeedStatus(null);
        loadChart(symbol, activeTimeframe);
      }, 1500);
    } catch (e) {
      if (e.status === 409) {
        setDataFeedStatus("Sync already running — please wait...");
      } else {
        console.warn("EOD sync failed:", e);
        setDataFeedStatus("Update Failed");
      }
      setTimeout(() => setDataFeedStatus(null), 3000);
    }
  };

  const lastBar = chartData.length > 0 ? chartData[chartData.length - 1] : null;

  const getStockDetails = () => {
    if (chartData.length === 0) return null;
    const currentBar = chartData[chartData.length - 1];
    const prevBar = chartData.length > 1 ? chartData[chartData.length - 2] : null;
    
    const openVal = currentBar.open;
    const highVal = currentBar.high;
    const lowVal = currentBar.low;
    const closeVal = currentBar.close;
    const volumeVal = currentBar.volume;
    
    const change = prevBar ? (closeVal - prevBar.close) : (closeVal - openVal);
    const pct = prevBar ? ((closeVal - prevBar.close) / prevBar.close * 100) : ((closeVal - openVal) / openVal * 100);
    const changeText = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${change >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    const isUp = change >= 0;
    
    return {
      open: openVal.toFixed(2),
      high: highVal.toFixed(2),
      low: lowVal.toFixed(2),
      close: closeVal.toFixed(2),
      volume: volumeVal.toLocaleString("en-IN"),
      changeText,
      isUp,
      symbol
    };
  };

  return (
    <div className={`${styles.keystockApp} ${isDarkMode ? styles.darkMode : ''}`}>

      {/* Scan-results navigator — flip through every match from a scanner */}
      {scanList && (
        <div className={styles.scanNavPill} style={{
          position: "fixed", top: 84, left: "50%", transform: "translateX(-50%)", zIndex: 600,
          display: "flex", alignItems: "center", gap: 8,
          background: "rgba(19,23,34,0.96)", border: "1px solid rgba(41,98,255,0.45)",
          borderRadius: 24, padding: "6px 12px", boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        }}>
          <span style={{ fontSize: "0.68rem", color: "#9ca3af", fontWeight: 700, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            📋 {scanList.label}
          </span>
          <button onClick={() => scanGo(-1)} disabled={scanIdx <= 0}
            style={{ background: "transparent", border: "1px solid #2962ff66", color: scanIdx <= 0 ? "#4b5563" : "#e5e7eb", borderRadius: 8, padding: "3px 10px", cursor: scanIdx <= 0 ? "default" : "pointer", fontWeight: 800 }}>◀</button>
          <span style={{ fontSize: "0.78rem", fontWeight: 800, color: "#e5e7eb", minWidth: 96, textAlign: "center" }}>
            {symbol} · {(scanIdx < 0 ? 0 : scanIdx + 1)}/{scanList.symbols.length}
          </span>
          <button onClick={() => scanGo(1)} disabled={scanIdx >= scanList.symbols.length - 1}
            style={{ background: "transparent", border: "1px solid #2962ff66", color: scanIdx >= scanList.symbols.length - 1 ? "#4b5563" : "#e5e7eb", borderRadius: 8, padding: "3px 10px", cursor: scanIdx >= scanList.symbols.length - 1 ? "default" : "pointer", fontWeight: 800 }}>▶</button>
          <button onClick={dismissScanList} title="Close scan list"
            style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", fontWeight: 800, fontSize: "0.9rem", padding: "0 2px" }}>✕</button>
        </div>
      )}




      {/* Main Body */}
      <div className={styles.mainBody}>
        

        {/* Left Column 2: Drawing Tools Sidebar */}
        <div className={styles.leftSidebar}>
          <div 
            className={`${styles.drawIcon} ${activeTool === null ? styles.drawIconActive : ''}`} 
            title="Select" 
            onClick={() => { setActiveTool(null); }}
            style={{ color: "var(--text-color)" }}
          >
            ↖
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'text' ? styles.drawIconActive : ''}`} 
            title="Text" 
            onClick={() => { setActiveTool('text'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            A
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'hline' ? styles.drawIconActive : ''}`} 
            title="Horizontal Line" 
            onClick={() => { setActiveTool('hline'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            —
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'vline' ? styles.drawIconActive : ''}`} 
            title="Vertical Line" 
            onClick={() => { setActiveTool('vline'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            |
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'trendline' ? styles.drawIconActive : ''}`} 
            title="Trendline" 
            onClick={() => { setActiveTool('trendline'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            /
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'ray' ? styles.drawIconActive : ''}`} 
            title="Extended Line" 
            onClick={() => { setActiveTool('ray'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            ⤡
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'channel' ? styles.drawIconActive : ''}`} 
            title="Parallel Channel" 
            onClick={() => { setActiveTool('channel'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            //
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'fibonacci' ? styles.drawIconActive : ''}`} 
            title="Fibonacci" 
            onClick={() => { setActiveTool('fibonacci'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            ≡
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'pitchfork' ? styles.drawIconActive : ''}`} 
            title="Pitchfork" 
            onClick={() => { setActiveTool('pitchfork'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
            style={{ color: "var(--text-color)" }}
          >
            ⋔
          </div>
          <div className={styles.drawIcon} title="Clear" onClick={() => { setDrawings([]); setActiveTool(null); }} style={{ color: "var(--text-color)" }}>🗑️</div>
        </div>
        {/* Chart column — toolbar, chart, nav bar together so the right
            sidebar (sibling below) runs full window height. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Main Menu Bar */}
      <div className={styles.menuBar}>
        {/* Symbol Search Input */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "14px", fontWeight: "bold" }}>🔍</span>
          <input
            type="text"
            value={headerSymbol}
            onChange={(e) => setHeaderSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (headerSymbol) {
                  selectSymbol(headerSymbol);
                }
              }
            }}
            placeholder="Symbol..."
            style={{
              padding: "4px 8px",
              fontSize: "12px",
              fontWeight: "bold",
              border: "1px solid var(--border-color)",
              borderRadius: "4px",
              background: "var(--input-bg)",
              color: "var(--text-color)",
              width: "100px",
              outline: "none"
            }}
          />
          {symbol && (
            <button
              onClick={() => toggleWatchlist(symbol)}
              style={{
                background: "none",
                border: "none",
                fontSize: "15px",
                cursor: "pointer",
                color: myWatchlist.some(w => w.symbol === symbol) ? "#ffb600" : "var(--text-color-muted)",
                outline: "none",
                padding: "2px 4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
              }}
              title={myWatchlist.some(w => w.symbol === symbol) ? "Remove from watchlist" : "Add to watchlist"}
            >
              {myWatchlist.some(w => w.symbol === symbol) ? "★" : "☆"}
            </button>
          )}
        </div>

        {/* Timeframe Selector (Segmented Button Group) */}
        <div style={{
          display: "flex",
          border: "1px solid var(--border-color)",
          borderRadius: "4px",
          overflow: "hidden",
          background: "var(--input-bg)",
          height: "26px",
          alignItems: "center",
          margin: "0 4px",
          flexShrink: 0
        }}>
          {[
                { label: "D", full: "Daily" },
                { label: "W", full: "Weekly" },
                { label: "M", full: "Monthly" },
              ].map((tf, index, arr) => (
            <button
              key={tf.label}
              onClick={() => handleTimeframeChange(tf.label)}
              title={tf.full}
              style={{
                border: "none",
                borderRight: index < arr.length - 1 ? "1px solid var(--border-color)" : "none",
                background: activeTimeframe === tf.label ? "#2962ff" : "transparent",
                color: activeTimeframe === tf.label ? "#fff" : "var(--text-color)",
                padding: "2px 8px",
                fontSize: "11px",
                fontWeight: activeTimeframe === tf.label ? "bold" : "normal",
                cursor: "pointer",
                outline: "none",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* Price scale mode: Auto / Log / % */}
        <div style={{
          display: "flex", border: "1px solid var(--border-color)", borderRadius: "4px",
          overflow: "hidden", background: "var(--input-bg)", height: "26px",
          alignItems: "center", margin: "0 4px", flexShrink: 0
        }}>
          {[{ mode: 0, label: "Auto", title: "Linear price scale" },
            { mode: 1, label: "Log", title: "Logarithmic price scale" },
            { mode: 2, label: "%", title: "Percentage price scale" }].map((m, i, arr) => (
            <button key={m.mode} onClick={() => setPriceScaleMode(m.mode)} title={m.title}
              style={{
                border: "none",
                borderRight: i < arr.length - 1 ? "1px solid var(--border-color)" : "none",
                background: priceScaleMode === m.mode ? "#2962ff" : "transparent",
                color: priceScaleMode === m.mode ? "#fff" : "var(--text-color)",
                padding: "2px 8px", fontSize: "11px",
                fontWeight: priceScaleMode === m.mode ? "bold" : "normal",
                cursor: "pointer", outline: "none", height: "100%",
                display: "flex", alignItems: "center", justifyContent: "center"
              }}>
              {m.label}
            </button>
          ))}
        </div>

        {/* Named layout manager: save / rename / copy / load / delete */}
        <div className={styles.menuItem} style={{ position: "relative" }}
          onClick={(e) => { e.stopPropagation(); setLayoutMenuOpen(v => !v); }}
          title="Manage saved chart layouts">
          <span>🗂</span> {layoutName} {layoutSavedTick ? <span style={{ color: "#10b981", marginLeft: 4 }}>✓ saved</span> : "▾"}
          {layoutMenuOpen && (
            <div onClick={(e) => e.stopPropagation()} style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 400,
              background: "var(--panel-bg)", border: "1px solid var(--border-color)",
              borderRadius: 8, minWidth: 220, boxShadow: "0 10px 26px rgba(0,0,0,0.45)",
              fontSize: 12, color: "var(--text-color)", overflow: "hidden",
            }}>
              <div onClick={() => { saveLayout(); setLayoutMenuOpen(false); }}
                style={{ padding: "9px 14px", cursor: "pointer", borderBottom: "1px solid var(--border-color)" }}>
                💾 Save layout <span style={{ opacity: 0.55, float: "right" }}>current: {layoutName}</span>
              </div>
              <div onClick={() => { saveLayoutAs(); setLayoutMenuOpen(false); }}
                style={{ padding: "9px 14px", cursor: "pointer" }}>Make a copy…</div>
              <div onClick={() => { renameLayout(); setLayoutMenuOpen(false); }}
                style={{ padding: "9px 14px", cursor: "pointer", borderBottom: "1px solid var(--border-color)" }}>Rename…</div>
              <div style={{ padding: "7px 14px 3px", fontSize: 10, opacity: 0.6 }}>LOAD LAYOUT</div>
              {layoutNames.length === 0 && (
                <div style={{ padding: "6px 14px 10px", opacity: 0.55 }}>No saved layouts yet — hit Save layout.</div>
              )}
              {layoutNames.map(n => (
                <div key={n} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 14px", cursor: "pointer", background: n === layoutName ? "var(--menu-hover)" : "transparent" }}>
                  <span onClick={() => loadLayout(n)} style={{ flex: 1 }}>{n === layoutName ? "● " : ""}{n}</span>
                  <span title="Delete" onClick={() => deleteLayout(n)} style={{ opacity: 0.6, padding: "0 4px", cursor: "pointer" }}>✕</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Screenshot export */}
        <div className={styles.menuItem} title="Download chart snapshot as PNG"
          onClick={() => {
            const c = chartInstance.current;
            if (!c) return;
            try {
              const canvas = c.takeScreenshot();
              const a = document.createElement("a");
              a.download = `${symbol}_${activeTimeframe}_chart.png`;
              a.href = canvas.toDataURL("image/png");
              a.click();
            } catch (e) { console.warn("Screenshot failed:", e); }
          }}>
          <span>📷</span> Snapshot
        </div>

        {/* Chart Style Selector */}
        <div 
          className={styles.menuItem} 
          style={{position: "relative"}} 
          onClick={(e) => {
            e.stopPropagation();
            setShowStyleMenu(!showStyleMenu);
          }}
        >
          <span>🕯️</span> {CHART_STYLES.find(s => s.id === chartStyle)?.label || "Candles"} ▾
          {showStyleMenu && (
            <div className={styles.dropdownMenu}>
              {CHART_STYLES.map(styleOpt => (
                <div
                  key={styleOpt.id}
                  className={`${styles.dropdownItem} ${chartStyle === styleOpt.id ? styles.dropdownActive : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setChartStyle(styleOpt.id);
                    setShowStyleMenu(false);
                  }}
                >
                  <span>{styleOpt.icon}</span> {styleOpt.label}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Indicators Trigger */}
        <div 
          className={styles.menuItem} 
          onClick={(e) => {
            e.stopPropagation();
            if (toolMenu) {
              setToolMenu(null);
            } else {
              setToolMenu({ x: 250, y: 80 });
              setMenuTab('indicators');
            }
          }}
          title="Add or remove technical indicators (Double-click chart as shortcut)"
        >
          <span>📊</span> Indicators
        </div>

        {/* Scans — one dropdown instead of three separate cryptic entries */}
        <div className={styles.menuItem} style={{ position: "relative" }}
          onClick={(e) => { e.stopPropagation(); setScansMenuOpen(v => !v); }}
          title="Run market scans from the chart">
          <span>🔎</span> Scans ▾
          {scansMenuOpen && (
            <div onClick={(e) => e.stopPropagation()} style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 400,
              background: "var(--panel-bg)", border: "1px solid var(--border-color)",
              borderRadius: 8, minWidth: 220, boxShadow: "0 10px 26px rgba(0,0,0,0.45)",
              fontSize: 12, color: "var(--text-color)", overflow: "hidden",
            }}>
              <div onClick={() => { setShowCustomQuery(true); setScansMenuOpen(false); }}
                style={{ padding: "9px 14px", cursor: "pointer" }}>🧪 Query Builder <span style={{ opacity: 0.55 }}>— 22 ready scans</span></div>
              <div onClick={() => { setShowAnalysisSearch(true); setScansMenuOpen(false); }}
                style={{ padding: "9px 14px", cursor: "pointer" }}>🔍 Analysis Search</div>
              <div onClick={() => { setShowMAAnalysis(true); setScansMenuOpen(false); }}
                style={{ padding: "9px 14px", cursor: "pointer" }}>📊 Moving Average Scan</div>
            </div>
          )}
        </div>
        <div className={styles.menuItem} onClick={() => setShowAlerts(true)}><span>🔔</span> Alerts</div>
        <div className={styles.menuItem} onClick={() => setShowSettings(true)}><span>⚙️</span> Settings</div>
        
        {/* Update Data */}
        <div className={styles.menuItem} onClick={handleUpdateData}>
          <span>🔄</span> Sync EOD
        </div>

        {/* Bar scroll controller */}
        <div style={{display:"flex", alignItems:"center", gap:"4px"}}>
           <button
             title="Go to bar"
             style={{borderRadius: "50%", background:"#000", color:"#FFF", width:"20px", height:"20px", fontSize: "10px", cursor:"pointer", border:"none"}}
             onClick={() => {
               if (chartInstance.current) {
                 try { chartInstance.current.timeScale().scrollToPosition(-parseInt(chartBars || 50, 10), false); } catch(e) {}
               }
             }}
           >▶</button>
           <input
             type="text"
             value={chartBars}
             onChange={e => setChartBars(e.target.value)}
             title="Number of bars to scroll back"
             style={{width:"25px", background: "var(--input-bg)", color: "var(--text-color)", border: "1px solid var(--border-color)", textAlign: "center", fontSize: "10px"}}
           />
           <button
              title="Fit all data"
              style={{borderRadius: "10px", padding: "0 8px", background:"#000", color:"#FFF", height:"20px", fontSize: "10px", cursor:"pointer", border:"none", fontWeight: "bold"}}
              onClick={() => {
                if (chartInstance.current) {
                  try { chartInstance.current.timeScale().fitContent(); } catch(e) {}
                }
              }}
            >ALL</button>
        </div>

        {/* Theme Toggle Button on the Right */}
        <div className={styles.themeToggleBtn} style={{ marginLeft: "auto", display: "flex", alignItems: "center" }} onClick={() => setIsDarkMode(!isDarkMode)} title="Toggle Light/Dark Theme">
          {isDarkMode ? "☀️" : "🌙"}
        </div>
      </div>

        {/* Center: Chart Area */}
        <div
          ref={chartWrapRef}
          className={styles.chartArea}
          style={{display: "flex", flexDirection: "column", backgroundColor: isDarkMode ? "#0f1117" : "#FFFFFF", position: "relative"}}
        >
          {activeMainTab === "Main" ? (
            <>
              {/* Legend content is owned exclusively by the chart's imperative
                  updateLegend() (innerHTML writes). It must have NO React
                  children — mixing them causes insertBefore NotFoundError
                  crashes when React reconciles nodes innerHTML destroyed. */}
              <div className={styles.chartInfoText}
                onClick={(e) => {
                  const indId = e.target?.dataset?.ind;
                  if (indId) { setEditingIndicator(prev => prev === indId ? null : indId); return; }
                  const maId = e.target?.dataset?.ma;
                  if (maId) setEditingIndicator(prev => prev === `ma:${maId}` ? null : `ma:${maId}`);
                }}>
                <div ref={legendRef} />
              </div>
              {activePattern && activePattern.symbol === symbol && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
                  background: BEARISH_PATTERNS.has(activePattern.pattern_type) ? "#FFE0E0" : "#E0FFE5",
                  borderBottom: "1px solid var(--border-color)", fontSize: 12, fontWeight: "bold",
                  color: BEARISH_PATTERNS.has(activePattern.pattern_type) ? "#990000" : "#006600",
                }}>
                  <span>
                    Showing pattern: {activePattern.pattern_type?.replace(/_/g, " ")}
                    {" "}({activePattern.confidence != null ? `${(activePattern.confidence * 100).toFixed(0)}% confidence` : "—"})
                  </span>
                  <span
                    style={{ cursor: "pointer", marginLeft: "auto", fontWeight: "normal" }}
                    onClick={() => setActivePattern(null)}
                  >
                    ✕ Clear
                  </span>
                </div>
              )}

              {/* Lightweight chart */}
              <div style={{ flex: 1, width: "100%", position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
                <div ref={chartRef} style={{ flex: 1, width: "100%", outline: "none", minHeight: 0 }} />

                {/* Active indicator legend — edit / replace / remove (below the price readout) */}
                <div style={{ position: "absolute", top: 56, left: 6, zIndex: 30, display: "flex", flexDirection: "column", gap: 3, pointerEvents: "none" }}>
                  {(() => {
                    const legendCount = INDICATOR_GROUPS.flatMap(g => g.items).filter(ind => activeIndicators.includes(ind.id)).length + maLines.length;
                    if (legendCount === 0) return null;
                    return (
                      <div style={{ pointerEvents: "auto" }}>
                        <div onClick={() => { setLegendCollapsed(v => !v); setEditingIndicator(null); }}
                          title={legendCollapsed ? "Show indicators" : "Hide indicators"}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 4,
                            background: isDarkMode ? "rgba(19,23,34,0.85)" : "rgba(255,255,255,0.88)",
                            border: "1px solid var(--border-color)", borderRadius: 4,
                            padding: "2px 8px", fontSize: 11, color: "var(--text-color)",
                            cursor: "pointer", userSelect: "none",
                          }}>
                          <span style={{ fontSize: 10 }}>{legendCollapsed ? "⌄" : "⌃"}</span>
                          {legendCollapsed && <span>{legendCount}</span>}
                        </div>
                      </div>
                    );
                  })()}
                  {!legendCollapsed && INDICATOR_GROUPS.flatMap(g => g.items).filter(ind => activeIndicators.includes(ind.id)).map(ind => {
                    const p = indicatorParams[ind.id];
                    const paramText = p ? Object.values(p).join(" ") : "";
                    const isEditing = editingIndicator === ind.id;
                    return (
                      <div key={ind.id} style={{ position: "relative", pointerEvents: "auto" }}>
                        <div style={{
                          display: "flex", alignItems: "center", gap: 5,
                          background: isDarkMode ? "rgba(19,23,34,0.85)" : "rgba(255,255,255,0.88)",
                          border: "1px solid var(--border-color)", borderRadius: 4,
                          padding: "2px 6px", fontSize: 11, color: "var(--text-color)",
                          userSelect: "none",
                        }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: getCol(ind.id, ind.color), flexShrink: 0 }} />
                          <span>{ind.label}{paramText ? ` · ${paramText}` : ""}</span>
                          {p && (
                            <span title="Edit parameters" onClick={() => setEditingIndicator(isEditing ? null : ind.id)}
                              style={{ cursor: "pointer", opacity: 0.7, fontSize: 11, padding: "0 2px" }}>⚙</span>
                          )}
                          <span title="Remove indicator" onClick={() => { setActiveIndicators(prev => prev.filter(x => x !== ind.id)); if (isEditing) setEditingIndicator(null); }}
                            style={{ cursor: "pointer", opacity: 0.7, fontSize: 11, padding: "0 2px" }}>✕</span>
                        </div>

                        {isEditing && p && (
                          <div style={{
                            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 40,
                            background: "var(--panel-bg)", border: "1px solid var(--border-color)",
                            borderRadius: 6, padding: "8px 10px", minWidth: 190,
                            boxShadow: "0 6px 16px rgba(0,0,0,0.35)", fontSize: 11, color: "var(--text-color)",
                          }}>
                            {Object.entries(p).map(([key, val]) => (
                              <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                                <span style={{ textTransform: "capitalize" }}>{key}</span>
                                <input type="number" step={val < 1 ? 0.01 : 1} value={val}
                                  onChange={e => {
                                    const v = val < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
                                    if (!isNaN(v) && v > 0) setIndicatorParam(ind.id, key, v);
                                  }}
                                  style={{ width: 64, padding: "2px 4px", fontSize: 11, background: "var(--input-bg)", color: "var(--text-color)", border: "1px solid var(--border-color)", borderRadius: 3 }} />
                              </div>
                            ))}
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                              <span>Color</span>
                              <input type="color" value={getCol(ind.id, ind.color)}
                                onChange={e => setIndicatorStyle(ind.id, "color", e.target.value)}
                                style={{ width: 40, height: 22, padding: 0, border: "1px solid var(--border-color)", borderRadius: 3, background: "transparent", cursor: "pointer" }} />
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                              <span>Width</span>
                              <input type="number" min={1} max={4} step={0.5} value={getW(ind.id, 1.5)}
                                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 1 && v <= 4) setIndicatorStyle(ind.id, "width", v); }}
                                style={{ width: 64, padding: "2px 4px", fontSize: 11, background: "var(--input-bg)", color: "var(--text-color)", border: "1px solid var(--border-color)", borderRadius: 3 }} />
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                              <span>Replace</span>
                              <select value="" onChange={e => {
                                  const newId = e.target.value;
                                  if (!newId) return;
                                  setActiveIndicators(prev => {
                                    const next = prev.map(x => (x === ind.id ? newId : x));
                                    return next.filter((x, i) => next.indexOf(x) === i);
                                  });
                                  setEditingIndicator(null);
                                }}
                                style={{ width: 110, padding: "2px 4px", fontSize: 11, background: "var(--input-bg)", color: "var(--text-color)", border: "1px solid var(--border-color)", borderRadius: 3 }}>
                                <option value="">Choose…</option>
                                {INDICATOR_GROUPS.flatMap(g => g.items)
                                  .filter(o => o.id !== ind.id && o.id !== "forecast_lstm" && !activeIndicators.includes(o.id))
                                  .map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                              </select>
                            </div>
                            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                              <button onClick={() => { setIndicatorParams(prev => ({ ...prev, [ind.id]: DEFAULT_INDICATOR_PARAMS[ind.id] })); setIndicatorStyles(prev => { const n = { ...prev }; delete n[ind.id]; return n; }); }}
                                style={{ flex: 1, padding: "3px 0", fontSize: 10, cursor: "pointer", background: "transparent", color: "var(--text-color)", border: "1px solid var(--border-color)", borderRadius: 3 }}>Reset</button>
                              <button onClick={() => setEditingIndicator(null)}
                                style={{ flex: 1, padding: "3px 0", fontSize: 10, cursor: "pointer", background: "#2962ff", color: "#fff", border: "none", borderRadius: 3 }}>Done</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Custom MA line chips — TradingView-style inline editing */}
                  {!legendCollapsed && maLines.map(ma => {
                    const isEditing = editingIndicator === `ma:${ma.id}`;
                    return (
                      <div key={`ma-${ma.id}`} style={{ position: "relative", pointerEvents: "auto" }}>
                        <div style={{
                          display: "flex", alignItems: "center", gap: 5,
                          background: isDarkMode ? "rgba(19,23,34,0.85)" : "rgba(255,255,255,0.88)",
                          border: "1px solid var(--border-color)", borderRadius: 4,
                          padding: "2px 6px", fontSize: 11, color: "var(--text-color)",
                          userSelect: "none", opacity: ma.visible ? 1 : 0.45,
                        }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: ma.color, flexShrink: 0 }} />
                          <span>{ma.type}{ma.type !== 'VWAP' ? ` ${ma.period}` : ''}</span>
                          <span title={ma.visible ? "Hide" : "Show"}
                            onClick={() => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, visible: !m.visible } : m))}
                            style={{ cursor: "pointer", opacity: 0.7, fontSize: 10, padding: "0 2px" }}>{ma.visible ? "👁" : "―"}</span>
                          <span title="Edit" onClick={() => setEditingIndicator(isEditing ? null : `ma:${ma.id}`)}
                            style={{ cursor: "pointer", opacity: 0.7, fontSize: 11, padding: "0 2px" }}>⚙</span>
                          <span title="Remove" onClick={() => { setMALines(prev => prev.filter(m => m.id !== ma.id)); if (isEditing) setEditingIndicator(null); }}
                            style={{ cursor: "pointer", opacity: 0.7, fontSize: 11, padding: "0 2px" }}>✕</span>
                        </div>

                        {isEditing && (
                          <div style={{
                            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 40,
                            background: "var(--panel-bg)", border: "1px solid var(--border-color)",
                            borderRadius: 6, padding: "8px 10px", minWidth: 190,
                            boxShadow: "0 6px 16px rgba(0,0,0,0.35)", fontSize: 11, color: "var(--text-color)",
                          }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                              <span>Type</span>
                              <select value={ma.type}
                                onChange={e => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, type: e.target.value } : m))}
                                style={{ width: 80, padding: "2px 4px", fontSize: 11, background: "var(--input-bg)", color: "var(--text-color)", border: "1px solid var(--border-color)", borderRadius: 3 }}>
                                {['SMA','EMA','WMA','DEMA','TEMA','HMA','VWAP','BB'].map(t => <option key={t}>{t}</option>)}
                              </select>
                            </div>
                            {ma.type !== 'VWAP' && (
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                                <span>Period</span>
                                <input type="number" min={2} max={500} value={ma.period}
                                  onChange={e => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, period: e.target.value } : m))}
                                  style={{ width: 64, padding: "2px 4px", fontSize: 11, background: "var(--input-bg)", color: "var(--text-color)", border: "1px solid var(--border-color)", borderRadius: 3 }} />
                              </div>
                            )}
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                              <span>Color</span>
                              <input type="color" value={ma.color}
                                onChange={e => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, color: e.target.value } : m))}
                                style={{ width: 40, height: 22, padding: 0, border: "1px solid var(--border-color)", borderRadius: 3, background: "transparent", cursor: "pointer" }} />
                            </div>
                            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                              <button onClick={() => { setMALines(prev => prev.filter(m => m.id !== ma.id)); setEditingIndicator(null); }}
                                style={{ flex: 1, padding: "3px 0", fontSize: 10, cursor: "pointer", background: "transparent", color: "#ef4444", border: "1px solid #ef4444", borderRadius: 3 }}>Remove</button>
                              <button onClick={() => setEditingIndicator(null)}
                                style={{ flex: 1, padding: "3px 0", fontSize: 10, cursor: "pointer", background: "#2962ff", color: "#fff", border: "none", borderRadius: 3 }}>Done</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Add MA chip */}
                  {!legendCollapsed && <div style={{ pointerEvents: "auto" }}>
                    <div onClick={() => {
                        const newId = ++maLineIdRef.current;
                        const colors = ['#10b981', '#c084fc', '#fb923c', '#38bdf8', '#f87171', '#4ade80'];
                        setMALines(prev => [...prev, { id: newId, type: 'SMA', period: 50, color: colors[prev.length % colors.length], visible: true }]);
                        setEditingIndicator(`ma:${newId}`);
                      }}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        background: isDarkMode ? "rgba(19,23,34,0.85)" : "rgba(255,255,255,0.88)",
                        border: "1px dashed var(--border-color)", borderRadius: 4,
                        padding: "2px 8px", fontSize: 11, color: "var(--text-color)",
                        cursor: "pointer", userSelect: "none", opacity: 0.8,
                      }}>
                      + MA
                    </div>
                  </div>}
                </div>
                {chartLoading && (
                  <div style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: "rgba(19, 23, 34, 0.45)",
                    backdropFilter: "blur(4px)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 10,
                  }}>
                    <div style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "12px",
                      background: "var(--panel-bg)",
                      border: "1px solid var(--border-color)",
                      padding: "20px 30px",
                      borderRadius: "8px",
                      boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.37)",
                    }}>
                      <div className={styles.spinning} style={{ fontSize: "24px" }}>⏳</div>
                      <span style={{ fontSize: "13px", fontWeight: "500", color: "var(--text-color)" }}>Loading Chart Data...</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Range Selector Bar */}
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "4px 10px",
                background: "var(--ma-bar-bg)",
                borderTop: "1px solid var(--border-color)",
                fontSize: "11px",
                color: "var(--text-color)",
                minHeight: "26px"
              }}>
                <span style={{ fontWeight: "bold" }}>Zoom Range:</span>
                {[
                  { label: "1M", days: 22 },
                  { label: "3M", days: 65 },
                  { label: "6M", days: 130 },
                  { label: "1Y", days: 250 },
                  { label: "5Y", days: 1250 },
                ].map(r => (
                  <button
                    key={r.label}
                    className={styles.maNavBtn}
                    style={{ padding: "1px 6px", fontSize: "10px" }}
                    onClick={() => {
                      if (chartInstance.current && chartDataRef.current.length > 0) {
                        try {
                          const dataLen = chartDataRef.current.length;
                          chartInstance.current.timeScale().setVisibleLogicalRange({
                            from: Math.max(0, dataLen - r.days),
                            to: dataLen + 3,
                          });
                        } catch(e) {}
                      }
                    }}
                  >
                    {r.label}
                  </button>
                ))}
                <button
                  className={styles.maNavBtn}
                  style={{ padding: "1px 6px", fontSize: "10px", fontWeight: "bold" }}
                  onClick={() => {
                    if (chartInstance.current) {
                      try { chartInstance.current.timeScale().fitContent(); } catch(e) {}
                    }
                  }}
                >
                  ALL
                </button>
              </div>

              {/* Bottom Tab Bar */}
              <div className={styles.bottomTabBar}>
                <div style={{ display: "flex", flex: 1, overflowX: "auto", overflowY: "hidden" }}>
                  {BOTTOM_TABS.map(tab => (
                    <div
                      key={tab.id}
                      className={`${styles.bottomTab} ${activeBottomTab === tab.id ? styles.bottomTabActive : ""}`}
                      onClick={() => {
                        setActiveBottomTab(tab.id);
                        setActiveIndicators(tab.indicators);
                      }}
                    >
                      {tab.label}
                    </div>
                  ))}
                </div>
                {/* Dropdown arrow button */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center", width: "24px",
                  background: "var(--bottom-tab-bg)", borderLeft: "1px solid var(--border-color)", borderBottom: "1px solid var(--border-color)",
                  cursor: "pointer", fontSize: "11px", color: "var(--text-color)", fontWeight: "bold"
                }} onClick={() => {
                  setShowSettings(true);
                }} title="Show indicator parameters settings">
                  ▼
                </div>
              </div>

              {/* Pane resizing is native now (chart panes.enableResize) — custom dividers removed */}

              {/* SVG Drawing Overlay */}
              <svg
                ref={overlayRef}
                style={{ position:"absolute", top:0, left:0, width:"100%", height:`${panelSplits.v1 * 100}%`, cursor: activeTool ? "crosshair" : "default", zIndex: 10, pointerEvents: "all", overflow: "hidden" }}
                onDoubleClick={e => {
                  if (activeTool) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setToolMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onClick={e => {
                  if (toolMenu && !e.target.closest('[data-toolmenu]')) { setToolMenu(null); return; }
                  if (!activeTool) { setSelectedId(null); return; }
                  const rect = e.currentTarget.getBoundingClientRect();
                  let cx = e.clientX - rect.left;
                  let cy = e.clientY - rect.top;

                  // ─ OHLC snap: find nearest candle and snap Y to closest OHLC level ─
                  const snap = (() => {
                    if (!chartInstance.current || !chartDataRef.current.length) return { cx, cy };
                    try {
                      const chart = chartInstance.current;
                      const ts = chart.timeScale();
                      const data = chartDataRef.current;
                      // Find candle whose x-coord is closest
                      let bestCandle = null, bestDist = Infinity;
                      for (const candle of data) {
                        const xCoord = ts.timeToCoordinate(candle.time);
                        if (xCoord === null) continue;
                        const dist = Math.abs(xCoord - cx);
                        if (dist < bestDist) { bestDist = dist; bestCandle = candle; }
                      }
                      if (!bestCandle) return { cx, cy };
                      // Snap Y to nearest OHLC level
                      const series = chart.series && chart.series()[0];
                      if (!series) return { cx, cy };
                      const priceToY = (p) => series.priceToCoordinate(p);
                      const levels = [
                        { name:'H', price: bestCandle.high,  y: priceToY(bestCandle.high) },
                        { name:'L', price: bestCandle.low,   y: priceToY(bestCandle.low) },
                        { name:'O', price: bestCandle.open,  y: priceToY(bestCandle.open) },
                        { name:'C', price: bestCandle.close, y: priceToY(bestCandle.close) },
                      ].filter(l => l.y !== null);
                      let snapLevel = null, snapDist = Infinity;
                      for (const lv of levels) {
                        const d = Math.abs(lv.y - cy);
                        if (d < snapDist && d < 20) { snapDist = d; snapLevel = lv; } // 20px threshold
                      }
                      const snappedY = snapLevel ? snapLevel.y : cy;
                      const snapX = ts.timeToCoordinate(bestCandle.time) ?? cx;
                      return { cx: Math.abs(snapX - cx) < 25 ? snapX : cx, cy: snappedY, label: snapLevel?.name, price: snapLevel?.price, candle: bestCandle };
                    } catch { return { cx, cy }; }
                  })();
                  cx = snap.cx; cy = snap.cy;

                  if (activeTool === 'eraser') { setDrawings([]); setActiveTool(null); return; }
                  if (activeTool === 'hline') {
                    setDrawings(d => [...d, { id: nextId.current++, type:'hline', x1:0, y1:cy, x2:9999, y2:cy, color:'#0000FF', selected:false, label: snap.price ? `H:${snap.price.toFixed(2)}` : '' }]);
                    setActiveTool(null); return;
                  }
                  if (activeTool === 'vline') {
                    setDrawings(d => [...d, { id: nextId.current++, type:'vline', x1:cx, y1:0, x2:cx, y2:9999, color:'#FF0000', selected:false, label: snap.candle?.time || '' }]);
                    setActiveTool(null); return;
                  }
                  if (activeTool === 'text') {
                    const txt = prompt('Enter label text:');
                    if (txt) setDrawings(d => [...d, { id: nextId.current++, type:'text', x1:cx, y1:cy, text:txt, color:'#000080', selected:false }]);
                    setActiveTool(null); return;
                  }
                  if (drawStep === 0) { setTempStart({x:cx,y:cy,snap}); setTempEnd({x:cx,y:cy}); setDrawStep(1); }
                  else {
                    setDrawings(d => [...d, {
                      id: nextId.current++, type: activeTool,
                      x1: tempStart.x, y1: tempStart.y,
                      x2: cx, y2: cy,
                      color: '#0000FF', selected: false,
                      labelStart: tempStart.snap?.label, labelEnd: snap?.label,
                      priceStart: tempStart.snap?.price, priceEnd: snap?.price
                    }]);
                    setDrawStep(0); setTempStart(null); setTempEnd(null); setActiveTool(null);
                  }
                }}
                onMouseMove={e => {
                  if (activeTool && drawStep === 1) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTempEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                  }
                  if (dragState) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const dx = e.clientX - rect.left - dragState.startX;
                    const dy = e.clientY - rect.top - dragState.startY;
                    setDrawings(ds => ds.map(d => d.id === dragState.id ? { ...d, x1: dragState.ox1+dx, y1: dragState.oy1+dy, x2: (dragState.ox2||0)+dx, y2: (dragState.oy2||0)+dy } : d));
                  }
                }}
                onWheel={e => {
                  if (!activeTool && chartRef.current) {
                    const canvas = chartRef.current.querySelector('canvas');
                    if (canvas) {
                      canvas.dispatchEvent(new WheelEvent('wheel', e.nativeEvent));
                    }
                  }
                }}
                onMouseDown={e => { if (!activeTool && !dragState) e.stopPropagation(); }}
                onMouseUp={() => setDragState(null)}
              >
                {/* Existing drawings */}
                {drawings.map(d => (
                  <g key={d.id}
                    style={{ cursor: 'move' }}
                    onMouseDown={e => {
                      e.stopPropagation();
                      const rect = overlayRef.current.getBoundingClientRect();
                      setDragState({ id: d.id, startX: e.clientX - rect.left, startY: e.clientY - rect.top, ox1:d.x1, oy1:d.y1, ox2:d.x2, oy2:d.y2 });
                      setSelectedId(d.id);
                    }}
                  >
                    {d.type === 'hline' && <><line x1={0} y1={d.y1} x2="100%" y2={d.y1} stroke={d.color} strokeWidth={d.id===selectedId?2:1} strokeDasharray={d.id===selectedId?"4 2":""} /><text x={6} y={d.y1-4} fontSize={10} fill={d.color} fontWeight="bold" fontFamily="Tahoma">{d.label}</text></>}
                    {d.type === 'vline' && <><line x1={d.x1} y1={0} x2={d.x1} y2="100%" stroke={d.color} strokeWidth={d.id===selectedId?2:1} strokeDasharray={d.id===selectedId?"4 2":""} /><text x={d.x1+4} y={18} fontSize={9} fill={d.color} fontWeight="bold" fontFamily="Tahoma">{d.label}</text></>}
                    {(d.type==='trendline'||d.type==='ray'||d.type==='arrow'||d.type==='channel'||d.type==='pitchfork') && (<><line x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} stroke={d.color} strokeWidth={d.id===selectedId?2.5:1.5} markerEnd={d.type==='arrow'?'url(#arrow)':''} />{d.priceStart!=null&&<text x={d.x1+4} y={d.y1-4} fontSize={9} fill={d.color} fontWeight="bold">{d.priceStart.toFixed(2)}</text>}{d.priceEnd!=null&&<text x={d.x2+4} y={d.y2-4} fontSize={9} fill={d.color} fontWeight="bold">{d.priceEnd.toFixed(2)}</text>}</>)}
                    {d.type==='rectangle' && <rect x={Math.min(d.x1,d.x2)} y={Math.min(d.y1,d.y2)} width={Math.abs(d.x2-d.x1)} height={Math.abs(d.y2-d.y1)} stroke={d.color} strokeWidth={d.id===selectedId?2:1} fill={d.color+'22'} />}
                    {d.type==='circle' && <ellipse cx={(d.x1+d.x2)/2} cy={(d.y1+d.y2)/2} rx={Math.abs(d.x2-d.x1)/2} ry={Math.abs(d.y2-d.y1)/2} stroke={d.color} strokeWidth={d.id===selectedId?2:1} fill={d.color+'22'} />}
                    {d.type==='fibonacci' && [0,0.236,0.382,0.5,0.618,0.786,1].map((lvl,i) => {
                      const y = d.y1 + (d.y2 - d.y1) * lvl;
                      return <g key={i}><line x1={0} y1={y} x2="100%" y2={y} stroke={['#FF0000','#FF6600','#FFB900','#00AA00','#0055BB','#7700AA','#000000'][i]} strokeWidth={1} strokeDasharray="3 2" /><text x={d.x1+4} y={y-3} fontSize={9} fill={['#FF0000','#FF6600','#FFB900','#00AA00','#0055BB','#7700AA','#000000'][i]}>{(lvl*100).toFixed(1)}%</text></g>;
                    })}
                    {d.type==='text' && (
                      editingId === d.id
                        ? <foreignObject x={d.x1} y={d.y1-16} width={160} height={24}><input autoFocus style={{fontSize:12,border:'1px solid #00F',padding:'1px 4px',background:'#FFFFCC',width:'100%'}} defaultValue={d.text} onBlur={e=>{setDrawings(ds=>ds.map(dd=>dd.id===d.id?{...dd,text:e.target.value}:dd));setEditingId(null);}} onKeyDown={e=>{if(e.key==='Enter'){setDrawings(ds=>ds.map(dd=>dd.id===d.id?{...dd,text:e.target.value}:dd));setEditingId(null);}}} /></foreignObject>
                        : <text x={d.x1} y={d.y1} fontSize={13} fontWeight="bold" fill={d.color} onDoubleClick={e=>{e.stopPropagation();setEditingId(d.id);}}>{d.text}</text>
                    )}
                    {/* Selection handles */}
                    {d.id===selectedId && d.type!=='text' && d.type!=='hline' && d.type!=='vline' && (
                      <>
                        <circle cx={d.x1} cy={d.y1} r={5} fill="#0000FF" stroke="#FFF" strokeWidth={1} style={{cursor:'nwse-resize'}} />
                        <circle cx={d.x2||d.x1} cy={d.y2||d.y1} r={5} fill="#0000FF" stroke="#FFF" strokeWidth={1} style={{cursor:'nwse-resize'}} />
                        <circle cx={(d.x1+(d.x2||d.x1))/2} cy={(d.y1+(d.y2||d.y1))/2} r={4} fill="#FF0000" stroke="#FFF" strokeWidth={1} title="Delete" onClick={e=>{e.stopPropagation();setDrawings(ds=>ds.filter(x=>x.id!==d.id));setSelectedId(null);}} style={{cursor:'pointer'}} />
                      </>
                    )}
                    {/* hline/vline delete handle */}
                    {d.id===selectedId && (d.type==='hline'||d.type==='vline') && (
                      <circle cx={d.type==='hline'?50:d.x1} cy={d.type==='hline'?d.y1:50} r={5} fill="#FF0000" stroke="#FFF" strokeWidth={1} onClick={e=>{e.stopPropagation();setDrawings(ds=>ds.filter(x=>x.id!==d.id));setSelectedId(null);}} style={{cursor:'pointer'}} />
                    )}
                  </g>
                ))}
                {/* In-progress drawing preview */}
                {activeTool && drawStep===1 && tempStart && tempEnd && (
                  <line x1={tempStart.x} y1={tempStart.y} x2={tempEnd.x} y2={tempEnd.y} stroke="#FF6600" strokeWidth={1.5} strokeDasharray="5 3" />
                )}
                {/* Arrow marker def */}
                <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#0000FF" /></marker></defs>
              </svg>

              {/* Full Tabbed Double-click Menu: Tools | Indicators | Signals */}
              {toolMenu && (
                <div data-toolmenu="1" onClick={e=>e.stopPropagation()} style={{ position:'absolute', left: Math.min(toolMenu.x, (overlayRef.current?.clientWidth||800)-280), top: Math.min(toolMenu.y, (overlayRef.current?.clientHeight||600)-420), zIndex:999, background:'var(--panel-bg)', border:'2px solid var(--border-color)', boxShadow:'4px 4px 0 rgba(0,0,0,0.4)', width:'320px', fontFamily:'Tahoma,Arial,sans-serif', color: 'var(--text-color)' }}>
                  {/* Title bar */}
                  <div style={{background:'var(--border-color)',color:'var(--text-color)',padding:'4px 8px',fontSize:'11px',fontWeight:'bold',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span>📊 Chart Analysis Panel</span>
                    <span style={{cursor:'pointer',fontWeight:'bold'}} onClick={()=>setToolMenu(null)}>✕</span>
                  </div>
                  {/* Tab bar */}
                  <div style={{display:'flex',borderBottom:'1px solid var(--border-color)',background:'var(--menu-bg)'}}>
                    {[{k:'tools',label:'🖊 Tools'},{k:'indicators',label:'📈 Indicators'},{k:'signals',label:'🔔 Signals'}].map(t=>(
                      <div key={t.k} onClick={()=>setMenuTab(t.k)} style={{padding:'4px 10px',fontSize:'11px',cursor:'pointer',borderRight:'1px solid var(--border-color)',background:menuTab===t.k?'var(--panel-bg)':'var(--menu-bg)',fontWeight:menuTab===t.k?'bold':'normal',color:'var(--text-color)'}}>{t.label}</div>
                    ))}
                  </div>

                  {/* TOOLS TAB */}
                  {menuTab === 'tools' && (
                    <div style={{padding:'6px'}}>
                      <div style={{fontSize:'10px',color:'var(--text-color)',opacity: 0.7,marginBottom:'4px'}}>Double-click snaps to nearest candle OHLC. Click places tool.</div>
                      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'3px'}}>
                        {TOOLS.map(t => (
                          <div key={t.id}
                            style={{ padding:'5px 3px', fontSize:'10px', cursor:'pointer', border:'1px solid var(--border-color)', background: activeTool===t.id ? 'var(--list-item-hover)' : 'var(--panel-bg)', color: activeTool===t.id ? 'var(--list-item-hover-text)':'var(--text-color)', display:'flex', flexDirection:'column', alignItems:'center', gap:'2px', userSelect:'none', textAlign:'center' }}
                            onClick={() => { setActiveTool(t.id); setDrawStep(0); setTempStart(null); setTempEnd(null); setToolMenu(null); }}
                          >
                            <span style={{fontSize:'18px',lineHeight:1}}>{t.icon}</span>
                            <span style={{fontSize:'9px'}}>{t.label}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{display:'flex',gap:'4px',marginTop:'6px'}}>
                        <button style={{flex:1,fontSize:'10px',padding:'4px',background:'var(--panel-bg)',color:'var(--text-color)',border:'1px solid var(--border-color)',cursor:'pointer'}} onClick={()=>{setDrawings([]);setToolMenu(null);setActiveTool(null);}}>🗑 Clear All</button>
                        <button style={{flex:1,fontSize:'10px',padding:'4px',background:'var(--panel-bg)',color:'var(--text-color)',border:'1px solid var(--border-color)',cursor:'pointer'}} onClick={()=>{setToolMenu(null);setActiveTool(null);}}>✕ Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* INDICATORS TAB */}
                  {menuTab === 'indicators' && (
                    <div style={{padding:'6px',maxHeight:'360px',overflowY:'auto'}}>
                      {INDICATOR_GROUPS.map(group => (
                        <div key={group.group} style={{marginBottom:'8px'}}>
                          <div style={{fontSize:'10px',fontWeight:'bold',color:'var(--text-color)',borderBottom:'1px solid var(--border-color)',marginBottom:'4px',paddingBottom:'2px'}}>{group.group}</div>
                          {group.items.map(ind => {
                            const isOn = activeIndicators.includes(ind.id);
                            return (
                              <div key={ind.id} style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'3px',cursor:'pointer',padding:'2px 4px',background:isOn?'var(--menu-hover)':'transparent',borderRadius:2}}
                                onClick={()=>{
                                  handleToggleIndicator(ind.id);
                                }}>
                                <span style={{fontSize:'12px',userSelect:'none',color:'var(--text-color)'}}>{isOn ? '☑' : '☐'}</span>
                                <span style={{display:'inline-block',width:10,height:10,background:ind.color,border:'1px solid var(--border-color)',borderRadius:1,flexShrink:0}} />
                                <span style={{fontSize:'11px',color:'var(--text-color)',userSelect:'none'}}>{ind.label}</span>
                                <span style={{marginLeft:'auto',fontSize:'9px',color:'var(--text-color)',opacity: 0.6}}>{ind.panel==='main'?'↗ Chart':'↘ Sub'}</span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {activeIndicators.includes('forecast_lstm') && forecastData && (
                        <div style={{marginBottom:'6px'}}>
                          <span style={{ fontSize: '11px', color: forecastData.is_stale ? '#f59e0b' : '#9ca3af', marginLeft: 2 }}>
                            {forecastData.is_stale ? '⚠ Forecast stale' : `Forecast as of ${forecastData.as_of_date}`}
                          </span>
                          <span
                            title="Predicted price assumes the overall market (NIFTY) stays flat over the forecast window. The model predicts the stock's expected move relative to the market, not the market's own movement."
                            style={{ fontSize: '10px', color: '#6b7280', marginLeft: 6, cursor: 'help', borderBottom: '1px dotted #6b7280' }}
                          >
                            ⓘ vs. flat market
                          </span>
                        </div>
                      )}
                      <div style={{display:'flex',gap:'4px',marginTop:'4px'}}>
                        <button style={{flex:1,fontSize:'10px',padding:'4px',background:'var(--panel-bg)',color:'var(--text-color)',border:'1px solid var(--border-color)',cursor:'pointer'}} onClick={()=>setActiveIndicators([])}>Clear All</button>
                        <button style={{flex:1,fontSize:'10px',padding:'4px',background:'var(--panel-bg)',color:'var(--text-color)',border:'1px solid var(--border-color)',cursor:'pointer'}} onClick={()=>setToolMenu(null)}>Apply ✔</button>
                      </div>
                    </div>
                  )}

                  {/* SIGNALS TAB */}
                  {menuTab === 'signals' && (
                    <div style={{padding:'6px',maxHeight:'360px',overflowY:'auto'}}>
                      <div style={{fontSize:'10px',color:'var(--text-color)',opacity:0.7,marginBottom:'6px'}}>Select a signal to auto-enable its required indicators and highlight events on chart.</div>
                      {SIGNAL_LIST.map(sig => {
                        const sigToInds = {
                          golden_cross:['sma50','sma200'], death_cross:['sma50','sma200'],
                          rsi_oversold:['rsi'], rsi_overbought:['rsi'],
                          bb_squeeze:['bb'], macd_cross:['macd'],
                          supertrend_buy:['supertrend'], supertrend_sell:['supertrend'],
                          stoch_oversold:['stoch'], stoch_overbought:['stoch'],
                          vwap_cross:['vwap'], obv_divergence:['obv'],
                        };
                        const required = sigToInds[sig.id] || [];
                        const isActive = required.every(r => activeIndicators.includes(r));
                        return (
                          <div key={sig.id} style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'4px',cursor:'pointer',padding:'3px 6px',background:isActive?'var(--menu-hover)':'var(--panel-bg)',border:'1px solid var(--border-color)',borderRadius:2}}
                            onClick={()=>{
                              setActiveIndicators(prev => {
                                const next = new Set(prev);
                                required.forEach(r => next.add(r));
                                return Array.from(next);
                              });
                              setToolMenu(null);
                            }}>
                            <span style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:sig.color,flexShrink:0}} />
                            <span style={{fontSize:'11px',color:'var(--text-color)',flex:1,userSelect:'none'}}>{sig.label}</span>
                            {isActive && <span style={{fontSize:'9px',color:'#00cc44',fontWeight:'bold'}}>ON</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Active tool status bar */}
              {activeTool && (
                <div style={{ position:'absolute', bottom:8, left:'50%', transform:'translateX(-50%)', background:'var(--list-item-hover)', color:'var(--list-item-hover-text)', padding:'3px 14px', fontSize:'11px', borderRadius:2, zIndex:100, pointerEvents:'none', whiteSpace:'nowrap' }}>
                  {drawStep===0 ? `🎯 Click to place: ${TOOLS.find(t=>t.id===activeTool)?.label} (snaps to H/L/O/C)` : '📍 Click second point — snaps to nearest OHLC (Esc = cancel)'}
                </div>
              )}
            </>
          ) : (
            <div style={{width: "100%", height: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: "2px", backgroundColor: "var(--border-color)"}}>
               <div style={{backgroundColor:"var(--panel-bg)", border:"1px solid var(--border-color)", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"var(--text-color)", fontWeight:"bold"}}>{symbol} (Daily)</div></div>
               <div style={{backgroundColor:"var(--panel-bg)", border:"1px solid var(--border-color)", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"var(--text-color)", fontWeight:"bold"}}>{symbol} (Weekly)</div></div>
               <div style={{backgroundColor:"var(--panel-bg)", border:"1px solid var(--border-color)", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"var(--text-color)", fontWeight:"bold"}}>{symbol} (Monthly)</div></div>
               <div style={{backgroundColor:"var(--panel-bg)", border:"1px solid var(--border-color)", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"var(--text-color)", fontWeight:"bold"}}>{symbol} (15m)</div></div>
            </div>
          )}
        </div>
      {/* Chart navigation bar (MA editing now lives in the on-chart legend) */}
      <div className={styles.maBar}>
        {/* Right-side nav buttons */}
        <div className={styles.maBarRight}>
          <button
            title="Scroll chart backward (older data)"
            className={styles.maNavBtn}
            onClick={() => { if (chartInstance.current) { try { chartInstance.current.timeScale().scrollToPosition((chartInstance.current.timeScale().scrollPosition() || 0) - 50, false); } catch(e) {} } }}
          >&lt;&lt;</button>
          <button
            title="Zoom Out"
            className={styles.maNavBtn}
            onClick={() => {
              if (chartInstance.current) {
                try {
                  const range = chartInstance.current.timeScale().getVisibleLogicalRange();
                  if (range) {
                    const len = range.to - range.from;
                    chartInstance.current.timeScale().setVisibleLogicalRange({
                      from: range.from - len * 0.15,
                      to: range.to + len * 0.15
                    });
                  }
                } catch(e) {}
              }
            }}
            style={{ fontWeight: 'bold' }}
          >🔍-</button>
          <button
            title="Zoom In"
            className={styles.maNavBtn}
            onClick={() => {
              if (chartInstance.current) {
                try {
                  const range = chartInstance.current.timeScale().getVisibleLogicalRange();
                  if (range) {
                    const len = range.to - range.from;
                    chartInstance.current.timeScale().setVisibleLogicalRange({
                      from: range.from + len * 0.15,
                      to: range.to - len * 0.15
                    });
                  }
                } catch(e) {}
              }
            }}
            style={{ fontWeight: 'bold' }}
          >🔍+</button>
          <button
            title="Scroll chart forward (recent data)"
            className={styles.maNavBtn}
            onClick={() => { if (chartInstance.current) { try { chartInstance.current.timeScale().scrollToPosition((chartInstance.current.timeScale().scrollPosition() || 0) + 50, false); } catch(e) {} } }}
          >&gt;&gt;</button>
          <button className={styles.maRiskBtn} onClick={() => setShowRiskCalc(true)}>Risk Calculator</button>
        </div>
      </div>
        </div>

        {/* Right Column: Watchlist & Details */}
        <div className={styles.rightSidebar}>
          {/* One header row instead of three. The view tabs carry their own
              labels, so "Select Index/Sector" is redundant with the dropdown
              under it, and Main/Multiple Charts doesn't need a full row. */}
          <div className={styles.sideHeader}>
            <div className={styles.sideViewTabs}>
              <button
                className={`${styles.sTabMini} ${sidebarTab === 'sectors' ? styles.sTabMiniActive : ''}`}
                onClick={() => setSidebarTab("sectors")}
                title="Index / sector constituents"
              >🗂️<span className={styles.sTabMiniLabel}>Sectors</span></button>
              <button
                className={`${styles.sTabMini} ${sidebarTab === 'personal' ? styles.sTabMiniActive : ''}`}
                onClick={() => { setSidebarTab("personal"); loadMyWatchlist(); }}
                title="My watchlist"
              >⭐<span className={styles.sTabMiniLabel}>Watchlist</span></button>
              <button
                className={`${styles.sTabMini} ${sidebarTab === 'holidays' ? styles.sTabMiniActive : ''}`}
                onClick={() => { setSidebarTab("holidays"); loadHolidays(); }}
                title="NSE holidays"
              >📅<span className={styles.sTabMiniLabel}>Holidays</span></button>
            </div>
            <select
              className={styles.sideLayoutSelect}
              value={activeMainTab}
              onChange={(e) => setActiveMainTab(e.target.value)}
              title="Chart layout"
            >
              <option value="Main">Main</option>
              <option value="Multiple Charts">Multi</option>
            </select>
          </div>

          {sidebarTab === 'sectors' && (
            <>
              <div style={{ padding: "4px 8px 0 8px" }}>
                <select
                  value={activeSector}
                  onChange={e => setActiveSector(e.target.value)}
                  title="Select index / sector"
                  style={{
                    width: "100%",
                    padding: "5px 6px",
                    border: "1px solid var(--border-color)",
                    borderRadius: "4px",
                    background: "var(--input-bg)",
                    color: "var(--text-color)",
                    fontSize: "11px",
                    fontFamily: "inherit",
                    cursor: "pointer",
                    outline: "none"
                  }}
                >
                  {Object.keys(INDICES).map(grp => (
                    <option key={grp} value={grp}>{grp}</option>
                  ))}
                </select>
              </div>

              {/* Index Header Card */}
              {(() => {
                const sectorSymbols = INDICES[activeSector] || [];
                if (sectorSymbols.length === 0) return null;
                const indexSymbol = sectorSymbols[0];
                const item = watchlistData.find(w => w.symbol === indexSymbol);
                const ltp = item && item.price != null ? item.price.toFixed(2) : "--";
                const chgPct = item && item.change_pct != null ? item.change_pct : 0;
                const chgPctStr = item && item.change_pct != null ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%` : "--";
                const color = chgPct >= 0 ? "#089981" : "#f23645";
                const isSelected = symbol === indexSymbol;
                return (
                  <div
                    className={`${styles.indexCard} ${isSelected ? styles.indexCardSelected : ''}`}
                    onClick={() => selectSymbol(indexSymbol)}
                    title={`${indexSymbol} — click to chart the index`}
                  >
                    <span className={styles.indexCardName}>{indexSymbol}</span>
                    <span className={styles.indexCardPrice}>{ltp}</span>
                    <span style={{ color, fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>{chgPctStr}</span>
                  </div>
                );
              })()}
            </>
          )}

          {/* Section Divider */}
          <div className={styles.constituentsHeader} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>
              {sidebarTab === 'sectors' && 'Constituent Stocks'}
              {sidebarTab === 'personal' && 'My Watchlist'}
              {sidebarTab === 'holidays' && 'NSE Holidays'}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {sidebarTab === 'holidays' && (
                <button
                  onClick={handleSyncHolidays}
                  disabled={holidaysSyncing || holidaysLoading}
                  className={styles.syncBtn}
                  title="Sync and Download latest holidays from NSE API"
                  style={{
                    background: "none",
                    border: "none",
                    color: holidaysSyncing ? "var(--text-color-muted)" : "var(--primary-color, #089981)",
                    cursor: holidaysSyncing || holidaysLoading ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    padding: "2px",
                    display: "flex",
                    alignItems: "center",
                    outline: "none",
                  }}
                >
                  <span className={holidaysSyncing ? styles.spinning : ""}>
                    {holidaysSyncing ? "⏳" : "🔄"}
                  </span>
                </button>
              )}
              <span style={{ fontSize: "11px", opacity: 0.7 }}>
                {sidebarTab === 'sectors' && `${Math.max(0, (INDICES[activeSector] || []).length - 1)} items`}
                {sidebarTab === 'personal' && `${myWatchlist.length} items`}
                {sidebarTab === 'holidays' && `${holidays.length} items`}
              </span>
            </div>
          </div>

          {/* Search Input */}
          <input 
            type="text" 
            placeholder={sidebarTab === 'holidays' ? "🔍 Search occasion or day..." : "🔍 Search in list..."}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: "calc(100% - 16px)",
              margin: "2px 8px 4px 8px",
              padding: "6px",
              border: "1px solid var(--border-color)",
              fontSize: "11px",
              borderRadius: "4px",
              background: "var(--input-bg)",
              color: "var(--text-color)",
              fontFamily: "inherit",
              outline: "none"
            }}
          />

          {/* Stocks List styled as table.
              tabIndex makes it focusable so ↑/↓ work; clicking a row focuses it
              too, so mouse and keyboard hand off to each other naturally. */}
          <div
            ref={listBoxRef}
            tabIndex={0}
            onKeyDown={onListKeyDown}
            className={styles.listBox}
            style={{ flex: 1, minHeight: 180, margin: "4px 8px 8px 8px", background: "var(--panel-bg)" }}
          >
            {/* Header Row */}
            {sidebarTab !== 'holidays' ? (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 6px", fontSize: "10px", opacity: 0.7, borderBottom: "1px solid var(--border-color)", fontWeight: "bold" }}>
                <span title="Click a stock, then use ↑ / ↓ to flip through the list">Symbol <span style={{ opacity: 0.7, fontWeight: 400 }}>↑↓</span></span>
                <div style={{ display: "flex", gap: "20px" }}>
                  <span style={{ width: "55px", textAlign: "right" }}>LTP</span>
                  <span style={{ width: "45px", textAlign: "right" }}>Chg%</span>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 6px", fontSize: "10px", opacity: 0.7, borderBottom: "1px solid var(--border-color)", fontWeight: "bold" }}>
                <span>Date & Day</span>
                <span style={{ textAlign: "right" }}>Occasion</span>
              </div>
            )}

            {/* Rows */}
            {(() => {
              if (sidebarTab === 'sectors' || sidebarTab === 'personal') {
                if (visibleRows.length === 0) {
                  return (
                    <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--text-color-muted)", fontSize: "11px" }}>
                      {sidebarTab === 'personal' && myWatchlist.length === 0
                        ? "Your watchlist is empty. Add symbols using the star button."
                        : "No matching symbols."}
                    </div>
                  );
                }
                // Rendered straight from visibleRows — the same array ↑/↓ walks,
                // so the cursor can never point at a different row than you see.
                return visibleRows.map(({ symbol: sym, item }, i) => {
                  const ltp = item && item.price != null ? item.price.toFixed(2) : "--";
                  const chgPct = item && item.change_pct != null ? item.change_pct : 0;
                  const chgPctStr = item && item.change_pct != null ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%` : "--";
                  const color = chgPct >= 0 ? "#089981" : "#f23645";
                  return (
                    <div
                      key={sym}
                      data-row={i}
                      className={`${styles.listItem} ${symbol === sym ? styles.listItemSelected : ''}`}
                      onClick={() => { selectSymbol(sym); listBoxRef.current?.focus(); }}
                      style={{ display: "flex", justifyContent: "space-between", padding: "6px 6px", borderBottom: "1px solid var(--border-color)" }}
                    >
                      <span style={{ fontWeight: "500" }}>{sym}</span>
                      <div style={{ display: "flex", gap: "20px" }}>
                        <span style={{ width: "55px", textAlign: "right", fontWeight: "bold" }}>{ltp}</span>
                        <span style={{ width: "45px", textAlign: "right", color: color, fontWeight: "bold" }}>{chgPctStr}</span>
                      </div>
                    </div>
                  );
                });
              } else if (sidebarTab === 'holidays') {
                const getTodayStr = () => {
                  const options = { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" };
                  const formatter = new Intl.DateTimeFormat("en-US", options);
                  const parts = formatter.formatToParts(new Date());
                  const partMap = {};
                  parts.forEach(p => { partMap[p.type] = p.value; });
                  return `${partMap.year}-${partMap.month}-${partMap.day}`;
                };
                const todayStr = getTodayStr();
                const filteredHolidays = holidays.filter(h => 
                  h.description.toLowerCase().includes(searchQuery.toLowerCase()) || 
                  h.day.toLowerCase().includes(searchQuery.toLowerCase()) ||
                  h.date.includes(searchQuery)
                );

                if (holidaysLoading) {
                  return (
                    <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--text-color-muted)", fontSize: "11px" }}>
                      Loading holidays...
                    </div>
                  );
                }

                if (filteredHolidays.length === 0) {
                  return (
                    <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--text-color-muted)", fontSize: "11px" }}>
                      No matching holidays found.
                    </div>
                  );
                }

                const formatHolidayDate = (dateStr) => {
                  try {
                    const parts = dateStr.split('-');
                    if (parts.length !== 3) return dateStr;
                    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    const mIdx = parseInt(parts[1], 10) - 1;
                    const day = parseInt(parts[2], 10);
                    return `${day} ${monthNames[mIdx]}`;
                  } catch (e) {
                    return dateStr;
                  }
                };

                return filteredHolidays.map(h => {
                  const isPast = h.date < todayStr;
                  const isToday = h.date === todayStr;
                  
                  let badge = null;
                  let rowClass = styles.holidayRowUpcoming;
                  if (isToday) {
                    rowClass = styles.holidayRowToday;
                    badge = (
                      <span style={{
                        fontSize: "8px",
                        background: "#089981",
                        color: "#fff",
                        padding: "1px 4px",
                        borderRadius: "3px",
                        fontWeight: "bold",
                        marginLeft: "6px",
                        display: "inline-block",
                        verticalAlign: "middle"
                      }}>TODAY</span>
                    );
                  } else if (isPast) {
                    rowClass = styles.holidayRowPast;
                    badge = (
                      <span style={{
                        fontSize: "8px",
                        background: "rgba(255,255,255,0.08)",
                        color: "var(--text-color-muted)",
                        padding: "1px 4px",
                        borderRadius: "3px",
                        marginLeft: "6px",
                        display: "inline-block",
                        verticalAlign: "middle"
                      }}>PAST</span>
                    );
                  }

                  return (
                    <div 
                      key={h.id} 
                      className={`${styles.holidayRow} ${rowClass}`}
                      style={{ 
                        display: "flex", 
                        justifyContent: "space-between", 
                        alignItems: "center", 
                        padding: "8px 6px", 
                        borderBottom: "1px solid var(--border-color)",
                        fontSize: "11px",
                        minHeight: "38px"
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
                        <div style={{ display: "flex", alignItems: "center" }}>
                          <span style={{ fontWeight: "bold" }}>
                            {formatHolidayDate(h.date)}
                          </span>
                          {badge}
                        </div>
                        <span style={{ fontSize: "9px", opacity: 0.5 }}>
                          {h.day}
                        </span>
                      </div>
                      <span 
                        style={{ 
                          maxWidth: "140px", 
                          textAlign: "right", 
                          fontWeight: "500", 
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: "11px"
                        }} 
                        title={h.description}
                      >
                        {h.description}
                      </span>
                    </div>
                  );
                });
              }
            })()}
          </div>

          {/* Fundamentals / Delivery — collapsed by default and BELOW the list.
              They used to sit above it and consumed the whole column, leaving
              the list with no room to render any rows at all. */}
          {sidebarTab === 'sectors' && fundamentals && (
            <div className={styles.sideAccordion}>
              <button className={styles.sideAccordionHead} onClick={() => toggleCard("funda")}>
                <span>📊 Fundamentals</span>
                <span className={styles.sideAccordionChevron}>{showFundaCard ? "▾" : "▸"}</span>
              </button>
              {showFundaCard && (() => {
                const f = fundamentals;
                const fmtCr = (v) => v == null ? "—" : `₹${(v / 1e12).toFixed(2)}L Cr`;
                const n = (v, suf = "") => v == null ? "—" : `${v}${suf}`;
                const rows = [
                  ["Mkt Cap", fmtCr(f.market_cap)], ["P/E", n(f.pe)],
                  ["P/B", n(f.pb)], ["ROE", n(f.roe, "%")],
                  ["D/E", n(f.debt_to_equity, "x")], ["Div Yld", n(f.dividend_yield, "%")],
                  ["EPS", n(f.eps)], ["Margin", n(f.profit_margin, "%")],
                  ["Promoter", n(f.promoter_holding, "%")],
                  ["52W H/L", (f.week52_high && f.week52_low) ? `${f.week52_high}/${f.week52_low}` : "—"],
                ];
                return (
                  <div className={styles.sideAccordionBody}>
                    {rows.map(([k, v]) => (
                      <div key={k} className={styles.sideStatRow}>
                        <span className={styles.sideStatKey}>{k}</span>
                        <span className={styles.sideStatVal} title={`${k}: ${v}`}>{v}</span>
                      </div>
                    ))}
                    {f.industry && (
                      <div className={styles.sideAccordionNote} title={`${f.sector} · ${f.industry}`}>
                        {f.sector} · {f.industry}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {sidebarTab === 'sectors' && deliveryFlow?.summary?.delivery_pct != null && (() => {
            const s = deliveryFlow.summary;
            const convColor = {
              "strong accumulation": "#089981", "money flowing in": "#26a69a",
              "conviction selling": "#f23645", "money flowing out": "#ef5350",
              "neutral": "#9aa4b2", "insufficient data": "#9aa4b2",
            }[s.conviction] || "#9aa4b2";
            const mfi = s.delivery_mfi;
            const spark = (deliveryFlow.series || []).slice(-30).filter(p => p.delivery_pct != null);
            const maxP = Math.max(...spark.map(p => p.delivery_pct), 1);
            return (
              <div className={styles.sideAccordion}>
                <button className={styles.sideAccordionHead} onClick={() => toggleCard("delivery")}>
                  <span>🚚 Delivery Flow</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: convColor, fontWeight: 700, fontSize: 9, textTransform: "uppercase" }}>
                      {s.conviction}
                    </span>
                    <span className={styles.sideAccordionChevron}>{showDeliveryCard ? "▾" : "▸"}</span>
                  </span>
                </button>
                {showDeliveryCard && (
                  <div className={styles.sideAccordionBody}>
                    <div className={styles.sideStatRow}>
                      <span className={styles.sideStatKey}>Delivery</span>
                      <span className={styles.sideStatVal}>{s.delivery_pct}%</span>
                    </div>
                    <div className={styles.sideStatRow}>
                      <span className={styles.sideStatKey}>20d avg</span>
                      <span className={styles.sideStatVal}>{s.delivery_pct_avg20 ?? "—"}%</span>
                    </div>
                    {mfi != null && (
                      <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                          <span className={styles.sideStatKey}>Delivery MFI (14)</span>
                          <span style={{ color: mfi >= 60 ? "#089981" : mfi <= 40 ? "#f23645" : "var(--text-color)", fontWeight: 700, fontSize: 11 }}>{mfi}</span>
                        </div>
                        <div style={{ height: 5, background: "var(--border-color)", borderRadius: 3, position: "relative" }}>
                          <div style={{
                            position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 3,
                            width: `${Math.min(100, Math.max(0, mfi))}%`,
                            background: mfi >= 60 ? "#089981" : mfi <= 40 ? "#f23645" : "#f0a500",
                          }} />
                        </div>
                      </div>
                    )}
                    {s.is_spike && (
                      <div style={{
                        gridColumn: "1 / -1", marginTop: 5, padding: "3px 8px", borderRadius: 5,
                        fontSize: 10, fontWeight: 800, color: "#f0a500", background: "#f0a50018",
                      }}>
                        ⚡ {s.spike_ratio}× normal delivered quantity today
                      </div>
                    )}
                    {spark.length >= 5 && (
                      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "flex-end", gap: 1, height: 22, marginTop: 6 }}
                        title="Delivery % — last 30 sessions">
                        {spark.map((p, i) => (
                          <div key={i} style={{
                            flex: 1, borderRadius: 1,
                            height: `${Math.max(8, (p.delivery_pct / maxP) * 100)}%`,
                            background: i === spark.length - 1 ? convColor : "var(--border-color)",
                          }} />
                        ))}
                      </div>
                    )}
                    <div className={styles.sideAccordionNote}>
                      High delivery % = shares taken home, not intraday-flipped.
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Stock Details Card at the bottom */}
          {(() => {
            const details = getStockDetails();
            if (!details) return null;
            const item = watchlistData.find(w => w.symbol === symbol);
            const compName = item ? item.name : "NSE Listed Equity";
            
            return (
              <div className={styles.detailsCard}>
                <div className={styles.detailsTitleRow} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span className={styles.detailsSym}>{details.symbol}</span>
                    <button
                      onClick={() => toggleWatchlist(details.symbol)}
                      style={{
                        background: "none",
                        border: "none",
                        fontSize: "15px",
                        cursor: "pointer",
                        color: myWatchlist.some(w => w.symbol === details.symbol) ? "#ffb600" : "#787b86",
                        outline: "none",
                        padding: 0,
                        display: "flex",
                        alignItems: "center"
                      }}
                      title={myWatchlist.some(w => w.symbol === details.symbol) ? "Remove from watchlist" : "Add to watchlist"}
                    >
                      {myWatchlist.some(w => w.symbol === details.symbol) ? "★" : "☆"}
                    </button>
                  </div>
                  <span className={styles.detailsName} title={compName}>
                    {compName.length > 16 ? compName.substring(0, 14) + "..." : compName}
                  </span>
                </div>
                <div className={styles.detailsPriceRow}>
                  <span className={styles.detailsLtp}>{details.close}</span>
                  <span className={styles.detailsChg} style={{ color: details.isUp ? "#089981" : "#f23645", fontWeight: "bold" }}>
                    {details.changeText}
                  </span>
                </div>
                <div className={styles.detailsGrid}>
                  <div className={styles.detailsItem}>
                    <span className={styles.detailsItemLabel}>Open</span>
                    <span className={styles.detailsItemVal}>{details.open}</span>
                  </div>
                  <div className={styles.detailsItem}>
                    <span className={styles.detailsItemLabel}>High</span>
                    <span className={styles.detailsItemVal}>{details.high}</span>
                  </div>
                  <div className={styles.detailsItem}>
                    <span className={styles.detailsItemLabel}>Low</span>
                    <span className={styles.detailsItemVal}>{details.low}</span>
                  </div>
                  <div className={styles.detailsItem}>
                    <span className={styles.detailsItemLabel}>Close</span>
                    <span className={styles.detailsItemVal}>{details.close}</span>
                  </div>
                  <div className={styles.detailsItem} style={{ gridColumn: "span 2" }}>
                    <span className={styles.detailsItemLabel}>Volume</span>
                    <span className={styles.detailsItemVal}>{details.volume}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {showCustomQuery && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "600px" }}>
            <div className={styles.winTitleBar}>
              <span>Analysis Search / Custom Query Builder</span>
              <button className={styles.winCloseBtn} onClick={() => setShowCustomQuery(false)}>X</button>
            </div>
            <div className={styles.winBody}>
              <div className={styles.winGroupBox}>
                <span className={styles.winGroupBoxLegend}>Condition Logic</span>
                <div className={styles.winRow}>
                  <select className={styles.winSelect} value={queryParam} onChange={e => setQueryParam(e.target.value)}>
                    <optgroup label="Moving Averages">
                      <option value="sma_cross">Moving Average Crossover Scan</option>
                      <option value="golden_cross">Golden Cross (50 above 200)</option>
                      <option value="death_cross">Death Cross (50 below 200)</option>
                      <option value="price_ma_cross">Price and MA Crossover</option>
                      <option value="ma_slope">MA Slope Scanner</option>
                      <option value="pullback">Scan Pull back in Stocks</option>
                    </optgroup>
                    <optgroup label="Indicators">
                      <option value="supertrend_buy">SuperTrend Buy Signal</option>
                      <option value="supertrend_sell">SuperTrend Sell Signal</option>
                      <option value="rsi_oversold">RSI Oversold (below 30)</option>
                      <option value="rsi_overbought">RSI Overbought (above 70)</option>
                      <option value="macd_divergence">MACD Bullish Crossover</option>
                      <option value="bb_squeeze">Bollinger Band Squeeze</option>
                      <option value="adx_trend">ADX Strong Trend (above 25)</option>
                    </optgroup>
                    <optgroup label="Price Action">
                      <option value="breakout">Breakout Analysis (20-day high)</option>
                      <option value="lifetime_high">Life Time High Scan</option>
                      <option value="nr7">NR7 (Narrow Range 7)</option>
                      <option value="inside_bar">Inside Bar Setup</option>
                      <option value="gap_up">Gap Up Open (above 1%)</option>
                      <option value="double_bottom">Scan Double Bottom</option>
                    </optgroup>
                    <optgroup label="Candlesticks">
                      <option value="candle_pattern">Bullish Engulfing</option>
                      <option value="hammer">Hammer Candle</option>
                    </optgroup>
                    <optgroup label="Volume">
                      <option value="volume_spike">Volume Scanner</option>
                      <option value="price_vol_gainers">Price Volume Gainers</option>
                    </optgroup>
                    <optgroup label="Combined">
                      <option value="combine_scans">Combine 2 Different Scans</option>
                    </optgroup>
                  </select>
                  <button className={styles.winBtn} onClick={runCustomQuery}>
                    {queryLoading ? "Scanning..." : "Run Scan"}
                  </button>
                </div>
              </div>

              <div className={styles.winTableContainer}>
                <table className={styles.winTable}>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Company Name</th>
                      <th>Close Price</th>
                      <th>Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queryMatches.map((m, i) => (
                      <tr key={m.symbol} onClick={() => startResultNav(queryMatches, i, "Scan results")} style={{cursor: "pointer"}} title="Open on chart & step through results">
                        <td>{m.symbol}</td>
                        <td>{m.name}</td>
                        <td>{m.close}</td>
                        <td>{m.volume}</td>
                      </tr>
                    ))}
                    {queryMatches.length === 0 && !queryLoading && (
                      <tr><td colSpan="4" style={{textAlign:"center", color:"#888"}}>No matches found. Run scan to populate.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{display: "flex", justifyContent: "space-between", gap: "8px", marginTop: "4px"}}>
                <div style={{display: "flex", gap: "8px"}}>
                  <button className={styles.winBtn} onClick={openScanHistory}>🕘 Scan History</button>
                  {queryMatches.length > 0 && (
                    <button className={styles.winBtn} onClick={() => startResultNav(queryMatches, 0, "Scan results")}>
                      ▶ View all on chart ({queryMatches.length})
                    </button>
                  )}
                </div>
                <div style={{display: "flex", gap: "8px"}}>
                  <button className={styles.winBtn} onClick={() => setQueryMatches([])}>Clear Results</button>
                  <button className={styles.winBtn} onClick={() => setShowCustomQuery(false)}>Close</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {resultNav && (
        <div style={{
          position: "fixed", bottom: "18px", left: "50%", transform: "translateX(-50%)",
          zIndex: 4000, display: "flex", alignItems: "center", gap: "10px",
          background: "rgba(20,22,28,0.96)", border: "1px solid #3a3f4b", borderRadius: "10px",
          padding: "8px 12px", boxShadow: "0 6px 24px rgba(0,0,0,0.5)", color: "#e6e6e6",
          fontSize: "13px"
        }}>
          <span style={{ color: "#9aa4b2", fontSize: "11px", maxWidth: "170px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{resultNav.label}</span>
          <button onClick={() => navResult(-1)} title="Previous (←)"
            style={{ background: "#2a2f3a", border: "1px solid #3a3f4b", color: "#e6e6e6", borderRadius: "6px", padding: "4px 11px", cursor: "pointer", fontSize: "14px", lineHeight: 1 }}>◀</button>
          <span style={{ fontWeight: 600, minWidth: "140px", textAlign: "center" }}>
            {resultNav.symbols[resultNav.index]}
            <span style={{ color: "#9aa4b2", fontWeight: 400 }}> ({resultNav.index + 1} / {resultNav.symbols.length})</span>
          </span>
          <button onClick={() => navResult(1)} title="Next (→)"
            style={{ background: "#2a2f3a", border: "1px solid #3a3f4b", color: "#e6e6e6", borderRadius: "6px", padding: "4px 11px", cursor: "pointer", fontSize: "14px", lineHeight: 1 }}>▶</button>
          <button onClick={closeResultNav} title="Close (Esc)"
            style={{ background: "transparent", border: "1px solid #3a3f4b", color: "#ff8080", borderRadius: "6px", padding: "4px 9px", cursor: "pointer", fontSize: "13px", lineHeight: 1 }}>✕</button>
        </div>
      )}

      {showScanHistory && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "640px" }}>
            <div className={styles.winTitleBar}>
              <span>Scan History{selectedHistory ? " — Saved Result" : ""}</span>
              <button className={styles.winCloseBtn} onClick={() => setShowScanHistory(false)}>X</button>
            </div>
            <div className={styles.winBody}>
              {historyLoading && (
                <div style={{ textAlign: "center", color: "#888", padding: "16px" }}>Loading…</div>
              )}

              {!historyLoading && !selectedHistory && (
                <div className={styles.winTableContainer}>
                  <table className={styles.winTable}>
                    <thead>
                      <tr><th>Date / Time</th><th>Type</th><th>Scan</th><th>Matches</th></tr>
                    </thead>
                    <tbody>
                      {scanHistory.map(h => (
                        <tr key={h.id} onClick={() => setSelectedHistory(h)} style={{ cursor: "pointer" }}>
                          <td>{fmtHistoryTime(h.created_at)}</td>
                          <td>{h.scan_type}</td>
                          <td style={{ maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summarizeHistoryParams(h.params)}</td>
                          <td>{h.result_count}</td>
                        </tr>
                      ))}
                      {scanHistory.length === 0 && (
                        <tr><td colSpan="4" style={{ textAlign: "center", color: "#888" }}>No saved scans yet. Run a scan to populate history.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {!historyLoading && selectedHistory && (
                <>
                  <div style={{ fontSize: "12px", color: "#aaa", marginBottom: "6px" }}>
                    {fmtHistoryTime(selectedHistory.created_at)} · {selectedHistory.scan_type} · {selectedHistory.result_count} matches
                  </div>
                  <div className={styles.winTableContainer}>
                    <table className={styles.winTable}>
                      <thead>
                        <tr><th>Symbol</th><th>Name</th><th>Close</th><th>Volume</th></tr>
                      </thead>
                      <tbody>
                        {(selectedHistory.matches || []).map((m, i) => (
                          <tr key={(m.symbol || "row") + "-" + i}
                              onClick={() => startResultNav(selectedHistory.matches, i, `${selectedHistory.scan_type} · ${fmtHistoryTime(selectedHistory.created_at)}`)}
                              style={{ cursor: "pointer" }} title="Open on chart & step through results">
                            <td>{m.symbol}</td>
                            <td>{m.name}</td>
                            <td>{m.close}</td>
                            <td>{m.volume}</td>
                          </tr>
                        ))}
                        {(!selectedHistory.matches || selectedHistory.matches.length === 0) && (
                          <tr><td colSpan="4" style={{ textAlign: "center", color: "#888" }}>This scan had no matches.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginTop: "4px" }}>
                {selectedHistory
                  ? <button className={styles.winBtn} onClick={() => setSelectedHistory(null)}>← Back to list</button>
                  : <button className={styles.winBtn} onClick={openScanHistory}>↻ Refresh</button>}
                <div style={{ display: "flex", gap: "8px" }}>
                  {selectedHistory && (selectedHistory.matches || []).length > 0 && (
                    <button className={styles.winBtn} onClick={() => startResultNav(selectedHistory.matches, 0, `${selectedHistory.scan_type} · ${fmtHistoryTime(selectedHistory.created_at)}`)}>
                      ▶ View all on chart ({selectedHistory.matches.length})
                    </button>
                  )}
                  <button className={styles.winBtn} onClick={() => setShowScanHistory(false)}>Close</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showMAAnalysis && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "650px" }}>
            <div className={styles.winTitleBar}>
              <span>Moving Average Analysis</span>
              <button className={styles.winCloseBtn} onClick={() => setShowMAAnalysis(false)}>X</button>
            </div>
            <div className={styles.winBody}>
              <div className={styles.winGroupBox}>
                <span className={styles.winGroupBoxLegend}>Scan Builder</span>
                <div style={{display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px"}}>
                  <select className={styles.winSelect} value={maConfig.compareType} onChange={e => setMAConfig({...maConfig, compareType: e.target.value})}>
                    <option value="price">Price</option>
                    <option value="ma">Moving Avg</option>
                  </select>
                  {maConfig.compareType === "ma" && (
                     <>
                        <select className={styles.winSelect} value={maConfig.type} onChange={e => setMAConfig({...maConfig, type: e.target.value})}>
                          <option value="sma">Simple</option>
                          <option value="ema">Exponential</option>
                        </select>
                        <input type="number" className={styles.winInput} value={maConfig.period1} onChange={e => setMAConfig({...maConfig, period1: e.target.value})} style={{width: "50px"}} />
                     </>
                  )}
                  <select className={styles.winSelect} value={maConfig.operator} onChange={e => setMAConfig({...maConfig, operator: e.target.value})}>
                    <option value="crosses_above">Crosses Above</option>
                    <option value="crosses_below">Crosses Below</option>
                    <option value="gt">Greater Than</option>
                    <option value="lt">Less Than</option>
                  </select>
                  <select className={styles.winSelect} value={maConfig.type} onChange={e => setMAConfig({...maConfig, type: e.target.value})}>
                    <option value="sma">SMA</option>
                    <option value="ema">EMA</option>
                  </select>
                  <input type="number" className={styles.winInput} value={maConfig.compareType === "price" ? maConfig.period1 : maConfig.period2} onChange={e => {
                     const val = e.target.value;
                     if(maConfig.compareType === "price") setMAConfig({...maConfig, period1: val});
                     else setMAConfig({...maConfig, period2: val});
                  }} style={{width: "50px"}} />
                  <button className={styles.winBtn} onClick={runMAAnalysis} style={{marginLeft: "auto"}}>
                    {maLoading ? "Scanning..." : "Run MA Scan"}
                  </button>
                </div>
              </div>

              <div className={styles.winTableContainer} style={{maxHeight: "200px"}}>
                <table className={styles.winTable}>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Company Name</th>
                      <th>Close Price</th>
                      <th>Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {maMatches.map(m => (
                      <tr key={m.symbol} onClick={() => { selectSymbol(m.symbol); setShowMAAnalysis(false); }} style={{cursor: "pointer"}}>
                        <td>{m.symbol}</td>
                        <td>{m.name}</td>
                        <td>{m.close}</td>
                        <td>{m.volume}</td>
                      </tr>
                    ))}
                    {maMatches.length === 0 && !maLoading && (
                      <tr><td colSpan="4" style={{textAlign:"center", color:"#888"}}>No matches found. Build & Run scan above.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px"}}>
                <button className={styles.winBtn} onClick={() => setMAMatches([])}>Clear Results</button>
                <button className={styles.winBtn} onClick={() => setShowMAAnalysis(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRiskCalc && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "350px" }}>
            <div className={styles.winTitleBar}>
              <span>Position Size & Risk Calculator</span>
              <button className={styles.winCloseBtn} onClick={() => setShowRiskCalc(false)}>X</button>
            </div>
            <div className={styles.winBody}>
              <div className={styles.winRow}>
                 <span className={styles.riskCalcLabel}>Total Capital:</span>
                 <input type="number" className={styles.winInput} value={riskData.capital} onChange={e => setRiskData({...riskData, capital: parseFloat(e.target.value)})} />
              </div>
              <div className={styles.winRow}>
                 <span className={styles.riskCalcLabel}>Risk Per Trade (%):</span>
                 <input type="number" className={styles.winInput} value={riskData.riskPct} onChange={e => setRiskData({...riskData, riskPct: parseFloat(e.target.value)})} />
              </div>
              <div className={styles.winRow}>
                 <span className={styles.riskCalcLabel}>Entry Price:</span>
                 <input type="number" className={styles.winInput} value={riskData.entry || lastBar?.close || 0} onChange={e => setRiskData({...riskData, entry: parseFloat(e.target.value)})} />
              </div>
              <div className={styles.winRow}>
                 <span className={styles.riskCalcLabel}>Stop Loss:</span>
                 <input type="number" className={styles.winInput} value={riskData.stop} onChange={e => setRiskData({...riskData, stop: parseFloat(e.target.value)})} />
              </div>
              <div className={styles.riskCalcResult} style={{marginTop: "12px"}}>
                 Max Risk Amount: ₹ {Math.round(riskData.capital * (riskData.riskPct / 100))} <br/>
                 Position Size (Shares): {Math.abs(riskData.entry - riskData.stop) > 0 ? Math.round((riskData.capital * (riskData.riskPct / 100)) / Math.abs(riskData.entry - riskData.stop)) : 0}
              </div>
              <div style={{display: "flex", justifyContent: "flex-end", marginTop: "12px"}}>
                <button className={styles.winBtn} onClick={() => setShowRiskCalc(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAlerts && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "500px" }}>
            <div className={styles.winTitleBar}>
              <span>Intraday Trading Alerts</span>
              <button className={styles.winCloseBtn} onClick={() => setShowAlerts(false)}>X</button>
            </div>
            <div className={styles.winBody}>
              <div className={styles.winTableContainer}>
                <table className={styles.winTable}>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Symbol</th>
                      <th>Condition</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alertsList.map(a => (
                      <tr key={a.id} style={{color: a.status === 'Triggered' ? 'red' : 'black', fontWeight: a.status === 'Triggered' ? 'bold' : 'normal'}}>
                        <td>{a.time}</td>
                        <td>{a.symbol}</td>
                        <td>{a.condition}</td>
                        <td>{a.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{display: "flex", justifyContent: "space-between", marginTop: "8px"}}>
                <button className={styles.winBtn}>+ New Alert</button>
                <button className={styles.winBtn} onClick={() => setShowAlerts(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dataFeedStatus && (
        <div className={styles.modalOverlay} style={{background: "transparent"}}>
          <div className={styles.winDialog} style={{ width: "300px", position: "absolute", bottom: "50px", right: "20px" }}>
            <div className={styles.winTitleBar}>
              <span>Data Feeder</span>
            </div>
            <div className={styles.winBody} style={{textAlign: "center", padding: "20px"}}>
              <span style={{fontWeight: "bold", color: "#000080"}}>{dataFeedStatus}</span>
              {dataFeedStatus !== "Complete" && (
                <div style={{marginTop: "10px", width: "100%", height: "15px", background: "#FFF", border: "1px solid #7F9DB9"}}>
                   <div style={{width: "50%", height: "100%", background: "#000080", animation: "pulse 1s infinite"}}></div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Dialog */}
      {showSettings && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "380px" }}>
            <div className={styles.winTitleBar}>
              <span>Settings</span>
              <button className={styles.winCloseBtn} onClick={() => setShowSettings(false)}>X</button>
            </div>
            <div className={styles.winBody}>
              <div className={styles.winGroupBox}>
                <span className={styles.winGroupBoxLegend}>Chart Display</span>
                <div className={styles.winRow}>
                  <span className={styles.riskCalcLabel}>Default Timeframe:</span>
                  <select className={styles.winSelect} value={activeTimeframe} onChange={e => handleTimeframeChange(e.target.value)}>
                    <option value="D">Daily</option>
                    <option value="W">Weekly</option>
                    <option value="M">Monthly</option>
                  </select>
                </div>
                <div className={styles.winRow}>
                  <span className={styles.riskCalcLabel}>Default Symbol:</span>
                  <input type="text" className={styles.winInput} defaultValue={symbol} onBlur={e => setSymbol(e.target.value.toUpperCase())} style={{width:"80px"}} />
                </div>
              </div>
              <div className={styles.winGroupBox} style={{marginTop:"8px"}}>
                <span className={styles.winGroupBoxLegend}>Indicator Parameters</span>
                <div className={styles.winRow} style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"4px"}}>
                  <span className={styles.riskCalcLabel}>RSI Period:</span>
                  <input type="number" className={styles.winInput} value={rsiPeriod} onChange={e => setIndicatorParam('rsi','period',parseInt(e.target.value) || 14)} style={{width:"50px"}} />
                </div>
                <div className={styles.winRow} style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"4px"}}>
                  <span className={styles.riskCalcLabel}>MACD Fast:</span>
                  <input type="number" className={styles.winInput} value={macdFast} onChange={e => setIndicatorParam('macd','fast',parseInt(e.target.value) || 12)} style={{width:"50px"}} />
                </div>
                <div className={styles.winRow} style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"4px"}}>
                  <span className={styles.riskCalcLabel}>MACD Slow:</span>
                  <input type="number" className={styles.winInput} value={macdSlow} onChange={e => setIndicatorParam('macd','slow',parseInt(e.target.value) || 26)} style={{width:"50px"}} />
                </div>
                <div className={styles.winRow} style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <span className={styles.riskCalcLabel}>MACD Signal:</span>
                  <input type="number" className={styles.winInput} value={macdSignal} onChange={e => setIndicatorParam('macd','signal',parseInt(e.target.value) || 9)} style={{width:"50px"}} />
                </div>
              </div>
              <div className={styles.winGroupBox} style={{marginTop:"8px"}}>
                <span className={styles.winGroupBoxLegend}>Default Indicators</span>
                <div style={{display:"flex", flexWrap:"wrap", gap:"6px", padding:"4px 0"}}>
                  {INDICATOR_GROUPS.flatMap(g => g.items).map(ind => (
                    <label key={ind.id} style={{display:"flex", alignItems:"center", gap:"3px", fontSize:"11px", cursor:"pointer"}}>
                      <input type="checkbox"
                        checked={activeIndicators.includes(ind.id)}
                        onChange={() => handleToggleIndicator(ind.id)}
                      />
                      <span style={{color: ind.color}}>{ind.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{display: "flex", justifyContent: "flex-end", marginTop: "12px"}}>
                <button className={styles.winBtn} onClick={() => setShowSettings(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Videos Dialog */}
      {showVideos && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "500px" }}>
            <div className={styles.winTitleBar}>
              <span>{showVideos === 'basic' ? 'Basic Tutorial Videos' : 'Help Videos'}</span>
              <button className={styles.winCloseBtn} onClick={() => setShowVideos(null)}>X</button>
            </div>
            <div className={styles.winBody}>
              <div className={styles.winGroupBox}>
                <span className={styles.winGroupBoxLegend}>{showVideos === 'basic' ? 'Getting Started' : 'Advanced Help'}</span>
                {(showVideos === 'basic' ? [
                  { title: '1. Introduction to KeyStocks-Lite', desc: 'Overview of chart types and navigation' },
                  { title: '2. Reading Candlestick Charts', desc: 'Understanding OHLC, patterns and signals' },
                  { title: '3. Using Moving Averages', desc: 'SMA, EMA, and crossover strategies' },
                  { title: '4. Drawing Trendlines', desc: 'How to draw and use trendlines on the chart' },
                ] : [
                  { title: '1. Using the Scanner', desc: 'How to build and run custom scans' },
                  { title: '2. Risk Calculator', desc: 'Position sizing and risk management' },
                  { title: '3. Alert System', desc: 'Setting up price and indicator alerts' },
                  { title: '4. Fibonacci Retracements', desc: 'Drawing Fibonacci levels on swing highs/lows' },
                ]).map((v, i) => (
                  <div key={i} style={{padding: "6px 4px", borderBottom: "1px solid #ccc", cursor:"pointer"}} onClick={() => alert('Video content not yet linked. Module: ' + v.title)}>
                    <div style={{fontWeight:"bold", fontSize:"12px"}}>{v.title}</div>
                    <div style={{fontSize:"11px", color:"#555"}}>{v.desc}</div>
                  </div>
                ))}
              </div>
              <div style={{display: "flex", justifyContent: "flex-end", marginTop: "8px"}}>
                <button className={styles.winBtn} onClick={() => setShowVideos(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Watchlist Manager Dialog */}
      {showWatchlistMgr && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "400px" }}>
            <div className={styles.winTitleBar}>
              <span>{showWatchlistMgr === 'new' ? 'Create New Watchlist' : 'Manage Watchlists'}</span>
              <button className={styles.winCloseBtn} onClick={() => setShowWatchlistMgr(null)}>X</button>
            </div>
            <div className={styles.winBody}>
              {showWatchlistMgr === 'new' ? (
                <div className={styles.winGroupBox}>
                  <span className={styles.winGroupBoxLegend}>New Watchlist</span>
                  <div className={styles.winRow}>
                    <span className={styles.riskCalcLabel}>Name:</span>
                    <input type="text" className={styles.winInput} placeholder="My Watchlist" style={{flex:1}} />
                  </div>
                  <div style={{marginTop:"8px", fontSize:"11px", color:"#555"}}>Add symbols separated by commas:</div>
                  <textarea className={styles.winInput} rows={3} placeholder="RELIANCE, TCS, INFY..." style={{width:"100%", marginTop:"4px", resize:"vertical", fontFamily:"inherit"}} />
                  <div style={{display:"flex", justifyContent:"flex-end", gap:"8px", marginTop:"8px"}}>
                    <button className={styles.winBtn} onClick={() => alert('Watchlist saved! (Feature coming soon)')}>Save</button>
                    <button className={styles.winBtn} onClick={() => setShowWatchlistMgr(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className={styles.winGroupBox}>
                  <span className={styles.winGroupBoxLegend}>Available Watchlists</span>
                  {Object.keys(INDICES).map(grp => (
                    <div key={grp} style={{padding:"4px 6px", display:"flex", justifyContent:"space-between", borderBottom:"1px solid #ddd"}}>
                      <span style={{fontSize:"12px"}}>{grp}</span>
                      <button className={styles.winBtn} onClick={() => setActiveSector(grp)}>Load</button>
                    </div>
                  ))}
                  <div style={{display:"flex", justifyContent:"flex-end", marginTop:"8px"}}>
                    <button className={styles.winBtn} onClick={() => setShowWatchlistMgr(null)}>Close</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Analysis Search Dialog (separate from Custom Query) */}
      {showAnalysisSearch && (
        <div className={styles.modalOverlay}>
          <div className={styles.winDialog} style={{ width: "550px" }}>
            <div className={styles.winTitleBar}>
              <span>Analysis Search</span>
              <button className={styles.winCloseBtn} onClick={() => setShowAnalysisSearch(false)}>X</button>
            </div>
            <div className={styles.winBody}>
              <div className={styles.winGroupBox}>
                <span className={styles.winGroupBoxLegend}>Search by Analysis Type</span>
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px", marginTop:"6px"}}>
                  {[
                    { label: "Stocks near 52W High",      action: () => { setQueryParam("lifetime_high"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "RSI Oversold (< 30)",        action: () => { setQueryParam("rsi_oversold"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "MA Crossover Signal",         action: () => { setQueryParam("sma_cross"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "Breakout Stocks",             action: () => { setQueryParam("breakout"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "Volume Spike Stocks",         action: () => { setQueryParam("volume_spike"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "Pullback Opportunities",      action: () => { setQueryParam("pullback"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "Price-MA Cross",              action: () => { setQueryParam("price_ma_cross"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "MACD Signal Cross",           action: () => { setQueryParam("macd_divergence"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "Candle Pattern Stocks",       action: () => { setQueryParam("candle_pattern"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                    { label: "Price & Volume Gainers",      action: () => { setQueryParam("price_vol_gainers"); setShowCustomQuery(true); setShowAnalysisSearch(false); } },
                  ].map((item, i) => (
                    <button key={i} className={styles.winBtn} style={{textAlign:"left", padding:"4px 8px"}} onClick={item.action}>{item.label}</button>
                  ))}
                </div>
              </div>
              <div style={{display: "flex", justifyContent: "flex-end", marginTop: "12px"}}>
                <button className={styles.winBtn} onClick={() => setShowAnalysisSearch(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Premium Upgrade Modal */}
      {premiumUpgradeMessage && (
        <div className="premium-overlay" onClick={() => setPremiumUpgradeMessage(null)}>
          <div className="premium-modal" onClick={(e) => e.stopPropagation()}>
            <div className="premium-header">
              <span className="premium-icon">⭐</span>
              <h2>Premium Feature</h2>
            </div>
            <p className="premium-text">{premiumUpgradeMessage}</p>
            <div className="premium-ctas">
              <a href="/dashboard/pricing" className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }}>
                🚀 Upgrade Plan Now
              </a>
              <button className="btn btn-outline" onClick={() => setPremiumUpgradeMessage(null)} style={{ width: "100%", justifyContent: "center" }}>
                Maybe Later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}