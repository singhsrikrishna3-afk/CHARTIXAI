"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

const SIGNAL_STYLE = {
  "accumulation": { color: "#089981", label: "ACCUMULATION" },
  "conviction selling": { color: "#f23645", label: "CONVICTION SELLING" },
  "conviction fading": { color: "#f0a500", label: "CONVICTION FADING" },
  "distribution": { color: "#f23645", label: "DISTRIBUTION" },
  "neutral": { color: "#9aa4b2", label: "NEUTRAL" },
};

const WINDOWS = [
  { key: "5v20", label: "5d vs 20d", recent: 5, baseline: 20 },
  { key: "10v40", label: "10d vs 40d", recent: 10, baseline: 40 },
];

function Sparkline({ trend, color }) {
  if (!trend || trend.length < 3) return null;
  const vals = trend.map((t) => t.pct);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const w = 140, h = 36;
  const pts = vals
    .map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`)
    .join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

const pctColor = (v) => (v >= 0 ? "#089981" : "#f23645");
const fmtPct = (v) => `${v >= 0 ? "+" : ""}${v}%`;

export default function DeliveryPage() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [spikes, setSpikes] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [win, setWin] = useState(WINDOWS[0]);
  const [openSector, setOpenSector] = useState(null);   // sector name whose drill-down is open
  const [sectorStocks, setSectorStocks] = useState({}); // sector → stocks payload
  const [stocksLoading, setStocksLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setOpenSector(null);
    setSectorStocks({});
    Promise.all([
      api.getDeliverySectors(win.recent, win.baseline),
      api.getDeliverySpikes(15).catch(() => null),
    ])
      .then(([sec, spk]) => {
        if (!alive) return;
        setData(sec);
        setSpikes(spk);
      })
      .catch((e) => alive && setError(e?.message || "Could not load delivery data."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [win]);

  const openChart = (symbol) => router.push(`/dashboard/charts?symbol=${encodeURIComponent(symbol)}`);

  const toggleSector = (sector) => {
    if (openSector === sector) { setOpenSector(null); return; }
    setOpenSector(sector);
    if (!sectorStocks[sector]) {
      setStocksLoading(true);
      api.getDeliverySectorStocks(sector, win.recent, win.baseline)
        .then((d) => setSectorStocks((prev) => ({ ...prev, [sector]: d })))
        .catch(() => {})
        .finally(() => setStocksLoading(false));
    }
  };

  const thStyle = { textAlign: "right", padding: "6px 10px", color: "#9aa4b2", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" };
  const tdStyle = { textAlign: "right", padding: "6px 10px", fontSize: 12, whiteSpace: "nowrap" };

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 4, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.35rem", fontWeight: 800, margin: 0 }}>🚚 Delivery Money Flow</h1>
        {data?.data_through && (
          <span style={{ color: "#9aa4b2", fontSize: 12 }}>data through {data.data_through}</span>
        )}
      </div>
      <p style={{ color: "var(--text-secondary, #9aa4b2)", fontSize: 13, margin: "6px 0 14px", maxWidth: 720 }}>
        NSE reports how many traded shares were actually <b>delivered</b> (taken home) instead of
        intraday-flipped. Rising delivery share = conviction money moving — and the price direction
        tells you whether that conviction is <b style={{ color: "#089981" }}>buying</b> or{" "}
        <b style={{ color: "#f23645" }}>dumping</b>. Click a sector to see which stocks carry the flow.
      </p>

      {/* ⚡ Conviction movers — today's delivery spikes */}
      {spikes?.spikes?.length > 0 && (
        <div style={{
          background: "var(--panel-bg, #14181f)", border: "1px solid var(--border-color, #2a2e39)",
          borderRadius: 10, padding: "12px 14px", marginBottom: 18,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800, fontSize: 14 }}>⚡ Conviction Movers</span>
            <span style={{ color: "#9aa4b2", fontSize: 11 }}>
              {spikes.date} — delivered qty ≥ {spikes.min_ratio}× the stock&apos;s own 20-session norm, liquid names only
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-color, #2a2e39)" }}>
                  <th style={{ ...thStyle, textAlign: "left" }}>Stock</th>
                  <th style={thStyle}>Spike</th>
                  <th style={thStyle}>Delivery %</th>
                  <th style={thStyle}>Price</th>
                  <th style={{ ...thStyle, textAlign: "left" }}>Sector</th>
                </tr>
              </thead>
              <tbody>
                {spikes.spikes.map((s) => (
                  <tr key={s.symbol} onClick={() => openChart(s.symbol)}
                      style={{ cursor: "pointer", borderBottom: "1px solid var(--border-color, #2a2e39)22" }}>
                    <td style={{ ...tdStyle, textAlign: "left", fontWeight: 700 }}>{s.symbol}</td>
                    <td style={{ ...tdStyle, fontWeight: 800, color: "#f0a500" }}>{s.spike_ratio}×</td>
                    <td style={tdStyle}>{s.delivery_pct}%</td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: pctColor(s.price_change_pct) }}>
                      {fmtPct(s.price_change_pct)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "left", color: "#9aa4b2", fontSize: 11 }}>{s.sector || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 6, color: "#9aa4b2", fontSize: 10 }}>
            Spike + price up = institutional footprint on the buy side. Spike + price down = the exit door. Click a row to open its chart.
          </div>
        </div>
      )}

      {/* Window toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: 14 }}>
        <div style={{ display: "inline-flex", border: "1px solid var(--border-color, #2a2e39)", borderRadius: 18, overflow: "hidden" }}>
          {WINDOWS.map((w) => (
            <button key={w.key} onClick={() => setWin(w)}
              style={{
                border: "none", cursor: "pointer", padding: "7px 16px", fontWeight: 700, fontSize: 12,
                background: win.key === w.key ? "#6366f1" : "transparent",
                color: win.key === w.key ? "#fff" : "var(--text-secondary, #cbd5e1)",
              }}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div style={{ color: "#9aa4b2", padding: 30 }}>Loading sector delivery flows…</div>}
      {error && !loading && (
        <div style={{ color: "#f23645", padding: 20, border: "1px solid #f2364540", borderRadius: 8 }}>
          {error}
        </div>
      )}

      {!loading && data?.sectors && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
          {data.sectors.map((s) => {
            const sig = SIGNAL_STYLE[s.signal] || SIGNAL_STYLE.neutral;
            const isOpen = openSector === s.sector;
            const stocks = sectorStocks[s.sector]?.stocks;
            return (
              <div key={s.sector}
                onClick={() => toggleSector(s.sector)}
                style={{
                  background: "var(--panel-bg, #14181f)",
                  border: `1px solid ${isOpen ? sig.color : "var(--border-color, #2a2e39)"}`,
                  borderRadius: 10, padding: "12px 14px", cursor: "pointer",
                  gridColumn: isOpen ? "1 / -1" : "auto",
                }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.sector}
                  </span>
                  <span style={{
                    color: sig.color, background: `${sig.color}18`, fontWeight: 800, fontSize: 10,
                    padding: "3px 8px", borderRadius: 5, letterSpacing: "0.4px", whiteSpace: "nowrap",
                  }}>
                    {sig.label}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 10 }}>
                  <div style={{ fontSize: 12, color: "#9aa4b2", lineHeight: 1.7 }}>
                    <div>
                      Delivery <b style={{ color: "var(--text-color, #e5e9f0)" }}>{s.recent_delivery_pct}%</b>
                      {" "}· base {s.baseline_delivery_pct}%
                      {" "}<b style={{ color: pctColor(s.change) }}>({s.change >= 0 ? "+" : ""}{s.change} pts)</b>
                    </div>
                    <div>
                      Price <b style={{ color: pctColor(s.price_change_pct) }}>{fmtPct(s.price_change_pct)}</b>
                      <span style={{ fontSize: 10 }}> over {data.recent_days} sessions</span>
                    </div>
                  </div>
                  <Sparkline trend={s.trend} color={sig.color} />
                </div>

                {/* Drill-down: the stocks carrying this sector's flow */}
                {isOpen && (
                  <div style={{ marginTop: 12, borderTop: "1px solid var(--border-color, #2a2e39)", paddingTop: 10 }}
                       onClick={(e) => e.stopPropagation()}>
                    {stocksLoading && !stocks && <div style={{ color: "#9aa4b2", fontSize: 12 }}>Loading stocks…</div>}
                    {stocks && (
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid var(--border-color, #2a2e39)" }}>
                              <th style={{ ...thStyle, textAlign: "left" }}>Stock</th>
                              <th style={thStyle}>Delivery (recent)</th>
                              <th style={thStyle}>Δ vs base</th>
                              <th style={thStyle}>Price</th>
                              <th style={thStyle}>Deliv MFI</th>
                              <th style={{ ...thStyle, textAlign: "left" }}>Read</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stocks.map((st) => {
                              const stSig = SIGNAL_STYLE[st.signal] || SIGNAL_STYLE.neutral;
                              return (
                                <tr key={st.symbol} onClick={() => openChart(st.symbol)} style={{ cursor: "pointer" }}>
                                  <td style={{ ...tdStyle, textAlign: "left", fontWeight: 700 }}>{st.symbol}</td>
                                  <td style={tdStyle}>{st.recent_delivery_pct}%</td>
                                  <td style={{ ...tdStyle, fontWeight: 700, color: pctColor(st.change) }}>
                                    {st.change >= 0 ? "+" : ""}{st.change} pts
                                  </td>
                                  <td style={{ ...tdStyle, fontWeight: 700, color: pctColor(st.price_change_pct) }}>
                                    {fmtPct(st.price_change_pct)}
                                  </td>
                                  <td style={{
                                    ...tdStyle,
                                    color: st.delivery_mfi == null ? "#9aa4b2" : st.delivery_mfi >= 60 ? "#089981" : st.delivery_mfi <= 40 ? "#f23645" : "var(--text-color)",
                                  }}>
                                    {st.delivery_mfi ?? "—"}
                                  </td>
                                  <td style={{ ...tdStyle, textAlign: "left", color: stSig.color, fontWeight: 700, fontSize: 10 }}>
                                    {stSig.label}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p
        style={{ marginTop: 22, color: "#9aa4b2", fontSize: 12, cursor: "pointer" }}
        onClick={() => router.push("/dashboard/charts")}
      >
        Tip: open any stock on the chart page — its sidebar shows a per-stock Delivery MFI card. →
      </p>
    </div>
  );
}
