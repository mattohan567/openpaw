import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";
import { createAlpacaTradingTools } from "./alpaca-trading.js";
import { createMarketDataTools } from "./alpaca-market-data.js";
import { createPortfolioTools } from "./portfolio.js";
import { createAnalysisTools } from "./trading-analysis.js";
import { createMemoryTools } from "../memory.js";

export function createOpenPawTools(config: OpenPawConfig): Tool[] {
  return [
    ...createAlpacaTradingTools(config),
    ...createMarketDataTools(config),
    ...createPortfolioTools(config),
    ...createAnalysisTools(config),
    ...createMemoryTools(),
  ];
}

export type { Tool } from "./types.js";
