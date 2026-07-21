"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
import styles from "./replay.module.css";

const CHART_TYPES = [
  { id: "candles", label: "Candles", icon: "🕯" },
  { id: "bars", label: "Bars", icon: "𝄩" },
  { id: "heikin_ashi", label: "Heikin Ashi", icon: "🕯" },
  { id: "line", label: "Line", icon: "╱" },
  { id: "area", label: "Area", icon: "◢" },
];

function toHeikinAshi(data) {
  const out = [];
  let prevOpen = null, prevClose = null;
  for (const d of data) {
    const haClose = (d.open + d.high + d.low + d.close) / 4;
    const haOpen = prevOpen === null ? (d.open + d.close) / 2 : (prevOpen + prevClose) / 2;
    out.push({
      time: d.time,
      open: haOpen,
      high: Math.max(d.high, haOpen, haClose),
      low: Math.min(d.low, haOpen, haClose),
      close: haClose,
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

export default function ReplayPage() {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const candleSeriesRef = useRef(null);

  const [symbol, setSymbol] = useState("RELIANCE");
  const [symbolInput, setSymbolInput] = useState("RELIANCE");
  const [chartType, setChartType] = useState("candles");
  const chartTypeRef = useRef("candles");
  useEffect(() => { chartTypeRef.current = chartType; }, [chartType]);
  const [indicators, setIndicators] = useState("sma:20,rsi:14");
  const [frames, setFrames] = useState([]);
  const [repaintChecks, setRepaintChecks] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);
  const markersApiRef = useRef(null);

  // Session setup: window length + random-period mode (practice without hindsight)
  const [windowBars, setWindowBars] = useState(250);
  const [randomStart, setRandomStart] = useState(false);
  const [rollNonce, setRollNonce] = useState(0);
  const [period, setPeriod] = useState(null);

  // Practice trading (client-side simulator on the replay)
  const [position, setPosition] = useState(null); // {side, entry, entryIdx, entryTime}
  const [trades, setTrades] = useState([]);       // closed practice trades

  // Load replay data
  const loadReplay = useCallback(async () => {
    setLoading(true);
    setError("");
    setIsPlaying(false);
    setCurrentIndex(0);
    setPosition(null);
    setTrades([]);
    clearInterval(intervalRef.current);

    try {
      const data = await api.getReplay(symbol, 60, 1, indicators, windowBars, randomStart);
      setFrames(data.frames || []);
      setRepaintChecks(data.repaint_checks || []);
      setPeriod(data.period || null);
    } catch (err) {
      setError(err.message || "Failed to load replay data");
      setFrames([]);
    } finally {
      setLoading(false);
    }
  }, [symbol, indicators, windowBars, randomStart, rollNonce]);

  useEffect(() => {
    loadReplay();
    return () => clearInterval(intervalRef.current);
  }, [loadReplay]);

  // Initialize chart
  useEffect(() => {
    if (!chartRef.current || frames.length === 0) return;

    const initChart = async () => {
      const { createChart, ColorType, CandlestickSeries, BarSeries, LineSeries, AreaSeries, createSeriesMarkers } = await import("lightweight-charts");

      if (chartInstance.current) chartInstance.current.remove();

      const chart = createChart(chartRef.current, {
        width: chartRef.current.clientWidth,
        height: 480,
        layout: {
          background: { type: ColorType.Solid, color: "#131722" },
          textColor: "#d1d5db",
          fontFamily: "'Inter', 'Segoe UI', 'Arial', sans-serif",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "#1e2230" },
          horzLines: { color: "#1e2230" },
        },
        rightPriceScale: { borderColor: "#2a2e39" },
        timeScale: { borderColor: "#2a2e39", timeVisible: false },
      });

      chartInstance.current = chart;

      let series;
      if (chartType === "bars") {
        series = chart.addSeries(BarSeries, {
          upColor: "#26a69a",
          downColor: "#ef5350",
          thinBars: false,
        });
      } else if (chartType === "line") {
        series = chart.addSeries(LineSeries, {
          color: "#2962ff",
          lineWidth: 2,
        });
      } else if (chartType === "area") {
        series = chart.addSeries(AreaSeries, {
          lineColor: "#2962ff",
          topColor: "rgba(41,98,255,0.3)",
          bottomColor: "rgba(41,98,255,0.02)",
          lineWidth: 2,
        });
      } else {
        // candles + heikin_ashi both use candlestick series
        series = chart.addSeries(CandlestickSeries, {
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderUpColor: "#26a69a",
          borderDownColor: "#ef5350",
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350",
        });
      }

      candleSeriesRef.current = series;
      try { markersApiRef.current = createSeriesMarkers(series, []); } catch (e) { markersApiRef.current = null; }

      // Set initial data (preserve position when switching chart type mid-replay)
      updateChartToIndex(currentIndex, series, chart);

      const handleResize = () => {
        if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
      };
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    };

    initChart();
  }, [frames, chartType]);

  // Update chart when index changes
  useEffect(() => {
    if (candleSeriesRef.current && frames.length > 0) {
      updateChartToIndex(currentIndex, candleSeriesRef.current, chartInstance.current);
    }
  }, [currentIndex]);

  function updateChartToIndex(index, candleSeries, chart) {
    const visibleFrames = frames.slice(0, index + 1);
    let data = visibleFrames.map((f) => ({
      time: f.time?.split("T")[0] || f.time,
      open: f.ohlcv.open,
      high: f.ohlcv.high,
      low: f.ohlcv.low,
      close: f.ohlcv.close,
    }));
    const type = chartTypeRef.current;
    if (type === "heikin_ashi") {
      data = toHeikinAshi(data);
    } else if (type === "line" || type === "area") {
      data = data.map((d) => ({ time: d.time, value: d.close }));
    }
    candleSeries.setData(data);
    if (chart) {
      // lightweight-charts stretches bars to fill the full width when very
      // few are visible — fitContent() on 1-2 bars renders a giant candle.
      // Use fixed spacing until there's a sane number of bars to fit.
      if (data.length >= 20) {
        chart.timeScale().fitContent();
      } else {
        chart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 5 });
      }
    }
  }

  // ── Practice trading: buy/short/close at the current bar's close ──
  const curFrame = frames[currentIndex] || null;
  const curClose = curFrame ? curFrame.ohlcv.close : null;
  const t10 = (t) => String(t || "").split("T")[0];

  function openPos(side) {
    if (!curClose || position) return;
    setPosition({ side, entry: curClose, entryIdx: currentIndex, entryTime: t10(curFrame.time) });
  }
  function closePos() {
    if (!position || !curClose) return;
    const dir = position.side === "long" ? 1 : -1;
    const pnlPct = (curClose / position.entry - 1) * 100 * dir;
    setTrades((t) => [...t, {
      ...position, exit: curClose, exitTime: t10(curFrame.time),
      pnlPct, bars: currentIndex - position.entryIdx,
    }]);
    setPosition(null);
  }
  const unrealizedPct = position && curClose
    ? (curClose / position.entry - 1) * 100 * (position.side === "long" ? 1 : -1)
    : null;
  const sessionStats = (() => {
    const wins = trades.filter((t) => t.pnlPct > 0).length;
    const total = trades.reduce((a, t) => a + t.pnlPct, 0);
    return { n: trades.length, wins, total };
  })();

  // Draw entry/exit markers on the chart (only up to the visible bar)
  useEffect(() => {
    if (!markersApiRef.current) return;
    const upTo = t10(curFrame?.time);
    const mk = [];
    for (const t of trades) {
      if (t.entryTime <= upTo) mk.push({
        time: t.entryTime, position: t.side === "long" ? "belowBar" : "aboveBar",
        color: t.side === "long" ? "#10b981" : "#ef4444",
        shape: t.side === "long" ? "arrowUp" : "arrowDown",
        text: t.side === "long" ? "BUY" : "SHORT",
      });
      if (t.exitTime <= upTo) mk.push({
        time: t.exitTime, position: "aboveBar", color: "#f59e0b", shape: "circle",
        text: `EXIT ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%`,
      });
    }
    if (position && position.entryTime <= upTo) mk.push({
      time: position.entryTime, position: position.side === "long" ? "belowBar" : "aboveBar",
      color: position.side === "long" ? "#10b981" : "#ef4444",
      shape: position.side === "long" ? "arrowUp" : "arrowDown",
      text: position.side === "long" ? "BUY" : "SHORT",
    });
    mk.sort((a, b) => (a.time < b.time ? -1 : 1));
    try { markersApiRef.current.setMarkers(mk); } catch (e) {}
  }, [trades, position, currentIndex, frames]);

  // Keyboard: Space play/pause · ←/→ step · B buy · S short · C close
  useEffect(() => {
    const h = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); isPlaying ? pause() : play(); }
      else if (e.key === "ArrowRight") stepForward();
      else if (e.key === "ArrowLeft") stepBackward();
      else if (e.key === "b" || e.key === "B") openPos("long");
      else if (e.key === "s" || e.key === "S") openPos("short");
      else if (e.key === "c" || e.key === "C") closePos();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // Playback controls
  function play() {
    if (currentIndex >= frames.length - 1) setCurrentIndex(0);
    setIsPlaying(true);
  }

  function pause() {
    setIsPlaying(false);
    clearInterval(intervalRef.current);
  }

  function stepForward() {
    setCurrentIndex((prev) => Math.min(prev + 1, frames.length - 1));
  }

  function stepBackward() {
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  }

  function reset() {
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    setCurrentIndex(0);
  }

  // Auto-play effect
  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(() => {
        setCurrentIndex((prev) => {
          if (prev >= frames.length - 1) {
            setIsPlaying(false);
            clearInterval(intervalRef.current);
            return prev;
          }
          return prev + 1;
        });
      }, playSpeed);
    }
    return () => clearInterval(intervalRef.current);
  }, [isPlaying, playSpeed, frames.length]);

  const currentFrame = frames[currentIndex] || null;

  return (
    <div className={styles.replayPage}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>⏪ Bar Replay</h1>
        <p className={styles.pageSubtitle}>
          Visual backtesting — step through historical bars
        </p>
      </div>

      {/* Controls */}
      <div className={styles.controlsBar}>
        <div className={styles.symbolControls}>
          <input
            className={styles.symbolInput}
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="Symbol"
            id="replay-symbol"
          />
          <input
            className={styles.indicatorInput}
            value={indicators}
            onChange={(e) => setIndicators(e.target.value)}
            placeholder="sma:20,rsi:14"
          />
          <select
            value={windowBars}
            onChange={(e) => setWindowBars(parseInt(e.target.value))}
            title="Replay length"
            style={{ background: "var(--input-bg, #131722)", color: "var(--text-primary,#e5e7eb)",
                     border: "1px solid var(--border-default,#444)", borderRadius: 6, padding: "0 8px", height: 34 }}
          >
            <option value={100}>100 bars</option>
            <option value={250}>250 bars</option>
            <option value={500}>500 bars</option>
          </select>
          <button
            className="btn btn-primary"
            onClick={() => { setRandomStart(false); setSymbol(symbolInput); setRollNonce(n => n + 1); }}
            style={{ padding: "8px 14px", fontSize: "0.85rem" }}
          >
            Load Latest
          </button>
          <button
            onClick={() => { setRandomStart(true); setSymbol(symbolInput); setRollNonce(n => n + 1); }}
            title="Drop into a random point in history — practice with no hindsight"
            style={{ padding: "8px 14px", fontSize: "0.85rem", background: "#7c3aed", color: "#fff",
                     border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer" }}
          >
            🎲 Random Period
          </button>
        </div>

        {/* Chart type selector */}
        <div style={{
          display: "flex", border: "1px solid var(--border-default, #444)", borderRadius: 6,
          overflow: "hidden", height: 34, alignItems: "stretch", flexShrink: 0,
        }}>
          {CHART_TYPES.map((ct, i) => (
            <button
              key={ct.id}
              onClick={() => setChartType(ct.id)}
              title={ct.label}
              style={{
                border: "none",
                borderRight: i < CHART_TYPES.length - 1 ? "1px solid var(--border-default, #444)" : "none",
                background: chartType === ct.id ? "#2962ff" : "transparent",
                color: chartType === ct.id ? "#fff" : "var(--text-primary, #ccc)",
                padding: "0 10px", fontSize: "0.75rem",
                fontWeight: chartType === ct.id ? 700 : 400,
                cursor: "pointer",
              }}
            >
              {ct.label}
            </button>
          ))}
        </div>

        <div className={styles.playbackControls}>
          <button className={styles.controlBtn} onClick={reset} title="Reset">⏮</button>
          <button className={styles.controlBtn} onClick={stepBackward} title="Step Back">◀</button>
          <button
            className={`${styles.controlBtn} ${styles.playBtn}`}
            onClick={isPlaying ? pause : play}
            title={isPlaying ? "Pause" : "Play"}
            id="replay-play"
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button className={styles.controlBtn} onClick={stepForward} title="Step Forward">▶</button>
          <button className={styles.controlBtn} onClick={() => setCurrentIndex(frames.length - 1)} title="End">⏭</button>
        </div>

        <div className={styles.speedControls}>
          <label className={styles.speedLabel}>Speed</label>
          <input
            type="range"
            min="50"
            max="1000"
            step="50"
            value={1050 - playSpeed}
            onChange={(e) => setPlaySpeed(1050 - parseInt(e.target.value))}
            className={styles.speedSlider}
          />
          <span className={styles.speedValue}>{playSpeed}ms</span>
        </div>
      </div>

      {/* Session period + practice trading bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        flexWrap: "wrap", margin: "10px 0", padding: "10px 14px", borderRadius: 10,
        background: "var(--bg-secondary, rgba(255,255,255,0.03))",
        border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))" }}>
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted,#9ca3af)" }}>
          {period ? <>Replaying <b style={{ color: "var(--text-primary,#e5e7eb)" }}>{t10(period.from)} → {t10(period.to)}</b>{randomStart && <span style={{ color: "#a78bfa", fontWeight: 700 }}> · 🎲 random period</span>}</> : "—"}
          <span style={{ marginLeft: 10, opacity: 0.7 }}>Space=play · ←→=step · B=buy · S=short · C=close</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {position ? (
            <>
              <span style={{ fontSize: "0.78rem", fontWeight: 800,
                color: position.side === "long" ? "#10b981" : "#ef4444" }}>
                {position.side === "long" ? "▲ LONG" : "▼ SHORT"} @ ₹{position.entry.toFixed(2)}
              </span>
              <span style={{ fontSize: "0.82rem", fontWeight: 800,
                color: (unrealizedPct ?? 0) >= 0 ? "#10b981" : "#ef4444" }}>
                {(unrealizedPct ?? 0) >= 0 ? "+" : ""}{(unrealizedPct ?? 0).toFixed(2)}%
              </span>
              <button onClick={closePos} style={{ background: "#f59e0b", color: "#111", border: "none",
                borderRadius: 8, padding: "6px 14px", fontWeight: 800, cursor: "pointer", fontSize: "0.78rem" }}>
                Close (C)
              </button>
            </>
          ) : (
            <>
              <button onClick={() => openPos("long")} disabled={!curClose}
                style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8,
                  padding: "6px 14px", fontWeight: 800, cursor: "pointer", fontSize: "0.78rem" }}>
                Buy (B)
              </button>
              <button onClick={() => openPos("short")} disabled={!curClose}
                style={{ background: "#ef4444", color: "#fff", border: "none", borderRadius: 8,
                  padding: "6px 14px", fontWeight: 800, cursor: "pointer", fontSize: "0.78rem" }}>
                Short (S)
              </button>
            </>
          )}
          <span style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", borderLeft: "1px solid var(--border-default,#333)", paddingLeft: 10 }}>
            Session: <b style={{ color: "var(--text-primary,#e5e7eb)" }}>{sessionStats.n}</b> trades
            {sessionStats.n > 0 && <> · <b style={{ color: "var(--text-primary,#e5e7eb)" }}>{Math.round(sessionStats.wins / sessionStats.n * 100)}%</b> wins
            · <b style={{ color: sessionStats.total >= 0 ? "#10b981" : "#ef4444" }}>{sessionStats.total >= 0 ? "+" : ""}{sessionStats.total.toFixed(2)}%</b></>}
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className={styles.progressBar}>
        <div
          className={styles.progressFill}
          style={{ width: `${frames.length ? (currentIndex / (frames.length - 1)) * 100 : 0}%` }}
        />
        <input
          type="range"
          min="0"
          max={Math.max(0, frames.length - 1)}
          value={currentIndex}
          onChange={(e) => setCurrentIndex(parseInt(e.target.value))}
          className={styles.progressSlider}
        />
      </div>

      {/* Chart */}
      <div className={styles.chartContainer}>
        {loading && (
          <div className={styles.chartOverlay}>
            <div className={styles.spinner} />
          </div>
        )}
        {error && (
          <div className={styles.chartError}>
            <p>⚠️ {error}</p>
          </div>
        )}
        <div ref={chartRef} className={styles.chartCanvas} id="replay-chart" />
      </div>

      {/* Info Panels */}
      <div className={styles.infoPanels}>
        {/* Current Bar Info */}
        <div className={styles.infoPanel}>
          <h3 className={styles.infoPanelTitle}>Current Bar</h3>
          {currentFrame ? (
            <div className={styles.barInfo}>
              <div className={styles.barRow}>
                <span>Bar</span>
                <span className="mono">{currentIndex + 1} / {frames.length}</span>
              </div>
              <div className={styles.barRow}>
                <span>Date</span>
                <span className="mono">{currentFrame.time?.split("T")[0]}</span>
              </div>
              <div className={styles.barRow}>
                <span>Open</span>
                <span className="mono">₹{currentFrame.ohlcv.open.toFixed(2)}</span>
              </div>
              <div className={styles.barRow}>
                <span>High</span>
                <span className="mono price-up">₹{currentFrame.ohlcv.high.toFixed(2)}</span>
              </div>
              <div className={styles.barRow}>
                <span>Low</span>
                <span className="mono price-down">₹{currentFrame.ohlcv.low.toFixed(2)}</span>
              </div>
              <div className={styles.barRow}>
                <span>Close</span>
                <span className="mono">₹{currentFrame.ohlcv.close.toFixed(2)}</span>
              </div>
              <div className={styles.barRow}>
                <span>Volume</span>
                <span className="mono">{currentFrame.ohlcv.volume?.toLocaleString()}</span>
              </div>
            </div>
          ) : (
            <p className={styles.noData}>No data</p>
          )}
        </div>

        {/* Indicators */}
        <div className={styles.infoPanel}>
          <h3 className={styles.infoPanelTitle}>Indicators</h3>
          {currentFrame?.indicators ? (
            <div className={styles.barInfo}>
              {Object.entries(currentFrame.indicators).map(([key, val]) => (
                <div key={key} className={styles.barRow}>
                  <span>{key.toUpperCase()}</span>
                  <span className="mono">{val != null ? parseFloat(val).toFixed(2) : "—"}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.noData}>No indicators computed</p>
          )}
        </div>

        {/* Practice Trades */}
        <div className={styles.infoPanel}>
          <h3 className={styles.infoPanelTitle}>📝 Practice Trades</h3>
          {trades.length > 0 ? (
            <div className={styles.barInfo}>
              {trades.map((t, i) => (
                <div key={i} className={styles.barRow}>
                  <span>{t.side === "long" ? "▲" : "▼"} {t.entryTime} → {t.exitTime} ({t.bars} bars)</span>
                  <span className="mono" style={{ color: t.pnlPct >= 0 ? "#10b981" : "#ef4444", fontWeight: 700 }}>
                    {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.noData}>Buy (B) / Short (S) during the replay, Close (C) to book — your calls get scored against what actually happened next.</p>
          )}
        </div>

        {/* Repaint Check */}
        <div className={styles.infoPanel}>
          <h3 className={styles.infoPanelTitle}>🔍 Repaint Check</h3>
          {repaintChecks.length > 0 ? (
            <div className={styles.repaintList}>
              {repaintChecks.map((rc, i) => (
                <div key={i} className={styles.repaintItem}>
                  <span className={styles.repaintName}>{rc.indicator}</span>
                  <span className={`badge ${rc.is_repainting ? "badge-red" : "badge-green"}`}>
                    {rc.is_repainting ? "REPAINTS" : "CLEAN"}
                  </span>
                  <span className={styles.repaintDetail}>{rc.details}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.noData}>Run replay to check for repainting</p>
          )}
        </div>
      </div>
    </div>
  );
}
