"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./alerts.module.css";

const EMPTY_FORM = { symbol: "", alert_type: "price_above", target_price: "", pattern_type: "" };

export default function AlertsPage() {
  const [rules, setRules] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Telegram delivery
  const [tg, setTg] = useState(null);        // {enabled, bot, linked, pending_code}
  const [tgCode, setTgCode] = useState(null); // freshly minted link code

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [r, n, t] = await Promise.all([
        api.listAlertRules(), api.listNotifications(),
        api.getTelegramStatus().catch(() => null),
      ]);
      setRules(r);
      setNotifications(n);
      setTg(t);
    } catch (err) {
      console.error("Alerts load error:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleLinkTelegram() {
    try {
      const res = await api.linkTelegram();
      setTgCode(res);
    } catch (err) {
      setError(err.message || "Telegram linking unavailable");
    }
  }

  async function handleUnlinkTelegram() {
    try { await api.unlinkTelegram(); setTgCode(null); await load(); } catch (e) {}
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { alert_type: form.alert_type };
      if (form.alert_type === "pattern") {
        if (form.symbol.trim()) payload.symbol = form.symbol.trim().toUpperCase();
        if (form.pattern_type.trim()) payload.pattern_type = form.pattern_type.trim();
      } else {
        payload.symbol = form.symbol.trim().toUpperCase();
        payload.target_price = parseFloat(form.target_price);
      }
      await api.createAlertRule(payload);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.message || "Failed to create alert");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRule(id) {
    try {
      await api.deleteAlertRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      alert("Failed to delete: " + err.message);
    }
  }

  async function handleMarkRead(id) {
    try {
      await api.markNotificationRead(id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    } catch (err) {
      console.error(err);
    }
  }

  async function handleMarkAllRead() {
    try {
      await api.markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    } catch (err) {
      console.error(err);
    }
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div className={styles.alertsPage}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>
            🔔 Alerts {unreadCount > 0 && <span className={styles.unreadBadge}>{unreadCount}</span>}
          </h1>
          <p className={styles.pageSubtitle}>Price &amp; pattern alerts, delivered in-app</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New Alert"}
        </button>
      </div>

      {/* Telegram delivery card */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
        background: "rgba(41,98,255,0.06)", border: "1px solid rgba(41,98,255,0.3)",
        borderRadius: 12, padding: "12px 16px", margin: "12px 0 18px" }}>
        <div style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
          <b>✈️ Telegram delivery</b>{" — "}
          {!tg?.enabled ? (
            <span style={{ color: "var(--text-muted,#9ca3af)" }}>
              not configured on the server yet. Alerts still appear in-app; Telegram switches on once the bot is set up.
            </span>
          ) : tg?.linked ? (
            <span style={{ color: "#10b981", fontWeight: 700 }}>linked ✓ — price triggers, patterns, and swing events (stop / T1 / T2 / earnings) reach your Telegram.</span>
          ) : tgCode ? (
            <span>
              Open Telegram → search <b>@{tgCode.bot}</b> → send{" "}
              <code style={{ background: "rgba(255,255,255,0.08)", padding: "2px 8px", borderRadius: 6, fontWeight: 800 }}>
                /start {tgCode.code}
              </code>{" "}
              — linked within ~10 minutes.
            </span>
          ) : (
            <span style={{ color: "var(--text-muted,#9ca3af)" }}>get alerts on your phone — price triggers, pattern hits, and swing events on your paper trades.</span>
          )}
        </div>
        {tg?.enabled && (
          tg?.linked ? (
            <button onClick={handleUnlinkTelegram}
              style={{ background: "transparent", border: "1px solid rgba(239,68,68,0.4)", color: "#ef4444",
                borderRadius: 8, padding: "7px 14px", fontWeight: 700, cursor: "pointer", fontSize: "0.78rem" }}>
              Unlink
            </button>
          ) : (
            <button onClick={handleLinkTelegram}
              style={{ background: "#2962ff", color: "#fff", border: "none", borderRadius: 8,
                padding: "7px 16px", fontWeight: 700, cursor: "pointer", fontSize: "0.8rem" }}>
              {tgCode ? "↻ New code" : "Link Telegram"}
            </button>
          )
        )}
      </div>

      {showForm && (
        <form className={styles.addForm} onSubmit={handleSubmit}>
          <div className={styles.formRow}>
            <select className="input" value={form.alert_type}
              onChange={(e) => setForm({ ...form, alert_type: e.target.value })}>
              <option value="price_above">Price Above</option>
              <option value="price_below">Price Below</option>
              <option value="pattern">Pattern Detected</option>
            </select>
            <input className="input" placeholder={form.alert_type === "pattern" ? "Symbol (optional)" : "Symbol"}
              value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              required={form.alert_type !== "pattern"} />
            {form.alert_type === "pattern" ? (
              <input className="input" placeholder="Pattern type (optional, e.g. head_and_shoulders)"
                value={form.pattern_type} onChange={(e) => setForm({ ...form, pattern_type: e.target.value })} />
            ) : (
              <input className="input" type="number" step="any" placeholder="Target Price"
                value={form.target_price} onChange={(e) => setForm({ ...form, target_price: e.target.value })} required />
            )}
          </div>
          {error && <p className={styles.errorText}>{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create Alert"}
          </button>
        </form>
      )}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Alert Rules</h2>
        {loading ? (
          <p className={styles.emptyHint}>Loading…</p>
        ) : rules.length === 0 ? (
          <p className={styles.emptyHint}>No alert rules yet.</p>
        ) : (
          <div className={styles.table}>
            {rules.map((rule) => (
              <div className={styles.ruleRow} key={rule.id}>
                <span className={`badge ${rule.is_active ? "badge-green" : "badge-blue"}`}>
                  {rule.is_active ? "active" : "fired"}
                </span>
                <span className={styles.ruleDesc}>
                  {rule.alert_type === "pattern"
                    ? `${rule.symbol || "Any symbol"} · ${rule.pattern_type || "any pattern"}`
                    : `${rule.symbol} ${rule.alert_type === "price_above" ? ">" : "<"} ₹${rule.target_price}`}
                </span>
                <button className={styles.removeBtn} onClick={() => handleDeleteRule(rule.id)} title="Delete">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeaderRow}>
          <h2 className={styles.sectionTitle}>Notifications</h2>
          {unreadCount > 0 && (
            <button className="btn btn-outline" onClick={handleMarkAllRead}>Mark all read</button>
          )}
        </div>
        {loading ? (
          <p className={styles.emptyHint}>Loading…</p>
        ) : notifications.length === 0 ? (
          <p className={styles.emptyHint}>No notifications yet.</p>
        ) : (
          <div className={styles.table}>
            {notifications.map((n) => (
              <div className={`${styles.notifRow} ${!n.is_read ? styles.notifUnread : ""}`} key={n.id}
                onClick={() => !n.is_read && handleMarkRead(n.id)}>
                <span className={styles.notifMsg}>{n.message}</span>
                <span className={styles.notifTime}>{new Date(n.triggered_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
