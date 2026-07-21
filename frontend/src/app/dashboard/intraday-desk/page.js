"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./intraday-desk.module.css";

export default function IntradayDeskPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("all");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setRefreshing(true);
    try {
      const res = await api.getIntradayDesk();
      if (res.error) {
        setError(res.error);
      } else {
        setData(res);
        setError(null);
      }
    } catch (err) {
      console.error("Error loading intraday desk:", err);
      setError(err.message || "Failed to load dashboard data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.loaderWrap}>
        <div className={styles.spinner} />
        <p>Analyzing stock market universe...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.errorState}>
        <span className={styles.errorIcon}>⚠️</span>
        <h3>Failed to load Traders Desk</h3>
        <p>{error}</p>
        <button className="btn btn-primary" onClick={loadData}>↻ Try Again</button>
      </div>
    );
  }

  const {
    latest_date,
    market_advances,
    indices_stats,
    pos_neg_volumes,
    sector_advances,
    volume_gainers,
    price_vs_volume,
    today_vs_yesterday_volume,
    stocks_near_52w_high,
    fno_gainers,
    stocks_at_days_high,
  } = data;

  const dateStr = new Date(latest_date).toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className={styles.deskPage}>
      {/* Top Header */}
      <div className={styles.header}>
        <div>
          <span className={styles.badge}>Live Dashboard</span>
          <h1 className={styles.title}>🖥️ Intraday Traders Desk</h1>
          <p className={styles.subtitle}>
            Market breadth, sector trends, and scanning alerts for {dateStr}
          </p>
        </div>
        <button
          className={`${styles.refreshBtn} ${refreshing ? styles.spinning : ""}`}
          onClick={loadData}
          disabled={refreshing}
          title="Refresh dashboard data"
        >
          {refreshing ? "⚡ Updating..." : "↻ Refresh Data"}
        </button>
      </div>

      {/* Breadth Overview Row */}
      <div className={styles.overviewGrid}>
        {/* Market Breadth */}
        <div className={styles.overviewCard}>
          <div className={styles.cardHeader}>
            <span className={styles.cardTitle}>Market Breadth (Advances/Declines)</span>
            <span className={styles.cardValue}>{market_advances.percentage}% Up</span>
          </div>
          <div className={styles.breadthBar}>
            <div
              className={styles.breadthAdv}
              style={{ width: `${market_advances.percentage}%` }}
              title={`${market_advances.advances} Advances`}
            />
            <div
              className={styles.breadthDec}
              style={{ width: `${100 - market_advances.percentage}%` }}
              title={`${market_advances.declines} Declines`}
            />
          </div>
          <div className={styles.breadthLabels}>
            <span className={styles.textGreen}>▲ {market_advances.advances} Advances</span>
            <span className={styles.textRed}>▼ {market_advances.declines} Declines</span>
          </div>
        </div>

        {/* Volume Split */}
        <div className={styles.overviewCard}>
          <div className={styles.cardHeader}>
            <span className={styles.cardTitle}>Volume Split (In Lacs)</span>
            <span className={styles.cardValue}>
              {((pos_neg_volumes.positive / (pos_neg_volumes.positive + pos_neg_volumes.negative)) * 100).toFixed(1)}% Bullish
            </span>
          </div>
          <div className={styles.breadthBar}>
            <div
              className={styles.breadthAdv}
              style={{
                width: `${(pos_neg_volumes.positive / (pos_neg_volumes.positive + pos_neg_volumes.negative)) * 100}%`,
              }}
              title={`${pos_neg_volumes.positive.toLocaleString()} Lacs Positive Volume`}
            />
            <div
              className={styles.breadthDec}
              style={{
                width: `${(pos_neg_volumes.negative / (pos_neg_volumes.positive + pos_neg_volumes.negative)) * 100}%`,
              }}
              title={`${pos_neg_volumes.negative.toLocaleString()} Lacs Negative Volume`}
            />
          </div>
          <div className={styles.breadthLabels}>
            <span className={styles.textGreen}>🟢 {pos_neg_volumes.positive.toLocaleString()} Lacs</span>
            <span className={styles.textRed}>🔴 {pos_neg_volumes.negative.toLocaleString()} Lacs</span>
          </div>
        </div>

        {/* Volume Comparison */}
        <div className={styles.overviewCard}>
          <div className={styles.cardHeader}>
            <span className={styles.cardTitle}>Aggregated Volume Trend</span>
            <span className={styles.cardValue}>
              {(((today_vs_yesterday_volume.today - today_vs_yesterday_volume.yesterday) / today_vs_yesterday_volume.yesterday) * 100).toFixed(1)}%
            </span>
          </div>
          <div className={styles.volumeCompare}>
            <div className={styles.volStat}>
              <span className={styles.volVal}>{today_vs_yesterday_volume.today.toLocaleString()} Lacs</span>
              <span className={styles.volLbl}>Today's Vol</span>
            </div>
            <div className={styles.volDivider} />
            <div className={styles.volStat}>
              <span className={styles.volVal}>{today_vs_yesterday_volume.yesterday.toLocaleString()} Lacs</span>
              <span className={styles.volLbl}>Yesterday's Vol</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Multi-Widget Grid */}
      <div className={styles.dashboardGrid}>
        {/* Widget 1: Indices Stats */}
        <div className={`${styles.widgetCard} ${styles.colSpan2}`}>
          <div className={styles.widgetHeader}>
            <h3 className={styles.widgetTitle}>📈 Key Indices Performance</h3>
          </div>
          <div className={styles.indicesGrid}>
            {indices_stats.slice(0, 10).map((idx) => {
              const isUp = idx.change_pct >= 0;
              return (
                <div key={idx.symbol} className={styles.indexItem}>
                  <div className={styles.indexMeta}>
                    <span className={styles.indexName}>{idx.name}</span>
                    <span className={styles.indexSymbol}>{idx.symbol}</span>
                  </div>
                  <div className={styles.indexPrices}>
                    <span className={styles.indexClose}>₹{idx.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                    <span className={`${styles.indexChange} ${isUp ? styles.up : styles.down}`}>
                      {isUp ? "▲" : "▼"} {idx.change_pct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Widget 2: Sector Advances */}
        <div className={`${styles.widgetCard} ${styles.colSpan2}`}>
          <div className={styles.widgetHeader}>
            <h3 className={styles.widgetTitle}>⚡ Sector Strength</h3>
          </div>
          <div className={styles.sectorsList}>
            {sector_advances.slice(0, 8).map((sec) => (
              <div key={sec.sector} className={styles.sectorRow}>
                <div className={styles.sectorMeta}>
                  <span className={styles.sectorName}>{sec.sector}</span>
                  <span className={styles.sectorRatio}>{sec.advances}/{sec.total} Up</span>
                </div>
                <div className={styles.sectorProgressWrap}>
                  <div
                    className={styles.sectorProgressBar}
                    style={{ width: `${sec.percentage}%`, background: sec.percentage >= 50 ? "var(--accent-emerald)" : "var(--accent-rose)" }}
                  />
                </div>
                <span className={styles.sectorPercentage}>{sec.percentage}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Widget 3: F&O Gainers */}
        <div className={styles.widgetCard}>
          <div className={styles.widgetHeader}>
            <h3 className={styles.widgetTitle}>🚀 F&O Top Gainers</h3>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th style={{ textAlign: "right" }}>Chg %</th>
                </tr>
              </thead>
              <tbody>
                {fno_gainers.slice(0, 6).map((stock) => (
                  <tr key={stock.symbol}>
                    <td>
                      <a href={`/dashboard/charts?symbol=${stock.symbol}`} className={styles.stockLink}>
                        {stock.symbol}
                      </a>
                    </td>
                    <td>₹{stock.close.toLocaleString("en-IN")}</td>
                    <td className={styles.textGreen} style={{ textAlign: "right", fontWeight: "bold" }}>
                      +{stock.change_pct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Widget 4: Volume Gainers */}
        <div className={styles.widgetCard}>
          <div className={styles.widgetHeader}>
            <h3 className={styles.widgetTitle}>📊 Volume Spike vs 20 SMA</h3>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Volume</th>
                  <th style={{ textAlign: "right" }}>Vol Gain %</th>
                </tr>
              </thead>
              <tbody>
                {volume_gainers.slice(0, 6).map((stock) => (
                  <tr key={stock.symbol}>
                    <td>
                      <a href={`/dashboard/charts?symbol=${stock.symbol}`} className={styles.stockLink}>
                        {stock.symbol}
                      </a>
                    </td>
                    <td>{stock.volume >= 1e6 ? (stock.volume / 1e6).toFixed(1) + "M" : (stock.volume / 1e3).toFixed(0) + "K"}</td>
                    <td className={styles.textGreen} style={{ textAlign: "right", fontWeight: "bold" }}>
                      +{stock.change_pct.toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Widget 5: Near 52W High */}
        <div className={styles.widgetCard}>
          <div className={styles.widgetHeader}>
            <h3 className={styles.widgetTitle}>🏆 Near 52-Week High</h3>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th style={{ textAlign: "right" }}>Diff %</th>
                </tr>
              </thead>
              <tbody>
                {stocks_near_52w_high.slice(0, 6).map((stock) => (
                  <tr key={stock.symbol}>
                    <td>
                      <a href={`/dashboard/charts?symbol=${stock.symbol}`} className={styles.stockLink}>
                        {stock.symbol}
                      </a>
                    </td>
                    <td>₹{stock.close.toLocaleString("en-IN")}</td>
                    <td className={styles.textAmber} style={{ textAlign: "right", fontWeight: "bold" }}>
                      {stock.change_pct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Widget 6: Day's High Breakouts */}
        <div className={styles.widgetCard}>
          <div className={styles.widgetHeader}>
            <h3 className={styles.widgetTitle}>🎯 Stocks at Day's High</h3>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>LTP</th>
                  <th style={{ textAlign: "right" }}>Day's High</th>
                </tr>
              </thead>
              <tbody>
                {stocks_at_days_high.slice(0, 6).map((stock) => (
                  <tr key={stock.symbol}>
                    <td>
                      <a href={`/dashboard/charts?symbol=${stock.symbol}`} className={styles.stockLink}>
                        {stock.symbol}
                      </a>
                    </td>
                    <td>₹{stock.close.toLocaleString("en-IN")}</td>
                    <td className={styles.textEmerald} style={{ textAlign: "right", fontWeight: "bold" }}>
                      ₹{stock.high.toLocaleString("en-IN")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
