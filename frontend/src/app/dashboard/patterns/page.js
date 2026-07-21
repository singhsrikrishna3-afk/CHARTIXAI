"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { drawMiniChart } from "@/lib/miniChart";
import styles from "./patterns.module.css";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

const PATTERN_TYPES = [
  "all", "double_top", "double_bottom", "triple_top", "triple_bottom",
  "head_shoulders", "inv_head_shoulders", "asc_triangle", "desc_triangle",
  "sym_triangle", "rising_wedge", "falling_wedge", "bull_flag", "bear_flag",
  "pennant", "rectangle", "wolfe_wave", "harmonic", "abc_pattern", "ew_4th_wave"
];

const STATUS_OPTIONS = ["forming", "completed", "all"];

const PATTERN_ICONS = {
  double_top: "🔻", double_bottom: "🔺", triple_top: "🔻🔻", triple_bottom: "🔺🔺",
  head_shoulders: "👤", inv_head_shoulders: "👤", asc_triangle: "△",
  desc_triangle: "▽", sym_triangle: "◇", rising_wedge: "⬆", falling_wedge: "⬇",
  bull_flag: "🏁", bear_flag: "🏴", pennant: "🚩", rectangle: "▬",
  wolfe_wave: "🌊", harmonic: "🎵", abc_pattern: "⚡", ew_4th_wave: "🏄",
};

const BEARISH_PATTERNS = new Set([
  "double_top", "triple_top", "head_shoulders", "desc_triangle",
  "rising_wedge", "bear_flag"
]);

function humanizeBreakdownKey(key) {
  return key.replace(/_/g, " ").replace(/\bfib\b/g, "Fibonacci").replace(/^./, (c) => c.toUpperCase());
}

// ─── Confidence + breakdown tooltip ───────────────────────────────────────────
// Two possible sources for the headline number:
//   "backtested"   — an empirical win rate measured by walking every past
//                     occurrence of this pattern type + fit-quality tier
//                     forward to see whether target_price or stop_loss was
//                     hit first. This is the real number whenever enough
//                     history exists for that bucket.
//   "geometric_fit" — a heuristic blend of shape sub-scores (price-level
//                     fit, symmetry, volume confirmation, etc.), used only
//                     as a fallback for pattern types/buckets that don't
//                     have a backtest yet.
//
// Rendered through a portal into document.body with a JS-measured fixed
// position: the pattern cards have `overflow: hidden` (for the mini-chart
// thumbnail's rounded corners) which would otherwise clip a tooltip that's
// wider than the card itself.
function ConfidenceBadge({ confidence, breakdown, source }) {
  const conf = confidence != null ? `${(confidence * 100).toFixed(0)}%` : "—";
  const entries = breakdown && typeof breakdown === "object" ? Object.entries(breakdown) : [];
  const triggerRef = useRef(null);
  const [pos, setPos] = useState(null);

  if (entries.length === 0) {
    return <span>{conf}</span>;
  }

  const showTooltip = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 220;
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    setPos({ top: rect.top - 8, left: Math.max(8, left), width });
  };
  const hideTooltip = () => setPos(null);

  return (
    <span
      ref={triggerRef}
      className={styles.confWrap}
      tabIndex={0}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {conf}
      <span style={{ fontSize: "0.65rem", color: "#999" }}>ⓘ</span>
      {pos && createPortal(
        <div
          className={styles.confTooltip}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, transform: "translateY(-100%)" }}
        >
          <div className={styles.confTooltipTitle}>
            {source === "backtested" ? "Historical win rate" : "Why this score"}
          </div>
          {entries.map(([key, value]) => (
            <div className={styles.confTooltipRow} key={key}>
              <span>{humanizeBreakdownKey(key)}</span>
              <span>{key === "sample_size" ? `n=${value.toLocaleString("en-IN")}` : `${Math.round(value * 100)}%`}</span>
            </div>
          ))}
          <div className={styles.confTooltipNote}>
            {source === "backtested"
              ? "Measured from real past occurrences of this pattern + fit tier — not a guarantee of future results."
              : "Geometric fit only — not yet backtested for this pattern type."}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}

// ─── Mini chart + pattern card ────────────────────────────────────────────────
function PatternCard({ p, chartData, timeframe }) {
  const canvasRef = useRef(null);
  const isBearish = BEARISH_PATTERNS.has(p.pattern_type);

  useEffect(() => {
    if (!canvasRef.current || !chartData || chartData.length < 2) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext("2d").scale(dpr, dpr);
    drawMiniChart(canvas, chartData.slice(-40), {
      upColor: "#26a69a", downColor: "#ef5350", bgColor: "#FFFFFF",
      gridColor: "#EEEEEE", borderColor: "#C0C0C0", showVolume: true,
      showMA: true, maPeriod: 20,
      maColor: isBearish ? "#AA00AA" : "#FF6600",
    });
  }, [chartData, isBearish]);

  const href = `/dashboard/charts?symbol=${p.symbol}&pattern=${p.id}&tf=${timeframe}`;

  return (
    <div className="scan-result-card" style={{ minHeight: 0 }}>
      {/* Mini chart thumbnail */}
      <div className="src-chart-wrap" style={{ height: 100 }}>
        <canvas ref={canvasRef} className="src-canvas"
          style={{ width: "100%", height: "100%", display: "block" }} />
        {(!chartData || chartData.length === 0) && (
          <div className="src-no-chart">No Data</div>
        )}
      </div>

      <div className="src-info">
        <div className="src-top-row">
          <a href={href} className="src-symbol">{p.symbol || "—"}</a>
          <span className={`badge ${p.status === "completed" ? "badge-green" : "badge-blue"}`}>
            {p.status}
          </span>
        </div>
        {p.sector && <div className="src-sector" style={{ fontSize: "11px", color: "#888", marginTop: "2px", fontWeight: 500 }}>{p.sector}</div>}

        <div className="src-signal" style={{ color: isBearish ? "#CC0000" : "#007700", fontWeight: 700 }}>
          {PATTERN_ICONS[p.pattern_type] || "🔮"}{" "}
          {p.pattern_type?.replace(/_/g, " ")}
        </div>

        <div className="src-prices">
          {p.target_price && (
            <span className="src-close" style={{ fontSize: "0.7rem", color: "#007700" }}>
              T: ₹{p.target_price.toLocaleString("en-IN")}
            </span>
          )}
          {p.stop_loss && (
            <span className="src-change src-down" style={{ fontSize: "0.68rem" }}>
              SL: ₹{p.stop_loss.toLocaleString("en-IN")}
            </span>
          )}
        </div>

        <div className="src-footer">
          <span className="src-conf">
            Conf: <ConfidenceBadge confidence={p.confidence} breakdown={p.key_points?.confidence_breakdown} source={p.key_points?.confidence_source} />
          </span>
          <span className="src-vol" style={{ color: "#555" }}>
            {new Date(p.detection_time).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
          </span>
          <a href={href} className="src-chart-link">Chart →</a>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function PatternsPage() {
  const [patterns, setPatterns] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState({ type: "all", status: "forming", timeframe: "D", sector: "all", index: "all" });
  const [subscription, setSubscription] = useState(null);
  const [premiumUpgradeMessage, setPremiumUpgradeMessage] = useState(null);
  const [viewMode, setViewMode] = useState("chart");  // "chart" | "table"
  const [chartCache, setChartCache] = useState({});
  const [sectors, setSectors]     = useState([]);
  const [indices, setIndices]     = useState([]);

  useEffect(() => {
    api.listSectors().then(data => setSectors(data || [])).catch(() => {});
    api.listIndices().then(data => setIndices(data || [])).catch(() => {});
    api.getSubscription().then(data => setSubscription(data)).catch(() => {});
  }, []);


  useEffect(() => { loadPatterns(); }, [filter]);

  async function loadPatterns() {
    setLoading(true);
    setChartCache({});
    try {
      const params = { limit: 100 };
      if (filter.type !== "all") params.pattern_type = filter.type;
      if (filter.status !== "all") params.status = filter.status;
      if (filter.sector !== "all") params.sector = filter.sector;
      if (filter.index !== "all") params.index = filter.index;
      params.timeframe = filter.timeframe;
      const data = await api.listPatterns(params);
      setPatterns(data);

      // Fetch mini-chart data in parallel
      const cache = {};
      await Promise.allSettled(
        (data || []).slice(0, 80).map(async (p) => {
          if (!p.symbol) return;
          try {
            const eod = await api.getEod(p.symbol);
            cache[p.symbol] = eod.map((d) => ({ open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
          } catch (_) { cache[p.symbol] = []; }
        })
      );
      setChartCache(cache);
    } catch (err) {
      if (err.status === 403) {
        setPremiumUpgradeMessage(err.message);
      } else {
        console.error("Error loading patterns:", err);
      }
    } finally {
      setLoading(false);
    }
  }

  const exportCSV = () => {
    if (!patterns.length) return;
    const rows = patterns.map(p =>
      `${p.symbol},${p.pattern_type?.replace(/_/g," ")},${p.status},${p.confidence ? (p.confidence*100).toFixed(0)+"%" : ""},${p.target_price || ""},${p.stop_loss || ""}`
    ).join("\n");
    const blob = new Blob([`Symbol,Pattern,Status,Confidence,Target,StopLoss\n${rows}`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "patterns.csv"; a.click();
  };

  return (
    <div className={styles.patternsPage}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>🔮 Pattern Screener</h1>
          <p className={styles.pageSubtitle}>
            Detected chart patterns across NSE stocks — Head &amp; Shoulders, Double Top/Bottom, Triangles, Flags &amp; more
          </p>
        </div>
        <button className={styles.triggerScanBtn} onClick={() => api.triggerScan().catch(() => {})}>
          ▶ Trigger Scan
        </button>
      </div>

      {/* Filters bar */}
      <div className={styles.filtersBar}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Pattern Type</label>
          <select className={styles.filterSelect} value={filter.type}
            onChange={(e) => setFilter({ ...filter, type: e.target.value })} id="filter-pattern-type">
            {PATTERN_TYPES.map((t) => (
              <option key={t} value={t}>{t === "all" ? "All Patterns" : t.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Sector</label>
          <select className={styles.filterSelect} value={filter.sector}
            onChange={(e) => setFilter({ ...filter, sector: e.target.value })} id="filter-sector">
            <option value="all">All Sectors</option>
            {sectors.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Index</label>
          <select className={styles.filterSelect} value={filter.index}
            onChange={(e) => setFilter({ ...filter, index: e.target.value })} id="filter-index">
            <option value="all">All Indices</option>
            {indices.map((idx) => (
              <option key={idx.symbol} value={idx.symbol}>{idx.name}</option>
            ))}
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Status</label>
          <select className={styles.filterSelect} value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })} id="filter-status">
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Timeframe</label>
          <select className={styles.filterSelect} value={filter.timeframe}
            onChange={(e) => {
              const val = e.target.value;
              const tier = subscription?.tier?.toLowerCase() || "free";
              if (["free", "eod_basic"].includes(tier) && ["W", "M"].includes(val)) {
                setPremiumUpgradeMessage("Weekly and Monthly pattern screening are only available on the EOD Pro plan. Please upgrade your plan.");
                return;
              }
              setFilter({ ...filter, timeframe: val });
            }} id="filter-timeframe">
            <option value="D">Daily</option>
            <option value="W">Weekly</option>
            <option value="M">Monthly</option>
          </select>
        </div>
        <button className="btn btn-outline" onClick={loadPatterns}
          style={{ alignSelf: "flex-end" }} id="refresh-patterns">
          ↻ Refresh
        </button>
      </div>

      {/* Quick-filter pattern group chips */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
        {[
          { label: "All", value: "all" },
          { label: "🔻 Double Top/Bottom", value: "double_top" },
          { label: "👤 Head & Shoulders", value: "head_shoulders" },
          { label: "△ Triangles", value: "asc_triangle" },
          { label: "🏁 Flags & Pennants", value: "bull_flag" },
          { label: "🎵 Harmonic", value: "harmonic" },
          { label: "🌊 Wolfe Waves", value: "wolfe_wave" },
          { label: "⚡ AB=CD", value: "abc_pattern" },
          { label: "🏄 Elliott W4", value: "ew_4th_wave" },
        ].map(chip => (
          <button
            key={chip.value}
            onClick={() => setFilter({ ...filter, type: chip.value })}
            style={{
              padding: "6px 14px",
              fontSize: "0.76rem",
              fontFamily: "var(--font-sans)",
              fontWeight: filter.type === chip.value ? "600" : "400",
              background: filter.type === chip.value ? "var(--accent-primary)" : "var(--bg-secondary)",
              color: filter.type === chip.value ? "#FFFFFF" : "var(--text-secondary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-full)",
              cursor: "pointer",
              transition: "all 0.2s var(--ease-smooth)",
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Results section */}
      <div className={styles.resultsSection}>
        <div className="scan-results-header" style={{ padding: "6px 0 10px" }}>
          <div>
            <span className="scan-results-count">
              {patterns.length} pattern{patterns.length !== 1 ? "s" : ""} found
            </span>
            <ViewAllOnCharts symbols={patterns.map(p => p.symbol)} label="Pattern Screener" style={{ marginLeft: 10 }} />
            {!loading && (
              <span className="scan-results-meta" style={{ marginLeft: 12 }}>
                {filter.type === "all" ? "All types" : filter.type.replace(/_/g, " ")}
                {" · "}{filter.timeframe === "D" ? "Daily" : filter.timeframe === "W" ? "Weekly" : "Monthly"}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="scan-view-toggle">
              <button className={`scan-view-btn ${viewMode === "chart" ? "active" : ""}`}
                onClick={() => setViewMode("chart")}>⬛ Charts</button>
              <button className={`scan-view-btn ${viewMode === "table" ? "active" : ""}`}
                onClick={() => setViewMode("table")}>☰ Table</button>
            </div>
            <button className="scan-export-btn" onClick={exportCSV}>↓ CSV</button>
          </div>
        </div>

        {loading ? (
          <div className={styles.gridSkeleton}>
            {[1,2,3,4,5,6,7,8].map((i) => <div key={i} className={styles.skeletonCard} />)}
          </div>
        ) : patterns.length > 0 ? (
          viewMode === "chart" ? (
            /* ─── CHART GRID (KeyStocks signature look) ─── */
            <div className="scan-results-grid">
              {patterns.map((p, i) => (
                <PatternCard key={i} p={p} chartData={chartCache[p.symbol] || []} timeframe={filter.timeframe} />
              ))}
            </div>
          ) : (
            /* ─── TABLE VIEW ─── */
            <div className={styles.tableWrap}>
              <div className={styles.tableHead}>
                <span>Symbol</span><span>Pattern</span><span>Sector</span><span>Status</span>
                <span>Confidence</span><span>Target ₹</span><span>Stop Loss ₹</span>
                <span>Detected</span><span>Chart</span>
              </div>
              {patterns.map((p, i) => {
                const isBearish = BEARISH_PATTERNS.has(p.pattern_type);
                return (
                  <div key={i} className={styles.tableRow}>
                    <span className={styles.tSymbol}>{p.symbol}</span>
                    <span className={isBearish ? styles.bearish : styles.bullish}>
                      {PATTERN_ICONS[p.pattern_type] || "🔮"}{" "}
                      {p.pattern_type?.replace(/_/g, " ")}
                    </span>
                    <span style={{ color: "#888", fontSize: "12px" }}>{p.sector || "—"}</span>
                    <span>
                      <span className={`badge ${p.status === "completed" ? "badge-green" : "badge-blue"}`}>
                        {p.status}
                      </span>
                    </span>
                    <span className={styles.tConf}>
                      <ConfidenceBadge confidence={p.confidence} breakdown={p.key_points?.confidence_breakdown} source={p.key_points?.confidence_source} />
                    </span>
                    <span className={styles.tMono}>
                      {p.target_price ? `₹${p.target_price.toLocaleString("en-IN")}` : "—"}
                    </span>
                    <span className={styles.tMono}>
                      {p.stop_loss ? `₹${p.stop_loss.toLocaleString("en-IN")}` : "—"}
                    </span>
                    <span className={styles.tDate}>
                      {new Date(p.detection_time).toLocaleDateString("en-IN")}
                    </span>
                    <a href={`/dashboard/charts?symbol=${p.symbol}&pattern=${p.id}&tf=${filter.timeframe}`} className={styles.tLink}>
                      Chart →
                    </a>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>🔮</span>
            <h3>No patterns found</h3>
            <p>Try adjusting filters or trigger a new scan cycle.</p>
            <button className={styles.triggerScanBtn2} onClick={() => api.triggerScan().catch(() => {})}>
              ▶ Trigger Scan Now
            </button>
          </div>
        )}
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
