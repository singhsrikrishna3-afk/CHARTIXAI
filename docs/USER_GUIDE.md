# Chartix — New User Guide & Tour

Welcome to **Chartix**, an AI-powered technical analysis platform for NSE stocks.
This guide walks you through every feature in the order a new user should learn them.

---

## 1. Getting Started

### Create an account
1. Open the landing page and click **Start Free →** (or **Login** if you already have an account).
2. Register with your email — every new account starts with a **14-day free trial**.
3. After login you land on the **Dashboard Overview**.

### Plans
| Plan | Price | Highlights |
|---|---|---|
| Free Trial | ₹0 (14 days) | Daily charts, pattern screener, 2 custom scanners |
| EOD Basic | ₹499/mo | 5 custom scanners, auto trendlines |
| EOD Pro | ₹999/mo | Weekly/Monthly charts, unlimited scanners, bar replay, visual exports |
| AI EOD Pro | ₹1,499/mo | Everything above + **AI Price Forecast (LSTM)** |

### Paying via UPI
1. Go to **Payments / Pricing**, pick a plan, and scan the UPI QR (or use the UPI ID shown).
2. After paying, enter the **12-digit UTR number** from your UPI app.
3. Your subscription activates once an admin verifies the transaction (usually within a few hours).

> **Note:** All price data is **end-of-day (EOD)** from the official NSE bhavcopy,
> updated after market close (by ~7 PM IST). There is no live tick data.

---

## 2. The Chart (Open Chart)

The heart of Chartix — a full trading terminal.

### Basics
- **Symbol**: pick from the right sidebar (index constituents) or search.
- **Timeframes**: `D` (Daily), `W` (Weekly), `M` (Monthly) buttons in the toolbar.
- **Chart styles**: candles, hollow candles, bars, Heikin Ashi, Renko, line break, line, area, baseline and more — via the style dropdown.
- **Price scale**: `Auto` / `Log` / `%` toggle in the toolbar.
- **📷 Snapshot**: downloads the current chart as a PNG.

### Indicators (44 available)
1. **Double-click the chart** → open the tool menu → **Indicators** tab, or use the settings window.
2. Toggle any of the 44 indicators: SMA/EMA, Bollinger, Keltner, Donchian, Ichimoku, Supertrend, PSAR, RSI, MACD, Stochastic, StochRSI, ADX, Aroon, Vortex, TRIX, CMF, OBV, and many more.
3. Sub-pane indicators (RSI, MACD, …) get their own panel below price; removing one re-flows the layout automatically.

### The legend chips (top-left of the chart)
Every active indicator shows a chip:
- **⚙** — edit its parameters (period, multiplier…), color, and line width; or **Replace** it with another indicator.
- **✕** — remove it (the chart re-flows).
- **⌃ / ⌄ N** — collapse/expand the whole chip stack.
- **+ MA** — add a custom moving average (SMA/EMA/WMA/DEMA/TEMA/HMA/VWAP/BB) with its own color and period.
- You can also click the **SMA(20)/EMA(9)** readouts in the header bar to edit them directly.

> Everything you customize (indicators, parameters, colors, MAs, price-scale mode)
> is **saved automatically** and restored the next time you open the chart.

### Drawing tools
Double-click the chart → **Tools** tab: trendline, ray, horizontal/vertical line,
rectangle, channel, Fibonacci, pitchfork, arrow, text, circle. Double-click snaps
to the nearest candle OHLC.

### Analysis Search (Custom Query Builder)
Toolbar → **Analysis Search**: 22 one-click scans grouped by category
(Golden Cross, SuperTrend Buy/Sell, RSI oversold/overbought, BB Squeeze, ADX trend,
NR7, Inside Bar, Gap Up, breakouts, and more). Results appear in a table; click a
symbol to load its chart.

---

## 3. Scanners

All scanners run across ~2,000 NSE stocks and support **sector and index filters**.

| Page | What it finds |
|---|---|
| **Pattern Screener** | 19 chart patterns (H&S, double/triple tops & bottoms, triangles, wedges, flags, Wolfe waves…) detected automatically every day |
| **MA Scanner** | Crossovers, slope, convergence, price-vs-MA, pullback-to-MA setups |
| **Indicator Scanner** | SuperTrend, Ichimoku, RSI/MACD, SAR, BB squeeze, ZigZag, Fib bands, MA oscillator/band, trend candles |
| **Candlestick Scanner** | 24+ candle patterns (hammer, engulfing, morning star, doji…) plus a custom pattern builder |
| **Other Scans** | Breakouts, RSI/MACD divergence, **VCP (Minervini)**, 52-week high/low, volume analysis, gainers/losers, HH/HL trend, pivots, gaps, Fibonacci retrace, range breakout, Elliott Wave 4, Gann swing |
| **Custom Scanner** | No-code builder: combine any indicator conditions with AND/OR logic, save and re-run them |

### ✨ Recommended button
Every scan configuration panel has a **✨ Recommended** button that fills in
battle-tested starting parameters (hover it to preview the values). Start there,
then tighten or loosen to taste.

> **Tip — VCP:** it's a rare, high-quality pattern. A handful of matches (or zero
> on weak market days) is normal. Loosen *Vol Dry-Up %* to ~110 or widen
> *Near Pivot %* if you want more candidates to review.

---

## 4. AI Features

### AI Price Forecast (LSTM) — AI EOD Pro plan
- On the chart, enable the **AI Forecast (LSTM)** indicator to overlay a 5-day
  predicted price path with calibrated confidence bands.
- The model is trained on 1.4M+ NSE data points and retrained regularly.
- Forecasts are directional aids, **not** investment advice.

### Scan Assistant
Type scans in plain English — e.g. *"golden crossover in nifty 50 daily"*,
*"RSI oversold in Nifty 200"*, or *"forecast RELIANCE"* — and it runs the right
scan and shows results.

---

## 5. Bar Replay (EOD Pro+)

Step through history one bar at a time to practice entries and exits:
- Pick a symbol, choose a chart type (candles, bars, Heikin Ashi, line, area).
- Use ⏮ ◀ ▶ ⏭ and the speed slider; scrub with the progress bar.
- The **Repaint Check** panel tells you if an indicator's historical values
  change as new bars arrive (repainting = untrustworthy signals).

---

## 6. Watchlist, Portfolio & Alerts

- **My Watchlist** — star symbols to track them with daily change at a glance.
- **My Portfolio** — record your holdings (symbol, qty, buy price) to see live P&L against EOD closes.
- **Alerts** — create price-level or pattern alerts; triggered alerts appear in the bell menu.

---

## 7. Suggested First Session (10-minute tour)

1. **Dashboard Overview** — see active patterns detected today.
2. **Open Chart** → load `RELIANCE` → toggle RSI + MACD → edit SMA 20 via its legend chip.
3. **Analysis Search** → run *SuperTrend Buy Signal* → click a result to chart it.
4. **Other Scans → VCP** → press **✨ Recommended** → Run.
5. **Pattern Screener** → filter by your favorite sector.
6. **Custom Scanner** → build "RSI < 35 AND price > SMA 200" → save it.
7. **Bar Replay** → replay `TCS` and practice spotting entries.
8. Star a few symbols into your **Watchlist**, set one **Alert**.

---

## 8. FAQ & Tips

- **Why did my scan find nothing?** Some setups (VCP, divergences) are genuinely rare.
  Try the ✨ Recommended params first, then loosen one constraint at a time.
- **When does data update?** After market close, by ~7 PM IST (official NSE bhavcopy).
- **Are Weekly/Monthly locked?** They need EOD Pro or above.
- **Is Chartix SEBI registered?** No — it's an educational/technical-analysis tool.
  All trading decisions are yours.
- **My chart settings disappeared?** They're stored in your browser (localStorage);
  clearing site data resets them.
