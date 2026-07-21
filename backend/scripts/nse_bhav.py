"""Chartix — NSE bhavcopy OHLCV reader (the fallback when Yahoo has nothing).

Yahoo is the primary EOD feed, but it has blind spots: a stock that listed
today has no ticker yet, and thinly-traded names sometimes return an empty
frame. The exchange's own full bhavcopy always has the bar:

    https://archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv

Same file sync_delivery.py uses for DELIV_QTY/DELIV_PER — it carries the full
OHLCV too (OPEN_PRICE / HIGH_PRICE / LOW_PRICE / CLOSE_PRICE / TTL_TRD_QNTY).

IMPORTANT — prices are NOT the same basis as Yahoo's:
    Yahoo (auto_adjust=True) → split/dividend ADJUSTED
    NSE bhavcopy            → RAW traded prices
Mixing the two inside one symbol's history puts a false gap at every split.
So this is a *fallback*, not a peer: use it for symbols Yahoo can't serve at
all (new listings, which have no corporate actions yet anyway), never to
patch holes in a history Yahoo already covers.

The file is per-day, so reading N days costs N requests. `fetch_day` caches
per process — walk the days once and pull every symbol you need from each,
rather than re-fetching the same CSV per symbol.
"""

import csv
import io
import logging
import time as _time
from datetime import date, timedelta

import requests

log = logging.getLogger(__name__)

ARCHIVE_URL = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{ddmmyyyy}.csv"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

# Mainboard traded series.
#   EQ/BE/BZ — ordinary equity, trade-for-trade, suspended
#   RR/IV    — REITs and InvITs (EMBASSY, MINDSPACE, BIRET, KRT…). These are in
#              `instruments` and trade normally, but Yahoo carries none of them,
#              so without this the exchange feed would skip the only source they
#              have and they'd look permanently delisted.
# SM/ST (SME) stay out — a different universe the instrument table doesn't carry.
SERIES_OK = {"EQ", "BE", "BZ", "RR", "IV"}

_cache = {}     # date -> {symbol: (o, h, l, c, v)} | None when no file that day


def _num(v):
    try:
        v = (v or "").replace(",", "").strip()
        return float(v) if v and v != "-" else None
    except Exception:
        return None


def fetch_day(d: date, pause=0.6, use_cache=True):
    """{symbol: (open, high, low, close, volume)} for one trading day, or None
    if the archive has no file (weekend / holiday). Cached per process.

    Pass use_cache=False for long historical walks: each day holds ~2,700
    symbols, so caching thousands of them would eat GBs of RAM. Short syncs
    re-read the same few days repeatedly and do want the cache.
    """
    if use_cache and d in _cache:
        return _cache[d]
    if d.weekday() >= 5:                    # weekend — no bhavcopy exists
        if use_cache:
            _cache[d] = None
        return None

    try:
        r = requests.get(ARCHIVE_URL.format(ddmmyyyy=d.strftime("%d%m%Y")),
                         headers=HEADERS, timeout=30)
    except Exception as e:
        log.warning(f"bhavcopy {d}: fetch failed ({e})")
        if use_cache:
            _cache[d] = None
        return None
    finally:
        _time.sleep(pause)                  # be polite to the NSE archive

    if r.status_code != 200 or not r.text or "SYMBOL" not in r.text[:200]:
        if use_cache:
            _cache[d] = None                # holiday
        return None

    out = {}
    for row in csv.DictReader(io.StringIO(r.text)):
        row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        if row.get("SERIES") not in SERIES_OK:
            continue
        o, h, l, c = (_num(row.get(k)) for k in
                      ("OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE", "CLOSE_PRICE"))
        if None in (o, h, l, c):
            continue
        v = _num(row.get("TTL_TRD_QNTY")) or 0
        out[row["SYMBOL"]] = (o, h, l, c, int(v))
    if use_cache:
        _cache[d] = out
    return out


def walk(symbols, start, cutoff, pause=0.6, on_day=None):
    """Stream the archive from `cutoff` back to `start`, yielding bars for
    `symbols` one day at a time.

    Unlike fetch_bars this holds no history in memory (use_cache=False) — the
    caller writes each day and the day is dropped. That's what makes a
    multi-year walk safe on this box; caching ~1,650 days x ~2,700 symbols
    would cost GBs.

    Yields (day, {symbol: (o, h, l, c, v)}) for days that have a file.
    """
    symbols = set(symbols)
    d = cutoff
    while d >= start:
        day = fetch_day(d, pause=pause, use_cache=False)
        if day:
            hit = {s: day[s] for s in symbols if s in day}
            if hit:
                yield d, hit
        if on_day:
            on_day(d)
        d -= timedelta(days=1)


def fetch_bars(symbols, days=30, cutoff=None, pause=0.6):
    """Walk back `days` calendar days once and collect bars for every symbol in
    `symbols`. Returns {symbol: [(date_str, o, h, l, c, v), …]} oldest-first.

    Bars after `cutoff` are skipped — mid-session the exchange has no file yet,
    but the caller's cutoff is the single source of truth on what counts.
    """
    symbols = set(symbols)
    if not symbols:
        return {}
    cutoff = cutoff or date.today()
    out = {s: [] for s in symbols}

    for back in range(days):
        d = date.today() - timedelta(days=back)
        if d > cutoff:
            continue
        day = fetch_day(d, pause=pause)
        if not day:
            continue
        day_s = d.strftime("%Y-%m-%d")
        for sym in symbols:
            bar = day.get(sym)
            if bar:
                out[sym].append((day_s, *bar))

    for sym in out:
        out[sym].sort(key=lambda x: x[0])
    return {s: bars for s, bars in out.items() if bars}
