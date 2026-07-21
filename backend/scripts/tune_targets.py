"""Measure recommendation win-rate at several first-target distances.

Reuses the LIVE detector (_score_setup) exactly like backtest_reco.py, but for
every detected setup it records the Maximum Favourable Excursion before the stop
is hit — so we can read off the win-rate for a 0.75R / 1.0R / 1.25R / 1.5R first
target in a single pass. This tells us which target gets each setup+grade above a
50% hit-rate before we commit to it.

Run:  venv/bin/python scripts/tune_targets.py
"""
import os
import sys
import time
from collections import defaultdict

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.api.trade_plan import _score_setup, _weighted_return, _conf_tier  # noqa: E402
from scripts import backtest_reco as bt  # reuse loader + params  # noqa: E402

TARGETS = [0.75, 1.0, 1.25, 1.5]


def first_touch_bars(entry, stop, risk, H, L, C, start, setup):
    """Return (stop_bar, {T: target_bar}) as bar offsets from `start`, or None if a
    breakout never triggered. inf = never within the window."""
    n = len(C)
    if setup == "Breakout":
        fill = None
        for j in range(start, min(start + bt.BREAKOUT_FILL, n)):
            if H[j] >= entry:
                fill = j
                break
        if fill is None:
            return None
        scan = fill
    else:
        scan = start
    stop_bar = float("inf")
    tgt_bar = {T: float("inf") for T in TARGETS}
    end = min(scan + bt.MAX_HOLD, n)
    for j in range(scan, end):
        if C[j] <= stop and stop_bar == float("inf"):  # closing-basis stop
            stop_bar = j
        for T in TARGETS:
            if tgt_bar[T] == float("inf") and H[j] >= entry + T * risk:
                tgt_bar[T] = j
        if stop_bar != float("inf") and all(tgt_bar[T] != float("inf") for T in TARGETS):
            break
    return stop_bar, tgt_bar


def main():
    t0 = time.time()
    print("loading history…", flush=True)
    meta, series = bt.load()
    print(f"  {len(series)} instruments", flush=True)
    all_dates = sorted({d for s in series.values() for d in s["t"]})
    idx_map = {iid: {d: i for i, d in enumerate(s["t"])} for iid, s in series.items()}
    pd_cache = {}

    def spd(iid):
        s = pd_cache.get(iid)
        if s is None:
            d = series[iid]
            s = {"h": pd.Series(d["h"]), "l": pd.Series(d["l"]),
                 "c": pd.Series(d["c"]), "v": pd.Series(d["v"])}
            pd_cache[iid] = s
        return s

    lo, hi = 252, len(all_dates) - (bt.MAX_HOLD + bt.BREAKOUT_FILL + 1)
    eval_dates = all_dates[lo:hi:bt.SAMPLE_EVERY]
    print(f"  {len(eval_dates)} eval dates", flush=True)

    # counters: key -> {T: wins, "n": trades}
    agg = defaultdict(lambda: {"n": 0, **{T: 0 for T in TARGETS}})
    next_free = defaultdict(int)

    for di, D in enumerate(eval_dates):
        rs_returns, present = [], []
        for iid, s in series.items():
            idx = idx_map[iid].get(D)
            if idx is None or idx < 120:
                continue
            present.append((iid, idx))
            wr = _weighted_return(spd(iid)["c"].iloc[max(0, idx - 252):idx + 1])
            if wr is not None:
                rs_returns.append(wr)
        rs_dist = sorted(rs_returns)

        for iid, idx in present:
            if idx < next_free[iid]:
                continue
            sp = spd(iid)
            a = max(0, idx - bt.LOOKBACK)
            rec = _score_setup(
                sp["c"].iloc[a:idx + 1].reset_index(drop=True),
                sp["h"].iloc[a:idx + 1].reset_index(drop=True),
                sp["l"].iloc[a:idx + 1].reset_index(drop=True),
                sp["v"].iloc[a:idx + 1].reset_index(drop=True),
                meta[iid], rs_dist, None,
            )
            if not rec:
                continue
            H, L, C = series[iid]["h"], series[iid]["l"], series[iid]["c"]
            risk = rec["entry"] - rec["stop"]
            if risk <= 0:
                continue
            ft = first_touch_bars(rec["entry"], rec["stop"], risk, H, L, C, idx + 1, rec["setup"])
            if ft is None:
                continue
            stop_bar, tgt_bar = ft
            # free the stock until the earliest exit we'd realistically take (1R)
            exit_ref = min(stop_bar, tgt_bar[1.0])
            next_free[iid] = (exit_ref if exit_ref != float("inf") else idx + bt.MAX_HOLD) + 1
            tier = _conf_tier(rec["base_conf"])
            for key in ("overall", rec["setup"], f'{rec["setup"]}|{tier}'):
                agg[key]["n"] += 1
                for T in TARGETS:
                    if tgt_bar[T] < stop_bar:      # target reached strictly before stop
                        agg[key][T] += 1
        if di % 20 == 0:
            print(f"  [{di+1}/{len(eval_dates)}] {D} elapsed={time.time()-t0:.0f}s", flush=True)

    def wr(key):
        a = agg[key]
        n = a["n"]
        if n < 50:
            return None
        return n, {T: round(a[T] / n * 100, 1) for T in TARGETS}

    print("\n=== WIN-RATE BY FIRST TARGET (win = target before stop) ===")
    print(f"{'bucket':30} {'n':>6}  " + "  ".join(f"{T}R" for T in TARGETS))
    order = ["overall", "Breakout", "Pullback in uptrend", "Oversold reversal"]
    tiers = ["80+", "70-79", "60-69", "55-59"]
    keys = order + [f"{s}|{t}" for s in ("Breakout", "Pullback in uptrend", "Oversold reversal") for t in tiers]
    for key in keys:
        r = wr(key)
        if r is None:
            continue
        n, m = r
        print(f"{key:30} {n:>6}  " + "  ".join(f"{m[T]:>4}" for T in TARGETS))
    print(f"\n(took {time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
