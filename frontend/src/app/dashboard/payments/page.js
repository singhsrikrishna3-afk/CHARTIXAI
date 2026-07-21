"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function PaymentsPage() {
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    api.getPendingPayments()
      .then(data => { setPending(data); setLoading(false); })
      .catch(err => { setError(err.message || "Failed to load"); setLoading(false); });
  }, []);

  const handleApprove = async (subId) => {
    try {
      const res = await api.approvePayment(subId);
      setMessage(res.message || "Approved");
      setPending(prev => prev.filter(p => p.sub_id !== subId));
    } catch (err) {
      setMessage("Error: " + (err.message || "Failed to approve"));
    }
  };

  const handleReject = async (subId) => {
    if (!confirm("Reject this payment? This cannot be undone.")) return;
    try {
      const res = await api.rejectPayment(subId);
      setMessage(res.message || "Rejected");
      setPending(prev => prev.filter(p => p.sub_id !== subId));
    } catch (err) {
      setMessage("Error: " + (err.message || "Failed to reject"));
    }
  };

  return (
    <div style={{ padding: "24px", maxWidth: "860px" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "6px" }}>Pending UPI Payments</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: "24px", fontSize: "0.875rem" }}>
        Verify each UTR number in your UPI app (peestocks@upi) before approving.
      </p>

      {message && (
        <div style={{
          marginBottom: "16px", padding: "12px 16px",
          background: message.startsWith("Error") ? "rgba(239,68,68,0.1)" : "rgba(16,185,129,0.1)",
          border: `1px solid ${message.startsWith("Error") ? "#ef4444" : "#10b981"}`,
          borderRadius: "8px", fontSize: "0.875rem",
          color: message.startsWith("Error") ? "#ef4444" : "#10b981",
        }}>
          {message}
        </div>
      )}

      {error && (
        <div style={{ padding: "16px", background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", borderRadius: "8px", color: "#ef4444" }}>
          {error === "Forbidden" ? "Access denied — admin only." : error}
        </div>
      )}

      {loading && <p style={{ color: "var(--text-muted)" }}>Loading...</p>}

      {!loading && !error && pending.length === 0 && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", background: "var(--bg-secondary)", borderRadius: "12px" }}>
          No pending payments.
        </div>
      )}

      {pending.map(p => (
        <div
          key={p.sub_id}
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-color)",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "12px",
            display: "flex",
            alignItems: "center",
            gap: "16px",
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>{p.user_email}</div>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <span>Plan: <b style={{ color: "var(--text-color)" }}>{p.tier?.replace(/_/g, " ").toUpperCase()}</b></span>
              <span>Amount: <b style={{ color: "#10b981" }}>₹{p.amount}</b></span>
              <span>UTR: <code style={{ background: "var(--bg-primary)", padding: "1px 6px", borderRadius: "4px", fontSize: "0.8rem" }}>{p.utr}</code></span>
              <span>{new Date(p.created_at).toLocaleString("en-IN")}</span>
            </div>
          </div>
          <button
            onClick={() => handleApprove(p.sub_id)}
            style={{
              background: "#10b981", color: "#fff", border: "none",
              borderRadius: "8px", padding: "8px 18px",
              cursor: "pointer", fontWeight: 600, fontSize: "0.875rem",
              whiteSpace: "nowrap",
            }}
          >
            ✓ Approve
          </button>
          <button
            onClick={() => handleReject(p.sub_id)}
            style={{
              background: "transparent", color: "#ef4444",
              border: "1px solid #ef4444",
              borderRadius: "8px", padding: "8px 18px",
              cursor: "pointer", fontSize: "0.875rem",
              whiteSpace: "nowrap",
            }}
          >
            ✕ Reject
          </button>
        </div>
      ))}
    </div>
  );
}
