/**
 * Structured logging with subsystem tagging and file rotation.
 *
 * Each subsystem gets its own logger that prefixes messages.
 * All logs also go to a daily log file in ~/.openpaw/logs/.
 * File rotation: logs older than 14 days are pruned on startup.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

let globalLevel: LogLevel = (process.env.OPENPAW_LOG_LEVEL as LogLevel) || "info";
let fileLoggingEnabled = true;
const LOG_RETENTION_DAYS = 14;

function todayLogFile(): string {
  const date = new Date().toISOString().split("T")[0];
  return join(LOGS_DIR, `openpaw-${date}.log`);
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

function writeToFile(line: string): void {
  if (!fileLoggingEnabled) return;
  try {
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true });
    }
    appendFileSync(todayLogFile(), line + "\n");
  } catch {
    // Don't crash if file logging fails
  }
}

export interface SubsystemLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}${a.stack ? "\n" + a.stack : ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  const log = (level: LogLevel, ...args: unknown[]) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;

    const timestamp = formatTimestamp();
    const label = LEVEL_LABELS[level];
    const message = formatArgs(args);
    const prefix = `[${subsystem}]`;
    const fileLine = `${timestamp} ${label.padEnd(5)} ${prefix} ${message}`;

    // Console output
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else if (level === "warn") {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }

    // File output (always includes timestamp and level)
    writeToFile(fileLine);
  };

  return {
    debug: (...args: unknown[]) => log("debug", ...args),
    info: (...args: unknown[]) => log("info", ...args),
    warn: (...args: unknown[]) => log("warn", ...args),
    error: (...args: unknown[]) => log("error", ...args),
  };
}

/**
 * Set the global log level. Anything below this level is suppressed.
 */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/**
 * Enable or disable file logging.
 */
export function setFileLogging(enabled: boolean): void {
  fileLoggingEnabled = enabled;
}

/**
 * Prune log files older than LOG_RETENTION_DAYS.
 * Called on gateway startup.
 */
export function pruneOldLogs(): void {
  if (!existsSync(LOGS_DIR)) return;

  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = readdirSync(LOGS_DIR).filter((f) => f.startsWith("openpaw-") && f.endsWith(".log"));

  for (const file of files) {
    // Extract date from filename: openpaw-YYYY-MM-DD.log
    const match = file.match(/openpaw-(\d{4}-\d{2}-\d{2})\.log/);
    if (!match) continue;

    const fileDate = new Date(match[1]).getTime();
    if (fileDate < cutoff) {
      try {
        unlinkSync(join(LOGS_DIR, file));
      } catch {
        // Ignore deletion errors
      }
    }
  }
}
