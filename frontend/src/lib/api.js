/**
 * PEESTOCK — API Client
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

/**
 * Turn a FastAPI error `detail` into a readable message.
 * It's a plain string for HTTPExceptions (e.g. "Email already registered"),
 * but an ARRAY of {loc, msg} objects for request-validation errors (e.g. a
 * password shorter than 8 chars). Passing the array straight to new Error()
 * rendered it as "[object Object]", which hid the real reason from the user.
 */
function _detailToMessage(detail, status) {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const msg = detail
      .map((e) => {
        const field = Array.isArray(e.loc) ? e.loc[e.loc.length - 1] : null;
        // Friendlier phrasing for the common cases; fall back to the raw msg.
        let m = e.msg || "Invalid value";
        if (e.type === "string_too_short" && e.ctx?.min_length) {
          m = `must be at least ${e.ctx.min_length} characters`;
        } else if (/valid email/i.test(m)) {
          m = "must be a valid email address";
        } else {
          // pydantic prefixes many messages with "Value "/"value " — drop it so
          // the field label reads naturally ("Email must be…", not "Email value…")
          m = m.replace(/^value\s+/i, "");
        }
        const label = field && field !== "body" ? String(field).replace(/_/g, " ") : null;
        return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)} ${m}` : m;
      })
      .filter(Boolean)
      .join(" · ");
    if (msg) return msg;
  }
  if (detail && typeof detail === "object" && detail.msg) return detail.msg;
  return `Request failed (${status})`;
}

class ApiClient {
  constructor() {
    this.baseUrl = API_BASE;
    this.token = typeof window !== "undefined" ? localStorage.getItem("peestock_token") : null;
  }

  setToken(token) {
    this.token = token;
    if (typeof window !== "undefined") {
      localStorage.setItem("peestock_token", token);
    }
  }

  clearToken() {
    this.token = null;
    if (typeof window !== "undefined") {
      localStorage.removeItem("peestock_token");
    }
  }

  async request(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    // A "Failed to fetch" TypeError means the request never reached the server
    // (e.g. dev backend mid-reload — which can take a few seconds when heavy
    // deps like torch re-import). The server never processed it, so it is always
    // safe to retry, even for POST/DELETE. Budget ~6s across attempts.
    const backoffs = [300, 600, 1000, 1500, 2500];
    let res;
    let lastErr;
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          cache: "no-store",
          ...options,
          headers,
        });
        break;
      } catch (e) {
        lastErr = e;
        if (e instanceof TypeError && attempt < backoffs.length) {
          await new Promise((r) => setTimeout(r, backoffs[attempt]));
          continue;
        }
        throw e;
      }
    }
    if (!res) throw lastErr;

    if (res.status === 401) {
      this.clearToken();
      if (typeof window !== "undefined") {
        window.location.href = "/auth/login";
      }
      throw new Error("Unauthorized");
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(_detailToMessage(body.detail, res.status));
      err.status = res.status;
      throw err;
    }

    if (res.status === 204) return null;
    return res.json();
  }

  // ── Auth ─────────────────────────────────────────────
  register(data) {
    return this.request("/auth/register", { method: "POST", body: JSON.stringify(data) });
  }
  login(data) {
    return this.request("/auth/login", { method: "POST", body: JSON.stringify(data) });
  }
  getMe() {
    return this.request("/auth/me");
  }
  forgotPassword(email) {
    return this.request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
  }
  resetPassword(token, newPassword) {
    return this.request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, new_password: newPassword }) });
  }
  changePassword(currentPassword, newPassword) {
    return this.request("/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
  }

  // ── Instruments ──────────────────────────────────────
  listInstruments(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/instruments/?${qs}`);
  }
  getWatchlist() {
    return this.request(`/instruments/watchlist`);
  }
  getFundamentals(symbol) {
    return this.request(`/instruments/${encodeURIComponent(symbol)}/fundamentals`);
  }
  getEod(symbol, start, end) {
    const params = {};
    if (start) params.start = start;
    if (end) params.end = end;
    const qs = new URLSearchParams(params).toString();
    return this.request(`/instruments/${symbol}/eod?${qs}`);
  }
  getForecast(symbol) {
    return this.request(`/forecasts/${symbol}`);
  }
  // ── Per-user preference store (chart layout, indicator settings, drawings) ──
  getPref(key) {
    return this.request(`/prefs/${encodeURIComponent(key)}`);
  }
  putPref(key, value) {
    return this.request(`/prefs/${encodeURIComponent(key)}`, {
      method: "PUT", body: JSON.stringify({ value }),
    });
  }
  getTradePlan(symbol, { capital = 100000, riskPct = 1, atrMult = 2 } = {}) {
    const qs = new URLSearchParams({ capital, risk_pct: riskPct, atr_mult: atrMult }).toString();
    return this.request(`/trade-plan/${symbol}?${qs}`);
  }
  getRecommendations({ capital = 100000, riskPct = 1, limit = 24, sector, index, setup } = {}) {
    const p = { capital, risk_pct: riskPct, limit };
    if (sector && sector !== "all") p.sector = sector;
    if (index && index !== "all") p.index = index;
    if (setup && setup !== "all") p.setup = setup;
    return this.request(`/trade-plan/top/recommendations?${new URLSearchParams(p).toString()}`);
  }
  getTopOpportunities({ capital = 100000, riskPct = 1, limit = 50, sector, index } = {}) {
    const p = { capital, risk_pct: riskPct, limit };
    if (sector && sector !== "all") p.sector = sector;
    if (index && index !== "all") p.index = index;
    return this.request(`/trade-plan/top/opportunities?${new URLSearchParams(p).toString()}`);
  }
  get360Scores({ allRoundOnly = true, limit = 50, sector, index } = {}) {
    const p = { all_round_only: allRoundOnly, limit };
    if (sector && sector !== "all") p.sector = sector;
    if (index && index !== "all") p.index = index;
    return this.request(`/trade-plan/top/360?${new URLSearchParams(p).toString()}`);
  }
  triggerSyncData() {
    return this.request(`/instruments/sync`, { method: "POST" });
  }
  getSyncStatus() {
    return this.request(`/instruments/sync/status`);
  }
  listSectors() {
    return this.request(`/instruments/sectors`);
  }
  listIndices() {
    return this.request(`/instruments/indices`);
  }
  getHolidays() {
    return this.request(`/instruments/holidays`);
  }
  syncHolidays() {
    return this.request(`/instruments/holidays/sync`, { method: "POST" });
  }

  // ── Personal Watchlist ────────────────────────────────
  getMyWatchlist() {
    return this.request(`/watchlist/`);
  }
  addToWatchlist(symbol) {
    return this.request(`/watchlist/${symbol}`, { method: "POST" });
  }
  removeFromWatchlist(symbol) {
    return this.request(`/watchlist/${symbol}`, { method: "DELETE" });
  }

  // ── Portfolio ─────────────────────────────────────────
  listPositions() {
    return this.request(`/portfolio/`);
  }
  addPosition(data) {
    return this.request(`/portfolio/`, { method: "POST", body: JSON.stringify(data) });
  }
  deletePosition(id) {
    return this.request(`/portfolio/${id}`, { method: "DELETE" });
  }

  // ── Alerts ────────────────────────────────────────────
  listAlertRules() {
    return this.request(`/alerts/rules`);
  }
  createAlertRule(data) {
    return this.request(`/alerts/rules`, { method: "POST", body: JSON.stringify(data) });
  }
  deleteAlertRule(id) {
    return this.request(`/alerts/rules/${id}`, { method: "DELETE" });
  }
  listNotifications(unreadOnly = false) {
    return this.request(`/alerts/notifications?unread_only=${unreadOnly}`);
  }
  markNotificationRead(id) {
    return this.request(`/alerts/notifications/${id}/read`, { method: "POST" });
  }
  markAllNotificationsRead() {
    return this.request(`/alerts/notifications/read-all`, { method: "POST" });
  }

  // ── Screener / Patterns ──────────────────────────────
  listPatterns(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/screener/patterns?${qs}`);
  }
  triggerScan() {
    return this.request("/screener/trigger-scan", { method: "POST" });
  }
  getPattern(id) {
    return this.request(`/screener/patterns/${id}`);
  }

  // ── Trendlines ───────────────────────────────────────
  listTrendlines(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/trendlines/?${qs}`);
  }
  getTrendlinesForSymbol(symbol) {
    return this.request(`/trendlines/${symbol}`);
  }

  // ── Custom Scanners ──────────────────────────────────
  listScanners(includePublic = true) {
    return this.request(`/scanners/?include_public=${includePublic}`);
  }
  createScanner(data) {
    return this.request("/scanners/", { method: "POST", body: JSON.stringify(data) });
  }
  previewScan(conditions, logic = "AND", sector, index) {
    const params = {};
    if (sector && sector !== "all") params.sector = sector;
    if (index && index !== "all") params.index = index;
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `/scanners/preview?${qs}` : "/scanners/preview";
    return this.request(url, {
      method: "POST",
      body: JSON.stringify({ name: "preview", conditions, logic, is_public: false }),
    });
  }
  getScanner(id) {
    return this.request(`/scanners/${id}`);
  }
  updateScanner(id, data) {
    return this.request(`/scanners/${id}`, { method: "PUT", body: JSON.stringify(data) });
  }
  deleteScanner(id) {
    return this.request(`/scanners/${id}`, { method: "DELETE" });
  }
  runScanner(id, sector, index) {
    const params = {};
    if (sector && sector !== "all") params.sector = sector;
    if (index && index !== "all") params.index = index;
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `/scanners/${id}/run?${qs}` : `/scanners/${id}/run`;
    return this.request(url, { method: "POST" });
  }

  // ── Scan History ──────────────────────────────────────
  getScanHistory({ limit = 50, scanType, includeMatches = false } = {}) {
    const params = { limit };
    if (scanType) params.scan_type = scanType;
    if (includeMatches) params.include_matches = true;
    const qs = new URLSearchParams(params).toString();
    return this.request(`/scans/history?${qs}`);
  }


  // ── Bar Replay ───────────────────────────────────────
  getReplay(symbol, startBar = 50, step = 1, indicators = "sma:20,rsi:14", window = 250, randomStart = false) {
    const params = { start_bar: startBar, step, indicators, window, random_start: randomStart };
    const qs = new URLSearchParams(params).toString();
    return this.request(`/replay/${symbol}?${qs}`);
  }

  // ── MA Scanner ────────────────────────────────────────
  runMaScanner(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/scans/ma?${qs}`, { method: "GET" });
  }

  // ── Intraday Traders Desk ─────────────────────────────
  getIntradayDesk() {
    return this.request("/scans/intraday-desk");
  }

  // ── Indicator Scanner ─────────────────────────────────
  runIndicatorScanner(params = {}) {
    return this.request("/scans/indicators", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ── Candlestick Scanner ───────────────────────────────
  runCandlestickScanner(params = {}) {
    return this.request("/scans/candlesticks", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ── Other Scans ───────────────────────────────────────
  runOtherScan(params = {}) {
    return this.request("/scans/other", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ── Subscription ─────────────────────────────────────
  getSubscription() {
    return this.request("/subscription/");
  }
  getSubscriptionStatus() {
    return this.request("/subscription/status");
  }

  // ── Payments (Razorpay & UPI) ──────────────────────
  getPlans() {
    return this.request("/payments/plans");
  }
  createCheckout(planId) {
    return this.request("/payments/checkout", {
      method: "POST",
      body: JSON.stringify({ plan_id: planId }),
    });
  }
  verifyPayment(data) {
    return this.request("/payments/verify", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  getUpiInfo(planId) {
    return this.request(`/payments/upi-info?plan_id=${planId}`);
  }
  verifyUpiPayment(data) {
    return this.request("/payments/upi-verify", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  getPendingPayments() {
    return this.request("/payments/pending");
  }
  approvePayment(subId) {
    return this.request(`/payments/approve/${subId}`, { method: "POST" });
  }
  rejectPayment(subId) {
    return this.request(`/payments/reject/${subId}`, { method: "POST" });
  }

  // ── Chatbot / Assistant ────────────────────────────────
  chatbotQuery(query) {
    return this.request("/chatbot/query", {
      method: "POST",
      body: JSON.stringify({ query }),
    });
  }

  // ── Market Regime ──────────────────────────────────────
  getMarketRegime() {
    return this.request("/trade-plan/market-regime");
  }

  // ── Market Analytics (stages / breadth / RS / peers) ──
  getStageAnalysis() {
    return this.request("/market-analytics/stages");
  }
  getMarketBreadth(days = 120) {
    return this.request(`/market-analytics/breadth?days=${days}`);
  }
  getRsLeaders(minRs = 80, limit = 100) {
    return this.request(`/market-analytics/rs-leaders?min_rs=${minRs}&limit=${limit}`);
  }
  getPeers(symbol) {
    return this.request(`/market-analytics/peers/${encodeURIComponent(symbol)}`);
  }

  // ── Relative Rotation Graph ────────────────────────────
  getRrg({ benchmark = "NIFTY_50", timeframe = "W", tail = 8, symbols, stocks_in } = {}) {
    const p = new URLSearchParams({ timeframe, tail });
    if (stocks_in) p.set("stocks_in", stocks_in);
    else p.set("benchmark", benchmark);
    if (symbols) p.set("symbols", symbols);
    return this.request(`/rrg?${p.toString()}`);
  }
  getRrgOptions() {
    return this.request("/rrg/options");
  }

  // ── Delivery Money Flow ────────────────────────────────
  getDelivery(symbol, days = 120) {
    return this.request(`/delivery/${encodeURIComponent(symbol)}?days=${days}`);
  }
  getDeliverySectors(recentDays = 5, baselineDays = 20) {
    return this.request(`/delivery/sectors?recent_days=${recentDays}&baseline_days=${baselineDays}`);
  }
  getDeliverySectorStocks(sector, recentDays = 5, baselineDays = 20) {
    return this.request(
      `/delivery/sectors/${encodeURIComponent(sector)}/stocks?recent_days=${recentDays}&baseline_days=${baselineDays}`
    );
  }
  getDeliverySpikes(limit = 20) {
    return this.request(`/delivery/spikes?limit=${limit}`);
  }

  // ── Strategy Backtester ────────────────────────────────
  runBacktest(payload) {
    return this.request("/backtest/run", { method: "POST", body: JSON.stringify(payload) });
  }

  // ── Telegram alert delivery ────────────────────────────
  getTelegramStatus() {
    return this.request("/alerts/telegram/status");
  }
  linkTelegram() {
    return this.request("/alerts/telegram/link", { method: "POST" });
  }
  unlinkTelegram() {
    return this.request("/alerts/telegram/unlink", { method: "POST" });
  }

  // ── Index ticker (public) ──────────────────────────────
  getTicker(symbols) {
    return this.request(`/ticker?symbols=${encodeURIComponent(symbols.join(","))}`);
  }

  // ── Paper Trading ──────────────────────────────────────
  listPaperTrades() {
    return this.request("/paper-trades/");
  }
  openPaperTrade(body) {
    return this.request("/paper-trades/", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  closePaperTrade(tradeId, price) {
    return this.request(`/paper-trades/${tradeId}/close?price=${price}`, {
      method: "POST",
    });
  }
  deletePaperTrade(tradeId) {
    return this.request(`/paper-trades/${tradeId}`, { method: "DELETE" });
  }
}

export const api = new ApiClient();
