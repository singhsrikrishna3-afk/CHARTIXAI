"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import styles from "./pricing.module.css";

const PLAN_TIERS = [
  {
    id: "eod_basic",
    name: "EOD Basic",
    price: "₹499",
    priceNum: 499,
    period: "/month",
    features: [
      "Daily charts",
      "Pattern screener (19 types)",
      "5 custom scanners",
      "Auto trendlines",
    ],
    featuresMissing: ["Bar replay", "Intraday data", "Visual scan exports"],
    accent: false,
    icon: "📊",
    gradient: "linear-gradient(135deg, #1a1f2e, #232a3d)",
  },
  {
    id: "eod_pro",
    name: "EOD Pro",
    price: "₹799",
    priceNum: 799,
    period: "/month",
    features: [
      "Daily + Weekly + Monthly charts",
      "All 19 pattern types",
      "Unlimited custom scanners",
      "Bar replay backtesting",
      "Auto trendlines",
    ],
    featuresMissing: ["Intraday data", "Visual scan exports"],
    accent: false,
    icon: "📈",
    gradient: "linear-gradient(135deg, #1a1040, #2a1a50)",
  },
  {
    id: "intraday_pro",
    name: "Intraday Pro",
    price: "₹1,499",
    priceNum: 1499,
    period: "/month",
    features: [
      "Everything in EOD Pro",
      "1-min delayed intraday (400 stocks)",
      "All timeframes (1m to Monthly)",
      "Unlimited scanners",
      "Bar replay + repaint detection",
      "Visual scan image exports",
    ],
    featuresMissing: [],
    accent: true,
    icon: "⚡",
    gradient: "linear-gradient(135deg, #0f1a3a, #1a2a5a)",
  },
];

export default function PricingPage() {
  const [subscription, setSubscription] = useState(null);
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState(""); // "success" | "error"

  useEffect(() => {
    api.getSubscriptionStatus()
      .then(setSubscription)
      .catch(() => {});
  }, []);

  const handleCheckout = async (planId) => {
    setCheckoutLoading(planId);
    setMessage("");

    try {
      const order = await api.createCheckout(planId);

      // Load Razorpay SDK dynamically
      if (!window.Razorpay) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://checkout.razorpay.com/v1/checkout.js";
          script.onload = resolve;
          script.onerror = reject;
          document.body.appendChild(script);
        });
      }

      const options = {
        key: order.key,
        amount: order.amount,
        currency: order.currency,
        name: "PEESTOCK",
        description: `${order.plan} Subscription`,
        order_id: order.order_id,
        prefill: {
          email: order.user_email,
          name: order.user_name,
        },
        theme: {
          color: "#6366f1",
          backdrop_color: "rgba(10, 14, 23, 0.85)",
        },
        handler: async (response) => {
          // Verify payment
          try {
            const result = await api.verifyPayment({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              plan_id: planId,
            });

            setMessage(result.message || "Subscription activated!");
            setMessageType("success");

            // Refresh subscription status
            const sub = await api.getSubscriptionStatus();
            setSubscription(sub);
          } catch (err) {
            setMessage("Payment verification failed. Contact support.");
            setMessageType("error");
          }
        },
        modal: {
          ondismiss: () => {
            setCheckoutLoading(null);
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", (response) => {
        setMessage(`Payment failed: ${response.error.description}`);
        setMessageType("error");
      });
      rzp.open();
    } catch (err) {
      setMessage(err.message || "Checkout failed");
      setMessageType("error");
    } finally {
      setCheckoutLoading(null);
    }
  };

  const isCurrentPlan = (planId) => {
    return subscription?.tier === planId && subscription?.status !== "expired";
  };

  return (
    <div className={styles.pricingPage}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>
          Upgrade Your <span className={styles.titleAccent}>Trading Edge</span>
        </h1>
        <p className={styles.subtitle}>
          Choose a plan that matches your analysis needs. All plans include a 14-day
          money-back guarantee.
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
            <div className={styles.planPrice}>
              {plan.price}
              <span className={styles.planPeriod}>{plan.period}</span>
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

            <button
              className={`btn ${plan.accent ? "btn-primary" : "btn-outline"} ${styles.planBtn}`}
              onClick={() => handleCheckout(plan.id)}
              disabled={checkoutLoading === plan.id || isCurrentPlan(plan.id)}
              id={`checkout-${plan.id}`}
            >
              {checkoutLoading === plan.id
                ? "Processing..."
                : isCurrentPlan(plan.id)
                ? "Current Plan"
                : "Subscribe"}
            </button>
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
              a: "All new accounts get a 14-day free trial with basic EOD features.",
            },
            {
              q: "What payment methods are accepted?",
              a: "We accept UPI, debit/credit cards, netbanking, and wallets via Razorpay.",
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
    </div>
  );
}
