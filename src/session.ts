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

import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "./logger.js";

const log = createSubsystemLogger("Session");
const SESSIONS_DIR = join(STATE_DIR, "sessions");
const ARCHIVE_DIR = join(SESSIONS_DIR, "archive");
// Archive sessions older than 7 days, delete archives older than 30 days
const ARCHIVE_AGE_DAYS = 7;
const DELETE_AGE_DAYS = 30;

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

/**
 * Archive old session files and prune ancient archives.
 * Like OpenClaw's session archiving - moves stale sessions to an archive
 * folder and deletes sessions older than DELETE_AGE_DAYS.
 * Called on gateway startup.
 */
export function archiveOldSessions(): void {
  if (!existsSync(SESSIONS_DIR)) return;

  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const now = Date.now();
  const archiveCutoff = now - ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000;
  const deleteCutoff = now - DELETE_AGE_DAYS * 24 * 60 * 60 * 1000;

  // Archive old active sessions
  const sessionFiles = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
  for (const file of sessionFiles) {
    // Don't archive the active "main" session
    if (file === "main.jsonl") continue;

    const filePath = join(SESSIONS_DIR, file);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < archiveCutoff) {
        renameSync(filePath, join(ARCHIVE_DIR, file));
        log.info(`Archived session: ${file}`);
      }
    } catch {
      // Skip files we can't stat
    }
  }

  // Delete ancient archives
  if (existsSync(ARCHIVE_DIR)) {
    const archiveFiles = readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(".jsonl"));
    for (const file of archiveFiles) {
      const filePath = join(ARCHIVE_DIR, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < deleteCutoff) {
          unlinkSync(filePath);
          log.info(`Pruned archived session: ${file}`);
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
  }
}
