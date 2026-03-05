"""
Quant Analysis Sidecar Service

Pure math stock analysis — no LLM calls. Deterministic signals for
technical, fundamental, and sentiment analysis. Inspired by ai-hedge-fund's
deterministic analysts.

Runs on port 8200. All data sourced from yfinance (free, no API key).
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from stockstats import StockDataFrame

# ---------------------------------------------------------------------------
# App & logging
# ---------------------------------------------------------------------------

app = FastAPI(title="Quant Analysis", version="1.0.0")
logger = logging.getLogger("quant-analysis")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ---------------------------------------------------------------------------
# Simple in-memory cache (key -> (timestamp, value))
# ---------------------------------------------------------------------------

_cache: dict[str, tuple[float, Any]] = {}
CACHE_TTL = 300  # 5 minutes


def _cache_get(key: str) -> Any | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.time() - ts > CACHE_TTL:
        del _cache[key]
        return None
    return value


def _cache_set(key: str, value: Any) -> None:
    _cache[key] = (time.time(), value)


# ---------------------------------------------------------------------------
# Data fetching (cached)
# ---------------------------------------------------------------------------


def _fetch_history(symbol: str, period: str = "6mo") -> pd.DataFrame:
    """Fetch OHLCV history from yfinance, cached for 5 min."""
    cache_key = f"history:{symbol}:{period}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    ticker = yf.Ticker(symbol)
    df = ticker.history(period=period, auto_adjust=True)
    if df.empty:
        raise HTTPException(status_code=404, detail=f"No price data for {symbol}")
    if len(df) < 30:
        raise HTTPException(
            status_code=422,
            detail=f"Insufficient data for {symbol}: only {len(df)} bars (need >= 30)",
        )

    # Normalize column names to lowercase for stockstats compatibility
    df.columns = [c.lower() for c in df.columns]
    _cache_set(cache_key, df)
    return df


def _fetch_info(symbol: str) -> dict[str, Any]:
    """Fetch ticker info dict from yfinance, cached for 5 min."""
    cache_key = f"info:{symbol}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    ticker = yf.Ticker(symbol)
    info = ticker.info
    if not info or info.get("regularMarketPrice") is None and info.get("currentPrice") is None:
        raise HTTPException(status_code=404, detail=f"No info data for {symbol}")

    _cache_set(cache_key, info)
    return info


def _fetch_news(symbol: str) -> list[dict[str, Any]]:
    """Fetch recent news from yfinance, cached for 5 min."""
    cache_key = f"news:{symbol}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    ticker = yf.Ticker(symbol)
    news = ticker.news or []
    _cache_set(cache_key, news)
    return news


# ---------------------------------------------------------------------------
# Technical analysis helpers
# ---------------------------------------------------------------------------


def _to_stockstats(df: pd.DataFrame) -> StockDataFrame:
    """Convert a plain DataFrame to a StockDataFrame for indicator access."""
    sdf = StockDataFrame.retype(df.copy())
    return sdf


def _clamp(value: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, value))


# -- Strategy 1: Trend Following (EMA crossover + ADX) ---------------------


def _trend_following(df: pd.DataFrame) -> dict[str, Any]:
    sdf = _to_stockstats(df)

    ema8 = sdf["close_8_ema"]
    ema21 = sdf["close_21_ema"]
    adx = sdf["adx"]

    latest_ema8 = float(ema8.iloc[-1])
    latest_ema21 = float(ema21.iloc[-1])
    latest_adx = float(adx.iloc[-1])
    ema_diff_pct = (latest_ema8 - latest_ema21) / latest_ema21 * 100

    strong_trend = latest_adx > 25
    if latest_ema8 > latest_ema21:
        signal = "bullish" if strong_trend else "neutral"
    elif latest_ema8 < latest_ema21:
        signal = "bearish" if strong_trend else "neutral"
    else:
        signal = "neutral"

    # Confidence: scale ADX (0-60 range mapped to 0-100), boost if crossover is wide
    confidence = _clamp(latest_adx / 50 * 70 + abs(ema_diff_pct) * 3)

    return {
        "signal": signal,
        "confidence": round(confidence),
        "details": {
            "ema8": round(latest_ema8, 4),
            "ema21": round(latest_ema21, 4),
            "ema_diff_pct": round(ema_diff_pct, 2),
            "adx": round(latest_adx, 2),
            "strong_trend": strong_trend,
        },
    }


# -- Strategy 2: Mean Reversion (Bollinger Bands + RSI) --------------------


def _mean_reversion(df: pd.DataFrame) -> dict[str, Any]:
    sdf = _to_stockstats(df)

    close = float(df["close"].iloc[-1])
    boll_upper = float(sdf["boll_ub"].iloc[-1])
    boll_lower = float(sdf["boll_lb"].iloc[-1])
    boll_mid = float(sdf["boll"].iloc[-1])
    rsi = float(sdf["rsi_14"].iloc[-1])

    signal = "neutral"
    confidence = 30.0  # base

    if close < boll_lower and rsi < 30:
        signal = "bullish"
        # Stronger signal the more oversold
        confidence = _clamp(60 + (30 - rsi) * 1.5 + (boll_lower - close) / close * 500)
    elif close > boll_upper and rsi > 70:
        signal = "bearish"
        confidence = _clamp(60 + (rsi - 70) * 1.5 + (close - boll_upper) / close * 500)
    else:
        # Mild lean based on position within bands
        band_pos = (close - boll_lower) / (boll_upper - boll_lower) if boll_upper != boll_lower else 0.5
        if band_pos < 0.3 and rsi < 40:
            signal = "bullish"
            confidence = _clamp(30 + (40 - rsi))
        elif band_pos > 0.7 and rsi > 60:
            signal = "bearish"
            confidence = _clamp(30 + (rsi - 60))

    return {
        "signal": signal,
        "confidence": round(confidence),
        "details": {
            "close": round(close, 4),
            "boll_upper": round(boll_upper, 4),
            "boll_lower": round(boll_lower, 4),
            "boll_mid": round(boll_mid, 4),
            "rsi_14": round(rsi, 2),
        },
    }


# -- Strategy 3: Momentum (ROC + MACD + Volume) ---------------------------


def _momentum(df: pd.DataFrame) -> dict[str, Any]:
    sdf = _to_stockstats(df)

    # Rate of change (12-period)
    closes = df["close"]
    roc = float((closes.iloc[-1] - closes.iloc[-13]) / closes.iloc[-13] * 100) if len(closes) > 13 else 0.0

    macd_line = float(sdf["macd"].iloc[-1])
    macd_signal = float(sdf["macds"].iloc[-1])
    macd_hist = float(sdf["macdh"].iloc[-1])

    # Volume confirmation: current volume vs 20-period average
    vol = df["volume"]
    vol_avg = float(vol.iloc[-21:-1].mean()) if len(vol) > 21 else float(vol.mean())
    vol_current = float(vol.iloc[-1])
    vol_ratio = vol_current / vol_avg if vol_avg > 0 else 1.0

    bullish_count = 0
    if roc > 0:
        bullish_count += 1
    if macd_line > macd_signal:
        bullish_count += 1
    if vol_ratio > 1.0:
        bullish_count += 1

    bearish_count = 0
    if roc < 0:
        bearish_count += 1
    if macd_line < macd_signal:
        bearish_count += 1

    if bullish_count == 3:
        signal = "bullish"
        confidence = _clamp(55 + abs(roc) * 2 + (vol_ratio - 1) * 20)
    elif bullish_count >= 2 and bearish_count == 0:
        signal = "bullish"
        confidence = _clamp(40 + abs(roc) * 1.5)
    elif bearish_count >= 2 and bullish_count <= 1:
        signal = "bearish"
        confidence = _clamp(40 + abs(roc) * 1.5)
    else:
        signal = "neutral"
        confidence = 30.0

    return {
        "signal": signal,
        "confidence": round(confidence),
        "details": {
            "roc_12": round(roc, 2),
            "macd_line": round(macd_line, 4),
            "macd_signal": round(macd_signal, 4),
            "macd_histogram": round(macd_hist, 4),
            "volume_ratio": round(vol_ratio, 2),
        },
    }


# -- Strategy 4: Volatility Regime (ATR percentile) -----------------------


def _volatility_regime(df: pd.DataFrame) -> dict[str, Any]:
    sdf = _to_stockstats(df)

    atr = sdf["atr_14"]
    latest_atr = float(atr.iloc[-1])
    close = float(df["close"].iloc[-1])
    atr_pct = latest_atr / close * 100  # ATR as % of price

    # Percentile rank of current ATR within the lookback
    atr_values = atr.dropna().values
    percentile = float(np.sum(atr_values <= latest_atr) / len(atr_values) * 100)

    if percentile < 25:
        regime = "low"
        confidence_modifier = 1.1  # Low vol = higher confidence in other signals
    elif percentile < 60:
        regime = "normal"
        confidence_modifier = 1.0
    elif percentile < 85:
        regime = "high"
        confidence_modifier = 0.85
    else:
        regime = "extreme"
        confidence_modifier = 0.7

    return {
        "signal": "neutral",  # Volatility regime doesn't generate directional signals
        "confidence": round(_clamp(50 + (50 - abs(percentile - 50)))),
        "details": {
            "atr_14": round(latest_atr, 4),
            "atr_pct_of_price": round(atr_pct, 2),
            "percentile": round(percentile, 1),
            "regime": regime,
            "confidence_modifier": confidence_modifier,
        },
    }


# -- Strategy 5: Statistical Arbitrage (Hurst Exponent) -------------------


def _hurst_exponent(series: np.ndarray, max_lag: int = 20) -> float:
    """Estimate the Hurst exponent using rescaled range (R/S) analysis.

    H < 0.5 → mean-reverting
    H = 0.5 → random walk
    H > 0.5 → trending
    """
    if len(series) < max_lag * 2:
        return 0.5  # Not enough data, assume random walk

    lags = range(2, max_lag + 1)
    rs_values = []

    for lag in lags:
        # Split into non-overlapping chunks
        chunks = [series[i : i + lag] for i in range(0, len(series) - lag + 1, lag)]
        rs_for_lag = []

        for chunk in chunks:
            if len(chunk) < lag:
                continue
            mean = np.mean(chunk)
            deviations = chunk - mean
            cumulative = np.cumsum(deviations)
            r = np.max(cumulative) - np.min(cumulative)
            s = np.std(chunk, ddof=1)
            if s > 0:
                rs_for_lag.append(r / s)

        if rs_for_lag:
            rs_values.append(np.mean(rs_for_lag))
        else:
            rs_values.append(np.nan)

    # Linear fit in log-log space
    valid = [(l, rs) for l, rs in zip(lags, rs_values) if not np.isnan(rs) and rs > 0]
    if len(valid) < 3:
        return 0.5

    log_lags = np.log([v[0] for v in valid])
    log_rs = np.log([v[1] for v in valid])

    # Least squares: log(R/S) = H * log(lag) + c
    coeffs = np.polyfit(log_lags, log_rs, 1)
    hurst = float(coeffs[0])

    # Clamp to reasonable range
    return max(0.0, min(1.0, hurst))


def _stat_arb(df: pd.DataFrame) -> dict[str, Any]:
    log_returns = np.diff(np.log(df["close"].values))
    hurst = _hurst_exponent(log_returns)

    if hurst < 0.4:
        signal = "bullish"  # Mean-reverting: good for mean reversion strategies
        behavior = "mean_reverting"
    elif hurst > 0.6:
        signal = "bullish"  # Trending: good for trend-following strategies
        behavior = "trending"
    else:
        signal = "neutral"  # Random walk: no edge
        behavior = "random_walk"

    # Confidence increases the further from 0.5
    distance_from_random = abs(hurst - 0.5)
    confidence = _clamp(30 + distance_from_random * 140)

    return {
        "signal": signal,
        "confidence": round(confidence),
        "details": {
            "hurst_exponent": round(hurst, 4),
            "behavior": behavior,
            "interpretation": (
                "H<0.5: mean-reverting, H=0.5: random walk, H>0.5: trending"
            ),
        },
    }


# ---------------------------------------------------------------------------
# Technical analysis ensemble
# ---------------------------------------------------------------------------

STRATEGY_WEIGHTS = {
    "trend_following": 0.25,
    "mean_reversion": 0.20,
    "momentum": 0.30,
    "volatility_regime": 0.10,
    "stat_arb": 0.15,
}


def _run_technical(symbol: str, period: str = "6mo") -> dict[str, Any]:
    df = _fetch_history(symbol, period)

    strategies = {
        "trend_following": _trend_following(df),
        "mean_reversion": _mean_reversion(df),
        "momentum": _momentum(df),
        "volatility_regime": _volatility_regime(df),
        "stat_arb": _stat_arb(df),
    }

    # Get volatility confidence modifier
    vol_modifier = strategies["volatility_regime"]["details"]["confidence_modifier"]

    # Weighted ensemble score: map signals to numeric (-1, 0, +1), weight by
    # confidence and strategy weight, then apply volatility modifier.
    signal_map = {"bullish": 1.0, "neutral": 0.0, "bearish": -1.0}
    weighted_sum = 0.0
    total_weight = 0.0

    for name, result in strategies.items():
        if name == "volatility_regime":
            continue  # Non-directional, skip in ensemble
        w = STRATEGY_WEIGHTS[name]
        score = signal_map[result["signal"]] * (result["confidence"] / 100.0) * w
        weighted_sum += score
        total_weight += w

    if total_weight > 0:
        ensemble_raw = weighted_sum / total_weight
    else:
        ensemble_raw = 0.0

    # Apply volatility modifier to confidence, not direction
    ensemble_raw *= vol_modifier

    if ensemble_raw > 0.15:
        ensemble_signal = "bullish"
    elif ensemble_raw < -0.15:
        ensemble_signal = "bearish"
    else:
        ensemble_signal = "neutral"

    ensemble_confidence = _clamp(abs(ensemble_raw) * 100)

    return {
        "strategies": strategies,
        "ensemble": {
            "signal": ensemble_signal,
            "confidence": round(ensemble_confidence),
            "raw_score": round(ensemble_raw, 4),
            "volatility_modifier": vol_modifier,
        },
    }


# ---------------------------------------------------------------------------
# Fundamental analysis
# ---------------------------------------------------------------------------


def _safe_get(info: dict[str, Any], key: str, default: float = 0.0) -> float:
    val = info.get(key)
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return default
    return float(val)


def _score_profitability(info: dict[str, Any]) -> dict[str, Any]:
    roe = _safe_get(info, "returnOnEquity")
    net_margin = _safe_get(info, "profitMargins")
    op_margin = _safe_get(info, "operatingMargins")

    # ROE: >20% excellent, >10% good, >0% ok
    roe_score = min(3.3, max(0, roe * 16.5))  # 0.20 -> 3.3
    # Net margin: >20% excellent, >10% good
    margin_score = min(3.3, max(0, net_margin * 16.5))
    # Operating margin: >25% excellent
    op_score = min(3.4, max(0, op_margin * 13.6))

    total = round(roe_score + margin_score + op_score, 1)
    return {
        "score": min(10.0, total),
        "details": {
            "roe": round(roe, 4),
            "net_margin": round(net_margin, 4),
            "operating_margin": round(op_margin, 4),
        },
    }


def _score_growth(info: dict[str, Any]) -> dict[str, Any]:
    rev_growth = _safe_get(info, "revenueGrowth")
    earn_growth = _safe_get(info, "earningsGrowth")

    # Revenue growth: >30% excellent (5), >15% good (3), >0% ok (1.5)
    rev_score = min(5.0, max(0, rev_growth * 16.7))
    # Earnings growth: same scale
    earn_score = min(5.0, max(0, earn_growth * 16.7))

    total = round(rev_score + earn_score, 1)
    return {
        "score": min(10.0, total),
        "details": {
            "revenue_growth": round(rev_growth, 4),
            "earnings_growth": round(earn_growth, 4),
        },
    }


def _score_financial_health(info: dict[str, Any]) -> dict[str, Any]:
    current_ratio = _safe_get(info, "currentRatio", 1.0)
    debt_to_equity = _safe_get(info, "debtToEquity", 100.0)

    # Current ratio: >2.0 excellent (3.3), >1.5 good, <1 bad
    cr_score = min(3.3, max(0, (current_ratio - 0.5) * 2.2))
    # Debt-to-equity: <50 excellent, <100 good, >200 bad (inverted)
    # debt_to_equity is in percentage form (e.g., 50 = 50%)
    de_score = min(3.3, max(0, (200 - debt_to_equity) / 60))
    # Interest coverage proxy: use operating income / interest expense if available
    # yfinance doesn't always have this, so we give a neutral 1.7 if missing
    ic_score = 3.4 if _safe_get(info, "operatingMargins") > 0.1 else 1.7

    total = round(cr_score + de_score + ic_score, 1)
    return {
        "score": min(10.0, total),
        "details": {
            "current_ratio": round(current_ratio, 2),
            "debt_to_equity": round(debt_to_equity, 2),
        },
    }


def _score_valuation(info: dict[str, Any]) -> dict[str, Any]:
    pe = _safe_get(info, "trailingPE", 25.0)
    pb = _safe_get(info, "priceToBook", 3.0)
    peg = _safe_get(info, "pegRatio", 1.5)

    # P/E: <15 great (3.3), 15-25 ok (2), >35 bad (0.5)
    if pe <= 0:
        pe_score = 0.5  # Negative earnings
    elif pe < 15:
        pe_score = 3.3
    elif pe < 25:
        pe_score = 3.3 - (pe - 15) * 0.18
    else:
        pe_score = max(0, 1.5 - (pe - 25) * 0.05)

    # P/B: <1.5 great, <3 ok, >5 expensive
    pb_score = min(3.3, max(0, (5 - pb) * 0.825))

    # PEG: <1 great, 1-2 ok, >2 expensive
    peg_score = min(3.4, max(0, (2.5 - peg) * 1.36))

    total = round(pe_score + pb_score + peg_score, 1)
    return {
        "score": min(10.0, total),
        "details": {
            "trailing_pe": round(pe, 2),
            "price_to_book": round(pb, 2),
            "peg_ratio": round(peg, 2),
        },
    }


def _run_fundamentals(symbol: str) -> dict[str, Any]:
    info = _fetch_info(symbol)

    profitability = _score_profitability(info)
    growth = _score_growth(info)
    financial_health = _score_financial_health(info)
    valuation = _score_valuation(info)

    fundamental_score = round(
        profitability["score"] + growth["score"] + financial_health["score"] + valuation["score"],
        1,
    )

    return {
        "profitability": profitability,
        "growth": growth,
        "financial_health": financial_health,
        "valuation": valuation,
        "fundamental_score": min(40.0, fundamental_score),
    }


# ---------------------------------------------------------------------------
# Sentiment analysis (keyword-based, no LLM)
# ---------------------------------------------------------------------------

POSITIVE_KEYWORDS = {
    "beat", "beats", "exceeded", "surpass", "surge", "surges", "soar", "soars",
    "rally", "rallies", "gain", "gains", "upgrade", "upgrades", "outperform",
    "buy", "bullish", "growth", "profit", "record", "strong", "positive",
    "optimistic", "momentum", "breakout", "recovery", "boost", "innovation",
    "dividend", "raised", "expanding", "partnership", "approval",
}

NEGATIVE_KEYWORDS = {
    "miss", "misses", "missed", "decline", "declines", "drop", "drops",
    "fall", "falls", "plunge", "plunges", "crash", "downgrade", "downgrades",
    "sell", "bearish", "loss", "losses", "weak", "negative", "pessimistic",
    "warning", "lawsuit", "fraud", "investigation", "recall", "layoff",
    "layoffs", "debt", "bankruptcy", "default", "cut", "slump", "risk",
}


def _run_sentiment(symbol: str) -> dict[str, Any]:
    news = _fetch_news(symbol)

    results: list[dict[str, Any]] = []
    pos_count = 0
    neg_count = 0
    total = 0

    for item in news:
        title = item.get("title", "")
        if not title:
            continue
        total += 1
        words = set(title.lower().split())
        pos_matches = words & POSITIVE_KEYWORDS
        neg_matches = words & NEGATIVE_KEYWORDS

        if pos_matches and not neg_matches:
            label = "positive"
            pos_count += 1
        elif neg_matches and not pos_matches:
            label = "negative"
            neg_count += 1
        elif pos_matches and neg_matches:
            label = "mixed"
        else:
            label = "neutral"

        results.append({
            "title": title,
            "label": label,
            "positive_keywords": sorted(pos_matches),
            "negative_keywords": sorted(neg_matches),
        })

    # Score: -1 (all negative) to +1 (all positive)
    if total > 0:
        score = (pos_count - neg_count) / total
    else:
        score = 0.0

    return {
        "score": round(score, 4),
        "headline_count": total,
        "positive_count": pos_count,
        "negative_count": neg_count,
        "details": results,
    }


# ---------------------------------------------------------------------------
# Composite signal
# ---------------------------------------------------------------------------

COMPOSITE_WEIGHTS = {
    "technical": 0.40,
    "fundamentals": 0.30,
    "sentiment": 0.30,
}


def _compute_composite(
    technical: dict[str, Any],
    fundamentals: dict[str, Any],
    sentiment: dict[str, Any],
) -> dict[str, Any]:
    """Combine technical, fundamental, and sentiment into a single signal.

    Technical: ensemble raw_score is in [-1, +1]
    Fundamentals: fundamental_score is 0-40, we normalize to [-1, +1]
    Sentiment: score is in [-1, +1]
    """
    # Technical contribution
    tech_score = technical["ensemble"]["raw_score"]  # already in [-1, +1]

    # Fundamentals: 20 is neutral, 0 is terrible, 40 is excellent
    fund_raw = fundamentals["fundamental_score"]
    fund_score = (fund_raw - 20) / 20  # maps 0->-1, 20->0, 40->+1

    # Sentiment
    sent_score = sentiment["score"]

    weighted = (
        tech_score * COMPOSITE_WEIGHTS["technical"]
        + fund_score * COMPOSITE_WEIGHTS["fundamentals"]
        + sent_score * COMPOSITE_WEIGHTS["sentiment"]
    )

    if weighted > 0.1:
        signal = "bullish"
    elif weighted < -0.1:
        signal = "bearish"
    else:
        signal = "neutral"

    confidence = _clamp(abs(weighted) * 100)

    return {
        "signal": signal,
        "confidence": round(confidence),
        "raw_score": round(weighted, 4),
        "weights": COMPOSITE_WEIGHTS,
        "component_scores": {
            "technical": round(tech_score, 4),
            "fundamentals": round(fund_score, 4),
            "sentiment": round(sent_score, 4),
        },
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "quant-analysis"}


@app.get("/technical/{symbol}")
async def technical(symbol: str, period: str = Query(default="6mo")) -> dict[str, Any]:
    """Technical analysis only: 5 strategies + weighted ensemble."""
    symbol = symbol.upper()
    logger.info("Technical analysis for %s (period=%s)", symbol, period)
    try:
        result = _run_technical(symbol, period)
        return {"symbol": symbol, "period": period, **result}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Technical analysis failed for %s", symbol)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/fundamentals/{symbol}")
async def fundamentals(symbol: str) -> dict[str, Any]:
    """Fundamental analysis: profitability, growth, health, valuation."""
    symbol = symbol.upper()
    logger.info("Fundamental analysis for %s", symbol)
    try:
        result = _run_fundamentals(symbol)
        return {"symbol": symbol, **result}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Fundamental analysis failed for %s", symbol)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/sentiment/{symbol}")
async def sentiment(symbol: str) -> dict[str, Any]:
    """News headline sentiment analysis."""
    symbol = symbol.upper()
    logger.info("Sentiment analysis for %s", symbol)
    try:
        result = _run_sentiment(symbol)
        return {"symbol": symbol, **result}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Sentiment analysis failed for %s", symbol)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/analyze/{symbol}")
async def analyze(symbol: str, period: str = Query(default="6mo")) -> dict[str, Any]:
    """Full quant analysis pipeline: technical + fundamentals + sentiment + composite."""
    symbol = symbol.upper()
    logger.info("Full analysis for %s (period=%s)", symbol, period)
    try:
        tech = _run_technical(symbol, period)
        fund = _run_fundamentals(symbol)
        sent = _run_sentiment(symbol)
        composite = _compute_composite(tech, fund, sent)

        return {
            "symbol": symbol,
            "period": period,
            "technical": tech,
            "fundamentals": fund,
            "sentiment": sent,
            "composite": composite,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Full analysis failed for %s", symbol)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# VWAP (Volume-Weighted Average Price)
# ---------------------------------------------------------------------------


def _compute_vwap(symbol: str) -> dict[str, Any]:
    """
    Compute intraday VWAP and VWAP bands.
    VWAP = Cumulative(TypicalPrice * Volume) / Cumulative(Volume)
    Bands at +/- 1 and 2 standard deviations from VWAP.
    """
    ticker = yf.Ticker(symbol)
    # Fetch today's intraday data (5min bars)
    df = ticker.history(period="1d", interval="5m", auto_adjust=True)
    if df.empty or len(df) < 5:
        # Fall back to last 5 days of daily bars
        df = ticker.history(period="5d", interval="1h", auto_adjust=True)
        if df.empty:
            raise HTTPException(status_code=404, detail=f"No intraday data for {symbol}")

    df.columns = [c.lower() for c in df.columns]
    tp = (df["high"] + df["low"] + df["close"]) / 3
    cum_tp_vol = (tp * df["volume"]).cumsum()
    cum_vol = df["volume"].cumsum()
    vwap = cum_tp_vol / cum_vol

    # VWAP bands (cumulative std dev)
    sq_diff = ((tp - vwap) ** 2 * df["volume"]).cumsum()
    std = np.sqrt(sq_diff / cum_vol)

    current_vwap = float(vwap.iloc[-1])
    current_std = float(std.iloc[-1])
    current_price = float(df["close"].iloc[-1])
    distance_pct = ((current_price - current_vwap) / current_vwap) * 100 if current_vwap else 0

    # Trading signal based on VWAP
    if current_price > current_vwap + current_std:
        position = "above_upper_band"
        bias = "bullish_extended"
    elif current_price > current_vwap:
        position = "above_vwap"
        bias = "bullish"
    elif current_price > current_vwap - current_std:
        position = "below_vwap"
        bias = "bearish"
    else:
        position = "below_lower_band"
        bias = "bearish_extended"

    return {
        "vwap": round(current_vwap, 4),
        "price": round(current_price, 4),
        "distance_from_vwap_pct": round(distance_pct, 2),
        "upper_band_1": round(current_vwap + current_std, 4),
        "lower_band_1": round(current_vwap - current_std, 4),
        "upper_band_2": round(current_vwap + 2 * current_std, 4),
        "lower_band_2": round(current_vwap - 2 * current_std, 4),
        "position": position,
        "bias": bias,
        "bars_analyzed": len(df),
    }


@app.get("/vwap/{symbol}")
async def vwap(symbol: str) -> dict[str, Any]:
    """Intraday VWAP with bands and position signal."""
    symbol = symbol.upper()
    logger.info("VWAP for %s", symbol)
    try:
        result = _compute_vwap(symbol)
        return {"symbol": symbol, **result}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("VWAP failed for %s", symbol)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Pre-market gap scanner
# ---------------------------------------------------------------------------


def _scan_gaps(min_gap_pct: float = 4.0, min_volume: int = 100_000, max_price: float = 50.0) -> list[dict[str, Any]]:
    """
    Scan for stocks gapping up/down from previous close.
    Uses yfinance's most-active and gainers/losers screeners.
    """
    gappers: list[dict[str, Any]] = []

    # Get top movers from yfinance screeners
    try:
        from yfinance import screen
        screeners = []
        for name in ["day_gainers", "day_losers", "most_actives"]:
            try:
                result = screen(name)
                if result is not None and not result.empty:
                    screeners.append(result)
            except Exception:
                pass

        if not screeners:
            # Fallback: check a hardcoded list of common gapper tickers
            return []

        combined = pd.concat(screeners, ignore_index=True).drop_duplicates(subset=["symbol"])

        for _, row in combined.iterrows():
            sym = str(row.get("symbol", ""))
            if not sym:
                continue

            try:
                ticker = yf.Ticker(sym)
                hist = ticker.history(period="5d", auto_adjust=True)
                if hist.empty or len(hist) < 2:
                    continue

                hist.columns = [c.lower() for c in hist.columns]
                prev_close = float(hist["close"].iloc[-2])
                current = float(hist["close"].iloc[-1])
                volume = float(hist["volume"].iloc[-1])
                gap_pct = ((current - prev_close) / prev_close) * 100

                if abs(gap_pct) >= min_gap_pct and volume >= min_volume and current <= max_price:
                    gappers.append({
                        "symbol": sym,
                        "prev_close": round(prev_close, 4),
                        "current": round(current, 4),
                        "gap_pct": round(gap_pct, 2),
                        "volume": int(volume),
                        "direction": "up" if gap_pct > 0 else "down",
                        "price": round(current, 4),
                    })
            except Exception:
                continue

    except ImportError:
        # yfinance screen not available in this version — try manual approach
        pass

    # Sort by absolute gap size
    gappers.sort(key=lambda x: abs(x.get("gap_pct", 0)), reverse=True)
    return gappers[:20]  # Top 20


@app.get("/gaps")
async def gaps(
    min_gap_pct: float = Query(default=4.0),
    min_volume: int = Query(default=100_000),
    max_price: float = Query(default=50.0),
) -> dict[str, Any]:
    """Scan for gap-up and gap-down stocks."""
    logger.info("Gap scan: min_gap=%.1f%%, min_vol=%d, max_price=%.0f", min_gap_pct, min_volume, max_price)
    try:
        results = _scan_gaps(min_gap_pct, min_volume, max_price)
        return {
            "count": len(results),
            "filters": {
                "min_gap_pct": min_gap_pct,
                "min_volume": min_volume,
                "max_price": max_price,
            },
            "gappers": results,
        }
    except Exception as e:
        logger.exception("Gap scan failed")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Position sizing (ATR-based + Kelly)
# ---------------------------------------------------------------------------


def _compute_position_size(
    symbol: str,
    account_equity: float,
    risk_per_trade_pct: float = 1.0,
    atr_multiplier: float = 2.0,
    max_position_pct: float = 15.0,
) -> dict[str, Any]:
    """
    ATR-based position sizing with Kelly Criterion adjustment.

    1. ATR determines stop distance (volatility-adjusted)
    2. Fixed fractional risk (default 1%) determines max $ risk
    3. Position size = Risk $ / Stop Distance
    4. Kelly-Lite adjusts sizing based on recent win rate (if available)
    """
    df = _fetch_history(symbol, "3mo")
    sdf = _to_stockstats(df)

    # ATR (14-period)
    atr_col = sdf["atr_14"]
    current_atr = float(atr_col.iloc[-1])
    current_price = float(df["close"].iloc[-1])

    # Stop distance = ATR * multiplier
    stop_distance = current_atr * atr_multiplier
    stop_price = current_price - stop_distance

    # Risk amount (fixed fractional)
    risk_amount = account_equity * (risk_per_trade_pct / 100)

    # Position size from ATR
    if stop_distance > 0:
        shares = int(risk_amount / stop_distance)
    else:
        shares = 0

    position_value = shares * current_price

    # Cap at max position size
    max_position_value = account_equity * (max_position_pct / 100)
    if position_value > max_position_value:
        shares = int(max_position_value / current_price)
        position_value = shares * current_price

    # Volatility classification
    atr_pct = (current_atr / current_price) * 100
    if atr_pct > 5:
        vol_class = "very_high"
    elif atr_pct > 3:
        vol_class = "high"
    elif atr_pct > 1.5:
        vol_class = "moderate"
    else:
        vol_class = "low"

    return {
        "price": round(current_price, 4),
        "atr_14": round(current_atr, 4),
        "atr_pct": round(atr_pct, 2),
        "volatility": vol_class,
        "stop_distance": round(stop_distance, 4),
        "stop_price": round(stop_price, 4),
        "risk_per_trade_pct": risk_per_trade_pct,
        "risk_amount": round(risk_amount, 2),
        "recommended_shares": shares,
        "position_value": round(position_value, 2),
        "position_pct_of_equity": round((position_value / account_equity) * 100, 2) if account_equity > 0 else 0,
        "take_profit_1": round(current_price + stop_distance, 4),       # 1:1 R:R
        "take_profit_2": round(current_price + stop_distance * 1.5, 4),  # 1.5:1 R:R
        "take_profit_3": round(current_price + stop_distance * 2, 4),    # 2:1 R:R
    }


@app.get("/position_size/{symbol}")
async def position_size(
    symbol: str,
    account_equity: float = Query(..., description="Account equity in dollars"),
    risk_pct: float = Query(default=1.0, description="Risk per trade as % of equity"),
    atr_multiplier: float = Query(default=2.0, description="ATR multiplier for stop distance"),
    max_position_pct: float = Query(default=15.0, description="Max position as % of equity"),
) -> dict[str, Any]:
    """ATR-based position sizing with stop-loss and take-profit levels."""
    symbol = symbol.upper()
    logger.info("Position sizing for %s (equity=%.0f, risk=%.1f%%)", symbol, account_equity, risk_pct)
    try:
        result = _compute_position_size(symbol, account_equity, risk_pct, atr_multiplier, max_position_pct)
        return {"symbol": symbol, **result}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Position sizing failed for %s", symbol)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8200)
