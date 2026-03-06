# OpenPaw

Autonomous stock trading agent that runs on your computer 24/7. Screens markets, analyzes stocks with quantitative models, debates every trade (bull vs bear vs risk), detects market regimes, optimizes portfolios, backtests with overfitting detection, and keeps you in the loop via WhatsApp.

Built on the same [Pi SDK](https://github.com/badlogic/pi-mono) agent engine as [OpenClaw](https://github.com/openclaw/openclaw).

## What It Does

- **Screens** — Scans top movers, most active, news, Reddit sentiment, insider trades, gap-up/gap-down stocks
- **Analyzes** — 5-strategy technical ensemble + fundamental scoring + sentiment + DCF valuation (pure math, no LLM)
- **Debates** — Structured bull/bear/risk debate before every trade. Only proceeds if bull > bear by 20%+ AND risk is manageable
- **Detects Regimes** — HMM-based regime detection (bull/bear/sideways) with dynamic strategy weights. Macro awareness (VIX, sectors, bonds)
- **Backtests** — Walk-forward validation with overfitting detection. Realistic 0.2% fees. Flags IS-vs-OOS gaps > 50%
- **Optimizes** — Mean-variance portfolio optimization, correlation analysis, adaptive strategy selection from trade history
- **Risk Checks** — Daily loss limits, position concentration, aging positions, earnings proximity, risk scoring
- **Trades** — Buys, sells, bracket orders, trailing stops via Alpaca
- **Monitors** — Real-time price streaming, price alerts, portfolio tracking
- **Reports** — Morning briefings, end-of-day reports, trade post-mortems, SPY benchmarking
- **Learns** — Auto post-mortems on closed trades, strategy performance tracking by regime, persistent memory across restarts

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
│  │            65 Tools                         │  │
│  │  Trading · Market Data · Portfolio · Risk   │  │
│  │  Research · Alerts · Memory · Quant · Web   │  │
│  │  Macro · Debate · Valuation · Strategy      │  │
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
  │ 20 endpts  │    │ 5 endpoints     │
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
    thinkingLevel: "medium",  // "off", "low", "medium", "high" for extended thinking
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

## Tools (65 total)

### Trading (8)
`buy_stock` · `sell_stock` · `bracket_order` · `trailing_stop_order` · `replace_stop_with_trailing` · `get_orders` · `cancel_order` · `get_market_calendar`

### Market Data (7)
`get_quote` · `get_bars` · `get_snapshot` · `get_news` · `get_top_movers` · `get_most_active` · `screen_stocks`

### Portfolio (8)
`get_account` · `get_positions` · `get_position` · `close_position` · `get_portfolio_history` · `get_watchlist` · `add_to_watchlist` · `remove_from_watchlist` · `clear_watchlist`

### Macro (3)
`get_market_regime` · `get_sector_rotation` · `get_macro_dashboard`

VIX-based regime detection (risk-on/risk-off/transition), 11 sector ETF rotation analysis, combined dashboard with bonds. The agent checks macro before every trade and adjusts position sizing by regime.

### Quant Analysis (13) — Python sidecar
`quant_analyze` · `quant_technical` · `quant_fundamentals` · `get_vwap` · `scan_gaps` · `calc_position_size` · `get_regime` · `get_correlations` · `optimize_portfolio` · `get_earnings` · `check_earnings_risk` · `backtest_strategy` · `optimize_strategy`

- **5-strategy ensemble** — trend following, mean reversion, momentum, volatility regime, statistical arbitrage
- **HMM regime detection** — 3-state Hidden Markov Model on returns + volatility → dynamic strategy weights per regime
- **Portfolio optimization** — mean-variance (max Sharpe + min variance), pairwise correlation matrix, rebalance trades
- **Earnings calendar** — upcoming earnings dates with gap risk warnings
- **VWAP** — intraday VWAP with bands for intraday bias
- **Position sizing** — ATR-based with Kelly Criterion adjustment

### Backtesting (3) — Python sidecar
`backtest_strategy` · `walkforward_backtest` · `get_strategy_recommendations`

- **Walk-forward validation** — N-fold IS/OOS testing with overfitting detection. Flags >50% performance gap
- **Realistic costs** — 0.2% fees (commission + slippage)
- **Adaptive strategy selection** — ranks strategies by win rate and returns per regime from trade history

### Debate & Valuation (3)
`debate_trade` · `get_valuation` · `get_strategy_recommendations`

- **Structured debate** — bull case, bear case, and risk assessment run in parallel. Only proceeds if bull > bear by 20%+ AND risk score < 60
- **DCF valuation** — intrinsic value estimate with margin of safety. Falls back to multiples (P/E, P/B, PEG, EV/EBITDA)

### Research (5)
`get_insider_trades` · `get_earnings_calendar` · `get_short_interest` · `get_spy_benchmark` · `get_technicals`

### Risk Management (4)
`get_risk_report` · `check_trade_risk` · `get_trade_analytics` · `review_closed_trades`

Risk reports include time-of-day trading zones, drawdown circuit breaker, and auto post-mortems. Pre-trade checks block trades during unfavorable conditions.

### Alerts (5)
`set_price_alert` · `get_alerts` · `remove_alert` · `get_live_price` · `stream_symbols`

### Web Search (2)
`web_search` · `search_reddit`

### Memory (4)
`memory_read` · `memory_write` · `memory_search` · `memory_list`

### Notifications (1)
`notify_owner`

## Trading Workflow

The agent follows a structured 12-step process:

1. **Macro Check** — `get_market_regime` first. Risk-off (VIX>25) → reduce size 50%
2. **Screen** — Find candidates via movers, most active, gaps, news, Reddit
3. **VWAP Check** — Price above VWAP = long bias, below = short bias
4. **Analyze** — `quant_analyze` + `get_valuation` for data-driven signals
5. **Debate** — `debate_trade` REQUIRED before every new position. Bull vs bear vs risk
6. **Validate** — `walkforward_backtest` to test thesis. >50% IS/OOS gap = overfit
7. **Earnings Check** — `get_earnings` — skip if reporting within 3 days
8. **Size** — `calc_position_size` with regime size modifier. ATR-based stops
9. **Risk Check** — `check_trade_risk` — if BLOCKED, don't override
10. **Execute** — `bracket_order` with automatic stop-loss and take-profit
11. **Monitor** — Trailing stops after 1 ATR move. Price alerts on key levels
12. **Review** — Weekly post-mortems, strategy adaptation, portfolio rebalancing

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
    alpaca-trading.ts    # Buy/sell/bracket/trailing stops
    alpaca-market-data.ts # Quotes, bars, movers
    portfolio.ts         # Positions, watchlist
    research.ts          # SEC filings, technicals
    web-search.ts        # DuckDuckGo, Reddit
    alerts.ts            # Price alerts
    risk-tools.ts        # Risk reports, post-mortems
    quant.ts             # Quant sidecar bridge
    macro.ts             # Macro regime tools
    debate.ts            # Trade debate, valuation, strategy recommendations
    index.ts             # Tool registry
services/
  quant-analysis/    # Analysis + macro + regime + portfolio + debate (FastAPI, port 8200)
  backtesting/       # Backtesting + walk-forward + strategy perf (FastAPI, port 8300)
```

## Disclaimer

This is an experimental project for educational purposes. It trades real money if configured with live Alpaca credentials. Use paper trading first. The authors are not responsible for any financial losses.
