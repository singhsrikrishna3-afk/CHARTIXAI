"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Spotlight tour of the real Chartix UI. Dims the app, highlights one element
 * at a time (via [data-tour="…"] anchors in the dashboard layout) and shows a
 * short card next to it. Mounted once in the dashboard layout.
 *
 * Start it from anywhere with startChartixTour(router?):
 *  - on /dashboard it starts immediately (custom event)
 *  - elsewhere it sets a pending flag and navigates; the overlay picks the
 *    flag up when the pathname becomes /dashboard (layout never remounts).
 */

const PENDING_KEY = "chartix_tour_pending";
const SEEN_KEY = "chartix_tour_seen";

export function startChartixTour(router) {
  try { localStorage.setItem(PENDING_KEY, "1"); } catch (e) {}
  if (typeof window !== "undefined" && window.location.pathname === "/dashboard") {
    window.dispatchEvent(new Event("chartix:start-tour"));
  } else if (router) {
    router.push("/dashboard");
  }
}

const STEPS = [
  {
    id: "welcome",
    emoji: "👋",
    title: "Welcome to Chartix",
    body: "60 seconds, 10 stops — we'll point at the real buttons, not describe them. Use → / ← on your keyboard, or Esc to bail out anytime.",
  },
  {
    id: "search",
    target: "search",
    emoji: "🔍",
    title: "Find anything, instantly",
    body: "2,700+ NSE stocks, indices, gold, crude, USDINR. Type a few letters, hit Enter, and you're on its chart.",
  },
  {
    id: "ticker",
    target: "ticker",
    emoji: "📟",
    title: "The tape",
    body: "Yesterday-close pulse of the major indices. Every chip is clickable — one tap charts that index.",
  },
  {
    id: "charts",
    target: "charts",
    emoji: "📈",
    title: "Your cockpit",
    body: "44 indicators, 10+ chart styles, drawing tools — and everything you set up auto-saves, so your chart is exactly how you left it.",
  },
  {
    id: "patterns",
    target: "patterns",
    emoji: "🔮",
    title: "While you were away…",
    body: "Chartix scans ~2,000 stocks for 19 chart patterns every evening — head & shoulders, triangles, wedges. Open this to see today's catch.",
  },
  {
    id: "other-scans",
    target: "other-scans",
    emoji: "🔭",
    title: "Scans for every style",
    body: "Breakouts, VCP, divergences, 52-week highs, gaps… Not sure what settings to use? Every scan has a ✨ Recommended button — proven parameters, one click.",
  },
  {
    id: "scanners",
    target: "scanners",
    emoji: "🎯",
    title: "Build your own scan — no code",
    body: "Stack conditions like “RSI < 35 AND price > SMA 200”, hit Run, save it, and re-run it any evening after the data update.",
  },
  {
    id: "assistant",
    target: "assistant",
    emoji: "💬",
    title: "Or just say it in English",
    body: "Type “golden crossover in nifty 50” or “forecast RELIANCE” — the assistant picks the right scan and runs it for you.",
  },
  {
    id: "replay",
    target: "replay",
    emoji: "⏪",
    title: "A flight simulator for trading",
    body: "Bar Replay steps you through past markets one candle at a time. Test your eye on history — zero money at risk.",
  },
  {
    id: "watchlist",
    target: "watchlist",
    emoji: "⭐",
    title: "Make it yours",
    body: "Star symbols into a watchlist, log holdings in the portfolio, and set price or pattern alerts — the 🔔 bell up top lights up when one fires.",
  },
  {
    id: "done",
    emoji: "🎉",
    title: "That's the lay of the land",
    body: "Best way to learn the rest: fly it. Open your first chart, or work through the First Missions — 6 small tasks that make you operational.",
  },
];

const CARD_W = 330;
const GAP = 14; // spotlight padding + card offset

export default function TourOverlay() {
  const pathname = usePathname();
  const router = useRouter();
  const [step, setStep] = useState(-1); // -1 = inactive
  const [rect, setRect] = useState(null); // spotlight rect (null = centered card)
  const active = step >= 0;

  const start = useCallback(() => {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
    setStep(0);
  }, []);

  const stop = useCallback(() => {
    setStep(-1);
    setRect(null);
    try { localStorage.setItem(SEEN_KEY, "1"); } catch (e) {}
  }, []);

  // Same-page start (welcome banner, guide page when already on /dashboard)
  useEffect(() => {
    window.addEventListener("chartix:start-tour", start);
    return () => window.removeEventListener("chartix:start-tour", start);
  }, [start]);

  // Cross-page start: guide sets the pending flag then navigates here
  useEffect(() => {
    if (pathname !== "/dashboard") return;
    try {
      if (localStorage.getItem(PENDING_KEY)) start();
    } catch (e) {}
  }, [pathname, start]);

  // Measure the current step's target (and re-measure on resize/scroll)
  useEffect(() => {
    if (!active) return;
    const s = STEPS[step];
    const measure = () => {
      const el = s.target ? document.querySelector(`[data-tour="${s.target}"]`) : null;
      if (!el || el.offsetParent === null) { setRect(null); return; } // hidden (mobile drawer) → centered card
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { setRect(null); return; }
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const el = s.target ? document.querySelector(`[data-tour="${s.target}"]`) : null;
    if (el) el.scrollIntoView({ block: "nearest" });
    // measure after the scroll settles
    const t = setTimeout(measure, 60);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, step]);

  // Keyboard: → / Enter next, ← back, Esc skip
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        setStep((x) => (x < STEPS.length - 1 ? x + 1 : (stop(), -1)));
      } else if (e.key === "ArrowLeft") { e.preventDefault(); setStep((x) => Math.max(0, x - 1)); }
      else if (e.key === "Escape") { e.preventDefault(); stop(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, stop]);

  if (!active) return null;

  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  // Card placement: right of the spotlight if it fits, else below, else above,
  // clamped to the viewport. No target → centered.
  let cardStyle;
  if (rect) {
    const spaceRight = vw - (rect.left + rect.width) - 2 * GAP;
    const spaceBelow = vh - (rect.top + rect.height) - 2 * GAP;
    let top, left;
    if (spaceRight >= CARD_W) {
      left = rect.left + rect.width + GAP + 6;
      top = Math.min(Math.max(GAP, rect.top - 8), vh - 240);
    } else if (spaceBelow >= 200) {
      top = rect.top + rect.height + GAP;
      left = Math.min(Math.max(GAP, rect.left), vw - CARD_W - GAP);
    } else {
      top = Math.max(GAP, rect.top - 220);
      left = Math.min(Math.max(GAP, rect.left), vw - CARD_W - GAP);
    }
    cardStyle = { position: "fixed", top, left, width: Math.min(CARD_W, vw - 2 * GAP) };
  } else {
    cardStyle = {
      position: "fixed", top: "50%", left: "50%",
      transform: "translate(-50%, -50%)", width: Math.min(CARD_W + 40, vw - 2 * GAP),
    };
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 400 }}>
      <style>{`
        @keyframes chartixTourIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        @keyframes chartixTourPulse {
          0%, 100% { box-shadow: 0 0 0 100vmax rgba(4, 8, 18, 0.78), 0 0 0 2px rgba(34,211,238,0.9), 0 0 22px rgba(34,211,238,0.45); }
          50%      { box-shadow: 0 0 0 100vmax rgba(4, 8, 18, 0.78), 0 0 0 2px rgba(34,211,238,0.9), 0 0 36px rgba(34,211,238,0.8); }
        }
      `}</style>

      {/* Spotlight (its huge box-shadow is the dimmer) — or a plain dimmer when no target */}
      {rect ? (
        <div style={{
          position: "fixed",
          top: rect.top - 6, left: rect.left - 6,
          width: rect.width + 12, height: rect.height + 12,
          borderRadius: 10,
          animation: "chartixTourPulse 2s ease-in-out infinite",
          transition: "top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease",
          pointerEvents: "none",
        }} />
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(4, 8, 18, 0.78)" }} />
      )}

      {/* Click-catcher so the app underneath isn't clickable mid-tour */}
      <div style={{ position: "fixed", inset: 0 }} onClick={() => {}} />

      {/* Step card */}
      <div key={step} style={{
        ...cardStyle,
        background: "var(--bg-secondary, #121824)",
        border: "1px solid rgba(34,211,238,0.4)",
        borderRadius: 14,
        padding: "18px 20px 14px",
        boxShadow: "0 18px 50px rgba(0,0,0,0.6)",
        animation: "chartixTourIn 0.22s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 26 }}>{s.emoji}</span>
          <div style={{ fontWeight: 800, fontSize: "1.02rem", color: "var(--text-primary, #e5e7eb)" }}>
            {s.title}
          </div>
        </div>
        <div style={{ fontSize: "0.86rem", lineHeight: 1.55, color: "var(--text-secondary, #b6bcc9)", marginBottom: 14 }}>
          {s.body}
        </div>

        {last ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button className="btn btn-primary" style={{ padding: "8px 14px", fontSize: "0.8rem" }}
              onClick={() => { stop(); router.push("/dashboard/charts?symbol=RELIANCE"); }}>
              📈 Open your first chart
            </button>
            <button className="btn" style={{
              padding: "8px 14px", fontSize: "0.8rem", cursor: "pointer",
              background: "transparent", border: "1px solid var(--border-default, #333)",
              color: "var(--text-primary, #e5e7eb)", borderRadius: 8,
            }}
              onClick={() => { stop(); router.push("/dashboard/guide"); }}>
              🏁 First Missions
            </button>
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* progress dots */}
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            {STEPS.map((_, i) => (
              <span key={i} style={{
                width: i === step ? 16 : 6, height: 6, borderRadius: 3,
                background: i === step ? "#22d3ee" : i < step ? "rgba(34,211,238,0.45)" : "rgba(255,255,255,0.15)",
                transition: "all 0.2s ease",
              }} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={stop} style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--text-muted, #7c8496)", fontSize: "0.75rem", padding: "6px 4px",
              whiteSpace: "nowrap",
            }}>
              Skip
            </button>
            {step > 0 && (
              <button onClick={() => setStep(step - 1)} style={{
                background: "transparent", border: "1px solid var(--border-default, #333)",
                color: "var(--text-primary, #e5e7eb)", borderRadius: 8,
                padding: "6px 12px", fontSize: "0.78rem", cursor: "pointer",
                whiteSpace: "nowrap",
              }}>
                ← Back
              </button>
            )}
            <button className="btn btn-primary" onClick={() => (last ? stop() : setStep(step + 1))}
              style={{ padding: "6px 14px", fontSize: "0.78rem", whiteSpace: "nowrap" }}>
              {last ? "Finish" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
