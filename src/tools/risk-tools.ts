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
    {
      name: "review_closed_trades",
      description:
        "Review recently closed positions and generate a post-mortem. Checks trades closed in the last N days, computes P&L, and identifies lessons learned. Use this regularly to improve your trading.",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: { type: "number", description: "Review trades from last N days (default: 7)" },
        },
      },
      execute: async (params) => {
        const days = params.days ? Number(params.days) : 7;

        try {
          // Fetch closed orders from Alpaca
          const ordersRes = await fetch(
            `${config.trading.alpacaBaseUrl}/v2/orders?status=closed&limit=100&direction=desc`,
            { headers: alpacaHeaders(config) },
          );
          if (!ordersRes.ok) return `Alpaca orders API error: ${ordersRes.status}`;
          const _closedOrders = (await ordersRes.json()) as Record<string, unknown>[];

          // Load trade log and filter to recent
          const trades = loadTradeLog(config.tradeLogFile);
          const recentTrades = getRecentTrades(trades, days);

          if (recentTrades.length === 0) {
            return `No closed trades in the last ${days} days.`;
          }

          const stats = analyzeTradePerformance(recentTrades);

          // Build post-mortem report
          const lines: string[] = [];
          lines.push(`=== Trade Post-Mortem (last ${days} days) ===\n`);

          const now = new Date();
          const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
          lines.push(`Period: ${start.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`);
          lines.push(`Completed round-trip trades: ${stats.winCount + stats.lossCount}`);
          lines.push(`Overall P&L: $${stats.realizedPl.toFixed(2)}`);
          lines.push(`Win rate: ${(stats.winRate * 100).toFixed(1)}% (${stats.winCount}W / ${stats.lossCount}L)`);
          lines.push(`Sharpe ratio: ${stats.sharpeRatio.toFixed(2)}`);
          lines.push(`Max drawdown: ${(stats.maxDrawdown * 100).toFixed(1)}%`);
          lines.push("");

          if (stats.largestWin > 0) {
            lines.push(`Best trade: +$${stats.largestWin.toFixed(2)}`);
          }
          if (stats.largestLoss < 0) {
            lines.push(`Worst trade: $${stats.largestLoss.toFixed(2)}`);
          }
          lines.push(`Avg win: +$${stats.avgWin.toFixed(2)} | Avg loss: -$${stats.avgLoss.toFixed(2)}`);
          lines.push("");

          // Day-of-week patterns
          const dayEntries = Object.entries(stats.byDayOfWeek).sort(
            (a, b) => b[1].pl - a[1].pl,
          );
          if (dayEntries.length > 1) {
            const bestDay = dayEntries[0];
            const worstDay = dayEntries[dayEntries.length - 1];
            lines.push(`Best day: ${bestDay[0]} (+$${bestDay[1].pl.toFixed(2)}, ${bestDay[1].trades} trades)`);
            lines.push(`Worst day: ${worstDay[0]} ($${worstDay[1].pl.toFixed(2)}, ${worstDay[1].trades} trades)`);
            lines.push("");
          }

          lines.push("--- Lessons ---");
          lines.push(
            "Think about: What setups worked? What went wrong on losers? Were stops too tight or too loose? Did you hold too long or exit too early?",
          );
          lines.push("");

          lines.push("*Action items:*");
          lines.push('- Write any new lessons to curated memory (memory_write target "curated")');
          lines.push("- Adjust strategy if win rate < 50% or drawdown is high");
          lines.push("- Check if any losing patterns should be avoided");

          return lines.join("\n");
        } catch (err) {
          return `Trade review failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
  ];
}
