from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.auth import get_current_user
from app.models import User, Instrument, Forecast
from app.schemas import ForecastOut, ForecastDay
from pydantic import BaseModel
import re
import logging
from typing import Optional, List, Dict, Any

from app.api.scans import ma_scanner, indicator_scanner, candlestick_scanner
from app.api.screener import list_patterns

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chatbot", tags=["chatbot"])

class ChatbotRequest(BaseModel):
    query: str

class ChatbotResponse(BaseModel):
    success: bool
    query: str
    intent: Optional[Dict[str, Any]] = None
    matches: List[Dict[str, Any]] = []
    message: str
    forecast: Optional[ForecastOut] = None

def parse_query(query: str) -> Dict[str, Any]:
    """Parse the natural language query into scannable parameters and scan type.
    
    Returns a dictionary:
    {
        "type": "ma" | "indicator" | "candlestick" | "pattern" | None,
        "timeframe": "D" | "W" | "M",
        "index": str | None,
        "sector": str | None,
        "parameters": dict
    }
    """
    q = query.lower().strip()

    # 0. Forecast intent: "forecast SYMBOL", "predict SYMBOL", "forecast for SYMBOL"
    forecast_match = re.search(r'\b(?:forecast|predict)\s+(?:for\s+)?([a-z0-9&\-\.]+)\b', q)
    if forecast_match:
        symbol = forecast_match.group(1).upper()
        return {
            "type": "forecast",
            "timeframe": "D",
            "index": None,
            "sector": None,
            "parameters": {"symbol": symbol}
        }

    # 1. Parse Timeframe (daily/weekly/monthly)
    timeframe = "D"
    if any(word in q for word in ["weekly", "week", " w "]) or q.endswith(" w") or " w " in q:
        timeframe = "W"
    elif any(word in q for word in ["monthly", "month", " m "]) or q.endswith(" m") or " m " in q:
        timeframe = "M"
    elif any(word in q for word in ["daily", "day", " d "]) or q.endswith(" d") or " d " in q:
        timeframe = "D"

    # 2. Parse Index
    index = None
    index_mappings = {
        "nifty_next_50": ["nifty next 50", "next 50", "next50"],
        "nifty_bank": ["nifty bank", "bank nifty", "niftybank", "banknifty", "bank"],
        "nifty_auto": ["nifty auto", "auto"],
        "nifty_cement": ["nifty cement", "cement"],
        "nifty_chemicals": ["nifty chemicals", "chemical", "chemicals"],
        "nifty_fin_services": ["nifty financial", "financial services", "nifty finance", "finance"],
        "nifty_fmcg": ["nifty fmcg", "fmcg"],
        "nifty_it": ["nifty it", "it index", "information technology"],
        "nifty_media": ["nifty media", "media"],
        "nifty_metal": ["nifty metal", "metal index", "metals index"],
        "nifty_pharma": ["nifty pharma", "pharma"],
        "nifty_psu_bank": ["nifty psu bank", "psu bank", "psubank", "psu"],
        "nifty_pvt_bank": ["nifty private bank", "private bank", "pvt bank"],
        "nifty_realty": ["nifty realty", "realty", "real estate"],
        "nifty_100": ["nifty 100", "nifty100"],
        "nifty_200": ["nifty 200", "nifty200"],
        "nifty_500": ["nifty 500", "nifty500"],
        "nifty_midcap_50": ["nifty midcap 50", "midcap 50", "midcap50"],
        "nifty_midcap_100": ["nifty midcap 100", "midcap 100", "midcap100"],
        "nifty_smallcap_50": ["nifty smallcap 50", "smallcap 50", "smallcap50"],
        "nifty_smallcap_100": ["nifty smallcap 100", "smallcap 100", "smallcap100"],
        "nifty_midsmall_400": ["nifty midsmall 400", "midsmall 400", "midsmall400"],
        "nifty_50": ["nifty 50", "nifty50", "nifty"],
        "mcx_icomdex": ["mcx icomdex", "icomdex", "bulldex", "metldex"],
        "bullion": ["bullion", "gold", "silver"],
        "base_metals": ["base metals", "base metal", "copper", "zinc", "aluminium", "lead"],
        "energy": ["energy", "crude", "natural gas"],
        "agri": ["agri", "cotton", "kapas"],
        "forex": ["forex", "currencies", "usd", "inr", "currency pairs"]
    }
    
    for idx_sym, keywords in index_mappings.items():
        if any(kw in q for kw in keywords):
            index = idx_sym.upper()
            break

    # 3. Detect Intent and Parameters
    intent_type = None
    params = {}

    # Case A: Moving Average (MA) Scans
    # Keywords: crossover, above, below, golden crossover, death cross, sma, ema
    is_ma = any(word in q for word in ["crossover", "cross", "above", "below", "ma", "sma", "ema", "golden", "death"])
    has_ind_term = any(word in q for word in ["rsi", "rai", "rsy", "macd", "supertrend"])
    
    if is_ma and not has_ind_term:
        intent_type = "ma"
        # Extract numbers (periods)
        numbers = [int(n) for n in re.findall(r'\b\d+\b', q)]
        
        # Golden Crossover / Death Cross
        if "golden" in q:
            params = {
                "scan_type": "crossover",
                "ma_type": "EMA",
                "period1": 50,
                "period2": 200,
                "direction": "bullish"
            }
        elif "death" in q:
            params = {
                "scan_type": "crossover",
                "ma_type": "EMA",
                "period1": 50,
                "period2": 200,
                "direction": "bearish"
            }
        elif "crossover" in q or "cross" in q:
            p1 = numbers[0] if len(numbers) > 0 else 20
            p2 = numbers[1] if len(numbers) > 1 else 50
            direction = "bearish" if "bearish" in q or "down" in q or "below" in q else "bullish"
            ma_type = "SMA" if "sma" in q else "EMA"
            params = {
                "scan_type": "crossover",
                "ma_type": ma_type,
                "period1": p1,
                "period2": p2,
                "direction": direction
            }
        elif "above" in q or "over" in q:
            p1 = numbers[0] if len(numbers) > 0 else 50
            ma_type = "SMA" if "sma" in q else "EMA"
            params = {
                "scan_type": "price_above",
                "ma_type": ma_type,
                "period1": p1,
                "direction": "bullish"
            }
        elif "below" in q or "under" in q:
            p1 = numbers[0] if len(numbers) > 0 else 50
            ma_type = "SMA" if "sma" in q else "EMA"
            params = {
                "scan_type": "price_above",
                "ma_type": ma_type,
                "period1": p1,
                "direction": "bearish"
            }
        else:
            # Fallback MA scan
            params = {
                "scan_type": "price_above",
                "ma_type": "EMA",
                "period1": 50,
                "direction": "bullish"
            }
            
    # Case B: Indicator Scans (RSI, Supertrend, MACD)
    # Keywords: rsi, rai, rsy, supertrend, macd, oversold, overbought, buy, sell, touch, range
    is_ind = any(word in q for word in ["rsi", "rai", "rsy", "supertrend", "macd", "oversold", "overbought", "buy", "sell", "touch", "range"])
    if is_ind and not intent_type:
        intent_type = "indicator"
        if any(w in q for w in ["rsi", "rai", "rsy"]):
            range_match = re.search(r'(\d+)\s*(?:-|to|and)\s*(\d+)', q)
            if "range" in q or range_match:
                low_val = float(range_match.group(1)) if range_match else 30.0
                high_val = float(range_match.group(2)) if range_match else 70.0
                if low_val > high_val:
                    low_val, high_val = high_val, low_val
                params = {
                    "indicator": "rsi",
                    "signal": "range",
                    "rsi_signal": "range",
                    "rsi_min": low_val,
                    "rsi_max": high_val
                }
            else:
                signal = "below_level"
                rsi_level = 30.0
                if "oversold" in q or "below 30" in q:
                    signal = "below_level"
                    rsi_level = 30.0
                elif "overbought" in q or "above 70" in q:
                    signal = "above_level"
                    rsi_level = 70.0
                elif "above" in q or "over" in q:
                    levels = [int(n) for n in re.findall(r'\b\d+\b', q)]
                    rsi_level = levels[0] if levels else 50.0
                    signal = "above_level"
                elif "below" in q or "under" in q:
                    levels = [int(n) for n in re.findall(r'\b\d+\b', q)]
                    rsi_level = levels[0] if levels else 50.0
                    signal = "below_level"
                
                params = {
                    "indicator": "rsi",
                    "signal": signal,
                    "rsi_signal": signal,
                    "rsi_level": rsi_level
                }
        elif "supertrend" in q:
            signal = "buy"
            if "sell" in q or "red" in q:
                signal = "sell"
            elif "touch" in q or "support" in q:
                signal = "touch"
            params = {
                "indicator": "supertrend",
                "signal": signal
            }
        elif "macd" in q:
            signal = "bullish_crossover"
            if "bear" in q or "sell" in q or "down" in q:
                signal = "bearish_crossover"
            params = {
                "indicator": "macd",
                "signal": signal
            }

    # Case C: Candlestick Pattern Scans
    # Keywords: doji, hammer, engulfing, morning star, shooting star, marubozu
    candlestick_patterns = {
        "doji": ["doji", "dojis"],
        "hammer": ["hammer", "hammers"],
        "engulfing": ["engulfing", "engulfing bullish", "engulfing bearish"],
        "morning_star": ["morning star", "morningstar"],
        "shooting_star": ["shooting star", "shootingstar"],
        "marubozu": ["marubozu"]
    }
    
    matched_candles = []
    for pat_sym, keywords in candlestick_patterns.items():
        if any(kw in q for kw in keywords):
            matched_candles.append(pat_sym)
            
    if matched_candles and not intent_type:
        intent_type = "candlestick"
        params = {
            "patterns": matched_candles
        }

    # Case D: Chart Pattern Screener
    # Keywords: double bottom, double top, head and shoulders, flag, wedge, triangle
    chart_patterns = {
        "double_bottom": ["double bottom", "w pattern", "doublebottom"],
        "double_top": ["double top", "m pattern", "doubletop"],
        "head_shoulders": ["head and shoulders", "head & shoulders", "head_shoulders"],
        "inv_head_shoulders": ["inverse head", "inv head", "inverse head & shoulders"],
        "bull_flag": ["bull flag", "bullish flag"],
        "bear_flag": ["bear flag", "bearish flag"],
        "rising_wedge": ["rising wedge"],
        "falling_wedge": ["falling wedge"],
        "asc_triangle": ["ascending triangle"],
        "desc_triangle": ["descending triangle"],
        "sym_triangle": ["symmetrical triangle"]
    }
    
    matched_pattern = None
    for pat_sym, keywords in chart_patterns.items():
        if any(kw in q for kw in keywords):
            matched_pattern = pat_sym
            break
            
    if matched_pattern and not intent_type:
        intent_type = "pattern"
        status = "forming" if "forming" in q or "developing" in q else "completed"
        params = {
            "pattern_type": matched_pattern,
            "status": status
        }

    return {
        "type": intent_type,
        "timeframe": timeframe,
        "index": index,
        "sector": None, # For simplicity, indices are primary scannable groups
        "parameters": params
    }


# ── Smart Composite Scan ──────────────────────────────────────
# Decomposes complex natural-language queries into concept primitives —
# fundamental filters (SQL over the fundamentals table) plus technical
# conditions (computed per stock) — then ANDs them, scores each candidate,
# and returns a ranked list with per-stock reasons.

SMART_CONCEPTS = {
    # ── fundamental concepts (applied as SQL filters) ──
    "quality":    {"kind": "fund", "label": "Strong fundamentals (ROE ≥ 15%, D/E ≤ 1, margin ≥ 8%)",
                   "phrases": ["fundamental", "fundamentally strong", "quality stock", "good company", "best stock", "strong balance sheet", "blue chip", "bluechip"]},
    "value":      {"kind": "fund", "label": "Value pricing (P/E ≤ 20, P/B ≤ 3)",
                   "phrases": ["undervalued", "value stock", "cheap stock", "low pe", "low p/e", "attractive valuation"]},
    "dividend":   {"kind": "fund", "label": "Dividend payer (yield ≥ 1.5%)",
                   "phrases": ["dividend"]},
    "growth":     {"kind": "fund", "label": "Growing business (revenue ≥ 10% or earnings ≥ 15% YoY)",
                   "phrases": ["growth stock", "growing", "high growth", "fast growing"]},
    "largecap":   {"kind": "fund", "label": "Large cap (mcap ≥ ₹50,000 cr)",
                   "phrases": ["large cap", "largecap", "big company", "large-cap"]},
    "midcap":     {"kind": "fund", "label": "Mid cap",
                   "phrases": ["mid cap", "midcap stock", "mid-cap"]},
    "smallcap":   {"kind": "fund", "label": "Small cap",
                   "phrases": ["small cap", "smallcap stock", "small-cap"]},
    "promoter":   {"kind": "fund", "label": "High promoter holding (≥ 50%)",
                   "phrases": ["promoter holding", "promoter owned", "skin in the game"]},
    # ── technical concepts (computed on the price series) ──
    "correction": {"kind": "tech", "label": "In correction (10–40% below 52-week high)",
                   "phrases": ["correction", "corrected", "after a fall", "beaten down", "pulled back", "pullback", "big fall", "fallen", "dip", "discount to high"]},
    "reversal":   {"kind": "tech", "label": "Reversal signs (≥2 of: RSI turning up, above EMA20, higher low, rising closes)",
                   "phrases": ["reversing", "reversal", "turning around", "turnaround", "bouncing", "bounce back", "rebound", "recovering", "recovery", "bottoming", "bottomed out"]},
    "oversold":   {"kind": "tech", "label": "Oversold (RSI < 32)",
                   "phrases": ["oversold"]},
    "breakout":   {"kind": "tech", "label": "Breaking out (close above 20-day high)",
                   "phrases": ["breaking out", "breakout", "broke out", "new high", "all time high", "52 week high stocks"]},
    "uptrend":    {"kind": "tech", "label": "Established uptrend (close > SMA50 > SMA200)",
                   "phrases": ["uptrend", "in an uptrend", "trending up", "strong trend", "bullish trend"]},
    "momentum":   {"kind": "tech", "label": "Positive momentum (≥ 5% in 20 sessions)",
                   "phrases": ["momentum", "gaining", "rallying", "outperforming"]},
    "volsurge":   {"kind": "tech", "label": "Volume surge (last volume > 1.5× 20-day avg)",
                   "phrases": ["volume surge", "high volume", "volume spike", "heavy volume", "accumulation"]},
    "near_low":   {"kind": "tech", "label": "Near 52-week low (within 10%)",
                   "phrases": ["52 week low", "near low", "yearly low"]},
}


def extract_smart_concepts(q: str) -> list:
    """Return the list of concept ids whose phrases appear in the query."""
    found = []
    for cid, spec in SMART_CONCEPTS.items():
        if any(p in q for p in spec["phrases"]):
            found.append(cid)
    return found


def _tech_checks(df, concepts: set) -> tuple:
    """Evaluate technical concepts on a daily OHLCV DataFrame.
    Returns (all_matched: bool, reasons: list, score: float)."""
    import pandas as pd  # noqa: F401 (df is already pandas)
    close = df["close"]; high = df["high"]; low = df["low"]; vol = df["volume"]
    n = len(df)
    reasons, score = [], 0.0

    # RSI(14)
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, 1e-9)
    rsi = 100 - (100 / (1 + rs))

    def ok(cid):
        if cid == "correction":
            hi52 = high.iloc[-252:].max() if n >= 60 else high.max()
            dd = (hi52 - close.iloc[-1]) / hi52 * 100
            return (10 <= dd <= 40, dd)
        if cid == "reversal":
            sigs = 0
            if n >= 25:
                r_now, r_then = rsi.iloc[-1], rsi.iloc[-6]
                if not (pd.isna(r_now) or pd.isna(r_then)):
                    if r_now > r_then and rsi.iloc[-11:].min() < 45:
                        sigs += 1
                ema20 = close.ewm(span=20, adjust=False).mean()
                if close.iloc[-1] > ema20.iloc[-1]:
                    sigs += 1
                if close.iloc[-1] > close.iloc[-6]:
                    sigs += 1
                if low.iloc[-5:].min() > low.iloc[-10:-5].min():
                    sigs += 1
            return (sigs >= 2, sigs)
        if cid == "oversold":
            return (not pd.isna(rsi.iloc[-1]) and rsi.iloc[-1] < 32, rsi.iloc[-1])
        if cid == "breakout":
            return (n >= 22 and close.iloc[-1] >= high.iloc[-21:-1].max(), None)
        if cid == "uptrend":
            if n < 200: return (False, None)
            s50 = close.rolling(50).mean().iloc[-1]; s200 = close.rolling(200).mean().iloc[-1]
            return (close.iloc[-1] > s50 > s200, None)
        if cid == "momentum":
            return (n >= 21 and (close.iloc[-1] / close.iloc[-21] - 1) * 100 >= 5, None)
        if cid == "volsurge":
            avg = vol.iloc[-21:-1].mean()
            return (avg > 0 and vol.iloc[-1] > 1.5 * avg, None)
        if cid == "near_low":
            lo52 = low.iloc[-252:].min() if n >= 60 else low.min()
            return (lo52 > 0 and (close.iloc[-1] - lo52) / lo52 * 100 <= 10, None)
        return (True, None)

    for cid in concepts:
        matched, detail = ok(cid)
        if not matched:
            return (False, [], 0.0)
        score += 10
        if cid == "reversal" and detail:
            score += detail  # more reversal signals = higher rank
            reasons.append(f"reversal signals {int(detail)}/4")
        elif cid == "correction" and detail is not None:
            reasons.append(f"{detail:.0f}% off 52w high")
        elif cid == "oversold" and detail is not None:
            reasons.append(f"RSI {detail:.0f}")
        else:
            reasons.append(SMART_CONCEPTS[cid]["label"].split(" (")[0].lower())
    return (True, reasons, score)


async def run_smart_scan(db, concepts: list, index: Optional[str], limit: int = 20) -> dict:
    """Execute a composite fundamental + technical scan for the given concepts."""
    from app.models import Instrument, Fundamentals, IndexConstituent
    from app.api.scans import _load_df

    fund_ids = [c for c in concepts if SMART_CONCEPTS[c]["kind"] == "fund"]
    tech_ids = {c for c in concepts if SMART_CONCEPTS[c]["kind"] == "tech"}

    stmt = select(Instrument, Fundamentals).outerjoin(
        Fundamentals, Fundamentals.instrument_id == Instrument.id
    ).where(Instrument.is_active == True, Instrument.segment == "EQ")

    if index:
        stmt = stmt.where(Instrument.id.in_(
            select(IndexConstituent.instrument_id).join(
                Instrument, Instrument.id == IndexConstituent.index_id
            ).where((Instrument.symbol == index) | (Instrument.name == index))
        ))

    # Fundamental filters in SQL
    F = Fundamentals
    if "quality" in fund_ids:
        stmt = stmt.where(F.roe >= 15, F.debt_to_equity <= 1.0, F.profit_margin >= 8)
    if "value" in fund_ids:
        stmt = stmt.where(F.pe > 0, F.pe <= 20, F.pb <= 3)
    if "dividend" in fund_ids:
        stmt = stmt.where(F.dividend_yield >= 1.5)
    if "growth" in fund_ids:
        from sqlalchemy import or_
        stmt = stmt.where(or_(F.revenue_growth >= 10, F.earnings_growth >= 15))
    if "largecap" in fund_ids:
        stmt = stmt.where(F.market_cap >= 5e11)
    if "midcap" in fund_ids:
        stmt = stmt.where(F.market_cap >= 1e11, F.market_cap < 5e11)
    if "smallcap" in fund_ids:
        stmt = stmt.where(F.market_cap < 1e11, F.market_cap > 0)
    if "promoter" in fund_ids:
        stmt = stmt.where(F.promoter_holding >= 50)

    rows = (await db.execute(stmt.limit(400))).all()

    scored = []
    for instr, fund in rows:
        df = await _load_df(db, instr.id, "D")
        if df is None or len(df) < 30:
            continue
        matched, reasons, score = _tech_checks(df, tech_ids)
        if not matched:
            continue
        # quality bonus keeps genuinely better companies at the top of ties
        if fund is not None and fund.roe is not None:
            score += min(float(fund.roe), 40) / 10
        prev = float(df.iloc[-2]["close"]) if len(df) > 1 else float(df.iloc[-1]["close"])
        last = float(df.iloc[-1]["close"])
        scored.append({
            "symbol": instr.symbol,
            "name": instr.name,
            "sector": instr.sector or "—",
            "close": last,
            "change_pct": round((last - prev) / prev * 100, 2) if prev else 0.0,
            "score": round(score, 1),
            "reasons": reasons,
            "roe": float(fund.roe) if fund is not None and fund.roe is not None else None,
        })

    scored.sort(key=lambda m: m["score"], reverse=True)
    return {"matches": scored[:limit], "total": len(scored)}


@router.post("/query", response_model=ChatbotResponse)
async def chatbot_query(
    request: ChatbotRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = request.query
    logger.info(f"Received chatbot query: {query}")

    # AI path (Claude via Bedrock) — enabled by settings + creds; otherwise fall
    # through to the deterministic rule-based router below. Any Bedrock/transport
    # failure also falls back, so the assistant is never fully down.
    from app.services import bedrock_assistant
    if bedrock_assistant.is_enabled():
        try:
            ai = await bedrock_assistant.run_assistant(query, db, user)
            return ChatbotResponse(
                success=ai["success"],
                query=query,
                intent={"type": "ai", "tools": ai.get("tool_calls", [])},
                matches=ai.get("matches", []),
                message=ai["message"],
            )
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("Bedrock assistant failed (%s); falling back to rule-based router.", e)

    parsed = parse_query(query)
    intent_type = parsed["type"]
    timeframe = parsed["timeframe"]
    index = parsed["index"]
    params = parsed["parameters"]

    # ── Smart composite path ──
    # Complex multi-concept queries ("best fundamental stock reversing after a
    # correction") are decomposed into fundamental + technical criteria and run
    # as one ranked scan. Used when the query mixes concepts the single-intent
    # parser can't express: any fundamental concept, or 2+ concepts, or the
    # correction/reversal ideas on their own.
    if intent_type != "forecast":
        q_lower = query.lower().strip()
        concepts = extract_smart_concepts(q_lower)
        has_fund = any(SMART_CONCEPTS[c]["kind"] == "fund" for c in concepts)
        if has_fund or len(concepts) >= 2 or any(c in ("correction", "reversal") for c in concepts):
            try:
                result = await run_smart_scan(db, concepts, index)
                criteria_text = "\n".join(
                    f"• {SMART_CONCEPTS[c]['label']}" for c in concepts
                )
                top = result["matches"][:5]
                why_lines = "\n".join(
                    f"**{m['symbol']}**" + (f" (ROE {m['roe']:.0f}%)" if m.get("roe") else "") +
                    f" — {', '.join(m['reasons'])}" for m in top
                )
                if result["matches"]:
                    message = (
                        f"🧠 I read your query as **{len(concepts)} combined criteria**:\n{criteria_text}\n\n"
                        f"Found **{result['total']}** stocks matching all of them"
                        f"{' in ' + index.replace('_', ' ') if index else ''}, ranked by fit. Top picks:\n{why_lines}"
                    )
                else:
                    message = (
                        f"🧠 I read your query as **{len(concepts)} combined criteria**:\n{criteria_text}\n\n"
                        "No stock currently matches all of them at once — that usually means the "
                        "combination is strict, not that nothing is close. Try dropping one criterion "
                        "(e.g. remove the index filter or the strictest condition) and ask again."
                    )
                if result["matches"]:
                    from app.services import scan_history
                    await scan_history.record(
                        user.id, "assistant",
                        {"query": query, "concepts": concepts, "index": index},
                        result["matches"],
                    )
                return ChatbotResponse(
                    success=bool(result["matches"]),
                    query=query,
                    intent={"type": "smart_composite", "timeframe": "D", "index": index,
                            "parameters": {"concepts": concepts}},
                    matches=result["matches"],
                    message=message,
                )
            except Exception as e:
                logger.warning("Smart composite scan failed (%s); falling back to single-intent router.", e)

    # Validate timeframe access based on user subscription
    if timeframe and intent_type != "forecast":
        from app.services.subscription_validator import validate_timeframe_access
        await validate_timeframe_access(user, timeframe, db)

    tf_label = "Daily" if timeframe == "D" else ("Weekly" if timeframe == "W" else "Monthly")
    index_label = f"'{index.replace('_', ' ')}'" if index else "all scannable instruments"

    if not intent_type:
        # Guidance response when no intent is matched
        guide_msg = (
            "I couldn't identify a scan in your query. I can help you run scans for "
            "Moving Averages, Indicators (RSI, Supertrend), Candlesticks, or Chart Patterns — "
            "and I understand combined questions too. Try one of these:\n\n"
            "🧠 *Combined*: 'best fundamental stock reversing after a correction' or "
            "'undervalued dividend stocks in an uptrend'\n"
            "📈 *Moving Average*: 'golden crossover in Nifty 50' or 'close above 200 ema daily'\n"
            "🕯️ *Candlestick*: 'scan for doji in Bank Nifty daily' or 'find hammer in Bullion'\n"
            "🔮 *Chart Pattern*: 'double bottom in Base Metals weekly' or 'bull flag in Nifty 500'\n"
            "📉 *Indicator*: 'RSI oversold in Nifty 200' or 'supertrend buy in Agri daily'"
        )
        return ChatbotResponse(
            success=False,
            query=query,
            intent=None,
            matches=[],
            message=guide_msg
        )
        
    try:
        matches = []
        message = ""
        forecast_out = None

        # 0. Forecast Intent
        if intent_type == "forecast":
            from app.api.forecasts import _require_ai_forecast_access
            try:
                await _require_ai_forecast_access(user, db)
            except HTTPException as e:
                return ChatbotResponse(
                    success=False,
                    query=query,
                    intent={"type": intent_type, "timeframe": timeframe, "index": index, "parameters": params},
                    matches=[],
                    message=e.detail,
                    forecast=None,
                )

            symbol = params["symbol"]
            inst_q = await db.execute(select(Instrument).where(Instrument.symbol == symbol))
            instrument = inst_q.scalar_one_or_none()

            if not instrument:
                message = f"I couldn't find an instrument with symbol **{symbol}**. Please check the symbol and try again."
                return ChatbotResponse(
                    success=False,
                    query=query,
                    intent={"type": intent_type, "timeframe": timeframe, "index": index, "parameters": params},
                    matches=[],
                    message=message,
                    forecast=None
                )

            latest_date_q = await db.execute(
                select(Forecast.as_of_date)
                .where(Forecast.instrument_id == instrument.id)
                .order_by(Forecast.as_of_date.desc())
                .limit(1)
            )
            latest_date = latest_date_q.scalar_one_or_none()

            if latest_date is None:
                message = (
                    f"No forecast available for **{symbol}** yet — its model needs at least "
                    f"60 days of price history."
                )
                return ChatbotResponse(
                    success=False,
                    query=query,
                    intent={"type": intent_type, "timeframe": timeframe, "index": index, "parameters": params},
                    matches=[],
                    message=message,
                    forecast=None
                )

            rows_q = await db.execute(
                select(Forecast)
                .where(Forecast.instrument_id == instrument.id, Forecast.as_of_date == latest_date)
                .order_by(Forecast.horizon_day.asc())
            )
            rows = rows_q.scalars().all()
            is_stale = (date.today() - latest_date) > timedelta(days=1)

            forecast_out = ForecastOut(
                symbol=instrument.symbol,
                as_of_date=latest_date,
                model_version=rows[0].model_version if rows else "unknown",
                is_stale=is_stale,
                days=[
                    ForecastDay(
                        horizon_day=r.horizon_day,
                        predicted_close=float(r.predicted_close),
                        lower_band=float(r.lower_band),
                        upper_band=float(r.upper_band),
                    )
                    for r in rows
                ],
            )

            if forecast_out.days:
                first_day = forecast_out.days[0]
                last_day = forecast_out.days[-1]
                message = (
                    f"{symbol} forecast: ₹{first_day.predicted_close:,.2f} → "
                    f"₹{last_day.predicted_close:,.2f} over the next {len(forecast_out.days)} days"
                    f"{' (stale model)' if is_stale else ''}."
                )
            else:
                message = f"Forecast data for **{symbol}** is currently empty."

            return ChatbotResponse(
                success=True,
                query=query,
                intent={"type": intent_type, "timeframe": timeframe, "index": index, "parameters": params},
                matches=[],
                message=message,
                forecast=forecast_out
            )

        # 1. Moving Average Scan
        if intent_type == "ma":
            scan_type = params["scan_type"]
            ma_type = params["ma_type"]
            period1 = params["period1"]
            period2 = params.get("period2", 50)
            direction = params["direction"]
            
            # Execute scan
            scan_res = await ma_scanner(
                scan_type=scan_type,
                ma_type=ma_type,
                period1=period1,
                period2=period2,
                period3=200,
                direction=direction,
                timeframe=timeframe,
                rsi_filter="none",
                pct_threshold=3.0,
                pullback_tolerance=1.5,
                pullback_trend_bars=10,
                sector=None,
                index=index,
                db=db,
                user=user
            )
            matches = scan_res.get("matches", [])
            
            if scan_type == "crossover":
                desc = "Golden Crossover" if period1 == 50 and period2 == 200 and direction == "bullish" else f"{ma_type} {period1}/{period2} Crossover"
            else:
                desc = f"Price above {period1} {ma_type}" if direction == "bullish" else f"Price below {period1} {ma_type}"
                
            message = f"Scanned for **{desc}** in **{index_label}** on a **{tf_label}** timeframe. Found **{len(matches)}** matching instruments."

        # 2. Indicator Scan
        elif intent_type == "indicator":
            indicator = params["indicator"]
            signal = params["signal"]
            
            body = {
                "indicator": indicator,
                "signal": signal,
                "timeframe": timeframe,
                "index": index,
                **params
            }
            
            # Execute scan
            scan_res = await indicator_scanner(
                body=body,
                db=db,
                user=user
            )
            matches = scan_res.get("matches", [])
            desc = f"{indicator.upper()} {signal.replace('_', ' ').title()}"
            message = f"Scanned for **{desc}** in **{index_label}** on a **{tf_label}** timeframe. Found **{len(matches)}** matching instruments."

        # 3. Candlestick Scan
        elif intent_type == "candlestick":
            patterns = params["patterns"]
            body = {
                "patterns": patterns,
                "timeframe": timeframe,
                "index": index
            }
            
            # Execute scan
            scan_res = await candlestick_scanner(
                body=body,
                db=db,
                user=user
            )
            matches = scan_res.get("matches", [])
            desc = ", ".join([p.replace("_", " ").title() for p in patterns])
            message = f"Scanned for **{desc}** patterns in **{index_label}** on a **{tf_label}** timeframe. Found **{len(matches)}** matching instruments."

        # 4. Chart Pattern Scan
        elif intent_type == "pattern":
            pattern_type = params["pattern_type"]
            status = params["status"]
            
            # Execute scan
            scan_res = await list_patterns(
                pattern_type=pattern_type,
                status=status,
                timeframe=timeframe,
                sector=None,
                index=index,
                limit=50,
                db=db,
                _user=user
            )
            
            # Convert PatternOut Pydantic models to dicts matching the structure of other matches
            matches = []
            for p in scan_res:
                # Add close price and change_pct if possible or mock for consistency
                matches.append({
                    "symbol": p.symbol,
                    "name": p.pattern_type.replace("_", " ").title(),
                    "sector": p.sector or "—",
                    "close": None, # Will be loaded in detail chart link
                    "change_pct": None,
                    "extra_details": f"Confidence: {int(p.confidence * 100)}% | Target: {p.target_price or 'N/A'}"
                })
                
            desc = f"{pattern_type.replace('_', ' ').title()} ({status.title()})"
            message = f"Scanned for **{desc}** chart patterns in **{index_label}** on a **{tf_label}** timeframe. Found **{len(matches)}** matching instruments."

        if matches:
            from app.services import scan_history
            await scan_history.record(
                user.id, "assistant",
                {"query": query, "intent": intent_type, "index": index},
                matches,
            )

        return ChatbotResponse(
            success=True,
            query=query,
            intent={
                "type": intent_type,
                "timeframe": timeframe,
                "index": index,
                "parameters": params
            },
            matches=matches,
            message=message
        )

    except Exception as e:
        logger.error(f"Error executing scan in chatbot: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"An error occurred while executing the scan: {str(e)}"
        )
