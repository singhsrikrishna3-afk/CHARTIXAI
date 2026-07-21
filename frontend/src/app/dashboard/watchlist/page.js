"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./watchlist.module.css";

export default function WatchlistPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [symbolInput, setSymbolInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api.getMyWatchlist();
      setItems(data);
    } catch (err) {
      console.error("Watchlist load error:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    const symbol = symbolInput.trim().toUpperCase();
    if (!symbol) return;
    setAdding(true);
    setError("");
    try {
      await api.addToWatchlist(symbol);
      setSymbolInput("");
      await load();
    } catch (err) {
      setError(err.message || "Failed to add symbol");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(symbol) {
    try {
      await api.removeFromWatchlist(symbol);
      setItems((prev) => prev.filter((i) => i.symbol !== symbol));
    } catch (err) {
      alert("Failed to remove: " + err.message);
    }
  }

  return (
    <div className={styles.watchlistPage}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>⭐ My Watchlist</h1>
          <p className={styles.pageSubtitle}>Track the symbols you care about</p>
        </div>
      </div>

      <form className={styles.addForm} onSubmit={handleAdd}>
        <input
          className="input"
          placeholder="Enter symbol (e.g. RELIANCE)"
          value={symbolInput}
          onChange={(e) => setSymbolInput(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={adding}>
          {adding ? "Adding…" : "+ Add"}
        </button>
      </form>
      {error && <p className={styles.errorText}>{error}</p>}

      {loading ? (
        <p className={styles.emptyHint}>Loading…</p>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>⭐</span>
          <p>Your watchlist is empty.</p>
          <p className={styles.emptyHint}>Add a symbol above to start tracking it.</p>
        </div>
      ) : (
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Symbol</span>
            <span>Sector</span>
            <span>Price</span>
            <span>Change</span>
            <span>Volume</span>
            <span></span>
          </div>
          {items.map((item) => (
            <div className={styles.tableRow} key={item.symbol}>
              <span className={styles.symbolCell}>
                <strong>{item.symbol}</strong>
                <span className={styles.nameSub}>{item.name}</span>
              </span>
              <span className={styles.sectorCell}>{item.sector || "—"}</span>
              <span className="mono">₹{item.price.toFixed(2)}</span>
              <span className={item.change >= 0 ? "price-up" : "price-down"}>
                {item.change >= 0 ? "+" : ""}{item.change.toFixed(2)} ({item.change_pct.toFixed(2)}%)
              </span>
              <span className="mono">{item.volume.toLocaleString()}</span>
              <button className={styles.removeBtn} onClick={() => handleRemove(item.symbol)} title="Remove">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
