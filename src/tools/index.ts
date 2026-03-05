import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";
import type { AlpacaStream } from "../streaming.js";
import { createAlpacaTradingTools } from "./alpaca-trading.js";
import { createMarketDataTools } from "./alpaca-market-data.js";
import { createPortfolioTools } from "./portfolio.js";
import { createWebSearchTools } from "./web-search.js";
import { createResearchTools } from "./research.js";
import { createMemoryTools } from "../memory.js";
import { createAlertTools } from "./alerts.js";
import { createRiskTools } from "./risk-tools.js";

export function createOpenPawTools(
  config: OpenPawConfig,
  stream?: AlpacaStream | null,
): Tool[] {
  return [
    ...createAlpacaTradingTools(config),
    ...createMarketDataTools(config),
    ...createPortfolioTools(config),
    ...createWebSearchTools(),
    ...createResearchTools(config),
    ...createAlertTools(stream ?? null),
    ...createRiskTools(config),
    ...createMemoryTools(),
  ];
}

export type { Tool } from "./types.js";
