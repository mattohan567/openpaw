# OpenPaw Backtesting Service

FastAPI sidecar that uses vectorbt for strategy backtesting. The agent calls this before committing capital to validate a strategy hypothesis.

## Setup

```bash
cd services/backtesting
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python server.py
```

The service starts on port **8300**.

## Endpoints

| Method | Path        | Description                                      |
|--------|-------------|--------------------------------------------------|
| GET    | `/health`   | Health check                                     |
| POST   | `/backtest` | Run a single strategy backtest                   |
| POST   | `/optimize` | Sweep parameter ranges, return top 3 combos      |

## Built-in Strategies

- **rsi** -- RSI oversold/overbought signals
- **sma_crossover** -- Fast/slow SMA crossover
- **bollinger** -- Bollinger Band breakout
- **momentum** -- N-day return + volume filter
- **mean_reversion** -- Standard deviation mean reversion

## Example

```bash
curl -X POST http://localhost:8300/backtest \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "NVDA",
    "strategy": "rsi",
    "params": {"rsi_period": 14, "oversold": 30, "overbought": 70},
    "period": "1y",
    "initial_capital": 10000
  }'
```
