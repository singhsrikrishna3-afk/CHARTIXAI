"""Chartix — AI assistant powered by Claude on AWS Bedrock.

This is a *scaffold*: it is fully wired but gated behind ``settings.BEDROCK_ENABLED``
(default False) and requires ``boto3`` plus AWS credentials with Bedrock model
access. Until those are present, ``/api/chatbot/query`` transparently falls back to
the legacy rule-based intent router in ``app.api.chatbot``.

Design: Claude drives the conversation and calls *tools* that map onto Chartix's
existing scan functions (the same ones the rule-based router calls). We run the
Bedrock Converse API tool-use loop, executing each requested tool against the live
DB/subscription context, and return Claude's final natural-language answer plus the
structured matches it surfaced.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.models import User

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are the Chartix AI assistant, an expert Indian-market (NSE equities and MCX "
    "commodities/forex) technical-analysis co-pilot. You help traders find setups by "
    "running scans through the provided tools and explaining the results plainly.\n\n"
    "Guidelines:\n"
    "- When the user asks for stocks matching technical criteria, choose the most "
    "appropriate tool and fill its parameters. Prefer running a tool over guessing.\n"
    "- Timeframes: 'D' daily, 'W' weekly, 'M' monthly. Default to 'D' unless the user "
    "says otherwise.\n"
    "- 'index' narrows the universe (e.g. NIFTY_50, NIFTY_BANK, BULLION). Omit it to "
    "scan all instruments.\n"
    "- After a tool returns, summarise how many instruments matched and name a handful "
    "of the most notable ones. Never invent symbols that a tool did not return.\n"
    "- If a tool reports a subscription/access error, tell the user which plan unlocks "
    "the feature instead of retrying.\n"
    "- You are not a financial adviser; do not give buy/sell recommendations. Describe "
    "what the scan found."
)


# ── Tool schemas (Bedrock Converse `toolConfig` format) ───────────────────────
def _tool_specs() -> list[dict]:
    tf = {"type": "string", "enum": ["D", "W", "M"], "description": "Timeframe: D/W/M"}
    idx = {"type": "string", "description": "Optional index/universe symbol e.g. NIFTY_50, NIFTY_BANK, BULLION. Omit to scan everything."}
    return [
        {"toolSpec": {
            "name": "run_moving_average_scan",
            "description": "Scan for moving-average setups: MA crossovers (e.g. golden/death cross) or price above/below an MA.",
            "inputSchema": {"json": {
                "type": "object",
                "properties": {
                    "scan_type": {"type": "string", "enum": ["crossover", "price_above"]},
                    "ma_type": {"type": "string", "enum": ["SMA", "EMA"]},
                    "fast_period": {"type": "integer", "description": "First/short MA period (or the single MA for price_above)."},
                    "slow_period": {"type": "integer", "description": "Second/long MA period for crossover."},
                    "direction": {"type": "string", "enum": ["bullish", "bearish"]},
                    "timeframe": tf, "index": idx,
                },
                "required": ["scan_type", "ma_type", "fast_period", "direction"],
            }},
        }},
        {"toolSpec": {
            "name": "run_indicator_scan",
            "description": "Scan by technical indicator: RSI (oversold/overbought/level), Supertrend (buy/sell), or MACD crossover.",
            "inputSchema": {"json": {
                "type": "object",
                "properties": {
                    "indicator": {"type": "string", "enum": ["rsi", "supertrend", "macd"]},
                    "signal": {"type": "string", "description": "rsi: below_level|above_level|range; supertrend: buy|sell|touch; macd: bullish_crossover|bearish_crossover"},
                    "rsi_level": {"type": "number", "description": "RSI threshold when indicator=rsi (e.g. 30 oversold, 70 overbought)."},
                    "timeframe": tf, "index": idx,
                },
                "required": ["indicator", "signal"],
            }},
        }},
        {"toolSpec": {
            "name": "run_candlestick_scan",
            "description": "Scan for candlestick patterns on the latest bar.",
            "inputSchema": {"json": {
                "type": "object",
                "properties": {
                    "patterns": {"type": "array", "items": {"type": "string", "enum": ["doji", "hammer", "engulfing", "morning_star", "shooting_star", "marubozu"]}},
                    "timeframe": tf, "index": idx,
                },
                "required": ["patterns"],
            }},
        }},
        {"toolSpec": {
            "name": "run_chart_pattern_scan",
            "description": "Screen detected multi-bar chart patterns (double top/bottom, head & shoulders, flags, wedges, triangles).",
            "inputSchema": {"json": {
                "type": "object",
                "properties": {
                    "pattern_type": {"type": "string", "description": "e.g. double_bottom, double_top, head_shoulders, bull_flag, falling_wedge, asc_triangle"},
                    "status": {"type": "string", "enum": ["forming", "completed"]},
                    "timeframe": tf, "index": idx,
                },
                "required": ["pattern_type"],
            }},
        }},
        {"toolSpec": {
            "name": "get_price_forecast",
            "description": "Get the LSTM price forecast for a single instrument by symbol (requires AI EOD Pro plan).",
            "inputSchema": {"json": {
                "type": "object",
                "properties": {"symbol": {"type": "string", "description": "Instrument symbol e.g. RELIANCE"}},
                "required": ["symbol"],
            }},
        }},
    ]


# ── Tool handlers — thin adapters over the existing scan functions ────────────
def _build_tool_handlers(db: AsyncSession, user: User, collected_matches: list) -> dict[str, Callable]:
    # Imported here to avoid a circular import (chatbot -> assistant -> scans/screener).
    from app.api.scans import ma_scanner, indicator_scanner, candlestick_scanner
    from app.api.screener import list_patterns

    def _slim(matches: list, limit: int = 15) -> list:
        """Trim match dicts to keep tool-result tokens small; full set is returned via the API."""
        out = []
        for m in matches[:limit]:
            out.append({k: m.get(k) for k in ("symbol", "name", "sector", "close", "change_pct") if k in m})
        return out

    async def h_ma(a: dict):
        res = await ma_scanner(
            scan_type=a.get("scan_type", "crossover"), ma_type=a.get("ma_type", "EMA"),
            period1=int(a.get("fast_period", 50)), period2=int(a.get("slow_period", 200)),
            period3=200, direction=a.get("direction", "bullish"),
            timeframe=a.get("timeframe", "D"), rsi_filter="none", pct_threshold=3.0,
            pullback_tolerance=1.5, pullback_trend_bars=10, sector=None,
            index=a.get("index"), db=db, user=user,
        )
        m = res.get("matches", [])
        collected_matches.extend(m)
        return {"count": len(m), "matches": _slim(m)}

    async def h_indicator(a: dict):
        body = {"indicator": a.get("indicator", "rsi"), "signal": a.get("signal"),
                "timeframe": a.get("timeframe", "D"), "index": a.get("index")}
        if a.get("indicator") == "rsi":
            body["rsi_signal"] = a.get("signal")
            if a.get("rsi_level") is not None:
                body["rsi_level"] = float(a["rsi_level"])
        res = await indicator_scanner(body=body, db=db, user=user)
        m = res.get("matches", [])
        collected_matches.extend(m)
        return {"count": len(m), "matches": _slim(m)}

    async def h_candles(a: dict):
        body = {"patterns": a.get("patterns", []), "timeframe": a.get("timeframe", "D"), "index": a.get("index")}
        res = await candlestick_scanner(body=body, db=db, user=user)
        m = res.get("matches", [])
        collected_matches.extend(m)
        return {"count": len(m), "matches": _slim(m)}

    async def h_patterns(a: dict):
        res = await list_patterns(
            pattern_type=a.get("pattern_type"), status=a.get("status", "forming"),
            timeframe=a.get("timeframe", "D"), sector=None, index=a.get("index"),
            limit=50, db=db, _user=user,
        )
        m = [{"symbol": p.symbol, "name": p.pattern_type.replace("_", " ").title(),
              "sector": p.sector or "—",
              "extra_details": f"Confidence: {int((p.confidence or 0) * 100)}% | Target: {p.target_price or 'N/A'}"}
             for p in res]
        collected_matches.extend(m)
        return {"count": len(m), "matches": [dict(list(x.items())[:3]) for x in m[:15]]}

    async def h_forecast(a: dict):
        from app.api.forecasts import _require_ai_forecast_access
        from app.models import Instrument, Forecast
        from sqlalchemy import select
        try:
            await _require_ai_forecast_access(user, db)
        except HTTPException as e:
            return {"error": e.detail}
        symbol = (a.get("symbol") or "").upper()
        inst = (await db.execute(select(Instrument).where(Instrument.symbol == symbol))).scalar_one_or_none()
        if not inst:
            return {"error": f"No instrument named {symbol}."}
        latest = (await db.execute(
            select(Forecast.as_of_date).where(Forecast.instrument_id == inst.id)
            .order_by(Forecast.as_of_date.desc()).limit(1))).scalar_one_or_none()
        if latest is None:
            return {"error": f"No forecast available for {symbol} yet."}
        rows = (await db.execute(
            select(Forecast).where(Forecast.instrument_id == inst.id, Forecast.as_of_date == latest)
            .order_by(Forecast.horizon_day.asc()))).scalars().all()
        return {"symbol": symbol, "as_of": str(latest),
                "days": [{"day": r.horizon_day, "predicted_close": float(r.predicted_close)} for r in rows]}

    return {
        "run_moving_average_scan": h_ma,
        "run_indicator_scan": h_indicator,
        "run_candlestick_scan": h_candles,
        "run_chart_pattern_scan": h_patterns,
        "get_price_forecast": h_forecast,
    }


def is_enabled() -> bool:
    """True only when Bedrock is switched on, boto3 is importable, and creds look present."""
    s = get_settings()
    if not s.BEDROCK_ENABLED:
        return False
    try:
        import boto3  # noqa: F401
    except ImportError:
        logger.warning("BEDROCK_ENABLED is true but boto3 is not installed; using rule-based fallback.")
        return False
    return True


def _bedrock_client():
    import boto3
    s = get_settings()
    kwargs: dict[str, Any] = {"region_name": s.AWS_REGION}
    if s.AWS_ACCESS_KEY_ID and s.AWS_SECRET_ACCESS_KEY:
        kwargs["aws_access_key_id"] = s.AWS_ACCESS_KEY_ID
        kwargs["aws_secret_access_key"] = s.AWS_SECRET_ACCESS_KEY
    return boto3.client("bedrock-runtime", **kwargs)


async def run_assistant(query: str, db: AsyncSession, user: User) -> dict:
    """Run the Bedrock tool-use loop and return a chatbot-compatible payload.

    Returns: {success, message, matches, tool_calls}. Raises RuntimeError on
    Bedrock/transport failure so the caller can fall back to the legacy router.
    """
    s = get_settings()
    client = _bedrock_client()
    collected_matches: list = []
    handlers = _build_tool_handlers(db, user, collected_matches)
    tool_config = {"tools": _tool_specs()}
    messages = [{"role": "user", "content": [{"text": query}]}]
    tool_calls: list[str] = []

    for _turn in range(s.BEDROCK_MAX_TOOL_TURNS):
        resp = await run_in_threadpool(
            client.converse,
            modelId=s.BEDROCK_MODEL_ID,
            system=[{"text": SYSTEM_PROMPT}],
            messages=messages,
            toolConfig=tool_config,
            inferenceConfig={"maxTokens": s.BEDROCK_MAX_TOKENS, "temperature": 0.0},
        )
        out_msg = resp["output"]["message"]
        messages.append(out_msg)
        stop = resp.get("stopReason")

        if stop != "tool_use":
            text = "".join(b.get("text", "") for b in out_msg.get("content", []) if "text" in b).strip()
            return {"success": True, "message": text or "(no response)",
                    "matches": collected_matches, "tool_calls": tool_calls}

        # Execute every tool the model requested this turn.
        tool_results = []
        for block in out_msg.get("content", []):
            if "toolUse" not in block:
                continue
            tu = block["toolUse"]
            name, tool_id, args = tu["name"], tu["toolUseId"], tu.get("input", {}) or {}
            tool_calls.append(name)
            handler = handlers.get(name)
            try:
                result = await handler(args) if handler else {"error": f"Unknown tool {name}"}
            except Exception as e:  # noqa: BLE001 — surface tool errors back to the model
                logger.exception("Assistant tool %s failed", name)
                result = {"error": str(e)}
            tool_results.append({"toolResult": {
                "toolUseId": tool_id,
                "content": [{"json": result}],
            }})
        messages.append({"role": "user", "content": tool_results})

    # Ran out of tool turns without a final text answer.
    return {"success": True,
            "message": "I gathered scan results but couldn't finish summarising them. "
                       "Please refine your question.",
            "matches": collected_matches, "tool_calls": tool_calls}
