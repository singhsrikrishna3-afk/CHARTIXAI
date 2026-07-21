/**
 * ScanResultCard — KeyStocks-style scan result card with mini chart thumbnail.
 * Usage:
 *   <ScanResultCard symbol="RELIANCE" close={2800} changePct={1.5} chartData={[...ohlcv]} ... />
 */
"use client";

import { useEffect, useRef } from "react";
import { drawMiniChart } from "@/lib/miniChart";

/**
 * @param {Object} props
 * @param {string}   props.symbol
 * @param {string}   [props.name]
 * @param {number}   [props.close]
 * @param {number}   [props.changePct]
 * @param {number}   [props.volume]
 * @param {Array}    [props.chartData]     — array of {open,high,low,close,volume}
 * @param {string}   [props.badge]         — e.g. "Bullish Cross"
 * @param {string}   [props.badgeColor]    — CSS color for badge
 * @param {string}   [props.signal]        — e.g. "EMA 20 × EMA 50"
 * @param {string}   [props.confidence]    — e.g. "87%"
 * @param {boolean}  [props.isBullish]
 * @param {string}   [props.href]          — link to chart
 * @param {Function} [props.onClick]
 */
export default function ScanResultCard({
  symbol,
  name,
  close,
  changePct,
  volume,
  chartData,
  badge,
  badgeColor,
  signal,
  confidence,
  isBullish = true,
  href,
  onClick,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !chartData || chartData.length === 0) return;
    const canvas = canvasRef.current;
    // Use devicePixelRatio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    drawMiniChart(canvas, chartData.slice(-40), {
      upColor: "#26a69a",
      downColor: "#ef5350",
      bgColor: "#FFFFFF",
      gridColor: "#EEEEEE",
      borderColor: "#C0C0C0",
      showVolume: true,
      showMA: chartData.length >= 20,
      maPeriod: 20,
      maColor: isBullish ? "#FF6600" : "#AA00AA",
    });
  }, [chartData, isBullish]);

  const isUp = changePct >= 0;
  const cardUrl = href || `/dashboard/charts?symbol=${symbol}`;

  return (
    <div className="scan-result-card" onClick={onClick}>
      {/* Mini chart */}
      <div className="src-chart-wrap">
        <canvas
          ref={canvasRef}
          className="src-canvas"
          style={{ width: "100%", height: "100%", display: "block" }}
        />
        {(!chartData || chartData.length === 0) && (
          <div className="src-no-chart">No Data</div>
        )}
      </div>

      {/* Info */}
      <div className="src-info">
        <div className="src-top-row">
          <a href={cardUrl} className="src-symbol">{symbol}</a>
          {badge && (
            <span
              className="src-badge"
              style={{ background: badgeColor ? `${badgeColor}22` : undefined, color: badgeColor }}
            >
              {badge}
            </span>
          )}
        </div>

        {name && <div className="src-name">{name}</div>}

        <div className="src-prices">
          {close != null && (
            <span className="src-close">₹{close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
          )}
          {changePct != null && (
            <span className={`src-change ${isUp ? "src-up" : "src-down"}`}>
              {isUp ? "▲" : "▼"} {Math.abs(changePct).toFixed(2)}%
            </span>
          )}
        </div>

        {signal && <div className="src-signal">📶 {signal}</div>}

        <div className="src-footer">
          {volume != null && (
            <span className="src-vol">Vol: {volume >= 1e6 ? (volume / 1e6).toFixed(1) + "M" : (volume / 1e3).toFixed(0) + "K"}</span>
          )}
          {confidence && <span className="src-conf">Conf: {confidence}</span>}
          <a href={cardUrl} className="src-chart-link">Chart →</a>
        </div>
      </div>
    </div>
  );
}
