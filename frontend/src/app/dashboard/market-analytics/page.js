"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

/**
 * Market Analytics — Stage Analysis, Market Breadth, RS Leaders, Peer Compare.
 * All computed from the full EOD universe (~2,100 stocks) + fundamentals.
 */

const STAGE_META = {
  1: { label: "Stage 1 · Basing", color: "#9ca3af", desc: "below a flattening 150-DMA — building a base after a decline" },
  2: { label: "Stage 2 · Advancing", color: "#10b981", desc: "above a rising 150-DMA — the stage swing longs live in" },
  3: { label: "Stage 3 · Topping", color: "#f59e0b", desc: "above a flattening/falling 150-DMA — distribution risk" },
  4: { label: "Stage 4 · Declining", color: "#ef4444", desc: "below a falling 150-DMA — avoid longs" },
};

const card = { background: "var(--bg-secondary, rgba(255,255,255,0.03))", border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))", borderRadius: 12, padding: "14px 16px" };
const th = { textAlign: "left", padding: "6px 8px", fontSize: "0.68rem", color: "var(--text-muted,#9ca3af)", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid var(--border-subtle,#333)" };
const td = { padding: "7px 8px", fontSize: "0.82rem", borderBottom: "1px solid var(--border-subtle,rgba(255,255,255,0.06))" };

function Spark({ pts, color = "#22d3ee", h = 42, zero = false }) {
  if (!pts || pts.length < 2) return null;
  const w = 260;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const xy = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`).join(" ");
  const zeroY = zero && min < 0 && max > 0 ? h - ((0 - min) / span) * (h - 4) - 2 : null;
  return (
    <svg width={w} height={h} style={{ display: "block", maxWidth: "100%" }}>
      {zeroY != null && <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="var(--text-muted,#666)" strokeDasharray="3,3" strokeWidth={0.7} />}
      <polyline points={xy} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  );
}

export default function MarketAnalyticsPage() {
  const [tab, setTab] = useState("stages");
  const [stages, setStages] = useState(null);
  const [breadth, setBreadth] = useState(null);
  const [leaders, setLeaders] = useState(null);
  const [minRs, setMinRs] = useState(80);
  const [stageFilter, setStageFilter] = useState(2);
  const [peerSym, setPeerSym] = useState("");
  const [peers, setPeers] = useState(null);
  const [peerErr, setPeerErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    if (tab === "stages" && !stages) api.getStageAnalysis().then(setStages).catch(() => {}).finally(() => setLoading(false));
    else if (tab === "breadth" && !breadth) api.getMarketBreadth(120).then(setBreadth).catch(() => {}).finally(() => setLoading(false));
    else if (tab === "leaders") { setLeaders(null); api.getRsLeaders(minRs, 150).then(setLeaders).catch(() => {}).finally(() => setLoading(false)); }
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, minRs]);

  const loadPeers = useCallback(() => {
    const s = peerSym.trim().toUpperCase();
    if (!s) return;
    setPeers(null); setPeerErr(null); setLoading(true);
    api.getPeers(s).then(setPeers).catch((e) => setPeerErr(e.message || "No industry data")).finally(() => setLoading(false));
  }, [peerSym]);

  const stageStocks = (stages?.stocks || []).filter((s) => s.stage === stageFilter);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 800, margin: "0 0 4px" }}>🔬 Market Analytics</h1>
      <p style={{ color: "var(--text-secondary,#9ca3af)", fontSize: "0.85rem", margin: "0 0 16px" }}>
        Stage analysis, breadth and relative-strength across the full NSE universe — computed from every bar in the database.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {[["stages", "🎯 Stage Analysis"], ["breadth", "📊 Market Breadth"], ["leaders", "🚀 RS Leaders"], ["peers", "⚖️ Peer Compare"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: "8px 16px", borderRadius: 20, fontSize: "0.82rem", fontWeight: 700, cursor: "pointer",
            background: tab === k ? "#2962ff" : "transparent",
            color: tab === k ? "#fff" : "var(--text-secondary,#cbd5e1)",
            border: tab === k ? "none" : "1px solid var(--border-default,#333)",
          }}>{label}</button>
        ))}
      </div>

      {loading && <div style={{ padding: 30, textAlign: "center", color: "var(--text-muted,#9ca3af)" }}>Computing across the universe…</div>}

      {tab === "stages" && stages && (
        <>
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 10 }}>
              Where the market is — {stages.universe.toLocaleString("en-IN")} stocks by Weinstein stage
            </div>
            <div style={{ display: "flex", height: 26, borderRadius: 8, overflow: "hidden", marginBottom: 10 }}>
              {[1, 2, 3, 4].map((s) => (
                <div key={s} title={`${STAGE_META[s].label}: ${stages.distribution[s]} (${stages.distribution_pct[s]}%)`}
                  style={{ width: `${stages.distribution_pct[s]}%`, background: STAGE_META[s].color, minWidth: 8 }} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}>
              {[1, 2, 3, 4].map((s) => (
                <div key={s} style={{ fontSize: "0.75rem", color: "var(--text-secondary,#cbd5e1)" }}>
                  <span style={{ color: STAGE_META[s].color, fontWeight: 800 }}>■ {STAGE_META[s].label}</span>{" "}
                  <b>{stages.distribution[s]}</b> ({stages.distribution_pct[s]}%)
                  <div style={{ color: "var(--text-muted,#8b93a3)", marginTop: 2 }}>{STAGE_META[s].desc}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 14, marginBottom: 14 }}>
            <div style={card}>
              <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 8 }}>By market cap</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Bucket</th>{[1, 2, 3, 4].map((s) => <th key={s} style={{ ...th, color: STAGE_META[s].color }}>S{s}</th>)}</tr></thead>
                <tbody>
                  {["large", "mid", "small"].map((b) => (
                    <tr key={b}>
                      <td style={{ ...td, textTransform: "capitalize", fontWeight: 600 }}>{b}</td>
                      {[1, 2, 3, 4].map((s) => <td key={s} style={td}>{stages.by_mcap[b][s]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={card}>
              <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 8 }}>Industries leading (share of stocks in Stage 2)</div>
              {stages.industries.slice(0, 8).map((i) => (
                <div key={i.industry} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", padding: "3px 0" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>{i.industry}</span>
                  <span><b style={{ color: "#10b981" }}>{i.stage2_pct}%</b> <span style={{ color: "var(--text-muted,#8b93a3)" }}>of {i.n}</span></span>
                </div>
              ))}
            </div>
          </div>

          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <div style={{ fontSize: "0.8rem", fontWeight: 700, flex: 1 }}>Stocks by stage</div>
              {[1, 2, 3, 4].map((s) => (
                <button key={s} onClick={() => setStageFilter(s)} style={{
                  padding: "4px 12px", borderRadius: 14, fontSize: "0.74rem", fontWeight: 700, cursor: "pointer",
                  background: stageFilter === s ? STAGE_META[s].color : "transparent",
                  color: stageFilter === s ? "#0b0e14" : STAGE_META[s].color,
                  border: `1px solid ${STAGE_META[s].color}`,
                }}>S{s} ({stages.distribution[s]})</button>
              ))}
              <ViewAllOnCharts symbols={stageStocks.map((s) => s.symbol)} label={`${STAGE_META[stageFilter].label} stocks`} />
            </div>
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Symbol</th><th style={th}>Industry</th><th style={th}>RS</th><th style={th}>vs 150-DMA</th><th style={th}>Price</th></tr></thead>
                <tbody>
                  {stageStocks.slice(0, 120).map((s) => (
                    <tr key={s.symbol}>
                      <td style={{ ...td, fontWeight: 700 }}>{s.symbol}</td>
                      <td style={{ ...td, color: "var(--text-secondary,#cbd5e1)" }}>{s.industry}</td>
                      <td style={{ ...td, color: (s.rs || 0) >= 70 ? "#10b981" : "var(--text-secondary,#cbd5e1)", fontWeight: 700 }}>{s.rs ?? "—"}</td>
                      <td style={{ ...td, color: s.ma_dist_pct >= 0 ? "#10b981" : "#ef4444" }}>{s.ma_dist_pct > 0 ? "+" : ""}{s.ma_dist_pct}%</td>
                      <td style={td}>{s.price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: "0.68rem", color: "var(--text-muted,#8b93a3)", marginTop: 8 }}>{stages.method}</div>
          </div>
        </>
      )}

      {tab === "breadth" && breadth && breadth.latest && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10, marginBottom: 14 }}>
            {[
              ["Advances / Declines", `${breadth.latest.advances} / ${breadth.latest.declines}`, breadth.latest.net >= 0 ? "#10b981" : "#ef4444"],
              ["McClellan Osc.", breadth.latest.mcclellan, breadth.latest.mcclellan >= 0 ? "#10b981" : "#ef4444"],
              ["New 52w Highs / Lows", `${breadth.latest.new_highs} / ${breadth.latest.new_lows}`, breadth.latest.new_highs >= breadth.latest.new_lows ? "#10b981" : "#ef4444"],
              ["% above 50-DMA", `${breadth.latest.pct_above_50}%`, breadth.latest.pct_above_50 >= 50 ? "#10b981" : "#ef4444"],
              ["% above 200-DMA", `${breadth.latest.pct_above_200}%`, breadth.latest.pct_above_200 >= 50 ? "#10b981" : "#ef4444"],
            ].map(([label, val, color]) => (
              <div key={label} style={card}>
                <div style={{ fontSize: "0.68rem", color: "var(--text-muted,#9ca3af)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 800, color }}>{val}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
            {[
              ["McClellan oscillator (breadth momentum)", breadth.series.map((s) => s.mcclellan), "#22d3ee", true],
              ["Cumulative A/D line", breadth.series.map((s) => s.ad_line), "#a78bfa", false],
              ["% of stocks above 50-DMA", breadth.series.map((s) => s.pct_above_50 ?? 0), "#10b981", false],
              ["Net new 52-week highs", breadth.series.map((s) => s.new_highs - s.new_lows), "#f59e0b", true],
            ].map(([label, pts, color, zero]) => (
              <div key={label} style={card}>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, marginBottom: 8 }}>{label}</div>
                <Spark pts={pts} color={color} zero={zero} />
                <div style={{ fontSize: "0.66rem", color: "var(--text-muted,#8b93a3)", marginTop: 4 }}>last {breadth.days} sessions</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "0.68rem", color: "var(--text-muted,#8b93a3)", marginTop: 10 }}>{breadth.note}</div>
        </>
      )}

      {tab === "leaders" && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, flex: 1 }}>
              Relative-strength leaders {leaders ? `(${leaders.count})` : ""}
            </div>
            <label style={{ fontSize: "0.75rem", color: "var(--text-secondary,#cbd5e1)" }}>Min RS:</label>
            {[70, 80, 90].map((v) => (
              <button key={v} onClick={() => setMinRs(v)} style={{
                padding: "4px 12px", borderRadius: 14, fontSize: "0.74rem", fontWeight: 700, cursor: "pointer",
                background: minRs === v ? "#2962ff" : "transparent", color: minRs === v ? "#fff" : "var(--text-secondary,#cbd5e1)",
                border: minRs === v ? "none" : "1px solid var(--border-default,#333)",
              }}>{v}+</button>
            ))}
            {leaders && <ViewAllOnCharts symbols={leaders.leaders.map((l) => l.symbol)} label={`RS ${minRs}+ leaders`} />}
          </div>
          {leaders && (
            <div style={{ maxHeight: 480, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Symbol</th><th style={th}>RS</th><th style={th}>Stage</th><th style={th}>1M</th><th style={th}>3M</th><th style={th}>Industry</th></tr></thead>
                <tbody>
                  {leaders.leaders.map((l) => (
                    <tr key={l.symbol}>
                      <td style={{ ...td, fontWeight: 700 }}>{l.symbol}</td>
                      <td style={{ ...td, fontWeight: 800, color: "#10b981" }}>{l.rs}</td>
                      <td style={{ ...td, color: STAGE_META[l.stage]?.color }}>{l.stage ? `S${l.stage}` : "—"}</td>
                      <td style={{ ...td, color: (l.ret_1m || 0) >= 0 ? "#10b981" : "#ef4444" }}>{l.ret_1m}%</td>
                      <td style={{ ...td, color: (l.ret_3m || 0) >= 0 ? "#10b981" : "#ef4444" }}>{l.ret_3m}%</td>
                      <td style={{ ...td, color: "var(--text-secondary,#cbd5e1)" }}>{l.industry}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ fontSize: "0.68rem", color: "var(--text-muted,#8b93a3)", marginTop: 8 }}>
            RS = IBD-style weighted 3/6/9/12-month return, percentile-ranked against the whole universe. Backtest note: RS works best as a filter WITHIN a setup (pullback/breakout/reversal), not as a blind buy list.
          </div>
        </div>
      )}

      {tab === "peers" && (
        <div style={card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={peerSym} onChange={(e) => setPeerSym(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && loadPeers()}
              placeholder="Symbol — e.g. RELIANCE" style={{
                flex: 1, maxWidth: 260, padding: "8px 12px", borderRadius: 8, fontSize: "0.85rem",
                border: "1px solid var(--border-default,#333)", background: "var(--input-bg,#131722)", color: "var(--text-primary,#e5e7eb)",
              }} />
            <button onClick={loadPeers} className="btn btn-primary" style={{ padding: "8px 18px", fontSize: "0.8rem" }}>Compare</button>
          </div>
          {peerErr && <div style={{ color: "#ef4444", fontSize: "0.8rem" }}>{peerErr}</div>}
          {peers && (
            <>
              <div style={{ fontSize: "0.78rem", color: "var(--text-secondary,#cbd5e1)", marginBottom: 8 }}>
                <b>{peers.industry}</b> — {peers.count} listed peers, largest first
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                  <thead><tr>{["Symbol", "MCap (₹cr)", "P/E", "ROE %", "Margin %", "D/E", "Rev growth", "RS", "3M %"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {peers.peers.map((p) => (
                      <tr key={p.symbol} style={p.is_self ? { background: "rgba(41,98,255,0.12)" } : undefined}>
                        <td style={{ ...td, fontWeight: p.is_self ? 800 : 600 }}>{p.symbol}{p.is_self ? " ◀" : ""}</td>
                        <td style={td}>{p.mcap_cr?.toLocaleString("en-IN") ?? "—"}</td>
                        <td style={td}>{p.pe != null ? p.pe.toFixed(1) : "—"}</td>
                        <td style={td}>{p.roe ?? "—"}</td>
                        <td style={td}>{p.margin ?? "—"}</td>
                        <td style={td}>{p.dte ?? "—"}</td>
                        <td style={td}>{p.rev_growth != null ? `${p.rev_growth}%` : "—"}</td>
                        <td style={{ ...td, fontWeight: 700, color: (p.rs || 0) >= 70 ? "#10b981" : "var(--text-secondary,#cbd5e1)" }}>{p.rs ?? "—"}</td>
                        <td style={{ ...td, color: (p.ret_3m || 0) >= 0 ? "#10b981" : "#ef4444" }}>{p.ret_3m ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
