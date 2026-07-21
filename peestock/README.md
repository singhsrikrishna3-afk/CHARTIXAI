# Peestock Predictive Technical Analysis Platform

Peestock is a comprehensive web-based technical analysis and predictive platform, designed as a modern web replication of legacy desktop stock screening software like KeyStocks.

## Architecture & Features

### 📊 Market Data
*   **Exchanges:** NSE, BSE, MCX
*   **Data Types:** 
    *   Real-time Tick Data
    *   End of Day Historical Data
*   **Engine:** High speed Engine capable of tracking 500+ stocks concurrently.

### 🔎 Scanner Engine
*   **Standard Indicators:**
    *   Moving Averages (e.g., 44 EMA)
    *   RSI & MACD Filters
    *   SuperTrend & SAR
    *   Volume Spikes
*   **Pattern Recognition:**
    *   Head & Shoulders
    *   Double Top/Bottom
    *   Triangles & Wedges
*   **Gap Analysis:**
    *   Common Gaps
    *   Breakaway Gaps
    *   Runaway Gaps
    *   Exhaustion Gaps
*   **Advanced Logic:**
    *   Bollinger Band Squeeze
    *   Ichimoku Cloud Crosses
    *   ADX Trend Strength
    *   Candlestick Patterns (NR7, Inside Bar)

### 📈 User Interface & Charting
*   **Layout:** Multi-Pane Layouts
*   **Indicators:** 100+ Built-in Indicators
*   **Drawing:** Drawing Tools (Fibonacci, Channels, etc.)
*   **Tabs:** Custom Tab Systems (KeyTrend)

### 🔔 Alerts & Automation
*   **Alerts:** Real-time Visual/Audio Alerts
*   **Watchlists:** Advanced Watchlist Management
*   **Trading:** ATS (Auto Trading System) Hooks

### 💻 Tech Stack (Web Replication)
*   **Frontend:** Next.js & Tailwind CSS
*   **Backend:** FastAPI (Python)
*   **Charts:** TradingView Lightweight Charts
*   **Task Queue:** Celery & Redis

### 🚀 Key Differentiators
*   **LSTM AI Forecasting:** Predictive chart pattern recognition and multivariate modeling.
*   **On-Device Processing:** Optimized for local processing performance.
*   **Natural Language Interface:** AI-driven interactions for ease of use.
