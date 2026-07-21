"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { api } from "@/lib/api";

const QUAD = {
  Leading:   { color: "#10b981", bg: "rgba(16,185,129,0.07)",  desc: "Strong & still gaining" },
  Weakening: { color: "#f59e0b", bg: "rgba(245,158,11,0.07)",  desc: "Strong but losing steam" },
  Lagging:   { color: "#ef4444", bg: "rgba(239,68,68,0.07)",   desc: "Weak & still falling" },
  Improving: { color: "#3b82f6", bg: "rgba(59,130,246,0.07)",  desc: "Weak but turning up" },
};
const quadOf = (x, y) => (x >= 100 ? (y >= 100 ? "Leading" : "Weakening") : (y >= 100 ? "Improving" : "Lagging"));
const shortLabel = (sym) => sym.replace(/^NIFTY_/, "").replace(/_/g, " ");

export default function RRGPage() {
  const [opts, setOpts] = useState(null);
  const [mode, setMode] = useState("sectors");      // "sectors" | "stocks"
  const [benchmark, setBenchmark] = useState("NIFTY_50");
  const [stocksIn, setStocksIn] = useState("NIFTY_BANK");
  const [timeframe, setTimeframe] = useState("W");
  const [tailLen, setTailLen] = useState(8);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hover, setHover] = useState(null);

  // Animation: reveal the rotation tail-by-tail
  const [frame, setFrame] = useState(null);         // null = show full tail; else index
  const [playing, setPlaying] = useState(false);
  const timer = useRef(null);

  useEffect(() => { api.getRrgOptions().then(setOpts).catch(() => {}); }, []);

  const load = async () => {
    setLoading(true); setError(""); setPlaying(false); setFrame(null);
    try {
      const params = { timeframe, tail: tailLen };
      if (mode === "stocks") params.stocks_in = stocksIn;
      else params.benchmark = benchmark;
      setData(await api.getRrg(params));
    } catch (e) {
      setError(e.status === 403 ? (e.message || "Upgrade required.") : (e.message || "Failed to load RRG."));
      setData(null);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [mode, benchmark, stocksIn, timeframe, tailLen]);

  // Animation loop
  useEffect(() => {
    clearInterval(timer.current);
    if (playing && data) {
      timer.current = setInterval(() => {
        setFrame((f) => {
          const next = (f == null ? 1 : f + 1);
          if (next >= tailLen) { setPlaying(false); return null; }  // finished → show full
          return next;
        });
      }, 650);
    }
    return () => clearInterval(timer.current);
  }, [playing, data, tailLen]);

  // Trim each tail to the current animation frame
  const securities = useMemo(() => {
    if (!data?.securities) return [];
    if (frame == null) return data.securities;
    return data.securities.map((s) => {
      const t = s.tail.slice(0, Math.max(2, frame + 1));
      const head = t[t.length - 1];
      return { ...s, tail: t, x: head.x, y: head.y, quadrant: quadOf(head.x, head.y) };
    });
  }, [data, frame]);

  const geom = useMemo(() => {
    if (!securities.length) return null;
    let dev = 1;
    for (const s of securities) for (const p of s.tail) dev = Math.max(dev, Math.abs(p.x - 100), Math.abs(p.y - 100));
    dev *= 1.18;
    const lo = 100 - dev, hi = 100 + dev, W = 660, H = 580, pad = 44;
    const sx = (x) => pad + ((x - lo) / (hi - lo)) * (W - 2 * pad);
    const sy = (y) => pad + (1 - (y - lo) / (hi - lo)) * (H - 2 * pad);
    return { W, H, pad, sx, sy, cx: sx(100), cy: sy(100) };
  }, [securities]);

  // Simple label anti-overlap: nudge labels that land too close to an earlier one.
  const labels = useMemo(() => {
    if (!geom) return [];
    const placed = [];
    return securities.map((s) => {
      const h = s.tail[s.tail.length - 1];
      let lx = geom.sx(h.x) + 9, ly = geom.sy(h.y) + 4;
      for (let guard = 0; guard < 6; guard++) {
        const clash = placed.find((p) => Math.abs(p.lx - lx) < 46 && Math.abs(p.ly - ly) < 13);
        if (!clash) break;
        ly += 14;
      }
      placed.push({ lx, ly });
      return { sym: s.symbol, lx, ly };
    });
  }, [securities, geom]);

  const sel = { background: "var(--input-bg,#131722)", color: "var(--text-primary,#e5e7eb)",
    border: "1px solid var(--border-default,#333)", borderRadius: 8, padding: "8px 10px", fontSize: "0.85rem", cursor: "pointer" };
  const lbl = { fontSize: "0.68rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 3 };

  return (
    <div style={{ maxWidth: 1150, margin: "0 auto" }}>
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 4 }}>🧭 Relative Rotation Graph</h1>
        <p style={{ color: "var(--text-muted,#9ca3af)", fontSize: "0.9rem", maxWidth: 780 }}>
          Where money is rotating. Each item is plotted by <b>relative strength</b> (→ right = stronger) and
          <b> momentum</b> (↑ up = accelerating). They rotate clockwise: <span style={{ color: "#3b82f6" }}>Improving</span> →
          <span style={{ color: "#10b981" }}> Leading</span> → <span style={{ color: "#f59e0b" }}>Weakening</span> →
          <span style={{ color: "#ef4444" }}> Lagging</span>. Read the tail's <i>direction</i>, not just the dot.
        </p>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 14 }}>
        <div>
          <label style={lbl}>View</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={sel}>
            <option value="sectors">Sectors vs benchmark</option>
            <option value="stocks">Stocks within an index</option>
          </select>
        </div>
        {mode === "sectors" ? (
          <div>
            <label style={lbl}>Benchmark</label>
            <select value={benchmark} onChange={(e) => setBenchmark(e.target.value)} style={sel}>
              {(opts?.benchmarks || [{ symbol: "NIFTY_50", name: "Nifty 50" }]).map((b) =>
                <option key={b.symbol} value={b.symbol}>{b.name}</option>)}
            </select>
          </div>
        ) : (
          <div>
            <label style={lbl}>Index (stocks vs this index)</label>
            <select value={stocksIn} onChange={(e) => setStocksIn(e.target.value)} style={sel}>
              {(opts?.drilldown_indices || [{ symbol: "NIFTY_BANK", name: "Nifty Bank" }]).map((b) =>
                <option key={b.symbol} value={b.symbol}>{b.name}{b.count ? ` (${b.count})` : ""}</option>)}
            </select>
          </div>
        )}
        <div>
          <label style={lbl}>Timeframe</label>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} style={sel}>
            <option value="W">Weekly (standard)</option>
            <option value="D">Daily</option>
          </select>
        </div>
        <div>
          <label style={lbl}>Tail</label>
          <select value={tailLen} onChange={(e) => setTailLen(Number(e.target.value))} style={sel}>
            {[4, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n} periods</option>)}
          </select>
        </div>
        <button onClick={() => { if (playing) { setPlaying(false); } else { setFrame(1); setPlaying(true); } }}
          disabled={!data} title="Animate the rotation over time"
          style={{ background: playing ? "#ef4444" : "#6366f1", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, cursor: "pointer", fontSize: "0.82rem" }}>
          {playing ? "⏸ Stop" : "▶ Play rotation"}
        </button>
        {data?.data_through && <div style={{ fontSize: "0.75rem", color: "var(--text-muted,#9ca3af)", paddingBottom: 8 }}>
          {data.benchmark_name} · data through {data.data_through}{frame != null ? ` · frame ${frame + 1}/${tailLen}` : ""}
        </div>}
      </div>

      {error && <div style={{ padding: 14, borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", color: "#ef4444", marginBottom: 12 }}>{error}</div>}
      {loading && !data && <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted,#9ca3af)" }}>Computing rotation…</div>}

      {data && geom && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", gap: 20, alignItems: "start" }}>
          <div style={{ background: "var(--bg-secondary,rgba(255,255,255,0.02))", borderRadius: 14, padding: 8, overflow: "hidden" }}>
            <svg viewBox={`0 0 ${geom.W} ${geom.H}`} style={{ width: "100%", height: "auto", display: "block" }}>
              <rect x={geom.cx} y={geom.pad} width={geom.W - geom.pad - geom.cx} height={geom.cy - geom.pad} fill={QUAD.Leading.bg} />
              <rect x={geom.cx} y={geom.cy} width={geom.W - geom.pad - geom.cx} height={geom.H - geom.pad - geom.cy} fill={QUAD.Weakening.bg} />
              <rect x={geom.pad} y={geom.cy} width={geom.cx - geom.pad} height={geom.H - geom.pad - geom.cy} fill={QUAD.Lagging.bg} />
              <rect x={geom.pad} y={geom.pad} width={geom.cx - geom.pad} height={geom.cy - geom.pad} fill={QUAD.Improving.bg} />
              <line x1={geom.cx} y1={geom.pad} x2={geom.cx} y2={geom.H - geom.pad} stroke="#4b5563" strokeWidth="1" strokeDasharray="4 4" />
              <line x1={geom.pad} y1={geom.cy} x2={geom.W - geom.pad} y2={geom.cy} stroke="#4b5563" strokeWidth="1" strokeDasharray="4 4" />
              <text x={geom.W - geom.pad - 6} y={geom.pad + 16} textAnchor="end" fill={QUAD.Leading.color} fontSize="13" fontWeight="800">LEADING</text>
              <text x={geom.W - geom.pad - 6} y={geom.H - geom.pad - 6} textAnchor="end" fill={QUAD.Weakening.color} fontSize="13" fontWeight="800">WEAKENING</text>
              <text x={geom.pad + 6} y={geom.H - geom.pad - 6} textAnchor="start" fill={QUAD.Lagging.color} fontSize="13" fontWeight="800">LAGGING</text>
              <text x={geom.pad + 6} y={geom.pad + 16} textAnchor="start" fill={QUAD.Improving.color} fontSize="13" fontWeight="800">IMPROVING</text>
              <text x={geom.W - geom.pad} y={geom.cy - 6} textAnchor="end" fill="#6b7280" fontSize="10">RS-Ratio →</text>
              <text x={geom.cx + 6} y={geom.pad + 2} textAnchor="start" fill="#6b7280" fontSize="10">RS-Momentum ↑</text>

              {securities.map((s, si) => {
                const c = QUAD[s.quadrant].color;
                const pts = s.tail.map((p) => `${geom.sx(p.x)},${geom.sy(p.y)}`).join(" ");
                const head = s.tail[s.tail.length - 1];
                const hx = geom.sx(head.x), hy = geom.sy(head.y);
                const hi = hover === s.symbol;
                const L = labels[si];
                return (
                  <g key={s.symbol} onMouseEnter={() => setHover(s.symbol)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
                    <polyline points={pts} fill="none" stroke={c} strokeWidth={hi ? 2.5 : 1.5} opacity={hi ? 0.95 : 0.4} />
                    {s.tail.slice(0, -1).map((p, i) => (
                      <circle key={i} cx={geom.sx(p.x)} cy={geom.sy(p.y)} r={1.8} fill={c} opacity={0.2 + 0.55 * (i / s.tail.length)} />
                    ))}
                    <circle cx={hx} cy={hy} r={hi ? 7 : 5.5} fill={c} stroke="#0b0f17" strokeWidth="1.5" />
                    {L && <text x={L.lx} y={L.ly} fill={hi ? "#fff" : "var(--text-secondary,#cbd5e1)"} fontSize={hi ? 12 : 11} fontWeight={hi ? 800 : 600}>{shortLabel(s.symbol)}</text>}
                  </g>
                );
              })}
            </svg>
          </div>

          <div>
            {["Leading", "Improving", "Weakening", "Lagging"].map((q) => {
              const items = securities.filter((s) => s.quadrant === q);
              if (!items.length) return null;
              return (
                <div key={q} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: QUAD[q].color, display: "inline-block" }} />
                    <span style={{ fontWeight: 800, color: QUAD[q].color, fontSize: "0.85rem" }}>{q}</span>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)" }}>· {QUAD[q].desc} · {items.length}</span>
                  </div>
                  {items.map((s) => (
                    <div key={s.symbol}
                      onMouseEnter={() => setHover(s.symbol)} onMouseLeave={() => setHover(null)}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                        padding: "6px 10px", borderRadius: 8, cursor: "pointer",
                        background: hover === s.symbol ? "rgba(255,255,255,0.06)" : "transparent" }}>
                      <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>{s.name}</span>
                      <span style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", fontVariantNumeric: "tabular-nums" }}>
                        RS {s.x.toFixed(1)} · Mom {s.y.toFixed(1)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p style={{ fontSize: "0.7rem", color: "var(--text-muted,#9ca3af)", marginTop: 18 }}>
        RRG-style approximation of the JdK RS-Ratio / RS-Momentum method from EOD data. Hit <b>▶ Play</b> to watch the
        rotation build over time. A leader with a tail curling up-right is strongest; a leader curling down may be rotating out.
        Educational tool, not investment advice.
      </p>
    </div>
  );
}
