"use client";

import { useRouter } from "next/navigation";

/**
 * "View All on Charts" — hands a scan's matched symbols to the chart page,
 * which shows a prev/next navigator so the user can flip through every result
 * full-screen. Drop it next to any scan-results header:
 *
 *   <ViewAllOnCharts symbols={results.matches.map(m => m.symbol)} label="Breakout scan" />
 */
export default function ViewAllOnCharts({ symbols, label = "Scan results", style = {} }) {
  const router = useRouter();
  const list = [...new Set((symbols || []).filter(Boolean).map((s) => String(s).toUpperCase()))];
  if (list.length === 0) return null;

  const go = () => {
    try {
      localStorage.setItem(
        "chartix_scan_list",
        JSON.stringify({ label, symbols: list, ts: Date.now() })
      );
    } catch (e) { /* storage unavailable — still open the first chart */ }
    router.push(`/dashboard/charts?symbol=${encodeURIComponent(list[0])}&scanlist=1`);
  };

  return (
    <button
      onClick={go}
      title={`Open all ${list.length} results on the chart — use ◀ ▶ to flip through them`}
      style={{
        background: "#2962ff", color: "#fff", border: "none", borderRadius: 8,
        padding: "7px 14px", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer",
        whiteSpace: "nowrap", ...style,
      }}
    >
      📊 View All on Charts ({list.length})
    </button>
  );
}
