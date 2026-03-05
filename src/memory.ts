/**
 * Memory system - persistent knowledge across sessions.
 *
 * Like OpenClaw's memory architecture:
 * - Layer 1: Daily logs (memory/YYYY-MM-DD.md) - timestamped events
 * - Layer 2: Curated knowledge (memory/MEMORY.md) - distilled, organized
 *
 * The agent gets memory tools to read/write these files.
 * Before compaction, the agent is prompted to flush important info to memory.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DIR } from "./config.js";
import type { Tool } from "./tools/types.js";
import { createSubsystemLogger } from "./logger.js";

const log = createSubsystemLogger("Memory");
// Keep daily logs for 90 days, then prune
const DAILY_LOG_RETENTION_DAYS = 90;

function todayFile(): string {
  return join(MEMORY_DIR, `${new Date().toISOString().split("T")[0]}.md`);
}

function memoryFile(): string {
  return join(MEMORY_DIR, "MEMORY.md");
}

export function createMemoryTools(): Tool[] {
  return [
    {
      name: "memory_read",
      description:
        "Read your persistent memory. Use 'curated' for your organized knowledge base (MEMORY.md), or 'daily' for today's event log, or 'daily:YYYY-MM-DD' for a specific date.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: {
            type: "string",
            description: "Which memory to read: 'curated', 'daily', or 'daily:YYYY-MM-DD'",
          },
        },
        required: ["source"],
      },
      execute: async (params) => {
        const source = params.source as string;
        let path: string;

        if (source === "curated") {
          path = memoryFile();
        } else if (source === "daily") {
          path = todayFile();
        } else if (source.startsWith("daily:")) {
          const date = source.slice(6);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return "Invalid date format. Use 'daily:YYYY-MM-DD'.";
          }
          path = join(MEMORY_DIR, `${date}.md`);
        } else {
          return "Invalid source. Use 'curated', 'daily', or 'daily:YYYY-MM-DD'.";
        }

        if (!existsSync(path)) return `No memory found at ${source}.`;
        return readFileSync(path, "utf-8");
      },
    },
    {
      name: "memory_write",
      description:
        "Write to your persistent memory. Use 'curated' to update your organized knowledge base, or 'daily' to append to today's event log. For curated, provide the full content (overwrites). For daily, the entry is appended with a timestamp.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: {
            type: "string",
            description: "Where to write: 'curated' or 'daily'",
          },
          content: {
            type: "string",
            description: "The content to write",
          },
        },
        required: ["target", "content"],
      },
      execute: async (params) => {
        const target = params.target as string;
        const content = params.content as string;

        if (target === "curated") {
          writeFileSync(memoryFile(), content);
          return "Curated memory (MEMORY.md) updated.";
        } else if (target === "daily") {
          const timestamp = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "America/New_York",
          });
          const entry = `\n## ${timestamp}\n${content}\n`;
          const path = todayFile();

          if (!existsSync(path)) {
            const dateStr = new Date().toISOString().split("T")[0];
            writeFileSync(path, `# Daily Log - ${dateStr}\n${entry}`);
          } else {
            appendFileSync(path, entry);
          }
          return "Daily log entry appended.";
        }

        return "Invalid target. Use 'curated' or 'daily'.";
      },
    },
    {
      name: "memory_search",
      description:
        "Search across all memory files (daily logs and curated) for a keyword or phrase. Returns matching excerpts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search term to look for across memory files",
          },
        },
        required: ["query"],
      },
      execute: async (params) => {
        const query = (params.query as string).toLowerCase();
        const results: string[] = [];

        if (!existsSync(MEMORY_DIR)) return "No memory files found.";

        const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));

        for (const file of files) {
          const content = readFileSync(join(MEMORY_DIR, file), "utf-8");
          const lines = content.split("\n");
          const matches: string[] = [];

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              // Include surrounding context (2 lines before/after)
              const start = Math.max(0, i - 2);
              const end = Math.min(lines.length - 1, i + 2);
              matches.push(lines.slice(start, end + 1).join("\n"));
            }
          }

          if (matches.length > 0) {
            results.push(`**${file}**:\n${matches.join("\n---\n")}`);
          }
        }

        return results.length > 0
          ? results.join("\n\n")
          : `No matches found for "${params.query}".`;
      },
    },
    {
      name: "memory_list",
      description: "List all memory files (daily logs and curated memory).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      execute: async () => {
        if (!existsSync(MEMORY_DIR)) return "No memory directory.";
        const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
        if (files.length === 0) return "No memory files yet.";
        return files.join("\n");
      },
    },
  ];
}

/**
 * Load curated memory to inject into system prompt.
 */
export function loadCuratedMemory(): string {
  const path = memoryFile();
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/**
 * Load today's daily log to inject into system prompt.
 */
export function loadTodayLog(): string {
  const path = todayFile();
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/**
 * Prune daily log files older than DAILY_LOG_RETENTION_DAYS.
 * Keeps MEMORY.md (curated) forever — only prunes dated daily logs.
 * Called on gateway startup.
 */
export function pruneOldDailyLogs(): void {
  if (!existsSync(MEMORY_DIR)) return;

  const cutoff = Date.now() - DAILY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = readdirSync(MEMORY_DIR).filter((f) =>
    /^\d{4}-\d{2}-\d{2}\.md$/.test(f),
  );

  for (const file of files) {
    const dateStr = file.replace(".md", "");
    const fileDate = new Date(dateStr).getTime();
    if (isNaN(fileDate)) continue;

    if (fileDate < cutoff) {
      try {
        unlinkSync(join(MEMORY_DIR, file));
        log.info(`Pruned old daily log: ${file}`);
      } catch {
        // Ignore deletion errors
      }
    }
  }
}
