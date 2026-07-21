"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { drawMiniChart } from "@/lib/miniChart";
import styles from "./ma-scanner.module.css";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

const MA_TYPES = [
  { value: "SMA", label: "SMA (Simple)" },
  { value: "EMA", label: "EMA (Exponential)" },
  { value: "WMA", label: "WMA (Weighted)" },
];

const SCAN_TYPES = [
  { value: "crossover",   label: "MA Crossover",    icon: "✕", desc: "Find stocks where a faster MA crosses a slower MA" },
  { value: "slope",       label: "MA Slope",         icon: "↗", desc: "Find stocks where MA is rising or falling at an angle" },
  { value: "convergence", label: "MA Convergence",   icon: "⟺", desc: "Find stocks where multiple MAs are converging together" },
  { value: "price_above", label: "Price vs MA",      icon: "≥", desc: "Find stocks trading above or below a specific MA" },
  { value: "price_ma_pct", label: "Price-MA % Diff", icon: "%", desc: "Find stocks trading a chosen % above or below a specific MA" },
  { value: "pullback",    label: "Pullback to MA",   icon: "⤵", desc: "Find trending stocks that have just pulled back to touch their MA" },
];

const TIMEFRAMES = [
  { value: "D", label: "Daily" },
  { value: "W", label: "Weekly" },
  { value: "M", label: "Monthly" },
];

const RSI_FILTER_OPTS = [
  { value: "none",     label: "No RSI Filter" },
  { value: "above_50", label: "RSI > 50 (Bullish)" },
  { value: "below_50", label: "RSI < 50 (Bearish)" },
  { value: "above_70", label: "RSI > 70 (Overbought)" },
  { value: "below_30", label: "RSI < 30 (Oversold)" },
];

// ─── Mini Chart Card ─────────────────────────────────────────────────────────
function MiniChartCard({ match, scanType, maType, period1, period2, isBullish, timeframe }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !match.chart_data || match.chart_data.length < 2) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext("2d").scale(dpr, dpr);

    drawMiniChart(canvas, match.chart_data.slice(-40), {
      upColor: "#26a69a",
      downColor: "#ef5350",
      bgColor: "#FFFFFF",
      gridColor: "#EEEEEE",
      borderColor: "#C0C0C0",
      showVolume: true,
      showMA: true,
      maPeriod: period1 || 20,
      maColor: isBullish ? "#FF6600" : "#AA00AA",
    });
  }, [match.chart_data, period1, isBullish]);

  const isUp = (match.change_pct ?? 0) >= 0;

  return (
    <div className="scan-result-card">
      <div className="src-chart-wrap">
        <canvas
          ref={canvasRef}
          className="src-canvas"
          style={{ width: "100%", height: "100%", display: "block" }}
        />
        {(!match.chart_data || match.chart_data.length === 0) && (
          <div className="src-no-chart">No Chart</div>
        )}
      </div>
      <div className="src-info">
        <div className="src-top-row">
          <a href={`/dashboard/charts?symbol=${match.symbol}&tf=${timeframe}`} className="src-symbol">
            {match.symbol}
          </a>
          <span
            className="src-badge"
            style={{ color: isBullish ? "#008000" : "#CC0000" }}
          >
            {isBullish ? "▲ Bull" : "▼ Bear"}
          </span>
        </div>
        {match.name && <div className="src-name">{match.name}</div>}
        {match.sector && <div className="src-sector" style={{ fontSize: "11px", color: "#888", marginTop: "2px", fontWeight: 500 }}>{match.sector}</div>}
        <div className="src-prices">
          {match.close != null && (
            <span className="src-close">
              ₹{match.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            </span>
          )}
          {match.change_pct != null && (
            <span className={`src-change ${isUp ? "src-up" : "src-down"}`}>
              {isUp ? "▲" : "▼"} {Math.abs(match.change_pct).toFixed(2)}%
            </span>
          )}
        </div>
        <div className="src-signal">
          {maType} {period1}
          {scanType === "crossover" ? ` × ${period2}` : ""}
          {scanType === "slope" ? " Slope" : ""}
        </div>
        <div className="src-footer">
          {match.volume != null && (
            <span className="src-vol">
              {match.volume >= 1e6
                ? (match.volume / 1e6).toFixed(1) + "M"
                : (match.volume / 1e3).toFixed(0) + "K"}
            </span>
          )}
          <a href={`/dashboard/charts?symbol=${match.symbol}&tf=${timeframe}`} className="src-chart-link">
            Chart →
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function MaScannerPage() {
  const [scanType, setScanType]   = useState("crossover");
  const [maType, setMaType]       = useState("EMA");
  const [period1, setPeriod1]     = useState(20);
  const [period2, setPeriod2]     = useState(50);
  const [period3, setPeriod3]     = useState(200);
  const [direction, setDirection] = useState("bullish");
  const [timeframe, setTimeframe] = useState("D");
  const [subscription, setSubscription] = useState(null);
  const [premiumUpgradeMessage, setPremiumUpgradeMessage] = useState(null);
  const [rsiFilter, setRsiFilter] = useState("none");
  const [useRsi, setUseRsi]       = useState(false);
  const [pctThreshold, setPctThreshold]         = useState(3);
  const [pullbackTolerance, setPullbackTolerance] = useState(1.5);
  const [pullbackTrendBars, setPullbackTrendBars] = useState(10);
  const [running, setRunning]     = useState(false);
  const [results, setResults]     = useState(null);
  const [error, setError]         = useState(null);
  const [viewMode, setViewMode]   = useState("chart"); // "chart" | "table"
  const [selectedStock, setSelectedStock] = useState(null);
  const [sectors, setSectors]     = useState([]);
  const [selectedSector, setSelectedSector] = useState("all");
  const [indices, setIndices]     = useState([]);
  const [selectedIndex, setSelectedIndex] = useState("all");
  const [chartCache, setChartCache] = useState({});

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
    setRunning(true);
    setError(null);
    setResults(null);
    setChartCache({});
    try {
      const params = {
        scan_type: scanType, ma_type: maType,
        period1, period2, direction, timeframe,
        rsi_filter: useRsi ? rsiFilter : "none",
        sector: selectedSector,
        index: selectedIndex,
      };
      if (scanType === "convergence") params.period3 = period3;
      if (scanType === "price_ma_pct") params.pct_threshold = pctThreshold;
      if (scanType === "pullback") {
        params.pullback_tolerance = pullbackTolerance;
        params.pullback_trend_bars = pullbackTrendBars;
      }
      const data = await api.runMaScanner(params);
      setResults(data);

      // Fetch chart data for first 50 matches (for thumbnails)
      const matches = data.matches?.slice(0, 50) || [];
      const cache = {};
      await Promise.allSettled(
        matches.map(async (m) => {
          try {
            const chartData = await api.getEod(m.symbol);
            cache[m.symbol] = chartData.map((d) => ({
              open: d.open, high: d.high, low: d.low,
              close: d.close, volume: d.volume,
            }));
          } catch (_) { cache[m.symbol] = []; }
        })
      );
      setChartCache(cache);
    } catch (err) {
      if (err.status === 403) {
        setPremiumUpgradeMessage(err.message);
      } else {
        setError(err.message || "Scan failed. Please ensure the backend is running.");
      }
    } finally {
      setRunning(false);
    }
  }

  const exportCSV = () => {
    if (!results?.matches) return;
    const rows = results.matches.map(
      (m) => `${m.symbol},${m.name || ""},${m.close || ""},${m.change_pct || ""},${m.volume || ""}`
    );
    const blob = new Blob([`Symbol,Name,Close,Change%,Volume\n${rows.join("\n")}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ma_scan_results.csv"; a.click();
  };

  const activeScanType = SCAN_TYPES.find((s) => s.value === scanType);
  const isBullish = direction === "bullish";

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>📊 MA Scanner</h1>
          <p className={styles.subtitle}>
            Moving Average Crossover · Slope · Convergence · Price vs MA
          </p>
        </div>
        <div className={styles.headerBadge}>
          <span className={styles.badgeDot} />
          NSE Equity · {TIMEFRAMES.find((t) => t.value === timeframe)?.label}
        </div>
      </div>

      <div className={styles.layout}>
        {/* ─── Controls ─────────────────────────────────── */}
        <div className={styles.controlsPanel}>
          {/* Scan Type */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Scan Type</div>
            <div className={styles.scanTypeGrid}>
              {SCAN_TYPES.map((st) => (
                <button
                  key={st.value}
                  className={`${styles.scanTypeBtn} ${scanType === st.value ? styles.scanTypeBtnActive : ""}`}
                  onClick={() => setScanType(st.value)}
                  id={`scan-type-${st.value}`}
                >
                  <span className={styles.scanTypeIcon}>{st.icon}</span>
                  <span className={styles.scanTypeLabel}>{st.label}</span>
                </button>
              ))}
            </div>
            {activeScanType && (
              <p className={styles.scanTypeDesc}>{activeScanType.desc}</p>
            )}
          </div>

          {/* MA Config */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>MA Configuration</div>
            <div className={styles.paramRow}>
              <label className={styles.paramLabel}>MA Type</label>
              <select className={styles.select} value={maType} onChange={(e) => setMaType(e.target.value)}>
                {MA_TYPES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            {scanType === "crossover" ? (
              <>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Fast MA Period</label>
                  <input type="number" className={styles.numInput} value={period1}
                    onChange={(e) => setPeriod1(Number(e.target.value))} min={1} max={500} id="ma-period1" />
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Slow MA Period</label>
                  <input type="number" className={styles.numInput} value={period2}
                    onChange={(e) => setPeriod2(Number(e.target.value))} min={1} max={500} id="ma-period2" />
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Cross Direction</label>
                  <select className={styles.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
                    <option value="bullish">Bullish Cross (↑ Fast crosses above Slow)</option>
                    <option value="bearish">Bearish Cross (↓ Fast crosses below Slow)</option>
                  </select>
                </div>
              </>
            ) : scanType === "slope" ? (
              <>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>MA Period</label>
                  <input type="number" className={styles.numInput} value={period1}
                    onChange={(e) => setPeriod1(Number(e.target.value))} min={1} max={500} />
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Slope Direction</label>
                  <select className={styles.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
                    <option value="bullish">Rising ↗ (Upward Slope)</option>
                    <option value="bearish">Falling ↘ (Downward Slope)</option>
                  </select>
                </div>
              </>
            ) : scanType === "convergence" ? (
              <>
                {[["Period 1", period1, setPeriod1], ["Period 2", period2, setPeriod2], ["Period 3", period3, setPeriod3]].map(([lbl, val, setter]) => (
                  <div className={styles.paramRow} key={lbl}>
                    <label className={styles.paramLabel}>{lbl}</label>
                    <input type="number" className={styles.numInput} value={val}
                      onChange={(e) => setter(Number(e.target.value))} min={1} max={500} />
                  </div>
                ))}
              </>
            ) : scanType === "price_ma_pct" ? (
              <>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>MA Period</label>
                  <input type="number" className={styles.numInput} value={period1}
                    onChange={(e) => setPeriod1(Number(e.target.value))} min={1} max={500} />
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Direction</label>
                  <select className={styles.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
                    <option value="bullish">Price ≥ X% Above MA</option>
                    <option value="bearish">Price ≥ X% Below MA</option>
                  </select>
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Threshold %</label>
                  <input type="number" className={styles.numInput} value={pctThreshold}
                    onChange={(e) => setPctThreshold(Number(e.target.value))} min={0.1} max={100} step={0.1} />
                </div>
              </>
            ) : scanType === "pullback" ? (
              <>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>MA Period</label>
                  <input type="number" className={styles.numInput} value={period1}
                    onChange={(e) => setPeriod1(Number(e.target.value))} min={1} max={500} />
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Trend Direction</label>
                  <select className={styles.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
                    <option value="bullish">Uptrend Pullback (Buy the Dip)</option>
                    <option value="bearish">Downtrend Pullback (Sell the Rally)</option>
                  </select>
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Prior Trend Bars</label>
                  <input type="number" className={styles.numInput} value={pullbackTrendBars}
                    onChange={(e) => setPullbackTrendBars(Number(e.target.value))} min={3} max={100} />
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Touch Tolerance %</label>
                  <input type="number" className={styles.numInput} value={pullbackTolerance}
                    onChange={(e) => setPullbackTolerance(Number(e.target.value))} min={0.1} max={20} step={0.1} />
                </div>
              </>
            ) : (
              <>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>MA Period</label>
                  <input type="number" className={styles.numInput} value={period1}
                    onChange={(e) => setPeriod1(Number(e.target.value))} min={1} max={500} />
                </div>
                <div className={styles.paramRow}>
                  <label className={styles.paramLabel}>Price Position</label>
                  <select className={styles.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
                    <option value="bullish">Price Above MA (Bullish)</option>
                    <option value="bearish">Price Below MA (Bearish)</option>
                  </select>
                </div>
              </>
            )}
          </div>

          {/* Timeframe */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Timeframe</div>
            <div className={styles.tfRow}>
              {TIMEFRAMES.map((tf) => (
                <button key={tf.value}
                  className={`${styles.tfBtn} ${timeframe === tf.value ? styles.tfBtnActive : ""}`}
                  onClick={() => handleTimeframeChange(tf.value)} id={`tf-${tf.value}`}>
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          {/* Sector Filter */}
          <div className={styles.section}>
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
          <div className={styles.section}>
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

          {/* RSI Filter */}
          <div className={styles.section}>
            <div className={styles.sectionTitleRow}>
              <div className={styles.sectionTitle}>RSI / MACD Filter</div>
              <label className={styles.toggle}>
                <input type="checkbox" checked={useRsi} onChange={(e) => setUseRsi(e.target.checked)} id="rsi-filter-toggle" />
                <span className={styles.toggleSlider} />
              </label>
            </div>
            {useRsi && (
              <select className={styles.select} value={rsiFilter} onChange={(e) => setRsiFilter(e.target.value)} style={{ marginTop: 8 }}>
                {RSI_FILTER_OPTS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            )}
            <p className={styles.hintText}>Mix MA signals with RSI to filter false signals</p>
          </div>

          {/* Preset buttons — like KeyStocks quick-selects */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Quick Presets</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                { label: "SMA 44 Crossover", fn: () => { setMaType("SMA"); setScanType("crossover"); setPeriod1(44); setPeriod2(200); setDirection("bullish"); }},
                { label: "EMA 9×20 Bull Cross", fn: () => { setMaType("EMA"); setScanType("crossover"); setPeriod1(9); setPeriod2(20); setDirection("bullish"); }},
                { label: "Golden Cross (50×200)", fn: () => { setMaType("SMA"); setScanType("crossover"); setPeriod1(50); setPeriod2(200); setDirection("bullish"); }},
                { label: "MA200 Rising Slope",  fn: () => { setMaType("SMA"); setScanType("slope"); setPeriod1(200); setDirection("bullish"); }},
                { label: "Price above EMA 20",  fn: () => { setMaType("EMA"); setScanType("price_above"); setPeriod1(20); setDirection("bullish"); }},
              ].map((p) => (
                <button key={p.label} className={styles.presetBtn} onClick={p.fn}>{p.label}</button>
              ))}
            </div>
          </div>

          {/* Run */}
          <button className={styles.runBtn} onClick={handleScan} disabled={running} id="ma-scan-run-btn">
            {running ? (
              <><span className={styles.spinner} /> Scanning 2000+ NSE Stocks...</>
            ) : (
              <>▶ Run MA Scanner</>
            )}
          </button>
        </div>

        {/* ─── Results ──────────────────────────────────── */}
        <div className={styles.resultsPanel}>
          {!results && !running && !error && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📊</div>
              <h3>Configure &amp; Run MA Scanner</h3>
              <p>Select scan type, set parameters, and click Run to find matching stocks.</p>
              <div className={styles.exampleTags}>
                <span className={styles.exTag}>EMA 20 × EMA 50 Bullish Cross</span>
                <span className={styles.exTag}>SMA 200 Rising Slope</span>
                <span className={styles.exTag}>Price above EMA 20 + RSI &gt; 50</span>
                <span className={styles.exTag}>SMA 44 Crossover</span>
              </div>
            </div>
          )}

          {running && (
            <div className={styles.loadingState}>
              <div className={styles.loadingBar}><div className={styles.loadingFill} /></div>
              <p>Scanning NSE stocks for {activeScanType?.label}...</p>
            </div>
          )}

          {error && (
            <div className={styles.errorState}>
              <span className={styles.errorIcon}>⚠️</span>
              <h3>Scan Error</h3>
              <p>{error}</p>
              <button className={styles.retryBtn} onClick={handleScan}>↺ Retry</button>
            </div>
          )}

          {results && (
            <div className={styles.resultsContainer}>
              {/* Results toolbar */}
              <div className="scan-results-header" style={{ padding: "8px 16px" }}>
                <div>
                  <span className="scan-results-count">
                    {results.count ?? results.matches?.length ?? 0} Stocks Found
                  </span>
                  <ViewAllOnCharts symbols={(results.matches || []).map(m => m.symbol)} label="MA Scanner" style={{ marginLeft: 10 }} />
                  <span className="scan-results-meta" style={{ marginLeft: 12 }}>
                    {activeScanType?.label} · {maType} {period1}
                    {scanType === "crossover" ? `×${period2}` : ""} · {TIMEFRAMES.find((t) => t.value === timeframe)?.label}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div className="scan-view-toggle">
                    <button className={`scan-view-btn ${viewMode === "chart" ? "active" : ""}`}
                      onClick={() => setViewMode("chart")}>⬛ Charts</button>
                    <button className={`scan-view-btn ${viewMode === "table" ? "active" : ""}`}
                      onClick={() => setViewMode("table")}>☰ Table</button>
                  </div>
                  <button className="scan-export-btn" onClick={exportCSV}>↓ CSV</button>
                </div>
              </div>

              {results.matches?.length > 0 ? (
                viewMode === "chart" ? (
                  /* ── CHART GRID VIEW ── */
                  <div className="scan-results-grid" style={{ padding: "8px 16px" }}>
                    {results.matches.map((m, i) => (
                      <MiniChartCard
                        key={i}
                        match={{ ...m, chart_data: chartCache[m.symbol] || [] }}
                        scanType={scanType}
                        maType={maType}
                        period1={period1}
                        period2={period2}
                        isBullish={isBullish}
                        timeframe={timeframe}
                      />
                    ))}
                  </div>
                ) : (
                  /* ── TABLE VIEW ── */
                  <div className={styles.resultsTable}>
                    <div className={styles.tableHead}>
                      <span>Symbol</span>
                      <span>Company</span>
                      <span>Sector</span>
                      <span>Close ₹</span>
                      <span>Change %</span>
                      <span>Volume</span>
                      <span>Action</span>
                    </div>
                    {results.matches.map((m, i) => (
                      <div key={i}
                        className={`${styles.tableRow} ${selectedStock === m.symbol ? styles.tableRowSelected : ""}`}
                        onClick={() => setSelectedStock(m.symbol)}>
                        <span className={styles.symbol}>{m.symbol}</span>
                        <span className={styles.companyName}>{m.name || "—"}</span>
                        <span className={styles.sectorName} style={{ color: "#888", fontSize: "12px" }}>{m.sector || "—"}</span>
                        <span className={styles.price}>
                          ₹{m.close?.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                        </span>
                        <span className={m.change_pct >= 0 ? styles.changeUp : styles.changeDown}>
                          {m.change_pct >= 0 ? "+" : ""}{m.change_pct?.toFixed(2) ?? "—"}%
                        </span>
                        <span className={styles.volume}>
                          {m.volume ? (m.volume / 1000).toFixed(0) + "K" : "—"}
                        </span>
                        <a href={`/dashboard/charts?symbol=${m.symbol}&tf=${timeframe}`} className={styles.chartLink}
                          onClick={(e) => e.stopPropagation()}>
                          Chart →
                        </a>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className={styles.noMatches}>
                  <p>No stocks matched the MA scan criteria.</p>
                  <p className={styles.hint}>Try relaxing the parameters or switching timeframes.</p>
                </div>
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
