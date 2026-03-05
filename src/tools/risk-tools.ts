import type { Tool } from "./types.js";
import type { OpenPawConfig } from "../config.js";
import {
  assessPortfolioRisk,
  preTradeRiskCheck,
  formatRiskReport,
  DEFAULT_RISK_CONFIG,
  type RiskConfig,
} from "../risk.js";
import {
  loadTradeLog,
  analyzeTradePerformance,
  formatTradeReport,
  getRecentTrades,
} from "../analytics.js";

function alpacaHeaders(config: OpenPawConfig) {
  return {
    "APCA-API-KEY-ID": config.trading.alpacaApiKey,
    "APCA-API-SECRET-KEY": config.trading.alpacaSecretKey,
  };
}

export function createRiskTools(config: OpenPawConfig): Tool[] {
  // Read from config at execution time so runtime changes are reflected
  function getRiskConfig(): RiskConfig {
    return {
      ...DEFAULT_RISK_CONFIG,
      ...config.risk,
      maxPositionSize: config.trading.maxPositionSize,
      maxPortfolioRisk: config.trading.maxPortfolioRisk,
    };
  }

  return [
    {
      name: "get_risk_report",
      description:
        "Get a comprehensive portfolio risk assessment: daily P&L vs limits, position concentration, aging positions, and an overall risk score (0-100). Run this before making trading decisions.",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => {
        try {
          const [accountRes, positionsRes] = await Promise.all([
            fetch(`${config.trading.alpacaBaseUrl}/v2/account`, { headers: alpacaHeaders(config) }),
            fetch(`${config.trading.alpacaBaseUrl}/v2/positions`, { headers: alpacaHeaders(config) }),
          ]);

          if (!accountRes.ok) return `Alpaca account API error: ${accountRes.status}`;
          if (!positionsRes.ok) return `Alpaca positions API error: ${positionsRes.status}`;

          const account = (await accountRes.json()) as Record<string, unknown>;
          const positions = (await positionsRes.json()) as Record<string, unknown>[];

          const risk = assessPortfolioRisk(account, positions, getRiskConfig());
          return formatRiskReport(risk);
        } catch (err) {
          return `Risk assessment failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
    {
      name: "check_trade_risk",
      description:
        "Pre-trade risk check for a proposed buy. Checks daily loss limits, buying power, concentration, position count. Returns clear BLOCK or ALLOW with any warnings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          estimated_cost: { type: "number", description: "Estimated cost of the trade in dollars" },
        },
        required: ["symbol", "estimated_cost"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const estimatedCost = Number(params.estimated_cost);

        try {
          const [accountRes, positionsRes] = await Promise.all([
            fetch(`${config.trading.alpacaBaseUrl}/v2/account`, { headers: alpacaHeaders(config) }),
            fetch(`${config.trading.alpacaBaseUrl}/v2/positions`, { headers: alpacaHeaders(config) }),
          ]);

          if (!accountRes.ok) return `Alpaca account API error: ${accountRes.status}`;
          if (!positionsRes.ok) return `Alpaca positions API error: ${positionsRes.status}`;

          const account = (await accountRes.json()) as Record<string, unknown>;
          const positions = (await positionsRes.json()) as Record<string, unknown>[];

          const check = preTradeRiskCheck(symbol, estimatedCost, account, positions, getRiskConfig());

          const parts: string[] = [];
          if (check.blocks.length > 0) {
            parts.push(`*BLOCKED*\n${check.blocks.join("\n")}`);
          } else {
            parts.push("*ALLOWED*");
          }
          if (check.warnings.length > 0) {
            parts.push(`\nWarnings:\n${check.warnings.join("\n")}`);
          }

          return parts.join("\n");
        } catch (err) {
          return `Risk check failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
    {
      name: "get_trade_analytics",
      description:
        "Analyze your trading performance: win rate, P&L, Sharpe ratio, max drawdown, best/worst trades, patterns by day/time. Use this to learn what's working and what isn't.",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: { type: "number", description: "Analyze last N days (default: all history)" },
        },
      },
      execute: async (params) => {
        try {
          let trades = loadTradeLog(config.tradeLogFile);

          if (params.days) {
            trades = getRecentTrades(trades, Number(params.days));
          }

          if (trades.length === 0) {
            return "No trades in history yet. Start trading to build analytics.";
          }

          const stats = analyzeTradePerformance(trades);
          return formatTradeReport(stats);
        } catch (err) {
          return `Analytics failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
  ];
}
