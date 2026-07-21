"""Chartix — Daily EOD sync (segment-aware).

Picks the correct Yahoo Finance ticker per instrument segment, so it updates
NOT just NSE equities but also indices, commodities and forex:

    EQ    → {SYMBOL}.NS
    FOREX → the symbol itself (already a Yahoo pair, e.g. USDINR=X)
    COMM  → the symbol itself when it's a Yahoo future (e.g. GC=F); MCX-only
            contracts (…_MCX) are skipped (no free daily feed)
    IND   → mapped to Yahoo's index ticker (^NSEI, ^NSEBANK, …) where available

Before syncing it checks NSE's listing master for stocks we don't have yet
(see sync_listings.py) so new IPOs don't sit invisible to the scanners, and
falls back to the NSE bhavcopy for any symbol Yahoo can't serve.

Run daily after market close. Fills the last `--days` of bars (gap-safe via
INSERT OR REPLACE). Designed to be called by cron/launchd.
"""

import os
import sys
import logging
from datetime import datetime, time as _time, timezone, timedelta

import pandas as pd
import yfinance as yf
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.config import get_settings  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
log = logging.getLogger(__name__)

# NSE closes 15:30 IST. During the session Yahoo returns a PARTIAL bar for the
# current day; writing it corrupts the EOD table (scanners/patterns/recos all
# read the latest bar). We only accept today's bar once the session is finished.
IST = timezone(timedelta(hours=5, minutes=30))
_MARKET_CLOSE = _time(15, 45)   # 15:30 close + 15-min settle buffer


def _cutoff_date():
    """Latest date whose bar is safe to store. Today counts only after ~15:45 IST."""
    now = datetime.now(IST)
    today = now.date()
    return today if now.time() >= _MARKET_CLOSE else (today - timedelta(days=1))

DB_URL = get_settings().DATABASE_URL.replace("+aiosqlite", "").replace("+asyncpg", "")

# NSE index → Yahoo ticker (only ones Yahoo actually serves). Verified working
# 2026-07 via an empirical probe; a handful of granular NSE sub-indices have no
# Yahoo source at all and can only be updated from an NSE feed later.
INDEX_YF = {
    "NIFTY_50": "^NSEI", "NIFTY_BANK": "^NSEBANK", "NIFTY_IT": "^CNXIT",
    "NIFTY_100": "^CNX100", "NIFTY_200": "^CNX200", "NIFTY_500": "^CRSLDX",
    "NIFTY_AUTO": "^CNXAUTO", "NIFTY_PHARMA": "^CNXPHARMA", "NIFTY_FMCG": "^CNXFMCG",
    "NIFTY_METAL": "^CNXMETAL", "NIFTY_REALTY": "^CNXREALTY", "NIFTY_MEDIA": "^CNXMEDIA",
    "NIFTY_ENERGY": "^CNXENERGY", "NIFTY_PSU_BANK": "^CNXPSUBANK",
    "NIFTY_NEXT_50": "^NSMIDCP", "NIFTY_MIDCAP_50": "^NSEMDCP50",
    "NIFTY_MIDCAP_100": "NIFTY_MIDCAP_100.NS", "NIFTY_SMALLCAP_100": "^CNXSC",
    "NIFTY_FIN_SERVICES": "NIFTY_FIN_SERVICE.NS", "NIFTY_PRIVATE_BANK": "NIFTY_PVT_BANK.NS",
    "NIFTY_HEALTHCARE": "NIFTY_HEALTHCARE.NS", "NIFTY_OIL_GAS": "NIFTY_OIL_AND_GAS.NS",
    "NIFTY_CONSUMER_DURABLES": "NIFTY_CONSR_DURBL.NS", "NIFTY_CEMENT": "NIFTY_CEMENT.NS",
    "NIFTY_CHEMICALS": "NIFTY_CHEMICALS.NS", "NIFTY_FIN_SERVICES_EX_BANK": "NIFTY_FINSEREXBNK.NS",
    "NIFTY_MIDSMALL_HEALTHCARE": "NIFTY_MIDSML_HLTH.NS", "NIFTY_REITS_REALTY": "NIFTY_REITS_REALTY.NS",
}


# Stocks that are BSE-only (not on NSE) — Yahoo needs the .BO suffix.
BSE_ONLY = {"ANDHRAPET": "ANDHRAPET.BO"}


def _yf_ticker(symbol, segment):
    if segment == "EQ":
        return BSE_ONLY.get(symbol, f"{symbol}.NS")
    if segment == "FOREX":
        return symbol  # already a Yahoo pair (USDINR=X)
    if segment == "COMM":
        return symbol if "=" in symbol else None  # GC=F etc.; skip *_MCX
    if segment == "IND":
        return INDEX_YF.get(symbol)
    return None


def _upsert(session, iid, df, cutoff=None):
    if df is None or df.empty:
        return 0
    if getattr(df.columns, "nlevels", 1) > 1:
        df.columns = df.columns.get_level_values(0)
    n = 0
    for ts, r in df.iterrows():
        # Skip any bar for a day that isn't finished yet (partial/live).
        if cutoff is not None and ts.date() > cutoff:
            continue
        try:
            o, h, l, c = float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"])
            v = int(r["Volume"]) if r["Volume"] == r["Volume"] else 0
        except Exception:
            continue
        if any(x != x for x in (o, h, l, c)):
            continue
        session.execute(text(
            "INSERT OR REPLACE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
            "VALUES (:iid,:t,:o,:h,:l,:c,:v)"
        ), {"iid": iid, "t": ts.strftime("%Y-%m-%d"), "o": o, "h": h, "l": l, "c": c, "v": v})
        n += 1
    return n


def run(days=7, skip_listings=False):
    period = f"{max(days, 5)}d"
    cutoff = _cutoff_date()
    log.info(f"EOD cutoff = {cutoff} (today's bar is written only after 15:45 IST)")

    # ── Pre-step: pick up new NSE listings ──
    # Runs BEFORE the sync below so a stock that listed today is already in
    # `instruments` and gets today's bar in this same run, instead of sitting
    # invisible to every scanner until someone notices. Falls back to the NSE
    # bhavcopy for names Yahoo has no ticker for yet.
    if not skip_listings:
        try:
            from sync_listings import sync_listings
            added, bars, _ = sync_listings()
            if added:
                log.info(f"New listings pre-step: +{added} instruments, {bars} bars")
        except Exception as e:
            log.warning(f"New-listings pre-step failed (non-fatal): {e}")

    engine = create_engine(DB_URL, pool_pre_ping=True,
                           connect_args={"timeout": 60} if DB_URL.startswith("sqlite") else {})
    with Session(engine) as s:
        rows = s.execute(text(
            "SELECT id, symbol, segment FROM instruments WHERE is_active = 1"
        )).fetchall()

        # Build (yf_ticker → id) map, split EQ (bulk) from the rest.
        # eq_nse_sym remembers the plain NSE symbol per ticker so the bhavcopy
        # fallback below can look it up (the .BO/BSE-only names have no NSE bar).
        eq, others, eq_nse_sym = {}, {}, {}
        skipped = 0
        for iid, sym, seg in rows:
            t = _yf_ticker(sym, seg)
            if not t:
                skipped += 1
                continue
            if seg == "EQ":
                eq[t] = iid
                if t.endswith(".NS"):
                    eq_nse_sym[t] = sym
            else:
                others[t] = iid

        total = 0

        # ── EQ in bulk chunks ──
        eq_tickers = list(eq.keys())
        for i in range(0, len(eq_tickers), 400):
            chunk = eq_tickers[i:i + 400]
            log.info(f"EQ chunk {i // 400 + 1}: {len(chunk)} tickers")
            try:
                data = yf.download(chunk, period=period, interval="1d",
                                   group_by="ticker", auto_adjust=True, threads=True, progress=False)
            except Exception as e:
                # A whole chunk failing used to silently lose 400 stocks for the
                # day; they stay in eq_empty and the NSE fallback picks them up.
                log.warning(f"chunk failed: {e}"); continue
            for t in chunk:
                try:
                    sub = data[t] if len(chunk) > 1 else data
                except Exception:
                    continue
                total += _upsert(s, eq[t], sub, cutoff)
            s.commit()

        # ── Fallback: anything Yahoo didn't deliver, take from the exchange ──
        # NSE's own bhavcopy is authoritative and covers every mainboard symbol,
        # so a Yahoo outage no longer costs us the day.
        #
        # INSERT OR IGNORE, *not* REPLACE: bhavcopy prices are raw while Yahoo's
        # are split/dividend-adjusted, so overwriting an existing Yahoo bar with
        # a raw one puts a false gap in that symbol's history the moment it goes
        # ex-dividend. The fallback fills holes; it never overrules Yahoo.
        #
        # Trigger is "no bar for the latest session", NOT "Yahoo returned
        # nothing": Yahoo carries some names (the REITs especially) but runs a
        # day stale forever, which a returned-nothing check never catches.
        # Symbols the exchange has no bar for either just come back empty.
        cutoff_s = cutoff.strftime("%Y-%m-%d")
        stale = s.execute(text(
            "SELECT i.symbol, i.id FROM instruments i "
            "WHERE i.segment='EQ' AND i.is_active=1 AND NOT EXISTS ("
            "  SELECT 1 FROM ohlcv_eod o WHERE o.instrument_id=i.id AND o.time=:cut)"
        ), {"cut": cutoff_s}).fetchall()
        eq_nse = set(eq_nse_sym.values())
        fallback_syms = {sym: iid for sym, iid in stale if sym in eq_nse}
        if fallback_syms:
            log.info(f"{len(fallback_syms)} EQ symbols have no bar for {cutoff_s} "
                     f"— trying the NSE bhavcopy")
            try:
                import nse_bhav
                found = nse_bhav.fetch_bars(fallback_syms.keys(), days=max(days, 5), cutoff=cutoff)
                n_fb = 0
                for sym, bars in found.items():
                    for t_, o, h, l, c, v in bars:
                        res = s.execute(text(
                            "INSERT OR IGNORE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
                            "VALUES (:iid,:t,:o,:h,:l,:c,:v)"
                        ), {"iid": fallback_syms[sym], "t": t_, "o": o, "h": h, "l": l, "c": c, "v": v})
                        n_fb += res.rowcount or 0
                s.commit()
                total += n_fb
                log.info(f"NSE fallback: filled {n_fb} missing bars for {len(found)} symbols; "
                         f"{len(fallback_syms) - len(found)} not on the exchange either (likely delisted)")
            except Exception as e:
                log.warning(f"NSE fallback failed (non-fatal): {e}")

        # ── Indices / commodities / forex individually ──
        for t, iid in others.items():
            try:
                df = yf.download(t, period=period, interval="1d",
                                 auto_adjust=True, progress=False)
                total += _upsert(s, iid, df, cutoff)
            except Exception as e:
                log.warning(f"{t} failed: {e}")
        s.commit()

        log.info(f"Done. EQ={len(eq)}, other={len(others)}, skipped(no feed)={skipped}, "
                 f"bars written={total}")

    # ── Post-step: official NSE index snapshot ──
    # The exchange's own ind_close_all CSV covers every NSE index, including the
    # ones Yahoo lags on or lacks (Midcap 100, Next 50, thematic indices).
    try:
        from sync_nse_indices import sync_indices
        n = sync_indices(days)
        log.info(f"NSE index csv post-step: {n} index bars upserted")
    except Exception as e:
        log.warning(f"NSE index post-step failed (non-fatal): {e}")

    # ── Post-step: NSE delivery volume ──
    # DELIV_QTY / DELIV_PER from the full bhavcopy — the institutional-conviction
    # proxy Yahoo doesn't carry. Must run after OHLCV so the rows exist to update.
    try:
        from sync_delivery import sync_delivery
        n = sync_delivery(days)
        log.info(f"NSE delivery post-step: {n} rows got delivery data")
    except Exception as e:
        log.warning(f"NSE delivery post-step failed (non-fatal): {e}")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--skip-listings", action="store_true",
                   help="don't check for new NSE listings first")
    args = p.parse_args()
    run(args.days, skip_listings=args.skip_listings)
