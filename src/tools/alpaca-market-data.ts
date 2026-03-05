import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";

const DATA_BASE_URL = "https://data.alpaca.markets";

function dataHeaders(config: OpenPawConfig) {
  return {
    "APCA-API-KEY-ID": config.trading.alpacaApiKey,
    "APCA-API-SECRET-KEY": config.trading.alpacaSecretKey,
  };
}

async function dataRequest(config: OpenPawConfig, path: string): Promise<unknown> {
  const res = await fetch(`${DATA_BASE_URL}${path}`, {
    headers: dataHeaders(config),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca Data API ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

export function createMarketDataTools(config: OpenPawConfig): Tool[] {
  return [
    {
      name: "get_quote",
      description: "Get the latest quote (bid/ask/last price) for a stock ticker.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL)" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const result = await dataRequest(config, `/v2/stocks/${symbol}/quotes/latest`);
        return JSON.stringify(result);
      },
    },
    {
      name: "get_bars",
      description:
        "Get historical price bars (OHLCV) for a stock. Specify timeframe like 1Day, 1Hour, 15Min. Returns up to limit bars.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          timeframe: {
            type: "string",
            description: "Bar timeframe: 1Min, 5Min, 15Min, 1Hour, 1Day, 1Week, 1Month",
          },
          start: { type: "string", description: "Start date (ISO 8601, e.g. 2026-01-01)" },
          end: { type: "string", description: "End date (ISO 8601)" },
          limit: { type: "number", description: "Max bars to return (default: 100)" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const tf = (params.timeframe as string) || "1Day";
        const limit = (params.limit as number) || 100;
        let path = `/v2/stocks/${symbol}/bars?timeframe=${tf}&limit=${limit}`;
        if (params.start) path += `&start=${params.start}`;
        if (params.end) path += `&end=${params.end}`;
        const result = await dataRequest(config, path);
        return JSON.stringify(result);
      },
    },
    {
      name: "get_snapshot",
      description:
        "Get a full snapshot of a stock including latest trade, quote, minute bar, daily bar, and prev daily bar.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const result = await dataRequest(config, `/v2/stocks/${symbol}/snapshot`);
        return JSON.stringify(result);
      },
    },
    {
      name: "get_news",
      description: "Get recent news articles for a stock or the market. Returns headlines, summaries, and sources.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbols: { type: "string", description: "Comma-separated ticker symbols (e.g. AAPL,NVDA)" },
          limit: { type: "number", description: "Max articles (default: 10)" },
        },
      },
      execute: async (params) => {
        let path = "/v1beta1/news?";
        if (params.symbols) path += `symbols=${params.symbols}&`;
        path += `limit=${(params.limit as number) || 10}`;
        const result = await dataRequest(config, path);
        return JSON.stringify(result);
      },
    },
  ];
}
