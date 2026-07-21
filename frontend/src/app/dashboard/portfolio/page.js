"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./portfolio.module.css";

const EMPTY_FORM = { symbol: "", quantity: "", buy_price: "", buy_date: "", notes: "" };

export default function PortfolioPage() {
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api.listPositions();
      setPositions(data);
    } catch (err) {
      console.error("Portfolio load error:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.addPosition({
        symbol: form.symbol.trim().toUpperCase(),
        quantity: parseFloat(form.quantity),
        buy_price: parseFloat(form.buy_price),
        buy_date: form.buy_date,
        notes: form.notes || null,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.message || "Failed to add position");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm("Remove this position?")) return;
    try {
      await api.deletePosition(id);
      setPositions((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      alert("Failed to delete: " + err.message);
    }
  }

  const totals = positions.reduce(
    (acc, p) => {
      acc.invested += p.invested;
      acc.current += p.current_value ?? p.invested;
      return acc;
    },
    { invested: 0, current: 0 }
  );
  const totalPnl = totals.current - totals.invested;
  const totalPnlPct = totals.invested ? (totalPnl / totals.invested) * 100 : 0;

  return (
    <div className={styles.portfolioPage}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>💼 My Portfolio</h1>
          <p className={styles.pageSubtitle}>Manually tracked holdings with live P&amp;L</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Add Position"}
        </button>
      </div>

      {!loading && positions.length > 0 && (
        <div className={styles.summaryRow}>
          <div className={styles.summaryCard}>
            <span className={styles.summaryLabel}>Invested</span>
            <span className="mono">₹{totals.invested.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
          <div className={styles.summaryCard}>
            <span className={styles.summaryLabel}>Current Value</span>
            <span className="mono">₹{totals.current.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
          <div className={styles.summaryCard}>
            <span className={styles.summaryLabel}>Total P&amp;L</span>
            <span className={totalPnl >= 0 ? "price-up" : "price-down"}>
              {totalPnl >= 0 ? "+" : ""}₹{totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })} ({totalPnlPct.toFixed(2)}%)
            </span>
          </div>
        </div>
      )}

      {showForm && (
        <form className={styles.addForm} onSubmit={handleSubmit}>
          <div className={styles.formRow}>
            <input className="input" placeholder="Symbol" value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })} required />
            <input className="input" type="number" step="any" placeholder="Quantity" value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
            <input className="input" type="number" step="any" placeholder="Buy Price" value={form.buy_price}
              onChange={(e) => setForm({ ...form, buy_price: e.target.value })} required />
            <input className="input" type="date" value={form.buy_date}
              onChange={(e) => setForm({ ...form, buy_date: e.target.value })} required />
          </div>
          <input className="input" placeholder="Notes (optional)" value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          {error && <p className={styles.errorText}>{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save Position"}
          </button>
        </form>
      )}

      {loading ? (
        <p className={styles.emptyHint}>Loading…</p>
      ) : positions.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>💼</span>
          <p>No holdings yet.</p>
          <p className={styles.emptyHint}>Add a position to start tracking your portfolio.</p>
        </div>
      ) : (
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Symbol</span>
            <span>Qty</span>
            <span>Buy Price</span>
            <span>Current</span>
            <span>Invested</span>
            <span>P&amp;L</span>
            <span></span>
          </div>
          {positions.map((p) => (
            <div className={styles.tableRow} key={p.id}>
              <span className={styles.symbolCell}>
                <strong>{p.symbol}</strong>
                <span className={styles.nameSub}>{p.name}</span>
              </span>
              <span className="mono">{p.quantity}</span>
              <span className="mono">₹{p.buy_price.toFixed(2)}</span>
              <span className="mono">{p.current_price != null ? `₹${p.current_price.toFixed(2)}` : "—"}</span>
              <span className="mono">₹{p.invested.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span className={p.pnl >= 0 ? "price-up" : "price-down"}>
                {p.pnl != null ? `${p.pnl >= 0 ? "+" : ""}₹${p.pnl.toFixed(2)} (${p.pnl_pct.toFixed(2)}%)` : "—"}
              </span>
              <button className={styles.removeBtn} onClick={() => handleDelete(p.id)} title="Remove">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
