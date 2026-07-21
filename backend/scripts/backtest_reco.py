"""Backtest the swing-trade recommendation logic.

Reuses the LIVE detection (`_score_setup` in app.api.trade_plan) on historical
slices — so it validates the exact logic that ships — then simulates each
detected setup forward against real bars:

  • Breakout: only "taken" if price actually triggers the buy-stop within 10 bars.
  • Pullback / Reversal: entered at the close of the signal bar.
  • Exit: first-touch of stop (-1R) or first target t1 (+1.5R); if both on the
    same bar, assume the stop first (conservative). Neither within 40 trading
    days → timeout, marked to the closing price.
  • One position per stock at a time (no overlapping entries).

Aggregates win-rate and average-R by setup and by confidence tier, and writes
data/reco_backtest.json — the table the live scanner uses to rank new trades by
empirical, back-tested win probability.

Run:  venv/bin/python scripts/backtest_reco.py
"""
import os
import sys
import json
import time
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.api.trade_plan import _score_setup, _weighted_return, _conf_tier  # noqa: E402

DB = "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "reco_backtest.json")

SAMPLE_EVERY = 5      # evaluate a new cohort of signals every N trading days
MAX_HOLD = 40         # trading days before a trade times out
BREAKOUT_FILL = 10    # bars allowed for a breakout buy-stop to trigger
LOOKBACK = 300        # bars fed to the detector (needs >=120, uses up to 252)
HISTORY_DAYS = 1600   # ~4.3y of history loaded


def load_nifty():
    """NIFTY_50 closes keyed by date — the regime reference series."""
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT e.time, e.close FROM ohlcv_eod e "
        "JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.symbol = 'NIFTY_50' AND e.close IS NOT NULL ORDER BY e.time ASC"
    ).fetchall()
    con.close()
    dates = [str(t)[:10] for t, _ in rows]
    closes = pd.Series([float(c) for _, c in rows])
    sma50 = closes.rolling(50).mean()
    sma200 = closes.rolling(200).mean()
    out = {}
    for i, d in enumerate(dates):
        a50 = bool(closes[i] > sma50[i]) if not pd.isna(sma50[i]) else None
        a200 = bool(closes[i] > sma200[i]) if not pd.isna(sma200[i]) else None
        out[d] = (a50, a200)
    return out


def regime_of(nifty_map, date):
    """3-bucket regime as-of a date: bull (>50 & >200 DMA), bear (< both), mixed."""
    # exact date, else walk back a few days (holiday gaps)
    from datetime import datetime as _dt, timedelta as _td
    d = date
    for _ in range(7):
        if d in nifty_map:
            a50, a200 = nifty_map[d]
            if a50 is None or a200 is None:
                return None
            if a50 and a200: return "bull"
            if not a50 and not a200: return "bear"
            return "mixed"
        d = (_dt.strptime(d, "%Y-%m-%d") - _td(days=1)).strftime("%Y-%m-%d")
    return None


def load():
    con = sqlite3.connect(DB)
    cur = con.cursor()
    insts = cur.execute(
        "SELECT id, symbol, name, sector FROM instruments WHERE is_active=1 AND segment='EQ'"
    ).fetchall()
    fund = {}
    for iid, roe, dte, margin in cur.execute(
        "SELECT instrument_id, roe, debt_to_equity, profit_margin FROM fundamentals"
    ).fetchall():
        fund[iid] = (
            float(roe) if roe is not None else None,
            float(dte) if dte is not None else None,
            float(margin) if margin is not None else None,
        )
    meta = {}
    for iid, sym, name, sector in insts:
        roe, dte, margin = fund.get(iid, (None, None, None))
        meta[iid] = {"symbol": sym, "name": name, "sector": sector or "—",
                     "roe": roe, "dte": dte, "margin": margin}

    rows = cur.execute(
        "SELECT e.instrument_id, e.time, e.high, e.low, e.close, e.volume "
        "FROM ohlcv_eod e JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.is_active=1 AND i.segment='EQ' AND e.close IS NOT NULL "
        "AND e.time >= date('now','-%d day') "
        "ORDER BY e.instrument_id, e.time ASC" % HISTORY_DAYS
    ).fetchall()
    con.close()

    series = {}
    for iid, t, hi, lo, cl, vol in rows:
        d = series.setdefault(iid, {"t": [], "h": [], "l": [], "c": [], "v": []})
        cl = float(cl)
        d["t"].append(str(t)[:10])
        d["h"].append(float(hi) if hi is not None else cl)
        d["l"].append(float(lo) if lo is not None else cl)
        d["c"].append(cl)
        d["v"].append(float(vol) if vol is not None else 0.0)
    return meta, series


def simulate(setup, entry, stop, t1, t2, H, L, C, start):
    """Return (outcome, R, exit_idx, scale_r) or None if a breakout never triggered.

    R           = pure first-target exit in R (the win-rate metric).
    scale_r     = the SCALE-OUT plan: book half at t1, move the stop on the other
                  half to breakeven, let it run to t2. scale_r = 0.5*win_r + 0.5*leg2.
    """
    n = len(C)
    risk = entry - stop
    if risk <= 0:
        return None
    if setup == "Breakout":
        fill = None
        for j in range(start, min(start + BREAKOUT_FILL, n)):
            if H[j] >= entry:
                fill = j
                break
        if fill is None:
            return None
        scan_from = fill
    else:
        scan_from = start
    end = min(scan_from + MAX_HOLD, n)
    win_r = (t1 - entry) / risk
    t2_r = (t2 - entry) / risk
    # CLOSING-BASIS stops: a stop fires only when the day CLOSES beyond it, and we
    # exit at that close (usually worse than the stop level — the honest cost of a
    # closing stop, in exchange for not being wicked out intraday). Targets stay
    # intraday-touch (a limit order fills), and are checked first each bar.
    for j in range(scan_from, end):
        if H[j] >= t1:                    # first target touched → scale out half here
            # Runner: breakeven (closing) stop only applies AFTER the t1 bar.
            if H[j] >= t2:
                leg2, ek = t2_r, j
            else:
                leg2, ek = None, end - 1
                for k in range(j + 1, end):
                    if H[k] >= t2:        # runner reaches target 2 (touch)
                        leg2, ek = t2_r, k
                        break
                    if C[k] <= entry:     # runner closes back to breakeven → 0R
                        leg2, ek = 0.0, k
                        break
                if leg2 is None:          # still open at window end → mark to close
                    leg2 = (C[end - 1] - entry) / risk
            return ("win", win_r, ek, 0.5 * win_r + 0.5 * leg2)
        if C[j] <= stop:                  # CLOSED below the stop → exit at the close
            loss_r = (C[j] - entry) / risk
            return ("loss", loss_r, j, loss_r)
    last = end - 1
    if last < scan_from:
        return None
    r = (C[last] - entry) / risk
    return ("timeout", r, last, r)


def main():
    t0 = time.time()
    print("loading history…", flush=True)
    meta, series = load()
    nifty = load_nifty()
    trades_out = os.environ.get("TRADES_OUT")  # optional per-trade dump for analysis
    trades = []
    print(f"  {len(series)} instruments, {sum(len(s['c']) for s in series.values())} bars", flush=True)

    # master trading calendar
    all_dates = sorted({d for s in series.values() for d in s["t"]})
    # date -> per-instrument bar index (position of the last bar on/before date)
    # Precompute each instrument's date->index map for O(1) lookup.
    idx_map = {iid: {d: i for i, d in enumerate(s["t"])} for iid, s in series.items()}
    pd_cache = {}  # iid -> dict of pandas Series (built lazily, reused)

    def series_pd(iid):
        s = pd_cache.get(iid)
        if s is None:
            d = series[iid]
            s = {"h": pd.Series(d["h"]), "l": pd.Series(d["l"]),
                 "c": pd.Series(d["c"]), "v": pd.Series(d["v"])}
            pd_cache[iid] = s
        return s

    # eval dates: leave room for lookback + forward simulation
    lo, hi = 252, len(all_dates) - (MAX_HOLD + BREAKOUT_FILL + 1)
    eval_dates = all_dates[lo:hi:SAMPLE_EVERY]
    print(f"  {len(eval_dates)} evaluation dates ({eval_dates[0]} → {eval_dates[-1]})", flush=True)

    agg = defaultdict(lambda: {"win": 0, "loss": 0, "timeout": 0, "R": 0.0, "scale_R": 0.0, "n": 0})
    next_free = defaultdict(int)   # iid -> earliest bar index free for a new trade
    n_signals = 0

    for di, D in enumerate(eval_dates):
        # 1) RS distribution as-of D
        rs_returns = []
        present = []   # (iid, idx)
        for iid, s in series.items():
            idx = idx_map[iid].get(D)
            if idx is None or idx < 120:
                continue
            present.append((iid, idx))
            c = series_pd(iid)["c"]
            wr = _weighted_return(c.iloc[max(0, idx - 252):idx + 1])
            if wr is not None:
                rs_returns.append(wr)
        rs_dist = sorted(rs_returns)

        # 2) detect + simulate
        for iid, idx in present:
            if idx < next_free[iid]:       # a prior trade in this stock is still open
                continue
            sp = series_pd(iid)
            a = max(0, idx - LOOKBACK)
            # _score_setup signature: (c, h, l, vv, meta, rs_dist, ai_up). No
            # per-day historical forecast exists, so ai_up=None (AI term = 0).
            rec = _score_setup(
                sp["c"].iloc[a:idx + 1].reset_index(drop=True),
                sp["h"].iloc[a:idx + 1].reset_index(drop=True),
                sp["l"].iloc[a:idx + 1].reset_index(drop=True),
                sp["v"].iloc[a:idx + 1].reset_index(drop=True),
                meta[iid], rs_dist, None,
            )
            if not rec:
                continue
            n_signals += 1
            H, L, C = series[iid]["h"], series[iid]["l"], series[iid]["c"]
            res = simulate(rec["setup"], rec["entry"], rec["stop"], rec["target1"],
                           rec["target2"], H, L, C, idx + 1)
            if res is None:
                continue
            outcome, R, exit_idx, scale_r = res
            next_free[iid] = exit_idx + 1
            tier = _conf_tier(rec["base_conf"])
            reg = regime_of(nifty, D)
            keys = ["overall", rec["setup"], f'{rec["setup"]}|{tier}']
            if reg:
                keys.append(f'regime:{rec["setup"]}|{reg}')
                keys.append(f'regime:ALL|{reg}')
            for key in keys:
                a2 = agg[key]
                a2[outcome] += 1
                a2["R"] += R
                a2["scale_R"] += scale_r
                a2["n"] += 1
            if trades_out:
                trades.append({
                    "date": D, "symbol": rec["symbol"], "setup": rec["setup"],
                    "tier": tier, "base_conf": rec["base_conf"], "rs": rec["rs"],
                    "outcome": outcome, "R": round(R, 3), "scale_r": round(scale_r, 3),
                    "regime": reg, **(rec.get("_diag") or {}),
                })

        if di % 10 == 0:
            print(f"  [{di+1}/{len(eval_dates)}] {D}  signals so far={n_signals}  "
                  f"elapsed={time.time()-t0:.0f}s", flush=True)

    # 3) build the table
    def finalize(a):
        n = a["n"]
        if n == 0:
            return None
        return {"n": n, "wins": a["win"], "losses": a["loss"], "timeouts": a["timeout"],
                "win_rate": round(a["win"] / n * 100, 1),
                "avg_r": round(a["R"] / n, 3),
                "avg_scale_r": round(a["scale_R"] / n, 3)}

    by_setup = {}
    by_setup_conf = {}
    by_regime = {}
    overall = None
    for key, a in agg.items():
        f = finalize(a)
        if f is None:
            continue
        if key == "overall":
            overall = f
        elif key.startswith("regime:"):
            by_regime[key[len("regime:"):]] = f
        elif "|" in key:
            by_setup_conf[key] = f
        else:
            by_setup[key] = f

    table = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "params": {"sample_every": SAMPLE_EVERY, "max_hold": MAX_HOLD,
                   "breakout_fill": BREAKOUT_FILL, "win_def": "t1 (+1.5R) before stop (-1R)"},
        "window": {"from": eval_dates[0], "to": eval_dates[-1], "eval_dates": len(eval_dates)},
        "n_trades": overall["n"] if overall else 0,
        "overall": overall,
        "by_setup": by_setup,
        "by_setup_conf": by_setup_conf,
        "by_regime": by_regime,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(table, fh, indent=2)
    if trades_out:
        with open(trades_out, "w") as fh:
            json.dump(trades, fh)
        print(f"wrote {len(trades)} trades to {trades_out}")

    print("\n=== BACKTEST RESULTS ===", flush=True)
    print(f"trades simulated: {table['n_trades']}   (took {time.time()-t0:.0f}s)")
    if overall:
        print(f"OVERALL   win-rate {overall['win_rate']}%   avg {overall['avg_r']}R   n={overall['n']}")
    for setup in ("Breakout", "Pullback in uptrend", "Oversold reversal"):
        f = by_setup.get(setup)
        if f:
            print(f"  {setup:22} win {f['win_rate']:5}%   avg {f['avg_r']:+.3f}R   n={f['n']}")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
