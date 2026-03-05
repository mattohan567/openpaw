import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";
import { appendFileSync } from "node:fs";

function alpacaHeaders(config: OpenPawConfig) {
  return {
    "APCA-API-KEY-ID": config.trading.alpacaApiKey,
    "APCA-API-SECRET-KEY": config.trading.alpacaSecretKey,
    "Content-Type": "application/json",
  };
}

async function alpacaRequest(
  config: OpenPawConfig,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `${config.trading.alpacaBaseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: alpacaHeaders(config),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

function logTrade(config: OpenPawConfig, trade: Record<string, unknown>) {
  const entry = { ...trade, timestamp: new Date().toISOString() };
  appendFileSync(config.tradeLogFile, JSON.stringify(entry) + "\n");
}

export function createAlpacaTradingTools(config: OpenPawConfig): Tool[] {
  return [
    {
      name: "buy_stock",
      description:
        "Buy shares of a stock. Specify the ticker symbol, quantity, and order type (market, limit, stop). For limit/stop orders, provide the limit_price or stop_price.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL, NVDA)" },
          qty: { type: "number", description: "Number of shares to buy" },
          order_type: {
            type: "string",
            enum: ["market", "limit", "stop", "stop_limit"],
            description: "Order type (default: market)",
          },
          limit_price: { type: "number", description: "Limit price (required for limit/stop_limit orders)" },
          stop_price: { type: "number", description: "Stop price (required for stop/stop_limit orders)" },
          time_in_force: {
            type: "string",
            enum: ["day", "gtc", "ioc", "fok"],
            description: "Time in force (default: day)",
          },
        },
        required: ["symbol", "qty"],
      },
      execute: async (params) => {
        const order: Record<string, unknown> = {
          symbol: (params.symbol as string).toUpperCase(),
          qty: String(params.qty),
          side: "buy",
          type: (params.order_type as string) || "market",
          time_in_force: (params.time_in_force as string) || "day",
        };
        if (params.limit_price) order.limit_price = String(params.limit_price);
        if (params.stop_price) order.stop_price = String(params.stop_price);

        const result = await alpacaRequest(config, "/v2/orders", "POST", order);
        logTrade(config, { action: "buy", ...order, result });
        return JSON.stringify(result);
      },
    },
    {
      name: "sell_stock",
      description:
        "Sell shares of a stock. Specify the ticker symbol, quantity, and order type (market, limit, stop). For limit/stop orders, provide the limit_price or stop_price.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          qty: { type: "number", description: "Number of shares to sell" },
          order_type: {
            type: "string",
            enum: ["market", "limit", "stop", "stop_limit"],
            description: "Order type (default: market)",
          },
          limit_price: { type: "number", description: "Limit price" },
          stop_price: { type: "number", description: "Stop price" },
          time_in_force: {
            type: "string",
            enum: ["day", "gtc", "ioc", "fok"],
            description: "Time in force (default: day)",
          },
        },
        required: ["symbol", "qty"],
      },
      execute: async (params) => {
        const order: Record<string, unknown> = {
          symbol: (params.symbol as string).toUpperCase(),
          qty: String(params.qty),
          side: "sell",
          type: (params.order_type as string) || "market",
          time_in_force: (params.time_in_force as string) || "day",
        };
        if (params.limit_price) order.limit_price = String(params.limit_price);
        if (params.stop_price) order.stop_price = String(params.stop_price);

        const result = await alpacaRequest(config, "/v2/orders", "POST", order);
        logTrade(config, { action: "sell", ...order, result });
        return JSON.stringify(result);
      },
    },
    {
      name: "get_orders",
      description: "List open orders, or filter by status (open, closed, all).",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", enum: ["open", "closed", "all"], description: "Order status filter (default: open)" },
          limit: { type: "number", description: "Max number of orders to return (default: 50)" },
        },
      },
      execute: async (params) => {
        const status = (params.status as string) || "open";
        const limit = (params.limit as number) || 50;
        const result = await alpacaRequest(config, `/v2/orders?status=${status}&limit=${limit}`);
        return JSON.stringify(result);
      },
    },
    {
      name: "cancel_order",
      description: "Cancel a pending order by its order ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          order_id: { type: "string", description: "The order ID to cancel" },
        },
        required: ["order_id"],
      },
      execute: async (params) => {
        await alpacaRequest(config, `/v2/orders/${params.order_id}`, "DELETE");
        return `Order ${params.order_id} cancelled.`;
      },
    },
  ];
}
