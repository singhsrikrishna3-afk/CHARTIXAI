"use client";

import { useRef, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { drawMiniChart } from "@/lib/miniChart";
import styles from "./candlesticks.module.css";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

const CANDLESTICK_PATTERNS = [
  // Single Bar
  { id: "doji",               label: "Doji",                  type: "neutral",  desc: "Open ≈ Close, market indecision" },
  { id: "hammer",             label: "Hammer",                type: "bullish",  desc: "Long lower shadow after downtrend" },
  { id: "hanging_man",        label: "Hanging Man",           type: "bearish",  desc: "Long lower shadow after uptrend" },
  { id: "shooting_star",      label: "Shooting Star",         type: "bearish",  desc: "Long upper shadow, small body" },
  { id: "inverted_hammer",    label: "Inverted Hammer",       type: "bullish",  desc: "Long upper shadow after downtrend" },
  { id: "spinning_top",       label: "Spinning Top",          type: "neutral",  desc: "Small body, long shadows both sides" },
  { id: "marubozu_bullish",   label: "Bullish Marubozu",      type: "bullish",  desc: "Long white body, no shadows" },
  { id: "marubozu_bearish",   label: "Bearish Marubozu",      type: "bearish",  desc: "Long black body, no shadows" },
  // Two Bar
  { id: "engulfing_bullish",  label: "Bullish Engulfing",     type: "bullish",  desc: "White candle engulfs prior black" },
  { id: "engulfing_bearish",  label: "Bearish Engulfing",     type: "bearish",  desc: "Black candle engulfs prior white" },
  { id: "harami_bullish",     label: "Bullish Harami",        type: "bullish",  desc: "Small white inside large black candle" },
  { id: "harami_bearish",     label: "Bearish Harami",        type: "bearish",  desc: "Small black inside large white candle" },
  { id: "piercing_line",      label: "Piercing Line",         type: "bullish",  desc: "White candle closes above midpoint of prior black" },
  { id: "dark_cloud_cover",   label: "Dark Cloud Cover",      type: "bearish",  desc: "Black candle closes below midpoint of prior white" },
  { id: "tweezer_top",        label: "Tweezer Top",           type: "bearish",  desc: "Two candles with matching highs" },
  { id: "tweezer_bottom",     label: "Tweezer Bottom",        type: "bullish",  desc: "Two candles with matching lows" },
  // Three Bar
  { id: "morning_star",         label: "Morning Star",          type: "bullish",  desc: "3-bar bullish reversal at bottom" },
  { id: "evening_star",         label: "Evening Star",          type: "bearish",  desc: "3-bar bearish reversal at top" },
  { id: "three_white_soldiers", label: "Three White Soldiers",  type: "bullish",  desc: "Three consecutive strong white candles" },
  { id: "three_black_crows",    label: "Three Black Crows",     type: "bearish",  desc: "Three consecutive strong black candles" },
  { id: "morning_doji_star",    label: "Morning Doji Star",     type: "bullish",  desc: "Morning Star with Doji in middle" },
  { id: "evening_doji_star",    label: "Evening Doji Star",     type: "bearish",  desc: "Evening Star with Doji in middle" },
  { id: "three_inside_up",      label: "Three Inside Up",       type: "bullish",  desc: "Bullish Harami confirmed by 3rd candle" },
  { id: "three_inside_down",    label: "Three Inside Down",     type: "bearish",  desc: "Bearish Harami confirmed by 3rd candle" },
];

const TIMEFRAMES = [
  { value: "D", label: "Daily" },
  { value: "W", label: "Weekly" },
  { value: "M", label: "Monthly" },
];

const FILTER_TYPES = ["All", "Bullish", "Bearish", "Neutral"];

const CUSTOM_FIELD_OPTIONS = ["open", "high", "low", "close", "volume", "body_size", "range", "upper_shadow", "lower_shadow"];
const CUSTOM_OP_OPTIONS = [["gt", ">"], ["lt", "<"], ["gte", "≥"], ["lte", "≤"], ["eq", "="]];

// ─── Custom candlestick pattern builder ───────────────────────────────────────
function CustomPatternBuilder({ customName, setCustomName, customRules, setCustomRules }) {
  const addRule = () => setCustomRules([...customRules, { field: "close", op: "gt", compare_field: "open" }]);
  const updateRule = (i, patch) => setCustomRules(customRules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRule = (i) => setCustomRules(customRules.filter((_, idx) => idx !== i));

  return (
    <div style={{ padding: 12, borderTop: "1px solid #e0e0e0" }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>🛠️ Custom Pattern Builder</div>
      <input
        type="text"
        placeholder="Pattern name (e.g. my_bull_setup)"
        value={customName}
        onChange={(e) => setCustomName(e.target.value)}
        style={{ width: "100%", marginBottom: 8, padding: 6, boxSizing: "border-box" }}
      />
      {customRules.map((rule, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select value={rule.field} onChange={(e) => updateRule(i, { field: e.target.value })}>
            {CUSTOM_FIELD_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={rule.op} onChange={(e) => updateRule(i, { op: e.target.value })}>
            {CUSTOM_OP_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            value={rule.compare_field || ""}
            onChange={(e) =>
              updateRule(i, e.target.value
                ? { compare_field: e.target.value, value: undefined, value_mult: undefined, value_field: undefined }
                : { compare_field: undefined, value: rule.value ?? 0 })
            }
          >
            <option value="">(fixed value)</option>
            {CUSTOM_FIELD_OPTIONS.map((f) => <option key={f} value={f}>{f} × mult</option>)}
          </select>
          {rule.compare_field ? (
            <input type="number" value={rule.value_mult ?? 1} step="0.01"
              title="Multiplier applied to the compared field"
              onChange={(e) => updateRule(i, { value_mult: Number(e.target.value), value_field: rule.compare_field, compare_field: undefined })}
              style={{ width: 70 }} />
          ) : (
            <input type="number" value={rule.value ?? 0} step="0.01"
              onChange={(e) => updateRule(i, { value: Number(e.target.value) })}
              style={{ width: 70 }} />
          )}
          <button onClick={() => removeRule(i)} title="Remove rule">✕</button>
        </div>
      ))}
      <button type="button" onClick={addRule} style={{ padding: "4px 10px" }}>+ Add Rule</button>
      <p style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
        Rules are ANDed against the latest bar. E.g. close &gt; open AND body_size &gt; range × 0.85 builds a custom bullish-marubozu rule.
      </p>
    </div>
  );
}

// ─── Mini chart thumbnail for scan result ─────────────────────────────────────
function CandleResultCard({ match, patternLabel, patternType, timeframe }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !match.chart_data || match.chart_data.length < 2) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext("2d").scale(dpr, dpr);
    drawMiniChart(canvas, match.chart_data.slice(-40), {
      upColor: "#26a69a", downColor: "#ef5350",
      bgColor: "#FFFFFF",  gridColor: "#EEEEEE",
      borderColor: "#C0C0C0", showVolume: true,
      showMA: true, maPeriod: 20,
      maColor: patternType === "bullish" ? "#FF6600" : "#AA00AA",
    });
  }, [match.chart_data, patternType]);

  const isUp = (match.change_pct ?? 0) >= 0;
  const typeColor = patternType === "bullish" ? "#008000" : patternType === "bearish" ? "#CC0000" : "#AA6600";

  return (
    <div className="scan-result-card">
      <div className="src-chart-wrap">
        <canvas ref={canvasRef} className="src-canvas"
          style={{ width: "100%", height: "100%", display: "block" }} />
        {(!match.chart_data || match.chart_data.length === 0) && (
          <div className="src-no-chart">No Chart</div>
        )}
      </div>
      <div className="src-info">
        <div className="src-top-row">
          <a href={`/dashboard/charts?symbol=${match.symbol}&tf=${timeframe}`} className="src-symbol">{match.symbol}</a>
          <span className="src-badge" style={{ color: typeColor }}>
            {patternType === "bullish" ? "▲" : patternType === "bearish" ? "▼" : "◆"}
          </span>
        </div>
        {match.name && <div className="src-name">{match.name}</div>}
        {match.sector && <div className="src-sector" style={{ fontSize: "11px", color: "#888", marginTop: "2px", fontWeight: 500 }}>{match.sector}</div>}
        <div className="src-prices">
          {match.close != null && (
            <span className="src-close">₹{match.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
          )}
          {match.change_pct != null && (
            <span className={`src-change ${isUp ? "src-up" : "src-down"}`}>
              {isUp ? "▲" : "▼"} {Math.abs(match.change_pct).toFixed(2)}%
            </span>
          )}
        </div>
        <div className="src-signal" style={{ color: typeColor, fontWeight: 700 }}>
          🕯️ {patternLabel}
        </div>
        <div className="src-footer">
          {match.volume != null && (
            <span className="src-vol">
              {match.volume >= 1e6 ? (match.volume / 1e6).toFixed(1) + "M" : (match.volume / 1e3).toFixed(0) + "K"}
            </span>
          )}
          <a href={`/dashboard/charts?symbol=${match.symbol}&tf=${timeframe}`} className="src-chart-link">Chart →</a>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function CandlesticksPage() {
  const [selected, setSelected]     = useState(new Set());
  const [timeframe, setTimeframe]   = useState("D");
  const [subscription, setSubscription] = useState(null);
  const [premiumUpgradeMessage, setPremiumUpgradeMessage] = useState(null);
  const [filterType, setFilterType] = useState("All");
  const [running, setRunning]       = useState(false);
  const [results, setResults]       = useState(null);
  const [error, setError]           = useState(null);
  const [viewMode, setViewMode]     = useState("chart");  // "chart" | "table"
  const [chartCache, setChartCache] = useState({});
  const [customName, setCustomName]   = useState("");
  const [customRules, setCustomRules] = useState([]);
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


  const filteredPatterns = CANDLESTICK_PATTERNS.filter(
    (p) => filterType === "All" || p.type === filterType.toLowerCase()
  );

  const togglePattern = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const selectAll   = () => setSelected(new Set(filteredPatterns.map((p) => p.id)));
  const clearAll    = () => setSelected(new Set());

  const customPatterns = (customName.trim() && customRules.length > 0)
    ? [{ name: customName.trim(), logic: "AND", rules: customRules }]
    : [];

  async function handleScan() {
    if (selected.size === 0 && customPatterns.length === 0) {
      alert("Please select at least one pattern, or build a custom one.");
      return;
    }
    setRunning(true); setError(null); setResults(null); setChartCache({});
    try {
      const data = await api.runCandlestickScanner({
        patterns: Array.from(selected),
        custom_patterns: customPatterns,
        timeframe,
        sector: selectedSector,
        index: selectedIndex
      });
      setResults(data);
      // Fetch mini-chart data for first 50 results
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

  const exportCSV = () => {
    if (!results?.matches) return;
    const rows = results.matches.map((m) => `${m.symbol},${m.name || ""},${m.close || ""},${m.change_pct || ""},${m.pattern || ""}`).join("\n");
    const blob = new Blob([`Symbol,Name,Close,Change%,Pattern\n${rows}`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "candlestick_scan.csv"; a.click();
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>🕯️ Candlestick Scanner</h1>
          <p className={styles.subtitle}>
            Scan NSE stocks for 24+ candlestick patterns — Single, Two &amp; Three bar patterns
          </p>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.selectedCount}>
            {selected.size} pattern{selected.size !== 1 ? "s" : ""} selected
          </span>
        </div>
      </div>

      <div className={styles.layout}>
        {/* ─── Pattern Selector Panel ───────────────────── */}
        <div className={styles.patternPanel}>
          <div className={styles.panelControls}>
            <div className={styles.filterTabs}>
              {FILTER_TYPES.map((f) => (
                <button key={f}
                  className={`${styles.filterTab} ${filterType === f ? styles.filterTabActive : ""} ${styles[`filter${f}`]}`}
                  onClick={() => setFilterType(f)}>
                  {f}
                </button>
              ))}
            </div>
            <div className={styles.bulkBtns}>
              <button className={styles.bulkBtn} onClick={selectAll}>All</button>
              <button className={styles.bulkBtn} onClick={clearAll}>None</button>
            </div>
          </div>

          <div className={styles.patternGrid}>
            {filteredPatterns.map((p) => (
              <button key={p.id}
                className={`${styles.patternCard} ${selected.has(p.id) ? styles.patternCardSelected : ""} ${styles[`type_${p.type}`]}`}
                onClick={() => togglePattern(p.id)} title={p.desc} id={`pattern-${p.id}`}>
                <span className={styles.patternIcon}>
                  {p.type === "bullish" ? "🟢" : p.type === "bearish" ? "🔴" : "🟡"}
                </span>
                <span className={styles.patternName}>{p.label}</span>
                <span className={styles.patternDesc}>{p.desc}</span>
                {selected.has(p.id) && <span className={styles.checkMark}>✓</span>}
              </button>
            ))}
          </div>

          <CustomPatternBuilder
            customName={customName} setCustomName={setCustomName}
            customRules={customRules} setCustomRules={setCustomRules}
          />

          <div className={styles.bottomControls}>
            <div className={styles.tfSection} style={{ marginBottom: "8px" }}>
              <span className={styles.tfLabel}>Sector Filter:</span>
              <select
                className={styles.select}
                value={selectedSector}
                onChange={(e) => setSelectedSector(e.target.value)}
                id="sector-filter-select"
              >
                <option value="all">All Sectors</option>
                {sectors.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className={styles.tfSection} style={{ marginBottom: "8px" }}>
              <span className={styles.tfLabel}>Index Filter:</span>
              <select
                className={styles.select}
                value={selectedIndex}
                onChange={(e) => setSelectedIndex(e.target.value)}
                id="index-filter-select"
              >
                <option value="all">All Indices</option>
                {indices.map((idx) => (
                  <option key={idx.symbol} value={idx.symbol}>{idx.name}</option>
                ))}
              </select>
            </div>
            <div className={styles.tfSection}>
              <span className={styles.tfLabel}>Timeframe:</span>
              <div className={styles.tfRow}>
                {TIMEFRAMES.map((tf) => (
                  <button key={tf.value}
                    className={`${styles.tfBtn} ${timeframe === tf.value ? styles.tfBtnActive : ""}`}
                    onClick={() => handleTimeframeChange(tf.value)}>
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>
            <button className={styles.runBtn} onClick={handleScan}
              disabled={running || (selected.size === 0 && customPatterns.length === 0)} id="candlestick-scan-run-btn">
              {running ? (
                <><span className={styles.spinner} /> Scanning...</>
              ) : (
                <>▶ Scan {selected.size > 0 ? `${selected.size} Pattern${selected.size > 1 ? "s" : ""}` : customPatterns.length ? "Custom Pattern" : "Selected Patterns"}</>
              )}
            </button>
          </div>
        </div>

        {/* ─── Results Panel ────────────────────────────── */}
        <div className={styles.resultsPanel}>
          {!results && !running && !error && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>🕯️</div>
              <h3>Select Patterns &amp; Scan</h3>
              <p>Pick one or more patterns, set your timeframe, and run the scan across 2000+ NSE stocks.</p>
              <div className={styles.tips}>
                <div className={styles.tip}>💡 Bullish patterns appear after downtrends</div>
                <div className={styles.tip}>💡 Confirm with volume analysis</div>
                <div className={styles.tip}>💡 Three-bar patterns are more reliable</div>
              </div>
            </div>
          )}

          {running && (
            <div className={styles.loadingState}>
              <div className={styles.loadingBar}><div className={styles.loadingFill} /></div>
              <p>Scanning {2000}+ NSE stocks for {selected.size} pattern{selected.size > 1 ? "s" : ""}...</p>
            </div>
          )}

          {error && (
            <div className={styles.errorState}>
              <span>⚠️</span><h3>Scan Error</h3><p>{error}</p>
              <button className={styles.retryBtn} onClick={handleScan}>↺ Retry</button>
            </div>
          )}

          {results && (
            <div className={styles.resultsContainer}>
              {/* Toolbar */}
              <div className="scan-results-header" style={{ padding: "8px 16px" }}>
                <div>
                  <span className="scan-results-count">
                    {results.count ?? results.matches?.length ?? 0} Stocks Found
                  </span>
                  <ViewAllOnCharts symbols={(results.matches || []).map(m => m.symbol)} label="Candlestick Scanner" style={{ marginLeft: 10 }} />
                  <span className="scan-results-meta" style={{ marginLeft: 12 }}>
                    {Array.from(selected).slice(0, 3).map(id => CANDLESTICK_PATTERNS.find(p => p.id === id)?.label).join(", ")}
                    {selected.size > 3 ? ` +${selected.size - 3} more` : ""}
                    {" · "}{TIMEFRAMES.find(t => t.value === timeframe)?.label}
                  </span>
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
                    {results.matches.map((m, i) => {
                      const pDef = CANDLESTICK_PATTERNS.find(p => p.id === m.pattern) ||
                                   CANDLESTICK_PATTERNS.find(p => Array.from(selected)[0] === p.id);
                      return (
                        <CandleResultCard key={i}
                          match={{ ...m, chart_data: chartCache[m.symbol] || [] }}
                          patternLabel={pDef?.label || m.pattern || "Pattern"}
                          patternType={pDef?.type || "neutral"}
                          timeframe={timeframe}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div className={styles.resultsTable}>
                    <div className={styles.tableHead}>
                      <span>Symbol</span><span>Company</span>
                      <span>Sector</span>
                      <span>Close ₹</span><span>Change %</span>
                      <span>Pattern</span><span>Chart</span>
                    </div>
                    {results.matches.map((m, i) => {
                      const pDef = CANDLESTICK_PATTERNS.find(p => p.id === m.pattern);
                      return (
                        <div key={i} className={styles.tableRow}>
                          <span className={styles.symbol}>{m.symbol}</span>
                          <span className={styles.companyName}>{m.name || "—"}</span>
                          <span className={styles.sectorName} style={{ color: "#888", fontSize: "12px" }}>{m.sector || "—"}</span>
                          <span className={styles.price}>₹{m.close?.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                          <span className={m.change_pct >= 0 ? styles.changeUp : styles.changeDown}>
                            {m.change_pct >= 0 ? "+" : ""}{m.change_pct?.toFixed(2) ?? "—"}%
                          </span>
                          <span className={`${styles.patternBadge} ${
                            pDef?.type === "bullish" ? styles.badgeBull
                            : pDef?.type === "bearish" ? styles.badgeBear
                            : styles.badgeNeutral
                          }`}>
                            {pDef?.label || m.pattern}
                          </span>
                          <a href={`/dashboard/charts?symbol=${m.symbol}&tf=${timeframe}`} className={styles.chartLink}>Chart →</a>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <div className={styles.noMatches}>No stocks matched the selected patterns.</div>
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
