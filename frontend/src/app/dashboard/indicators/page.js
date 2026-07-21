"use client";

import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";
import { drawMiniChart } from "@/lib/miniChart";
import styles from "./indicators.module.css";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

function IndResultCard({ match, indicator, isBullish, timeframe }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !match.chart_data || match.chart_data.length < 2) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext("2d").scale(dpr, dpr);
    drawMiniChart(canvas, match.chart_data.slice(-40), {
      upColor: "#26a69a", downColor: "#ef5350", bgColor: "#FFFFFF",
      gridColor: "#EEEEEE", borderColor: "#C0C0C0",
      showVolume: true, showMA: true, maPeriod: 20,
      maColor: isBullish ? "#FF6600" : "#AA00AA",
    });
  }, [match.chart_data, isBullish]);
  const isUp = (match.change_pct ?? 0) >= 0;
  return (
    <div className="scan-result-card">
      <div className="src-chart-wrap">
        <canvas ref={canvasRef} className="src-canvas" style={{ width: "100%", height: "100%", display: "block" }} />
        {(!match.chart_data || match.chart_data.length === 0) && <div className="src-no-chart">No Chart</div>}
      </div>
      <div className="src-info">
        <div className="src-top-row">
          <a href={`/dashboard/charts?symbol=${match.symbol}&tf=${timeframe}`} className="src-symbol">{match.symbol}</a>
          <span className="src-badge" style={{ color: isBullish ? "#008000" : "#CC0000" }}>{isBullish ? "▲ Bull" : "▼ Bear"}</span>
        </div>
        {match.name && <div className="src-name">{match.name}</div>}
        {match.sector && <div className="src-sector" style={{ fontSize: "11px", color: "#888", marginTop: "2px", fontWeight: 500 }}>{match.sector}</div>}
        <div className="src-prices">
          {match.close != null && <span className="src-close">₹{match.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>}
          {match.change_pct != null && <span className={`src-change ${isUp ? "src-up" : "src-down"}`}>{isUp ? "▲" : "▼"} {Math.abs(match.change_pct).toFixed(2)}%</span>}
        </div>
        {indicator && <div className="src-signal">{indicator}</div>}
        <div className="src-footer">
          {match.volume != null && <span className="src-vol">{match.volume >= 1e6 ? (match.volume / 1e6).toFixed(1) + "M" : (match.volume / 1e3).toFixed(0) + "K"}</span>}
          <a href={`/dashboard/charts?symbol=${match.symbol}&tf=${timeframe}`} className="src-chart-link">Chart →</a>
        </div>
      </div>
    </div>
  );
}

const INDICATOR_TABS = [
  { id: "supertrend", label: "SuperTrend", icon: "🔥" },
  { id: "ichimoku", label: "Ichimoku", icon: "☁️" },
  { id: "rsi_macd", label: "RSI / MACD", icon: "📉" },
  { id: "sar", label: "SAR / ATS", icon: "⚡" },
  { id: "bbands", label: "BB Squeeze", icon: "🎯" },
  { id: "zigzag", label: "ZigZag / Gann", icon: "⚡" },
  { id: "fibonacci", label: "Fib Bands", icon: "🌀" },
  { id: "ma_oscillator", label: "MA Oscillator", icon: "〜" },
  { id: "ma_band", label: "MA Band", icon: "📏" },
  { id: "trend_candle", label: "Trend Candle", icon: "🕯️" },
];

const TIMEFRAMES = [
  { value: "D", label: "Daily" },
  { value: "W", label: "Weekly" },
  { value: "M", label: "Monthly" },
];

// Standard textbook starting parameters per indicator — applied via the
// "✨ Recommended" button on each configuration panel.
const RECOMMENDED_PARAMS = {
  supertrend:    { atr_period: 10, multiplier: 3, signal: "buy" },
  ichimoku:      { signal: "tk_cross_bullish" },
  rsi_macd:      { rsi_period: 14, rsi_level: 30, rsi_signal: "below_level", macd_fast: 12, macd_slow: 26, macd_signal: 9, macd_signal_type: "bullish_cross" },
  sar:           { period: 14, signal: "flip_bullish" },
  bbands:        { period: 20, std_dev: 2, signal: "squeeze_both" },
  zigzag:        { period: 5, signal: "hh_hl" },
  fibonacci:     { signal: "slope_up" },
  ma_oscillator: { signal: "cross_above_zero" },
  ma_band:       { signal: "breakout_up" },
  trend_candle:  { signal: "flip_bullish" },
};

function SuperTrendPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        SuperTrend plots a trailing stop line — Buy when price closes above, Sell when below. 
        Also scan when price touches the SuperTrend line as a support/resistance test.
      </div>
      <div className={styles.paramGrid}>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>ATR Period</label>
          <input type="number" className={styles.numInput} value={params.atr_period || 10}
            onChange={(e) => setParams({ ...params, atr_period: Number(e.target.value) })} min={1} max={100} />
        </div>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>ATR Multiplier</label>
          <input type="number" className={styles.numInput} value={params.multiplier || 3} step={0.1}
            onChange={(e) => setParams({ ...params, multiplier: Number(e.target.value) })} min={0.5} max={10} />
        </div>
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="st_signal" value="buy" checked={params.signal === "buy"}
            onChange={() => setParams({ ...params, signal: "buy" })} />
          🟢 Buy Signal (Price crosses above SuperTrend)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="st_signal" value="sell" checked={params.signal === "sell"}
            onChange={() => setParams({ ...params, signal: "sell" })} />
          🔴 Sell Signal (Price crosses below SuperTrend)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="st_signal" value="touch" checked={params.signal === "touch"}
            onChange={() => setParams({ ...params, signal: "touch" })} />
          🔵 Price Touching SuperTrend Line
        </label>
      </div>
    </div>
  );
}

function IchimokuPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        Ichimoku Kinko Hyo — scan cloud position, Tenken-Kijun cross, price relative to cloud.
        Most powerful when all signals align in one direction.
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="ich_signal" value="above_cloud" checked={params.signal === "above_cloud"}
            onChange={() => setParams({ ...params, signal: "above_cloud" })} />
          ☁️ Price Above Cloud (Bullish)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="ich_signal" value="below_cloud" checked={params.signal === "below_cloud"}
            onChange={() => setParams({ ...params, signal: "below_cloud" })} />
          ⛅ Price Below Cloud (Bearish)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="ich_signal" value="tk_cross_bullish" checked={params.signal === "tk_cross_bullish"}
            onChange={() => setParams({ ...params, signal: "tk_cross_bullish" })} />
          🟢 Tenken crosses above Kijun (Bullish TK Cross)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="ich_signal" value="tk_cross_bearish" checked={params.signal === "tk_cross_bearish"}
            onChange={() => setParams({ ...params, signal: "tk_cross_bearish" })} />
          🔴 Tenken crosses below Kijun (Bearish TK Cross)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="ich_signal" value="cloud_twist" checked={params.signal === "cloud_twist"}
            onChange={() => setParams({ ...params, signal: "cloud_twist" })} />
          🔄 Cloud Twist (Senkou A crosses Senkou B)
        </label>
      </div>
    </div>
  );
}

function RsiMacdPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        Scan RSI / MACD for divergences, breakouts, or value crosses. 
        Mix both indicators together for confluence signals.
      </div>
      <div className={styles.twoCol}>
        <div className={styles.subSection}>
          <div className={styles.subSectionTitle}>RSI Settings</div>
          <div className={styles.paramGrid}>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>RSI Period</label>
              <input type="number" className={styles.numInput} value={params.rsi_period || 14}
                onChange={(e) => setParams({ ...params, rsi_period: Number(e.target.value) })} min={2} max={100} />
            </div>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>RSI Level</label>
              <input type="number" className={styles.numInput} value={params.rsi_level || 50}
                onChange={(e) => setParams({ ...params, rsi_level: Number(e.target.value) })} min={1} max={99} />
            </div>
          </div>
          <div className={styles.signalRow}>
            <label className={styles.radioLabel}>
              <input type="radio" name="rsi_signal" value="above_level" checked={params.rsi_signal === "above_level"}
                onChange={() => setParams({ ...params, rsi_signal: "above_level" })} />
              RSI above {params.rsi_level || 50} (Bullish)
            </label>
            <label className={styles.radioLabel}>
              <input type="radio" name="rsi_signal" value="below_level" checked={params.rsi_signal === "below_level"}
                onChange={() => setParams({ ...params, rsi_signal: "below_level" })} />
              RSI below {params.rsi_level || 50} (Bearish)
            </label>
            <label className={styles.radioLabel}>
              <input type="radio" name="rsi_signal" value="divergence_pos" checked={params.rsi_signal === "divergence_pos"}
                onChange={() => setParams({ ...params, rsi_signal: "divergence_pos" })} />
              Positive Divergence (Price ↓, RSI ↑)
            </label>
            <label className={styles.radioLabel}>
              <input type="radio" name="rsi_signal" value="divergence_neg" checked={params.rsi_signal === "divergence_neg"}
                onChange={() => setParams({ ...params, rsi_signal: "divergence_neg" })} />
              Negative Divergence (Price ↑, RSI ↓)
            </label>
            <label className={styles.radioLabel}>
              <input type="radio" name="rsi_signal" value="breakout" checked={params.rsi_signal === "breakout"}
                onChange={() => setParams({ ...params, rsi_signal: "breakout" })} />
              RSI N-Day Breakout
            </label>
          </div>
        </div>
        <div className={styles.subSection}>
          <div className={styles.subSectionTitle}>MACD Settings</div>
          <div className={styles.paramGrid}>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>Fast</label>
              <input type="number" className={styles.numInput} value={params.macd_fast || 12}
                onChange={(e) => setParams({ ...params, macd_fast: Number(e.target.value) })} min={2} max={100} />
            </div>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>Slow</label>
              <input type="number" className={styles.numInput} value={params.macd_slow || 26}
                onChange={(e) => setParams({ ...params, macd_slow: Number(e.target.value) })} min={2} max={200} />
            </div>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>Signal</label>
              <input type="number" className={styles.numInput} value={params.macd_signal || 9}
                onChange={(e) => setParams({ ...params, macd_signal: Number(e.target.value) })} min={2} max={100} />
            </div>
          </div>
          <div className={styles.signalRow}>
            <label className={styles.radioLabel}>
              <input type="radio" name="macd_signal" value="bullish_cross" checked={params.macd_signal_type === "bullish_cross"}
                onChange={() => setParams({ ...params, macd_signal_type: "bullish_cross" })} />
              MACD Bullish Cross (MACD above Signal)
            </label>
            <label className={styles.radioLabel}>
              <input type="radio" name="macd_signal" value="bearish_cross" checked={params.macd_signal_type === "bearish_cross"}
                onChange={() => setParams({ ...params, macd_signal_type: "bearish_cross" })} />
              MACD Bearish Cross (MACD below Signal)
            </label>
            <label className={styles.radioLabel}>
              <input type="radio" name="macd_signal" value="histogram_pos" checked={params.macd_signal_type === "histogram_pos"}
                onChange={() => setParams({ ...params, macd_signal_type: "histogram_pos" })} />
              Histogram Positive (Above Zero)
            </label>
            <label className={styles.radioLabel}>
              <input type="radio" name="macd_signal" value="divergence" checked={params.macd_signal_type === "divergence"}
                onChange={() => setParams({ ...params, macd_signal_type: "divergence" })} />
              MACD Divergence
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

function SarPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        ATS/SAR, Parabolic SAR, HL SAR and SAR Special — always-in-trade indicators 
        based on support/resistance trailing lines.
      </div>
      <div className={styles.paramGrid}>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>SAR Type</label>
          <select className={styles.select} value={params.sar_type || "parabolic"}
            onChange={(e) => setParams({ ...params, sar_type: e.target.value })}>
            <option value="parabolic">Parabolic SAR (PSAR)</option>
            <option value="ats">ATS / SAR</option>
            <option value="hl_sar">HL SAR (High-Low Based)</option>
            <option value="sar_special">SAR Special (ATS+Phase+KeyTrend)</option>
          </select>
        </div>
        {params.sar_type === "hl_sar" && (
          <div className={styles.paramItem}>
            <label className={styles.paramLabel}>Period</label>
            <input type="number" className={styles.numInput} value={params.period || 21}
              onChange={(e) => setParams({ ...params, period: Number(e.target.value) })} min={5} max={200} />
          </div>
        )}
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="sar_signal" value="bullish" checked={params.signal === "bullish"}
            onChange={() => setParams({ ...params, signal: "bullish" })} />
          🟢 Bullish Signal (Price above SAR line)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="sar_signal" value="bearish" checked={params.signal === "bearish"}
            onChange={() => setParams({ ...params, signal: "bearish" })} />
          🔴 Bearish Signal (Price below SAR line)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="sar_signal" value="flip_bullish" checked={params.signal === "flip_bullish"}
            onChange={() => setParams({ ...params, signal: "flip_bullish" })} />
          🔄 Fresh Flip to Bullish (just turned)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="sar_signal" value="flip_bearish" checked={params.signal === "flip_bearish"}
            onChange={() => setParams({ ...params, signal: "flip_bearish" })} />
          🔄 Fresh Flip to Bearish (just turned)
        </label>
      </div>
    </div>
  );
}

function BBandsPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        Bollinger Band Squeeze — identifies periods of low volatility before explosive moves.
        3 squeeze types: Keltner inside BB, Width at 200-day low, both conditions together.
      </div>
      <div className={styles.paramGrid}>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>BB Period</label>
          <input type="number" className={styles.numInput} value={params.period || 20}
            onChange={(e) => setParams({ ...params, period: Number(e.target.value) })} min={5} max={100} />
        </div>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>BB Std Dev</label>
          <input type="number" className={styles.numInput} value={params.std_dev || 2} step={0.1}
            onChange={(e) => setParams({ ...params, std_dev: Number(e.target.value) })} min={0.5} max={5} />
        </div>
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="bb_signal" value="squeeze_keltner" checked={params.signal === "squeeze_keltner"}
            onChange={() => setParams({ ...params, signal: "squeeze_keltner" })} />
          🟣 Keltner inside BB Band (Magenta Squeeze)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="bb_signal" value="squeeze_200" checked={params.signal === "squeeze_200"}
            onChange={() => setParams({ ...params, signal: "squeeze_200" })} />
          🟠 BB Width at 200-day low (Historical Squeeze)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="bb_signal" value="squeeze_both" checked={params.signal === "squeeze_both"}
            onChange={() => setParams({ ...params, signal: "squeeze_both" })} />
          🔴 Both Squeeze Conditions (Extreme Squeeze)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="bb_signal" value="breakout_up" checked={params.signal === "breakout_up"}
            onChange={() => setParams({ ...params, signal: "breakout_up" })} />
          🟢 Price Breakout Above Upper Band
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="bb_signal" value="breakout_down" checked={params.signal === "breakout_down"}
            onChange={() => setParams({ ...params, signal: "breakout_down" })} />
          🔴 Price Breakout Below Lower Band
        </label>
      </div>
    </div>
  );
}

function ZigzagPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        ZigZag connects swing highs and lows. Gann Swing uses Gann theory to identify trend direction.
        Useful for Elliott Wave traders and price action analysis.
      </div>
      <div className={styles.paramGrid}>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>Type</label>
          <select className={styles.select} value={params.zz_type || "zigzag"}
            onChange={(e) => setParams({ ...params, zz_type: e.target.value })}>
            <option value="zigzag">ZigZag Indicator</option>
            <option value="gann">Gann Swing</option>
            <option value="pivot_levels">Pivot Levels (HH/HL)</option>
          </select>
        </div>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>Swing Size (bars)</label>
          <input type="number" className={styles.numInput} value={params.period || 5}
            onChange={(e) => setParams({ ...params, period: Number(e.target.value) })} min={2} max={50} />
        </div>
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="zz_signal" value="hh_hl" checked={params.signal === "hh_hl"}
            onChange={() => setParams({ ...params, signal: "hh_hl" })} />
          🟢 Higher High + Higher Low (Uptrend per Dow Theory)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="zz_signal" value="ll_lh" checked={params.signal === "ll_lh"}
            onChange={() => setParams({ ...params, signal: "ll_lh" })} />
          🔴 Lower Low + Lower High (Downtrend per Dow Theory)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="zz_signal" value="first_hh" checked={params.signal === "first_hh"}
            onChange={() => setParams({ ...params, signal: "first_hh" })} />
          🔄 First Higher High (Potential trend reversal)
        </label>
      </div>
    </div>
  );
}

function FibBandsPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        Fibonacci Bands plot 6 dynamic levels based on price action. 
        When price enters the upper band = Bullish; Lower band = Bearish.
        Slope direction provides additional trend confirmation.
      </div>
      <div className={styles.paramGrid}>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>Period</label>
          <input type="number" className={styles.numInput} value={params.period || 20}
            onChange={(e) => setParams({ ...params, period: Number(e.target.value) })} min={5} max={200} />
        </div>
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="fib_signal" value="in_upper_band" checked={params.signal === "in_upper_band"}
            onChange={() => setParams({ ...params, signal: "in_upper_band" })} />
          🟢 Price in Upper Band (Bullish)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="fib_signal" value="in_lower_band" checked={params.signal === "in_lower_band"}
            onChange={() => setParams({ ...params, signal: "in_lower_band" })} />
          🔴 Price in Lower Band (Bearish)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="fib_signal" value="slope_up" checked={params.signal === "slope_up"}
            onChange={() => setParams({ ...params, signal: "slope_up" })} />
          ↗ Bands Sloping Upward (Uptrend confirmation)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="fib_signal" value="slope_down" checked={params.signal === "slope_down"}
            onChange={() => setParams({ ...params, signal: "slope_down" })} />
          ↘ Bands Sloping Downward (Downtrend confirmation)
        </label>
      </div>
    </div>
  );
}

function MaOscillatorPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        MA Oscillator plots the % difference between a fast and slow moving average,
        oscillating around zero. Zero-line crosses signal a shift in short-term momentum.
      </div>
      <div className={styles.paramGrid}>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>MA Type</label>
          <select className={styles.select} value={params.ma_type || "EMA"}
            onChange={(e) => setParams({ ...params, ma_type: e.target.value })}>
            <option value="EMA">EMA</option>
            <option value="SMA">SMA</option>
          </select>
        </div>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>Fast Period</label>
          <input type="number" className={styles.numInput} value={params.fast || 10}
            onChange={(e) => setParams({ ...params, fast: Number(e.target.value) })} min={1} max={200} />
        </div>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>Slow Period</label>
          <input type="number" className={styles.numInput} value={params.slow || 20}
            onChange={(e) => setParams({ ...params, slow: Number(e.target.value) })} min={2} max={500} />
        </div>
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="mao_signal" value="above_zero" checked={params.signal === "above_zero"}
            onChange={() => setParams({ ...params, signal: "above_zero" })} />
          🟢 Oscillator Above Zero (Bullish)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="mao_signal" value="below_zero" checked={params.signal === "below_zero"}
            onChange={() => setParams({ ...params, signal: "below_zero" })} />
          🔴 Oscillator Below Zero (Bearish)
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="mao_signal" value="cross_above_zero" checked={params.signal === "cross_above_zero"}
            onChange={() => setParams({ ...params, signal: "cross_above_zero" })} />
          🔄 Fresh Cross Above Zero
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="mao_signal" value="cross_below_zero" checked={params.signal === "cross_below_zero"}
            onChange={() => setParams({ ...params, signal: "cross_below_zero" })} />
          🔄 Fresh Cross Below Zero
        </label>
      </div>
    </div>
  );
}

function MaBandPanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        MA Band (envelope) plots a fixed % band above and below a moving average.
        Scan for breakouts beyond the band, touches, or price contained inside it.
      </div>
      <div className={styles.paramGrid}>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>MA Type</label>
          <select className={styles.select} value={params.ma_type || "SMA"}
            onChange={(e) => setParams({ ...params, ma_type: e.target.value })}>
            <option value="SMA">SMA</option>
            <option value="EMA">EMA</option>
          </select>
        </div>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>Period</label>
          <input type="number" className={styles.numInput} value={params.period || 20}
            onChange={(e) => setParams({ ...params, period: Number(e.target.value) })} min={2} max={500} />
        </div>
        <div className={styles.paramItem}>
          <label className={styles.paramLabel}>Band %</label>
          <input type="number" className={styles.numInput} value={params.band_pct || 2.5} step={0.1}
            onChange={(e) => setParams({ ...params, band_pct: Number(e.target.value) })} min={0.1} max={20} />
        </div>
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="mab_signal" value="breakout_up" checked={params.signal === "breakout_up"}
            onChange={() => setParams({ ...params, signal: "breakout_up" })} />
          🟢 Breakout Above Upper Band
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="mab_signal" value="breakout_down" checked={params.signal === "breakout_down"}
            onChange={() => setParams({ ...params, signal: "breakout_down" })} />
          🔴 Breakdown Below Lower Band
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="mab_signal" value="touch_upper" checked={params.signal === "touch_upper"}
            onChange={() => setParams({ ...params, signal: "touch_upper" })} />
          🔵 Touching Upper Band
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="mab_signal" value="touch_lower" checked={params.signal === "touch_lower"}
            onChange={() => setParams({ ...params, signal: "touch_lower" })} />
          🔵 Touching Lower Band
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="mab_signal" value="inside_band" checked={params.signal === "inside_band"}
            onChange={() => setParams({ ...params, signal: "inside_band" })} />
          ⚪ Contained Inside Band (Low Volatility)
        </label>
      </div>
    </div>
  );
}

function TrendCandlePanel({ params, setParams }) {
  return (
    <div className={styles.indicatorForm}>
      <div className={styles.formDesc}>
        Trend Candle uses Heikin-Ashi smoothed candles to classify the current bar as
        bullish or bearish, and flags the bar where the trend just flipped.
      </div>
      <div className={styles.signalRow}>
        <label className={styles.radioLabel}>
          <input type="radio" name="tc_signal" value="bullish" checked={params.signal === "bullish"}
            onChange={() => setParams({ ...params, signal: "bullish" })} />
          🟢 Bullish Trend Candle
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="tc_signal" value="bearish" checked={params.signal === "bearish"}
            onChange={() => setParams({ ...params, signal: "bearish" })} />
          🔴 Bearish Trend Candle
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="tc_signal" value="flip_bullish" checked={params.signal === "flip_bullish"}
            onChange={() => setParams({ ...params, signal: "flip_bullish" })} />
          🔄 Fresh Flip to Bullish
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="tc_signal" value="flip_bearish" checked={params.signal === "flip_bearish"}
            onChange={() => setParams({ ...params, signal: "flip_bearish" })} />
          🔄 Fresh Flip to Bearish
        </label>
      </div>
    </div>
  );
}

const PANEL_COMPONENTS = {
  supertrend: SuperTrendPanel,
  ichimoku: IchimokuPanel,
  rsi_macd: RsiMacdPanel,
  sar: SarPanel,
  bbands: BBandsPanel,
  zigzag: ZigzagPanel,
  fibonacci: FibBandsPanel,
  ma_oscillator: MaOscillatorPanel,
  ma_band: MaBandPanel,
  trend_candle: TrendCandlePanel,
};

export default function IndicatorScannerPage() {
  const [activeTab, setActiveTab] = useState("supertrend");
  const [timeframe, setTimeframe] = useState("D");
  const [subscription, setSubscription] = useState(null);
  const [premiumUpgradeMessage, setPremiumUpgradeMessage] = useState(null);
  const [params, setParams] = useState({ signal: "buy", rsi_signal: "above_level", rsi_level: 50, macd_signal_type: "bullish_cross" });
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("chart");
  const [chartCache, setChartCache] = useState({});
  const [sectors, setSectors] = useState([]);
  const [selectedSector, setSelectedSector] = useState("all");
  const [indices, setIndices] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState("all");

  useEffect(() => {
    api.listSectors().then(data => setSectors(data || [])).catch(() => {});
    api.listIndices().then(data => setIndices(data || [])).catch(() => {});
    api.getSubscription().then(data => setSubscription(data)).catch(() => {});
  }, []);

  const handleTimeframeChange = (val) => {
    const tier = subscription?.tier?.toLowerCase() || "free";
    if (["free", "eod_basic"].includes(tier) && ["W", "M"].includes(val)) {
      setPremiumUpgradeMessage("Weekly and Monthly scans are only available on the EOD Pro plan. Please upgrade your plan.");
      return;
    }
    setTimeframe(val);
  };

  async function handleScan() {
    setRunning(true); setError(null); setResults(null); setChartCache({});
    try {
      const payload = { indicator: activeTab, timeframe, sector: selectedSector, index: selectedIndex, ...params };
      const data = await api.runIndicatorScanner(payload);
      setResults(data);
      const cache = {};
      await Promise.allSettled(
        (data.matches?.slice(0, 50) || []).map(async (m) => {
          try {
            const eod = await api.getEod(m.symbol);
            cache[m.symbol] = eod.map((d) => ({ open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
          } catch (_) { cache[m.symbol] = []; }
        })
      );
      setChartCache(cache);
    } catch (err) {
      if (err.status === 403) {
        setPremiumUpgradeMessage(err.message);
      } else {
        setError(err.message || "Scan failed. Please ensure backend is running.");
      }
    } finally {
      setRunning(false);
    }
  }

  const PanelComponent = PANEL_COMPONENTS[activeTab];
  const activeTabInfo = INDICATOR_TABS.find(t => t.id === activeTab);
  const isBullish = params.signal !== "sell" && params.signal !== "bearish"
    && params.macd_signal_type !== "bearish_cross" && params.rsi_signal !== "divergence_neg";

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>📉 Indicator Scanner</h1>
          <p className={styles.subtitle}>
            SuperTrend · Ichimoku · RSI/MACD · SAR · BB Squeeze · ZigZag · Fibonacci Bands
          </p>
        </div>
      </div>

      <div className={styles.tabBar}>
        {INDICATOR_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ""}`}
            onClick={() => { setActiveTab(tab.id); setResults(null); setError(null); }}
            id={`ind-tab-${tab.id}`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className={styles.layout}>
        <div className={styles.settingsPanel}>
          {/* Timeframe */}
          <div className={styles.tfSection}>
            <div className={styles.sectionTitle}>Timeframe</div>
            <div className={styles.tfRow}>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.value}
                  className={`${styles.tfBtn} ${timeframe === tf.value ? styles.tfBtnActive : ""}`}
                  onClick={() => handleTimeframeChange(tf.value)}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          {/* Sector Filter */}
          <div className={styles.tfSection}>
            <div className={styles.sectionTitle}>Sector Filter</div>
            <select
              className={styles.select}
              value={selectedSector}
              onChange={(e) => setSelectedSector(e.target.value)}
              style={{ width: "100%", marginTop: "8px" }}
              id="sector-filter-select"
            >
              <option value="all">All Sectors</option>
              {sectors.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {/* Index Filter */}
          <div className={styles.tfSection}>
            <div className={styles.sectionTitle}>Index Filter</div>
            <select
              className={styles.select}
              value={selectedIndex}
              onChange={(e) => setSelectedIndex(e.target.value)}
              style={{ width: "100%", marginTop: "8px" }}
              id="index-filter-select"
            >
              <option value="all">All Indices</option>
              {indices.map((idx) => (
                <option key={idx.symbol} value={idx.symbol}>{idx.name}</option>
              ))}
            </select>
          </div>

          {/* Indicator Panel */}
          <div className={styles.indicatorConfig}>
            <div className={styles.sectionTitle} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>
                {INDICATOR_TABS.find(t => t.id === activeTab)?.icon}{" "}
                {INDICATOR_TABS.find(t => t.id === activeTab)?.label} Configuration
              </span>
              {RECOMMENDED_PARAMS[activeTab] && (
                <button
                  onClick={() => setParams({ ...params, ...RECOMMENDED_PARAMS[activeTab] })}
                  title={"Apply recommended parameters: " + Object.entries(RECOMMENDED_PARAMS[activeTab]).map(([k, v]) => `${k}=${v}`).join(", ")}
                  style={{
                    background: "rgba(34,211,238,0.12)", color: "#22d3ee",
                    border: "1px solid rgba(34,211,238,0.4)", borderRadius: 6,
                    padding: "3px 10px", fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
                  }}
                >
                  ✨ Recommended
                </button>
              )}
            </div>
            {PanelComponent && <PanelComponent params={params} setParams={setParams} />}
          </div>

          <button
            className={styles.runBtn}
            onClick={handleScan}
            disabled={running}
            id="indicator-scan-run-btn"
          >
            {running ? (
              <><span className={styles.spinner} /> Scanning NSE Stocks...</>
            ) : (
              <>▶ Run {INDICATOR_TABS.find(t => t.id === activeTab)?.label} Scanner</>
            )}
          </button>
        </div>

        {/* Results */}
        <div className={styles.resultsPanel}>
          {!results && !running && !error && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                {INDICATOR_TABS.find(t => t.id === activeTab)?.icon || "📉"}
              </div>
              <h3>Select Signal & Run Scanner</h3>
              <p>Configure the {INDICATOR_TABS.find(t => t.id === activeTab)?.label} parameters and click Run.</p>
            </div>
          )}
          {running && (
            <div className={styles.loadingState}>
              <div className={styles.loadingBar}><div className={styles.loadingFill} /></div>
              <p>Scanning NSE stocks...</p>
            </div>
          )}
          {error && (
            <div className={styles.errorState}>
              <span>⚠️</span>
              <h3>Scan Error</h3>
              <p>{error}</p>
              <button className={styles.retryBtn} onClick={handleScan}>↺ Retry</button>
            </div>
          )}
          {results && (
            <div className={styles.resultsContainer}>
              <div className="scan-results-header" style={{ padding: "8px 16px" }}>
                <div>
                  <span className="scan-results-count">{results.count ?? results.matches?.length ?? 0} Stocks Found</span>
                  <ViewAllOnCharts symbols={(results.matches || []).map(m => m.symbol)} label="Indicator Scanner" style={{ marginLeft: 10 }} />
                  <span className="scan-results-meta" style={{ marginLeft: 12 }}>
                    {activeTabInfo?.label} · {TIMEFRAMES.find(t => t.value === timeframe)?.label}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <div className="scan-view-toggle">
                    <button className={`scan-view-btn ${viewMode === "chart" ? "active" : ""}`} onClick={() => setViewMode("chart")}>⬛ Charts</button>
                    <button className={`scan-view-btn ${viewMode === "table" ? "active" : ""}`} onClick={() => setViewMode("table")}>☰ Table</button>
                  </div>
                </div>
              </div>
              {results.matches?.length > 0 ? (
                viewMode === "chart" ? (
                  <div className="scan-results-grid" style={{ padding: "8px 16px" }}>
                    {results.matches.map((m, i) => (
                      <IndResultCard key={i} match={{ ...m, chart_data: chartCache[m.symbol] || [] }}
                        indicator={activeTabInfo?.label}
                        isBullish={m.signal_direction ? m.signal_direction === "bullish" : isBullish}
                        timeframe={timeframe} />
                    ))}
                  </div>
                ) : (
                  <div className={styles.resultsTable}>
                    <div className={styles.tableHead}>
                      <span>Symbol</span><span>Company</span><span>Sector</span>
                      <span>Close ₹</span><span>Change %</span>
                      <span>Signal</span><span>Chart</span>
                    </div>
                    {results.matches.map((m, i) => (
                      <div key={i} className={styles.tableRow}>
                        <span className={styles.symbol}>{m.symbol}</span>
                        <span className={styles.companyName}>{m.name || "—"}</span>
                        <span className={styles.sectorName} style={{ color: "#888", fontSize: "12px" }}>{m.sector || "—"}</span>
                        <span className={styles.price}>₹{m.close?.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                        <span className={m.change_pct >= 0 ? styles.changeUp : styles.changeDown}>
                          {m.change_pct >= 0 ? "+" : ""}{m.change_pct?.toFixed(2) ?? "—"}%
                        </span>
                        <span className={`${styles.signalBadge} ${m.signal_direction === "bullish" ? styles.signalBull : styles.signalBear}`}>
                          {m.signal_direction === "bullish" ? "🟢 Bullish" : "🔴 Bearish"}
                        </span>
                        <a href={`/dashboard/charts?symbol=${m.symbol}&tf=${timeframe}`} className={styles.chartLink}>Chart →</a>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className={styles.noMatches}>No stocks matched the indicator criteria.</div>
              )}
            </div>
          )}
        </div>
      </div>
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
