"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startChartixTour } from "@/components/TourOverlay";

/**
 * Guide & Tour — not a manual. Two ways in:
 *  1. the spotlight tour (walks the real UI, started from here or the welcome banner)
 *  2. First Missions — 6 hands-on tasks with progress saved in localStorage
 * The old reference material lives in collapsed accordions at the bottom.
 */

const MISSIONS_KEY = "chartix_missions_done";

const MISSIONS = [
  {
    id: "chart",
    emoji: "📈",
    title: "Load your first chart",
    why: "Everything you set up here auto-saves — this becomes your chart.",
    task: "Open RELIANCE, double-click the chart → Indicators, toggle RSI and MACD on. Then edit the SMA 20 from its legend chip (⚙).",
    href: "/dashboard/charts?symbol=RELIANCE",
    linkLabel: "Open RELIANCE",
    minutes: 3,
  },
  {
    id: "patterns",
    emoji: "🔮",
    title: "See what formed today",
    why: "19 chart patterns across ~2,000 stocks are detected for you every evening.",
    task: "Open the Pattern Screener, pick any pattern with results, and click a row to see it drawn on the chart.",
    href: "/dashboard/patterns",
    linkLabel: "Pattern Screener",
    minutes: 2,
  },
  {
    id: "recommended",
    emoji: "✨",
    title: "Run a scan the easy way",
    why: "Every scan panel has a ✨ Recommended button — proven parameters, zero guesswork.",
    task: "Go to Other Scans → VCP (Minervini) → press ✨ Recommended → Run. Few or zero matches is normal — it's a rare, high-quality pattern.",
    href: "/dashboard/other-scans",
    linkLabel: "Other Scans",
    minutes: 2,
  },
  {
    id: "custom",
    emoji: "🎯",
    title: "Build a scan of your own",
    why: "This is the muscle you'll use every evening after the data update.",
    task: "In Custom Scanner, combine two conditions — try “RSI < 35 AND price > SMA 200” — run it, then save it.",
    href: "/dashboard/scanners",
    linkLabel: "Custom Scanner",
    minutes: 3,
  },
  {
    id: "assistant",
    emoji: "💬",
    title: "Ask instead of clicking",
    why: "Anything the scanners do, you can also just type.",
    task: "Ask the Scan Assistant: “golden crossover in nifty 50 daily”. Then try one in your own words.",
    href: "/dashboard/assistant",
    linkLabel: "Scan Assistant",
    minutes: 1,
  },
  {
    id: "base",
    emoji: "⭐",
    title: "Set up your home base",
    why: "Watchlist + one alert = Chartix starts working for you while you're away.",
    task: "Star 3 stocks you actually follow into the Watchlist, then create one price alert — the 🔔 bell will light up when it triggers.",
    href: "/dashboard/watchlist",
    linkLabel: "My Watchlist",
    minutes: 2,
  },
];

const REFERENCE = [
  {
    id: "plans",
    icon: "💳",
    title: "Plans, billing & UPI",
    body: [
      ["Plans", "Free Trial (14 days) → EOD Basic ₹499 → EOD Pro ₹999 (Weekly/Monthly charts, unlimited scanners, bar replay) → AI EOD Pro ₹1,499 (adds the LSTM AI Price Forecast)."],
      ["Paying via UPI", "Pick a plan on the Pricing page, pay via the UPI QR / UPI ID, then enter the 12-digit UTR number from your UPI app. Your plan activates once an admin verifies the transaction (usually within a few hours)."],
    ],
    cta: { href: "/dashboard/pricing", label: "View plans →" },
  },
  {
    id: "data",
    icon: "🗄️",
    title: "Data & coverage",
    body: [
      ["EOD data", "All prices are end-of-day from the official NSE bhavcopy, updated after market close by ~7 PM IST. There is no live tick data."],
      ["Coverage", "2,700+ NSE stocks, 30+ indices, commodities (gold, silver, crude…) and major forex pairs. Delivery volume (institutional-conviction proxy) is included for NSE equities."],
    ],
  },
  {
    id: "power",
    icon: "⚡",
    title: "Power-user tips",
    body: [
      ["Legend chips", "Every active indicator shows a chip on the chart (top-left): ⚙ edits parameters/colors, ✕ removes, + MA adds a custom moving average."],
      ["Analysis Search", "On the chart page: 22 one-click scans (Golden Cross, BB Squeeze, NR7, Gap Up…) — results in a table, click to chart."],
      ["Repaint Check", "In Bar Replay, it tells you if an indicator's historical values change as new bars arrive — repainting indicators give untrustworthy signals."],
      ["AI Forecast", "On the AI EOD Pro plan, enable the AI Forecast (LSTM) indicator to overlay a 5-day predicted path with confidence bands. Directional aid — not investment advice."],
    ],
  },
];

export default function GuidePage() {
  const router = useRouter();
  const [done, setDone] = useState([]);
  const [openRef, setOpenRef] = useState(null);
  const [justFinished, setJustFinished] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(MISSIONS_KEY) || "[]");
      if (Array.isArray(saved)) setDone(saved);
    } catch (e) {}
  }, []);

  const toggleDone = (id) => {
    setDone((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try { localStorage.setItem(MISSIONS_KEY, JSON.stringify(next)); } catch (e) {}
      if (next.length === MISSIONS.length && prev.length < MISSIONS.length) {
        setJustFinished(true);
      }
      return next;
    });
  };

  const pct = Math.round((done.length / MISSIONS.length) * 100);
  const allDone = done.length === MISSIONS.length;

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <style>{`
        @keyframes guidePop { 0% { transform: scale(0.96); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
      `}</style>

      {/* Hero — the tour is a thing you DO, not read */}
      <div style={{
        background: "linear-gradient(135deg, rgba(34,211,238,0.10), rgba(99,102,241,0.12))",
        border: "1px solid rgba(34,211,238,0.3)", borderRadius: 16,
        padding: "26px 26px 22px", marginBottom: 26,
      }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, margin: "0 0 6px" }}>
          🧭 Learn Chartix by using it
        </h1>
        <p style={{ color: "var(--text-secondary, #b6bcc9)", fontSize: "0.9rem", margin: "0 0 16px", lineHeight: 1.55 }}>
          A 60-second spotlight tour of the real interface, then six small missions.
          Do them in order and you&apos;re operational in ~15 minutes — no reading required.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn btn-primary" style={{ padding: "10px 18px", fontSize: "0.85rem" }}
            onClick={() => startChartixTour(router)}>
            ▶ Start the 60-second tour
          </button>
          <a href="#missions" style={{
            padding: "10px 18px", fontSize: "0.85rem", fontWeight: 600, borderRadius: 8,
            border: "1px solid var(--border-default, #333)", color: "var(--text-primary, #e5e7eb)",
            textDecoration: "none",
          }}>
            🏁 Jump to missions
          </a>
        </div>
      </div>

      {/* Missions */}
      <div id="missions" style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 800, margin: 0 }}>🏁 First Missions</h2>
        <span style={{ fontSize: "0.8rem", color: "var(--text-muted, #7c8496)", fontWeight: 600 }}>
          {done.length}/{MISSIONS.length} done · ~{MISSIONS.filter((m) => !done.includes(m.id)).reduce((a, m) => a + m.minutes, 0)} min left
        </span>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 8, borderRadius: 4, background: "rgba(255,255,255,0.08)",
        overflow: "hidden", marginBottom: 18,
      }}>
        <div style={{
          height: "100%", width: `${pct}%`, borderRadius: 4,
          background: "linear-gradient(90deg, #22d3ee, #6366f1)",
          transition: "width 0.4s ease",
        }} />
      </div>

      {(allDone || justFinished) && (
        <div style={{
          background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.4)",
          borderRadius: 12, padding: "14px 18px", marginBottom: 18,
          display: "flex", alignItems: "center", gap: 12, animation: "guidePop 0.3s ease",
        }}>
          <span style={{ fontSize: 26 }}>🏆</span>
          <div>
            <div style={{ fontWeight: 800 }}>All missions complete — you&apos;re operational.</div>
            <div style={{ fontSize: "0.83rem", color: "var(--text-secondary, #b6bcc9)" }}>
              Your evening loop from here: data updates by ~7 PM → check the Pattern Screener → run your saved scan → review your watchlist and alerts.
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 12, marginBottom: 30 }}>
        {MISSIONS.map((m, i) => {
          const isDone = done.includes(m.id);
          return (
            <div key={m.id} style={{
              display: "flex", gap: 14, alignItems: "flex-start",
              background: isDone ? "rgba(16,185,129,0.06)" : "var(--bg-secondary, rgba(255,255,255,0.03))",
              border: `1px solid ${isDone ? "rgba(16,185,129,0.35)" : "var(--border-subtle, rgba(255,255,255,0.08))"}`,
              borderRadius: 12, padding: "16px 18px", transition: "all 0.2s ease",
            }}>
              {/* check control */}
              <button onClick={() => toggleDone(m.id)}
                title={isDone ? "Mark as not done" : "Mark as done"}
                style={{
                  width: 28, height: 28, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
                  border: `2px solid ${isDone ? "#10b981" : "var(--border-default, #444)"}`,
                  background: isDone ? "#10b981" : "transparent",
                  color: "#fff", fontSize: 14, fontWeight: 800, lineHeight: 1,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.15s ease", marginTop: 2,
                }}>
                {isDone ? "✓" : ""}
              </button>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <span style={{
                    fontWeight: 800, fontSize: "0.92rem",
                    textDecoration: isDone ? "line-through" : "none",
                    opacity: isDone ? 0.65 : 1,
                  }}>
                    {m.emoji} Mission {i + 1} · {m.title}
                  </span>
                  <span style={{
                    fontSize: "0.68rem", fontWeight: 700, color: "var(--text-muted, #7c8496)",
                    border: "1px solid var(--border-subtle, #333)", borderRadius: 10, padding: "1px 8px",
                  }}>
                    ~{m.minutes} min
                  </span>
                </div>
                {!isDone && (
                  <>
                    <div style={{ fontSize: "0.83rem", color: "var(--accent-cyan, #22d3ee)", marginBottom: 6 }}>
                      {m.why}
                    </div>
                    <div style={{ fontSize: "0.85rem", lineHeight: 1.55, color: "var(--text-secondary, #b6bcc9)", marginBottom: 10 }}>
                      {m.task}
                    </div>
                    <Link href={m.href} className="btn btn-primary"
                      style={{ padding: "7px 14px", fontSize: "0.78rem", textDecoration: "none", display: "inline-block" }}>
                      {m.linkLabel} →
                    </Link>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Reference — demoted to collapsed accordions */}
      <h2 style={{ fontSize: "1.05rem", fontWeight: 800, margin: "0 0 10px", color: "var(--text-secondary, #b6bcc9)" }}>
        📚 Reference (when you need it)
      </h2>
      {REFERENCE.map((r) => (
        <section key={r.id} style={{
          background: "var(--bg-secondary, rgba(255,255,255,0.03))",
          border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))",
          borderRadius: 12, marginBottom: 10, overflow: "hidden",
        }}>
          <div onClick={() => setOpenRef(openRef === r.id ? null : r.id)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "12px 16px", cursor: "pointer", userSelect: "none",
            }}>
            <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>{r.icon} {r.title}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{openRef === r.id ? "▲" : "▼"}</span>
          </div>
          {openRef === r.id && (
            <div style={{ padding: "0 16px 14px" }}>
              {r.body.map(([label, text], i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.82rem", marginBottom: 2, color: "var(--accent-primary, #22d3ee)" }}>
                    {label}
                  </div>
                  <div style={{ fontSize: "0.83rem", lineHeight: 1.6, color: "var(--text-secondary, #bbb)" }}>
                    {text}
                  </div>
                </div>
              ))}
              {r.cta && (
                <Link href={r.cta.href} style={{ fontSize: "0.8rem", fontWeight: 600, color: "#22d3ee", textDecoration: "none" }}>
                  {r.cta.label}
                </Link>
              )}
            </div>
          )}
        </section>
      ))}

      <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: 24, textAlign: "center" }}>
        Chartix is a technical-analysis and educational tool, not SEBI-registered investment advice.
        All trading decisions are yours.
      </p>
    </div>
  );
}
