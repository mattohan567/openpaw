import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RiskConfig {
  maxDailyLoss: number;
  maxDailyLossPct: number;
  maxOpenPositions: number;
  maxSectorConcentration: number;
  positionAgingDays: number;
  maxPositionSize: number;
  maxPortfolioRisk: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxDailyLoss: 500,
  maxDailyLossPct: 0.05,
  maxOpenPositions: 10,
  maxSectorConcentration: 0.40,
  positionAgingDays: 5,
  maxPositionSize: 5000,
  maxPortfolioRisk: 0.15,
};

export interface RiskCheck {
  allowed: boolean;
  warnings: string[];
  blocks: string[];
}

export interface PositionRisk {
  symbol: string;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  concentration: number;
  daysHeld: number;
  isAging: boolean;
}

export interface PortfolioRisk {
  equity: number;
  dayPl: number;
  dayPlPct: number;
  positions: PositionRisk[];
  totalPositions: number;
  dailyLossLimitHit: boolean;
  agingPositions: PositionRisk[];
  highConcentration: PositionRisk[];
  riskScore: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Try to figure out when a position was opened.
 * Alpaca positions don't include an entry timestamp, so we fall back to
 * scanning the trade log for the earliest *buy* of this symbol that could
 * correspond to the current position.
 */
function estimateDaysHeld(
  symbol: string,
  tradeLogPath?: string,
): number {
  const logPath = tradeLogPath ?? join(homedir(), ".openpaw", "trade_history.jsonl");
  if (!existsSync(logPath)) return 0;

  try {
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const now = new Date();

    // Walk backwards — find the most recent buy for this symbol
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (
          typeof entry.symbol === "string" &&
          entry.symbol.toUpperCase() === symbol.toUpperCase() &&
          (entry.action === "buy" || entry.side === "buy")
        ) {
          if (typeof entry.timestamp === "string") {
            const entryDate = new Date(entry.timestamp);
            if (!isNaN(entryDate.getTime())) {
              return daysBetween(now, entryDate);
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file read error — treat as unknown
  }

  return 0;
}

function buildPositionRisk(
  pos: Record<string, unknown>,
  equity: number,
  riskConfig: RiskConfig,
  tradeLogPath?: string,
): PositionRisk {
  const symbol = String(pos.symbol ?? "");
  const marketValue = Math.abs(num(pos.market_value));
  const unrealizedPl = num(pos.unrealized_pl);
  const costBasis = num(pos.cost_basis);
  const unrealizedPlPct = costBasis !== 0 ? unrealizedPl / costBasis : 0;
  const concentration = equity > 0 ? marketValue / equity : 0;
  const daysHeld = estimateDaysHeld(symbol, tradeLogPath);
  const isAging = daysHeld > riskConfig.positionAgingDays;

  return {
    symbol,
    marketValue,
    unrealizedPl,
    unrealizedPlPct,
    concentration,
    daysHeld,
    isAging,
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

export function assessPortfolioRisk(
  account: Record<string, unknown>,
  positions: Record<string, unknown>[],
  riskConfig: RiskConfig = DEFAULT_RISK_CONFIG,
  tradeLogPath?: string,
): PortfolioRisk {
  const equity = num(account.equity);
  const lastEquity = num(account.last_equity);
  const dayPl = equity - lastEquity;
  const dayPlPct = lastEquity !== 0 ? dayPl / lastEquity : 0;

  const posRisks = positions.map((p) =>
    buildPositionRisk(p, equity, riskConfig, tradeLogPath),
  );

  const dailyLossLimitHit =
    dayPl < 0 &&
    (Math.abs(dayPl) >= riskConfig.maxDailyLoss ||
      Math.abs(dayPlPct) >= riskConfig.maxDailyLossPct);

  const agingPositions = posRisks.filter((p) => p.isAging);
  const highConcentration = posRisks.filter(
    (p) => p.concentration > riskConfig.maxPortfolioRisk,
  );

  const portfolioRisk: PortfolioRisk = {
    equity,
    dayPl,
    dayPlPct,
    positions: posRisks,
    totalPositions: posRisks.length,
    dailyLossLimitHit,
    agingPositions,
    highConcentration,
    riskScore: 0, // filled in below
  };

  portfolioRisk.riskScore = calculateRiskScore(portfolioRisk, riskConfig);
  return portfolioRisk;
}

export function preTradeRiskCheck(
  symbol: string,
  estimatedCost: number,
  account: Record<string, unknown>,
  positions: Record<string, unknown>[],
  riskConfig: RiskConfig = DEFAULT_RISK_CONFIG,
  tradeLogPath?: string,
): RiskCheck {
  const blocks: string[] = [];
  const warnings: string[] = [];

  const equity = num(account.equity);
  const lastEquity = num(account.last_equity);
  const buyingPower = num(account.buying_power);
  const dayPl = equity - lastEquity;
  const dayPlPct = lastEquity !== 0 ? dayPl / lastEquity : 0;

  // --- Daily loss limit ---
  if (
    dayPl < 0 &&
    (Math.abs(dayPl) >= riskConfig.maxDailyLoss ||
      Math.abs(dayPlPct) >= riskConfig.maxDailyLossPct)
  ) {
    blocks.push(
      `Daily loss limit reached: $${Math.abs(dayPl).toFixed(2)} loss (${(Math.abs(dayPlPct) * 100).toFixed(1)}%). ` +
        `Limit: $${riskConfig.maxDailyLoss} / ${(riskConfig.maxDailyLossPct * 100).toFixed(0)}%.`,
    );
  }

  // --- Buying power ---
  if (estimatedCost > buyingPower) {
    blocks.push(
      `Insufficient buying power: need $${estimatedCost.toFixed(2)}, have $${buyingPower.toFixed(2)}.`,
    );
  }

  // --- Max position size ---
  if (estimatedCost > riskConfig.maxPositionSize) {
    blocks.push(
      `Position size $${estimatedCost.toFixed(2)} exceeds max $${riskConfig.maxPositionSize.toFixed(2)}.`,
    );
  }

  // --- Portfolio concentration (existing + new) ---
  const existingValue = positions
    .filter(
      (p) =>
        typeof p.symbol === "string" &&
        p.symbol.toUpperCase() === symbol.toUpperCase(),
    )
    .reduce((sum, p) => sum + Math.abs(num(p.market_value)), 0);

  const projectedConcentration =
    equity > 0 ? (existingValue + estimatedCost) / equity : 0;

  if (projectedConcentration > riskConfig.maxPortfolioRisk) {
    blocks.push(
      `Projected concentration in ${symbol.toUpperCase()} would be ${(projectedConcentration * 100).toFixed(1)}% ` +
        `(limit ${(riskConfig.maxPortfolioRisk * 100).toFixed(0)}%).`,
    );
  }

  // --- Max open positions ---
  const uniqueSymbols = new Set(
    positions.map((p) =>
      typeof p.symbol === "string" ? p.symbol.toUpperCase() : "",
    ),
  );
  const isNewPosition = !uniqueSymbols.has(symbol.toUpperCase());

  if (isNewPosition && uniqueSymbols.size >= riskConfig.maxOpenPositions) {
    blocks.push(
      `Already at max open positions (${uniqueSymbols.size}/${riskConfig.maxOpenPositions}).`,
    );
  }

  // --- Aging warnings ---
  for (const pos of positions) {
    const sym = String(pos.symbol ?? "");
    const days = estimateDaysHeld(sym, tradeLogPath);
    if (days > riskConfig.positionAgingDays) {
      warnings.push(
        `${sym} held for ${days} days (threshold: ${riskConfig.positionAgingDays}).`,
      );
    }
  }

  // --- Near daily loss warning (>75% of limit) ---
  if (
    dayPl < 0 &&
    blocks.length === 0 &&
    (Math.abs(dayPl) >= riskConfig.maxDailyLoss * 0.75 ||
      Math.abs(dayPlPct) >= riskConfig.maxDailyLossPct * 0.75)
  ) {
    warnings.push(
      `Approaching daily loss limit: $${Math.abs(dayPl).toFixed(2)} loss today.`,
    );
  }

  return {
    allowed: blocks.length === 0,
    warnings,
    blocks,
  };
}

export function calculateRiskScore(
  portfolioRisk: PortfolioRisk,
  riskConfig: RiskConfig = DEFAULT_RISK_CONFIG,
): number {
  let score = 0;

  // Daily P&L relative to limit (0-30 points)
  if (portfolioRisk.dayPl < 0) {
    const lossRatio = Math.min(
      Math.abs(portfolioRisk.dayPl) / riskConfig.maxDailyLoss,
      1,
    );
    score += Math.round(lossRatio * 30);
  }

  // Number of positions vs max (0-20 points)
  const posRatio = Math.min(
    portfolioRisk.totalPositions / riskConfig.maxOpenPositions,
    1,
  );
  score += Math.round(posRatio * 20);

  // Highest concentration vs limit (0-25 points)
  const maxConcentration =
    portfolioRisk.positions.length > 0
      ? Math.max(...portfolioRisk.positions.map((p) => p.concentration))
      : 0;
  const concRatio = Math.min(maxConcentration / riskConfig.maxPortfolioRisk, 1);
  score += Math.round(concRatio * 25);

  // Number of aging positions (0-15 points)
  if (portfolioRisk.totalPositions > 0) {
    const agingRatio = Math.min(
      portfolioRisk.agingPositions.length / portfolioRisk.totalPositions,
      1,
    );
    score += Math.round(agingRatio * 15);
  }

  // Overall P&L trend (0-10 points)
  // Based on aggregate unrealized P&L across all positions
  const totalUnrealized = portfolioRisk.positions.reduce(
    (sum, p) => sum + p.unrealizedPl,
    0,
  );
  if (totalUnrealized < 0 && portfolioRisk.equity > 0) {
    const unrealizedRatio = Math.min(
      Math.abs(totalUnrealized) / portfolioRisk.equity,
      0.1,
    );
    score += Math.round((unrealizedRatio / 0.1) * 10);
  }

  return Math.min(score, 100);
}

export function formatRiskReport(portfolioRisk: PortfolioRisk): string {
  const lines: string[] = [];

  // Header
  const riskLabel =
    portfolioRisk.riskScore <= 30
      ? "LOW"
      : portfolioRisk.riskScore <= 60
        ? "MODERATE"
        : portfolioRisk.riskScore <= 80
          ? "HIGH"
          : "CRITICAL";

  lines.push(`*Portfolio Risk Report*`);
  lines.push(`Risk Score: *${portfolioRisk.riskScore}/100* (${riskLabel})`);
  lines.push("");

  // Account summary
  const plSign = portfolioRisk.dayPl >= 0 ? "+" : "";
  lines.push(`*Account*`);
  lines.push(`Equity: $${portfolioRisk.equity.toFixed(2)}`);
  lines.push(
    `Day P&L: ${plSign}$${portfolioRisk.dayPl.toFixed(2)} (${plSign}${(portfolioRisk.dayPlPct * 100).toFixed(2)}%)`,
  );
  lines.push(`Open Positions: ${portfolioRisk.totalPositions}`);
  lines.push("");

  if (portfolioRisk.dailyLossLimitHit) {
    lines.push(`*DAILY LOSS LIMIT HIT* - new buys blocked`);
    lines.push("");
  }

  // High concentration
  if (portfolioRisk.highConcentration.length > 0) {
    lines.push(`*High Concentration*`);
    for (const p of portfolioRisk.highConcentration) {
      lines.push(
        `  ${p.symbol}: ${(p.concentration * 100).toFixed(1)}% of portfolio ($${p.marketValue.toFixed(0)})`,
      );
    }
    lines.push("");
  }

  // Aging positions
  if (portfolioRisk.agingPositions.length > 0) {
    lines.push(`*Aging Positions*`);
    for (const p of portfolioRisk.agingPositions) {
      const plSign2 = p.unrealizedPl >= 0 ? "+" : "";
      lines.push(
        `  ${p.symbol}: ${p.daysHeld} days, ${plSign2}$${p.unrealizedPl.toFixed(2)} (${plSign2}${(p.unrealizedPlPct * 100).toFixed(1)}%)`,
      );
    }
    lines.push("");
  }

  // Positions summary (top 5 by concentration)
  if (portfolioRisk.positions.length > 0) {
    const sorted = [...portfolioRisk.positions].sort(
      (a, b) => b.concentration - a.concentration,
    );
    const top = sorted.slice(0, 5);
    lines.push(`*Top Positions by Concentration*`);
    for (const p of top) {
      const plSign3 = p.unrealizedPl >= 0 ? "+" : "";
      lines.push(
        `  ${p.symbol}: ${(p.concentration * 100).toFixed(1)}% | $${p.marketValue.toFixed(0)} | ${plSign3}$${p.unrealizedPl.toFixed(2)}`,
      );
    }
    if (sorted.length > 5) {
      lines.push(`  ... and ${sorted.length - 5} more`);
    }
  }

  return lines.join("\n");
}
