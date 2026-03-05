import type { Tool } from "./types.js";
import type { AlpacaStream } from "../streaming.js";

export function createAlertTools(stream: AlpacaStream | null): Tool[] {
  if (!stream) return [];

  return [
    {
      name: "set_price_alert",
      description:
        "Set a real-time price alert. You'll be notified instantly when a stock hits your target — no need to poll. Use for entry/exit triggers, breakout alerts, support/resistance levels.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          condition: {
            type: "string",
            description: "'above' (price goes above target), 'below' (drops below), or 'crosses' (either direction)",
          },
          price: { type: "number", description: "Target price" },
          message: { type: "string", description: "Why you set this alert (for context when it triggers)" },
        },
        required: ["symbol", "condition", "price"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const condition = params.condition as "above" | "below" | "crosses";
        const price = Number(params.price);
        const message = params.message as string | undefined;

        if (!["above", "below", "crosses"].includes(condition)) {
          return "Invalid condition. Use 'above', 'below', or 'crosses'.";
        }

        // Subscribe to this symbol's stream if not already
        stream.subscribe([symbol]);

        const id = stream.addAlert({ symbol, condition, price, message });

        const lastPrice = stream.getLastPrice(symbol);
        const priceInfo = lastPrice ? ` (last: $${lastPrice.toFixed(2)})` : "";

        return `Alert set: ${symbol} ${condition} $${price.toFixed(2)}${priceInfo}. ID: ${id}`;
      },
    },
    {
      name: "get_alerts",
      description: "List all active price alerts. Shows which are still waiting and which have triggered.",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => {
        const alerts = stream.getAlerts();
        if (alerts.length === 0) return "No active alerts.";

        const lines = alerts.map((a) => {
          const status = a.triggered ? "TRIGGERED" : "waiting";
          const lastPrice = stream.getLastPrice(a.symbol);
          const priceInfo = lastPrice ? ` (last: $${lastPrice.toFixed(2)})` : "";
          return `${a.symbol} ${a.condition} $${a.price.toFixed(2)} [${status}]${priceInfo}${a.message ? ` — ${a.message}` : ""}`;
        });

        return lines.join("\n");
      },
    },
    {
      name: "remove_alert",
      description: "Remove a price alert by its ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          alert_id: { type: "string", description: "Alert ID to remove" },
        },
        required: ["alert_id"],
      },
      execute: async (params) => {
        const removed = stream.removeAlert(params.alert_id as string);
        return removed ? "Alert removed." : "Alert not found.";
      },
    },
    {
      name: "get_live_price",
      description:
        "Get the latest real-time price from the live stream. Faster than get_quote because it uses cached WebSocket data. Only works for symbols you're streaming.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const price = stream.getLastPrice(symbol);

        if (price === null) {
          // Subscribe and return message
          stream.subscribe([symbol]);
          return `No cached price for ${symbol} yet — just subscribed to live stream. Try again in a few seconds, or use get_quote for immediate data.`;
        }

        const quote = stream.getLastQuote(symbol);
        const parts = [`${symbol}: $${price.toFixed(2)}`];
        if (quote) {
          parts.push(`bid: $${quote.bid.toFixed(2)} / ask: $${quote.ask.toFixed(2)}`);
          parts.push(`spread: $${(quote.ask - quote.bid).toFixed(4)}`);
        }

        return parts.join(" | ");
      },
    },
    {
      name: "stream_symbols",
      description:
        "Subscribe to real-time price streaming for symbols. Once streaming, you get instant price alerts and cached live prices via get_live_price.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbols: { type: "string", description: "Comma-separated ticker symbols to stream" },
        },
        required: ["symbols"],
      },
      execute: async (params) => {
        const symbols = (params.symbols as string)
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);

        stream.subscribe(symbols);
        return `Now streaming: ${symbols.join(", ")}. Use get_live_price or set_price_alert on these symbols.`;
      },
    },
  ];
}
