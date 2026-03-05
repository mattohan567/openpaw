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
