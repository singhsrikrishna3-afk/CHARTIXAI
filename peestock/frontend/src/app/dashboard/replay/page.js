"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
import styles from "./replay.module.css";

export default function ReplayPage() {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const candleSeriesRef = useRef(null);

  const [symbol, setSymbol] = useState("RELIANCE");
  const [symbolInput, setSymbolInput] = useState("RELIANCE");
  const [indicators, setIndicators] = useState("sma:20,rsi:14");
  const [frames, setFrames] = useState([]);
  const [repaintChecks, setRepaintChecks] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);

  // Load replay data
  const loadReplay = useCallback(async () => {
    setLoading(true);
    setError("");
    setIsPlaying(false);
    setCurrentIndex(0);
    clearInterval(intervalRef.current);

    try {
      const data = await api.getReplay(symbol, 50, 1, indicators);
      setFrames(data.frames || []);
      setRepaintChecks(data.repaint_checks || []);
    } catch (err) {
      setError(err.message || "Failed to load replay data");
      setFrames([]);
    } finally {
      setLoading(false);
    }
  }, [symbol, indicators]);

  useEffect(() => {
    loadReplay();
    return () => clearInterval(intervalRef.current);
  }, [loadReplay]);

  // Initialize chart
  useEffect(() => {
    if (!chartRef.current || frames.length === 0) return;

    const initChart = async () => {
      const { createChart, ColorType, CandlestickSeries } = await import("lightweight-charts");

      if (chartInstance.current) chartInstance.current.remove();

      const chart = createChart(chartRef.current, {
        width: chartRef.current.clientWidth,
        height: 400,
        layout: {
          background: { type: ColorType.Solid, color: "#FFFFFF" },
          textColor: "#333333",
          fontFamily: "'Tahoma', 'Arial', sans-serif",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "#E0E0E0" },
          horzLines: { color: "#E0E0E0" },
        },
        rightPriceScale: { borderColor: "#C0C0C0" },
        timeScale: { borderColor: "#C0C0C0", timeVisible: false },
      });

      chartInstance.current = chart;

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#26a69a",
        downColor: "#ef5350",
        borderUpColor: "#26a69a",
        borderDownColor: "#ef5350",
        wickUpColor: "#26a69a",
        wickDownColor: "#ef5350",
      });


      candleSeriesRef.current = candleSeries;

      // Set initial data
      updateChartToIndex(0, candleSeries, chart);

      const handleResize = () => {
        if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
      };
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    };

    initChart();
  }, [frames]);

  // Update chart when index changes
  useEffect(() => {
    if (candleSeriesRef.current && frames.length > 0) {
      updateChartToIndex(currentIndex, candleSeriesRef.current, chartInstance.current);
    }
  }, [currentIndex]);

  function updateChartToIndex(index, candleSeries, chart) {
    const visibleFrames = frames.slice(0, index + 1);
    const data = visibleFrames.map((f) => ({
      time: f.time?.split("T")[0] || f.time,
      open: f.ohlcv.open,
      high: f.ohlcv.high,
      low: f.ohlcv.low,
      close: f.ohlcv.close,
    }));
    candleSeries.setData(data);
    if (chart) chart.timeScale().fitContent();
  }

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
          <button
            className="btn btn-primary"
            onClick={() => { setSymbol(symbolInput); }}
            style={{ padding: "8px 16px", fontSize: "0.85rem" }}
          >
            Load
          </button>
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
