"""Seed the backtest-derived swing scanners as PUBLIC custom scanners.

These operationalise the per-stock logics that came out of the reco backtest
(scripts/backtest_reco.py, ~16k NSE swing trades 2020–2026). Only the logics that
are expressible as per-STOCK indicator conditions become scanners:

  • Shallow pullback near highs (the cleanest edge: 66% win / +0.29R when the
    stock is within ~20% of its high, vs 56% / −0.02R when deeper)
  • Relative-strength leader (a bounce/breakout in a leader beats one in a laggard)

The other three findings are NOT per-stock filters and stay in the Swing Trade
Plan engine, which already fuses all five:
  • Market regime (a market-level switch, not a stock condition)
  • Expectancy over win-rate (a ranking rule)
  • Scale-out with a runner (trade management)

Run:  venv/bin/python scripts/seed_swing_scans.py
Idempotent — skips scanners whose name already exists.
"""
import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select
from app.database import get_db
from app.models import User, CustomScanner

# Building blocks: an "uptrend leader" = price>200DMA, 50DMA>200DMA (proxy for
# relative strength, since the scanner engine has no universe-relative RS).
_ABOVE_200 = {"indicator": "price", "operator": "gt",
              "compare_to": {"indicator": "sma", "params": {"period": 200}}}
_50_OVER_200 = {"indicator": "sma", "params": {"period": 50}, "operator": "gt",
                "compare_to": {"indicator": "sma", "params": {"period": 200}}}

SCANNERS = [
    {
        "name": "Shallow Pullback in a Leader (Swing)",
        "description": ("Backtest edge #2 (cleanest): buy the dip in a rising leader while it is "
                        "still shallow. Uptrend (price>200DMA, 50DMA>200DMA), price holding above "
                        "the 50DMA (near highs, not a deep slide), RSI pulled back into 45–58. "
                        "Backtest: shallow pullbacks (within ~20% of the 52w high) won 66% at "
                        "+0.29R vs 56% / −0.02R for deep ones. Best in bull/mixed market tape."),
        "logic": "AND",
        "conditions": [
            _ABOVE_200, _50_OVER_200,
            {"indicator": "price", "operator": "gt",
             "compare_to": {"indicator": "sma", "params": {"period": 50}}},
            {"indicator": "rsi", "params": {"period": 14}, "operator": "lt", "value": 58},
            {"indicator": "rsi", "params": {"period": 14}, "operator": "gt", "value": 45},
        ],
    },
    {
        "name": "Breakout in a Leader (Swing)",
        "description": ("A fresh breakout above the upper Bollinger band (20,2) in a relative-strength "
                        "leader (uptrend: price>200DMA, 50DMA>200DMA). Backtest: breakouts led by "
                        "strong stocks win ~65% vs 62% ungated. Regime note — breakouts work in "
                        "bull/mixed tape but collapse in a weak market (51% in bear); skip them when "
                        "the market is Risk-Off."),
        "logic": "AND",
        "conditions": [
            {"indicator": "price", "operator": "crosses_above",
             "compare_to": {"indicator": "bbands", "params": {"period": 20, "component": "upper"}},
             "params": {"within_bars": 3}},
            _50_OVER_200, _ABOVE_200,
        ],
    },
    {
        "name": "Oversold Reversal in a Leader (Swing)",
        "description": ("Buy an oversold LEADER turning up — not a falling knife. Stock still above "
                        "its 200DMA (long-term uptrend intact), RSI below 50 (pulled back), price "
                        "crossing back above its 20DMA (turning up). Backtest: filtering reversals to "
                        "relative-strength leaders flipped this from the weakest setup into the "
                        "strongest weak-market play (~65% / +0.40R in bear tape). This is the setup "
                        "to favour when the market is Risk-Off."),
        "logic": "AND",
        "conditions": [
            _ABOVE_200,
            {"indicator": "rsi", "params": {"period": 14}, "operator": "lt", "value": 50},
            {"indicator": "price", "operator": "crosses_above",
             "compare_to": {"indicator": "sma", "params": {"period": 20}},
             "params": {"within_bars": 3}},
        ],
    },
    {
        "name": "Strong Trend Leader (Swing Universe)",
        "description": ("The relative-strength 'leader' universe to combine with the setups above. "
                        "Price above a rising 50DMA, 50DMA>200DMA, ADX>25 (a real trend), RSI>55 "
                        "(active momentum). Backtest finding #5: a bounce or breakout in a leader beats "
                        "one in a laggard — but RS works as a filter WITHIN a setup, not as a buy signal "
                        "on its own, so use this to qualify candidates rather than trade blindly."),
        "logic": "AND",
        "conditions": [
            {"indicator": "price", "operator": "gt",
             "compare_to": {"indicator": "sma", "params": {"period": 50}}},
            _50_OVER_200,
            {"indicator": "sma", "params": {"period": 50}, "operator": "slope_up",
             "params": {"slope_period": 10}},
            {"indicator": "adx", "params": {"period": 14}, "operator": "gt", "value": 25},
            {"indicator": "rsi", "params": {"period": 14}, "operator": "gt", "value": 55},
        ],
    },
]


async def seed():
    async for db in get_db():
        user = (await db.execute(select(User).limit(1))).scalar_one_or_none()
        if not user:
            print("No users in the DB — create one first.")
            return
        print(f"Seeding under user {user.id} ({user.email})")
        existing = set((await db.execute(select(CustomScanner.name))).scalars().all())
        added = 0
        for s in SCANNERS:
            if s["name"] in existing:
                print(f"  skip (exists): {s['name']}")
                continue
            db.add(CustomScanner(user_id=user.id, name=s["name"], description=s["description"],
                                 conditions=s["conditions"], logic=s["logic"], is_public=True))
            added += 1
            print(f"  + {s['name']}  ({len(s['conditions'])} conditions)")
        await db.commit()
        print(f"\nDone. {added} public swing scanners added.")
        break


if __name__ == "__main__":
    asyncio.run(seed())
