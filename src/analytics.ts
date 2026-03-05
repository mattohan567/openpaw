import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface TradeRecord {
  timestamp: string;
  action: "buy" | "sell" | "bracket_buy";
  symbol: string;
  qty: number;
  price?: number;
  estimatedCost?: number;
  side: "buy" | "sell";
  type: string;
  result?: Record<string, unknown>;
}

export interface TradeStats {
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  uniqueSymbols: string[];

  // P&L
  realizedPl: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;

  // Win/Loss
  winCount: number;
  lossCount: number;
  winRate: number;
  profitFactor: number;

  // Risk metrics
  maxDrawdown: number;
  sharpeRatio: number;
  avgHoldingPeriod: number;

  // By symbol
  bySymbol: Record<
    string,
    {
      trades: number;
      realizedPl: number;
      winRate: number;
      avgReturn: number;
    }
  >;

  // Time analysis
  byDayOfWeek: Record<string, { trades: number; pl: number }>;
  byHour: Record<string, { trades: number; pl: number }>;

  // Period
  periodStart: string;
  periodEnd: string;
  tradingDays: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractPrice(trade: TradeRecord): number | null {
  if (trade.price != null && trade.price > 0) return trade.price;

  if (trade.result) {
    const filledAvg = trade.result["filled_avg_price"];
    if (filledAvg != null) {
      const n = Number(filledAvg);
      if (!isNaN(n) && n > 0) return n;
    }
    const limitPrice = trade.result["limit_price"];
    if (limitPrice != null) {
      const n = Number(limitPrice);
      if (!isNaN(n) && n > 0) return n;
    }
  }

  if (trade.estimatedCost != null && trade.qty > 0) {
    const derived = trade.estimatedCost / trade.qty;
    if (derived > 0) return derived;
  }

  return null;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// ── Core Functions ──────────────────────────────────────────────────────────

export function loadTradeLog(filePath: string): TradeRecord[] {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) return [];

  const raw = readFileSync(absPath, "utf-8");
  const lines = raw.split("\n");
  const records: TradeRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      // Normalise qty to number
      if (typeof obj.qty === "string") obj.qty = Number(obj.qty);
      if (!obj.symbol || !obj.action) continue;
      records.push(obj as TradeRecord);
    } catch {
      // Skip corrupted lines
    }
  }

  return records;
}

export function getRecentTrades(
  trades: TradeRecord[],
  days: number,
): TradeRecord[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffMs = cutoff.getTime();

  return trades.filter((t) => {
    const ts = new Date(t.timestamp).getTime();
    return !isNaN(ts) && ts >= cutoffMs;
  });
}

export function calculateSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;

  const dailyRf = 0.05 / 252;
  const excess = returns.map((r) => r - dailyRf);
  const mean = excess.reduce((s, v) => s + v, 0) / excess.length;
  const variance =
    excess.reduce((s, v) => s + (v - mean) ** 2, 0) / (excess.length - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;

  return (mean / std) * Math.sqrt(252);
}

export function calculateMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;

  let peak = equityCurve[0];
  let maxDd = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = (peak - value) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }

  return maxDd;
}

export function analyzeTradePerformance(
  trades: TradeRecord[],
  period?: { start?: string; end?: string },
): TradeStats {
  // Filter by period
  let filtered = trades;
  if (period?.start) {
    const startMs = new Date(period.start).getTime();
    filtered = filtered.filter(
      (t) => new Date(t.timestamp).getTime() >= startMs,
    );
  }
  if (period?.end) {
    const endMs = new Date(period.end).getTime();
    filtered = filtered.filter(
      (t) => new Date(t.timestamp).getTime() <= endMs,
    );
  }

  // Sort chronologically
  filtered = [...filtered].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const buyCount = filtered.filter(
    (t) => t.action === "buy" || t.action === "bracket_buy",
  ).length;
  const sellCount = filtered.filter((t) => t.action === "sell").length;

  const uniqueSymbols = [...new Set(filtered.map((t) => t.symbol))];

  // FIFO matching: build buy queues per symbol
  const buyQueues: Record<
    string,
    { price: number; qty: number; timestamp: string }[]
  > = {};
  const completedTrades: {
    symbol: string;
    pl: number;
    buyTime: string;
    sellTime: string;
    returnPct: number;
  }[] = [];

  for (const trade of filtered) {
    const price = extractPrice(trade);
    if (price == null) continue;
    const qty = Math.abs(trade.qty) || 0;
    if (qty === 0) continue;

    const sym = trade.symbol;

    if (trade.action === "buy" || trade.action === "bracket_buy") {
      if (!buyQueues[sym]) buyQueues[sym] = [];
      buyQueues[sym].push({ price, qty, timestamp: trade.timestamp });
    } else if (trade.action === "sell") {
      if (!buyQueues[sym] || buyQueues[sym].length === 0) continue;

      let remaining = qty;
      while (remaining > 0 && buyQueues[sym].length > 0) {
        const front = buyQueues[sym][0];
        const matched = Math.min(remaining, front.qty);
        const pl = (price - front.price) * matched;
        const returnPct =
          front.price > 0 ? (price - front.price) / front.price : 0;

        completedTrades.push({
          symbol: sym,
          pl,
          buyTime: front.timestamp,
          sellTime: trade.timestamp,
          returnPct,
        });

        front.qty -= matched;
        remaining -= matched;
        if (front.qty <= 0) buyQueues[sym].shift();
      }
    }
  }

  // P&L calculations
  const realizedPl = completedTrades.reduce((s, t) => s + t.pl, 0);
  const wins = completedTrades.filter((t) => t.pl > 0);
  const losses = completedTrades.filter((t) => t.pl < 0);

  const grossWins = wins.reduce((s, t) => s + t.pl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pl, 0));

  const avgWin = wins.length > 0 ? grossWins / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;
  const largestWin =
    wins.length > 0 ? Math.max(...wins.map((t) => t.pl)) : 0;
  const largestLoss =
    losses.length > 0 ? Math.min(...losses.map((t) => t.pl)) : 0;

  const winRate =
    completedTrades.length > 0 ? wins.length / completedTrades.length : 0;
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  // Holding period
  const holdingDays = completedTrades.map((t) => {
    const ms =
      new Date(t.sellTime).getTime() - new Date(t.buyTime).getTime();
    return ms / (1000 * 60 * 60 * 24);
  });
  const avgHoldingPeriod =
    holdingDays.length > 0
      ? holdingDays.reduce((s, v) => s + v, 0) / holdingDays.length
      : 0;

  // Equity curve and risk metrics from completed trades in chronological order
  const equityCurve: number[] = [0];
  let cumPl = 0;
  for (const t of completedTrades) {
    cumPl += t.pl;
    equityCurve.push(cumPl);
  }

  // For Sharpe, use returns from completed trades
  const dailyReturns = completedTrades.map((t) => t.returnPct);

  const maxDrawdown = calculateMaxDrawdown(equityCurve);
  const sharpeRatio = calculateSharpe(dailyReturns);

  // By symbol
  const bySymbol: TradeStats["bySymbol"] = {};
  for (const sym of uniqueSymbols) {
    const symTrades = completedTrades.filter((t) => t.symbol === sym);
    const symWins = symTrades.filter((t) => t.pl > 0);
    const symPl = symTrades.reduce((s, t) => s + t.pl, 0);
    const symAvgReturn =
      symTrades.length > 0
        ? symTrades.reduce((s, t) => s + t.returnPct, 0) / symTrades.length
        : 0;

    bySymbol[sym] = {
      trades: symTrades.length,
      realizedPl: symPl,
      winRate: symTrades.length > 0 ? symWins.length / symTrades.length : 0,
      avgReturn: symAvgReturn,
    };
  }

  // Time analysis
  const byDayOfWeek: TradeStats["byDayOfWeek"] = {};
  const byHour: TradeStats["byHour"] = {};

  for (const ct of completedTrades) {
    const d = new Date(ct.sellTime);
    const dayName = DAY_NAMES[d.getDay()];
    const hour = String(d.getHours());

    if (!byDayOfWeek[dayName]) byDayOfWeek[dayName] = { trades: 0, pl: 0 };
    byDayOfWeek[dayName].trades++;
    byDayOfWeek[dayName].pl += ct.pl;

    if (!byHour[hour]) byHour[hour] = { trades: 0, pl: 0 };
    byHour[hour].trades++;
    byHour[hour].pl += ct.pl;
  }

  // Period boundaries and trading days
  const timestamps = filtered.map((t) => new Date(t.timestamp).getTime()).filter((t) => !isNaN(t));
  const periodStart =
    timestamps.length > 0
      ? new Date(Math.min(...timestamps)).toISOString()
      : "";
  const periodEnd =
    timestamps.length > 0
      ? new Date(Math.max(...timestamps)).toISOString()
      : "";

  const tradingDaysSet = new Set(
    filtered.map((t) => new Date(t.timestamp).toISOString().slice(0, 10)),
  );

  return {
    totalTrades: filtered.length,
    buyCount,
    sellCount,
    uniqueSymbols,
    realizedPl,
    avgWin,
    avgLoss,
    largestWin,
    largestLoss,
    winCount: wins.length,
    lossCount: losses.length,
    winRate,
    profitFactor,
    maxDrawdown,
    sharpeRatio,
    avgHoldingPeriod,
    bySymbol,
    byDayOfWeek,
    byHour,
    periodStart,
    periodEnd,
    tradingDays: tradingDaysSet.size,
  };
}

export function formatTradeReport(stats: TradeStats): string {
  const lines: string[] = [];

  const plSign = stats.realizedPl >= 0 ? "+" : "";
  lines.push(
    `*Trading Performance Report*`,
    `${stats.periodStart.slice(0, 10)} to ${stats.periodEnd.slice(0, 10)} (${stats.tradingDays} trading days)`,
    ``,
    `*Overall P&L:* ${plSign}$${stats.realizedPl.toFixed(2)}`,
    `*Win Rate:* ${(stats.winRate * 100).toFixed(1)}% (${stats.winCount}W / ${stats.lossCount}L)`,
    `*Profit Factor:* ${stats.profitFactor === Infinity ? "N/A (no losses)" : stats.profitFactor.toFixed(2)}`,
    `*Total Trades:* ${stats.totalTrades} (${stats.buyCount} buys, ${stats.sellCount} sells)`,
    `*Symbols Traded:* ${stats.uniqueSymbols.length}`,
    ``,
  );

  // Best / worst
  if (stats.largestWin > 0 || stats.largestLoss < 0) {
    lines.push(`*Best Trade:* +$${stats.largestWin.toFixed(2)}`);
    lines.push(`*Worst Trade:* $${stats.largestLoss.toFixed(2)}`);
    lines.push(
      `*Avg Win:* +$${stats.avgWin.toFixed(2)} | *Avg Loss:* -$${stats.avgLoss.toFixed(2)}`,
    );
    lines.push(``);
  }

  // Risk metrics
  lines.push(`*Risk Metrics*`);
  lines.push(`Max Drawdown: ${(stats.maxDrawdown * 100).toFixed(1)}%`);
  lines.push(
    `Sharpe Ratio: ${stats.sharpeRatio === Infinity || stats.sharpeRatio === -Infinity ? "N/A" : stats.sharpeRatio.toFixed(2)}`,
  );
  lines.push(
    `Avg Holding Period: ${stats.avgHoldingPeriod.toFixed(1)} days`,
  );
  lines.push(``);

  // Top symbols by P&L
  const symbolEntries = Object.entries(stats.bySymbol)
    .filter(([, v]) => v.trades > 0)
    .sort((a, b) => b[1].realizedPl - a[1].realizedPl);

  if (symbolEntries.length > 0) {
    lines.push(`*Top Symbols*`);
    const top = symbolEntries.slice(0, 5);
    for (const [sym, data] of top) {
      const sign = data.realizedPl >= 0 ? "+" : "";
      lines.push(
        `${sym}: ${sign}$${data.realizedPl.toFixed(2)} (${(data.winRate * 100).toFixed(0)}% WR, ${data.trades} trades)`,
      );
    }
    lines.push(``);
  }

  // Day/time patterns — highlight best/worst
  const dayEntries = Object.entries(stats.byDayOfWeek).sort(
    (a, b) => b[1].pl - a[1].pl,
  );
  if (dayEntries.length > 1) {
    const bestDay = dayEntries[0];
    const worstDay = dayEntries[dayEntries.length - 1];
    if (bestDay[1].pl !== worstDay[1].pl) {
      lines.push(`*Day Patterns*`);
      lines.push(
        `Best day: ${bestDay[0]} (+$${bestDay[1].pl.toFixed(2)}, ${bestDay[1].trades} trades)`,
      );
      lines.push(
        `Worst day: ${worstDay[0]} ($${worstDay[1].pl.toFixed(2)}, ${worstDay[1].trades} trades)`,
      );
    }
  }

  return lines.join("\n");
}
