/**
 * Session persistence - JSONL transcript storage.
 *
 * Like OpenClaw, every agent turn is appended to a JSONL file.
 * Append-only means at most one line is lost on crash.
 * On startup, the session is restored from the transcript.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.js";
import type Anthropic from "@anthropic-ai/sdk";

const SESSIONS_DIR = join(STATE_DIR, "sessions");

export interface TranscriptEntry {
  id: string;
  timestamp: string;
  role: "user" | "assistant";
  content: unknown; // string or ContentBlock[] or ToolResultBlockParam[]
  toolsUsed?: string[];
  turnIndex: number;
}

export interface SessionStore {
  sessionId: string;
  filePath: string;
  turnCount: number;
  append: (entry: Omit<TranscriptEntry, "id" | "timestamp" | "turnIndex">) => void;
  loadMessages: () => Anthropic.MessageParam[];
  getTokenEstimate: () => number;
  compact: (summary: string) => void;
}

let idCounter = 0;

function generateId(): string {
  return `${Date.now()}-${++idCounter}`;
}

export function openSession(sessionId: string): SessionStore {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  const filePath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  let turnCount = 0;

  // Count existing turns
  if (existsSync(filePath)) {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    turnCount = lines.length;
  }

  return {
    sessionId,
    filePath,
    get turnCount() { return turnCount; },

    append(entry) {
      const full: TranscriptEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        turnIndex: turnCount++,
        ...entry,
      };
      appendFileSync(filePath, JSON.stringify(full) + "\n");
    },

    loadMessages(): Anthropic.MessageParam[] {
      if (!existsSync(filePath)) return [];

      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages: Anthropic.MessageParam[] = [];

      for (const line of lines) {
        try {
          const entry: TranscriptEntry = JSON.parse(line);
          messages.push({
            role: entry.role,
            content: entry.content as Anthropic.MessageParam["content"],
          });
        } catch {
          // Skip corrupted lines
        }
      }

      // Ensure messages alternate correctly (Claude API requirement)
      return normalizeMessageOrder(messages);
    },

    getTokenEstimate(): number {
      // Rough estimate: ~4 chars per token
      if (!existsSync(filePath)) return 0;
      const size = readFileSync(filePath, "utf-8").length;
      return Math.ceil(size / 4);
    },

    compact(summary: string) {
      // Replace entire transcript with a summary message
      // This is like OpenClaw's compaction - save context before it overflows
      const compactedEntry: TranscriptEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        role: "user",
        content: `[Session compacted. Previous context summary]\n\n${summary}`,
        turnIndex: 0,
      };
      writeFileSync(filePath, JSON.stringify(compactedEntry) + "\n");
      turnCount = 1;
    },
  };
}

/**
 * Ensure messages alternate user/assistant as Claude API requires.
 * Merge consecutive same-role messages.
 */
function normalizeMessageOrder(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return [];

  const normalized: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    const last = normalized[normalized.length - 1];

    if (last && last.role === msg.role) {
      // Merge consecutive same-role messages
      if (typeof last.content === "string" && typeof msg.content === "string") {
        last.content = last.content + "\n" + msg.content;
      } else {
        // Convert to array form and concat
        const lastArr = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: last.content as string }];
        const msgArr = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content as string }];
        last.content = [...lastArr, ...msgArr] as Anthropic.ContentBlockParam[];
      }
    } else {
      normalized.push({ ...msg });
    }
  }

  // Must start with user message
  if (normalized.length > 0 && normalized[0].role !== "user") {
    normalized.unshift({ role: "user", content: "[session resumed]" });
  }

  return normalized;
}
