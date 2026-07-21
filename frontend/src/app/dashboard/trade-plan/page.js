"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

const VERDICT_COLORS = {
  "Strong Setup": { bg: "rgba(16,185,129,0.14)", border: "#10b981", text: "#10b981" },
  "Watch": { bg: "rgba(245,158,11,0.14)", border: "#f59e0b", text: "#f59e0b" },
  "Weak / Avoid": { bg: "rgba(239,68,68,0.14)", border: "#ef4444", text: "#ef4444" },
};

const inr = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ background: "var(--bg-secondary, rgba(255,255,255,0.03))", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: "0.72rem", color: "var(--text-muted, #9ca3af)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: "1.15rem", fontWeight: 700, color: color || "var(--text-primary, #fff)" }}>{value}</div>
      {sub && <div style={{ fontSize: "0.72rem", color: "var(--text-muted, #9ca3af)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const rsColor = (rs) => (rs >= 70 ? "#10b981" : rs >= 50 ? "#f59e0b" : "#ef4444");

// Market-health banner shown atop the recommendation views. Tells the trader
// WHEN setups are worth trusting (breakouts pay in strong, broad markets).
function RegimeGauge({ regime }) {
  if (!regime) return null;
  const tone = regime.tone === "bull" ? { c: "#10b981", bg: "rgba(16,185,129,0.10)", b: "rgba(16,185,129,0.4)", icon: "🟢" }
    : regime.tone === "bear" ? { c: "#ef4444", bg: "rgba(239,68,68,0.10)", b: "rgba(239,68,68,0.4)", icon: "🔴" }
    : { c: "#f59e0b", bg: "rgba(245,158,11,0.10)", b: "rgba(245,158,11,0.4)", icon: "🟡" };
  const n = regime.nifty;
  return (
    <div style={{ background: tone.bg, border: `1px solid ${tone.b}`, borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "1.1rem" }}>{tone.icon}</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: "0.98rem", color: tone.c }}>
              Market Regime: {regime.label} <span style={{ color: "var(--text-muted,#9ca3af)", fontWeight: 600, fontSize: "0.8rem" }}>({regime.score}/100)</span>
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-secondary,#cbd5e1)", lineHeight: 1.4, marginTop: 2, maxWidth: 640 }}>{regime.note}</div>
          </div>
        </div>
        {n && (
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", textAlign: "right" }}>
            <div>NIFTY {n.close?.toLocaleString("en-IN")} <span style={{ color: n.ret_20d >= 0 ? "#10b981" : "#ef4444" }}>{n.ret_20d >= 0 ? "+" : ""}{n.ret_20d}% (20d)</span></div>
            <div>{n.above_50dma ? "▲ >50DMA" : "▼ <50DMA"} · {n.above_200dma ? "▲ >200DMA" : "▼ <200DMA"}</div>
          </div>
        )}
      </div>
      {/* 0–100 meter */}
      <div style={{ position: "relative", height: 8, borderRadius: 4, marginBottom: 8,
        background: "linear-gradient(90deg,#ef4444 0%,#ef4444 45%,#f59e0b 45%,#f59e0b 62%,#10b981 62%,#10b981 100%)" }}>
        <div style={{ position: "absolute", top: -3, left: `calc(${Math.max(0, Math.min(100, regime.score))}% - 7px)`,
          width: 14, height: 14, borderRadius: "50%", background: "#fff", border: `3px solid ${tone.c}`, boxShadow: "0 1px 4px rgba(0,0,0,0.4)" }} />
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)" }}>
        <span>Breadth: <b style={{ color: "var(--text-secondary,#cbd5e1)" }}>{regime.pct_above_50dma}%</b> &gt;50DMA · <b style={{ color: "var(--text-secondary,#cbd5e1)" }}>{regime.pct_above_200dma}%</b> &gt;200DMA</span>
        <span>Today: <b style={{ color: "#10b981" }}>{regime.advancers}</b> up / <b style={{ color: "#ef4444" }}>{regime.decliners}</b> down</span>
        <span style={{ color: "var(--text-muted,#9ca3af)" }}>across {regime.universe?.toLocaleString("en-IN")} stocks · as of {regime.as_of}</span>
      </div>
    </div>
  );
}

// Little score bar (0–100) for the 360 pillar columns
function Bar({ val }) {
  if (val == null) return <span style={{ color: "var(--text-muted,#9ca3af)" }}>—</span>;
  const c = val >= 70 ? "#10b981" : val >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden", minWidth: 40 }}>
        <div style={{ width: `${val}%`, height: "100%", background: c }} />
      </div>
      <span style={{ fontSize: "0.75rem", color: c, fontWeight: 600, width: 24 }}>{val}</span>
    </div>
  );
}

export default function TradePlanPage() {
  const [mode, setMode] = useState("reco"); // "reco" | "top" | "s360" | "single"

  // Auto recommendations
  const [reco, setReco] = useState(null);
  const [recoLoading, setRecoLoading] = useState(false);
  const [recoError, setRecoError] = useState("");
  const [recoSetup, setRecoSetup] = useState("all"); // all | breakout | pullback | reversal
  const [capital, setCapital] = useState(100000);
  const [riskPct, setRiskPct] = useState(1);

  // Sector / index filters (shared by both scanners)
  const [sectors, setSectors] = useState([]);
  const [indices, setIndices] = useState([]);
  const [sector, setSector] = useState("all");
  const [index, setIndex] = useState("all");
  useEffect(() => {
    api.listSectors().then((d) => setSectors(d || [])).catch(() => {});
    api.listIndices().then((d) => setIndices(d || [])).catch(() => {});
  }, []);

  // Top opportunities
  const [top, setTop] = useState(null);
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState("");

  // Single symbol
  const [symbol, setSymbol] = useState("");
  const [atrMult, setAtrMult] = useState(2);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 360 all-round
  const [s360, setS360] = useState(null);
  const [s360Loading, setS360Loading] = useState(false);
  const [s360Error, setS360Error] = useState("");

  // Market regime (global, cheap, cached server-side)
  const [regime, setRegime] = useState(null);

  // Paper trading
  const [paper, setPaper] = useState(null);       // { stats, trades }
  const [paperLoading, setPaperLoading] = useState(false);
  const [paperError, setPaperError] = useState("");
  const [paperMsg, setPaperMsg] = useState("");
  const emptyForm = { symbol: "", direction: "long", qty: 1, entry_price: "", entry_date: "", stop: "", target1: "", target2: "", setup: "", source: "manual", notes: "" };
  const [pf, setPf] = useState(emptyForm);         // paper-trade open form

  const loadPaper = async ({ silent } = {}) => {
    if (!silent) setPaperLoading(true);
    try {
      const data = await api.listPaperTrades();
      setPaper(data);
      setPaperError("");   // success clears any stale banner
    } catch (err) {
      // Tunnel hiccup: keep the last good table on screen rather than replacing
      // it with a scary "Load failed". Only surface the error when we have
      // nothing to show yet.
      setPaper((prev) => {
        if (!prev) setPaperError(err.message || "Failed to load paper trades.");
        return prev;
      });
    } finally {
      if (!silent) setPaperLoading(false);
    }
  };

  const submitPaper = async (e) => {
    e?.preventDefault?.();
    if (!pf.symbol || !pf.entry_price) { setPaperError("Symbol and entry price are required."); return; }
    setPaperError(""); setPaperMsg("");
    try {
      const body = {
        symbol: pf.symbol.toUpperCase().trim(),
        direction: pf.direction,
        qty: Math.max(1, parseInt(pf.qty, 10) || 1),
        entry_price: parseFloat(pf.entry_price),
        entry_date: pf.entry_date || undefined,
        stop: pf.stop === "" ? undefined : parseFloat(pf.stop),
        target1: pf.target1 === "" ? undefined : parseFloat(pf.target1),
        target2: pf.target2 === "" ? undefined : parseFloat(pf.target2),
        setup: pf.setup || undefined,
        source: pf.source || "manual",
        notes: pf.notes || undefined,
      };
      await api.openPaperTrade(body);
      setPf(emptyForm);
      setPaperMsg(`Opened paper trade in ${body.symbol}.`);
      await loadPaper();
    } catch (err) {
      setPaperError(err.status === 404 ? "Symbol not found." : (err.message || "Failed to open trade."));
    }
  };

  const closePaper = async (t) => {
    const price = parseFloat(prompt(`Close ${t.symbol} at what price?`, t.current_price ?? t.entry_price));
    if (!price || Number.isNaN(price)) return;
    try { await api.closePaperTrade(t.id, price); await loadPaper(); }
    catch (err) { setPaperError(err.message || "Failed to close."); }
  };

  const removePaper = async (t) => {
    if (!confirm(`Delete the paper trade in ${t.symbol}? This can't be undone.`)) return;
    try { await api.deletePaperTrade(t.id); await loadPaper(); }
    catch (err) { setPaperError(err.message || "Failed to delete."); }
  };

  // Prefill the paper-trade form from a recommendation card and jump to the tab
  const paperTradeFrom = (r) => {
    setPf({
      ...emptyForm,
      symbol: r.symbol,
      entry_price: r.entry ?? "",
      stop: r.stop ?? "",
      target1: r.target1 ?? "",
      target2: r.target2 ?? "",
      qty: r.shares || 1,
      setup: r.setup || "",
      source: "recommendation",
    });
    setPaperMsg(`Prefilled from the ${r.symbol} recommendation — review and open below.`);
    setPaperError("");
    setMode("paper");
  };

  const load360 = async () => {
    setS360Loading(true); setS360Error("");
    try {
      const data = await api.get360Scores({ allRoundOnly: true, limit: 50, sector, index });
      setS360(data);
    } catch (err) {
      setS360Error(err.message || "Failed to load scores.");
    } finally {
      setS360Loading(false);
    }
  };

  const loadTop = async () => {
    setTopLoading(true); setTopError("");
    try {
      const data = await api.getTopOpportunities({ capital, riskPct, limit: 50, sector, index });
      setTop(data);
    } catch (err) {
      setTopError(err.message || "Failed to load opportunities.");
    } finally {
      setTopLoading(false);
    }
  };

  // Load top 50 immediately on first open
  const loadReco = async (setupOverride) => {
    setRecoLoading(true); setRecoError("");
    try {
      const setupArg = setupOverride ?? recoSetup;
      const data = await api.getRecommendations({ capital, riskPct, limit: 24, sector, index, setup: setupArg });
      setReco(data);
    } catch (err) {
      setRecoError(err.message || "Failed to load recommendations.");
    } finally {
      setRecoLoading(false);
    }
  };

  // Recommendations are the default view — load them on first open
  useEffect(() => { loadReco(); /* eslint-disable-next-line */ }, []);
  // Market regime — load once on mount (used atop the reco / top views)
  useEffect(() => {
    api.getMarketRegime().then(setRegime).catch(() => {});
  }, []);
  // Lazy-load the Top 50 when that tab is first opened
  useEffect(() => {
    if (mode === "top" && !top && !topLoading) loadTop();
    /* eslint-disable-next-line */
  }, [mode]);

  // Lazy-load 360 the first time that tab is opened
  useEffect(() => {
    if (mode === "s360" && !s360 && !s360Loading) load360();
    /* eslint-disable-next-line */
  }, [mode]);

  // Lazy-load paper trades the first time that tab is opened
  useEffect(() => {
    if (mode === "paper" && !paper && !paperLoading) loadPaper();
    /* eslint-disable-next-line */
  }, [mode]);

  const runSingle = async (e) => {
    e?.preventDefault();
    if (!symbol.trim()) return;
    setLoading(true); setError(""); setPlan(null);
    try {
      const data = await api.getTradePlan(symbol.trim().toUpperCase(), { capital, riskPct, atrMult });
      setPlan(data);
    } catch (err) {
      setError(err.status === 422 ? "Not enough price history for this symbol." :
               err.status === 404 ? "Symbol not found." : (err.message || "Failed."));
    } finally {
      setLoading(false);
    }
  };

  const v = plan ? VERDICT_COLORS[plan.verdict] || VERDICT_COLORS["Watch"] : null;

  const numInput = {
    padding: "8px 12px", background: "var(--input-bg, #131722)", color: "var(--text-primary,#fff)",
    border: "1px solid var(--border-default,#333)", borderRadius: 8, width: "100%",
  };

  return (
    <div style={{ maxWidth: 1050, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 4 }}>🎯 Swing Trade Plan</h1>
        <p style={{ color: "var(--text-muted, #9ca3af)", fontSize: "0.9rem" }}>
          The market's best risk:reward setups, ranked — every stock scanned on technicals + fundamentals,
          fused with Relative Strength and our AI forecast. Or look up any symbol for its full plan.
        </p>
      </div>

      {/* Mode tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["reco", "🤖 Recommendations"], ["top", "🏆 Top 50 Opportunities"], ["s360", "🧬 360° All-Round"], ["single", "🔍 Single Symbol Plan"], ["paper", "📝 Paper Trades"]].map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)}
            style={{
              padding: "8px 16px", borderRadius: 8, fontSize: "0.85rem", fontWeight: 600, cursor: "pointer",
              background: mode === k ? "#2962ff" : "transparent",
              color: mode === k ? "#fff" : "var(--text-secondary,#cbd5e1)",
              border: mode === k ? "none" : "1px solid var(--border-default,#333)",
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* Sector / Index filters — for both scanner tabs */}
      {mode !== "single" && mode !== "paper" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 14 }}>
          <div style={{ flex: "1 1 220px" }}>
            <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>Sector</label>
            <select value={sector} onChange={(e) => setSector(e.target.value)}
              style={{ ...numInput, cursor: "pointer" }}>
              <option value="all">All Sectors</option>
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>Index</label>
            <select value={index} onChange={(e) => setIndex(e.target.value)}
              style={{ ...numInput, cursor: "pointer" }}>
              <option value="all">All Indices</option>
              {indices.map((ix) => <option key={ix.symbol} value={ix.symbol}>{ix.name}</option>)}
            </select>
          </div>
          <button
            onClick={mode === "reco" ? loadReco : mode === "top" ? loadTop : load360}
            disabled={mode === "reco" ? recoLoading : mode === "top" ? topLoading : s360Loading}
            style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontWeight: 700, cursor: "pointer", fontSize: "0.85rem" }}>
            Apply filters
          </button>
        </div>
      )}

      {/* Symbol / capital / risk / ATR inputs — only the single-symbol planner
          needs them. Recommendations & Top 50 are ranked automatically, so the
          old Capital/Risk/Refresh bar was just noise there. */}
      {mode === "single" && (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 20,
        background: "var(--bg-secondary, rgba(255,255,255,0.03))", padding: 16, borderRadius: 12 }}>
        {mode === "single" && (
          <div style={{ flex: "1 1 160px" }}>
            <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>Symbol</label>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. RELIANCE" style={numInput}
              onKeyDown={(e) => e.key === "Enter" && runSingle(e)} />
          </div>
        )}
        <div style={{ flex: "1 1 130px" }}>
          <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>Capital (₹)</label>
          <input type="number" value={capital} min={1000} step="any" onChange={(e) => setCapital(Number(e.target.value))} style={numInput} />
        </div>
        <div style={{ flex: "1 1 100px" }}>
          <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>Risk %</label>
          <input type="number" value={riskPct} min={0.25} max={10} step="any" onChange={(e) => setRiskPct(Number(e.target.value))} style={numInput} />
        </div>
        {mode === "single" && (
          <div style={{ flex: "1 1 100px" }}>
            <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>ATR × (stop)</label>
            <input type="number" value={atrMult} min={1} max={6} step="any" onChange={(e) => setAtrMult(Number(e.target.value))} style={numInput} />
          </div>
        )}
        <button
          onClick={mode === "reco" ? loadReco : mode === "top" ? loadTop : runSingle}
          disabled={mode === "reco" ? recoLoading : mode === "top" ? topLoading : loading}
          style={{ background: "#2962ff", color: "#fff", border: "none", borderRadius: 8, padding: "9px 22px", fontWeight: 700, cursor: "pointer", fontSize: "0.9rem" }}>
          {mode === "single" ? (loading ? "Building…" : "Build Plan")
            : (mode === "reco" ? recoLoading : topLoading) ? "Scanning…" : "Refresh"}
        </button>
      </div>
      )}

      {/* ── AUTO RECOMMENDATIONS ── */}
      {mode === "reco" && (
        <div>
          <RegimeGauge regime={regime} />
          {recoError && <div style={{ padding: 14, borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", color: "#ef4444", marginBottom: 12 }}>{recoError}</div>}
          {recoLoading && !reco && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted,#9ca3af)" }}>
              Scanning the market for high-confidence setups… (first load ~10s)
            </div>
          )}
          {reco && (
            <>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted,#9ca3af)", marginBottom: 10 }}>
                {reco.available_count > reco.count
                  ? <><b style={{ color: "var(--text-secondary,#cbd5e1)" }}>{reco.count} of {reco.available_count}</b> qualifying setups shown (weak-market cap)</>
                  : <>{reco.count} shown</>} · <b style={{ color: "#10b981" }}>every setup here has a &gt;50% back-tested win rate</b> (first target = 1R), ranked highest-first ·
                sub-50% grades are filtered out
              </div>
              {reco.earnings_shield?.excluded > 0 && (
                <div style={{ fontSize: "0.75rem", color: "#22d3ee", background: "rgba(34,211,238,0.08)",
                  border: "1px solid rgba(34,211,238,0.3)", borderRadius: 8, padding: "7px 12px", marginBottom: 12 }}>
                  🛡️ <b>Earnings Shield:</b> {reco.earnings_shield.excluded} setup{reco.earnings_shield.excluded > 1 ? "s" : ""} hidden — results within {reco.earnings_shield.exclude_days} days. Entering right before earnings is a coin-flip on the report, not a technical trade.
                </div>
              )}
              {reco.regime_adjustments && reco.regime_adjustments.tone !== "bull" && (
                <div style={{ fontSize: "0.75rem", color: reco.regime_adjustments.tone === "bear" ? "#ef4444" : "#f59e0b",
                  background: reco.regime_adjustments.tone === "bear" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
                  border: `1px solid ${reco.regime_adjustments.tone === "bear" ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}`,
                  borderRadius: 8, padding: "7px 12px", marginBottom: 12, lineHeight: 1.45 }}>
                  🛡️ <b>{reco.regime_adjustments.label} market — defenses applied automatically:</b> only setups with ≥{reco.regime_adjustments.win_rate_floor}% back-tested
                  win rate{reco.regime_adjustments.filtered_out > 0 && <> ({reco.regime_adjustments.filtered_out} weaker ones hidden)</>} ·
                  position size ×{reco.regime_adjustments.size_multiplier}
                </div>
              )}
              {/* Setup type filter + flip-through-all-on-charts */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                {[["all", `All (${(reco.setup_counts?.breakout || 0) + (reco.setup_counts?.pullback || 0) + (reco.setup_counts?.reversal || 0)})`],
                  ["breakout", `⚡ Breakout (${reco.setup_counts?.breakout || 0})`],
                  ["pullback", `📈 Pullback (${reco.setup_counts?.pullback || 0})`],
                  ["reversal", `🔄 Reversal (${reco.setup_counts?.reversal || 0})`]].map(([k, label]) => (
                  <button key={k}
                    onClick={() => { setRecoSetup(k); loadReco(k); }}
                    style={{
                      padding: "6px 14px", borderRadius: 20, fontSize: "0.78rem", fontWeight: 600, cursor: "pointer",
                      background: recoSetup === k ? "#2962ff" : "transparent",
                      color: recoSetup === k ? "#fff" : "var(--text-secondary,#cbd5e1)",
                      border: recoSetup === k ? "none" : "1px solid var(--border-default,#333)",
                    }}>
                    {label}
                  </button>
                ))}
                <ViewAllOnCharts
                  symbols={(reco.results || []).map((r) => r.symbol)}
                  label={`Swing recommendations${recoSetup !== "all" ? ` · ${recoSetup}` : ""}`}
                  style={{ marginLeft: "auto" }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 14 }}>
                {reco.results.map((r) => {
                  const setupColor = r.setup === "Breakout" ? "#f59e0b" : r.setup === "Pullback in uptrend" ? "#22d3ee" : "#a78bfa";
                  const confColor = r.confidence >= 80 ? "#10b981" : r.confidence >= 65 ? "#f59e0b" : "#9ca3af";
                  const wp = r.win_probability;
                  const wpColor = wp == null ? "#9ca3af" : wp >= 50 ? "#10b981" : wp >= 40 ? "#f59e0b" : "#ef4444";
                  const ed = r.earnings_in_days;
                  const warnDays = reco.earnings_shield?.warn_days ?? 10;
                  const earnWarn = ed != null && ed <= warnDays;
                  const earnColor = ed != null && ed <= 5 ? "#ef4444" : "#f59e0b";
                  return (
                    <div key={r.symbol} style={{
                      background: "var(--bg-secondary, rgba(255,255,255,0.03))",
                      border: "1px solid var(--border-subtle, rgba(255,255,255,0.09))",
                      borderRadius: 14, padding: "16px 18px",
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>{r.symbol}</div>
                          <div style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)" }}>{r.sector}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <span style={{ fontSize: "0.68rem", fontWeight: 700, color: setupColor, background: `${setupColor}22`, padding: "3px 9px", borderRadius: 8 }}>{r.setup}</span>
                          <div style={{ fontSize: "0.72rem", marginTop: 5, color: confColor, fontWeight: 700 }}>confidence {r.confidence}</div>
                          {earnWarn && (
                            <div style={{ fontSize: "0.66rem", marginTop: 5, color: earnColor, fontWeight: 700,
                              background: `${earnColor}18`, border: `1px solid ${earnColor}55`, padding: "2px 8px", borderRadius: 6, display: "inline-block" }}>
                              📊 Results in {ed}d ({r.earnings_date})
                            </div>
                          )}
                          {!earnWarn && ed != null && ed <= 21 && (
                            <div style={{ fontSize: "0.62rem", marginTop: 5, color: "var(--text-muted,#9ca3af)" }}>results {r.earnings_date}</div>
                          )}
                        </div>
                      </div>

                      <div style={{ fontSize: "0.78rem", color: "var(--text-secondary,#cbd5e1)", marginBottom: 10, lineHeight: 1.45 }}>
                        {r.entry_note}
                      </div>

                      {wp != null && (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10,
                          background: `${wpColor}14`, border: `1px solid ${wpColor}55`, borderRadius: 10, padding: "8px 12px" }}>
                          <div style={{ fontSize: "1.35rem", fontWeight: 800, color: wpColor, lineHeight: 1 }}>{wp}%</div>
                          <div style={{ fontSize: "0.68rem", color: "var(--text-secondary,#cbd5e1)", lineHeight: 1.35 }}>
                            back-tested win rate — hits target 1 (1R) before stop
                            {r.expectancy_r != null && <> · avg <b style={{ color: r.expectancy_r >= 0 ? "#10b981" : "#ef4444" }}>{r.expectancy_r >= 0 ? "+" : ""}{r.expectancy_r}R</b>/trade</>}
                          </div>
                        </div>
                      )}

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10, textAlign: "center" }}>
                        <div><div style={{ fontSize: "0.62rem", color: "var(--text-muted,#9ca3af)" }}>ENTRY</div><div style={{ fontWeight: 700, fontSize: "0.85rem" }}>{inr(r.entry)}</div></div>
                        <div><div style={{ fontSize: "0.62rem", color: "var(--text-muted,#9ca3af)" }}>STOP <span style={{ opacity: 0.7 }}>(close)</span></div><div style={{ fontWeight: 700, fontSize: "0.85rem", color: "#ef4444" }}>{inr(r.stop)}<div style={{ fontSize: "0.62rem" }}>{r.stop_pct}%</div></div></div>
                        <div><div style={{ fontSize: "0.62rem", color: "var(--text-muted,#9ca3af)" }}>TARGET 1</div><div style={{ fontWeight: 700, fontSize: "0.85rem", color: "#10b981" }}>{inr(r.target1)}<div style={{ fontSize: "0.62rem" }}>+{r.t1_pct}%</div></div></div>
                        <div><div style={{ fontSize: "0.62rem", color: "var(--text-muted,#9ca3af)" }}>TARGET 2</div><div style={{ fontWeight: 700, fontSize: "0.85rem", color: "#10b981" }}>{inr(r.target2)}<div style={{ fontSize: "0.62rem" }}>+{r.t2_pct}%</div></div></div>
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-secondary,#cbd5e1)", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                        <span>⏱ Hold: <b>{r.holding}</b></span>
                        <span>R:R <b>{r.reward_risk}:1</b></span>
                        <span>📦 <b>{r.shares} sh</b> ({inr(r.invested)})</span>
                      </div>

                      <div style={{ fontSize: "0.68rem", color: "var(--text-secondary,#cbd5e1)", marginBottom: 10,
                        background: "rgba(41,98,255,0.08)", border: "1px solid rgba(41,98,255,0.25)", borderRadius: 8, padding: "6px 10px", lineHeight: 1.4 }}>
                        📋 <b>Plan:</b> sell <b>½ at Target 1</b> (locks +1R), move stop to <b>breakeven</b>, run the rest to <b>Target 2</b>. Stop is on a <b>daily-close basis</b> — ignore intraday wicks.
                      </div>

                      {r.reasons?.length > 0 && (
                        <div style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", marginBottom: 10, lineHeight: 1.5 }}>
                          ✓ {r.reasons.join(" · ")}
                        </div>
                      )}

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <Link href={`/dashboard/charts?symbol=${r.symbol}`}
                          style={{ fontSize: "0.78rem", fontWeight: 600, color: "#2962ff", textDecoration: "none" }}>
                          Open chart →
                        </Link>
                        <button onClick={() => paperTradeFrom(r)}
                          style={{ fontSize: "0.75rem", fontWeight: 700, color: "#10b981", background: "rgba(16,185,129,0.12)",
                            border: "1px solid rgba(16,185,129,0.4)", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}>
                          📝 Paper trade this
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {reco.results.length === 0 && (
                <div style={{ textAlign: "center", padding: 30, color: "var(--text-muted,#9ca3af)" }}>
                  No setups clear the quality gates right now — that's the system being honest, not broken.
                  Try removing the sector/index filter, or check back after the next EOD update.
                </div>
              )}
              <p style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", marginTop: 16 }}>
                Auto-generated from EOD data: setup detection (breakout / pullback / reversal), structure+ATR stops,
                R-multiple targets checked against resistance, and holding time estimated from each stock's own volatility.
                Educational tool — not SEBI-registered investment advice. Always confirm on the chart.
              </p>
            </>
          )}
        </div>
      )}

      {/* ── 360° ALL-ROUND ── */}
      {mode === "s360" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary,#cbd5e1)", margin: 0, maxWidth: 680 }}>
              Stocks that pass on <strong>every front</strong> at once — strong technicals, real money flowing in
              (volume / accumulation), and sound fundamentals. The rare all-rounders.
            </p>
            <button onClick={load360} disabled={s360Loading}
              style={{ background: "#2962ff", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, cursor: "pointer", fontSize: "0.85rem" }}>
              {s360Loading ? "Scanning…" : "Refresh"}
            </button>
          </div>
          {s360Error && <div style={{ padding: 14, borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", color: "#ef4444" }}>{s360Error}</div>}
          {s360Loading && !s360 && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted,#9ca3af)" }}>Grading the whole market across every front… (first load ~13s)</div>
          )}
          {s360 && (
            <>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted,#9ca3af)", marginBottom: 10 }}>
                {s360.total_all_round} stocks are strong on all three fronts · showing top {s360.count}
              </div>
              <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", minWidth: 680 }}>
                  <thead>
                    <tr style={{ background: "var(--bg-secondary, rgba(255,255,255,0.04))", textAlign: "left" }}>
                      {["#", "Symbol", "Grade", "Overall", "Technical", "Money Flow", "Fundamental", ""].map((hh, i) => (
                        <th key={i} style={{ padding: "10px 12px", color: "var(--text-muted,#9ca3af)", fontWeight: 600, whiteSpace: "nowrap" }}>{hh}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s360.results.map((s, i) => (
                      <tr key={s.symbol} style={{ borderTop: "1px solid var(--border-subtle, rgba(255,255,255,0.06))" }}>
                        <td style={{ padding: "9px 12px", color: "var(--text-muted,#9ca3af)" }}>{i + 1}</td>
                        <td style={{ padding: "9px 12px" }}>
                          <div style={{ fontWeight: 700 }}>{s.symbol}</div>
                          <div style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.sector}</div>
                        </td>
                        <td style={{ padding: "9px 12px" }}>
                          <span style={{ fontWeight: 800, color: "#10b981", background: "rgba(16,185,129,0.12)", padding: "2px 8px", borderRadius: 6 }}>{s.grade}</span>
                        </td>
                        <td style={{ padding: "9px 12px", fontWeight: 700 }}>{s.overall}</td>
                        {[s.technical, s.money_flow, s.fundamental].map((val, j) => (
                          <td key={j} style={{ padding: "9px 12px", minWidth: 90 }}>
                            <Bar val={val} />
                          </td>
                        ))}
                        <td style={{ padding: "9px 12px" }}>
                          <Link href={`/dashboard/charts?symbol=${s.symbol}`} style={{ color: "#2962ff", textDecoration: "none", fontSize: "0.78rem", whiteSpace: "nowrap" }}>Chart →</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", marginTop: 14 }}>
                Each pillar is 0–100. Technical = trend + momentum + structure. Money Flow = OBV, CMF, MFI, up/down volume,
                accumulation. Fundamental = ROE, debt, margins, growth, valuation. All-round = clears the floor on all three.
              </p>
            </>
          )}
        </div>
      )}

      {/* ── TOP 50 TABLE ── */}
      {mode === "top" && (
        <div>
          <RegimeGauge regime={regime} />
          {topError && <div style={{ padding: 14, borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", color: "#ef4444" }}>{topError}</div>}
          {topLoading && !top && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted,#9ca3af)" }}>
              Scanning the whole market for the best setups… (first load ~10s)
            </div>
          )}
          {top && (
            <>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted,#9ca3af)", marginBottom: 10 }}>
                Ranked {top.universe_ranked}+ setups · showing top {top.count} · position sized for {inr(top.risk_amount)} risk ({top.risk_pct}% of {inr(top.capital)})
              </div>
              <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", minWidth: 720 }}>
                  <thead>
                    <tr style={{ background: "var(--bg-secondary, rgba(255,255,255,0.04))", textAlign: "left" }}>
                      {["#", "Symbol", "Entry", "Stop", "Target", "R:R", "RS", "Trend", "Fund", "AI", "Size", ""].map((h, i) => (
                        <th key={i} style={{ padding: "10px 12px", color: "var(--text-muted,#9ca3af)", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {top.results.map((s, i) => (
                      <tr key={s.symbol} style={{ borderTop: "1px solid var(--border-subtle, rgba(255,255,255,0.06))" }}>
                        <td style={{ padding: "9px 12px", color: "var(--text-muted,#9ca3af)" }}>{i + 1}</td>
                        <td style={{ padding: "9px 12px" }}>
                          <div style={{ fontWeight: 700 }}>{s.symbol}</div>
                          <div style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.sector}</div>
                        </td>
                        <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>{inr(s.entry)}</td>
                        <td style={{ padding: "9px 12px", whiteSpace: "nowrap", color: "#ef4444" }}>{inr(s.stop)}<span style={{ color: "var(--text-muted,#9ca3af)", fontSize: "0.7rem" }}> {s.stop_pct}%</span></td>
                        <td style={{ padding: "9px 12px", whiteSpace: "nowrap", color: "#10b981" }}>{inr(s.target)}<span style={{ color: "var(--text-muted,#9ca3af)", fontSize: "0.7rem" }}> +{s.target_pct}%</span></td>
                        <td style={{ padding: "9px 12px", fontWeight: 700 }}>{s.reward_risk}:1</td>
                        <td style={{ padding: "9px 12px", fontWeight: 700, color: rsColor(s.rs || 0) }}>{s.rs ?? "—"}</td>
                        <td style={{ padding: "9px 12px", color: s.trend_score >= 3 ? "#10b981" : "#f59e0b" }}>{s.trend_score}/4</td>
                        <td style={{ padding: "9px 12px" }}>{s.fund_quality}/3{s.roe != null ? <span style={{ color: "var(--text-muted,#9ca3af)", fontSize: "0.7rem" }}> · ROE {s.roe}%</span> : null}</td>
                        <td style={{ padding: "9px 12px", fontWeight: 700, color: s.ai_up ? "#10b981" : s.ai_up === false ? "#ef4444" : "var(--text-muted,#9ca3af)" }}>
                          {s.ai_up ? "↑" : s.ai_up === false ? "↓" : "·"}
                        </td>
                        <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>{s.shares} sh<div style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)" }}>{inr(s.invested)}</div></td>
                        <td style={{ padding: "9px 12px" }}>
                          <Link href={`/dashboard/charts?symbol=${s.symbol}`} style={{ color: "#2962ff", textDecoration: "none", fontSize: "0.78rem", whiteSpace: "nowrap" }}>Chart →</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", marginTop: 14 }}>
                R:R = distance to the recent resistance ÷ distance to the ATR/structure stop. Ranked by a composite of
                reward:risk, Relative Strength, trend health, fundamentals and AI direction. Educational — confirm on your own chart.
              </p>
            </>
          )}
        </div>
      )}

      {/* ── SINGLE SYMBOL PLAN ── */}
      {mode === "single" && (
        <div>
          {error && <div style={{ padding: 14, borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", color: "#ef4444", marginBottom: 16 }}>{error}</div>}
          {plan && (
            <div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: "1.3rem", fontWeight: 800 }}>{plan.symbol}
                    <span style={{ fontSize: "0.9rem", fontWeight: 400, color: "var(--text-muted,#9ca3af)", marginLeft: 8 }}>{plan.name} · {plan.sector}</span>
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted,#9ca3af)" }}>{inr(plan.price)} · ATR {inr(plan.atr)} · as of {plan.as_of}</div>
                </div>
                <div style={{ background: v.bg, border: `1.5px solid ${v.border}`, color: v.text, fontWeight: 800, fontSize: "1rem", padding: "8px 18px", borderRadius: 10 }}>{plan.verdict}</div>
              </div>
              {plan.verdict_reasons?.length > 0 && (
                <div style={{ fontSize: "0.82rem", color: "var(--text-secondary,#cbd5e1)", marginBottom: 18 }}>Why: {plan.verdict_reasons.join(" · ")}</div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 }}>
                <Stat label="Entry" value={inr(plan.plan.entry)} />
                <Stat label="Stop-loss" value={inr(plan.plan.stop)} sub={`${plan.plan.stop_pct}% · risk ${inr(plan.plan.risk_per_share)}/sh`} color="#ef4444" />
                <Stat label="Position size" value={`${plan.plan.shares} sh`} sub={`${inr(plan.plan.invested)} invested`} />
                <Stat label="₹ at risk" value={inr(plan.plan.risk_amount)} sub={`${plan.plan.risk_pct}% of ${inr(plan.plan.capital)}`} color="#f59e0b" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 18 }}>
                {plan.plan.targets.map((t, i) => (
                  <Stat key={i} label={`Target ${plan.plan.target_labels[i]}`} value={inr(t)} sub={`+${(((t / plan.plan.entry) - 1) * 100).toFixed(1)}%`} color="#10b981" />
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 18 }}>
                <Stat label="Relative Strength (1–99)" value={plan.relative_strength ?? "—"}
                  sub={plan.relative_strength >= 70 ? "market leader" : plan.relative_strength >= 50 ? "in-line" : "laggard"} color={rsColor(plan.relative_strength || 0)} />
                <Stat label="Trend health" value={`${plan.trend.score} / ${plan.trend.of}`}
                  sub={plan.trend.notes.length ? plan.trend.notes.join(", ") : "below key MAs"} color={plan.trend.score >= 3 ? "#10b981" : plan.trend.score >= 2 ? "#f59e0b" : "#ef4444"} />
                <Stat label="Reward : Risk (at 2R)" value={plan.plan.reward_risk_t2 ? `${plan.plan.reward_risk_t2} : 1` : "—"} />
              </div>
              {plan.ai_forecast ? (
                <div style={{ background: plan.ai_forecast.agrees_with_long ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)", border: `1px solid ${plan.ai_forecast.agrees_with_long ? "#10b981" : "#ef4444"}`, borderRadius: 10, padding: 14, marginBottom: 18 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>🤖 AI Forecast: {plan.ai_forecast.agrees_with_long ? "Agrees with a long" : "Disagrees — caution"}</div>
                  <div style={{ fontSize: "0.84rem", color: "var(--text-secondary,#cbd5e1)" }}>
                    LSTM projects {inr(plan.ai_forecast.predicted_close)} in {plan.ai_forecast.horizon_days} days ({plan.ai_forecast.expected_move_pct > 0 ? "+" : ""}{plan.ai_forecast.expected_move_pct}%). As of {plan.ai_forecast.as_of}.
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted,#9ca3af)", marginBottom: 18 }}>No AI forecast for this symbol yet.</div>
              )}
              <Link href={`/dashboard/charts?symbol=${plan.symbol}`} style={{ background: "#2962ff", color: "#fff", padding: "9px 18px", borderRadius: 8, textDecoration: "none", fontWeight: 600, fontSize: "0.85rem" }}>Open chart →</Link>
            </div>
          )}
          {!plan && !error && !loading && (
            <div style={{ textAlign: "center", padding: 30, color: "var(--text-muted,#9ca3af)" }}>Enter a symbol above to build its full trade plan.</div>
          )}
        </div>
      )}

      {/* ── PAPER TRADES ── */}
      {mode === "paper" && (
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "rgba(245,158,11,0.1)",
            border: "1px solid rgba(245,158,11,0.4)", borderRadius: 10, padding: "10px 14px", marginBottom: 16 }}>
            <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>⚠️</span>
            <div style={{ fontSize: "0.8rem", color: "#f59e0b", lineHeight: 1.5 }}>
              <b>For learning purposes only.</b> Paper trading is a simulation — no real money is involved and no order is
              ever placed. Nothing here is investment advice or a recommendation to buy or sell any security. We are not
              SEBI-registered. Do your own research and consult a registered advisor before trading real capital.
            </div>
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary,#cbd5e1)", marginTop: 0, marginBottom: 16, maxWidth: 720 }}>
            Log a simulated swing trade — from a recommendation above, or your own plan — and we score it against
            real end-of-day data: did price hit your target or stop after entry, what's the live P&amp;L and R-multiple,
            how long it's been held. No money moves. A risk-free way to see whether a plan actually works.
          </p>

          {/* Open a paper trade */}
          <form onSubmit={submitPaper} style={{ background: "var(--bg-secondary, rgba(255,255,255,0.03))", padding: 16, borderRadius: 12, marginBottom: 22 }}>
            <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: 12 }}>Open a paper trade</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
              {[
                ["symbol", "Symbol", "text", "e.g. RELIANCE", "1 1 130px"],
                ["entry_price", "Entry ₹", "number", "0.00", "1 1 100px"],
                ["qty", "Qty", "number", "1", "1 1 70px"],
                ["stop", "Stop ₹", "number", "optional", "1 1 100px"],
                ["target1", "Target 1 ₹", "number", "optional", "1 1 100px"],
                ["target2", "Target 2 ₹", "number", "optional", "1 1 100px"],
                ["entry_date", "Entry date", "date", "", "1 1 140px"],
              ].map(([key, label, type, ph, flex]) => (
                <div key={key} style={{ flex }}>
                  <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>{label}</label>
                  <input
                    type={type} placeholder={ph}
                    step={type === "number" ? "any" : undefined}
                    value={pf[key]}
                    onChange={(e) => setPf({ ...pf, [key]: type === "text" ? e.target.value.toUpperCase() : e.target.value })}
                    style={numInput} />
                </div>
              ))}
              <div style={{ flex: "1 1 110px" }}>
                <label style={{ fontSize: "0.72rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 4 }}>Direction</label>
                <select value={pf.direction} onChange={(e) => setPf({ ...pf, direction: e.target.value })} style={{ ...numInput, cursor: "pointer" }}>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </div>
              <button type="submit"
                style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "9px 22px", fontWeight: 700, cursor: "pointer", fontSize: "0.9rem" }}>
                Open trade
              </button>
            </div>
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", marginTop: 8 }}>
              Leave the entry date blank to enter at today. Backdate it to test a plan against what actually happened since.
            </div>
          </form>

          {paperError && <div style={{ padding: 12, borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", color: "#ef4444", marginBottom: 12 }}>{paperError}</div>}
          {paperMsg && <div style={{ padding: 12, borderRadius: 10, background: "rgba(16,185,129,0.1)", border: "1px solid #10b981", color: "#10b981", marginBottom: 12 }}>{paperMsg}</div>}

          {paperLoading && !paper && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted,#9ca3af)" }}>Loading your paper trades…</div>
          )}

          {paper && (
            <>
              {/* Summary stats */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 20 }}>
                <Stat label="Open" value={paper.stats.open} />
                <Stat label="Closed" value={paper.stats.closed} />
                <Stat label="Win rate" value={paper.stats.win_rate != null ? `${paper.stats.win_rate}%` : "—"}
                  color={paper.stats.win_rate != null ? (paper.stats.win_rate >= 50 ? "#10b981" : "#f59e0b") : undefined} />
                <Stat label="Avg R" value={paper.stats.avg_r != null ? `${paper.stats.avg_r}R` : "—"}
                  color={paper.stats.avg_r != null ? (paper.stats.avg_r >= 0 ? "#10b981" : "#ef4444") : undefined} />
                <Stat label="Total P&L" value={inr(paper.stats.total_pnl)}
                  color={paper.stats.total_pnl >= 0 ? "#10b981" : "#ef4444"} />
              </div>

              {paper.trades.length === 0 ? (
                <div style={{ textAlign: "center", padding: 30, color: "var(--text-muted,#9ca3af)" }}>
                  No paper trades yet. Open one above, or hit “📝 Paper trade this” on any recommendation.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem", minWidth: 820 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--text-muted,#9ca3af)", fontSize: "0.7rem", textTransform: "uppercase" }}>
                        {["Symbol", "Dir", "Entry", "Now / Exit", "Stop", "T1 / T2", "P&L", "R", "Held", "Status", ""].map((h) => (
                          <th key={h} style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-default,#333)", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {paper.trades.map((t) => {
                        const pnlColor = (t.pnl || 0) >= 0 ? "#10b981" : "#ef4444";
                        const statusStyle = t.phase === "runner"
                          ? { color: "#22d3ee", bg: "rgba(34,211,238,0.15)", label: "RUNNER ½" }
                          : t.status === "open"
                          ? { color: "#3b82f6", bg: "rgba(59,130,246,0.15)", label: "OPEN" }
                          : t.exit_reason === "stop"
                          ? { color: "#ef4444", bg: "rgba(239,68,68,0.15)", label: "STOPPED" }
                          : t.exit_reason === "target2"
                          ? { color: "#10b981", bg: "rgba(16,185,129,0.15)", label: "T1+T2 ✓" }
                          : t.exit_reason === "t1_then_be"
                          ? { color: "#10b981", bg: "rgba(16,185,129,0.15)", label: "T1 ✓ · B/E" }
                          : t.exit_reason === "target1"
                          ? { color: "#10b981", bg: "rgba(16,185,129,0.15)", label: "TARGET 1 ✓" }
                          : { color: "#9ca3af", bg: "rgba(148,163,184,0.15)", label: "CLOSED" };
                        return (
                          <tr key={t.id} style={{ borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.06))" }}>
                            <td style={{ padding: "10px", fontWeight: 700, whiteSpace: "nowrap" }}>
                              <Link href={`/dashboard/charts?symbol=${t.symbol}`} style={{ color: "var(--text-primary,#fff)", textDecoration: "none" }}>{t.symbol}</Link>
                              {t.setup && <div style={{ fontSize: "0.62rem", color: "var(--text-muted,#9ca3af)", fontWeight: 400 }}>{t.setup}</div>}
                              {t.status !== "closed" && t.earnings_in_days != null && t.earnings_in_days <= 7 && (
                                <div style={{ fontSize: "0.62rem", color: t.earnings_in_days <= 3 ? "#ef4444" : "#f59e0b", fontWeight: 700 }}>
                                  📊 results in {t.earnings_in_days}d — exit or hold through?
                                </div>
                              )}
                            </td>
                            <td style={{ padding: "10px", color: t.direction === "short" ? "#f59e0b" : "#22d3ee", fontWeight: 600 }}>{(t.direction || "long").toUpperCase()}</td>
                            <td style={{ padding: "10px", whiteSpace: "nowrap" }}>{inr(t.entry_price)}<div style={{ fontSize: "0.62rem", color: "var(--text-muted,#9ca3af)" }}>{t.entry_date}</div></td>
                            <td style={{ padding: "10px", whiteSpace: "nowrap" }}>
                              {t.status === "closed" && t.exit_price != null ? <>{inr(t.exit_price)}<div style={{ fontSize: "0.62rem", color: "var(--text-muted,#9ca3af)" }}>{t.exit_date}</div></> : inr(t.current_price)}
                            </td>
                            <td style={{ padding: "10px", color: "#ef4444", whiteSpace: "nowrap" }}>{t.stop != null ? inr(t.stop) : "—"}</td>
                            <td style={{ padding: "10px", color: "#10b981", whiteSpace: "nowrap", fontSize: "0.72rem" }}>
                              {t.target1 != null ? inr(t.target1) : "—"}{t.target2 != null ? ` / ${inr(t.target2)}` : ""}
                            </td>
                            <td style={{ padding: "10px", color: pnlColor, fontWeight: 700, whiteSpace: "nowrap" }}>
                              {(t.pnl || 0) >= 0 ? "+" : ""}{inr(t.pnl)}<div style={{ fontSize: "0.62rem" }}>{(t.pnl_pct || 0) >= 0 ? "+" : ""}{t.pnl_pct}%</div>
                            </td>
                            <td style={{ padding: "10px", color: t.r_multiple != null ? ((t.r_multiple >= 0) ? "#10b981" : "#ef4444") : "#9ca3af", fontWeight: 700, whiteSpace: "nowrap" }}>
                              {t.r_multiple != null ? `${t.r_multiple >= 0 ? "+" : ""}${t.r_multiple}R` : "—"}
                            </td>
                            <td style={{ padding: "10px", whiteSpace: "nowrap" }}>{t.days_held}d</td>
                            <td style={{ padding: "10px" }}>
                              <span style={{ fontSize: "0.62rem", fontWeight: 700, color: statusStyle.color, background: statusStyle.bg, padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap" }}>{statusStyle.label}</span>
                            </td>
                            <td style={{ padding: "10px", whiteSpace: "nowrap" }}>
                              {t.status === "open" && (
                                <button onClick={() => closePaper(t)} title="Close manually at a price"
                                  style={{ fontSize: "0.68rem", color: "#f59e0b", background: "transparent", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", marginRight: 6 }}>Close</button>
                              )}
                              <button onClick={() => removePaper(t)} title="Delete this paper trade"
                                style={{ fontSize: "0.68rem", color: "#ef4444", background: "transparent", border: "1px solid rgba(239,68,68,0.35)", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>✕</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", marginTop: 16 }}>
                Trades are scored with the <b>scale-out plan</b>: half the position is booked at Target 1, the stop on the
                runner moves to <b>breakeven</b>, and the rest runs to Target 2. <b>RUNNER ½</b> = first half booked, runner
                still live; <b>T1 ✓ · B/E</b> = runner later stopped at breakeven; <b>T1+T2 ✓</b> = both hit. Stops are on a
                <b>closing basis</b> — only a daily <i>close</i> beyond the stop exits the trade (no intraday wick-outs),
                and it exits at that close. Targets fill intraday on touch. Educational tool, not investment advice.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
