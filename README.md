# OpenPaw

Autonomous stock trading agent that runs on your computer 24/7. Screens markets, analyzes stocks with quantitative models, backtests strategies, manages risk, executes trades via Alpaca, and keeps you in the loop via WhatsApp.

Built on the same [Pi SDK](https://github.com/badlogic/pi-mono) agent engine as [OpenClaw](https://github.com/openclaw/openclaw).

## What It Does

- **Screens** — Scans top movers, most active, news, Reddit sentiment, insider trades
- **Analyzes** — 5-strategy technical ensemble + fundamental scoring + sentiment analysis (pure math, no LLM)
- **Backtests** — Validates strategies against historical data before committing capital (vectorbt)
- **Risk Checks** — Daily loss limits, position concentration, aging positions, risk scoring
- **Trades** — Buys, sells, bracket orders with automatic stop-loss/take-profit via Alpaca
- **Monitors** — Real-time price streaming, price alerts, portfolio tracking
- **Reports** — Morning briefings, end-of-day reports, trade analytics, SPY benchmarking
- **Remembers** — Persistent memory across restarts (daily logs + curated knowledge)

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Gateway (Node.js)                │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Pi SDK   │  │ WhatsApp │  │ Alpaca Stream │  │
│  │ Agent    │  │ (Baileys)│  │ (WebSocket)   │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │                │          │
│  ┌────┴──────────────┴────────────────┴───────┐  │
│  │            46 Tools                         │  │
│  │  Trading · Market Data · Portfolio · Risk   │  │
│  │  Research · Alerts · Memory · Quant · Web   │  │
│  └────┬───────────────────────────────┬───────┘  │
│       │                               │          │
│  ┌────┴─────┐                   ┌─────┴──────┐   │
│  │ Session  │                   │ Cron/Heart │   │
│  │ (JSONL)  │                   │ beat Jobs  │   │
│  └──────────┘                   └────────────┘   │
└──────────────────┬───────────────────────────────┘
                   │ HTTP (auto-started)
        ┌──────────┴──────────┐
        │                     │
  ┌─────┴──────┐    ┌────────┴────────┐
  │ Quant      │    │ Backtesting     │
  │ Analysis   │    │ Service         │
  │ (Python)   │    │ (Python)        │
  │ Port 8200  │    │ Port 8300       │
  └────────────┘    └─────────────────┘
```

## Quick Start

### Prerequisites

- Node.js >= 22
- Python >= 3.11
- pnpm
- [Alpaca](https://alpaca.markets) account (paper trading is free)

### Install

```bash
git clone https://github.com/mattohan567/openpaw.git
cd openpaw
pnpm install

# Set up Python sidecars
cd services/quant-analysis && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && deactivate && cd ../..
cd services/backtesting && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && deactivate && cd ../..
```

### Configure

```bash
# First run creates ~/.openpaw/config.json5 with defaults
pnpm dev gateway run
```

Edit `~/.openpaw/config.json5`:

```json5
{
  trading: {
    alpacaApiKey: "your-key",
    alpacaSecretKey: "your-secret",
    alpacaBaseUrl: "https://paper-api.alpaca.markets", // paper trading
    paperTrading: true,
    watchlist: ["AAPL", "NVDA", "TSLA"],
    maxPositionSize: 5000,    // max $ per trade
    maxPortfolioRisk: 0.15,   // max 15% of portfolio in one stock
  },
  agent: {
    provider: "xai",          // or "anthropic", "openai", "google", "openrouter"
    model: "grok-3-fast",
  },
  whatsapp: {
    ownerNumber: "+15551234567", // your number for notifications
  },
}
```

Set your LLM API key:
```bash
export XAI_API_KEY="your-key"        # for xai/grok
# or
export ANTHROPIC_API_KEY="your-key"  # for anthropic/claude
# or
export OPENAI_API_KEY="your-key"     # for openai/gpt
```

### Run

```bash
pnpm dev gateway run
```

This single command starts:
- The agent gateway (port 18790)
- Quant analysis service (port 8200) — auto-started
- Backtesting service (port 8300) — auto-started
- Real-time Alpaca streaming
- WhatsApp connection (scans QR code on first run)
- Heartbeat cron jobs (every 15 min during market hours)

## Tools (46 total)

### Trading (6)
`buy_stock` · `sell_stock` · `bracket_order` · `get_orders` · `cancel_order` · `get_market_calendar`

### Market Data (7)
`get_quote` · `get_bars` · `get_snapshot` · `get_news` · `get_top_movers` · `get_most_active` · `screen_stocks`

### Portfolio (8)
`get_account` · `get_positions` · `get_position` · `close_position` · `get_portfolio_history` · `get_watchlist` · `add_to_watchlist` · `remove_from_watchlist` · `clear_watchlist`

### Quant Analysis (3) — Python sidecar
`quant_analyze` · `quant_technical` · `quant_fundamentals`

5-strategy technical ensemble (trend following, mean reversion, momentum, volatility regime, statistical arbitrage) + fundamental scoring (profitability, growth, health, valuation) + headline sentiment. Pure math — no LLM calls. Data from yfinance.

### Backtesting (2) — Python sidecar
`backtest_strategy` · `optimize_strategy`

Test strategies against historical data before trading. Built-in strategies: RSI, SMA crossover, Bollinger bands, momentum, mean reversion. Parameter optimization sweeps thousands of combos in seconds via vectorbt.

### Research (5)
`get_insider_trades` · `get_earnings_calendar` · `get_short_interest` · `get_spy_benchmark` · `get_technicals`

### Risk Management (3)
`get_risk_report` · `check_trade_risk` · `get_trade_analytics`

### Alerts (5)
`set_price_alert` · `get_alerts` · `remove_alert` · `get_live_price` · `stream_symbols`

### Web Search (2)
`web_search` · `search_reddit`

### Memory (4)
`memory_read` · `memory_write` · `memory_search` · `memory_list`

## Trading Workflow

The agent follows a structured process:

1. **Screen** — Find candidates via movers, most active, news, Reddit
2. **Analyze** — Run `quant_analyze` for data-driven signals, plus deeper research
3. **Validate** — `backtest_strategy` to test the thesis against historical data
4. **Risk Check** — `check_trade_risk` before every buy. If BLOCKED, don't override.
5. **Execute** — Place the trade. `bracket_order` for automatic exits.
6. **Monitor** — `set_price_alert` for key levels. Real-time streaming.
7. **Review** — `get_risk_report` and `get_trade_analytics` to learn from trades.

## Project Structure

```
src/
  entry.ts          # CLI entry point
  cli.ts            # Commander CLI
  gateway.ts        # HTTP/WS server, orchestration
  agent.ts          # Pi SDK agent, system prompt, streaming
  session.ts        # JSONL transcript persistence
  memory.ts         # Daily logs + curated memory
  config.ts         # JSON5 config loading
  cron.ts           # Heartbeat, market open/close jobs
  streaming.ts      # Alpaca WebSocket, price alerts
  risk.ts           # Portfolio risk assessment
  analytics.ts      # Trade performance analytics
  sidecars.ts       # Python sidecar auto-start
  whatsapp.ts       # WhatsApp via Baileys
  tools/
    alpaca-trading.ts    # Buy/sell/bracket orders
    alpaca-market-data.ts # Quotes, bars, movers
    portfolio.ts         # Positions, watchlist
    research.ts          # SEC filings, technicals
    web-search.ts        # DuckDuckGo, Reddit
    alerts.ts            # Price alerts
    risk-tools.ts        # Risk reports
    quant.ts             # Quant sidecar bridge
    index.ts             # Tool registry
services/
  quant-analysis/    # Pure math analysis (FastAPI, port 8200)
  backtesting/       # vectorbt backtesting (FastAPI, port 8300)
```

## Disclaimer

This is an experimental project for educational purposes. It trades real money if configured with live Alpaca credentials. Use paper trading first. The authors are not responsible for any financial losses.
