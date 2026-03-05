import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";
import { appendFileSync } from "node:fs";

/** Validate URL path segments to prevent path traversal */
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;
function validateId(value: string, label: string): string | null {
  if (!SAFE_ID.test(value)) return `Invalid ${label}: contains unsafe characters.`;
  return null;
}

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
        const symbol = (params.symbol as string).toUpperCase();
        const qty = Number(params.qty);

        // Pre-trade safety checks
        const account = (await alpacaRequest(config, "/v2/account")) as Record<string, string>;
        const buyingPower = Number(account.buying_power);
        const portfolioValue = Number(account.portfolio_value);

        // Estimate order cost
        const quoteRes = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`, {
          headers: {
            "APCA-API-KEY-ID": config.trading.alpacaApiKey,
            "APCA-API-SECRET-KEY": config.trading.alpacaSecretKey,
          },
        });
        if (!quoteRes.ok) {
          return `Failed to get quote for ${symbol}: ${quoteRes.status}. Cannot validate trade safety.`;
        }
        const quoteData = (await quoteRes.json()) as Record<string, Record<string, number>>;
        const price = params.limit_price
          ? Number(params.limit_price)
          : quoteData.quote?.ap || quoteData.quote?.bp || 0;
        if (price <= 0) {
          return `Could not determine price for ${symbol}. Cannot validate trade safety.`;
        }
        const estimatedCost = price * qty;

        // Check max position size
        if (estimatedCost > config.trading.maxPositionSize) {
          return `BLOCKED: Order ~$${estimatedCost.toFixed(0)} exceeds max position size of $${config.trading.maxPositionSize}. Reduce qty or adjust config.`;
        }

        // Check buying power
        if (estimatedCost > buyingPower) {
          return `BLOCKED: Order ~$${estimatedCost.toFixed(0)} exceeds available buying power of $${buyingPower}. You can't afford this trade.`;
        }

        // Check portfolio concentration
        if (portfolioValue > 0) {
          // Get existing position in this stock
          let existingValue = 0;
          try {
            const pos = (await alpacaRequest(config, `/v2/positions/${symbol}`)) as Record<string, string>;
            existingValue = Number(pos.market_value) || 0;
          } catch {
            // No existing position
          }
          const totalExposure = existingValue + estimatedCost;
          const concentration = totalExposure / portfolioValue;
          if (concentration > config.trading.maxPortfolioRisk) {
            return `BLOCKED: This would put ${(concentration * 100).toFixed(0)}% of portfolio in ${symbol} (max ${(config.trading.maxPortfolioRisk * 100).toFixed(0)}%). Total exposure: $${totalExposure.toFixed(0)} of $${portfolioValue.toFixed(0)} portfolio.`;
          }
        }

        const order: Record<string, unknown> = {
          symbol,
          qty: String(qty),
          side: "buy",
          type: (params.order_type as string) || "market",
          time_in_force: (params.time_in_force as string) || "day",
        };
        if (params.limit_price) order.limit_price = String(params.limit_price);
        if (params.stop_price) order.stop_price = String(params.stop_price);

        const result = await alpacaRequest(config, "/v2/orders", "POST", order);
        logTrade(config, { action: "buy", ...order, estimatedCost, buyingPower, portfolioValue, result });
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
        const symbol = (params.symbol as string).toUpperCase();
        const qty = Number(params.qty);

        // Validate we actually hold enough shares
        try {
          const pos = (await alpacaRequest(config, `/v2/positions/${symbol}`)) as Record<string, string>;
          const held = Number(pos.qty) || 0;
          if (qty > held) {
            return `BLOCKED: Trying to sell ${qty} shares of ${symbol} but only holding ${held}.`;
          }
        } catch {
          return `BLOCKED: No open position in ${symbol}. Nothing to sell.`;
        }

        const order: Record<string, unknown> = {
          symbol,
          qty: String(qty),
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
        const orderId = params.order_id as string;
        const err = validateId(orderId, "order_id");
        if (err) return err;
        await alpacaRequest(config, `/v2/orders/${orderId}`, "DELETE");
        return `Order ${orderId} cancelled.`;
      },
    },
    {
      name: "bracket_order",
      description:
        "Place a buy order with automatic take-profit and stop-loss. Alpaca executes the exits server-side — no need for the agent to be awake. Use time_in_force 'gtc' (good till cancelled) so the exit orders persist across trading days.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          qty: { type: "number", description: "Number of shares to buy" },
          take_profit: { type: "number", description: "Take-profit price — sell when stock reaches this price" },
          stop_loss: { type: "number", description: "Stop-loss price — sell if stock drops to this price" },
          limit_price: { type: "number", description: "Limit price for the buy (omit for market order)" },
        },
        required: ["symbol", "qty", "take_profit", "stop_loss"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const qty = Number(params.qty);
        const takeProfit = Number(params.take_profit);
        const stopLoss = Number(params.stop_loss);

        // Same pre-trade checks as buy_stock
        const account = (await alpacaRequest(config, "/v2/account")) as Record<string, string>;
        const buyingPower = Number(account.buying_power);
        const portfolioValue = Number(account.portfolio_value);

        const quoteRes = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`, {
          headers: {
            "APCA-API-KEY-ID": config.trading.alpacaApiKey,
            "APCA-API-SECRET-KEY": config.trading.alpacaSecretKey,
          },
        });
        if (!quoteRes.ok) {
          return `Failed to get quote for ${symbol}: ${quoteRes.status}. Cannot validate trade safety.`;
        }
        const quoteData = (await quoteRes.json()) as Record<string, Record<string, number>>;
        const price = params.limit_price
          ? Number(params.limit_price)
          : quoteData.quote?.ap || quoteData.quote?.bp || 0;
        if (price <= 0) {
          return `Could not determine price for ${symbol}. Cannot validate trade safety.`;
        }
        const estimatedCost = price * qty;

        if (estimatedCost > config.trading.maxPositionSize) {
          return `BLOCKED: ~$${estimatedCost.toFixed(0)} exceeds max position size $${config.trading.maxPositionSize}.`;
        }
        if (estimatedCost > buyingPower) {
          return `BLOCKED: ~$${estimatedCost.toFixed(0)} exceeds buying power $${buyingPower}.`;
        }
        if (portfolioValue > 0) {
          let existingValue = 0;
          try {
            const pos = (await alpacaRequest(config, `/v2/positions/${symbol}`)) as Record<string, string>;
            existingValue = Number(pos.market_value) || 0;
          } catch {}
          const concentration = (existingValue + estimatedCost) / portfolioValue;
          if (concentration > config.trading.maxPortfolioRisk) {
            return `BLOCKED: Would put ${(concentration * 100).toFixed(0)}% of portfolio in ${symbol} (max ${(config.trading.maxPortfolioRisk * 100).toFixed(0)}%).`;
          }
        }

        const order: Record<string, unknown> = {
          symbol,
          qty: String(qty),
          side: "buy",
          type: params.limit_price ? "limit" : "market",
          time_in_force: "gtc",
          order_class: "bracket",
          take_profit: { limit_price: String(takeProfit) },
          stop_loss: { stop_price: String(stopLoss) },
        };
        if (params.limit_price) order.limit_price = String(params.limit_price);

        const result = await alpacaRequest(config, "/v2/orders", "POST", order);
        logTrade(config, {
          action: "bracket_buy",
          ...order,
          estimatedCost,
          takeProfit,
          stopLoss,
          result,
        });
        return JSON.stringify(result);
      },
    },
    {
      name: "get_market_calendar",
      description: "Get market calendar — check if the market is open on specific dates, early close days, and holidays.",
      inputSchema: {
        type: "object" as const,
        properties: {
          start: { type: "string", description: "Start date YYYY-MM-DD (default: today)" },
          end: { type: "string", description: "End date YYYY-MM-DD (default: 10 days from start)" },
        },
      },
      execute: async (params) => {
        const start = (params.start as string) || new Date().toISOString().split("T")[0];
        const end = (params.end as string) || new Date(Date.now() + 10 * 86400000).toISOString().split("T")[0];
        const result = await alpacaRequest(config, `/v2/calendar?start=${start}&end=${end}`);
        return JSON.stringify(result);
      },
    },
  ];
}
