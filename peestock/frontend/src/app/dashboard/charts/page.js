"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import styles from "./charts.module.css";

const TIMEFRAMES = [
  { label: "D", value: "D" },
  { label: "W", value: "W" },
  { label: "M", value: "M" },
];

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
    let lastTime = new Date(result[0].time);
    finalResult.push({
      ...result[0],
      time: result[0].time
    });
    for (let i = 1; i < result.length; i++) {
      let currTime = new Date(result[i].time);
      if (currTime <= lastTime) {
        currTime = new Date(lastTime.getTime() + 24 * 60 * 60 * 1000); // add 1 day
      }
      const yyyy = currTime.getFullYear();
      const mm = String(currTime.getMonth() + 1).padStart(2, '0');
      const dd = String(currTime.getDate()).padStart(2, '0');
      const timeStr = `${yyyy}-${mm}-${dd}`;
      
      finalResult.push({
        ...result[i],
        time: timeStr
      });
      lastTime = currTime;
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
    let lastTime = new Date(result[0].time);
    finalResult.push({
      ...result[0],
      time: result[0].time
    });
    for (let i = 1; i < result.length; i++) {
      let currTime = new Date(result[i].time);
      if (currTime <= lastTime) {
        currTime = new Date(lastTime.getTime() + 24 * 60 * 60 * 1000); // add 1 day
      }
      const yyyy = currTime.getFullYear();
      const mm = String(currTime.getMonth() + 1).padStart(2, '0');
      const dd = String(currTime.getDate()).padStart(2, '0');
      const timeStr = `${yyyy}-${mm}-${dd}`;
      
      finalResult.push({
        ...result[i],
        time: timeStr
      });
      lastTime = currTime;
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
    result.push({ time: t, value: m - s });
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

function aggregateTimeframe(data, tf) {
  if (tf === "D") return data;
  const result = [];
  let currentGroup = null;

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const dateObj = new Date(d.time);
    let groupKey;
    if (tf === "W") {
      const firstDayOfYear = new Date(dateObj.getFullYear(), 0, 1);
      const pastDaysOfYear = (dateObj - firstDayOfYear) / 86400000;
      const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
      groupKey = `${dateObj.getFullYear()}-W${weekNum}`;
    } else {
      groupKey = `${dateObj.getFullYear()}-${dateObj.getMonth()}`;
    }

    if (!currentGroup || currentGroup.key !== groupKey) {
      if (currentGroup) result.push(currentGroup.candle);
      currentGroup = { key: groupKey, candle: { ...d } };
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
  ]
};

export default function ChartsPage() {
  return (
    <Suspense fallback={<div style={{padding: "2rem", color: "#94a3b8"}}>Loading charts...</div>}>
      <ChartsPageContent />
    </Suspense>
  );
}

const BOTTOM_TABS = [
  { id: "Tab1", label: "Tab1", indicators: ["rsi", "macd"] },
  { id: "ma_bb", label: "MA+BB", indicators: ["sma20", "bb"] },
  { id: "lt_hl", label: "LT H/L", indicators: ["sr_levels", "sma200"] },
  { id: "db", label: "DB", indicators: ["pattern_engulfing", "rsi"] },
  { id: "dt", label: "DT", indicators: ["pattern_engulfing", "macd"] },
  { id: "tb", label: "TB", indicators: ["pattern_doji", "stoch"] },
  { id: "tt", label: "TT", indicators: ["pattern_doji", "macd"] },
  { id: "Tab8", label: "Tab8", indicators: ["stoch", "williams"] },
  { id: "Tab9", label: "Tab9", indicators: ["cci", "atr"] },
  { id: "Tab10", label: "Tab10", indicators: ["obv", "mfi"] },
  { id: "Tab11", label: "Tab11", indicators: ["adx", "macd"] },
  { id: "Tab12", label: "Tab12", indicators: ["sma50", "sma200"] },
  { id: "Tab13", label: "Tab13", indicators: ["ema9", "ema20"] },
  { id: "Tab14", label: "Tab14", indicators: ["supertrend", "psar"] },
  { id: "Tab15", label: "Tab15", indicators: ["pattern_hammer", "pattern_doji"] },
  { id: "Harmonic", label: "Harmonic", indicators: ["rsi", "stoch"] },
  { id: "ab_cd", label: "AB=CD", indicators: ["macd", "cci"] },
  { id: "chp3", label: "CHP3", indicators: ["vwap", "cci"] },
  { id: "chp6", label: "CHP6", indicators: ["vwap", "obv"] },
  { id: "chp9", label: "CHP9", indicators: ["vwap", "mfi"] },
  { id: "chp12", label: "CHP12", indicators: ["vwap", "atr"] },
  { id: "fourth_wave", label: "4th Wave", indicators: ["rsi", "williams"] },
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
  const [instruments, setInstruments] = useState([]);
  const [chartData, setChartData] = useState([]);
  const [chartStyle, setChartStyle] = useState("candles");
  const [showStyleMenu, setShowStyleMenu] = useState(false);

  // Close chart style dropdown when clicking outside
  useEffect(() => {
    if (!showStyleMenu) return;
    const handleClose = () => setShowStyleMenu(false);
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
  }, [showStyleMenu]);
  
  const [activeTimeframe, setActiveTimeframe] = useState("D");
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
      { id:'sma20',    label:'SMA 20',       color:'#FF6600', panel:'main' },
      { id:'sma44',    label:'SMA 44',       color:'#FF0000', panel:'main' },
      { id:'sma50',    label:'SMA 50',       color:'#AA00AA', panel:'main' },
      { id:'sma200',   label:'SMA 200',      color:'#0000FF', panel:'main' },
      { id:'ema9',     label:'EMA 9',        color:'#00AAAA', panel:'main' },
      { id:'ema20',    label:'EMA 20',       color:'#FF8800', panel:'main' },
      { id:'ema50',    label:'EMA 50',       color:'#9900AA', panel:'main' },
      { id:'supertrend', label:'SuperTrend', color:'#00AA00', panel:'main' },
      { id:'psar',     label:'Parabolic SAR',color:'#FF4400', panel:'main' },
      { id:'vwap',     label:'VWAP',         color:'#0066FF', panel:'main' },
      { id:'sr_levels', label:'S&R Auto Levels', color:'#FF00FF', panel:'main' },
    ]},
    { group: 'Volatility', items: [
      { id:'bb',       label:'Bollinger Bands', color:'#0000FF', panel:'main' },
      { id:'atr',      label:'ATR (14)',      color:'#AA6600', panel:'sub' },
    ]},
    { group: 'Momentum', items: [
      { id:'rsi',      label:'RSI (14)',      color:'#800080', panel:'sub' },
      { id:'macd',     label:'MACD',          color:'#0000AA', panel:'sub' },
      { id:'stoch',    label:'Stochastic',    color:'#007700', panel:'sub' },
      { id:'cci',      label:'CCI (20)',      color:'#AA0044', panel:'sub' },
      { id:'williams', label:'Williams %R',   color:'#008844', panel:'sub' },
      { id:'mfi',      label:'Money Flow Index', color:'#6600AA', panel:'sub' },
    ]},
    { group: 'Volume', items: [
      { id:'obv',      label:'On-Balance Vol', color:'#004488', panel:'sub' },
      { id:'adx',      label:'ADX (14)',      color:'#CC6600', panel:'sub' },
    ]},
    { group: 'Candlestick Patterns', items: [
      { id:'pattern_doji',      label:'Doji Pattern',      color:'#FF6600', panel:'main' },
      { id:'pattern_hammer',    label:'Hammer Pattern',    color:'#00AA00', panel:'main' },
      { id:'pattern_engulfing', label:'Engulfing Pattern', color:'#0000FF', panel:'main' },
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

  const [activeIndicators, setActiveIndicators] = useState(['rsi', 'macd']); // rsi+macd enabled by default, can be toggled
  const [rsiPeriod, setRsiPeriod] = useState(14);
  const [macdFast, setMacdFast] = useState(12);
  const [macdSlow, setMacdSlow] = useState(26);
  const [macdSignal, setMacdSignal] = useState(9);
  const [menuTab, setMenuTab] = useState('tools'); // 'tools' | 'indicators' | 'signals'
  const maLineIdRef = useRef(10);
  const [maLines, setMALines] = useState([
    { id: 1, type: 'SMA', period: 20,  color: '#FF6600', visible: true  },
    { id: 2, type: 'SMA', period: 44,  color: '#FF0000', visible: true  },
    { id: 3, type: 'EMA', period: 9,   color: '#00AAAA', visible: true  },
    { id: 4, type: 'SMA', period: 200, color: '#0000FF', visible: false },
  ]);
  const chartDataRef = useRef([]); // for OHLC snap

  const [showCustomQuery, setShowCustomQuery] = useState(false);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryMatches, setQueryMatches] = useState([]);
  const [queryParam, setQueryParam] = useState("sma_cross");

  const [activeSector, setActiveSector] = useState("NIFTY 50");
  
  // New UI feature states
  const [activeMainTab, setActiveMainTab] = useState("Main"); // 'Main' | 'Multiple Charts'
  const [showRiskCalc, setShowRiskCalc] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState("Tab1");
  const [riskData, setRiskData] = useState({ capital: 100000, riskPct: 2, entry: 0, stop: 0 });
  const [showSettings, setShowSettings] = useState(false);
  const [showVideos, setShowVideos] = useState(null); // 'basic' | 'help'
  const [showWatchlistMgr, setShowWatchlistMgr] = useState(null); // 'new' | 'manage'
  const [showAnalysisSearch, setShowAnalysisSearch] = useState(false);
  const [chartBars, setChartBars] = useState(50); // bars to show (▶ button input)

  // Panel split points (fractions 0–1 of chart height) — candle/vol | vol/RSI | RSI/MACD
  const [panelSplits, setPanelSplits] = useState({ v1: 0.55, v2: 0.73, v3: 0.87 });
  
  // Intraday & Alerts states
  const [isIntradayMode, setIsIntradayMode] = useState(false);
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

  // Load Watchlist (Mocking for UI clone)
  useEffect(() => {
    api.listInstruments({ limit: 50 }).then(setInstruments).catch(() => {});
  }, []);

  // Escape key cancels active drawing tool
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { setActiveTool(null); setDrawStep(0); setTempStart(null); setTempEnd(null); setToolMenu(null); setSelectedId(null); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const loadChart = useCallback(async (sym) => {
    try {
      const data = await api.getEod(sym);
      setChartData(data);
      setUserDrawings([]);
    } catch (err) {
      setChartData([]);
    }
  }, []);

  useEffect(() => {
    loadChart(symbol);
  }, [symbol, loadChart]);

  // Initialize and update chart
  useEffect(() => {
    if (!chartRef.current || chartData.length === 0) return;

    const initChart = async () => {
      const { createChart, CrosshairMode, ColorType, LineStyle, CandlestickSeries, HistogramSeries, LineSeries, BarSeries, AreaSeries, BaselineSeries, LineType, createSeriesMarkers } = await import("lightweight-charts");

      if (chartInstance.current) {
        chartInstance.current.remove();
      }
      seriesRefs.current = {};

      const chart = createChart(chartRef.current, {
        width: chartRef.current.clientWidth,
        height: chartRef.current.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: "#FFFFFF" },
          textColor: "#333333",
          fontFamily: "'Tahoma', 'Arial', sans-serif",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "#E0E0E0", style: LineStyle.Dotted },
          horzLines: { color: "#E0E0E0", style: LineStyle.Dotted },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: '#808080',
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: '#808080',
          },
          horzLine: {
            color: '#808080',
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: '#808080',
          },
        },
        rightPriceScale: { borderColor: "#C0C0C0" },
        timeScale: {
          borderColor: "#C0C0C0",
          rightOffset: 6,
          fixRightEdge: false,
        },
      });

      chartInstance.current = chart;

      const rawCandleData = chartData.map((d) => ({
        time: d.time.split("T")[0],
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));
      const baseCandleData = aggregateTimeframe(rawCandleData, activeTimeframe);
      
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
        candleSeries = chart.addSeries(BarSeries, {
          upColor: "#26a69a",
          downColor: "#ef5350",
          openVisible: true,
          thinBars: false,
        });
      } else if (chartStyle === "hollow_candles") {
        candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: "rgba(0,0,0,0)",
          downColor: "#ef5350",
          borderVisible: true,
          borderUpColor: "#26a69a",
          borderDownColor: "#ef5350",
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350",
        });
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
        candleSeries = chart.addSeries(CandlestickSeries, {
          borderVisible: true,
        });
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
        candleSeries = chart.addSeries(LineSeries, {
          color: "#26a69a",
          lineWidth: 2,
        });
      } else if (chartStyle === "line_markers") {
        candleSeries = chart.addSeries(LineSeries, {
          color: "#26a69a",
          lineWidth: 2,
        });
      } else if (chartStyle === "step_line") {
        candleSeries = chart.addSeries(LineSeries, {
          color: "#26a69a",
          lineWidth: 2,
          lineType: LineType.WithSteps,
        });
      } else if (chartStyle === "area") {
        candleSeries = chart.addSeries(AreaSeries, {
          topColor: "rgba(38, 166, 154, 0.4)",
          bottomColor: "rgba(38, 166, 154, 0.0)",
          lineColor: "#26a69a",
          lineWidth: 2,
        });
      } else if (chartStyle === "hlc_area") {
        candleSeries = chart.addSeries(AreaSeries, {
          topColor: "rgba(38, 166, 154, 0.3)",
          bottomColor: "rgba(38, 166, 154, 0.0)",
          lineColor: "#26a69a",
          lineWidth: 2,
        });
      } else if (chartStyle === "baseline") {
        const avgPrice = candleData.reduce((sum, d) => sum + d.close, 0) / (candleData.length || 1);
        candleSeries = chart.addSeries(BaselineSeries, {
          baseValue: { type: 'price', price: avgPrice },
          topFillColor1: 'rgba(38, 166, 154, 0.28)',
          topFillColor2: 'rgba(38, 166, 154, 0.05)',
          topLineColor: '#26a69a',
          bottomFillColor1: 'rgba(239, 83, 80, 0.05)',
          bottomFillColor2: 'rgba(239, 83, 80, 0.28)',
          bottomLineColor: '#ef5350',
          lineWidth: 2,
        });
      } else if (chartStyle === "columns") {
        candleSeries = chart.addSeries(HistogramSeries, {
          color: "#26a69a",
          priceFormat: { type: "price" },
        });
      } else if (chartStyle === "high_low") {
        candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: "rgba(0,0,0,0)",
          downColor: "rgba(0,0,0,0)",
          borderVisible: false,
          wickVisible: true,
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350",
        });
      } else {
        // default candles / heikin_ashi / renko / line_break
        candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderVisible: true,
          borderUpColor: "#26a69a",
          borderDownColor: "#ef5350",
          wickDownColor: "#ef5350",
          wickUpColor: "#26a69a",
        });
      }

      // Panel margins derived from panelSplits
      const GAP = 0.015; // small gap between panels
      const { v1, v2, v3 } = panelSplits;

      // Identify active sub-indicators in order
      const activeSubs = activeIndicators.filter(id => ['rsi', 'macd', 'stoch', 'atr', 'cci', 'williams', 'obv', 'mfi', 'adx'].includes(id));
      const subCount = activeSubs.length;

      const subMarginsMap = {};

      if (subCount === 0) {
        // Volume fills the bottom
        subMarginsMap['volume'] = { top: v1 + GAP, bottom: 0.02 };
      } else if (subCount === 1) {
        subMarginsMap['volume'] = { top: v1 + GAP, bottom: 1 - v2 + GAP };
        subMarginsMap[activeSubs[0]] = { top: v2 + GAP, bottom: 0.02 };
      } else if (subCount === 2) {
        subMarginsMap['volume'] = { top: v1 + GAP, bottom: 1 - v2 + GAP };
        subMarginsMap[activeSubs[0]] = { top: v2 + GAP, bottom: 1 - v3 + GAP };
        subMarginsMap[activeSubs[1]] = { top: v3 + GAP, bottom: 0.01 };
      } else {
        // subCount > 2: partition Panel 3 (from v3 to 0.99) among the rest
        subMarginsMap['volume'] = { top: v1 + GAP, bottom: 1 - v2 + GAP };
        subMarginsMap[activeSubs[0]] = { top: v2 + GAP, bottom: 1 - v3 + GAP };
        
        const M = subCount - 1;
        const START_P3 = v3;
        const END_P3 = 0.99;
        const h_p3 = (END_P3 - START_P3) / M;
        for (let idx = 0; idx < M; idx++) {
          const id = activeSubs[idx + 1];
          const top = START_P3 + idx * h_p3 + GAP;
          const bottom = 1 - (START_P3 + (idx + 1) * h_p3 - GAP);
          subMarginsMap[id] = { top, bottom };
        }
      }

      // Candle series scale margins (fits cleanly in the top panel)
      candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.02, bottom: 1 - v1 + GAP } });
      
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
          color: d.close >= d.open ? "#26a69a" : "#ef5350",
        })));
      } else {
        candleSeries.setData(displayData);
      }
      
      seriesRefs.current.candles = candleSeries;

      // Volume series
      if (subMarginsMap['volume']) {
        const volumeSeries = chart.addSeries(HistogramSeries, {
          color: "#26a69a",
          priceFormat: { type: "volume" },
          priceScaleId: "volume",
          lastValueVisible: false,
        });
        volumeSeries.priceScale().applyOptions({
          visible: false,
          scaleMargins: subMarginsMap['volume']
        });
        volumeSeries.setData(candleData.map((d) => ({
          time: d.time, value: d.volume, color: d.close >= d.open ? "#26a69a" : "#ef5350",
        })));
      }

      // RSI series (always rendered, panel height controlled by splits)
      if (activeIndicators.includes('rsi') && subMarginsMap['rsi']) {
        const rsiData = computeRSI(candleData, rsiPeriod);
        if (rsiData.length > 0) {
          const rsiSeries = chart.addSeries(LineSeries, {
            color: "#800080", lineWidth: 1, priceScaleId: "rsi", lastValueVisible: false
          });
          rsiSeries.priceScale().applyOptions({
            visible: false,
            scaleMargins: subMarginsMap['rsi']
          });
          rsiSeries.setData(rsiData);
          const line70 = chart.addSeries(LineSeries, { color:'#FF0000', lineWidth:1, lineStyle:2, priceScaleId:'rsi', lastValueVisible: false });
          line70.setData(rsiData.map(d => ({ time: d.time, value: 70 })));
          const line30 = chart.addSeries(LineSeries, { color:'#00AA00', lineWidth:1, lineStyle:2, priceScaleId:'rsi', lastValueVisible: false });
          line30.setData(rsiData.map(d => ({ time: d.time, value: 30 })));
          line70.priceScale().applyOptions({ visible: false, scaleMargins: subMarginsMap['rsi'] });
          line30.priceScale().applyOptions({ visible: false, scaleMargins: subMarginsMap['rsi'] });
        }
      }

      // MACD series
      if (activeIndicators.includes('macd') && subMarginsMap['macd']) {
        const macdData = computeMACD(candleData, macdFast, macdSlow, macdSignal);
        if (macdData.length > 0) {
          const macdSeries = chart.addSeries(HistogramSeries, {
            priceScaleId: "macd",
            title: 'MACD',
            lastValueVisible: false,
          });
          macdSeries.priceScale().applyOptions({
            visible: false,
            scaleMargins: subMarginsMap['macd']
          });
          macdSeries.setData(macdData.map(d => ({
            time: d.time, value: d.value, color: d.value >= 0 ? '#00AA00' : '#FF0000'
          })));
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
              color: '#FF6600',
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
                color: '#00AA00',
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
                color: '#0000FF',
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
            const bbUpper = chart.addSeries(LineSeries, { color: ma.color, lineWidth: 1, title: '', lastValueVisible: true, priceLineVisible: false });
            bbUpper.setData(bbData.map(d => ({ time: d.time, value: d.upper })));
            const bbMid = chart.addSeries(LineSeries, { color: ma.color, lineWidth: 1, lineStyle: 2, title: '', lastValueVisible: true, priceLineVisible: false });
            bbMid.setData(bbData.map(d => ({ time: d.time, value: d.middle })));
            const bbLower = chart.addSeries(LineSeries, { color: ma.color, lineWidth: 1, title: '', lastValueVisible: true, priceLineVisible: false });
            bbLower.setData(bbData.map(d => ({ time: d.time, value: d.lower })));
          }
          continue;
        }
        if (maData.length) {
          const maSeries = chart.addSeries(LineSeries, {
            color: ma.color, lineWidth: 1.5, title: '',
            lastValueVisible: true,
            priceLineVisible: false,
          });
          maSeries.setData(maData.map(d => ({ time: d.time, value: d.value ?? d })));
        }
      }

      // ── Render all active indicators ──
      const addLine = (data, color, w=1, scaleId='', margins=null, title='') => {
        if (!data || data.length === 0) return;
        const options = { 
          color, 
          lineWidth: w, 
          title: '',
          lastValueVisible: true,
          priceLineVisible: false,
        };
        if (scaleId) {
          options.priceScaleId = scaleId;
        }
        const s = chart.addSeries(LineSeries, options);
        if (margins && scaleId) {
          s.priceScale().applyOptions({ visible: false, scaleMargins: margins });
        }
        s.setData(data.map(d => ({ time: d.time, value: d.value ?? d })));
      };

      if (activeIndicators.includes('sma20')) addLine(computeSMA(candleData,20), '#FF6600', 1.5, '', null, 'SMA20');
      if (activeIndicators.includes('sma44')) addLine(computeSMA(candleData,44), '#FF0000', 1.5, '', null, 'SMA44');
      if (activeIndicators.includes('sma50')) addLine(computeSMA(candleData,50), '#AA00AA', 1.5, '', null, 'SMA50');
      if (activeIndicators.includes('sma200')) addLine(computeSMA(candleData,200), '#0000FF', 2, '', null, 'SMA200');
      if (activeIndicators.includes('ema9')) addLine(computeEMA(candleData,9), '#00AAAA', 1, '', null, 'EMA9');
      if (activeIndicators.includes('ema20')) addLine(computeEMA(candleData,20), '#FF8800', 1.5, '', null, 'EMA20');
      if (activeIndicators.includes('ema50')) addLine(computeEMA(candleData,50), '#9900AA', 1.5, '', null, 'EMA50');
      if (activeIndicators.includes('vwap')) addLine(computeVWAP(candleData), '#0066FF', 1.5, '', null, 'VWAP');
      if (activeIndicators.includes('psar')) {
        const psarData = computePSAR(candleData);
        if (psarData.length) {
          const ps = chart.addSeries(LineSeries, { color:'#FF4400', lineWidth:2, lineStyle:3, title: '', lastValueVisible: true, priceLineVisible: false });
          ps.setData(psarData.map(d => ({ time: d.time, value: d.value })));
        }
      }
      if (activeIndicators.includes('supertrend')) {
        const st = computeSuperTrend(candleData);
        if (st.length) {
          const stS = chart.addSeries(LineSeries, { color:'#00AA00', lineWidth:2, title: '', lastValueVisible: true, priceLineVisible: false });
          stS.setData(st.map(d => ({ time: d.time, value: d.value })));
        }
      }
      if (activeIndicators.includes('bb')) {
        const bbData = computeBB(candleData);
        if (bbData.length) {
          const upper = chart.addSeries(LineSeries, { color:'#0000BB', lineWidth:1.5, title:'', lastValueVisible: true, priceLineVisible: false });
          upper.setData(bbData.map(d => ({ time:d.time, value:d.upper })));
          const mid = chart.addSeries(LineSeries, { color:'#8888BB', lineWidth:1, lineStyle:2, title:'', lastValueVisible: true, priceLineVisible: false });
          mid.setData(bbData.map(d => ({ time:d.time, value:d.middle })));
          const lower = chart.addSeries(LineSeries, { color:'#0000BB', lineWidth:1.5, title:'', lastValueVisible: true, priceLineVisible: false });
          lower.setData(bbData.map(d => ({ time:d.time, value:d.lower })));
        }
      }
      // RSI and MACD are always rendered above with panelSplits margins — skip here to avoid duplicates
      if (activeIndicators.includes('stoch')) {
        const st = computeStochastic(candleData);
        if (st.length) {
          const s = chart.addSeries(LineSeries, { color:'#007700', lineWidth:1.5, priceScaleId:'stoch', title: '', lastValueVisible: true });
          s.priceScale().applyOptions({ visible: false, scaleMargins: subMarginsMap['stoch'] || { top: 0.72, bottom: 0.04 } });
          s.setData(st.map(d=>({time:d.time,value:d.k})));
          
          const dLine = chart.addSeries(LineSeries, { color:'#FF8800', lineWidth:1, priceScaleId:'stoch', title: '', lastValueVisible: true });
          dLine.setData(st.map(d=>({time:d.time,value:d.d})));

          const line80 = chart.addSeries(LineSeries, { color: '#FF0000', lineWidth: 1, lineStyle: 3, priceScaleId: 'stoch', lastValueVisible: false });
          line80.setData(st.map(d => ({ time: d.time, value: 80 })));
          const line20 = chart.addSeries(LineSeries, { color: '#00AA00', lineWidth: 1, lineStyle: 3, priceScaleId: 'stoch', lastValueVisible: false });
          line20.setData(st.map(d => ({ time: d.time, value: 20 })));
        }
      }
      if (activeIndicators.includes('atr')) {
        const at = computeATR(candleData);
        addLine(at, '#AA6600', 1.5, 'atr', subMarginsMap['atr'], 'ATR');
      }
      if (activeIndicators.includes('cci')) {
        const cc = computeCCI(candleData);
        addLine(cc, '#AA0044', 1.5, 'cci', subMarginsMap['cci'], 'CCI');
      }
      if (activeIndicators.includes('williams')) {
        const wr = computeWilliamsR(candleData);
        addLine(wr, '#008844', 1.5, 'williams', subMarginsMap['williams'], 'Williams %R');
      }
      if (activeIndicators.includes('obv')) {
        const ob = computeOBV(candleData);
        addLine(ob, '#004488', 1.5, 'obv', subMarginsMap['obv'], 'OBV');
      }
      if (activeIndicators.includes('mfi')) {
        const mf = computeMFI(candleData);
        addLine(mf, '#6600AA', 1.5, 'mfi', subMarginsMap['mfi'], 'MFI');
      }
      if (activeIndicators.includes('adx')) {
        const adxD = computeADX(candleData);
        addLine(adxD, '#CC6600', 1.5, 'adx', subMarginsMap['adx'], 'ADX');
      }

      // ── Legend Update Logic with Separators & Moving Averages ──
      const updateLegend = (time) => {
        if (!legendRef.current) return;
        
        const idx = candleData.findIndex(d => {
          const t1 = typeof d.time === 'string' ? d.time.split("T")[0] : String(d.time);
          const t2 = typeof time === 'string' ? time.split("T")[0] : String(time);
          return t1 === t2;
        });
        const bar = idx !== -1 ? candleData[idx] : candleData[candleData.length - 1];
        if (!bar) return;
        
        const prevBar = idx > 0 ? candleData[idx - 1] : null;
        
        const barTimeStr = typeof bar.time === 'string' ? bar.time.split("T")[0] : bar.time;
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
          ${symbol} (${activeTimeframe === 'D' ? 'Daily' : activeTimeframe === 'W' ? 'Weekly' : 'Monthly'}) | 
          Date: ${barTimeStr} | 
          Open: <span style="font-weight: bold;">${openVal}</span> | 
          High: <span style="font-weight: bold;">${highVal}</span> | 
          Low: <span style="font-weight: bold;">${lowVal}</span> | 
          Close: <span style="font-weight: bold;">${closeVal}</span> | 
          Volume: <span style="font-weight: bold;">${volumeVal}</span>
        `;
        
        const findItemByTime = (arr, targetTime) => {
          if (!arr) return null;
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
          legendHtml += ` | <span style="color: ${ma.color}; font-weight: bold;">${ma.type}(${p}):</span> ${maVal}`;
        }
        
        // 2. Preset active indicators MAs
        if (activeIndicators.includes('sma20')) {
          const item = findItemByTime(computeSMA(candleData, 20), bar.time);
          legendHtml += ` | <span style="color: #FF6600; font-weight: bold;">SMA(20):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        if (activeIndicators.includes('sma44')) {
          const item = findItemByTime(computeSMA(candleData, 44), bar.time);
          legendHtml += ` | <span style="color: #FF0000; font-weight: bold;">SMA(44):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        if (activeIndicators.includes('sma50')) {
          const item = findItemByTime(computeSMA(candleData, 50), bar.time);
          legendHtml += ` | <span style="color: #AA00AA; font-weight: bold;">SMA(50):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        if (activeIndicators.includes('sma200')) {
          const item = findItemByTime(computeSMA(candleData, 200), bar.time);
          legendHtml += ` | <span style="color: #0000FF; font-weight: bold;">SMA(200):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        if (activeIndicators.includes('ema9')) {
          const item = findItemByTime(computeEMA(candleData, 9), bar.time);
          legendHtml += ` | <span style="color: #00AAAA; font-weight: bold;">EMA(9):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        if (activeIndicators.includes('ema20')) {
          const item = findItemByTime(computeEMA(candleData, 20), bar.time);
          legendHtml += ` | <span style="color: #FF8800; font-weight: bold;">EMA(20):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        if (activeIndicators.includes('ema50')) {
          const item = findItemByTime(computeEMA(candleData, 50), bar.time);
          legendHtml += ` | <span style="color: #9900AA; font-weight: bold;">EMA(50):</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        if (activeIndicators.includes('vwap')) {
          const item = findItemByTime(computeVWAP(candleData), bar.time);
          legendHtml += ` | <span style="color: #0066FF; font-weight: bold;">VWAP:</span> ${item ? (item.value ?? item).toFixed(2) : "--"}`;
        }
        
        if (activeBottomTab === "Harmonic") {
          legendHtml += ` <span style="color:#FF00FF; font-weight:bold; margin-left:8px;">[ Bullish Bat Pattern Detected ]</span>`;
        }
        
        legendHtml += `
          <br />
          <span style="font-size: 14px; font-weight: bold; color: ${changeColor};">${closeVal} (${changeSign}${pct.toFixed(2)}%)</span>
          <span style="font-size: 14px; color: #333333; margin-left: 8px;">${symbol}</span>
        `;
        
        legendRef.current.innerHTML = legendHtml;
      };

      // Initial draw
      updateLegend(candleData[candleData.length - 1]?.time);

      // Subscribe to hover crosshair moves
      chart.subscribeCrosshairMove(param => {
        if (!param.time || param.point === undefined) {
          updateLegend(candleData[candleData.length - 1]?.time);
        } else {
          updateLegend(param.time);
        }
      });

      const handleResize = () => { if (chartRef.current && chart) chart.applyOptions({ width: chartRef.current.clientWidth, height: chartRef.current.clientHeight }); };
      window.addEventListener("resize", handleResize);
      return () => {
         window.removeEventListener("resize", handleResize);
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
  }, [chartData, activeTimeframe, activeMainTab, activeIndicators, maLines, panelSplits, rsiPeriod, macdFast, macdSlow, macdSignal, activeBottomTab, chartStyle]);

  const selectSymbol = (sym) => {
    setSymbol(sym);
  };

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
      }

      // Create a temporary scanner
      const sc = await api.createScanner({
        name: "Temp Custom Query " + Date.now(),
        description: "Ad-hoc scan",
        conditions,
        is_public: false
      });
      // Run it
      const res = await api.runScanner(sc.id);
      setQueryMatches(res.matches || []);
      // Cleanup
      await api.deleteScanner(sc.id);
    } catch (e) {
      console.error(e);
      alert("Error running query: " + e.message);
    } finally {
      setQueryLoading(false);
    }
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

      const sc = await api.createScanner({
        name: "Temp MA Scan " + Date.now(),
        conditions: [condition],
        is_public: false
      });
      const res = await api.runScanner(sc.id);
      setMAMatches(res.matches || []);
      await api.deleteScanner(sc.id);
    } catch (e) {
      console.error(e);
      alert("Error running MA scan: " + e.message);
    } finally {
      setMALoading(false);
    }
  };

  const handleUpdateData = async () => {
    setDataFeedStatus("Connecting to Server...");
    if (!isIntradayMode) {
      try {
        setDataFeedStatus("Downloading EOD Bhavcopy from NSE...");
        await api.triggerSyncData();
        setDataFeedStatus("Update Complete");
        setTimeout(() => {
          setDataFeedStatus(null);
          loadChart(symbol);
        }, 1500);
      } catch (e) {
        console.error(e);
        setDataFeedStatus("Update Failed");
        setTimeout(() => setDataFeedStatus(null), 2000);
      }
    } else {
      setTimeout(() => {
        setDataFeedStatus("Downloading Intraday Ticks...");
        setTimeout(() => {
          setDataFeedStatus("Update Complete");
          setTimeout(() => {
            setDataFeedStatus(null);
            loadChart(symbol); // Force chart to re-fetch/update
          }, 1000);
        }, 1500);
      }, 1000);
    }
  };

  const toggleMode = () => {
    setIsIntradayMode(!isIntradayMode);
  };

  const lastBar = chartData.length > 0 ? chartData[chartData.length - 1] : null;

  return (
    <div className={styles.keystockApp}>


      {/* Main Menu Bar */}
      <div className={styles.menuBar}>
        <div className={styles.menuItem} onClick={toggleMode}>
          <span>{isIntradayMode ? "⏱️" : "🗄️"}</span> {isIntradayMode ? "INTRADAY" : "EOD"}
        </div>
        <div className={styles.menuItem} onClick={handleUpdateData}>
          <span>🔄</span> Update Data
        </div>
        <div 
          className={styles.menuItem} 
          style={{position: "relative"}} 
          onClick={(e) => {
            e.stopPropagation();
            setShowStyleMenu(!showStyleMenu);
          }}
        >
          <span>🕯️</span> Chart Type: {CHART_STYLES.find(s => s.id === chartStyle)?.label || "Candles"} ▾
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
        <div className={styles.menuItem} onClick={() => setShowCustomQuery(true)}><span>📊</span> Scan Chart Pattern</div>
        <div className={styles.menuItem} onClick={() => setShowAnalysisSearch(true)}><span>📉</span> Analysis Search</div>
        <div className={styles.menuItem} onClick={() => setShowMAAnalysis(true)}><span>📈</span> MA Analysis</div>
        <div className={styles.menuItem} onClick={() => setShowCustomQuery(true)}><span>🛠️</span> Custom Query</div>
        <div className={styles.menuItem} onClick={() => setShowAlerts(true)}><span>🔔</span> Alerts</div>
        <div className={styles.menuItem} onClick={() => setShowSettings(true)}>Settings</div>
        <div style={{display:"flex", alignItems:"center", gap:"4px", marginLeft: "16px"}}>
           <button
             title="Go to bar"
             style={{borderRadius: "50%", background:"#000", color:"#FFF", width:"20px", height:"20px", fontSize: "10px", cursor:"pointer"}}
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
             style={{width:"30px", background: "#00FFFF", border: "1px solid #A0A0A0", textAlign: "center"}}
           />
           <select style={{fontSize: "11px", border: "1px solid #A0A0A0", padding: "1px"}}><option>Normal</option></select>
           <button
             title="Fit all data"
             style={{borderRadius: "50%", background:"#000", color:"#FFF", width:"20px", height:"20px", fontSize: "10px", cursor:"pointer"}}
             onClick={() => {
               if (chartInstance.current) {
                 try { chartInstance.current.timeScale().fitContent(); } catch(e) {}
               }
             }}
           >✖</button>
           <input type="text" readOnly value={chartData.length} title="Total bars loaded" style={{width:"35px", background: "#00FFFF", border: "1px solid #A0A0A0", textAlign: "center"}}/>
        </div>
      </div>



      {/* Main Body */}
      <div className={styles.mainBody}>
        
        {/* Timeframe Column — D / W / M */}
        <div className={styles.extremeLeftCol}>
          {[
            { label: "D", full: "Daily" },
            { label: "W", full: "Weekly" },
            { label: "M", full: "Monthly" },
          ].map(tf => (
            <div
              key={tf.label}
              className={styles.timeBtn}
              style={{
                background: activeTimeframe === tf.label ? "#0000FF" : "",
                color: activeTimeframe === tf.label ? "#FFFFFF" : "#000000",
                fontWeight: activeTimeframe === tf.label ? "bold" : "normal",
                padding: "8px 4px",
                fontSize: "13px",
                textAlign: "center",
                cursor: "pointer",
                letterSpacing: "0px",
              }}
              onClick={() => setActiveTimeframe(tf.label)}
              title={tf.full}
            >
              {tf.label}
            </div>
          ))}
        </div>

        {/* Left Sidebar */}
        <div className={styles.leftSidebar}>
          <div className={styles.sidebarTabs}>
            <div className={`${styles.sTab} ${activeMainTab === 'Main' ? styles.sTabActive : ''}`} onClick={() => setActiveMainTab("Main")}>Main</div>
            <div className={`${styles.sTab} ${activeMainTab === 'Multiple Charts' ? styles.sTabActive : ''}`} onClick={() => setActiveMainTab("Multiple Charts")}>Multiple Charts</div>
          </div>
          <div className={styles.videoBtns}>
            <div className={styles.redBtn} onClick={() => setShowVideos('basic')}>Basic Videos</div>
            <div className={styles.redBtn} onClick={() => setShowVideos('help')}>Help Videos</div>
          </div>
          <div className={styles.listBox} style={{height: "120px", flex: "none"}}>
            {Object.keys(INDICES).map(grp => (
               <div key={grp} className={`${styles.listItem} ${activeSector === grp ? styles.listItemSelected : ''}`} onClick={() => setActiveSector(grp)}>
                 {grp}
               </div>
            ))}
          </div>
          <div className={styles.sidebarDivider}>
            <span title="Already controlled by extreme-left column" style={{color: "#999", padding:"2px 6px"}}>D</span>
            <span style={{color: "#999", padding:"2px 6px"}}>W</span>
            <span style={{color: "#999", padding:"2px 6px"}}>M</span>
          </div>
          <div className={styles.sidebarLabel} style={{cursor:"pointer"}} onClick={() => setShowWatchlistMgr('new')}>New Watchlist</div>
          <div className={styles.sidebarLabel} style={{cursor:"pointer"}} onClick={() => setShowWatchlistMgr('manage')}>Maintain Watchlists</div>
          <div className={styles.listBox} style={{flex: 1}}>
            {(INDICES[activeSector] || []).map(sym => (
               <div key={sym} className={`${styles.listItem} ${symbol === sym ? styles.listItemSelected : ''}`} onClick={() => selectSymbol(sym)}>
                 {sym}
               </div>
            ))}
          </div>
          <div className={styles.sidebarLabel}>Market Watch</div>
        </div>

        {/* Chart Area */}
        <div
          ref={chartWrapRef}
          className={styles.chartArea}
          style={{display: "flex", flexDirection: "column", backgroundColor: "#000", position: "relative"}}
        >
          {activeMainTab === "Main" ? (
            <>
              <div ref={legendRef} className={styles.chartInfoText}>
                {symbol} ({activeTimeframe === 'D' ? 'Daily' : activeTimeframe === 'W' ? 'Weekly' : 'Monthly'}) | Date: {lastBar?.time?.split("T")[0] || "2022-07-20"} | Open: {lastBar?.open || "--"} | High: {lastBar?.high || "--"} | Low: {lastBar?.low || "--"} | Close: {lastBar?.close || "--"} | Volume: {lastBar?.volume || "--"}
                {activeBottomTab === "Harmonic" && <span style={{color:"#FF00FF", fontWeight:"bold", marginLeft:"8px"}}>[ Bullish Bat Pattern Detected ]</span>}
                <br />
                <span style={{fontSize: "14px", fontWeight: "bold", color: "#000"}}>{lastBar?.close || "--"} ( 0.19% ) </span>
                <span style={{fontSize: "14px", color: "#000"}}>{symbol}</span>
              </div>

              {/* Lightweight chart */}
              <div ref={chartRef} style={{ flex: 1, width: "100%", outline: "none", minHeight: 0 }} />

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
                  background: "#E4CDA2", borderLeft: "1px solid #800000", borderBottom: "1px solid #800000",
                  cursor: "pointer", fontSize: "11px", color: "#800000", fontWeight: "bold"
                }} onClick={() => {
                  setShowSettings(true);
                }} title="Show indicator parameters settings">
                  ▼
                </div>
              </div>

              {/* Panel Divider Handles — draggable horizontal borders */}
              {(() => {
                const activeSubs = activeIndicators.filter(id => ['rsi', 'macd', 'stoch', 'atr', 'cci', 'williams', 'obv', 'mfi', 'adx'].includes(id));
                const subCount = activeSubs.length;
                const activeDividers = [
                  { split: panelSplits.v1, idx: 0, label: 'Candle ↕ Volume', color: '#606060' }
                ];
                if (subCount >= 1) {
                  const label2 = `Volume ↕ ${activeSubs[0].toUpperCase()}`;
                  activeDividers.push({ split: panelSplits.v2, idx: 1, label: label2, color: '#606060' });
                }
                if (subCount >= 2) {
                  const label3 = `${activeSubs[0].toUpperCase()} ↕ ${activeSubs[1].toUpperCase()}`;
                  activeDividers.push({ split: panelSplits.v3, idx: 2, label: label3, color: '#606060' });
                }
                return activeDividers;
              })().map(({ split, idx, label, color }) => (
                <div
                  key={idx}
                  title={label + ' — drag to resize'}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: `calc(${split * 100}% - 7px)`,
                    width: '100%',
                    height: '14px',           // tall grab zone
                    cursor: 'ns-resize',
                    zIndex: 30,
                    userSelect: 'none',
                  }}
                  onMouseDown={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    document.body.style.cursor = 'ns-resize';

                    const onMove = (ev) => {
                      const rect = chartWrapRef.current?.getBoundingClientRect();
                      if (!rect) return;
                      const frac = Math.max(0.05, Math.min(0.95, (ev.clientY - rect.top) / rect.height));
                      setPanelSplits(prev => {
                        const next = { ...prev };
                        if (idx === 0) next.v1 = Math.max(0.12, Math.min(next.v2 - 0.07, frac));
                        else if (idx === 1) next.v2 = Math.max(next.v1 + 0.07, Math.min(next.v3 - 0.07, frac));
                        else next.v3 = Math.max(next.v2 + 0.07, Math.min(0.94, frac));
                        return next;
                      });
                    };

                    const onUp = () => {
                      document.body.style.cursor = '';
                      window.removeEventListener('mousemove', onMove);
                      window.removeEventListener('mouseup', onUp);
                    };

                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  }}
                >
                  {/* Thin visible separator line in the middle of the hit zone */}
                  <div style={{
                    position: 'absolute', top: '6px', left: 0, width: '100%', height: '2px',
                    background: color, opacity: 0.6, pointerEvents: 'none',
                  }} />
                  {/* Centered grip pill */}
                  <div style={{
                    position: 'absolute', top: '3px', left: '50%', transform: 'translateX(-50%)',
                    width: '48px', height: '8px',
                    background: '#D4D0C8', border: '1px solid #808080', borderRadius: '3px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px',
                    pointerEvents: 'none',
                  }}>
                    {[0,1,2,3].map(i => (
                      <div key={i} style={{ width: '2px', height: '4px', background: '#808080', borderRadius: '1px' }} />
                    ))}
                  </div>
                </div>
              ))}

              {/* SVG Drawing Overlay */}
              <svg
                ref={overlayRef}
                style={{ position:"absolute", top:0, left:0, width:"100%", height:"55%", cursor: activeTool ? "crosshair" : "default", zIndex: 10, pointerEvents: "all", overflow: "hidden" }}
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
                    {d.type === 'hline' && <><line x1={0} y1={d.y1} x2="100%" y2={d.y1} stroke={d.color} strokeWidth={d.id===selectedId?2:1} strokeDasharray={d.id===selectedId?"4 2":""} />{d.label&&<text x={6} y={d.y1-4} fontSize={10} fill={d.color} fontWeight="bold" fontFamily="Tahoma">{d.label}</text>}</>}
                    {d.type === 'vline' && <><line x1={d.x1} y1={0} x2={d.x1} y2="100%" stroke={d.color} strokeWidth={d.id===selectedId?2:1} strokeDasharray={d.id===selectedId?"4 2":""} />{d.label&&<text x={d.x1+4} y={18} fontSize={9} fill={d.color} fontWeight="bold" fontFamily="Tahoma">{d.label}</text>}</>}
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
                <div data-toolmenu="1" onClick={e=>e.stopPropagation()} style={{ position:'absolute', left: Math.min(toolMenu.x, (overlayRef.current?.clientWidth||800)-280), top: Math.min(toolMenu.y, (overlayRef.current?.clientHeight||600)-420), zIndex:999, background:'#ECE9D8', border:'2px solid #848284', boxShadow:'4px 4px 0 #848284', width:'320px', fontFamily:'Tahoma,Arial,sans-serif' }}>
                  {/* Title bar */}
                  <div style={{background:'#000080',color:'#FFF',padding:'3px 8px',fontSize:'11px',fontWeight:'bold',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span>📊 Chart Analysis Panel</span>
                    <span style={{cursor:'pointer',fontWeight:'bold'}} onClick={()=>setToolMenu(null)}>✕</span>
                  </div>
                  {/* Tab bar */}
                  <div style={{display:'flex',borderBottom:'1px solid #848284',background:'#D4D0C8'}}>
                    {[{k:'tools',label:'🖊 Tools'},{k:'indicators',label:'📈 Indicators'},{k:'signals',label:'🔔 Signals'}].map(t=>(
                      <div key={t.k} onClick={()=>setMenuTab(t.k)} style={{padding:'3px 10px',fontSize:'11px',cursor:'pointer',borderRight:'1px solid #848284',background:menuTab===t.k?'#ECE9D8':'#C0C0C0',fontWeight:menuTab===t.k?'bold':'normal',color:'#000'}}>{t.label}</div>
                    ))}
                  </div>

                  {/* TOOLS TAB */}
                  {menuTab === 'tools' && (
                    <div style={{padding:'6px'}}>
                      <div style={{fontSize:'10px',color:'#555',marginBottom:'4px'}}>Double-click snaps to nearest candle OHLC. Click places tool.</div>
                      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'3px'}}>
                        {TOOLS.map(t => (
                          <div key={t.id}
                            style={{ padding:'5px 3px', fontSize:'10px', cursor:'pointer', border:'1px solid #848284', background: activeTool===t.id ? '#000080' : '#ECE9D8', color: activeTool===t.id ? '#FFF':'#000', display:'flex', flexDirection:'column', alignItems:'center', gap:'2px', userSelect:'none', textAlign:'center' }}
                            onClick={() => { setActiveTool(t.id); setDrawStep(0); setTempStart(null); setTempEnd(null); setToolMenu(null); }}
                          >
                            <span style={{fontSize:'18px',lineHeight:1}}>{t.icon}</span>
                            <span style={{fontSize:'9px'}}>{t.label}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{display:'flex',gap:'4px',marginTop:'6px'}}>
                        <button style={{flex:1,fontSize:'10px',padding:'3px',background:'#ECE9D8',border:'1px solid #848284'}} onClick={()=>{setDrawings([]);setToolMenu(null);setActiveTool(null);}}>🗑 Clear All</button>
                        <button style={{flex:1,fontSize:'10px',padding:'3px',background:'#ECE9D8',border:'1px solid #848284'}} onClick={()=>{setToolMenu(null);setActiveTool(null);}}>✕ Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* INDICATORS TAB */}
                  {menuTab === 'indicators' && (
                    <div style={{padding:'6px',maxHeight:'360px',overflowY:'auto'}}>
                      {INDICATOR_GROUPS.map(group => (
                        <div key={group.group} style={{marginBottom:'8px'}}>
                          <div style={{fontSize:'10px',fontWeight:'bold',color:'#000080',borderBottom:'1px solid #000080',marginBottom:'4px',paddingBottom:'2px'}}>{group.group}</div>
                          {group.items.map(ind => {
                            const isOn = activeIndicators.includes(ind.id);
                            return (
                              <div key={ind.id} style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'3px',cursor:'pointer',padding:'2px 4px',background:isOn?'#D0E8FF':'transparent',borderRadius:2}}
                                onClick={()=>{
                                  setActiveIndicators(prev => isOn ? prev.filter(x=>x!==ind.id) : [...prev, ind.id]);
                                }}>
                                <span style={{fontSize:'12px',userSelect:'none'}}>{isOn ? '☑' : '☐'}</span>
                                <span style={{display:'inline-block',width:10,height:10,background:ind.color,border:'1px solid #555',borderRadius:1,flexShrink:0}} />
                                <span style={{fontSize:'11px',color:'#000',userSelect:'none'}}>{ind.label}</span>
                                <span style={{marginLeft:'auto',fontSize:'9px',color:'#888'}}>{ind.panel==='main'?'↗ Chart':'↘ Sub'}</span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      <div style={{display:'flex',gap:'4px',marginTop:'4px'}}>
                        <button style={{flex:1,fontSize:'10px',padding:'3px',background:'#ECE9D8',border:'1px solid #848284'}} onClick={()=>setActiveIndicators([])}>Clear All</button>
                        <button style={{flex:1,fontSize:'10px',padding:'3px',background:'#ECE9D8',border:'1px solid #848284'}} onClick={()=>setToolMenu(null)}>Apply ✔</button>
                      </div>
                    </div>
                  )}

                  {/* SIGNALS TAB */}
                  {menuTab === 'signals' && (
                    <div style={{padding:'6px',maxHeight:'360px',overflowY:'auto'}}>
                      <div style={{fontSize:'10px',color:'#555',marginBottom:'6px'}}>Select a signal to auto-enable its required indicators and highlight events on chart.</div>
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
                          <div key={sig.id} style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'4px',cursor:'pointer',padding:'3px 6px',background:isActive?'#D0FFD8':'#F5F5F5',border:'1px solid #C0C0C0',borderRadius:2}}
                            onClick={()=>{
                              setActiveIndicators(prev => {
                                const next = new Set(prev);
                                required.forEach(r => next.add(r));
                                return Array.from(next);
                              });
                              setToolMenu(null);
                            }}>
                            <span style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:sig.color,flexShrink:0}} />
                            <span style={{fontSize:'11px',color:'#000',flex:1,userSelect:'none'}}>{sig.label}</span>
                            {isActive && <span style={{fontSize:'9px',color:'#007700',fontWeight:'bold'}}>ON</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Active tool status bar */}
              {activeTool && (
                <div style={{ position:'absolute', bottom:8, left:'50%', transform:'translateX(-50%)', background:'#000080', color:'#FFF', padding:'3px 14px', fontSize:'11px', borderRadius:2, zIndex:100, pointerEvents:'none', whiteSpace:'nowrap' }}>
                  {drawStep===0 ? `🎯 Click to place: ${TOOLS.find(t=>t.id===activeTool)?.label} (snaps to H/L/O/C)` : '📍 Click second point — snaps to nearest OHLC (Esc = cancel)'}
                </div>
              )}
            </>
          ) : (
            <div style={{width: "100%", height: "100%", display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: "2px"}}>
               <div style={{backgroundColor:"#FFF", border:"1px solid #333", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"#000", fontWeight:"bold"}}>{symbol} (Daily)</div></div>
               <div style={{backgroundColor:"#FFF", border:"1px solid #333", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"#000", fontWeight:"bold"}}>{symbol} (Weekly)</div></div>
               <div style={{backgroundColor:"#FFF", border:"1px solid #333", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"#000", fontWeight:"bold"}}>{symbol} (Monthly)</div></div>
               <div style={{backgroundColor:"#FFF", border:"1px solid #333", position:"relative"}}><div style={{position:"absolute", top:2, left:2, zIndex:10, fontSize:"11px", color:"#000", fontWeight:"bold"}}>{symbol} (15m)</div></div>
            </div>
          )}
        </div>

        {/* Right Sidebar (Drawing Tools) */}
        <div className={styles.rightSidebar}>
          <div 
            className={`${styles.drawIcon} ${activeTool === null ? styles.drawIconActive : ''}`} 
            title="Select" 
            onClick={() => { setActiveTool(null); }}
          >
            ↖
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'text' ? styles.drawIconActive : ''}`} 
            title="Text" 
            onClick={() => { setActiveTool('text'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            A
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'hline' ? styles.drawIconActive : ''}`} 
            title="Horizontal Line" 
            onClick={() => { setActiveTool('hline'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            —
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'vline' ? styles.drawIconActive : ''}`} 
            title="Vertical Line" 
            onClick={() => { setActiveTool('vline'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            |
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'trendline' ? styles.drawIconActive : ''}`} 
            title="Trendline" 
            onClick={() => { setActiveTool('trendline'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            /
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'ray' ? styles.drawIconActive : ''}`} 
            title="Extended Line" 
            onClick={() => { setActiveTool('ray'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            ⤡
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'channel' ? styles.drawIconActive : ''}`} 
            title="Parallel Channel" 
            onClick={() => { setActiveTool('channel'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            //
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'fibonacci' ? styles.drawIconActive : ''}`} 
            title="Fibonacci" 
            onClick={() => { setActiveTool('fibonacci'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            ≡
          </div>
          <div 
            className={`${styles.drawIcon} ${activeTool === 'pitchfork' ? styles.drawIconActive : ''}`} 
            title="Pitchfork" 
            onClick={() => { setActiveTool('pitchfork'); setDrawStep(0); setTempStart(null); setTempEnd(null); }}
          >
            ⋔
          </div>
          <div className={styles.drawIcon} title="Clear" onClick={() => { setDrawings([]); setActiveTool(null); }}>🗑️</div>
        </div>
      </div>

      {/* Editable Moving Average Bar */}
      <div className={styles.maBar}>
        <div className={styles.maBarLabel}>MA Lines:</div>
        <div className={styles.maBarRows}>
          {maLines.map(ma => (
            <div key={ma.id} className={styles.maBarRow}>
              {/* Visibility toggle */}
              <button
                className={`${styles.maVisBtn} ${ma.visible ? styles.maVisBtnOn : styles.maVisBtnOff}`}
                title={ma.visible ? 'Hide MA' : 'Show MA'}
                onClick={() => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, visible: !m.visible } : m))}
              >{ma.visible ? '●' : '○'}</button>

              {/* Color swatch (opens color picker) */}
              <label className={styles.maColorLabel} title="Change color" style={{ background: ma.color }}>
                <input
                  type="color"
                  value={ma.color}
                  onChange={e => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, color: e.target.value } : m))}
                  style={{ opacity: 0, position: 'absolute', width: 0, height: 0 }}
                />
              </label>

              {/* MA Type selector */}
              <select
                className={styles.maTypeSelect}
                value={ma.type}
                onChange={e => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, type: e.target.value } : m))}
              >
                <option>SMA</option>
                <option>EMA</option>
                <option>WMA</option>
                <option>DEMA</option>
                <option>TEMA</option>
                <option>HMA</option>
                <option>VWAP</option>
                <option>BB</option>
              </select>

              {/* Period input (hidden for VWAP) */}
              {ma.type !== 'VWAP' && (
                <input
                  type="number"
                  className={styles.maPeriodInput}
                  value={ma.period}
                  min={2}
                  max={500}
                  onChange={e => setMALines(prev => prev.map(m => m.id === ma.id ? { ...m, period: e.target.value } : m))}
                />
              )}

              {/* MA label */}
              <span className={styles.maLineLabel} style={{ color: ma.color }}>
                {ma.type}{ma.type !== 'VWAP' ? `(${ma.period})` : ''}
              </span>

              {/* Delete */}
              <button
                className={styles.maDeleteBtn}
                title="Remove this MA"
                onClick={() => setMALines(prev => prev.filter(m => m.id !== ma.id))}
              >✕</button>
            </div>
          ))}
        </div>

        {/* Add MA button */}
        <button
          className={styles.maAddBtn}
          title="Add a new MA line"
          onClick={() => {
            const newId = ++maLineIdRef.current;
            const colors = ['#009900','#CC00CC','#CC6600','#006699','#990000','#339933'];
            setMALines(prev => [
              ...prev,
              { id: newId, type: 'SMA', period: 50, color: colors[prev.length % colors.length], visible: true }
            ]);
          }}
        >+ Add MA</button>

        {/* Right-side nav buttons */}
        <div className={styles.maBarRight}>
          <button
            title="Scroll chart backward (older data)"
            className={styles.maNavBtn}
            onClick={() => { if (chartInstance.current) { try { chartInstance.current.timeScale().scrollToPosition((chartInstance.current.timeScale().scrollPosition() || 0) - 50, false); } catch(e) {} } }}
          >&lt;&lt;&lt;&lt;</button>
          <button
            title="Scroll chart forward (recent data)"
            className={styles.maNavBtn}
            onClick={() => { if (chartInstance.current) { try { chartInstance.current.timeScale().scrollToPosition((chartInstance.current.timeScale().scrollPosition() || 0) + 50, false); } catch(e) {} } }}
          >&gt;&gt;&gt;&gt;</button>
          <button className={styles.maRiskBtn} onClick={() => setShowRiskCalc(true)}>Risk Calculator</button>
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
                    <option value="sma_cross">Moving Average Crossover Scan</option>
                    <option value="price_ma_cross">Price and MA Crossover</option>
                    <option value="ma_slope">MA Slope Scanner</option>
                    <option value="rsi_oversold">Scan RSI Indicator</option>
                    <option value="macd_divergence">RSI and MACD Divergence</option>
                    <option value="volume_spike">Volume Scanner</option>
                    <option value="price_vol_gainers">Price Volume Gainers</option>
                    <option value="double_bottom">Scan Double Bottom</option>
                    <option value="candle_pattern">Scan Candle Sticks Pattern</option>
                    <option value="lifetime_high">Life Time High Scan</option>
                    <option value="breakout">Breakout Analysis</option>
                    <option value="pullback">Scan Pull back in Stocks</option>
                    <option value="combine_scans">Combine 2 Different Scans</option>
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
                    {queryMatches.map(m => (
                      <tr key={m.symbol} onClick={() => { selectSymbol(m.symbol); setShowCustomQuery(false); }} style={{cursor: "pointer"}}>
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
              <div style={{display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px"}}>
                <button className={styles.winBtn} onClick={() => setQueryMatches([])}>Clear Results</button>
                <button className={styles.winBtn} onClick={() => setShowCustomQuery(false)}>Close</button>
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
                  <select className={styles.winSelect} value={activeTimeframe} onChange={e => setActiveTimeframe(e.target.value)}>
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
                  <input type="number" className={styles.winInput} value={rsiPeriod} onChange={e => setRsiPeriod(parseInt(e.target.value) || 14)} style={{width:"50px"}} />
                </div>
                <div className={styles.winRow} style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"4px"}}>
                  <span className={styles.riskCalcLabel}>MACD Fast:</span>
                  <input type="number" className={styles.winInput} value={macdFast} onChange={e => setMacdFast(parseInt(e.target.value) || 12)} style={{width:"50px"}} />
                </div>
                <div className={styles.winRow} style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"4px"}}>
                  <span className={styles.riskCalcLabel}>MACD Slow:</span>
                  <input type="number" className={styles.winInput} value={macdSlow} onChange={e => setMacdSlow(parseInt(e.target.value) || 26)} style={{width:"50px"}} />
                </div>
                <div className={styles.winRow} style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <span className={styles.riskCalcLabel}>MACD Signal:</span>
                  <input type="number" className={styles.winInput} value={macdSignal} onChange={e => setMacdSignal(parseInt(e.target.value) || 9)} style={{width:"50px"}} />
                </div>
              </div>
              <div className={styles.winGroupBox} style={{marginTop:"8px"}}>
                <span className={styles.winGroupBoxLegend}>Default Indicators</span>
                <div style={{display:"flex", flexWrap:"wrap", gap:"6px", padding:"4px 0"}}>
                  {INDICATOR_GROUPS.flatMap(g => g.items).map(ind => (
                    <label key={ind.id} style={{display:"flex", alignItems:"center", gap:"3px", fontSize:"11px", cursor:"pointer"}}>
                      <input type="checkbox"
                        checked={activeIndicators.includes(ind.id)}
                        onChange={e => {
                          if (e.target.checked) setActiveIndicators(prev => [...prev, ind.id]);
                          else setActiveIndicators(prev => prev.filter(x => x !== ind.id));
                        }}
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
    </div>
  );
}
