/**
 * Session persistence - JSONL transcript storage.
 *
 * Like OpenClaw, every agent turn is appended to a JSONL file.
 * Append-only means at most one line is lost on crash.
 * On startup, the session is restored from the transcript.
 *
 * Stores Pi SDK AgentMessage objects directly so they can be
 * replayed back into the Agent on restart.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const SESSIONS_DIR = join(STATE_DIR, "sessions");

export interface TranscriptEntry {
  id: string;
  timestamp: string;
  message: AgentMessage; // Full Pi SDK message (user, assistant, or toolResult)
  turnIndex: number;
  meta?: {
    toolsUsed?: string[];
    tokenEstimate?: number;
  };
}

export interface SessionStore {
  sessionId: string;
  filePath: string;
  turnCount: number;
  /** Append a Pi SDK message to the transcript. */
  append: (message: AgentMessage, meta?: TranscriptEntry["meta"]) => void;
  /** Load all messages from transcript for replaying into Agent. */
  loadMessages: () => AgentMessage[];
  /** Rough token estimate of the transcript. */
  getTokenEstimate: () => number;
  /** Replace transcript with a compaction summary. */
  compact: (summaryMessages: AgentMessage[]) => void;
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

    append(message: AgentMessage, meta?: TranscriptEntry["meta"]) {
      const entry: TranscriptEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        turnIndex: turnCount++,
        message,
        meta,
      };
      appendFileSync(filePath, JSON.stringify(entry) + "\n");
    },

    loadMessages(): AgentMessage[] {
      if (!existsSync(filePath)) return [];

      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages: AgentMessage[] = [];

      for (const line of lines) {
        try {
          const entry: TranscriptEntry = JSON.parse(line);
          if (entry.message) {
            messages.push(entry.message);
          }
        } catch {
          // Skip corrupted lines
        }
      }

      return messages;
    },

    getTokenEstimate(): number {
      if (!existsSync(filePath)) return 0;
      const size = readFileSync(filePath, "utf-8").length;
      return Math.ceil(size / 4);
    },

    compact(summaryMessages: AgentMessage[]) {
      const lines = summaryMessages.map((message, i) => {
        const entry: TranscriptEntry = {
          id: generateId(),
          timestamp: new Date().toISOString(),
          turnIndex: i,
          message,
          meta: { tokenEstimate: 0 },
        };
        return JSON.stringify(entry);
      });
      writeFileSync(filePath, lines.join("\n") + "\n");
      turnCount = summaryMessages.length;
    },
  };
}
