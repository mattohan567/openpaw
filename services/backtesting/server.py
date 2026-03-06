"""
OpenPaw Backtesting Sidecar Service

FastAPI service using vectorbt for fast strategy backtesting.
The agent calls this before committing capital to validate a strategy hypothesis.
"""

from __future__ import annotations

import functools
import hashlib
import json
import time
from enum import Enum
from itertools import product
from pathlib import Path
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
        fees=0.002,  # 0.2% per trade (commission + slippage)
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


class WalkForwardRequest(BaseModel):
    symbol: str
    strategy: str
    params: dict[str, Any] = Field(default_factory=dict)
    period: str = "2y"
    initial_capital: float = 10000.0
    n_folds: int = 5


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
                fees=0.002,
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


@app.post("/walkforward")
def walkforward(req: WalkForwardRequest) -> dict[str, Any]:
    """Walk-forward validation: train on fold, test on next fold, repeat.

    Detects overfitting by comparing in-sample vs out-of-sample performance.
    A >50% degradation from IS to OOS suggests the strategy is overfit.
    """
    if req.strategy not in STRATEGY_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown strategy '{req.strategy}'. Available: {list(STRATEGY_MAP.keys())}",
        )

    merged_params = {**STRATEGY_DEFAULTS.get(req.strategy, {}), **req.params}
    df = _fetch_price_data(req.symbol, req.period)

    n = len(df)
    fold_size = n // (req.n_folds + 1)  # +1 because we need IS and OOS windows

    if fold_size < 30:
        raise HTTPException(
            status_code=422,
            detail=f"Insufficient data for {req.n_folds} folds. Need at least {30 * (req.n_folds + 1)} bars, got {n}.",
        )

    is_results = []  # in-sample
    oos_results = []  # out-of-sample
    fold_details = []

    for i in range(req.n_folds):
        # In-sample: folds 0..i, Out-of-sample: fold i+1
        is_end = (i + 1) * fold_size
        oos_start = is_end
        oos_end = min(oos_start + fold_size, n)

        if oos_end - oos_start < 20:
            continue

        is_df = df.iloc[:is_end]
        oos_df = df.iloc[oos_start:oos_end]

        # Run strategy on in-sample
        is_close = is_df["Close"]
        is_volume = is_df["Volume"]
        try:
            is_entries, is_exits = STRATEGY_MAP[req.strategy](is_close, is_volume, merged_params)
            is_entries = is_entries.fillna(False).astype(bool)
            is_exits = is_exits.fillna(False).astype(bool)

            is_pf = vbt.Portfolio.from_signals(
                is_close, entries=is_entries, exits=is_exits,
                init_cash=req.initial_capital, fees=0.002, freq="1D",
            )
            is_metrics = _extract_results(is_pf)
        except Exception:
            continue

        # Run strategy on out-of-sample
        oos_close = oos_df["Close"]
        oos_volume = oos_df["Volume"]
        try:
            oos_entries, oos_exits = STRATEGY_MAP[req.strategy](oos_close, oos_volume, merged_params)
            oos_entries = oos_entries.fillna(False).astype(bool)
            oos_exits = oos_exits.fillna(False).astype(bool)

            oos_pf = vbt.Portfolio.from_signals(
                oos_close, entries=oos_entries, exits=oos_exits,
                init_cash=req.initial_capital, fees=0.002, freq="1D",
            )
            oos_metrics = _extract_results(oos_pf)
        except Exception:
            continue

        is_results.append(is_metrics)
        oos_results.append(oos_metrics)

        fold_details.append({
            "fold": i + 1,
            "is_bars": len(is_df),
            "oos_bars": len(oos_df),
            "is_return": is_metrics["total_return_pct"],
            "oos_return": oos_metrics["total_return_pct"],
            "is_sharpe": is_metrics["sharpe_ratio"],
            "oos_sharpe": oos_metrics["sharpe_ratio"],
            "is_trades": is_metrics["total_trades"],
            "oos_trades": oos_metrics["total_trades"],
        })

    if not fold_details:
        raise HTTPException(status_code=422, detail="No valid folds produced. Data may be insufficient.")

    # Aggregate metrics
    avg_is_return = sum(f["is_return"] for f in fold_details) / len(fold_details)
    avg_oos_return = sum(f["oos_return"] for f in fold_details) / len(fold_details)
    avg_is_sharpe = sum(f["is_sharpe"] for f in fold_details) / len(fold_details)
    avg_oos_sharpe = sum(f["oos_sharpe"] for f in fold_details) / len(fold_details)

    # Performance gap (IS vs OOS)
    return_gap = abs(avg_is_return - avg_oos_return) / max(abs(avg_is_return), 0.01) * 100
    sharpe_gap = abs(avg_is_sharpe - avg_oos_sharpe) / max(abs(avg_is_sharpe), 0.01) * 100

    # Verdict
    if return_gap > 50 or sharpe_gap > 50:
        verdict = f"LIKELY OVERFIT — IS-vs-OOS gap is {return_gap:.0f}% (return) / {sharpe_gap:.0f}% (Sharpe). Strategy performance degrades significantly out-of-sample."
        overfit_risk = "high"
    elif return_gap > 30 or sharpe_gap > 30:
        verdict = f"MODERATE OVERFIT RISK — IS-vs-OOS gap is {return_gap:.0f}% (return) / {sharpe_gap:.0f}% (Sharpe). Consider simpler parameters."
        overfit_risk = "moderate"
    else:
        verdict = f"ROBUST — IS-vs-OOS gap is only {return_gap:.0f}% (return) / {sharpe_gap:.0f}% (Sharpe). Strategy generalizes well."
        overfit_risk = "low"

    # Buy-and-hold benchmark on full period
    buy_hold = _compute_benchmark(df["Close"], req.initial_capital)

    return {
        "symbol": req.symbol.upper(),
        "strategy": req.strategy,
        "params": merged_params,
        "period": req.period,
        "n_folds": len(fold_details),
        "in_sample": {
            "avg_return_pct": round(avg_is_return, 2),
            "avg_sharpe": round(avg_is_sharpe, 2),
        },
        "out_of_sample": {
            "avg_return_pct": round(avg_oos_return, 2),
            "avg_sharpe": round(avg_oos_sharpe, 2),
        },
        "performance_gap": {
            "return_gap_pct": round(return_gap, 1),
            "sharpe_gap_pct": round(sharpe_gap, 1),
        },
        "overfit_risk": overfit_risk,
        "verdict": verdict,
        "benchmark_buy_hold_pct": buy_hold,
        "fold_details": fold_details,
    }


# ---------------------------------------------------------------------------
# Strategy Performance Analysis
# ---------------------------------------------------------------------------

TRADE_LOG_PATH = Path.home() / ".openpaw" / "trade_history.jsonl"

class StrategyPerformanceRequest(BaseModel):
    current_regime: str = "unknown"  # "bull", "bear", "sideways", or "unknown"
    days: int = 90

@app.post("/strategy_performance")
def strategy_performance(req: StrategyPerformanceRequest) -> dict[str, Any]:
    """Analyze historical trade performance by strategy and regime.

    Reads the trade log and computes win rate, avg return, and Sharpe
    for each strategy. When a regime is provided, shows regime-conditional
    performance to recommend the best strategies.
    """
    if not TRADE_LOG_PATH.exists():
        return {
            "status": "no_data",
            "message": "No trade history found. Start trading to build performance data.",
            "recommendations": [],
        }

    # Load trades
    trades = []
    cutoff = pd.Timestamp.now() - pd.Timedelta(days=req.days)

    for line in TRADE_LOG_PATH.read_text().strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            trade = json.loads(line)
            ts = pd.Timestamp(trade.get("timestamp", ""))
            if ts >= cutoff:
                trades.append(trade)
        except Exception:
            continue

    if not trades:
        return {
            "status": "no_data",
            "message": f"No trades in the last {req.days} days.",
            "recommendations": [],
        }

    # Group by strategy (from trade log tags, or infer from order type/action)
    strategy_stats: dict[str, dict[str, Any]] = {}

    # Build FIFO matching per symbol
    buy_queues: dict[str, list[dict]] = {}
    completed: list[dict] = []

    for trade in trades:
        symbol = trade.get("symbol", "").upper()
        action = trade.get("action", "")
        qty = abs(float(trade.get("qty", 0)))

        # Try to get price
        price = 0
        if trade.get("estimatedCost") and qty > 0:
            price = float(trade["estimatedCost"]) / qty
        elif isinstance(trade.get("result"), dict):
            fp = trade["result"].get("filled_avg_price")
            if fp:
                price = float(fp)

        if price <= 0 or qty <= 0:
            continue

        # Strategy tag (if present in trade log)
        strategy = trade.get("strategy", "untagged")
        regime = trade.get("regime", "unknown")

        if action in ("buy", "bracket_buy"):
            if symbol not in buy_queues:
                buy_queues[symbol] = []
            buy_queues[symbol].append({
                "price": price, "qty": qty,
                "strategy": strategy, "regime": regime,
                "timestamp": trade.get("timestamp", ""),
            })
        elif action == "sell":
            if symbol not in buy_queues or not buy_queues[symbol]:
                continue
            remaining = qty
            while remaining > 0 and buy_queues[symbol]:
                front = buy_queues[symbol][0]
                matched = min(remaining, front["qty"])
                pnl = (price - front["price"]) * matched
                ret_pct = (price - front["price"]) / front["price"] * 100

                completed.append({
                    "symbol": symbol,
                    "strategy": front["strategy"],
                    "regime": front["regime"],
                    "pnl": pnl,
                    "return_pct": ret_pct,
                })

                front["qty"] -= matched
                remaining -= matched
                if front["qty"] <= 0:
                    buy_queues[symbol].pop(0)

    if not completed:
        return {
            "status": "no_completed",
            "message": f"Found {len(trades)} trades but no completed round-trips in {req.days} days.",
            "recommendations": [],
        }

    # Aggregate by strategy
    for trade in completed:
        strat = trade["strategy"]
        if strat not in strategy_stats:
            strategy_stats[strat] = {"trades": [], "regime_trades": {}}
        strategy_stats[strat]["trades"].append(trade)

        regime = trade["regime"]
        if regime not in strategy_stats[strat]["regime_trades"]:
            strategy_stats[strat]["regime_trades"][regime] = []
        strategy_stats[strat]["regime_trades"][regime].append(trade)

    # Compute stats per strategy
    results = []
    for strat, data in strategy_stats.items():
        trades_list = data["trades"]
        returns = [t["return_pct"] for t in trades_list]
        wins = [r for r in returns if r > 0]

        entry = {
            "strategy": strat,
            "total_trades": len(trades_list),
            "win_rate": round(len(wins) / len(returns) * 100, 1) if returns else 0,
            "avg_return_pct": round(sum(returns) / len(returns), 2) if returns else 0,
            "total_pnl": round(sum(t["pnl"] for t in trades_list), 2),
            "best_return": round(max(returns), 2) if returns else 0,
            "worst_return": round(min(returns), 2) if returns else 0,
        }

        # Regime-conditional stats
        if req.current_regime != "unknown":
            regime_trades = data["regime_trades"].get(req.current_regime, [])
            if regime_trades:
                regime_returns = [t["return_pct"] for t in regime_trades]
                regime_wins = [r for r in regime_returns if r > 0]
                entry["regime_stats"] = {
                    "regime": req.current_regime,
                    "trades_in_regime": len(regime_trades),
                    "win_rate_in_regime": round(len(regime_wins) / len(regime_returns) * 100, 1),
                    "avg_return_in_regime": round(sum(regime_returns) / len(regime_returns), 2),
                }

        results.append(entry)

    # Sort by avg return
    results.sort(key=lambda x: x["avg_return_pct"], reverse=True)

    # Generate recommendations
    recommendations = []
    for r in results[:3]:
        if r["win_rate"] >= 55 and r["avg_return_pct"] > 0:
            recommendations.append(f"{r['strategy']}: {r['win_rate']}% win rate, {r['avg_return_pct']}% avg return — RECOMMENDED")
        elif r["avg_return_pct"] > 0:
            recommendations.append(f"{r['strategy']}: {r['win_rate']}% win rate, {r['avg_return_pct']}% avg return — viable but below target")

    if not recommendations:
        recommendations.append("No strategies with positive returns. Review your approach.")

    return {
        "status": "ok",
        "period_days": req.days,
        "total_completed_trades": len(completed),
        "strategies": results,
        "recommendations": recommendations,
        "current_regime": req.current_regime,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8300)
