"use client";

import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { drawMiniChart } from "@/lib/miniChart";
import styles from "./trendlines.module.css";

// ─── Mini Chart Card for each trendline ─────────────────────────────────────
function TrendlineCard({ tl, chartData }) {
  const canvasRef = useRef(null);
  const isSupport = tl.line_type === "support";

  useEffect(() => {
    if (!canvasRef.current || !chartData || chartData.length < 2) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext("2d").scale(dpr, dpr);
    drawMiniChart(canvas, chartData.slice(-50), {
      upColor: "#26a69a", downColor: "#ef5350", bgColor: "#FFFFFF",
      gridColor: "#EEEEEE", borderColor: "#C0C0C0", showVolume: false,
      showMA: false, maColor: isSupport ? "#008000" : "#CC0000",
      srLevel: tl.point_b_price ? parseFloat(tl.point_b_price) : null,
      srColor: isSupport ? "#008000" : "#CC0000",
    });
  }, [chartData, isSupport, tl.point_b_price]);

  const slope = tl.slope ? parseFloat(tl.slope) : 0;
  const slopeDir = slope > 0 ? "↗" : slope < 0 ? "↘" : "→";
  const slopeColor = slope > 0 ? "#008000" : slope < 0 ? "#CC0000" : "#555";
  const href = `/dashboard/charts?symbol=${tl.symbol}`;

  return (
    <div className="scan-result-card">
      <div className="src-chart-wrap">
        <canvas ref={canvasRef} className="src-canvas"
          style={{ width: "100%", height: "100%", display: "block" }} />
        {(!chartData || chartData.length === 0) && (
          <div className="src-no-chart">No Chart</div>
        )}
        {/* S/R type badge overlaid on chart */}
        <div className={styles.srTypeBadge} style={{
          background: isSupport ? "#008000" : "#CC0000"
        }}>
          {isSupport ? "SUP" : "RES"}
        </div>
      </div>

      <div className="src-info">
        <div className="src-top-row">
          <a href={href} className="src-symbol">{tl.symbol || "—"}</a>
          <span className="src-badge" style={{ fontFamily: "monospace", color: "#555" }}>
            {tl.timeframe}
          </span>
        </div>

        <div className="src-signal" style={{ color: isSupport ? "#007700" : "#CC0000", fontWeight: 700 }}>
          {isSupport ? "⬇ Support Line" : "⬆ Resistance Line"}
        </div>

        <div className="src-prices">
          {tl.point_a_price && (
            <span className="src-close" style={{ fontSize: "0.75rem" }}>
              A: ₹{parseFloat(tl.point_a_price).toFixed(2)}
            </span>
          )}
          {tl.point_b_price && (
            <span className="src-close" style={{ fontSize: "0.75rem", marginLeft: 6 }}>
              B: ₹{parseFloat(tl.point_b_price).toFixed(2)}
            </span>
          )}
        </div>

        <div className="src-footer">
          <span style={{ color: slopeColor, fontWeight: 700, fontSize: "0.72rem" }}>
            {slopeDir} {Math.abs(slope).toFixed(3)}
          </span>
          <span className="src-vol" style={{ color: "#555" }}>
            {tl.touches ? `${tl.touches} touches` : ""}
          </span>
          <a href={href} className="src-chart-link">Chart →</a>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function TrendlinesPage() {
  const [trendlines, setTrendlines] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [symbolFilter, setSymbolFilter] = useState("");
  const [lineType, setLineType] = useState("all");    // all | support | resistance
  const [timeframe, setTimeframe] = useState("D");
  const [viewMode, setViewMode] = useState("chart");
  const [chartCache, setChartCache] = useState({});

  useEffect(() => { loadTrendlines(); }, [lineType, timeframe]);

  async function loadTrendlines() {
    setLoading(true);
    setChartCache({});
    try {
      const params = { active_only: true, limit: 100, timeframe };
      if (symbolFilter.trim()) params.symbol = symbolFilter.trim().toUpperCase();
      if (lineType !== "all") params.line_type = lineType;
      const data = await api.listTrendlines(params);
      setTrendlines(data);

      // Parallel mini-chart fetch
      const cache = {};
      await Promise.allSettled(
        (data || []).slice(0, 80).map(async (tl) => {
          if (!tl.symbol || cache[tl.symbol] !== undefined) return;
          try {
            const eod = await api.getEod(tl.symbol);
            cache[tl.symbol] = eod.map((d) => ({
              open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume
            }));
          } catch (_) { cache[tl.symbol] = []; }
        })
      );
      setChartCache(cache);
    } catch (err) {
      console.error("Error loading trendlines:", err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e) {
    e.preventDefault();
    loadTrendlines();
  }

  const exportCSV = () => {
    if (!trendlines.length) return;
    const rows = trendlines.map(tl =>
      `${tl.symbol},${tl.line_type},${tl.timeframe},${tl.point_a_price || ""},${tl.point_b_price || ""},${tl.slope || ""},${tl.touches || ""}`
    ).join("\n");
    const blob = new Blob([`Symbol,Type,Timeframe,PointA,PointB,Slope,Touches\n${rows}`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "trendlines.csv"; a.click();
  };

  return (
    <div className={styles.trendlinesPage}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>📐 Auto S/R Scanner</h1>
          <p className={styles.pageSubtitle}>
            Automated Support &amp; Resistance trendlines detected across NSE stocks
          </p>
        </div>
        <button className={styles.triggerBtn} onClick={() => api.triggerScan().catch(() => {})}>
          ▶ Trigger Scan
        </button>
      </div>

      {/* Filter bar */}
      <div className={styles.filterBar}>
        {/* Symbol search */}
        <form className={styles.searchForm} onSubmit={handleSearch}>
          <input
            className={styles.searchInput}
            placeholder="Symbol e.g. RELIANCE"
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())}
            id="trendline-search"
          />
          <button className={styles.searchBtn} type="submit">Search</button>
          {symbolFilter && (
            <button className={styles.clearBtn} type="button"
              onClick={() => { setSymbolFilter(""); setTimeout(loadTrendlines, 80); }}>
              ✕
            </button>
          )}
        </form>

        {/* Line type filter */}
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Type</label>
          <div className={styles.typeRow}>
            {[["all", "All"], ["support", "Support ⬇"], ["resistance", "Resistance ⬆"]].map(([v, l]) => (
              <button key={v}
                className={`${styles.typeBtn} ${lineType === v ? styles.typeBtnActive : ""}`}
                onClick={() => setLineType(v)}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Timeframe */}
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Timeframe</label>
          <div className={styles.typeRow}>
            {[["D", "Daily"], ["W", "Weekly"], ["M", "Monthly"]].map(([v, l]) => (
              <button key={v}
                className={`${styles.typeBtn} ${timeframe === v ? styles.typeBtnActive : ""}`}
                onClick={() => setTimeframe(v)}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results header */}
      <div className="scan-results-header" style={{ padding: "6px 0 12px" }}>
        <div>
          <span className="scan-results-count">
            {trendlines.length} trendline{trendlines.length !== 1 ? "s" : ""} found
          </span>
          <span className="scan-results-meta" style={{ marginLeft: 12 }}>
            {lineType === "all" ? "Support & Resistance" : lineType === "support" ? "Support Lines" : "Resistance Lines"}
            {" · "}{timeframe === "D" ? "Daily" : timeframe === "W" ? "Weekly" : "Monthly"}
          </span>
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

      {/* Content */}
      {loading ? (
        <div className={styles.skeletonGrid}>
          {[1,2,3,4,5,6,7,8].map((i) => <div key={i} className={styles.skeletonCard} />)}
        </div>
      ) : trendlines.length > 0 ? (
        viewMode === "chart" ? (
          <div className="scan-results-grid">
            {trendlines.map((tl, i) => (
              <TrendlineCard key={tl.id || i} tl={tl} chartData={chartCache[tl.symbol] || []} />
            ))}
          </div>
        ) : (
          /* ─── TABLE VIEW ─── */
          <div className={styles.tableWrap}>
            <div className={styles.tableHead}>
              <span>Symbol</span>
              <span>Type</span>
              <span>Timeframe</span>
              <span>Point A ₹</span>
              <span>Point B ₹</span>
              <span>Slope</span>
              <span>Touches</span>
              <span>Chart</span>
            </div>
            {trendlines.map((tl) => (
              <div key={tl.id} className={styles.tableRow}>
                <span className={styles.tSymbol}>{tl.symbol || "—"}</span>
                <span>
                  <span className={`badge ${tl.line_type === "support" ? "badge-green" : "badge-red"}`}>
                    {tl.line_type}
                  </span>
                </span>
                <span className={styles.tMono}>{tl.timeframe}</span>
                <span className={styles.tMono}>
                  {tl.point_a_price ? `₹${parseFloat(tl.point_a_price).toFixed(2)}` : "—"}
                  {tl.point_a_time && (
                    <span className={styles.cellDate}> {new Date(tl.point_a_time).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                  )}
                </span>
                <span className={styles.tMono}>
                  {tl.point_b_price ? `₹${parseFloat(tl.point_b_price).toFixed(2)}` : "—"}
                  {tl.point_b_time && (
                    <span className={styles.cellDate}> {new Date(tl.point_b_time).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                  )}
                </span>
                <span className={styles.tMono} style={{ color: parseFloat(tl.slope) > 0 ? "#007700" : "#CC0000" }}>
                  {tl.slope ? parseFloat(tl.slope).toFixed(4) : "—"}
                </span>
                <span className={styles.tMono}>{tl.touches ?? "—"}</span>
                <a href={`/dashboard/charts?symbol=${tl.symbol}`} className={styles.tLink}>Chart →</a>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>📐</span>
          <h3>No trendlines found</h3>
          <p>Trendlines will appear after market data is ingested and scanned.</p>
          <button className={styles.triggerBtn2} onClick={() => api.triggerScan().catch(() => {})}>
            ▶ Trigger Scan Now
          </button>
        </div>
      )}
    </div>
  );
}
