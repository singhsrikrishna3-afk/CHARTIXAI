"use client";

import React, { useState, useEffect } from "react";
import styles from "./page.module.css";
import {
  Target, Radar, History, Bot, ScanSearch, SlidersHorizontal, Compass, Truck,
  Shield, CalendarX, Send, ClipboardList, PenLine, Layers, LineChart, Smartphone,
  Microscope, FlaskConical, Lock, Database, Zap, MessageSquare, Check, TrendingUp,
} from "lucide-react";

/* Every number on this page is measured from our own data and restated when it
   changes: trade count + win rate come from data/reco_backtest.json, the stock
   count from the instruments table. No invented testimonials, no round-number
   inflation — that's the point of the product, so it's the rule for the page. */
const BACKTEST = { trades: "11,859", win: "65.5%", window: "Mar 2023 – May 2026" };
const UNIVERSE = "2,765";

const PILLARS = [
  {
    icon: Target, tone: styles.uspCardPurple,
    badge: "The core", title: "Recommendations with receipts",
    desc: "Complete swing plans — entry, stop, two targets, position size, holding window. A setup only appears if it beat a coin-flip across our full backtest, and expectancy must be positive after costs of being wrong.",
    stats: [["Backtest", `${BACKTEST.trades} trades`], ["Overall win rate", BACKTEST.win], ["Window", BACKTEST.window]],
    cta: "See today's picks",
  },
  {
    icon: Radar, tone: styles.uspCardIndigo,
    badge: "Scanner suite", title: "21 scans, one review flow",
    desc: "Patterns, divergences, breakouts, VCP, candlesticks, and a no-code builder for your own rules. Run any scan, then flip through every match full-screen with your indicators intact.",
    stats: [["Built-in scans", "21"], ["Custom rules", "No-code"], ["Universe", `${UNIVERSE} stocks`]],
    cta: "Browse the scanners",
  },
  {
    icon: History, tone: styles.uspCardEmerald,
    badge: "Practice", title: "A gym before the arena",
    desc: "Bar replay drops you at a random point in 20 years of NSE history — no hindsight possible. Paper trading simulates the full scale-out playbook. Build a verified track record before risking a rupee.",
    stats: [["Replay data", "20 years"], ["Hindsight", "None"], ["Risk", "Zero"]],
    cta: "Try the simulator",
  },
  {
    icon: Bot, tone: styles.uspCardCyan,
    badge: "AI, kept honest", title: "A forecast that admits uncertainty",
    desc: "An LSTM trained on 1.4M+ NSE bars draws the next five days as a range, not a promise — calibrated confidence bands on the chart, refreshed nightly. A directional aid, never a guarantee.",
    stats: [["Training data", "1.4M+ bars"], ["Horizon", "5 days"], ["Updated", "Nightly"]],
    cta: "View a forecast",
  },
];

const RECEIPTS = [
  { icon: FlaskConical, title: "Backtested, not asserted", desc: `${BACKTEST.trades} simulated trades, ${BACKTEST.window}. Win rates are measured, republished when they change, and shown on every card.` },
  { icon: Shield, title: "Regime-aware by default", desc: "A live market-health gauge conditions every probability on current tape — breakouts stop being recommended when the data says they stop working." },
  { icon: CalendarX, title: "Earnings shield", desc: "Entering two days before results is a bet on the report, not the chart. Those entries are blocked automatically." },
  { icon: Database, title: "Official exchange data", desc: `NSE bhavcopy ingested nightly across ${UNIVERSE} stocks — the same closing data the exchange publishes, including delivery volumes.` },
];

const FEATURES = [
  { icon: Compass, title: "Sector rotation (RRG)", desc: "Watch money rotate across sectors on a live relative-rotation graph." },
  { icon: Truck, title: "Delivery money flow", desc: "Delivery-backed volume as a proxy for quiet institutional buying." },
  { icon: Microscope, title: "Market analytics", desc: "Weinstein stages, breadth, and relative-strength leaders across the universe." },
  { icon: FlaskConical, title: "Strategy backtester", desc: "Test your own rules on any stock, index, or the whole market." },
  { icon: Send, title: "Telegram alerts", desc: "Targets hit, stops hit, earnings approaching — sent to your phone." },
  { icon: ClipboardList, title: "Paper trading", desc: "The full scale-out playbook, simulated against real closing data." },
  { icon: ScanSearch, title: "Pattern screener", desc: "19 chart patterns scanned nightly, each with its measured win rate." },
  { icon: SlidersHorizontal, title: "Custom scanner", desc: "Multi-condition rules in a visual builder. No code." },
  { icon: PenLine, title: "Auto trendlines", desc: "Pivot-fitted trendlines and support/resistance, drawn in milliseconds." },
  { icon: Layers, title: "360° scores", desc: "Technicals, money flow, and fundamentals graded independently." },
  { icon: LineChart, title: "Pro charts", desc: "30+ indicators, saved layouts, persistent drawings, replay." },
  { icon: Smartphone, title: "Works everywhere", desc: "Desktop, tablet, phone — one account, one workflow." },
];

const SCAN_BADGES = [
  "Trendline Breakout", "Head & Shoulders", "Double Bottom", "Triple Top",
  "Ascending Triangle", "Symmetric Triangle", "Falling Wedge", "Bull Flag",
  "Wolfe Waves", "Fibonacci Retracement", "MA Crossover", "RSI Divergence",
  "MACD Crossover", "BB Squeeze", "Volume Spike", "52W High Breakout",
  "Gap Analysis", "Inside Bar", "Hammer", "Morning Star", "Custom Query Builder",
];

const PRICING = [
  {
    id: "eod_basic", name: "EOD Basic", price: "₹299", period: "per month · or ₹99/week",
    color: "var(--accent-primary)", highlight: false, cta: "Get started",
    features: ["All 21 scanners, liquidity-filtered", "Patterns with measured win rates", "Bar replay practice simulator", "Unlimited paper trading", "View-all-on-charts review"],
  },
  {
    id: "eod_pro", name: "EOD Pro", price: "₹599", period: "per month · or ₹199/week",
    color: "var(--info)", highlight: true, cta: "Go Pro",
    features: ["Everything in Basic", "Swing recommendations with backtested win rates", "Market-regime defense + earnings shield", "Telegram alerts on your trades", "Weekly and monthly charts + custom scanner"],
  },
  {
    id: "ai_eod_pro", name: "AI EOD Pro", price: "₹999", period: "per month · or ₹299/week",
    color: "var(--accent)", highlight: false, cta: "Go AI Pro",
    features: ["Everything in Pro", "AI price forecast (LSTM)", "5-day predicted price bands", "360° all-round scores", "Priority support"],
  },
];

const FALLBACK_TICKER_DATA = [
  { sym: "RELIANCE",  price: "1,293.90", chg: "-0.55%" },
  { sym: "TCS",       price: "2,031.50", chg: "-3.17%" },
  { sym: "HDFCBANK",  price: "797.95",   chg: "-0.12%" },
  { sym: "INFY",      price: "1,000.40", chg: "-3.50%" },
  { sym: "SBIN",      price: "1,026.90", chg: "-0.89%" },
  { sym: "ICICIBANK", price: "1,375.20", chg: "-0.89%" },
  { sym: "BAJFINANCE",price: "1,004.75", chg: "+2.31%" },
  { sym: "MARUTI",    price: "14,115.00",chg: "+5.24%" },
  { sym: "TITAN",     price: "4,404.00", chg: "+2.96%" },
  { sym: "AXISBANK",  price: "1,345.70", chg: "-0.82%" },
];

export default function HomePage() {
  const [scrolled, setScrolled]     = useState(false);
  const [mounted, setMounted]       = useState(false);
  const [tickerData, setTickerData] = useState(FALLBACK_TICKER_DATA);
  const [tickerDate, setTickerDate] = useState("");

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    const apiBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api").replace(/\/api$/, "");
    fetch(`${apiBase}/api/ticker`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setTickerData(data);
          if (data[0].date) setTickerDate(data[0].date);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", fn);
    return () => window.removeEventListener("scroll", fn);
  }, []);

  return (
    <div className={styles.homePage}>

      <div className={styles.bgOrbs} aria-hidden>
        <div className={`${styles.orb} ${styles.orb1}`} />
        <div className={`${styles.orb} ${styles.orb2}`} />
        <div className={`${styles.orb} ${styles.orb3}`} />
      </div>
      <div className={styles.bgGrid} aria-hidden />

      <div className={styles.content}>

        {/* ── NAV ───────────────────────────────────────────────── */}
        <nav className={`${styles.nav} ${scrolled ? styles.navScrolled : ""}`}>
          <div className={styles.navInner}>
            <a href="/" className={styles.navLogo}>
              <img src="/logo.svg" alt="Chartix" style={{ width: 28, height: 28, borderRadius: 7 }} />
              <span className={styles.logoGradient}>Chartix</span>
            </a>
            <div className={styles.navLinks}>
              <a href="#method"   className={styles.navLink}>Method</a>
              <a href="#features" className={styles.navLink}>Features</a>
              <a href="#pricing"  className={styles.navLink}>Pricing</a>
              <a href="#faq"      className={styles.navLink}>FAQ</a>
              <a href="/auth/login"    className={styles.navLogin}>Sign in</a>
              <a href="/auth/register" className={styles.navCta} id="nav-cta">Start free</a>
            </div>
          </div>
        </nav>

        {/* ── TICKER ────────────────────────────────────────────── */}
        <div className={styles.tickerBar}>
          <span className={styles.tickerLabel}>NSE EOD {tickerDate ? `· ${tickerDate}` : ""}</span>
          <div className={styles.tickerScroll}>
            {[...tickerData, ...tickerData].map((t, i) => (
              <span key={i} className={styles.tickerItem}>
                <span className={styles.tickerSym}>{t.sym}</span>
                <span className={styles.tickerPrice}>{t.price}</span>
                <span className={`${styles.tickerChg} ${t.chg?.startsWith("+") ? styles.tickerUp : styles.tickerDown}`}>{t.chg}</span>
              </span>
            ))}
          </div>
        </div>

        {/* ── HERO ──────────────────────────────────────────────── */}
        <section className={styles.hero}>
          <div className={styles.heroContent}>
            <div className={styles.heroPill}>
              <span className={styles.pillDot} />
              NSE end-of-day · {UNIVERSE} stocks · built in India
            </div>

            <h1 className={styles.heroTitle}>
              Trade ideas that<br />
              show their <span className={styles.heroGrad}>track record</span><br />
              before you take them
            </h1>

            <p className={styles.heroDesc}>
              Every recommendation carries its entry, stop, targets — and the win rate it
              earned across <b>{BACKTEST.trades} backtested trades</b>. If a setup can&apos;t
              beat a coin-flip in the data, you never see it. Paper-trade everything free
              before paying a rupee.
            </p>

            <div className={styles.heroCtas}>
              <a href="/auth/register" className={styles.ctaPrimary} id="hero-cta">Start free — 7 days</a>
              <a href="#method" className={styles.ctaSecondary}>See the method</a>
            </div>

            <div className={styles.heroStats}>
              {[
                { num: BACKTEST.trades, label: "Trades backtested" },
                { num: BACKTEST.win,    label: "Measured win rate" },
                { num: UNIVERSE,        label: "Stocks scanned nightly" },
                { num: "20 yrs",        label: "Replay practice data" },
              ].map(s => (
                <div key={s.label} className={styles.heroStat}>
                  <span className={styles.heroStatNum}>{s.num}</span>
                  <span className={styles.heroStatLabel}>{s.label}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 10 }}>
              Historical results from our published backtest ({BACKTEST.window}). Markets change; past performance never guarantees future results.
            </p>
          </div>

          {/* Mock chart */}
          <div className={styles.heroMockup}>
            <div className={styles.mockOuter}>
              <div className={styles.mockGlow} aria-hidden />
              <div className={styles.mockWindow}>
                <div className={styles.mockTitleBar}>
                  <div className={styles.mockDots}>
                    <span className={styles.mockDot} />
                    <span className={styles.mockDot} />
                    <span className={styles.mockDot} />
                  </div>
                  <span className={styles.mockTitle}>Chartix — NIFTY — Daily</span>
                </div>
                <div className={styles.mockToolbar}>
                  {["1D","W","M"].map(tf => (
                    <button key={tf} className={`${styles.mockTf} ${tf==="1D" ? styles.mockTfActive : ""}`}>{tf}</button>
                  ))}
                  <span style={{ flex: 1 }} />
                  {["EMA 44","RSI","MACD"].map(ind => (
                    <button key={ind} className={styles.mockTf}>{ind}</button>
                  ))}
                </div>
                <div className={styles.mockChart}>
                  {mounted && (
                    <>
                      <svg viewBox="0 0 400 185" style={{ width: "100%", height: "100%" }}>
                        {[30,60,90,120,150].map(y => (
                          <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" strokeDasharray="3,3"/>
                        ))}
                        {[...Array(32)].map((_, i) => {
                          const x   = 10 + i * 11.5;
                          const rng = Math.abs(Math.sin(i * 12.9898 + 78.233)) % 1;
                          const r2  = Math.abs(Math.cos(i * 4.1415 + 9.21)) % 1;
                          const r3  = Math.abs(Math.sin(i * 2.7182 + 3.14)) % 1;
                          const up  = rng > 0.44;
                          const bH  = 5 + r2 * 20;
                          const bY  = 22 + r3 * 92;
                          return (
                            <g key={i}>
                              <line x1={x+2.5} y1={bY-4} x2={x+2.5} y2={bY+bH+4}
                                stroke={up?"var(--up)":"var(--down)"} strokeWidth="0.8"/>
                              <rect x={x} y={bY} width={5} height={bH}
                                fill={up?"transparent":"var(--down)"}
                                stroke={up?"var(--up)":"var(--down)"} strokeWidth="1.2"
                                rx="0.5"/>
                            </g>
                          );
                        })}
                        <polyline
                          points={[...Array(32)].map((_,i) => `${10+i*11.5+2.5},${68+Math.sin(i*0.38)*24}`).join(" ")}
                          fill="none" stroke="var(--accent-primary)" strokeWidth="1.8" strokeLinecap="round"/>
                        <polyline
                          points="345,68 358,62 372,55 385,50 398,44"
                          fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4,3" strokeLinecap="round"/>
                        <text x="8"   y="181" fontSize="8" fill="var(--text-muted)" fontFamily="monospace">EMA 44</text>
                        <text x="340" y="181" fontSize="8" fill="var(--accent)" fontFamily="monospace">AI →</text>
                      </svg>
                      <div className={styles.mockRsi}>
                        <div className={styles.mockRsiLabel}>RSI (14)</div>
                        <svg viewBox="0 0 400 36" style={{ width:"100%", height:32 }}>
                          <line x1="0" y1="18" x2="400" y2="18" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" strokeDasharray="2,2"/>
                          <polyline
                            points={[...Array(32)].map((_,i) => `${10+i*11.5+2.5},${10+Math.sin(i*0.48+1)*13}`).join(" ")}
                            fill="none" stroke="var(--info)" strokeWidth="1.4" strokeLinecap="round"/>
                        </svg>
                      </div>
                    </>
                  )}
                </div>
                <div className={styles.mockStatus}>
                  <span className={styles.mockStatusDot}/>
                  Scanning · 4 setups found · Double Bottom near EMA 44
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── PILLARS ───────────────────────────────────────────── */}
        <section className={styles.uspSection} id="method">
          <div className={styles.uspInner}>
            <div className={styles.uspHead}>
              <div className={styles.sectionPill}>What Chartix is</div>
              <h2 className={styles.uspTitle}>Four things, done properly</h2>
              <p className={styles.uspSub}>Not forty features fighting for attention — a recommendation engine you can audit, a scanner suite, a place to practice, and an AI that knows its limits.</p>
            </div>
            <div className={styles.uspGrid}>
              {PILLARS.map(p => {
                const Icon = p.icon;
                return (
                  <div key={p.title} className={`${styles.uspCard} ${p.tone}`}>
                    <div className={styles.uspCardBadge}>{p.badge}</div>
                    <div className={styles.uspCardIcon}><Icon size={26} strokeWidth={1.6} /></div>
                    <h3 className={styles.uspCardTitle}>{p.title}</h3>
                    <p className={styles.uspCardDesc}>{p.desc}</p>
                    <div className={styles.uspCardStats}>
                      {p.stats.map(([k, v]) => (
                        <div key={k} className={styles.uspStat}><span>{k}</span><strong>{v}</strong></div>
                      ))}
                    </div>
                    <a href="/auth/register" className={styles.uspCardCta}>{p.cta} →</a>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── RECEIPTS (replaces invented testimonials) ─────────── */}
        <section className={styles.testimonialsSection}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionPill}>Why trust it</div>
            <h2 className={styles.sectionTitle}>No reviews we wrote ourselves. Receipts instead.</h2>
            <p className={styles.sectionSub}>Tip channels sell confidence. We publish the numbers behind every signal and let you verify them with paper trades before a rupee moves.</p>
          </div>
          <div className={styles.testimonialsGrid}>
            {RECEIPTS.map(r => {
              const Icon = r.icon;
              return (
                <div key={r.title} className={styles.testimonialCard}>
                  <div style={{ color: "var(--accent)", marginBottom: 10 }}><Icon size={22} strokeWidth={1.6} /></div>
                  <div className={styles.testimonialName} style={{ marginBottom: 6 }}>{r.title}</div>
                  <p className={styles.testimonialText} style={{ margin: 0 }}>{r.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── FEATURE GRID ──────────────────────────────────────── */}
        <section className={styles.featuresSection} id="features">
          <div className={styles.sectionHead}>
            <div className={styles.sectionPill}>The rest of the toolkit</div>
            <h2 className={styles.sectionTitle}>Everything else, in one line each</h2>
          </div>
          <div className={styles.featuresGrid}>
            {FEATURES.map(f => {
              const Icon = f.icon;
              return (
                <div key={f.title} className={styles.featureCard}>
                  <div className={styles.featureIconWrap}>
                    <Icon size={20} strokeWidth={1.6} />
                  </div>
                  <h3 className={styles.featureTitle}>{f.title}</h3>
                  <p className={styles.featureDesc}>{f.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── SCAN BADGES ───────────────────────────────────────── */}
        <section className={styles.scanSection} id="scans">
          <div className={styles.sectionHead}>
            <div className={styles.sectionPill}>Built-in scans</div>
            <h2 className={styles.sectionTitle}>21 scans and patterns</h2>
          </div>
          <div className={styles.badgesWrap}>
            {SCAN_BADGES.map(b => <span key={b} className={styles.scanBadge}>{b}</span>)}
          </div>
        </section>

        {/* ── HOW IT WORKS ──────────────────────────────────────── */}
        <section className={styles.howSection}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionPill}>Workflow</div>
            <h2 className={styles.sectionTitle}>Three steps, most evenings</h2>
          </div>
          <div className={styles.stepsRow}>
            {[
              { num: "1", title: "Open the picks", desc: "Fresh recommendations after the nightly data update — or run any scanner yourself." },
              { num: "2", title: "Check the receipt", desc: "Win rate, expectancy, and risk are on the card. The regime gauge says how aggressive to be." },
              { num: "3", title: "Execute your plan", desc: "Trade it live with your broker, or paper-trade it first. Alerts track your targets and stops." },
            ].map((s, i) => (
              <React.Fragment key={s.num}>
                <div className={styles.step}>
                  <div className={styles.stepNum}>{s.num}</div>
                  <h3 className={styles.stepTitle}>{s.title}</h3>
                  <p className={styles.stepDesc}>{s.desc}</p>
                </div>
                {i < 2 && <div className={styles.stepConnector}>→</div>}
              </React.Fragment>
            ))}
          </div>
        </section>

        {/* ── PRICING ───────────────────────────────────────────── */}
        <section className={styles.pricingSection} id="pricing">
          <div className={styles.sectionHead}>
            <div className={styles.sectionPill}>Pricing</div>
            <h2 className={styles.sectionTitle}>Less than one bad trade</h2>
            <p className={styles.sectionSub}>7 days free, no card needed. UPI only. Cancel anytime.</p>
          </div>
          <div className={styles.pricingGrid}>
            {PRICING.map(plan => (
              <div key={plan.id} className={`${styles.pricingCard} ${plan.highlight ? styles.pricingCardHighlight : ""}`}>
                {plan.highlight && <div className={styles.popularBadge}>Popular</div>}
                <h3 className={styles.planName}>{plan.name}</h3>
                <div className={styles.planPrice}>
                  <span className={styles.planPriceNum} style={{ color: plan.color }}>{plan.price}</span>
                  <span className={styles.planPricePeriod}> / {plan.period}</span>
                </div>
                <ul className={styles.planFeatures}>
                  {plan.features.map(f => (
                    <li key={f} className={styles.planFeature}>
                      <span className={styles.planCheck} style={{ color: plan.color }}><Check size={14} strokeWidth={2.5} /></span> {f}
                    </li>
                  ))}
                </ul>
                <a href="/auth/register" className={styles.planCta} id={`plan-${plan.id}`}>{plan.cta} →</a>
              </div>
            ))}
          </div>
          <p className={styles.pricingNote}>
            UPI payments (GPay, PhonePe, Paytm, BHIM), verified manually within a few hours. No payment gateway, no card data stored.
          </p>
        </section>

        {/* ── FAQ ───────────────────────────────────────────────── */}
        <section className={styles.faqSection} id="faq">
          <div className={styles.sectionHead}>
            <div className={styles.sectionPill}>FAQ</div>
            <h2 className={styles.sectionTitle}>Fair questions</h2>
          </div>
          <div className={styles.faqGrid}>
            {[
              { q: "Where does the data come from?", a: `Official NSE bhavcopy files, ingested every trading evening across ${UNIVERSE} stocks — the same closing data the exchange publishes, including delivery volumes.` },
              { q: "Are the win rates guaranteed?", a: `No, and distrust anyone who says otherwise. They are measured across ${BACKTEST.trades} simulated historical trades (${BACKTEST.window}) and republished when they change. History informs; it never promises.` },
              { q: "How do payments work?", a: "UPI only — scan the QR, pay, enter your UTR number. We verify manually within a few hours. No payment gateway, no card details stored." },
              { q: "Do I need to code?", a: "No. Every scanner, backtest, and custom rule is built visually with dropdowns and sliders." },
              { q: "Can I cancel anytime?", a: "Yes. Month-to-month or weekly, no lock-in. Cancel before your next billing date and you won't be charged again." },
              { q: "Is Chartix SEBI registered?", a: "No. Chartix is a technical-analysis and educational tool, not an investment adviser. Every trading decision is yours." },
            ].map((item, i) => (
              <div key={i} className={styles.faqItem}>
                <div className={styles.faqQ}>{item.q}</div>
                <div className={styles.faqA}>{item.a}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── CTA BANNER ────────────────────────────────────────── */}
        <section className={styles.ctaBanner}>
          <h2 className={styles.ctaBannerTitle}>See tonight&apos;s picks with their receipts</h2>
          <p className={styles.ctaBannerSub}>7 days free. Paper-trade everything before risking anything.</p>
          <div className={styles.heroCtas} style={{ justifyContent: "center" }}>
            <a href="/auth/register" className={styles.ctaPrimary}>Start free</a>
            <a href="#pricing"       className={styles.ctaSecondary}>See plans</a>
          </div>
        </section>

        {/* ── FOOTER ────────────────────────────────────────────── */}
        <footer className={styles.footer}>
          <div className={styles.footerInner}>
            <div className={styles.footerBrand}>
              <span className={styles.footerName}>Chartix</span>
              <p className={styles.footerTagline}>Backtested technical analysis for NSE swing traders. Every number on this page is measured from our own data and restated when it changes.</p>
            </div>
            <div className={styles.footerLinks}>
              <div className={styles.footerCol}>
                <div className={styles.footerColTitle}>Scanners</div>
                {["Chart Patterns","MA Scanner","Candlesticks","Custom Query"].map(l => (
                  <a key={l} href="/dashboard" className={styles.footerLink}>{l}</a>
                ))}
              </div>
              <div className={styles.footerCol}>
                <div className={styles.footerColTitle}>Tools</div>
                {["Bar Replay","Auto Trendlines","AI Forecast","Alerts"].map(l => (
                  <a key={l} href="/dashboard" className={styles.footerLink}>{l}</a>
                ))}
              </div>
              <div className={styles.footerCol}>
                <div className={styles.footerColTitle}>Contact</div>
                <span className={styles.footerLink}>admin@peestocks.in</span>
                <span className={styles.footerLink}>9 AM – 9 PM support</span>
              </div>
            </div>
          </div>
          <div className={styles.footerBottom}>
            © {new Date().getFullYear()} Chartix. All rights reserved. Not SEBI registered. For educational purposes only.
          </div>
        </footer>

      </div>
    </div>
  );
}
