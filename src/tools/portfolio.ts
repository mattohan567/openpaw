import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";

function alpacaHeaders(config: OpenPawConfig) {
  return {
    "APCA-API-KEY-ID": config.trading.alpacaApiKey,
    "APCA-API-SECRET-KEY": config.trading.alpacaSecretKey,
  };
}

async function alpacaRequest(config: OpenPawConfig, path: string): Promise<unknown> {
  const res = await fetch(`${config.trading.alpacaBaseUrl}${path}`, {
    headers: alpacaHeaders(config),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca API ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

export function createPortfolioTools(config: OpenPawConfig): Tool[] {
  return [
    {
      name: "get_account",
      description:
        "Get Alpaca account info: buying power, equity, cash, portfolio value, P&L, and whether the account is paper trading.",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => {
        const account = (await alpacaRequest(config, "/v2/account")) as Record<string, unknown>;
        return JSON.stringify({
          status: account.status,
          buying_power: account.buying_power,
          cash: account.cash,
          equity: account.equity,
          portfolio_value: account.portfolio_value,
          last_equity: account.last_equity,
          long_market_value: account.long_market_value,
          short_market_value: account.short_market_value,
          paper_trading: config.trading.paperTrading,
        });
      },
    },
    {
      name: "get_positions",
      description: "Get all current stock positions with unrealized P&L, quantity, average cost, and current price.",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => {
        const positions = await alpacaRequest(config, "/v2/positions");
        return JSON.stringify(positions);
      },
    },
    {
      name: "get_position",
      description: "Get position details for a specific stock.",
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
          const position = await alpacaRequest(config, `/v2/positions/${symbol}`);
          return JSON.stringify(position);
        } catch {
          return `No open position in ${symbol}.`;
        }
      },
    },
    {
      name: "close_position",
      description: "Close an entire position in a stock (sell all shares).",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol to close" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const res = await fetch(`${config.trading.alpacaBaseUrl}/v2/positions/${symbol}`, {
          method: "DELETE",
          headers: alpacaHeaders(config),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Failed to close position ${symbol}: ${res.status} ${text}`);
        }
        return `Position in ${symbol} closed.`;
      },
    },
    {
      name: "get_portfolio_history",
      description:
        "Get portfolio value history over a time period. Useful for charting P&L over time.",
      inputSchema: {
        type: "object" as const,
        properties: {
          period: {
            type: "string",
            description: "Time period: 1D, 1W, 1M, 3M, 1A (1 day, 1 week, 1 month, 3 months, 1 year)",
          },
          timeframe: {
            type: "string",
            description: "Bar timeframe: 1Min, 5Min, 15Min, 1H, 1D",
          },
        },
      },
      execute: async (params) => {
        const period = (params.period as string) || "1D";
        const tf = (params.timeframe as string) || "1H";
        const result = await alpacaRequest(
          config,
          `/v2/account/portfolio/history?period=${period}&timeframe=${tf}`,
        );
        return JSON.stringify(result);
      },
    },
    {
      name: "get_watchlist",
      description: "Get the current watchlist of tickers that OpenPaw monitors.",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => {
        return JSON.stringify({
          watchlist: config.trading.watchlist,
          maxPositionSize: config.trading.maxPositionSize,
          maxPortfolioRisk: config.trading.maxPortfolioRisk,
          paperTrading: config.trading.paperTrading,
        });
      },
    },
  ];
}
