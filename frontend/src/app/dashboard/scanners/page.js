"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./scanners.module.css";
import ViewAllOnCharts from "@/components/ViewAllOnCharts";

const INDICATORS = [
  { value: "price", label: "Price" },
  { value: "sma", label: "SMA", hasParams: true },
  { value: "ema", label: "EMA", hasParams: true },
  { value: "rsi", label: "RSI", hasParams: true },
  { value: "macd", label: "MACD" },
  { value: "volume", label: "Volume" },
  { value: "high_n", label: "N-Day High", hasParams: true },
  { value: "low_n", label: "N-Day Low", hasParams: true },
  { value: "bbands", label: "Bollinger Bands", hasParams: true },
  { value: "supertrend", label: "SuperTrend", hasParams: true },
  { value: "adx", label: "ADX", hasParams: true },
  { value: "ichimoku", label: "Ichimoku Cloud", hasParams: true },
  { value: "atr", label: "ATR", hasParams: true },
  { value: "nr7", label: "NR7 Pattern" },
  { value: "inside_bar", label: "Inside Bar" },
  { value: "gap_up", label: "Gap Up", hasParams: true },
  { value: "gap_down", label: "Gap Down", hasParams: true },
  { value: "stochastic", label: "Stochastic", hasParams: true },
  { value: "vwap", label: "VWAP" },
  { value: "doji", label: "Doji Pattern" },
  { value: "hammer", label: "Hammer Pattern" },
  { value: "engulfing", label: "Engulfing Pattern" },
];

const OPERATORS = [
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "crosses_above", label: "Crosses Above" },
  { value: "crosses_below", label: "Crosses Below" },
  { value: "slope_up", label: "Slope Up ↗" },
  { value: "slope_down", label: "Slope Down ↘" },
];

const EMPTY_CONDITION = {
  indicator: "sma",
  params: { period: 20 },
  operator: "gt",
  value: null,
  compare_to: null,
  compareMode: "value", // "value" or "indicator"
};

export default function ScannersPage() {
  const [scanners, setScanners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showBuilder, setShowBuilder] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [scanResults, setScanResults] = useState(null);
  const [sectors, setSectors] = useState([]);
  const [selectedSectors, setSelectedSectors] = useState({});
  const [indices, setIndices] = useState([]);
  const [selectedIndices, setSelectedIndices] = useState({});

  useEffect(() => {
    api.listSectors().then(data => setSectors(data || [])).catch(() => {});
    api.listIndices().then(data => setIndices(data || [])).catch(() => {});
  }, []);

  const handleSectorChange = (id, value) => {
    setSelectedSectors(prev => ({ ...prev, [id]: value }));
  };

  const handleIndexChange = (id, value) => {
    setSelectedIndices(prev => ({ ...prev, [id]: value }));
  };


  // Builder state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [conditions, setConditions] = useState([{ ...EMPTY_CONDITION }]);
  const [logic, setLogic] = useState("AND");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);

  // Premium paywall overlay state
  const [premiumUpgradeMessage, setPremiumUpgradeMessage] = useState(null);

  // Strategy backtester
  const [btScope, setBtScope] = useState("symbol");   // symbol | index | sector | all
  const [btSymbol, setBtSymbol] = useState("RELIANCE");
  const [btIndex, setBtIndex] = useState("");
  const [btSector, setBtSector] = useState("");
  const [btStop, setBtStop] = useState(5);
  const [btTarget, setBtTarget] = useState(10);
  const [btHold, setBtHold] = useState(30);
  const [btRunning, setBtRunning] = useState(false);
  const [btResult, setBtResult] = useState(null);
  const [btError, setBtError] = useState("");

  function conditionsPayload() {
    return conditions.map((c) => ({
      indicator: c.indicator,
      params: c.params || {},
      operator: c.operator,
      value: c.compareMode === "value" ? parseFloat(c.value) || 0 : undefined,
      compare_to: c.compareMode === "indicator" ? {
        indicator: c.compare_to?.indicator || "sma",
        params: c.compare_to?.params || { period: 50 },
      } : undefined,
    }));
  }

  async function handleBacktest() {
    setBtRunning(true); setBtError(""); setBtResult(null);
    try {
      const payload = { conditions: conditionsPayload(), logic,
        stop_loss_pct: Number(btStop), target_pct: Number(btTarget), max_holding_bars: Number(btHold) };
      if (btScope === "symbol") payload.symbol = btSymbol.trim().toUpperCase();
      else if (btScope === "index") payload.index = btIndex;
      else if (btScope === "sector") payload.sector = btSector;
      else payload.scope = "all";
      const res = await api.runBacktest(payload);
      setBtResult(res);
    } catch (err) {
      if (err.status === 403) setPremiumUpgradeMessage(err.message || "Strategy backtesting is available on the EOD Pro plan and above.");
      else setBtError(err.message || "Backtest failed. Check your conditions.");
    } finally {
      setBtRunning(false);
    }
  }

  useEffect(() => {
    loadScanners();
  }, []);

  async function loadScanners() {
    setLoading(true);
    try {
      const data = await api.listScanners();
      setScanners(data);
    } catch (err) {
      console.error("Error loading scanners:", err);
    } finally {
      setLoading(false);
    }
  }

  function addCondition() {
    setConditions([...conditions, { ...EMPTY_CONDITION }]);
  }

  function removeCondition(idx) {
    setConditions(conditions.filter((_, i) => i !== idx));
  }

  function updateCondition(idx, field, value) {
    const updated = [...conditions];
    if (field.includes(".")) {
      const [parent, child] = field.split(".");
      updated[idx] = { ...updated[idx], [parent]: { ...updated[idx][parent], [child]: value } };
    } else {
      updated[idx] = { ...updated[idx], [field]: value };
    }
    setConditions(updated);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name,
        description,
        conditions: conditions.map((c) => ({
          indicator: c.indicator,
          params: c.params || {},
          operator: c.operator,
          value: c.compareMode === "value" ? parseFloat(c.value) || 0 : undefined,
          compare_to: c.compareMode === "indicator" ? {
            indicator: c.compare_to?.indicator || "sma",
            params: c.compare_to?.params || { period: 50 },
          } : undefined,
        })),
        logic,
        is_public: isPublic,
      };
      await api.createScanner(payload);
      setShowBuilder(false);
      setName("");
      setDescription("");
      setConditions([{ ...EMPTY_CONDITION }]);
      loadScanners();
    } catch (err) {
      if (err.status === 403 || err.message?.includes("maximum number of custom scanners")) {
        setPremiumUpgradeMessage(err.message || "You have reached the maximum number of custom scanners allowed for your plan.");
      } else {
        alert(err.message || "Failed to save scanner");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleRun(scannerId, sector) {
    setRunningId(scannerId);
    setScanResults(null);
    try {
      const result = await api.runScanner(scannerId, sector);
      setScanResults(result);
    } catch (err) {
      alert(err.message || "Scanner execution failed");
    } finally {
      setRunningId(null);
    }
  }


  async function handleDelete(scannerId) {
    if (!confirm("Delete this scanner?")) return;
    try {
      await api.deleteScanner(scannerId);
      loadScanners();
    } catch (err) {
      alert(err.message);
    }
  }

  const selStyle = { background: "var(--input-bg, #131722)", color: "var(--text-primary,#e5e7eb)",
    border: "1px solid var(--border-default,#333)", borderRadius: 8, padding: "8px 10px", fontSize: "0.82rem" };
  const lblStyle = { fontSize: "0.68rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 3 };

  return (
    <div className={styles.scannersPage}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>🎯 Custom Scanners</h1>
          <p className={styles.pageSubtitle}>
            Build no-code screeners with technical indicators
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowBuilder(!showBuilder)}
          id="create-scanner-btn"
        >
          {showBuilder ? "✕ Close" : "+ New Scanner"}
        </button>
      </div>

      {/* Scanner Builder */}
      {showBuilder && (
        <div className={styles.builderPanel}>
          <h2 className={styles.builderTitle}>Build Scanner</h2>

          <div className={styles.builderForm}>
            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Scanner Name *</label>
                <input
                  className="input"
                  placeholder="e.g. RSI Oversold + SMA Crossover"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  id="scanner-name"
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Logic</label>
                <select
                  className={styles.filterSelect}
                  value={logic}
                  onChange={(e) => setLogic(e.target.value)}
                >
                  <option value="AND">ALL conditions (AND)</option>
                  <option value="OR">ANY condition (OR)</option>
                </select>
              </div>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Description</label>
              <input
                className="input"
                placeholder="Optional description..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Conditions */}
            <div className={styles.conditionsSection}>
              <h3 className={styles.conditionsTitle}>Conditions</h3>
              {conditions.map((cond, idx) => (
                <div key={idx} className={styles.conditionRow}>
                  <span className={styles.conditionNum}>#{idx + 1}</span>

                  <select
                    className={styles.condSelect}
                    value={cond.indicator}
                    onChange={(e) => updateCondition(idx, "indicator", e.target.value)}
                  >
                    {INDICATORS.map((ind) => (
                      <option key={ind.value} value={ind.value}>{ind.label}</option>
                    ))}
                  </select>

                  {["sma", "ema", "rsi", "high_n", "low_n", "bbands", "supertrend", "adx", "ichimoku", "atr", "stochastic"].includes(cond.indicator) && (
                    <input
                      className={styles.condPeriod}
                      type="number"
                      placeholder="Period"
                      value={cond.params?.period || ""}
                      onChange={(e) => updateCondition(idx, "params.period", parseInt(e.target.value) || 20)}
                    />
                  )}
                  {["gap_up", "gap_down"].includes(cond.indicator) && (
                    <input
                      className={styles.condPeriod}
                      type="number"
                      step="0.1"
                      placeholder="Min %"
                      value={cond.params?.min_percent || ""}
                      onChange={(e) => updateCondition(idx, "params.min_percent", parseFloat(e.target.value) || 0.5)}
                    />
                  )}

                  <select
                    className={styles.condSelect}
                    value={cond.operator}
                    onChange={(e) => updateCondition(idx, "operator", e.target.value)}
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>

                  <select
                    className={styles.condSelect}
                    value={cond.compareMode}
                    onChange={(e) => updateCondition(idx, "compareMode", e.target.value)}
                    style={{ width: 100 }}
                  >
                    <option value="value">Value</option>
                    <option value="indicator">Indicator</option>
                  </select>

                  {cond.compareMode === "value" ? (
                    <input
                      className={styles.condPeriod}
                      type="number"
                      placeholder="Value"
                      value={cond.value || ""}
                      onChange={(e) => updateCondition(idx, "value", e.target.value)}
                    />
                  ) : (
                    <>
                      <select
                        className={styles.condSelect}
                        value={cond.compare_to?.indicator || "sma"}
                        onChange={(e) => updateCondition(idx, "compare_to", {
                          ...cond.compare_to,
                          indicator: e.target.value,
                        })}
                      >
                        {INDICATORS.map((ind) => (
                          <option key={ind.value} value={ind.value}>{ind.label}</option>
                        ))}
                      </select>
                      <input
                        className={styles.condPeriod}
                        type="number"
                        placeholder="Period"
                        value={cond.compare_to?.params?.period || ""}
                        onChange={(e) => updateCondition(idx, "compare_to", {
                          ...cond.compare_to,
                          params: { period: parseInt(e.target.value) || 50 },
                        })}
                      />
                    </>
                  )}

                  <button
                    className={styles.removeBtn}
                    onClick={() => removeCondition(idx)}
                    disabled={conditions.length <= 1}
                  >
                    ✕
                  </button>
                </div>
              ))}

              <button className={`btn btn-outline ${styles.addCondBtn}`} onClick={addCondition}>
                + Add Condition
              </button>
            </div>

            <div className={styles.builderActions}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                Make public
              </label>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !name.trim()}
                id="save-scanner-btn"
              >
                {saving ? "Saving..." : "Save Scanner"}
              </button>
            </div>

            {/* ── Strategy Backtester ── */}
            <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid var(--border-subtle, rgba(255,255,255,0.1))" }}>
              <div style={{ fontWeight: 800, fontSize: "1rem", marginBottom: 4 }}>📊 Backtest this strategy</div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted,#9ca3af)", marginBottom: 12 }}>
                Enter when your conditions above turn true; exit on stop / target / max holding. See how it would have performed.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: "0.68rem", color: "var(--text-muted,#9ca3af)", display: "block", marginBottom: 3 }}>Universe</label>
                  <select value={btScope} onChange={(e) => setBtScope(e.target.value)} style={selStyle}>
                    <option value="symbol">Single stock</option>
                    <option value="index">Index</option>
                    <option value="sector">Sector</option>
                    <option value="all">All liquid stocks</option>
                  </select>
                </div>
                {btScope === "symbol" && (
                  <div><label style={lblStyle}>Symbol</label>
                    <input value={btSymbol} onChange={(e) => setBtSymbol(e.target.value.toUpperCase())} placeholder="RELIANCE" style={{ ...selStyle, width: 130 }} /></div>
                )}
                {btScope === "index" && (
                  <div><label style={lblStyle}>Index</label>
                    <select value={btIndex} onChange={(e) => setBtIndex(e.target.value)} style={selStyle}>
                      <option value="">Choose…</option>
                      {indices.map((ix) => <option key={ix.symbol || ix} value={ix.symbol || ix}>{ix.name || ix.symbol || ix}</option>)}
                    </select></div>
                )}
                {btScope === "sector" && (
                  <div><label style={lblStyle}>Sector</label>
                    <select value={btSector} onChange={(e) => setBtSector(e.target.value)} style={selStyle}>
                      <option value="">Choose…</option>
                      {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select></div>
                )}
                <div><label style={lblStyle}>Stop %</label><input type="number" value={btStop} onChange={(e) => setBtStop(e.target.value)} style={{ ...selStyle, width: 72 }} /></div>
                <div><label style={lblStyle}>Target %</label><input type="number" value={btTarget} onChange={(e) => setBtTarget(e.target.value)} style={{ ...selStyle, width: 72 }} /></div>
                <div><label style={lblStyle}>Max hold (bars)</label><input type="number" value={btHold} onChange={(e) => setBtHold(e.target.value)} style={{ ...selStyle, width: 90 }} /></div>
                <button onClick={handleBacktest} disabled={btRunning}
                  style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontWeight: 800, cursor: "pointer", fontSize: "0.85rem" }}>
                  {btRunning ? "Running…" : "▶ Run Backtest"}
                </button>
              </div>

              {btError && <div style={{ color: "#ef4444", fontSize: "0.8rem", marginBottom: 8 }}>⚠ {btError}</div>}
              {btRunning && btScope !== "symbol" && <div style={{ fontSize: "0.75rem", color: "var(--text-muted,#9ca3af)" }}>Scanning the basket — this can take 10–30s…</div>}

              {btResult && (() => {
                const s = btResult.summary || {};
                const money = s.total_return_pct != null ? s.total_return_pct : s.avg_symbol_return_pct;
                const moneyLabel = s.total_return_pct != null ? "Total return (compounded)" : "Avg return / stock";
                const cards = [
                  ["Trades", s.num_trades, "#e5e7eb"],
                  ["Win rate", s.win_rate_pct != null ? s.win_rate_pct + "%" : "—", (s.win_rate_pct || 0) >= 50 ? "#10b981" : "#f59e0b"],
                  ["Avg / trade", (s.avg_return_pct >= 0 ? "+" : "") + s.avg_return_pct + "%", s.avg_return_pct >= 0 ? "#10b981" : "#ef4444"],
                  [moneyLabel, money != null ? (money >= 0 ? "+" : "") + money + "%" : "—", (money || 0) >= 0 ? "#10b981" : "#ef4444"],
                  ["Max drawdown", s.max_drawdown_pct != null ? s.max_drawdown_pct + "%" : "—", "#ef4444"],
                  ["Profit factor", s.profit_factor != null ? s.profit_factor : "—", (s.profit_factor || 0) >= 1.5 ? "#10b981" : "#f59e0b"],
                ];
                return (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted,#9ca3af)", marginBottom: 8 }}>
                      {btResult.scope?.label} · {btResult.params?.instruments_tested} tested{btResult.scope?.capped ? " (capped)" : ""} · avg {s.avg_bars_held} bars held
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 14 }}>
                      {cards.map(([label, val, color]) => (
                        <div key={label} style={{ background: "var(--bg-secondary, rgba(255,255,255,0.03))", borderRadius: 10, padding: "10px 12px" }}>
                          <div style={{ fontSize: "0.66rem", color: "var(--text-muted,#9ca3af)" }}>{label}</div>
                          <div style={{ fontSize: "1.15rem", fontWeight: 800, color }}>{val}</div>
                        </div>
                      ))}
                    </div>
                    {s.num_trades === 0 && <div style={{ fontSize: "0.8rem", color: "var(--text-muted,#9ca3af)" }}>No trades — your entry conditions never triggered in this window. Try loosening them.</div>}
                    {btResult.trades?.length > 0 && (
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem", minWidth: 560 }}>
                          <thead><tr style={{ textAlign: "left", color: "var(--text-muted,#9ca3af)", textTransform: "uppercase", fontSize: "0.64rem" }}>
                            {["Symbol", "Entry", "Exit", "Return", "Bars", "Exit reason"].map((h) => <th key={h} style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-default,#333)" }}>{h}</th>)}
                          </tr></thead>
                          <tbody>
                            {btResult.trades.slice(-25).reverse().map((t, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.06))" }}>
                                <td style={{ padding: "6px 8px", fontWeight: 700 }}>{t.symbol}</td>
                                <td style={{ padding: "6px 8px" }}>{t.entry_date} @{t.entry_price}</td>
                                <td style={{ padding: "6px 8px" }}>{t.exit_date} @{t.exit_price}</td>
                                <td style={{ padding: "6px 8px", fontWeight: 700, color: t.return_pct >= 0 ? "#10b981" : "#ef4444" }}>{t.return_pct >= 0 ? "+" : ""}{t.return_pct}%</td>
                                <td style={{ padding: "6px 8px" }}>{t.bars_held}</td>
                                <td style={{ padding: "6px 8px", color: "var(--text-muted,#9ca3af)" }}>{t.exit_reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div style={{ fontSize: "0.68rem", color: "var(--text-muted,#9ca3af)", marginTop: 6 }}>Showing last 25 of {s.num_trades} trades. Long-only, equal-weight. Educational — past performance isn&apos;t predictive.</div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Scanner List */}
      <div className={styles.scannerList}>
        {loading ? (
          <div className={styles.skeleton}>
            {[1, 2, 3].map((i) => <div key={i} className={styles.skeletonCard} />)}
          </div>
        ) : scanners.length > 0 ? (
          scanners.map((scanner) => (
            <div key={scanner.id} className={styles.scannerCard}>
              <div className={styles.scannerHeader}>
                <div>
                  <h3 className={styles.scannerName}>{scanner.name}</h3>
                  {scanner.description && (
                    <p className={styles.scannerDesc}>{scanner.description}</p>
                  )}
                </div>
                <div className={styles.scannerBadges}>
                  {scanner.is_public && <span className="badge badge-blue">Public</span>}
                  <span className="badge badge-green">
                    {scanner.conditions?.length || 0} conditions
                  </span>
                </div>
              </div>
              <div className={styles.scannerActions} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <select
                  className={styles.condSelect}
                  value={selectedSectors[scanner.id] || "all"}
                  onChange={(e) => handleSectorChange(scanner.id, e.target.value)}
                  style={{ minWidth: "120px", fontSize: "0.82rem", padding: "6px 10px" }}
                >
                  <option value="all">All Sectors</option>
                  {sectors.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select
                  className={styles.condSelect}
                  value={selectedIndices[scanner.id] || "all"}
                  onChange={(e) => handleIndexChange(scanner.id, e.target.value)}
                  style={{ minWidth: "120px", fontSize: "0.82rem", padding: "6px 10px" }}
                >
                  <option value="all">All Indices</option>
                  {indices.map((idx) => (
                    <option key={idx.symbol} value={idx.symbol}>{idx.name}</option>
                  ))}
                </select>
                <button
                  className="btn btn-primary"
                  onClick={() => handleRun(
                    scanner.id,
                    selectedSectors[scanner.id] || "all",
                    selectedIndices[scanner.id] || "all"
                  )}
                  disabled={runningId === scanner.id}
                  style={{ fontSize: "0.82rem", padding: "8px 16px" }}
                >
                  {runningId === scanner.id ? "Running..." : "▶ Run"}
                </button>
                <button
                  className="btn btn-outline"
                  onClick={() => handleDelete(scanner.id)}
                  style={{ fontSize: "0.82rem", padding: "8px 16px", color: "var(--accent-rose)" }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>🎯</span>
            <h3>No scanners yet</h3>
            <p>Create your first no-code scanner above</p>
          </div>
        )}
      </div>

      {/* Scan Results Modal */}
      {scanResults && (
        <div className={styles.resultsOverlay} onClick={() => setScanResults(null)}>
          <div className={styles.resultsModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.resultsHeader}>
              <h2>Scan Results</h2>
              <button className={styles.closeBtn} onClick={() => setScanResults(null)}>✕</button>
            </div>
            <p className={styles.resultsCount}>
              {scanResults.count} stock{scanResults.count !== 1 ? "s" : ""} matched
            </p>
            <ViewAllOnCharts symbols={(scanResults.matches || []).map(m => m.symbol)} label="Custom Scanner" style={{ marginBottom: 10 }} />
            {scanResults.matches?.length > 0 ? (
              <div className={styles.matchList}>
                {scanResults.matches.map((m, i) => (
                  <a key={i} href={`/dashboard/charts?symbol=${m.symbol}&tf=D`} className={styles.matchItem}>
                    <span className={styles.matchSymbol}>{m.symbol}</span>
                    <span className={styles.matchName}>{m.name}</span>
                    {m.sector && (
                      <span style={{ fontSize: "11px", color: "var(--text-muted)", backgroundColor: "var(--bg-secondary)", padding: "2px 8px", borderRadius: "4px", marginRight: "12px", whiteSpace: "nowrap" }}>
                        {m.sector}
                      </span>
                    )}
                    <span className={styles.matchPrice}>₹{m.close?.toLocaleString("en-IN")}</span>
                  </a>
                ))}
              </div>
            ) : (
              <p className={styles.noMatches}>No stocks matched the scanner criteria.</p>
            )}
          </div>
        </div>
      )}

      {/* Premium Upgrade Modal */}
      {premiumUpgradeMessage && (
        <div className={styles.premiumOverlay} onClick={() => setPremiumUpgradeMessage(null)}>
          <div className={styles.premiumModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.premiumHeader}>
              <span className={styles.premiumIcon}>⭐</span>
              <h2>Premium Feature</h2>
            </div>
            <p className={styles.premiumText}>{premiumUpgradeMessage}</p>
            <div className={styles.premiumCtas}>
              <a href="/dashboard/pricing" className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }}>
                🚀 Upgrade Plan Now
              </a>
              <button className="btn btn-outline" onClick={() => setPremiumUpgradeMessage(null)} style={{ width: "100%", justifyContent: "center" }}>
                Maybe Later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
