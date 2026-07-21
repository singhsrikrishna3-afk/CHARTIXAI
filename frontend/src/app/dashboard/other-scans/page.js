"use client";

import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";
import { drawMiniChart } from "@/lib/miniChart";
import styles from "./other-scans.module.css";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

function OtherResultCard({ match, scanLabel, isBullish, activeTab, timeframe }) {
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
      gridColor: "#EEEEEE", borderColor: "#C0C0C0", showVolume: true,
      showMA: true, maPeriod: 20, maColor: isBullish ? "#FF6600" : "#AA00AA",
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
          <span className="src-badge" style={{ color: isBullish ? "#008000" : "#CC0000" }}>{isBullish ? "▲" : "▼"}</span>
        </div>
        {match.name && <div className="src-name">{match.name}</div>}
        {match.sector && <div className="src-sector" style={{ fontSize: "11px", color: "#888", marginTop: "2px", fontWeight: 500 }}>{match.sector}</div>}
        <div className="src-prices">
          {match.close != null && <span className="src-close">₹{match.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>}
          {match.change_pct != null && <span className={`src-change ${isUp ? "src-up" : "src-down"}`}>{isUp ? "▲" : "▼"} {Math.abs(match.change_pct).toFixed(2)}%</span>}
        </div>
        {scanLabel && <div className="src-signal">{scanLabel}</div>}
        {activeTab === "mtf_bullish" && (
          <div className="src-gains-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", fontSize: "11px", marginTop: "6px", borderTop: "1px solid #eee", paddingTop: "6px" }}>
            <div><strong>D:</strong> <span style={{ color: match.d_gain >= 0 ? "#008000" : "#CC0000" }}>{match.d_gain >= 0 ? "+" : ""}{match.d_gain?.toFixed(2)}%</span></div>
            <div><strong>W:</strong> <span style={{ color: match.w_gain >= 0 ? "#008000" : "#CC0000" }}>{match.w_gain >= 0 ? "+" : ""}{match.w_gain?.toFixed(2)}%</span></div>
            <div><strong>M:</strong> <span style={{ color: match.m_gain >= 0 ? "#008000" : "#CC0000" }}>{match.m_gain >= 0 ? "+" : ""}{match.m_gain?.toFixed(2)}%</span></div>
          </div>
        )}
        <div className="src-footer">
          {match.volume != null && <span className="src-vol">{match.volume >= 1e6 ? (match.volume / 1e6).toFixed(1) + "M" : (match.volume / 1e3).toFixed(0) + "K"}</span>}
          <a href={`/dashboard/charts?symbol=${match.symbol}&tf=${timeframe}`} className="src-chart-link">Chart →</a>
        </div>
      </div>
    </div>
  );
}

const SCAN_TABS = [
  { id: "breakout",    label: "Breakout",            icon: "🚀" },
  { id: "mtf_bullish", label: "MTF Candle Alignment", icon: "🕯️" },
  { id: "divergence",  label: "RSI/MACD Divergence", icon: "📐" },
  { id: "vcp",         label: "VCP Pattern",         icon: "🌪️" },
  { id: "week52",      label: "52-Week H/L",         icon: "📅" },
  { id: "volume",      label: "Volume Analysis",      icon: "📊" },
  { id: "gainers_losers", label: "Gainers/Losers + Vol", icon: "🔥" },
  { id: "hh_hl",       label: "HH/HL Trend",          icon: "📈" },
  { id: "pivot",       label: "Pivot Points",         icon: "🎯" },
  { id: "gaps",        label: "Gap Analysis",         icon: "⬆️" },
  { id: "fibonacci",   label: "Fibonacci Retrace",    icon: "🌀" },
  { id: "range",       label: "Range Breakout",       icon: "📦" },
  { id: "elliott",     label: "Elliott Wave 4th",     icon: "〰️" },
  { id: "gann_swing",  label: "Gann Swing Trend",     icon: "🔷" },
];


const TIMEFRAMES = [
  { value: "D", label: "Daily" },
  { value: "W", label: "Weekly" },
  { value: "M", label: "Monthly" },
];

// Recommended starting parameters per scan type — applied via the
// "✨ Recommended" button. Values balance hit-rate against setup quality.
const RECOMMENDED_PARAMS = {
  breakout:       { min_bars: 20, max_bars: 120, direction: "up", require_indicator_breakout: true },
  divergence:     { rsi_period: 14, min_swing: 8, max_swing: 40, indicator: "rsi", div_type: "positive" },
  vcp:            { min_contractions: 2, max_contractions: 4, max_contraction_depth: 35, near_pivot_pct: 8, vdu_pct: 100, require_prior_uptrend: true },
  week52:         { near_pct: 5, rebound_min: 50, rebound_max: 60, scan_type: "near_high" },
  volume:         { vol_pct: 200, avg_period: 20, rsi_level: 50, vol_type: "high_vol" },
  gainers_losers: { min_price_chg_pct: 3, vol_mult: 1.5, avg_period: 20, direction: "gainers" },
  hh_hl:          { swing_period: 5, num_swings: 2, trend_type: "hh_hl" },
  pivot:          { pivot_period: "W", pivot_type: "classic", pivot_action: "break_r1" },
  gaps:           { lookback: 5, min_gap_pct: 2, gap_type: "gap_up" },
  fibonacci:      { fib_level: "61.8", tolerance: 2, min_swing_pct: 15, direction: "bullish", require_high_volume: true },
  range:          { range_days: 20, max_range_pct: 8, range_type: "breakout_up" },
  elliott:        { lookback: 60, min_w3_pct: 15, max_w4_pct: 50, ew_dir: "bullish" },
  gann_swing:     { swing_bars: 5, min_swing: 3, confirm_swings: 2, gann_trend: "uptrend" },
};

function ScanForm({ tab, params, setParams }) {
  switch (tab) {
    case "mtf_bullish":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Scan for stocks showing the same candle type (e.g. Bullish, Bearish, Doji) on the Daily, Weekly, and Monthly timeframes simultaneously.
            This indicates strong momentum or structural alignment across short, medium, and long-term horizons.
          </div>
          <div className={styles.paramGrid}>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>Candle Type</label>
              <select 
                className={styles.select} 
                value={params.candle_type || "bullish"} 
                onChange={e => setParams({...params, candle_type: e.target.value})}
              >
                <option value="bullish">🟢 Bullish Candle (Close &gt; Open)</option>
                <option value="bearish">🔴 Bearish Candle (Close &lt; Open)</option>
                <option value="doji">🟡 Doji (Indecision / Tight Body)</option>
                <option value="hammer">🔨 Hammer (Bullish Reversal / Long Lower Shadow)</option>
                <option value="shooting_star">💫 Shooting Star (Bearish Reversal / Long Upper Shadow)</option>
                <option value="marubozu_bullish">⚡ Bullish Marubozu (Very Strong Buying)</option>
                <option value="marubozu_bearish">💥 Bearish Marubozu (Very Strong Selling)</option>
              </select>
            </div>
          </div>
        </div>
      );
    case "breakout":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Scan stocks that broke out above/below previous swing high/low. 
            Set bar range (e.g., any breakout between 10–300 bars).
            Optional: require indicator breakout to avoid false signals.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Min Bars (lookback)" value={params.min_bars || 10} onChange={v => setParams({...params, min_bars: v})} />
            <ParamInput label="Max Bars (lookback)" value={params.max_bars || 300} onChange={v => setParams({...params, max_bars: v})} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="bo_dir" value="up" checked={params.direction !== "down"} onChange={() => setParams({...params, direction: "up"})} /> 🟢 Breakout (Price breaks above swing high)</label>
            <label className={styles.radioLabel}><input type="radio" name="bo_dir" value="down" checked={params.direction === "down"} onChange={() => setParams({...params, direction: "down"})} /> 🔴 Breakdown (Price breaks below swing low)</label>
          </div>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={params.require_indicator_breakout || false} onChange={e => setParams({...params, require_indicator_breakout: e.target.checked})} />
            Require RSI/MACD indicator breakout confirmation
          </label>
        </div>
      );
    case "divergence":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Detect positive (bullish) and negative (bearish) divergence in RSI and MACD.
            Set swing size range for divergence detection.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="RSI Period" value={params.rsi_period || 14} onChange={v => setParams({...params, rsi_period: v})} />
            <ParamInput label="Min Swing Bars" value={params.min_swing || 5} onChange={v => setParams({...params, min_swing: v})} />
            <ParamInput label="Max Swing Bars" value={params.max_swing || 50} onChange={v => setParams({...params, max_swing: v})} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="div_ind" value="rsi" checked={params.indicator !== "macd"} onChange={() => setParams({...params, indicator: "rsi"})} /> RSI Divergence</label>
            <label className={styles.radioLabel}><input type="radio" name="div_ind" value="macd" checked={params.indicator === "macd"} onChange={() => setParams({...params, indicator: "macd"})} /> MACD Divergence</label>
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="div_type" value="positive" checked={params.div_type !== "negative"} onChange={() => setParams({...params, div_type: "positive"})} /> 🟢 Positive Divergence (Price ↓, Indicator ↑) — Bullish</label>
            <label className={styles.radioLabel}><input type="radio" name="div_type" value="negative" checked={params.div_type === "negative"} onChange={() => setParams({...params, div_type: "negative"})} /> 🔴 Negative Divergence (Price ↑, Indicator ↓) — Bearish</label>
          </div>
        </div>
      );
    case "vcp":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Scan for Mark Minervini's Volatility Contraction Pattern (VCP).
            Identifies stocks in an uptrend undergoing sequential volatility/swing tightenings, forming a tight pivot range on volume dry-up.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Min Contractions (Ts)" value={params.min_contractions || 2} onChange={v => setParams({...params, min_contractions: v})} min={2} max={4} />
            <ParamInput label="Max Contractions (Ts)" value={params.max_contractions || 4} onChange={v => setParams({...params, max_contractions: v})} min={2} max={5} />
            <ParamInput label="Max Init Depth %" value={params.max_contraction_depth || 35} onChange={v => setParams({...params, max_contraction_depth: v})} min={10} max={60} />
            <ParamInput label="Near Pivot %" value={params.near_pivot_pct || 8} onChange={v => setParams({...params, near_pivot_pct: v})} step={0.5} min={1} max={15} />
            <ParamInput label="Vol Dry-Up % (VDU)" value={params.vdu_pct || 100} onChange={v => setParams({...params, vdu_pct: v})} min={20} max={130} />
          </div>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={params.require_prior_uptrend !== false} onChange={e => setParams({...params, require_prior_uptrend: e.target.checked})} />
            Require prior uptrend (Price above SMA 150/200 & SMA 200 trending up)
          </label>
        </div>
      );
    case "week52":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Find stocks near 52-week high/low, or stocks that have rebounded from their 52-week extreme by a certain percentage.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Near % (within)" value={params.near_pct || 5} onChange={v => setParams({...params, near_pct: v})} step={0.5} />
            <ParamInput label="Rebound From % (min)" value={params.rebound_min || 50} onChange={v => setParams({...params, rebound_min: v})} />
            <ParamInput label="Rebound From % (max)" value={params.rebound_max || 60} onChange={v => setParams({...params, rebound_max: v})} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="w52_type" value="near_high" checked={params.scan_type === "near_high" || !params.scan_type} onChange={() => setParams({...params, scan_type: "near_high"})} /> 🔴 Near 52-Week HIGH (within {params.near_pct || 5}%)</label>
            <label className={styles.radioLabel}><input type="radio" name="w52_type" value="near_low" checked={params.scan_type === "near_low"} onChange={() => setParams({...params, scan_type: "near_low"})} /> 🟢 Near 52-Week LOW (within {params.near_pct || 5}%)</label>
            <label className={styles.radioLabel}><input type="radio" name="w52_type" value="rebound_high" checked={params.scan_type === "rebound_high"} onChange={() => setParams({...params, scan_type: "rebound_high"})} /> 📉 Rebounded from 52W High by {params.rebound_min || 50}–{params.rebound_max || 60}%</label>
            <label className={styles.radioLabel}><input type="radio" name="w52_type" value="rebound_low" checked={params.scan_type === "rebound_low"} onChange={() => setParams({...params, scan_type: "rebound_low"})} /> 📈 Rebounded from 52W Low by {params.rebound_min || 50}–{params.rebound_max || 60}%</label>
          </div>
        </div>
      );
    case "volume":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Find stocks with unusual volume activity. Filter by RSI to distinguish accumulation from distribution.
            Also find stocks with lifetime or N-day highest volumes.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Volume % above avg" value={params.vol_pct || 200} onChange={v => setParams({...params, vol_pct: v})} />
            <ParamInput label="Avg Volume Period" value={params.avg_period || 20} onChange={v => setParams({...params, avg_period: v})} />
            <ParamInput label="RSI Level (filter)" value={params.rsi_level || 50} onChange={v => setParams({...params, rsi_level: v})} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="vol_type" value="high_vol" checked={!params.vol_type || params.vol_type === "high_vol"} onChange={() => setParams({...params, vol_type: "high_vol"})} /> Volume {params.vol_pct || 200}%+ above {params.avg_period || 20}-day avg</label>
            <label className={styles.radioLabel}><input type="radio" name="vol_type" value="high_vol_rsi_below" checked={params.vol_type === "high_vol_rsi_below"} onChange={() => setParams({...params, vol_type: "high_vol_rsi_below"})} /> 🟢 High Volume + RSI below {params.rsi_level || 30} (Accumulation)</label>
            <label className={styles.radioLabel}><input type="radio" name="vol_type" value="high_vol_rsi_above" checked={params.vol_type === "high_vol_rsi_above"} onChange={() => setParams({...params, vol_type: "high_vol_rsi_above"})} /> 🔴 High Volume + RSI above {params.rsi_level || 70} (Distribution)</label>
            <label className={styles.radioLabel}><input type="radio" name="vol_type" value="lifetime_high" checked={params.vol_type === "lifetime_high"} onChange={() => setParams({...params, vol_type: "lifetime_high"})} /> 📊 Lifetime Highest Volume</label>
          </div>
        </div>
      );
    case "gainers_losers":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Combined price + volume scan: a price gainer/loser only counts if it's also
            trading on above-average volume, filtering out moves with no real participation.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Min Price Change %" value={params.min_price_chg_pct || 3} onChange={v => setParams({...params, min_price_chg_pct: v})} step={0.5} />
            <ParamInput label="Volume Multiplier (x avg)" value={params.vol_mult || 1.5} onChange={v => setParams({...params, vol_mult: v})} step={0.1} min={1} />
            <ParamInput label="Avg Volume Period" value={params.avg_period || 20} onChange={v => setParams({...params, avg_period: v})} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="gl_dir" value="gainers" checked={params.direction !== "losers"} onChange={() => setParams({...params, direction: "gainers"})} /> 🟢 Top Gainers (Price ↑ + Volume Surge)</label>
            <label className={styles.radioLabel}><input type="radio" name="gl_dir" value="losers" checked={params.direction === "losers"} onChange={() => setParams({...params, direction: "losers"})} /> 🔴 Top Losers (Price ↓ + Volume Surge)</label>
          </div>
        </div>
      );
    case "hh_hl":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Dow Theory: stocks making Higher Highs + Higher Lows = Uptrend. Lower Highs + Lower Lows = Downtrend.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Swing Period (bars)" value={params.swing_period || 5} onChange={v => setParams({...params, swing_period: v})} />
            <ParamInput label="Num Swings Required" value={params.num_swings || 2} onChange={v => setParams({...params, num_swings: v})} min={1} max={5} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="hh_type" value="hh_hl" checked={!params.trend_type || params.trend_type === "hh_hl"} onChange={() => setParams({...params, trend_type: "hh_hl"})} /> 🟢 Higher High + Higher Low (Uptrend)</label>
            <label className={styles.radioLabel}><input type="radio" name="hh_type" value="ll_lh" checked={params.trend_type === "ll_lh"} onChange={() => setParams({...params, trend_type: "ll_lh"})} /> 🔴 Lower Low + Lower High (Downtrend)</label>
            <label className={styles.radioLabel}><input type="radio" name="hh_type" value="first_hh" checked={params.trend_type === "first_hh"} onChange={() => setParams({...params, trend_type: "first_hh"})} /> 🔄 First Higher High (Early trend reversal)</label>
            <label className={styles.radioLabel}><input type="radio" name="hh_type" value="first_ll" checked={params.trend_type === "first_ll"} onChange={() => setParams({...params, trend_type: "first_ll"})} /> 🔄 First Lower Low (Early downtrend signal)</label>
          </div>
        </div>
      );
    case "pivot":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Scan weekly/monthly pivot points. Find stocks breaking, supporting, or testing pivot levels.
            Supports 4 pivot types: Classic, Woodies, Camarilla, Fibonacci.
          </div>
          <div className={styles.paramGrid}>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>Pivot Period</label>
              <select className={styles.select} value={params.pivot_period || "W"} onChange={e => setParams({...params, pivot_period: e.target.value})}>
                <option value="W">Weekly</option>
                <option value="M">Monthly</option>
              </select>
            </div>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>Pivot Type</label>
              <select className={styles.select} value={params.pivot_type || "classic"} onChange={e => setParams({...params, pivot_type: e.target.value})}>
                <option value="classic">Classic</option>
                <option value="woodies">Woodies</option>
                <option value="camarilla">Camarilla</option>
                <option value="fibonacci">Fibonacci</option>
              </select>
            </div>
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="piv_action" value="break_r1" checked={!params.pivot_action || params.pivot_action === "break_r1"} onChange={() => setParams({...params, pivot_action: "break_r1"})} /> 🟢 Price breaks above R1 (Bullish)</label>
            <label className={styles.radioLabel}><input type="radio" name="piv_action" value="break_s1" checked={params.pivot_action === "break_s1"} onChange={() => setParams({...params, pivot_action: "break_s1"})} /> 🔴 Price breaks below S1 (Bearish)</label>
            <label className={styles.radioLabel}><input type="radio" name="piv_action" value="support_pp" checked={params.pivot_action === "support_pp"} onChange={() => setParams({...params, pivot_action: "support_pp"})} /> 🔵 Price finds support at PP (Pivot Point)</label>
            <label className={styles.radioLabel}><input type="radio" name="piv_action" value="resistance_pp" checked={params.pivot_action === "resistance_pp"} onChange={() => setParams({...params, pivot_action: "resistance_pp"})} /> 🟠 Price finds resistance at PP</label>
          </div>
        </div>
      );
    case "gaps":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Find stocks that made a gap up/down in recent sessions. Also find stocks where a past gap has been filled.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Lookback Bars" value={params.lookback || 5} onChange={v => setParams({...params, lookback: v})} />
            <ParamInput label="Min Gap % Size" value={params.min_gap_pct || 1} onChange={v => setParams({...params, min_gap_pct: v})} step={0.5} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="gap_type" value="gap_up" checked={!params.gap_type || params.gap_type === "gap_up"} onChange={() => setParams({...params, gap_type: "gap_up"})} /> 🟢 Gap Up (in last {params.lookback || 5} bars)</label>
            <label className={styles.radioLabel}><input type="radio" name="gap_type" value="gap_down" checked={params.gap_type === "gap_down"} onChange={() => setParams({...params, gap_type: "gap_down"})} /> 🔴 Gap Down (in last {params.lookback || 5} bars)</label>
            <label className={styles.radioLabel}><input type="radio" name="gap_type" value="gap_fill" checked={params.gap_type === "gap_fill"} onChange={() => setParams({...params, gap_type: "gap_fill"})} /> ↩ Gap Fill (past gap now filled in 1–3 days)</label>
          </div>
        </div>
      );
    case "fibonacci":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Find stocks that have retraced to a Fibonacci level (50%, 61.8%, 78.6%, or custom %).
            Optional: require last bar color in direction of main swing, and volume filter.
          </div>
          <div className={styles.paramGrid}>
            <div className={styles.paramItem}>
              <label className={styles.paramLabel}>Fib Level</label>
              <select className={styles.select} value={params.fib_level || "61.8"} onChange={e => setParams({...params, fib_level: e.target.value})}>
                <option value="23.6">23.6%</option>
                <option value="38.2">38.2%</option>
                <option value="50.0">50.0%</option>
                <option value="61.8">61.8% (Golden)</option>
                <option value="78.6">78.6%</option>
              </select>
            </div>
            <ParamInput label="Tolerance %" value={params.tolerance || 2} onChange={v => setParams({...params, tolerance: v})} step={0.5} />
            <ParamInput label="Min Swing Size %" value={params.min_swing_pct || 10} onChange={v => setParams({...params, min_swing_pct: v})} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="fib_dir" value="bullish" checked={!params.direction || params.direction === "bullish"} onChange={() => setParams({...params, direction: "bullish"})} /> 🟢 Bullish Retracement (Stock retraced from high)</label>
            <label className={styles.radioLabel}><input type="radio" name="fib_dir" value="bearish" checked={params.direction === "bearish"} onChange={() => setParams({...params, direction: "bearish"})} /> 🔴 Bearish Retracement (Stock retraced from low)</label>
          </div>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={params.require_high_volume || false} onChange={e => setParams({...params, require_high_volume: e.target.checked})} />
            Require high volume confirmation
          </label>
        </div>
      );
    case "range":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Find stocks that have been trading in a tight range for N days and have now broken out (or are still in range).
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Range Period (days)" value={params.range_days || 20} onChange={v => setParams({...params, range_days: v})} />
            <ParamInput label="Max Range Width %" value={params.max_range_pct || 10} onChange={v => setParams({...params, max_range_pct: v})} step={0.5} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="rng_type" value="breakout_up" checked={!params.range_type || params.range_type === "breakout_up"} onChange={() => setParams({...params, range_type: "breakout_up"})} /> 🟢 Breakout Above Range</label>
            <label className={styles.radioLabel}><input type="radio" name="rng_type" value="breakout_down" checked={params.range_type === "breakout_down"} onChange={() => setParams({...params, range_type: "breakout_down"})} /> 🔴 Breakdown Below Range</label>
            <label className={styles.radioLabel}><input type="radio" name="rng_type" value="still_in_range" checked={params.range_type === "still_in_range"} onChange={() => setParams({...params, range_type: "still_in_range"})} /> 📦 Still in Range (consolidating)</label>
          </div>
        </div>
      );
    case "elliott":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Find stocks that appear to be in Elliott Wave 4th corrective wave — pullback after a strong 3-wave rally,
            setting up for a potential Wave 5 impulse. Requires a clear 3-wave structure in lookback period.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Lookback Bars" value={params.lookback || 60} onChange={v => setParams({...params, lookback: v})} />
            <ParamInput label="Min Wave 3 Rally %" value={params.min_w3_pct || 10} onChange={v => setParams({...params, min_w3_pct: v})} step={0.5} />
            <ParamInput label="Max W4 Retrace %" value={params.max_w4_pct || 50} onChange={v => setParams({...params, max_w4_pct: v})} step={0.5} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="ew_dir" value="bullish" checked={!params.ew_dir || params.ew_dir === "bullish"} onChange={() => setParams({...params, ew_dir: "bullish"})} /> 🟢 Bullish W4 (expect W5 up)</label>
            <label className={styles.radioLabel}><input type="radio" name="ew_dir" value="bearish" checked={params.ew_dir === "bearish"} onChange={() => setParams({...params, ew_dir: "bearish"})} /> 🔴 Bearish W4 (expect W5 down)</label>
          </div>
        </div>
      );
    case "gann_swing":
      return (
        <div className={styles.form}>
          <div className={styles.formDesc}>
            Gann Swing Chart — identifies primary trend using swing highs and swing lows.
            Find stocks in a confirmed uptrend (HH + HL) or downtrend (LH + LL) per Gann swing rules.
            Consecutive swing count confirms trend strength.
          </div>
          <div className={styles.paramGrid}>
            <ParamInput label="Swing Lookback (bars)" value={params.swing_bars || 5} onChange={v => setParams({...params, swing_bars: v})} />
            <ParamInput label="Min Swing Bars" value={params.min_swing || 3} onChange={v => setParams({...params, min_swing: v})} />
            <ParamInput label="Confirm Swings Count" value={params.confirm_swings || 2} onChange={v => setParams({...params, confirm_swings: v})} />
          </div>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}><input type="radio" name="gann_trend" value="uptrend" checked={!params.gann_trend || params.gann_trend === "uptrend"} onChange={() => setParams({...params, gann_trend: "uptrend"})} /> 🟢 Gann Uptrend (HH+HL confirmed)</label>
            <label className={styles.radioLabel}><input type="radio" name="gann_trend" value="downtrend" checked={params.gann_trend === "downtrend"} onChange={() => setParams({...params, gann_trend: "downtrend"})} /> 🔴 Gann Downtrend (LH+LL confirmed)</label>
            <label className={styles.radioLabel}><input type="radio" name="gann_trend" value="reversal" checked={params.gann_trend === "reversal"} onChange={() => setParams({...params, gann_trend: "reversal"})} /> 🔷 Trend Reversal Signal (swing flip)</label>
          </div>
        </div>
      );
    default:
      return null;
  }
}


function ParamInput({ label, value, onChange, step = 1, min = 1, max = 9999 }) {
  return (
    <div className={styles.paramItem}>
      <label className={styles.paramLabel}>{label}</label>
      <input
        type="number"
        className={styles.numInput}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        step={step}
        min={min}
        max={max}
      />
    </div>
  );
}

export default function OtherScansPage() {
  const [activeTab, setActiveTab] = useState("breakout");
  const [timeframe, setTimeframe] = useState("D");
  const [subscription, setSubscription] = useState(null);
  const [premiumUpgradeMessage, setPremiumUpgradeMessage] = useState(null);
  const [params, setParams] = useState({});
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("chart");
  const [chartCache, setChartCache] = useState({});
  const [sectors, setSectors]     = useState([]);
  const [selectedSector, setSelectedSector] = useState("all");
  const [indices, setIndices]     = useState([]);
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
      const data = await api.runOtherScan({
        scan_type: activeTab,
        timeframe,
        sector: selectedSector,
        index: selectedIndex,
        ...params
      });
      setResults(data);
      const cache = {};
      await Promise.allSettled(
        (data.matches?.slice(0, 50) || []).map(async (m) => {
          try {
            const chartData = await api.getEod(m.symbol);
            cache[m.symbol] = chartData.map((d) => ({ open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
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

  const exportCSV = () => {
    if (!results?.matches) return;
    const rows = results.matches.map((m) => `${m.symbol},${m.name || ""},${m.close || ""},${m.change_pct || ""}`).join("\n");
    const blob = new Blob([`Symbol,Name,Close,Change%\n${rows}`], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "scan_results.csv"; a.click();
  };

  const selectedCandleType = params.candle_type || "bullish";
  const isBullish = (activeTab === "mtf_bullish" && (selectedCandleType === "bullish" || selectedCandleType === "hammer" || selectedCandleType === "marubozu_bullish")) ||
    activeTab === "vcp" || 
    (activeTab !== "mtf_bullish" && (!params.direction || params.direction !== "down" && params.direction !== "bearish"
      && params.div_type !== "negative" && params.trend_type !== "ll_lh"));

  const tabInfo = SCAN_TABS.find(t => t.id === activeTab);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>🔭 Other Scans</h1>
          <p className={styles.subtitle}>MTF Candle Alignment · Breakout · Divergence · VCP Pattern · 52W H/L · Volume · Pivot · Gaps · Fibonacci · Range · Elliott Wave · Gann Swing</p>
        </div>
      </div>

      {/* Tab Bar */}
      <div className={styles.tabBar}>
        {SCAN_TABS.map(tab => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ""}`}
            onClick={() => { setActiveTab(tab.id); setResults(null); setError(null); setParams({}); }}
            id={`scan-tab-${tab.id}`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className={styles.layout}>
        {/* Settings */}
        <div className={styles.settingsPanel}>
          <div className={styles.sectionTitle}>Sector Filter</div>
          <select
            className={styles.select}
            value={selectedSector}
            onChange={(e) => setSelectedSector(e.target.value)}
            style={{ width: "100%", marginBottom: "8px" }}
            id="sector-filter-select"
          >
            <option value="all">All Sectors</option>
            {sectors.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <div className={styles.sectionTitle} style={{ marginTop: "12px" }}>Index Filter</div>
          <select
            className={styles.select}
            value={selectedIndex}
            onChange={(e) => setSelectedIndex(e.target.value)}
            style={{ width: "100%", marginBottom: "8px" }}
            id="index-filter-select"
          >
            <option value="all">All Indices</option>
            {indices.map((idx) => (
              <option key={idx.symbol} value={idx.symbol}>{idx.name}</option>
            ))}
          </select>
          <div className={styles.divider} />

          {activeTab !== "mtf_bullish" && (
            <>
              <div className={styles.sectionTitle}>Timeframe</div>
              <div className={styles.tfRow}>
                {TIMEFRAMES.map(tf => (
                  <button key={tf.value} className={`${styles.tfBtn} ${timeframe === tf.value ? styles.tfBtnActive : ""}`}
                    onClick={() => handleTimeframeChange(tf.value)}>{tf.label}</button>
                ))}
              </div>
              <div className={styles.divider} />
            </>
          )}

          <div className={styles.sectionTitle} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>{tabInfo?.icon} {tabInfo?.label} Parameters</span>
            {RECOMMENDED_PARAMS[activeTab] && (
              <button
                onClick={() => setParams({ ...RECOMMENDED_PARAMS[activeTab] })}
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
          <ScanForm tab={activeTab} params={params} setParams={setParams} />

          <button
            className={styles.runBtn}
            onClick={handleScan}
            disabled={running}
            id="other-scan-run-btn"
          >
            {running ? <><span className={styles.spinner} /> Scanning NSE Stocks...</> : <>▶ Run {tabInfo?.label} Scan</>}
          </button>
        </div>

        {/* Results */}
        <div className={styles.resultsPanel}>
          {!results && !running && !error && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>{tabInfo?.icon || "🔭"}</div>
              <h3>Configure & Run {tabInfo?.label}</h3>
              <p>Set your parameters and click Run to scan NSE stocks.</p>
            </div>
          )}
          {running && (
            <div className={styles.loadingState}>
              <div className={styles.loadingBar}><div className={styles.loadingFill} /></div>
              <p>Scanning 2000+ NSE stocks...</p>
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
                  <ViewAllOnCharts symbols={(results.matches || []).map(m => m.symbol)} label="Other Scans" style={{ marginLeft: 10 }} />
                  <span className="scan-results-meta" style={{ marginLeft: 12 }}>{tabInfo?.label} · {TIMEFRAMES.find(t => t.value === timeframe)?.label}</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <div className="scan-view-toggle">
                    <button className={`scan-view-btn ${viewMode === "chart" ? "active" : ""}`} onClick={() => setViewMode("chart")}>⬛ Charts</button>
                    <button className={`scan-view-btn ${viewMode === "table" ? "active" : ""}`} onClick={() => setViewMode("table")}>☰ Table</button>
                  </div>
                  <button className="scan-export-btn" onClick={exportCSV}>↓ CSV</button>
                </div>
              </div>
              {results.matches?.length > 0 ? (
                viewMode === "chart" ? (
                  <div className="scan-results-grid" style={{ padding: "8px 16px" }}>
                    {results.matches.map((m, i) => (
                      <OtherResultCard key={i} match={{ ...m, chart_data: chartCache[m.symbol] || [] }}
                        scanLabel={tabInfo?.label} isBullish={isBullish} activeTab={activeTab} timeframe={timeframe} />
                    ))}
                  </div>
                ) : (
                  <div className={styles.resultsTable}>
                    <div className={styles.tableHead} style={{ gridTemplateColumns: activeTab === "mtf_bullish" ? "100px 1.2fr 1fr 100px 80px 80px 80px 70px" : "100px 1.2fr 1fr 100px 80px 80px 70px" }}>
                      {activeTab === "mtf_bullish" ? (
                        <>
                          <span>Symbol</span><span>Company</span><span>Sector</span><span>Close ₹</span><span>Daily Gain</span><span>Weekly Gain</span><span>Monthly Gain</span><span>Chart</span>
                        </>
                      ) : (
                        <>
                          <span>Symbol</span><span>Company</span><span>Sector</span><span>Close ₹</span><span>Change %</span><span>Volume</span><span>Chart</span>
                        </>
                      )}
                    </div>
                    {results.matches.map((m, i) => (
                      <div key={i} className={styles.tableRow} style={{ gridTemplateColumns: activeTab === "mtf_bullish" ? "100px 1.2fr 1fr 100px 80px 80px 80px 70px" : "100px 1.2fr 1fr 100px 80px 80px 70px" }}>
                        <span className={styles.symbol}>{m.symbol}</span>
                        <span className={styles.companyName}>{m.name || "—"}</span>
                        <span className={styles.sectorName} style={{ color: "#888", fontSize: "12px" }}>{m.sector || "—"}</span>
                        <span className={styles.price}>₹{m.close?.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                        {activeTab === "mtf_bullish" ? (
                          <>
                            <span className={m.d_gain >= 0 ? styles.changeUp : styles.changeDown}>
                              {m.d_gain >= 0 ? "+" : ""}{m.d_gain?.toFixed(2)}%
                            </span>
                            <span className={m.w_gain >= 0 ? styles.changeUp : styles.changeDown}>
                              {m.w_gain >= 0 ? "+" : ""}{m.w_gain?.toFixed(2)}%
                            </span>
                            <span className={m.m_gain >= 0 ? styles.changeUp : styles.changeDown}>
                              {m.m_gain >= 0 ? "+" : ""}{m.m_gain?.toFixed(2)}%
                            </span>
                          </>
                        ) : (
                          <>
                            <span className={m.change_pct >= 0 ? styles.changeUp : styles.changeDown}>
                              {m.change_pct >= 0 ? "+" : ""}{m.change_pct?.toFixed(2) ?? "—"}%
                            </span>
                            <span className={styles.volume}>{m.volume ? (m.volume / 1000).toFixed(0) + "K" : "—"}</span>
                          </>
                        )}
                        <a href={`/dashboard/charts?symbol=${m.symbol}&tf=${timeframe}`} className={styles.chartLink}>Chart →</a>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className={styles.noMatches}>No stocks matched the scan criteria. Try relaxing parameters.</div>
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
