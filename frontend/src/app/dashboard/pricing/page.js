"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./pricing.module.css";

const PLAN_TIERS = [
  {
    id: "free",
    name: "Free",
    price: "₹0",
    priceNum: 0,
    period: "for 7 days",
    tagline: "7-day free trial",
    features: [
      "Full-featured charts + saved layouts",
      "Watchlist & portfolio tracking",
      "Auto trendlines on any chart",
      "Paper trading — test before you pay",
      "Bar replay (latest period)",
      "In-app price alerts",
    ],
    featuresMissing: ["Expires after 7 days", "Scanners & pattern win rates", "Swing recommendations"],
    accent: false,
    icon: "🌱",
    gradient: "linear-gradient(135deg, #14181f, #1a2028)",
  },
  {
    id: "eod_basic",
    name: "EOD Basic",
    price: "₹299",
    priceNum: 299,
    period: "/month",
    priceWeekly: "₹99",
    weeklyId: "eod_basic_weekly",
    tagline: "Find your own setups",
    features: [
      "Everything in Free",
      "All scanners — MA, indicator, candlestick, breakout, VCP, 52-week & more",
      "Pattern screener with BACKTESTED win rates",
      "View-All-on-Charts scan review flow",
      "Bar replay 🎲 random-period practice + trading sim",
      "Unlimited paper trades with scale-out tracking",
    ],
    featuresMissing: ["Swing recommendations", "Telegram alerts"],
    accent: false,
    icon: "📊",
    gradient: "linear-gradient(135deg, #1a1f2e, #232a3d)",
  },
  {
    id: "eod_pro",
    name: "EOD Pro",
    price: "₹599",
    priceNum: 599,
    period: "/month",
    priceWeekly: "₹199",
    weeklyId: "eod_pro_weekly",
    tagline: "Get told what & when",
    features: [
      "Everything in Basic",
      "Swing recommendations — entry, stop, T1/T2, sizing; every pick >50% backtested win rate",
      "Market-regime auto-defense (picks tighten & size down in weak markets)",
      "Earnings Shield — never enter right before results",
      "Delivery Money Flow — per-stock Delivery MFI + sector accumulation board",
      "✈️ Telegram alerts — stop hit, book-half at T1, earnings ahead",
      "Weekly & Monthly timeframes + custom scanner",
    ],
    featuresMissing: ["AI Price Forecast (LSTM)"],
    accent: true,
    icon: "🎯",
    gradient: "linear-gradient(135deg, #1a1040, #2a1a50)",
  },
  {
    id: "ai_eod_pro",
    name: "AI EOD Pro",
    price: "₹999",
    priceNum: 999,
    period: "/month",
    priceWeekly: "₹299",
    weeklyId: "ai_eod_pro_weekly",
    tagline: "The full edge",
    features: [
      "Everything in Pro",
      "AI Price Forecast (LSTM) with 5-day predicted bands",
      "360° all-round scores — technicals + money flow + fundamentals",
      "Priority support & earliest access to new features",
    ],
    featuresMissing: [],
    accent: false,
    icon: "🤖",
    gradient: "linear-gradient(135deg, #0f1a3a, #1a2a5a)",
  },
];

export default function PricingPage() {
  const [subscription, setSubscription] = useState(null);
  const [billing, setBilling] = useState("monthly"); // "weekly" | "monthly"
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState(""); // "success" | "error"

  useEffect(() => {
    api.getSubscriptionStatus()
      .then(setSubscription)
      .catch(() => {});
  }, []);

  // WhatsApp-based subscription: contact us, we share the UPI scanner, the
  // customer sends a payment screenshot + their Chartix login email, and we
  // activate access within 12 hours. No self-service UPI/UTR flow.
  const WHATSAPP_NUMBER = "918789702002";

  const handleCheckout = (planId) => {
    const plan = PLAN_TIERS.find((p) => p.id === planId);
    const weekly = billing === "weekly" && plan?.weeklyId;
    const label = plan
      ? (weekly ? `${plan.name} Weekly (${plan.priceWeekly}/week)` : `${plan.name} (${plan.price}/month)`)
      : planId;
    const text =
      `Hi Chartix, I'd like to subscribe to the *${label}* plan.\n\n` +
      `Please share the UPI payment details. I'll send the payment screenshot ` +
      `and the email ID I use to log in to Chartix.`;
    const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const isCurrentPlan = (planId) => {
    const t = subscription?.tier;
    return (t === planId || t === `${planId}_weekly`) && subscription?.status !== "expired";
  };

  return (
    <div className={styles.pricingPage}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>
          Upgrade Your <span className={styles.titleAccent}>Trading Edge</span>
        </h1>
        <p className={styles.subtitle}>
          Every recommendation shows its <b>backtested win rate</b> — and you can paper-trade
          any plan risk-free before paying a rupee. No black boxes.
        </p>
      </div>

      {/* Current Plan Banner */}
      {subscription && subscription.tier !== "free" && (
        <div className={styles.currentBanner}>
          <div className={styles.bannerIcon}>⭐</div>
          <div className={styles.bannerInfo}>
            <span className={styles.bannerLabel}>Current Plan</span>
            <span className={styles.bannerTier}>
              {subscription.tier?.replace(/_/g, " ").toUpperCase()}
            </span>
          </div>
          <span className={`badge ${subscription.status === "active" || subscription.status === "trial" ? "badge-green" : "badge-red"}`}>
            {subscription.status}
          </span>
          {subscription.expires_at && (
            <span className={styles.bannerExpiry}>
              Expires: {new Date(subscription.expires_at).toLocaleDateString("en-IN")}
            </span>
          )}
        </div>
      )}

      {/* Message */}
      {message && (
        <div className={`${styles.message} ${messageType === "success" ? styles.messageSuccess : styles.messageError}`}>
          {messageType === "success" ? "✓" : "⚠"} {message}
        </div>
      )}

      {/* Billing period toggle */}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 0, marginBottom: 4 }}>
        <div style={{ display: "inline-flex", border: "1px solid var(--border-default,#333)", borderRadius: 24, overflow: "hidden" }}>
          {[["weekly", "Weekly"], ["monthly", "Monthly"]].map(([k, label]) => (
            <button key={k} onClick={() => setBilling(k)}
              style={{
                border: "none", cursor: "pointer", padding: "9px 22px", fontWeight: 700, fontSize: "0.85rem",
                background: billing === k ? "#6366f1" : "transparent",
                color: billing === k ? "#fff" : "var(--text-secondary,#cbd5e1)",
              }}>
              {label}{k === "monthly" && <span style={{ marginLeft: 6, fontSize: "0.68rem", color: billing === k ? "#c7f9d9" : "#10b981", fontWeight: 800 }}>SAVE ~30%</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Plans Grid */}
      <div className={styles.plansGrid}>
        {PLAN_TIERS.map((plan) => (
          <div
            key={plan.id}
            className={`${styles.planCard} ${plan.accent ? styles.planCardAccent : ""}`}
            style={{ background: plan.gradient }}
          >
            {plan.accent && <div className={styles.planBadge}>Most Popular</div>}

            <div className={styles.planIcon}>{plan.icon}</div>
            <h3 className={styles.planName}>{plan.name}</h3>
            {plan.tagline && (
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #9ca3af)", fontWeight: 600, marginBottom: 6 }}>
                {plan.tagline}
              </div>
            )}
            <div className={styles.planPrice}>
              {billing === "weekly" && plan.priceWeekly ? plan.priceWeekly : plan.price}
              <span className={styles.planPeriod}>
                {plan.id === "free" ? plan.period : (billing === "weekly" && plan.priceWeekly ? "/week" : "/month")}
              </span>
            </div>

            <ul className={styles.planFeatures}>
              {plan.features.map((f) => (
                <li key={f} className={styles.featureIncluded}>
                  <span className={styles.featureCheck}>✓</span> {f}
                </li>
              ))}
              {plan.featuresMissing.map((f) => (
                <li key={f} className={styles.featureMissing}>
                  <span className={styles.featureX}>✗</span> {f}
                </li>
              ))}
            </ul>

            {plan.id === "free" ? (
              <button className={`btn btn-outline ${styles.planBtn}`} disabled id="checkout-free">
                {(!subscription || subscription.tier === "free") ? "Your current plan" : "Included with signup"}
              </button>
            ) : (
              <button
                className={`btn ${plan.accent ? "btn-primary" : "btn-outline"} ${styles.planBtn}`}
                onClick={() => handleCheckout(plan.id)}
                disabled={isCurrentPlan(plan.id)}
                id={`checkout-${plan.id}`}
              >
                {isCurrentPlan(plan.id) ? "Current Plan" : "💬 Subscribe on WhatsApp"}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* FAQ */}
      <div className={styles.faqSection}>
        <h2 className={styles.faqTitle}>Frequently Asked Questions</h2>
        <div className={styles.faqGrid}>
          {[
            {
              q: "Can I change plans later?",
              a: "Yes! Upgrade or downgrade anytime. We'll prorate the difference.",
            },
            {
              q: "Is there a free trial?",
              a: "Every new account gets 7 days free — full access to the Free plan (charts, RRG, paper trading, watchlist). After 7 days you'll need EOD Basic (from ₹99/week) to continue.",
            },
            {
              q: "How do I subscribe and how long until I get access?",
              a: "Tap 'Subscribe on WhatsApp' and message us at +91 87897 02002. We'll share the UPI payment scanner. Pay, then send us the payment screenshot along with the email ID you use to log in to Chartix. Your access is activated within 12 hours.",
            },
            {
              q: "Can I cancel anytime?",
              a: "Absolutely. No lock-in period. Cancel from your dashboard anytime.",
            },
          ].map((faq, i) => (
            <div key={i} className={styles.faqItem}>
              <h4 className={styles.faqQ}>{faq.q}</h4>
              <p className={styles.faqA}>{faq.a}</p>
            </div>
          ))}
        </div>
      </div>

      {/* How subscription works — WhatsApp flow */}
      <div className={styles.faqSection}>
        <h2 className={styles.faqTitle}>How to Subscribe</h2>
        <ol style={{ maxWidth: 640, margin: "0 auto", lineHeight: 1.9, fontSize: "0.95rem", color: "var(--text-secondary, #cbd5e1)" }}>
          <li>Tap <strong>💬 Subscribe on WhatsApp</strong> on the plan you want.</li>
          <li>We'll reply with the UPI payment scanner / UPI ID.</li>
          <li>Pay the amount, then send us a <strong>screenshot of the payment</strong> along with the <strong>email ID you use to log in to Chartix</strong>.</li>
          <li>Your access is activated within <strong>12 hours</strong> (usually much faster).</li>
        </ol>
        <div style={{ textAlign: "center", marginTop: 20 }}>
          <a
            href="https://wa.me/918789702002?text=Hi%20Chartix%2C%20I%27d%20like%20to%20subscribe.%20Please%20share%20the%20payment%20details."
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: "#25D366", color: "#fff", fontWeight: 700, fontSize: "0.95rem",
              padding: "12px 22px", borderRadius: 10, textDecoration: "none",
            }}
          >
            <span style={{ fontSize: "1.15rem" }}>💬</span>
            Chat with us: +91 87897 02002
          </a>
        </div>
      </div>
    </div>
  );
}
