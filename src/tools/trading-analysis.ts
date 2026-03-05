import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";

export function createAnalysisTools(config: OpenPawConfig): Tool[] {
  return [
    {
      name: "analyze_stock",
      description:
        "Run a deep multi-agent analysis on a stock using TradingAgents. This calls fundamental, sentiment, technical, and news analysts, runs a bull vs bear debate, and returns a BUY/SELL/HOLD recommendation with reasoning. Takes 30-60 seconds.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol (e.g. NVDA)" },
          date: {
            type: "string",
            description: "Analysis date in YYYY-MM-DD format (default: today)",
          },
          analysts: {
            type: "string",
            description:
              'Comma-separated list of analysts to run: market,social,news,fundamentals (default: all)',
          },
        },
        required: ["ticker"],
      },
      execute: async (params) => {
        const ticker = (params.ticker as string).toUpperCase();
        const date = (params.date as string) || new Date().toISOString().split("T")[0];
        const analysts = params.analysts
          ? (params.analysts as string).split(",").map((a) => a.trim())
          : ["market", "social", "news", "fundamentals"];

        try {
          const res = await fetch(`${config.tradingAgentsUrl}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticker, date, analysts }),
          });

          if (!res.ok) {
            const text = await res.text();
            throw new Error(`TradingAgents sidecar error: ${res.status} ${text}`);
          }

          const result = await res.json();
          return JSON.stringify(result);
        } catch (err) {
          if (err instanceof Error && err.message.includes("ECONNREFUSED")) {
            return "TradingAgents sidecar is not running. Start it with: cd services/trading-agents && python server.py";
          }
          throw err;
        }
      },
    },
  ];
}
