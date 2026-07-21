"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import styles from "./overview.module.css";
import { startChartixTour } from "@/components/TourOverlay";

export default function DashboardOverview() {
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState(null);
  const [recentPatterns, setRecentPatterns] = useState([]);
  const [subscription, setSubscription] = useState(null);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showWelcome, setShowWelcome] = useState(false);

  useEffect(() => {
    loadDashboard();
    // One-time welcome banner for new users pointing to the guided tour
    try {
      if (!localStorage.getItem("chartix_tour_seen")) setShowWelcome(true);
    } catch (e) { /* storage unavailable */ }
  }, []);

  const dismissWelcome = () => {
    setShowWelcome(false);
    try { localStorage.setItem("chartix_tour_seen", "1"); } catch (e) {}
  };

  async function loadDashboard() {
    try {
      const [userRes, patternsRes, subRes, alertsRes] = await Promise.allSettled([
        api.getMe(),
        api.listPatterns({ limit: 10, status: "forming" }),
        api.getSubscriptionStatus(),
        api.listNotifications(true),
      ]);

      if (userRes.status === "fulfilled") setUser(userRes.value);

      if (patternsRes.status === "fulfilled") setRecentPatterns(patternsRes.value);
      if (subRes.status === "fulfilled") setSubscription(subRes.value);
      if (alertsRes.status === "fulfilled") setUnreadAlerts(alertsRes.value.length);
    } catch (err) {
      console.error("Dashboard load error:", err);
    } finally {
      setLoading(false);
    }
  }

  const QUICK_STATS = [
    {
      // Static snapshot of active EQ instruments (peestock.db, 2026-07-16).
      // Update after a listing sync adds stocks; there is no count API yet.
      label: "NSE Stocks",
      value: "2,765",
      icon: "📈",
      color: "var(--accent-primary)",
    },
    {
      label: "Pattern Types",
      value: "19",
      icon: "🔮",
      color: "var(--accent-emerald)",
    },
    {
      label: "Active Patterns",
      value: recentPatterns.length || "—",
      icon: "🎯",
      color: "var(--accent-amber)",
    },
    {
      label: "Plan",
      value: subscription?.tier?.replace("_", " ").toUpperCase() || "FREE",
      icon: "⭐",
      color: "var(--accent-cyan)",
    },
  ];

  const PATTERN_COLORS = {
    double_top: "var(--accent-rose)",
    double_bottom: "var(--accent-emerald)",
    head_shoulders: "var(--accent-rose)",
    inv_head_shoulders: "var(--accent-emerald)",
    asc_triangle: "var(--accent-emerald)",
    desc_triangle: "var(--accent-rose)",
    sym_triangle: "var(--accent-amber)",
    rising_wedge: "var(--accent-rose)",
    falling_wedge: "var(--accent-emerald)",
    rectangle: "var(--accent-cyan)",
  };

  return (
    <div className={styles.overview}>
      {/* One-time new-user welcome banner */}
      {showWelcome && (
        <div style={{
          display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
          background: "linear-gradient(135deg, rgba(34,211,238,0.10), rgba(99,102,241,0.10))",
          border: "1px solid rgba(34,211,238,0.35)", borderRadius: 12,
          padding: "14px 18px", marginBottom: 20,
        }}>
          <span style={{ fontSize: 24 }}>👋</span>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>New to Chartix?</div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary, #bbb)" }}>
              60 seconds, 10 stops — we&apos;ll point at the real buttons, not describe them.
            </div>
          </div>
          <button onClick={() => { dismissWelcome(); startChartixTour(); }} className="btn btn-primary"
            style={{ padding: "8px 16px", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
            ▶ Start the tour
          </button>
          <button onClick={dismissWelcome} title="Dismiss"
            style={{ background: "transparent", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 16 }}>
            ✕
          </button>
        </div>
      )}

      {/* Welcome */}
      <div className={styles.welcomeSection}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 className={styles.welcomeTitle}>
              Welcome back, <span className={styles.welcomeName}>{user?.full_name || "Trader"}</span>
            </h1>
            <p className={styles.welcomeSub}>
              Here's what's happening in the market today
            </p>
          </div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <a href="/dashboard/alerts" className="btn btn-outline" style={{ position: "relative" }}>
              🔔 Alerts
              {unreadAlerts > 0 && (
                <span style={{
                  position: "absolute", top: -6, right: -6,
                  background: "var(--accent-rose)", color: "white",
                  fontSize: "0.7rem", fontWeight: 700, borderRadius: "999px",
                  padding: "1px 6px",
                }}>
                  {unreadAlerts}
                </span>
              )}
            </a>
            <button
              className="btn btn-primary"
              onClick={async () => {
                try {
                  const res = await api.triggerScan();
                  alert(res.message);
                  loadDashboard();
                } catch (err) {
                  alert("Scan failed: " + err.message);
                }
              }}
              id="trigger-scan-btn"
            >
              🔍 Scan Market Now
            </button>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className={styles.statsGrid}>
        {QUICK_STATS.map((stat) => (
          <div key={stat.label} className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: `${stat.color}20` }}>
              {stat.icon}
            </div>
            <div className={styles.statInfo}>
              <span className={styles.statValue} style={{ color: stat.color }}>
                {stat.value}
              </span>
              <span className={styles.statLabel}>{stat.label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Content Grid */}
      <div className={styles.contentGrid}>
        {/* Left Column - Secondary Info */}
        <div className={styles.leftColumn}>
          {/* Recent Patterns */}
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>🔮 Recent Patterns</h2>
              <a href="/dashboard/patterns" className={styles.panelLink}>View All →</a>
            </div>
            <div className={styles.panelBody}>
              {loading ? (
                <div className={styles.skeleton}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className={styles.skeletonRow} />
                  ))}
                </div>
              ) : recentPatterns.length > 0 ? (
                <div className={styles.patternList}>
                  {recentPatterns.map((p, i) => (
                    <div key={i} className={styles.patternItem}>
                      <div className={styles.patternSymbol}>
                        <span className={styles.patternDot}
                          style={{ background: PATTERN_COLORS[p.pattern_type] || "var(--accent-primary)" }}
                        />
                        {p.symbol || "—"}
                      </div>
                      <span className={styles.patternType}>
                        {p.pattern_type?.replace(/_/g, " ")}
                      </span>
                      <span className={styles.patternConfidence}>
                        {p.confidence ? `${(p.confidence * 100).toFixed(0)}%` : "—"}
                      </span>
                      <span className={`badge ${p.status === "completed" ? "badge-green" : "badge-blue"}`}>
                        {p.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>🔮</span>
                  <p>No patterns detected yet.</p>
                  <p className={styles.emptyHint}>
                    Patterns will appear once market data is ingested.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Subscription Status */}
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>⭐ Your Plan</h2>
            </div>
            <div className={styles.panelBody}>
              {subscription ? (
                <div className={styles.subInfo}>
                  <div className={styles.subTier}>
                    {subscription.tier?.replace("_", " ").toUpperCase() || "FREE"}
                  </div>
                  <div className={styles.subStatus}>
                    Status: <span className={`badge ${subscription.status === "active" || subscription.status === "trial" ? "badge-green" : "badge-red"}`}>
                      {subscription.status}
                    </span>
                  </div>
                  {subscription.expires_at && (
                    <div className={styles.subExpiry}>
                      Expires: {new Date(subscription.expires_at).toLocaleDateString()}
                    </div>
                  )}
                  <div className={styles.subFeatures}>
                    <h4>Features:</h4>
                    <ul>
                      {subscription.features && Object.entries(subscription.features).map(([key, val]) => {
                        // Feature values aren't all booleans: max_scanners is a
                        // number (-1 = unlimited), timeframes is an array. Treat
                        // each as enabled unless it's explicitly off, and show
                        // the actual value so "timeframes" reads "D, W, M".
                        let enabled, detail = null;
                        if (Array.isArray(val)) { enabled = val.length > 0; detail = val.join(", "); }
                        else if (typeof val === "number") { enabled = val !== 0; detail = val === -1 ? "unlimited" : String(val); }
                        else { enabled = val === true; }
                        return (
                          <li key={key} className={enabled ? styles.featureOn : styles.featureOff}>
                            {enabled ? "✓" : "✗"} {key.replace(/_/g, " ")}{detail ? `: ${detail}` : ""}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>⭐</span>
                  <p>Free Plan</p>
                  <a href="/dashboard/pricing" className="btn btn-primary" style={{ marginTop: 12, fontSize: "0.85rem", textDecoration: "none" }}>
                    Upgrade Plan
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column - Primary Quick Actions */}
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>⚡ Quick Actions</h2>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.actionGrid}>
              <a href="/dashboard/charts" className={styles.actionCard}>
                <span className={styles.actionIcon}>📈</span>
                <span className={styles.actionLabel}>Open Chart</span>
                <span className={styles.actionDesc}>View any NSE stock</span>
              </a>
              <a href="/dashboard/patterns" className={styles.actionCard}>
                <span className={styles.actionIcon}>🔮</span>
                <span className={styles.actionLabel}>Pattern Screener</span>
                <span className={styles.actionDesc}>Find setups</span>
              </a>
              <a href="/dashboard/ma-scanner" className={styles.actionCard}>
                <span className={styles.actionIcon}>📊</span>
                <span className={styles.actionLabel}>MA Scanner</span>
                <span className={styles.actionDesc}>Crossover · Slope · Convergence</span>
              </a>
              <a href="/dashboard/indicators" className={styles.actionCard}>
                <span className={styles.actionIcon}>📉</span>
                <span className={styles.actionLabel}>Indicator Scanner</span>
                <span className={styles.actionDesc}>SuperTrend · Ichimoku · RSI</span>
              </a>
              <a href="/dashboard/candlesticks" className={styles.actionCard}>
                <span className={styles.actionIcon}>🕯️</span>
                <span className={styles.actionLabel}>Candlestick Scanner</span>
                <span className={styles.actionDesc}>24+ patterns</span>
              </a>
              <a href="/dashboard/other-scans" className={styles.actionCard}>
                <span className={styles.actionIcon}>🔭</span>
                <span className={styles.actionLabel}>Other Scans</span>
                <span className={styles.actionDesc}>Breakout · Divergence · Volume</span>
              </a>
              <a href="/dashboard/scanners" className={styles.actionCard}>
                <span className={styles.actionIcon}>🎯</span>
                <span className={styles.actionLabel}>Custom Scanner</span>
                <span className={styles.actionDesc}>No-code builder</span>
              </a>
              <a href="/dashboard/replay" className={styles.actionCard}>
                <span className={styles.actionIcon}>⏪</span>
                <span className={styles.actionLabel}>Bar Replay</span>
                <span className={styles.actionDesc}>Visual backtest</span>
              </a>
              <a href="/dashboard/trendlines" className={styles.actionCard}>
                <span className={styles.actionIcon}>📐</span>
                <span className={styles.actionLabel}>Trendlines</span>
                <span className={styles.actionDesc}>Auto S/R lines</span>
              </a>
              <a href="/dashboard/watchlist" className={styles.actionCard}>
                <span className={styles.actionIcon}>⭐</span>
                <span className={styles.actionLabel}>My Watchlist</span>
                <span className={styles.actionDesc}>Track your symbols</span>
              </a>
              <a href="/dashboard/portfolio" className={styles.actionCard}>
                <span className={styles.actionIcon}>💼</span>
                <span className={styles.actionLabel}>My Portfolio</span>
                <span className={styles.actionDesc}>Holdings &amp; live P&amp;L</span>
              </a>
              <a href="/dashboard/alerts" className={styles.actionCard}>
                <span className={styles.actionIcon}>🔔</span>
                <span className={styles.actionLabel}>Alerts</span>
                <span className={styles.actionDesc}>Price &amp; pattern alerts</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
