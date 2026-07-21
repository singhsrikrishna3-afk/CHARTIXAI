"use client";

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./dashboard.module.css";
import { api } from "@/lib/api";
import TourOverlay from "@/components/TourOverlay";
import {
  LayoutDashboard, CandlestickChart, Target, MessagesSquare, Microscope, Compass,
  Truck, Filter, ScanSearch, TrendingUp, Activity, Radar, SlidersHorizontal,
  Wrench, MonitorDot, History, PenLine, Briefcase, Star, Bell, CreditCard,
  BookOpen, ChevronRight, ChevronsLeft, ChevronsRight, LogOut,
} from "lucide-react";

// One grouped, collapsible nav. Replaces the 20-item flat emoji list: two
// top-level entries, four labelled groups, two footer entries — ~8 things on
// screen instead of 20. Icons come from one set (lucide), no emoji.
const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/charts", label: "Charts", icon: CandlestickChart },
  { group: "Trade Ideas", icon: Target, items: [
    { href: "/dashboard/trade-plan", label: "Swing Trade Plan", icon: Target },
    { href: "/dashboard/assistant", label: "Scan Assistant", icon: MessagesSquare },
    { href: "/dashboard/market-analytics", label: "Market Analytics", icon: Microscope },
    { href: "/dashboard/rrg", label: "Sector Rotation", icon: Compass },
    { href: "/dashboard/delivery", label: "Delivery Flow", icon: Truck },
  ] },
  { group: "Screeners", icon: Filter, items: [
    { href: "/dashboard/patterns", label: "Pattern Screener", icon: ScanSearch },
    { href: "/dashboard/ma-scanner", label: "MA Scanner", icon: TrendingUp },
    { href: "/dashboard/indicators", label: "Indicator Scanner", icon: Activity },
    { href: "/dashboard/candlesticks", label: "Candlestick Scanner", icon: CandlestickChart },
    { href: "/dashboard/other-scans", label: "Other Scans", icon: Radar },
    { href: "/dashboard/scanners", label: "Custom Scanner", icon: SlidersHorizontal },
  ] },
  { group: "Study Tools", icon: Wrench, items: [
    { href: "/dashboard/intraday-desk", label: "Intraday Desk", icon: MonitorDot },
    { href: "/dashboard/replay", label: "Bar Replay", icon: History },
    { href: "/dashboard/trendlines", label: "Trendlines", icon: PenLine },
  ] },
  { group: "Portfolio", icon: Briefcase, items: [
    { href: "/dashboard/watchlist", label: "Watchlist", icon: Star },
    { href: "/dashboard/portfolio", label: "Holdings", icon: Briefcase },
    { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
  ] },
  { href: "/dashboard/payments", label: "Billing", icon: CreditCard },
  { href: "/dashboard/guide", label: "Guide", icon: BookOpen },
];

// Anchors the spotlight tour points at (TourOverlay looks these up by [data-tour])
const TOUR_KEYS = {
  "/dashboard/charts": "charts",
  "/dashboard/assistant": "assistant",
  "/dashboard/patterns": "patterns",
  "/dashboard/other-scans": "other-scans",
  "/dashboard/scanners": "scanners",
  "/dashboard/replay": "replay",
  "/dashboard/watchlist": "watchlist",
};

export default function DashboardLayout({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  // Charts page renders full-bleed: no global top bar, no ticker tape
  const isChartsPage = pathname?.startsWith("/dashboard/charts");
  const [collapsed, setCollapsed] = useState(false);

  // Mobile: sidebar becomes an off-canvas drawer behind a ☰ button. The inline
  // marginLeft below would otherwise override the CSS media query and leave a
  // 260px dead zone on phones.
  const [isMobile, setIsMobile] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  useEffect(() => { setMobileNavOpen(false); }, [pathname]); // navigating closes the drawer
  const [subscription, setSubscription] = useState(null);
  const [marketStatus, setMarketStatus] = useState("Closed");

  // Top-bar stock search
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(-1);

  // Index ticker tape (slim strip under the top bar)
  const TICKER_SYMBOLS = [
    ["NIFTY_50", "NIFTY"], ["NIFTY_BANK", "BANKNIFTY"], ["NIFTY_IT", "NIFTY IT"],
    ["NIFTY_MIDCAP_100", "MIDCAP 100"], ["NIFTY_SMALLCAP_100", "SMALLCAP 100"],
    ["NIFTY_AUTO", "AUTO"], ["NIFTY_PHARMA", "PHARMA"], ["NIFTY_FMCG", "FMCG"],
    ["NIFTY_METAL", "METAL"],
  ];
  const [indexTicker, setIndexTicker] = useState([]);

  // Notification bell — unread alert count, refreshed every 2 minutes
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const rows = await api.listNotifications(true);
        if (!cancelled) setUnreadAlerts(Array.isArray(rows) ? rows.length : 0);
      } catch (e) { /* signed out / offline — badge just hides */ }
    };
    poll();
    const t = setInterval(poll, 2 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pathname]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.getTicker(TICKER_SYMBOLS.map(([s]) => s));
        if (!cancelled && Array.isArray(data)) setIndexTicker(data);
      } catch (e) { /* ticker is decorative — fail silently */ }
    };
    load();
    const t = setInterval(load, 10 * 60 * 1000); // EOD data — refresh gently
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const q = searchQ.trim();
    if (q.length < 1) { setSearchResults([]); setSearchOpen(false); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const data = await api.listInstruments({ search: q, limit: 12 });
        if (!cancelled) {
          setSearchResults(Array.isArray(data) ? data.slice(0, 12) : []);
          setSearchOpen(true);
          setSearchActive(-1);
        }
      } catch (e) { if (!cancelled) setSearchResults([]); }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [searchQ]);

  const goToSymbol = (sym) => {
    if (!sym) return;
    setSearchQ(""); setSearchResults([]); setSearchOpen(false);
    router.push(`/dashboard/charts?symbol=${encodeURIComponent(sym.toUpperCase())}`);
  };

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSearchActive((i) => Math.min(i + 1, searchResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSearchActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      const pick = searchActive >= 0 ? searchResults[searchActive] : searchResults[0];
      goToSymbol(pick ? pick.symbol : searchQ);
    } else if (e.key === "Escape") { setSearchOpen(false); }
  };

  useEffect(() => {
    // Check subscription status
    api.getSubscriptionStatus().then(setSubscription).catch(console.error);

    // Simulate market status check or simple schedule
    const updateMarketStatus = () => {
      const now = new Date();
      const hours = now.getHours();
      const mins = now.getMinutes();
      const day = now.getDay(); // 0 is Sunday, 6 is Saturday
      
      // NSE Trading Hours: 9:15 AM to 3:30 PM (9.25 to 15.5 decimal hours)
      const decimalTime = hours + mins / 60;
      if (day >= 1 && day <= 5 && decimalTime >= 9.25 && decimalTime <= 15.5) {
        setMarketStatus("Live");
      } else {
        setMarketStatus("Closed");
      }
    };

    updateMarketStatus();
    const interval = setInterval(updateMarketStatus, 60000);
    return () => clearInterval(interval);
  }, [pathname]);

  // Which nav groups are expanded. Start with the group containing the current
  // route open (so the active page is always visible), the rest collapsed.
  const [openGroups, setOpenGroups] = useState(() => {
    const active = NAV.find((n) => n.items && n.items.some((i) => i.href === pathname));
    return active ? { [active.group]: true } : {};
  });
  useEffect(() => {
    const active = NAV.find((n) => n.items && n.items.some((i) => i.href === pathname));
    if (active) setOpenGroups((g) => ({ ...g, [active.group]: true }));
  }, [pathname]);
  const toggleGroup = (name) => setOpenGroups((g) => ({ ...g, [name]: !g[name] }));

  const planName = subscription?.tier?.replace("_", " ").toUpperCase() || "FREE";

  const handleLogout = () => {
    api.setToken(null);
    router.push("/");
  };

  return (
    <div className={styles.dashboardLayout} style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
      {/* Sidebar */}
      {/* Mobile drawer backdrop */}
      {isMobile && mobileNavOpen && (
        <div onClick={() => setMobileNavOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 240 }} />
      )}

      <aside
        className={`${styles.sidebar} ${collapsed && !isMobile ? styles.sidebarCollapsed : ""}`}
        style={{
          borderRight: "1px solid var(--border-subtle)", background: "var(--bg-secondary)",
          ...(isMobile ? {
            width: 260, zIndex: 250,
            transform: mobileNavOpen ? "translateX(0)" : "translateX(-105%)",
            transition: "transform 0.25s ease",
            boxShadow: mobileNavOpen ? "0 0 40px rgba(0,0,0,0.6)" : "none",
          } : {}),
        }}>
        <div className={styles.sidebarHeader} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <Link href="/dashboard" className={styles.sidebarLogo}>
            <img src="/logo.svg" alt="Chartix" style={{ width: 28, height: 28, borderRadius: 7, flexShrink: 0 }} />
            {!collapsed && (
              <span style={{
                fontWeight: 800,
                background: "linear-gradient(135deg, #22d3ee, #6366f1)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text"
              }}>
                Chartix
              </span>
            )}
          </Link>
          <button className={styles.sidebarToggle} onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>

        <nav className={styles.sidebarNav}>
          {NAV.map((node) => {
            // A single icon+label link, shared by top-level items and group children.
            const renderLink = (link, inGroup) => {
              const Icon = link.icon;
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`${styles.sidebarLink} ${isActive ? styles.sidebarLinkActive : ""} ${inGroup && !collapsed ? styles.sidebarLinkNested : ""}`}
                  title={link.label}
                  data-tour={TOUR_KEYS[link.href]}
                >
                  <span className={styles.sidebarIcon}><Icon size={18} strokeWidth={1.75} /></span>
                  {!collapsed && <span>{link.label}</span>}
                </Link>
              );
            };

            if (node.href) return renderLink(node, false);

            // Collapsed rail: no group headers — show every leaf as an icon.
            if (collapsed) return node.items.map((i) => renderLink(i, false));

            const GroupIcon = node.icon;
            const isOpen = !!openGroups[node.group];
            const hasActive = node.items.some((i) => i.href === pathname);
            return (
              <div key={node.group} className={styles.navGroup}>
                <button
                  className={`${styles.navGroupHeader} ${hasActive ? styles.navGroupHeaderActive : ""}`}
                  onClick={() => toggleGroup(node.group)}
                  aria-expanded={isOpen}
                >
                  <span className={styles.sidebarIcon}><GroupIcon size={18} strokeWidth={1.75} /></span>
                  <span className={styles.navGroupLabel}>{node.group}</span>
                  <ChevronRight size={15} className={`${styles.navChevron} ${isOpen ? styles.navChevronOpen : ""}`} />
                </button>
                {isOpen && <div className={styles.navGroupItems}>{node.items.map((i) => renderLink(i, true))}</div>}
              </div>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter} style={{ borderTop: "1px solid var(--border-subtle)" }}>
          <div className={styles.userInfo}>
            <div 
              className={styles.userAvatar} 
              style={{ 
                background: "linear-gradient(135deg, #6366f1, #d946ef)",
                borderRadius: "50%",
                fontWeight: "bold",
                color: "#ffffff"
              }}
            >
              AU
            </div>
            {!collapsed && (
              <div className={styles.userDetails}>
                <span className={styles.userName} style={{ color: "var(--text-primary)" }}>Admin User</span>
                <span className={styles.userEmail} style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>{planName} PLAN</span>
              </div>
            )}
          </div>
          {!collapsed && (
            <button 
              className={styles.logoutBtn}
              onClick={handleLogout}
              style={{
                marginTop: "8px",
                width: "100%",
                background: "rgba(239, 68, 68, 0.1)",
                borderColor: "rgba(239, 68, 68, 0.3)",
                color: "#ef4444"
              }}
            >
              Sign Out
            </button>
          )}
        </div>
      </aside>

      {/* Main Content */}
      {/* Charts page gets the full viewport — its toolbar has its own symbol
          search, so the global top bar + ticker tape would only squeeze the chart */}
      <div
        className={styles.mainContent}
        style={{
          marginLeft: isMobile ? 0 : (collapsed ? "72px" : "260px"),
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
          transition: "margin-left 0.3s ease",
          background: "var(--bg-primary)",
          // flex-item min-width:auto lets wide children (ticker tape) stretch
          // this column past the viewport, pushing the header off-screen
          minWidth: 0,
        }}
      >
        {/* Top Bar */}
        {!isChartsPage && (
        <header className={styles.topBar} style={{ borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-secondary)" }}>
          {isMobile && (
            <button onClick={() => setMobileNavOpen(true)} aria-label="Open menu"
              style={{ background: "transparent", border: "1px solid var(--border-default,#333)",
                color: "var(--text-primary,#e5e7eb)", borderRadius: 8, padding: "6px 10px",
                fontSize: "1.05rem", cursor: "pointer", marginRight: 10, flexShrink: 0 }}>
              ☰
            </button>
          )}
          <div className={styles.searchWrap} data-tour="search" style={{ position: "relative", minWidth: 0 }}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              type="text"
              placeholder="Search stocks by symbol or name…"
              className={styles.searchInput}
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={onSearchKey}
              onFocus={() => { if (searchResults.length) setSearchOpen(true); }}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              autoComplete="off"
            />
            {searchOpen && searchResults.length > 0 && (
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 200,
                background: "var(--bg-secondary, #1a1f2e)", border: "1px solid var(--border-default, #333)",
                borderRadius: 10, overflow: "hidden", maxHeight: 360, overflowY: "auto",
                boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
              }}>
                {searchResults.map((r, i) => (
                  <div key={r.symbol + i}
                    onMouseDown={(e) => { e.preventDefault(); goToSymbol(r.symbol); }}
                    onMouseEnter={() => setSearchActive(i)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                      padding: "9px 14px", cursor: "pointer",
                      background: i === searchActive ? "var(--list-item-hover, #2962ff)" : "transparent",
                      color: i === searchActive ? "#fff" : "var(--text-primary, #e5e7eb)",
                    }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 700 }}>{r.symbol}</span>
                      <span style={{ marginLeft: 8, fontSize: "0.8rem", opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                    </div>
                    <span style={{ fontSize: "0.72rem", opacity: 0.6, whiteSpace: "nowrap" }}>{r.sector || r.segment || ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={styles.topBarActions} style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <Link href="/dashboard/alerts" title="Alerts & notifications"
              style={{ position: "relative", textDecoration: "none", fontSize: "1.15rem", lineHeight: 1 }}>
              🔔
              {unreadAlerts > 0 && (
                <span style={{
                  position: "absolute", top: -6, right: -10, background: "#ef4444", color: "#fff",
                  borderRadius: 10, fontSize: "0.62rem", fontWeight: 800, padding: "1px 5px", minWidth: 16, textAlign: "center",
                }}>
                  {unreadAlerts > 99 ? "99+" : unreadAlerts}
                </span>
              )}
            </Link>
            <span className={`badge ${marketStatus === "Live" ? "badge-green" : "badge-red"}`}>
              {marketStatus === "Live" ? "● NSE LIVE" : "● NSE CLOSED"}
            </span>
            <Link href="/dashboard/pricing" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "0.8rem", textDecoration: "none" }}>
              💎 Upgrade Plan
            </Link>
          </div>
        </header>
        )}

        {/* Charts page has no top bar — give mobile users a floating ☰ so the
            sidebar stays reachable */}
        {isChartsPage && isMobile && !mobileNavOpen && (
          <button onClick={() => setMobileNavOpen(true)} aria-label="Open menu"
            style={{ position: "fixed", top: 8, left: 8, zIndex: 230,
              background: "rgba(19,23,34,0.9)", border: "1px solid var(--border-default,#333)",
              color: "#e5e7eb", borderRadius: 8, padding: "6px 10px", fontSize: "1.05rem", cursor: "pointer" }}>
            ☰
          </button>
        )}

        {/* Index ticker tape — dedicated slim strip, smooth scroll, never clipped */}
        {!isChartsPage && indexTicker.length > 0 && (
          <div className={styles.tickerStrip} data-tour="ticker">
            <div className={styles.tickerTrack}>
              {[0, 1].map((copy) => (
                <div key={copy} className={styles.tickerGroup} aria-hidden={copy === 1}>
                  {indexTicker.map((t) => {
                    const up = (t.change_pct ?? 0) >= 0;
                    const label = (TICKER_SYMBOLS.find(([s]) => s === t.sym) || [null, t.sym])[1];
                    return (
                      <Link key={`${copy}-${t.sym}`} href={`/dashboard/charts?symbol=${t.sym}`}
                        className={styles.tickerItem} title={`${t.sym} — open chart (EOD ${t.date})`}>
                        <span className={styles.tickerLabel}>{label}</span>
                        <span className={styles.tickerPrice}>{t.price}</span>
                        <span style={{ color: up ? "#10b981" : "#ef4444", fontWeight: 700 }}>
                          {up ? "▲" : "▼"} {t.chg}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Page Content Viewport */}
        <main 
          className={styles.pageContent} 
          style={{ 
            flex: 1, 
            overflowY: "auto", 
            height: "calc(100vh - 64px)",
            padding: "24px"
          }}
        >
          {children}
        </main>
      </div>

      {/* Spotlight tour (renders nothing until started) */}
      <TourOverlay />
    </div>
  );
}
