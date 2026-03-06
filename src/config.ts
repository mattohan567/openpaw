import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";

export interface TradingConfig {
  alpacaApiKey: string;
  alpacaSecretKey: string;
  alpacaBaseUrl: string; // "https://paper-api.alpaca.markets" for paper trading
  watchlist: string[];
  maxPositionSize: number; // max $ per position
  maxPortfolioRisk: number; // max % of portfolio in single stock
  tradingHoursOnly: boolean;
  paperTrading: boolean;
}

export interface WhatsAppConfig {
  ownerNumber: string; // your phone number in E.164 format e.g. "+15551234567"
  authDir: string;
}

export interface AgentConfig {
  provider: string; // "anthropic", "xai", "openai", "google", "openrouter", etc.
  model: string;
  maxTokens: number;
  systemPromptFile: string; // path to SOUL.md or similar
  thinkingLevel: "off" | "low" | "medium" | "high"; // extended thinking for complex decisions
}

export interface CronConfig {
  heartbeatMinutes: number; // how often to run heartbeat during market hours
  marketOpenHeartbeat: boolean;
  marketCloseReport: boolean;
}

export interface RiskSettings {
  maxDailyLoss: number;       // max $ loss per day before halting trades
  maxDailyLossPct: number;    // max % loss per day
  maxOpenPositions: number;   // max concurrent positions
  positionAgingDays: number;  // flag positions held longer than this
}

export interface OpenPawConfig {
  trading: TradingConfig;
  whatsapp: WhatsAppConfig;
  agent: AgentConfig;
  cron: CronConfig;
  risk: RiskSettings;
  gateway: {
    port: number;
    host: string;
  };
  streaming: {
    enabled: boolean;
    streamWatchlist: boolean; // auto-stream watchlist symbols
  };
  tradeLogFile: string;
}

export const STATE_DIR = process.env.OPENPAW_STATE_DIR || join(homedir(), ".openpaw");
export const CONFIG_PATH = join(STATE_DIR, "config.json5");
export const TRADE_LOG_PATH = join(STATE_DIR, "trade_history.jsonl");
export const MEMORY_DIR = join(STATE_DIR, "memory");
export const CREDENTIALS_DIR = join(STATE_DIR, "credentials");
export const LOGS_DIR = join(STATE_DIR, "logs");

const DEFAULT_CONFIG: OpenPawConfig = {
  trading: {
    alpacaApiKey: "",
    alpacaSecretKey: "",
    alpacaBaseUrl: "https://paper-api.alpaca.markets",
    watchlist: ["AAPL", "NVDA", "TSLA", "MSFT", "GOOGL", "AMZN", "META"],
    maxPositionSize: 5000,
    maxPortfolioRisk: 0.15,
    tradingHoursOnly: true,
    paperTrading: true,
  },
  whatsapp: {
    ownerNumber: "",
    authDir: CREDENTIALS_DIR,
  },
  agent: {
    provider: "xai",
    model: "grok-3-fast",
    maxTokens: 4096,
    systemPromptFile: join(STATE_DIR, "SOUL.md"),
    thinkingLevel: "off",
  },
  cron: {
    heartbeatMinutes: 15,
    marketOpenHeartbeat: true,
    marketCloseReport: true,
  },
  risk: {
    maxDailyLoss: 500,
    maxDailyLossPct: 0.05,
    maxOpenPositions: 10,
    positionAgingDays: 5,
  },
  gateway: {
    port: 18790,
    host: "127.0.0.1",
  },
  streaming: {
    enabled: true,
    streamWatchlist: true,
  },
  tradeLogFile: TRADE_LOG_PATH,
};

export function ensureStateDir(): void {
  for (const dir of [STATE_DIR, MEMORY_DIR, CREDENTIALS_DIR, LOGS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function loadConfig(): OpenPawConfig {
  ensureStateDir();

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON5.stringify(DEFAULT_CONFIG, null, 2));
    return structuredClone(DEFAULT_CONFIG);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON5.parse(raw);
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    trading: { ...DEFAULT_CONFIG.trading, ...parsed.trading },
    whatsapp: { ...DEFAULT_CONFIG.whatsapp, ...parsed.whatsapp },
    agent: { ...DEFAULT_CONFIG.agent, ...parsed.agent },
    cron: { ...DEFAULT_CONFIG.cron, ...parsed.cron },
    risk: { ...DEFAULT_CONFIG.risk, ...parsed.risk },
    gateway: { ...DEFAULT_CONFIG.gateway, ...parsed.gateway },
    streaming: { ...DEFAULT_CONFIG.streaming, ...parsed.streaming },
  };
}

export function saveConfig(config: OpenPawConfig): void {
  ensureStateDir();
  writeFileSync(CONFIG_PATH, JSON5.stringify(config, null, 2));
}

export function isMarketHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const hours = parseInt(get("hour"), 10);
  const minutes = parseInt(get("minute"), 10);
  const timeNum = hours * 100 + minutes;

  // Weekdays 9:30 AM - 4:00 PM ET
  if (weekday === "Sat" || weekday === "Sun") return false;
  return timeNum >= 930 && timeNum < 1600;
}
