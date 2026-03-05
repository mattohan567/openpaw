import type { Tool } from "./types.js";

const QUANT_BASE = "http://127.0.0.1:8200";
const BACKTEST_BASE = "http://127.0.0.1:8300";

async function quantRequest(path: string): Promise<string> {
  const res = await fetch(`${QUANT_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Quant service ${path}: ${res.status} ${text}`);
  }
  return JSON.stringify(await res.json());
}

async function backtestRequest(path: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BACKTEST_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backtest service ${path}: ${res.status} ${text}`);
  }
  return JSON.stringify(await res.json());
}

export function createQuantTools(): Tool[] {
  return [
    {
      name: "quant_analyze",
      description:
        "Run a full quantitative analysis on a stock: technical signals (5 strategies), fundamental scores, sentiment, and a composite signal. Pure math — no LLM. Uses yfinance data. Returns bullish/bearish/neutral with confidence scores. Use this BEFORE trading to get a data-driven view.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA)" },
          period: { type: "string", description: "Data period: 1mo, 3mo, 6mo, 1y (default: 6mo)" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const period = (params.period as string) || "6mo";
        try {
          return await quantRequest(`/analyze/${symbol}?period=${period}`);
        } catch (err) {
          return `Quant analysis failed (is the quant service running on port 8200?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "quant_technical",
      description:
        "Technical analysis only: runs 5 strategies (trend following, mean reversion, momentum, volatility regime, statistical arbitrage) and returns a weighted ensemble signal. Use for quick technical reads.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          period: { type: "string", description: "Data period (default: 6mo)" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const period = (params.period as string) || "6mo";
        try {
          return await quantRequest(`/technical/${symbol}?period=${period}`);
        } catch (err) {
          return `Technical analysis failed (is the quant service running on port 8200?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "quant_fundamentals",
      description:
        "Fundamental analysis: scores profitability (ROE, margins), growth (revenue, earnings), financial health (debt, current ratio), and valuation (P/E, P/B, PEG). Each category 0-10, total 0-40. Higher is better.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        try {
          return await quantRequest(`/fundamentals/${symbol}`);
        } catch (err) {
          return `Fundamental analysis failed (is the quant service running on port 8200?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "backtest_strategy",
      description:
        "Backtest a trading strategy on historical data before committing real capital. Strategies: 'rsi' (buy oversold/sell overbought), 'sma_crossover' (moving average crossover), 'bollinger' (Bollinger band bounce), 'momentum' (ROC + volume), 'mean_reversion' (std dev reversion). Returns total return, Sharpe ratio, max drawdown, win rate, and comparison vs buy-and-hold.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          strategy: {
            type: "string",
            description: "Strategy name: rsi, sma_crossover, bollinger, momentum, mean_reversion",
          },
          params: {
            type: "string",
            description:
              'Strategy params as JSON string, e.g. \'{"rsi_period":14,"oversold":30,"overbought":70}\'. Omit for defaults.',
          },
          period: { type: "string", description: "Backtest period: 6mo, 1y, 2y (default: 1y)" },
          initial_capital: { type: "number", description: "Starting capital in dollars (default: 10000)" },
        },
        required: ["symbol", "strategy"],
      },
      execute: async (params) => {
        const body: Record<string, unknown> = {
          symbol: (params.symbol as string).toUpperCase(),
          strategy: params.strategy as string,
          period: (params.period as string) || "1y",
          initial_capital: (params.initial_capital as number) || 10000,
        };
        if (params.params) {
          try {
            body.params = JSON.parse(params.params as string);
          } catch {
            return "Invalid params JSON. Example: {\"rsi_period\":14,\"oversold\":30,\"overbought\":70}";
          }
        }
        try {
          return await backtestRequest("/backtest", body);
        } catch (err) {
          return `Backtest failed (is the backtest service running on port 8300?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "get_vwap",
      description:
        "Get real-time VWAP (Volume-Weighted Average Price) with bands for a stock. VWAP is the #1 day trading indicator — price above VWAP = bullish bias, below = bearish. Also returns upper/lower bands (1 and 2 std devs) as support/resistance levels.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        try {
          return await quantRequest(`/vwap/${symbol}`);
        } catch (err) {
          return `VWAP failed (is the quant service running?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "scan_gaps",
      description:
        "Scan for stocks gapping up or down from previous close. Gap-and-go is one of the highest-probability day trading setups. Filters by minimum gap %, minimum volume, and max price. Returns sorted by gap size.",
      inputSchema: {
        type: "object" as const,
        properties: {
          min_gap_pct: { type: "number", description: "Minimum gap % from prev close (default: 4)" },
          min_volume: { type: "number", description: "Minimum volume (default: 100000)" },
          max_price: { type: "number", description: "Max stock price to include (default: 50)" },
        },
      },
      execute: async (params) => {
        const qp = new URLSearchParams();
        if (params.min_gap_pct) qp.set("min_gap_pct", String(params.min_gap_pct));
        if (params.min_volume) qp.set("min_volume", String(params.min_volume));
        if (params.max_price) qp.set("max_price", String(params.max_price));
        const qs = qp.toString() ? `?${qp.toString()}` : "";
        try {
          return await quantRequest(`/gaps${qs}`);
        } catch (err) {
          return `Gap scan failed (is the quant service running?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "calc_position_size",
      description:
        "Calculate ATR-based position size for a stock. Uses volatility (ATR) to determine stop-loss distance, then sizes the position so you risk a fixed % of equity. Returns recommended shares, stop price, and take-profit levels at 1:1, 1.5:1, and 2:1 risk/reward.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          account_equity: { type: "number", description: "Your account equity in dollars" },
          risk_pct: { type: "number", description: "Risk per trade as % of equity (default: 1.0)" },
          atr_multiplier: { type: "number", description: "ATR multiplier for stop distance (default: 2.0)" },
        },
        required: ["symbol", "account_equity"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const equity = Number(params.account_equity);
        const risk = params.risk_pct ? Number(params.risk_pct) : 1.0;
        const atrMult = params.atr_multiplier ? Number(params.atr_multiplier) : 2.0;
        try {
          return await quantRequest(
            `/position_size/${symbol}?account_equity=${equity}&risk_pct=${risk}&atr_multiplier=${atrMult}`,
          );
        } catch (err) {
          return `Position sizing failed (is the quant service running?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "optimize_strategy",
      description:
        "Find the best parameters for a strategy by testing many combinations. Returns top 3 parameter sets ranked by Sharpe ratio (or other metric). Use this to tune a strategy before trading it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          strategy: {
            type: "string",
            description: "Strategy name: rsi, sma_crossover, bollinger, momentum, mean_reversion",
          },
          param_ranges: {
            type: "string",
            description:
              'JSON of param arrays to sweep, e.g. \'{"rsi_period":[10,14,20],"oversold":[25,30,35],"overbought":[65,70,75]}\'',
          },
          period: { type: "string", description: "Backtest period (default: 1y)" },
          optimize_by: { type: "string", description: "Metric to optimize: sharpe_ratio, total_return_pct, win_rate_pct (default: sharpe_ratio)" },
        },
        required: ["symbol", "strategy", "param_ranges"],
      },
      execute: async (params) => {
        let paramRanges: Record<string, unknown>;
        try {
          paramRanges = JSON.parse(params.param_ranges as string);
        } catch {
          return "Invalid param_ranges JSON.";
        }
        const body: Record<string, unknown> = {
          symbol: (params.symbol as string).toUpperCase(),
          strategy: params.strategy as string,
          param_ranges: paramRanges,
          period: (params.period as string) || "1y",
          initial_capital: 10000,
          optimize_by: (params.optimize_by as string) || "sharpe_ratio",
        };
        try {
          return await backtestRequest("/optimize", body);
        } catch (err) {
          return `Optimization failed (is the backtest service running on port 8300?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
  ];
}
