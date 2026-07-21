"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";

const FEATURES = [
  {
    icon: "📐",
    title: "Auto Trendlines",
    desc: "Automatic support & resistance trendlines drawn on every chart. Find breakouts in seconds.",
    color: "#0000FF",
  },
  {
    icon: "🔮",
    title: "Chart Pattern Scanner",
    desc: "19+ patterns: Head & Shoulders, Double Top/Bottom, Triangles, Wedges, Flags, Wolfe Waves & more.",
    color: "#008000",
  },
  {
    icon: "📊",
    title: "MA Scanner",
    desc: "MA Crossover, MA Slope, MA Convergence. Mix with RSI filter. SMA 44 — the KeyStocks special.",
    color: "#AA0000",
  },
  {
    icon: "🕯️",
    title: "Candlestick Scanner",
    desc: "24+ patterns: Hammer, Engulfing, Morning Star, Doji, Marubozu and more.",
    color: "#006666",
  },
  {
    icon: "📈",
    title: "RSI / MACD Divergence",
    desc: "Positive & negative divergence scanner across all NSE stocks. Rare scan, powerful signal.",
    color: "#660066",
  },
  {
    icon: "⏪",
    title: "Bar Replay",
    desc: "Visual backtesting tool. Replay any stock's history bar by bar, test your strategies.",
    color: "#664400",
  },
  {
    icon: "🚀",
    title: "Breakout Scanner",
    desc: "Find stocks breaking above swing highs or below swing lows. With indicator confirmation.",
    color: "#004488",
  },
  {
    icon: "🌀",
    title: "Fibonacci Retracement",
    desc: "Find stocks at 38.2%, 50%, 61.8%, 78.6% retracement with volume confirmation.",
    color: "#226600",
  },
  {
    icon: "🎯",
    title: "Custom Query Builder",
    desc: "No-code custom scan builder. Mix any indicator + price condition. No programming needed.",
    color: "#880000",
  },
];

const SCAN_BADGES = [
  "Trendline Break", "Head & Shoulders", "Double Top/Bottom", "Triple Top/Bottom",
  "Ascending Triangle", "Descending Triangle", "Symmetric Triangle", "Rising Wedge",
  "Falling Wedge", "Bull Flag", "Bear Flag", "Pennant", "Rectangle", "Wolfe Waves",
  "Harmonic ABCD", "Fibonacci Retrace", "MA Crossover", "MA Slope", "MA Convergence",
  "RSI Divergence", "MACD Divergence", "BB Squeeze", "Volume Spike", "52W High/Low",
  "Breakout Scan", "Gap Analysis", "Pivot Points", "HH/HL Trend", "Bar Replay",
  "Candlestick Patterns", "Gann Swing", "Elliott Wave", "Custom Query",
];

const PRICING = [
  {
    name: "EOD Free Trial",
    price: "₹0",
    period: "2 weeks",
    color: "#008000",
    features: [
      "All EOD scanners",
      "2000+ NSE stocks",
      "19+ chart patterns",
      "24+ candlestick patterns",
      "MA Scanner (all types)",
      "Bar Replay",
      "Trendline Scanner",
    ],
    cta: "Start Free Trial",
    highlight: false,
  },
  {
    name: "EOD Annual",
    price: "₹2,000",
    period: "per year",
    color: "#0000FF",
    features: [
      "Everything in Free Trial",
      "Unlimited scans",
      "Export CSV results",
      "Priority support",
      "RSI/MACD Divergence",
      "Fibonacci Scanner",
      "Volume Analysis",
    ],
    cta: "Buy EOD Plan",
    highlight: true,
  },
  {
    name: "Intraday",
    price: "₹5,000",
    period: "per year",
    color: "#AA0000",
    features: [
      "Everything in EOD",
      "1-min data updates",
      "400+ top NSE stocks",
      "Intraday scanners",
      "Real-time alerts",
      "Custom query builder",
      "Email/SMS alerts",
    ],
    cta: "Buy Intraday Plan",
    highlight: false,
  },
];

// Animated ticker simulation
const TICKER_DATA = [
  { sym: "RELIANCE", price: "2847.50", chg: "+1.23%" },
  { sym: "TCS",      price: "3921.00", chg: "+0.87%" },
  { sym: "HDFCBANK", price: "1642.75", chg: "-0.34%" },
  { sym: "INFY",     price: "1789.25", chg: "+2.11%" },
  { sym: "SBIN",     price: "812.40",  chg: "+1.54%" },
  { sym: "ICICIBANK",price: "1124.60", chg: "-0.12%" },
  { sym: "BAJFINANCE",price:"7120.00", chg: "+0.95%" },
  { sym: "MARUTI",   price: "12450.00",chg: "+1.77%" },
  { sym: "TITAN",    price: "3615.50", chg: "+0.63%" },
  { sym: "AXISBANK", price: "1089.25", chg: "-0.45%" },
];

export default function HomePage() {
  const [tickerPos, setTickerPos] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setTickerPos((p) => (p + 1) % TICKER_DATA.length), 3000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className={styles.homePage}>

      {/* ── NAVBAR ──────────────────────────────────────────── */}
      <nav className={`${styles.nav} ${scrolled ? styles.navScrolled : ""}`}>
        <div className={styles.navInner}>
          <a href="/" className={styles.navLogo}>
            <span className={styles.logoIcon}>📈</span>
            <span className={styles.logoText}>PeeStocks</span>
          </a>
          <div className={styles.navLinks}>
            <a href="#features" className={styles.navLink}>Features</a>
            <a href="#scans"    className={styles.navLink}>Scans</a>
            <a href="#pricing"  className={styles.navLink}>Pricing</a>
            <a href="/dashboard" className={styles.navCta} id="nav-start-btn">
              Open Dashboard →
            </a>
          </div>
        </div>
      </nav>

      {/* ── TICKER BAR ──────────────────────────────────────── */}
      <div className={styles.tickerBar}>
        <span className={styles.tickerLabel}>NSE LIVE</span>
        <div className={styles.tickerScroll}>
          {[...TICKER_DATA, ...TICKER_DATA].map((t, i) => (
            <span key={i} className={styles.tickerItem}>
              <span className={styles.tickerSym}>{t.sym}</span>
              <span className={styles.tickerPrice}>{t.price}</span>
              <span className={`${styles.tickerChg} ${t.chg.startsWith("+") ? styles.tickerUp : styles.tickerDown}`}>
                {t.chg}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* ── HERO ────────────────────────────────────────────── */}
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <div className={styles.heroBadge}>
            🇮🇳 Built for Indian Stock Market · NSE · BSE
          </div>
          <h1 className={styles.heroTitle}>
            Most Powerful<br />
            <span className={styles.heroHighlight}>Stock Scanner</span><br />
            for India
          </h1>
          <p className={styles.heroDesc}>
            Scan 2000+ NSE stocks across 30+ technical setups without writing a single line of code.
            Chart patterns, MA scans, candlesticks, divergence, breakouts — all in one place.
          </p>
          <div className={styles.heroCtas}>
            <a href="/dashboard" className={styles.ctaPrimary} id="hero-dashboard-btn">
              Open Dashboard Free →
            </a>
            <a href="#features" className={styles.ctaSecondary}>
              See All Features
            </a>
          </div>
          <div className={styles.heroStats}>
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>2,000+</span>
              <span className={styles.heroStatLabel}>NSE Stocks</span>
            </div>
            <div className={styles.heroStatDiv}/>
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>30+</span>
              <span className={styles.heroStatLabel}>Scan Types</span>
            </div>
            <div className={styles.heroStatDiv}/>
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>19+</span>
              <span className={styles.heroStatLabel}>Chart Patterns</span>
            </div>
            <div className={styles.heroStatDiv}/>
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>No Code</span>
              <span className={styles.heroStatLabel}>Required</span>
            </div>
          </div>
        </div>

        {/* Mock chart window */}
        <div className={styles.heroMockup}>
          <div className={styles.mockWindow}>
            <div className={styles.mockTitleBar}>
              <span className={styles.mockTitle}>PeeStocks — RELIANCE.NS — Daily</span>
              <div className={styles.mockButtons}>
                <span className={styles.mockBtn} />
                <span className={styles.mockBtn} />
                <span className={styles.mockBtn} />
              </div>
            </div>
            <div className={styles.mockToolbar}>
              {["D", "W", "M"].map(tf => (
                <button key={tf} className={`${styles.mockTf} ${tf === "D" ? styles.mockTfActive : ""}`}>{tf}</button>
              ))}
              <span style={{ flex: 1 }} />
              {["SMA 44", "SMA 200", "RSI", "MACD"].map(ind => (
                <button key={ind} className={styles.mockInd}>{ind}</button>
              ))}
            </div>
            {/* Fake chart area */}
            <div className={styles.mockChart}>
              <svg viewBox="0 0 400 180" style={{ width: "100%", height: "100%" }}>
                {/* Grid lines */}
                {[40,80,120,160].map(y => (
                  <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="#E0E0E0" strokeWidth="0.5" strokeDasharray="3,3"/>
                ))}
                {/* Fake candles */}
                {[...Array(30)].map((_, i) => {
                  const x = 8 + i * 13;
                  const rng = Math.random();
                  const isUp = rng > 0.42;
                  const bodyH = 8 + Math.random() * 20;
                  const bodyY = 20 + Math.random() * 100;
                  return (
                    <g key={i}>
                      <line x1={x+3} y1={bodyY - 4} x2={x+3} y2={bodyY + bodyH + 4}
                        stroke={isUp ? "#26a69a" : "#ef5350"} strokeWidth="1" />
                      <rect x={x} y={bodyY} width={6} height={bodyH}
                        fill={isUp ? "#FFFFFF" : "#ef5350"}
                        stroke={isUp ? "#26a69a" : "#ef5350"} strokeWidth="1" />
                    </g>
                  );
                })}
                {/* Fake SMA line */}
                <polyline
                  points={[...Array(30)].map((_, i) => `${8+i*13+3},${60 + Math.sin(i*0.4)*25}`).join(" ")}
                  fill="none" stroke="#FF6600" strokeWidth="1.5" />
                {/* Label */}
                <text x="6" y="175" fontSize="10" fill="#666">SMA 44</text>
                <rect x="40" y="170" width="20" height="4" fill="#FF6600" />
              </svg>
              {/* RSI sub-pane */}
              <div className={styles.mockRsi}>
                <span className={styles.mockRsiLabel}>RSI 14</span>
                <svg viewBox="0 0 400 40" style={{ width: "100%", height: 40 }}>
                  <line x1="0" y1="20" x2="400" y2="20" stroke="#E0E0E0" strokeWidth="0.5" strokeDasharray="2,2"/>
                  <polyline
                    points={[...Array(30)].map((_, i) => `${8+i*13+3},${10 + Math.sin(i*0.5+1)*15}`).join(" ")}
                    fill="none" stroke="#800080" strokeWidth="1.5" />
                </svg>
              </div>
            </div>
            <div className={styles.mockStatus}>
              <span className={styles.mockStatusDot} />
              <span>2 patterns detected · Bullish Engulfing · RSI Oversold</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── SCAN BADGES ─────────────────────────────────────── */}
      <section className={styles.scanBadgesSection} id="scans">
        <div className={styles.sectionHead}>
          <div className={styles.sectionLabel}>What you can scan</div>
          <h2 className={styles.sectionTitle}>30+ Scan Types at your fingertips</h2>
        </div>
        <div className={styles.badgesWrap}>
          {SCAN_BADGES.map((b) => (
            <span key={b} className={styles.scanBadge}>{b}</span>
          ))}
        </div>
      </section>

      {/* ── FEATURES ────────────────────────────────────────── */}
      <section className={styles.featuresSection} id="features">
        <div className={styles.sectionHead}>
          <div className={styles.sectionLabel}>Features</div>
          <h2 className={styles.sectionTitle}>Everything a Technical Analyst Needs</h2>
          <p className={styles.sectionSub}>
            No coding. No complexity. Just click, configure, and scan.
          </p>
        </div>
        <div className={styles.featuresGrid}>
          {FEATURES.map((f) => (
            <div key={f.title} className={styles.featureCard}>
              <div className={styles.featureIconWrap} style={{ borderColor: f.color }}>
                <span className={styles.featureIcon}>{f.icon}</span>
              </div>
              <h3 className={styles.featureTitle} style={{ color: f.color }}>{f.title}</h3>
              <p className={styles.featureDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── HOW IT WORKS ────────────────────────────────────── */}
      <section className={styles.howSection}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionLabel}>How it works</div>
          <h2 className={styles.sectionTitle}>3 Steps to Find Your Next Trade</h2>
        </div>
        <div className={styles.stepsRow}>
          {[
            { num: "1", title: "Choose a Scanner", desc: "Pick from Chart Patterns, MA Scanner, Candlesticks, Divergence, Breakout, Volume and more." },
            { num: "2", title: "Set Parameters",    desc: "No coding needed. Select your periods, direction, and timeframe using simple dropdowns." },
            { num: "3", title: "See Results as Charts", desc: "Every matching stock shows a mini candlestick chart with key indicator lines — just like KeyStocks." },
          ].map((s, i) => (
            <div key={i} className={styles.step}>
              <div className={styles.stepNum}>{s.num}</div>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepDesc}>{s.desc}</p>
              {i < 2 && <div className={styles.stepArrow}>→</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── PRICING ─────────────────────────────────────────── */}
      <section className={styles.pricingSection} id="pricing">
        <div className={styles.sectionHead}>
          <div className={styles.sectionLabel}>Pricing</div>
          <h2 className={styles.sectionTitle}>Affordable Plans for Every Trader</h2>
          <p className={styles.sectionSub}>
            Start with a free trial. No credit card needed.
          </p>
        </div>
        <div className={styles.pricingGrid}>
          {PRICING.map((plan) => (
            <div key={plan.name}
              className={`${styles.pricingCard} ${plan.highlight ? styles.pricingCardHighlight : ""}`}
              style={plan.highlight ? { borderColor: plan.color } : {}}>
              {plan.highlight && (
                <div className={styles.popularBadge} style={{ background: plan.color }}>
                  Most Popular
                </div>
              )}
              <h3 className={styles.planName}>{plan.name}</h3>
              <div className={styles.planPrice}>
                <span className={styles.planPriceNum} style={{ color: plan.color }}>{plan.price}</span>
                <span className={styles.planPricePeriod}> / {plan.period}</span>
              </div>
              <ul className={styles.planFeatures}>
                {plan.features.map((f) => (
                  <li key={f} className={styles.planFeature}>
                    <span style={{ color: plan.color }}>✓</span> {f}
                  </li>
                ))}
              </ul>
              <a
                href="/dashboard"
                className={styles.planCta}
                style={plan.highlight ? { background: plan.color } : { borderColor: plan.color, color: plan.color }}
                id={`plan-cta-${plan.name.toLowerCase().replace(/\s/g, "-")}`}
              >
                {plan.cta}
              </a>
            </div>
          ))}
        </div>
        <p className={styles.pricingNote}>
          * Pricing in INR. GST extra. Software works on all browsers (Windows, Mac, Linux).
        </p>
      </section>

      {/* ── FOOTER ──────────────────────────────────────────── */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <span className={styles.logoIcon}>📈</span>
            <span className={styles.footerName}>PeeStocks</span>
            <p className={styles.footerTagline}>
              Best Technical Analysis Software for Indian Stock Market
            </p>
          </div>
          <div className={styles.footerLinks}>
            <div className={styles.footerCol}>
              <div className={styles.footerColTitle}>Scanners</div>
              {["Chart Patterns", "MA Scanner", "Candlesticks", "Indicators", "Other Scans", "Custom Query"].map(l => (
                <a key={l} href="/dashboard" className={styles.footerLink}>{l}</a>
              ))}
            </div>
            <div className={styles.footerCol}>
              <div className={styles.footerColTitle}>Tools</div>
              {["Bar Replay", "Trendlines", "Auto S/R", "Charts"].map(l => (
                <a key={l} href="/dashboard" className={styles.footerLink}>{l}</a>
              ))}
            </div>
            <div className={styles.footerCol}>
              <div className={styles.footerColTitle}>Contact</div>
              <span className={styles.footerLink}>9 AM – 9 PM only</span>
              <a href="mailto:admin@peestocks.in" className={styles.footerLink}>admin@peestocks.in</a>
              <span className={styles.footerLink}>NSE Equity · EOD + Intraday</span>
            </div>
          </div>
        </div>
        <div className={styles.footerBottom}>
          © {new Date().getFullYear()} PeeStocks. All rights reserved. &nbsp;|&nbsp;
          Windows · Mac · Linux · Browser
        </div>
      </footer>
    </div>
  );
}
