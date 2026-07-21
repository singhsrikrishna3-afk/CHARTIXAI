"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./scanners.module.css";

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

  // Builder state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [conditions, setConditions] = useState([{ ...EMPTY_CONDITION }]);
  const [logic, setLogic] = useState("AND");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);

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
      alert(err.message || "Failed to save scanner");
    } finally {
      setSaving(false);
    }
  }

  async function handleRun(scannerId) {
    setRunningId(scannerId);
    setScanResults(null);
    try {
      const result = await api.runScanner(scannerId);
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
              <div className={styles.scannerActions}>
                <button
                  className="btn btn-primary"
                  onClick={() => handleRun(scanner.id)}
                  disabled={runningId === scanner.id}
                  style={{ fontSize: "0.82rem", padding: "8px 16px" }}
                >
                  {runningId === scanner.id ? "Running..." : "▶ Run Scanner"}
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
            {scanResults.matches?.length > 0 ? (
              <div className={styles.matchList}>
                {scanResults.matches.map((m, i) => (
                  <a key={i} href={`/dashboard/charts?symbol=${m.symbol}`} className={styles.matchItem}>
                    <span className={styles.matchSymbol}>{m.symbol}</span>
                    <span className={styles.matchName}>{m.name}</span>
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
    </div>
  );
}
