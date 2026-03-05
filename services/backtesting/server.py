"""
OpenPaw Backtesting Sidecar Service

FastAPI service using vectorbt for fast strategy backtesting.
The agent calls this before committing capital to validate a strategy hypothesis.
"""

from __future__ import annotations

import functools
import hashlib
import time
from enum import Enum
from itertools import product
from typing import Any

import numpy as np
import pandas as pd
import uvicorn
import vectorbt as vbt
import yfinance as yf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="OpenPaw Backtesting Service", version="1.0.0")

# ---------------------------------------------------------------------------
# Data cache (15-minute TTL for historical data)
# ---------------------------------------------------------------------------

_DATA_CACHE: dict[str, tuple[float, pd.DataFrame]] = {}
_CACHE_TTL_SECONDS = 900  # 15 minutes


def _fetch_price_data(symbol: str, period: str) -> pd.DataFrame:
    """Download OHLCV data from yfinance with 15-minute caching."""
    cache_key = hashlib.md5(f"{symbol}:{period}".encode()).hexdigest()
    now = time.time()

    if cache_key in _DATA_CACHE:
        ts, df = _DATA_CACHE[cache_key]
        if now - ts < _CACHE_TTL_SECONDS:
            return df.copy()

    ticker = yf.Ticker(symbol)
    df = ticker.history(period=period, auto_adjust=True)

    if df.empty:
        raise HTTPException(
            status_code=422,
            detail=f"No price data returned for symbol '{symbol}' over period '{period}'. "
            "Check that the symbol is valid and the period is supported.",
        )

    if len(df) < 30:
        raise HTTPException(
            status_code=422,
            detail=f"Insufficient data for '{symbol}' — only {len(df)} bars returned. "
            "At least 30 bars are required for meaningful backtesting.",
        )

    _DATA_CACHE[cache_key] = (now, df.copy())
    return df


# ---------------------------------------------------------------------------
# Strategies — each returns (entries: pd.Series[bool], exits: pd.Series[bool])
# ---------------------------------------------------------------------------


def _strategy_rsi(
    close: pd.Series,
    volume: pd.Series,
    params: dict[str, Any],
) -> tuple[pd.Series, pd.Series]:
    rsi_period: int = int(params.get("rsi_period", 14))
    oversold: float = float(params.get("oversold", 30))
    overbought: float = float(params.get("overbought", 70))

    rsi = vbt.RSI.run(close, window=rsi_period).rsi.to_numpy()
    entries = pd.Series(rsi < oversold, index=close.index)
    exits = pd.Series(rsi > overbought, index=close.index)
    return entries, exits


def _strategy_sma_crossover(
    close: pd.Series,
    volume: pd.Series,
    params: dict[str, Any],
) -> tuple[pd.Series, pd.Series]:
    fast_period: int = int(params.get("fast_period", 10))
    slow_period: int = int(params.get("slow_period", 30))

    fast_sma = vbt.MA.run(close, window=fast_period).ma.to_numpy()
    slow_sma = vbt.MA.run(close, window=slow_period).ma.to_numpy()

    cross_above = (fast_sma[:-1] <= slow_sma[:-1]) & (fast_sma[1:] > slow_sma[1:])
    cross_below = (fast_sma[:-1] >= slow_sma[:-1]) & (fast_sma[1:] < slow_sma[1:])

    entries = pd.Series(
        np.concatenate([[False], cross_above]), index=close.index
    )
    exits = pd.Series(
        np.concatenate([[False], cross_below]), index=close.index
    )
    return entries, exits


def _strategy_bollinger(
    close: pd.Series,
    volume: pd.Series,
    params: dict[str, Any],
) -> tuple[pd.Series, pd.Series]:
    bb_period: int = int(params.get("bb_period", 20))
    bb_std: float = float(params.get("bb_std", 2.0))

    bb = vbt.BBANDS.run(close, window=bb_period, alpha=bb_std)
    lower = bb.lower.to_numpy()
    upper = bb.upper.to_numpy()
    close_arr = close.to_numpy()

    entries = pd.Series(close_arr < lower, index=close.index)
    exits = pd.Series(close_arr > upper, index=close.index)
    return entries, exits


def _strategy_momentum(
    close: pd.Series,
    volume: pd.Series,
    params: dict[str, Any],
) -> tuple[pd.Series, pd.Series]:
    lookback: int = int(params.get("lookback", 10))
    vol_factor: float = float(params.get("vol_factor", 1.5))

    returns = close.pct_change(periods=lookback).to_numpy()
    avg_volume = volume.rolling(window=lookback).mean().to_numpy()
    volume_arr = volume.to_numpy()

    entries = pd.Series(
        (returns > 0) & (volume_arr > avg_volume * vol_factor),
        index=close.index,
    )
    exits = pd.Series(returns < 0, index=close.index)
    return entries, exits


def _strategy_mean_reversion(
    close: pd.Series,
    volume: pd.Series,
    params: dict[str, Any],
) -> tuple[pd.Series, pd.Series]:
    window: int = int(params.get("window", 20))
    entry_std: float = float(params.get("entry_std", 2.0))
    exit_std: float = float(params.get("exit_std", 0.5))

    rolling_mean = close.rolling(window=window).mean().to_numpy()
    rolling_std = close.rolling(window=window).std().to_numpy()
    close_arr = close.to_numpy()

    entries = pd.Series(
        close_arr < (rolling_mean - entry_std * rolling_std),
        index=close.index,
    )
    exits = pd.Series(
        close_arr > (rolling_mean - exit_std * rolling_std),
        index=close.index,
    )
    return entries, exits


STRATEGY_MAP: dict[str, Any] = {
    "rsi": _strategy_rsi,
    "sma_crossover": _strategy_sma_crossover,
    "bollinger": _strategy_bollinger,
    "momentum": _strategy_momentum,
    "mean_reversion": _strategy_mean_reversion,
}

STRATEGY_DEFAULTS: dict[str, dict[str, Any]] = {
    "rsi": {"rsi_period": 14, "oversold": 30, "overbought": 70},
    "sma_crossover": {"fast_period": 10, "slow_period": 30},
    "bollinger": {"bb_period": 20, "bb_std": 2.0},
    "momentum": {"lookback": 10, "vol_factor": 1.5},
    "mean_reversion": {"window": 20, "entry_std": 2.0, "exit_std": 0.5},
}

# ---------------------------------------------------------------------------
# Portfolio stats extraction
# ---------------------------------------------------------------------------


def _extract_results(pf: vbt.Portfolio) -> dict[str, Any]:
    """Pull key metrics from a vectorbt Portfolio object."""
    stats = pf.stats()

    total_return_pct = round(float(pf.total_return() * 100), 2)
    sharpe = pf.sharpe_ratio()
    sortino = pf.sortino_ratio()
    max_dd = pf.max_drawdown()
    total_trades = int(pf.trades.count())

    if total_trades == 0:
        return {
            "total_return_pct": total_return_pct,
            "sharpe_ratio": 0.0,
            "sortino_ratio": 0.0,
            "max_drawdown_pct": round(float(max_dd * 100), 2),
            "win_rate_pct": 0.0,
            "total_trades": 0,
            "profit_factor": 0.0,
            "avg_trade_pct": 0.0,
            "best_trade_pct": 0.0,
            "worst_trade_pct": 0.0,
            "avg_holding_days": 0.0,
        }

    trades = pf.trades.records_readable
    trade_returns = pf.trades.pnl.values / pf.trades.size.values / pf.trades.entry_price.values * 100
    winning = trade_returns[trade_returns > 0]
    losing = trade_returns[trade_returns < 0]

    win_rate = round(float(len(winning) / total_trades * 100), 2) if total_trades > 0 else 0.0
    profit_factor = round(float(winning.sum() / abs(losing.sum())), 2) if len(losing) > 0 and losing.sum() != 0 else float("inf") if len(winning) > 0 else 0.0

    # Average holding period in days
    if "Entry Timestamp" in trades.columns and "Exit Timestamp" in trades.columns:
        durations = pd.to_datetime(trades["Exit Timestamp"]) - pd.to_datetime(trades["Entry Timestamp"])
        avg_holding = round(float(durations.dt.total_seconds().mean() / 86400), 2)
    else:
        avg_holding = 0.0

    return {
        "total_return_pct": total_return_pct,
        "sharpe_ratio": round(float(sharpe), 2) if np.isfinite(sharpe) else 0.0,
        "sortino_ratio": round(float(sortino), 2) if np.isfinite(sortino) else 0.0,
        "max_drawdown_pct": round(float(max_dd * 100), 2),
        "win_rate_pct": win_rate,
        "total_trades": total_trades,
        "profit_factor": round(profit_factor, 2) if np.isfinite(profit_factor) else 999.99,
        "avg_trade_pct": round(float(trade_returns.mean()), 2) if total_trades > 0 else 0.0,
        "best_trade_pct": round(float(trade_returns.max()), 2) if total_trades > 0 else 0.0,
        "worst_trade_pct": round(float(trade_returns.min()), 2) if total_trades > 0 else 0.0,
        "avg_holding_days": avg_holding,
    }


def _compute_benchmark(close: pd.Series, initial_capital: float) -> float:
    """Buy-and-hold return percentage."""
    if len(close) < 2:
        return 0.0
    return round(float((close.iloc[-1] / close.iloc[0] - 1) * 100), 2)


def _build_verdict(
    results: dict[str, Any],
    buy_hold_return: float,
    alpha: float,
) -> str:
    """Generate a human-readable verdict."""
    sharpe = results["sharpe_ratio"]
    total_trades = results["total_trades"]
    total_return = results["total_return_pct"]

    if total_trades == 0:
        return "BACKTEST FAILED -- no trades were generated. The strategy parameters may be too restrictive for this data."

    if sharpe < 0:
        return (
            f"BACKTEST FAILED -- negative Sharpe ratio ({sharpe}). "
            f"Strategy returned {total_return}% vs buy-and-hold {buy_hold_return}%. Not viable."
        )

    if alpha > 0 and sharpe >= 1.0:
        return (
            f"BACKTEST PASSED -- strategy outperforms buy-and-hold by {alpha}% "
            f"with Sharpe {sharpe}"
        )

    if alpha > 0 and sharpe >= 0.5:
        return (
            f"BACKTEST MARGINAL -- strategy outperforms buy-and-hold by {alpha}% "
            f"but Sharpe is only {sharpe}. Consider optimizing parameters."
        )

    if alpha <= 0:
        return (
            f"BACKTEST FAILED -- strategy underperforms buy-and-hold by {abs(alpha)}% "
            f"(Sharpe {sharpe}). Buy-and-hold returned {buy_hold_return}%."
        )

    return (
        f"BACKTEST INCONCLUSIVE -- {total_return}% return, Sharpe {sharpe}, "
        f"alpha {alpha}% vs buy-and-hold. Review trade details."
    )


# ---------------------------------------------------------------------------
# Run a single backtest
# ---------------------------------------------------------------------------


def _run_backtest(
    symbol: str,
    strategy: str,
    params: dict[str, Any],
    period: str,
    initial_capital: float,
) -> dict[str, Any]:
    """Execute a single strategy backtest and return full results dict."""
    if strategy not in STRATEGY_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown strategy '{strategy}'. Available: {list(STRATEGY_MAP.keys())}",
        )

    # Merge defaults with provided params
    merged_params = {**STRATEGY_DEFAULTS.get(strategy, {}), **params}

    df = _fetch_price_data(symbol, period)
    close = df["Close"]
    volume = df["Volume"]

    entries, exits = STRATEGY_MAP[strategy](close, volume, merged_params)

    # Clean signals: fill NaN with False
    entries = entries.fillna(False).astype(bool)
    exits = exits.fillna(False).astype(bool)

    pf = vbt.Portfolio.from_signals(
        close,
        entries=entries,
        exits=exits,
        init_cash=initial_capital,
        fees=0.001,  # 0.1% per trade (approximate commission + slippage)
        freq="1D",
    )

    results = _extract_results(pf)
    buy_hold_return = _compute_benchmark(close, initial_capital)
    alpha = round(results["total_return_pct"] - buy_hold_return, 2)
    verdict = _build_verdict(results, buy_hold_return, alpha)

    return {
        "symbol": symbol.upper(),
        "strategy": strategy,
        "params": merged_params,
        "period": period,
        "results": results,
        "benchmark": {
            "buy_hold_return_pct": buy_hold_return,
            "alpha": alpha,
        },
        "verdict": verdict,
    }


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class BacktestRequest(BaseModel):
    symbol: str
    strategy: str
    params: dict[str, Any] = Field(default_factory=dict)
    period: str = "1y"
    initial_capital: float = 10000.0


class OptimizeRequest(BaseModel):
    symbol: str
    strategy: str
    param_ranges: dict[str, list[Any]]
    period: str = "1y"
    initial_capital: float = 10000.0
    optimize_by: str = "sharpe_ratio"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "openpaw-backtesting", "version": "1.0.0"}


@app.post("/backtest")
def backtest(req: BacktestRequest) -> dict[str, Any]:
    return _run_backtest(
        symbol=req.symbol,
        strategy=req.strategy,
        params=req.params,
        period=req.period,
        initial_capital=req.initial_capital,
    )


@app.post("/optimize")
def optimize(req: OptimizeRequest) -> dict[str, Any]:
    if req.strategy not in STRATEGY_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown strategy '{req.strategy}'. Available: {list(STRATEGY_MAP.keys())}",
        )

    valid_metrics = {
        "sharpe_ratio",
        "sortino_ratio",
        "total_return_pct",
        "profit_factor",
        "win_rate_pct",
    }
    if req.optimize_by not in valid_metrics:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid optimize_by metric '{req.optimize_by}'. Available: {sorted(valid_metrics)}",
        )

    # Build all parameter combinations
    param_names = list(req.param_ranges.keys())
    param_values = list(req.param_ranges.values())

    all_combos = list(product(*param_values))
    if len(all_combos) > 1000:
        raise HTTPException(
            status_code=400,
            detail=f"Too many parameter combinations ({len(all_combos)}). "
            "Maximum is 1000. Reduce the number of values per parameter.",
        )

    if len(all_combos) == 0:
        raise HTTPException(
            status_code=400,
            detail="No parameter combinations generated. Provide at least one value per parameter.",
        )

    # Pre-fetch data once (cached anyway, but be explicit)
    df = _fetch_price_data(req.symbol, req.period)
    close = df["Close"]
    volume = df["Volume"]

    # Merge with defaults for any params not in sweep
    base_params = {**STRATEGY_DEFAULTS.get(req.strategy, {})}

    scored_results: list[tuple[float, dict[str, Any]]] = []

    for combo in all_combos:
        params = {**base_params, **dict(zip(param_names, combo))}

        try:
            entries, exits = STRATEGY_MAP[req.strategy](close, volume, params)
            entries = entries.fillna(False).astype(bool)
            exits = exits.fillna(False).astype(bool)

            pf = vbt.Portfolio.from_signals(
                close,
                entries=entries,
                exits=exits,
                init_cash=req.initial_capital,
                fees=0.001,
                freq="1D",
            )

            results = _extract_results(pf)
            metric_value = results.get(req.optimize_by, 0.0)
            if not np.isfinite(metric_value):
                metric_value = -999.0

            buy_hold_return = _compute_benchmark(close, req.initial_capital)
            alpha = round(results["total_return_pct"] - buy_hold_return, 2)
            verdict = _build_verdict(results, buy_hold_return, alpha)

            scored_results.append(
                (
                    metric_value,
                    {
                        "params": params,
                        "results": results,
                        "benchmark": {
                            "buy_hold_return_pct": buy_hold_return,
                            "alpha": alpha,
                        },
                        "verdict": verdict,
                    },
                )
            )
        except Exception:
            # Skip combos that error (e.g., window too large for data)
            continue

    if not scored_results:
        raise HTTPException(
            status_code=422,
            detail="All parameter combinations failed. The data may be insufficient "
            "for the requested parameter ranges.",
        )

    # Sort descending by metric, take top 3
    scored_results.sort(key=lambda x: x[0], reverse=True)
    top_3 = scored_results[:3]

    return {
        "symbol": req.symbol.upper(),
        "strategy": req.strategy,
        "period": req.period,
        "optimize_by": req.optimize_by,
        "combinations_tested": len(scored_results),
        "top_results": [entry[1] for entry in top_3],
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8300)
