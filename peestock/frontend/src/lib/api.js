/**
 * PEESTOCK — API Client
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

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

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      this.clearToken();
      if (typeof window !== "undefined") {
        window.location.href = "/auth/login";
      }
      throw new Error("Unauthorized");
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `API Error ${res.status}`);
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

  // ── Instruments ──────────────────────────────────────
  listInstruments(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/instruments/?${qs}`);
  }
  getWatchlist() {
    return this.request(`/instruments/watchlist`);
  }
  getEod(symbol, start, end) {
    const params = {};
    if (start) params.start = start;
    if (end) params.end = end;
    const qs = new URLSearchParams(params).toString();
    return this.request(`/instruments/${symbol}/eod?${qs}`);
  }
  triggerSyncData() {
    return this.request(`/instruments/sync`, { method: "POST" });
  }

  // ── Screener / Patterns ──────────────────────────────
  listPatterns(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/screener/patterns?${qs}`);
  }
  triggerScan() {
    return this.request("/screener/trigger-scan", { method: "POST" });
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
  getScanner(id) {
    return this.request(`/scanners/${id}`);
  }
  updateScanner(id, data) {
    return this.request(`/scanners/${id}`, { method: "PUT", body: JSON.stringify(data) });
  }
  deleteScanner(id) {
    return this.request(`/scanners/${id}`, { method: "DELETE" });
  }
  runScanner(id) {
    return this.request(`/scanners/${id}/run`, { method: "POST" });
  }

  // ── Bar Replay ───────────────────────────────────────
  getReplay(symbol, startBar = 50, step = 1, indicators = "sma:20,rsi:14") {
    const params = { start_bar: startBar, step, indicators };
    const qs = new URLSearchParams(params).toString();
    return this.request(`/replay/${symbol}?${qs}`);
  }

  // ── MA Scanner ────────────────────────────────────────
  runMaScanner(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/scans/ma?${qs}`, { method: "GET" })
      .catch(() => ({ count: 0, matches: [] }));
  }

  // ── Indicator Scanner ─────────────────────────────────
  runIndicatorScanner(params = {}) {
    return this.request("/scans/indicators", {
      method: "POST",
      body: JSON.stringify(params),
    }).catch(() => ({ count: 0, matches: [] }));
  }

  // ── Candlestick Scanner ───────────────────────────────
  runCandlestickScanner(params = {}) {
    return this.request("/scans/candlesticks", {
      method: "POST",
      body: JSON.stringify(params),
    }).catch(() => ({ count: 0, matches: [] }));
  }

  // ── Other Scans ───────────────────────────────────────
  runOtherScan(params = {}) {
    return this.request("/scans/other", {
      method: "POST",
      body: JSON.stringify(params),
    }).catch(() => ({ count: 0, matches: [] }));
  }

  // ── Subscription ─────────────────────────────────────
  getSubscription() {
    return this.request("/subscription/");
  }
  getSubscriptionStatus() {
    return this.request("/subscription/status");
  }

  // ── Payments (Razorpay) ─────────────────────────────
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
}

export const api = new ApiClient();
