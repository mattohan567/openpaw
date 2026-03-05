/**
 * Agent engine - uses the same Pi SDK as OpenClaw.
 *
 * Uses Agent class from @mariozechner/pi-agent-core with streamSimple
 * from @mariozechner/pi-ai. This gives us:
 * - Streaming responses (text deltas as they arrive)
 * - Full event lifecycle (agent_start → turn_start → message_start → tool events → agent_end)
 * - Tool execution with proper abort/signal handling
 * - Steering (interrupt agent mid-run with new instructions)
 * - Follow-up messages (queue messages for after agent finishes)
 * - Context management via transformContext (compaction)
 * - Model-agnostic (Anthropic, OpenAI, Google, etc.)
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { streamSimple, getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import type { Model, AssistantMessage as PiAssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import { readFileSync, existsSync } from "node:fs";
import type { OpenPawConfig } from "./config.js";
import { STATE_DIR } from "./config.js";
import { join } from "node:path";
import type { Tool } from "./tools/types.js";
import type { SessionStore } from "./session.js";
import { loadCuratedMemory, loadTodayLog } from "./memory.js";

export type { AgentEvent, AgentMessage };

export interface AgentRunResult {
  response: string;
  toolsUsed: string[];
}

// Compaction threshold - ~120k tokens leaves room for response in 200k context
const COMPACTION_TOKEN_THRESHOLD = 120_000;

/**
 * Convert our simple Tool interface to Pi SDK's AgentTool interface.
 */
function toPiTool(tool: Tool): AgentTool<any> {
  const schema = Type.Object(
    Object.fromEntries(
      Object.entries(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties || {},
      ).map(([key, val]) => {
        const prop = val as { type?: string; description?: string };
        if (prop.type === "number") {
          return [key, Type.Optional(Type.Number({ description: prop.description }))];
        }
        return [key, Type.Optional(Type.String({ description: prop.description }))];
      }),
    ),
  );

  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: schema,
    async execute(
      _toolCallId: string,
      input: unknown,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const params = (input ?? {}) as Record<string, unknown>;
        const result = await tool.execute(params);
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return {
          content: [{ type: "text", text }],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
        };
      }
    },
  };
}

/**
 * Resolve the Claude model definition for Pi SDK.
 */
function resolveModel(config: OpenPawConfig): Model<"anthropic-messages"> {
  try {
    return getModel("anthropic", config.agent.model as any);
  } catch {
    return {
      id: config.agent.model,
      name: config.agent.model,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: config.agent.maxTokens,
    };
  }
}

/**
 * Load SOUL.md from the state directory.
 * Like OpenClaw's SOUL.md - defines persona, tone, boundaries.
 */
export function loadSoulPrompt(config: OpenPawConfig): string {
  const soulPath = config.agent.systemPromptFile || join(STATE_DIR, "SOUL.md");
  if (existsSync(soulPath)) {
    return readFileSync(soulPath, "utf-8");
  }
  return DEFAULT_SOUL;
}

/**
 * Load HEARTBEAT.md - the checklist for proactive heartbeat runs.
 */
export function loadHeartbeatPrompt(): string {
  const path = join(STATE_DIR, "HEARTBEAT.md");
  if (existsSync(path)) {
    return readFileSync(path, "utf-8");
  }
  return DEFAULT_HEARTBEAT;
}

/**
 * Build the full system prompt with memory injection.
 * Like OpenClaw's system-prompt.ts that injects SOUL.md + memory + time + context.
 */
export function buildSystemPrompt(config: OpenPawConfig): string {
  const parts = [loadSoulPrompt(config)];

  const memory = loadCuratedMemory();
  if (memory) {
    parts.push("\n\n## Your Persistent Memory\nThis is your curated knowledge from previous sessions:\n\n" + memory);
  }

  const todayLog = loadTodayLog();
  if (todayLog) {
    parts.push("\n\n## Today's Activity Log\n" + todayLog);
  }

  const now = new Date();
  const eastern = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  parts.push(`\n\n## Current Context`);
  parts.push(`- Time: ${eastern} ET`);
  parts.push(`- Watchlist: ${config.trading.watchlist.join(", ")}`);
  parts.push(`- Paper trading: ${config.trading.paperTrading}`);
  parts.push(`- Max position size: $${config.trading.maxPositionSize}`);
  parts.push(`- Max portfolio risk per stock: ${(config.trading.maxPortfolioRisk * 100).toFixed(0)}%`);

  return parts.join("\n");
}

/**
 * Create the Pi SDK Agent with context management (compaction).
 */
export function createAgent(
  tools: Tool[],
  config: OpenPawConfig,
): Agent {
  const model = resolveModel(config);
  const piTools = tools.map(toPiTool);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(config),
      model,
      thinkingLevel: "off" as ThinkingLevel,
      tools: piTools,
      messages: [],
    },
    streamFn: streamSimple,
    getApiKey: async (provider: string) => {
      return getEnvApiKey(provider) ?? undefined;
    },
    // Context management - like OpenClaw's compaction
    transformContext: async (messages: AgentMessage[]) => {
      // Rough token estimate: stringify and divide by 4
      const estimate = JSON.stringify(messages).length / 4;

      if (estimate > COMPACTION_TOKEN_THRESHOLD) {
        console.log(`[Agent] Context at ~${Math.round(estimate)}k tokens, compacting...`);
        return compactMessages(messages);
      }

      return messages;
    },
  });

  return agent;
}

/**
 * Restore agent state from a persisted session transcript.
 * Replays saved messages into the Agent so it has full context after restart.
 */
export function restoreSession(agent: Agent, sessionStore: SessionStore): number {
  const messages = sessionStore.loadMessages();
  if (messages.length === 0) return 0;

  // Replace the agent's messages with the restored ones
  agent.replaceMessages(messages);
  console.log(`[Agent] Restored ${messages.length} messages from transcript.`);
  return messages.length;
}

/**
 * Compact messages when context gets too large.
 * Keeps the first few messages (identity/context) and recent messages,
 * summarizes the middle.
 */
function compactMessages(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= 10) return messages;

  // Keep first 2 messages (usually initial context) and last 8 (recent activity)
  const keepFirst = 2;
  const keepLast = 8;
  const middle = messages.slice(keepFirst, -keepLast);

  // Build a summary of the middle messages
  const summaryParts: string[] = ["[Previous conversation compacted. Key context preserved below.]", ""];

  for (const msg of middle) {
    if ("role" in msg) {
      const m = msg as any;
      if (m.role === "user" && typeof m.content === "string") {
        // Summarize user messages briefly
        const text = m.content as string;
        if (text.length > 200) {
          summaryParts.push(`User: ${text.slice(0, 200)}...`);
        }
      } else if (m.role === "assistant" && Array.isArray(m.content)) {
        // Extract key decisions from assistant messages
        for (const block of m.content) {
          if (block.type === "text" && typeof block.text === "string") {
            const text = block.text as string;
            // Keep lines mentioning trades, positions, or decisions
            const importantLines = text.split("\n").filter((line: string) =>
              /\b(bought|sold|buy|sell|position|portfolio|P&?L|alert|warning|risk)\b/i.test(line),
            );
            if (importantLines.length > 0) {
              summaryParts.push(...importantLines.slice(0, 5));
            }
          }
        }
      }
    }
  }

  const summaryMessage: AgentMessage = {
    role: "user",
    content: summaryParts.join("\n"),
    timestamp: Date.now(),
  };

  return [
    ...messages.slice(0, keepFirst),
    summaryMessage,
    ...messages.slice(-keepLast),
  ];
}

/**
 * Run a single agent turn with full event handling and persistence.
 *
 * The Pi SDK Agent handles the entire tool-calling loop internally:
 *   prompt → LLM call → tool execution → result → loop until done
 *
 * Events stream back via subscribe() for real-time UI updates.
 */
export async function runAgentTurn(
  agent: Agent,
  sessionStore: SessionStore,
  userMessage: string,
  config: OpenPawConfig,
  callbacks?: {
    onTextDelta?: (delta: string) => void;
    onToolUse?: (toolName: string) => void;
    onAgentEnd?: () => void;
  },
): Promise<AgentRunResult> {
  // Refresh system prompt (memory/time may have changed since last turn)
  agent.setSystemPrompt(buildSystemPrompt(config));

  const toolsUsed: string[] = [];
  let fullResponse = "";

  // Subscribe to events for streaming + tracking
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const evt = event.assistantMessageEvent;
        if (evt.type === "text_delta") {
          callbacks?.onTextDelta?.(evt.delta);
        }
        break;
      }
      case "message_end": {
        const msg = event.message;
        if (msg && "content" in msg && Array.isArray((msg as PiAssistantMessage).content)) {
          const assistantMsg = msg as PiAssistantMessage;
          const texts = assistantMsg.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          if (texts.length > 0) {
            fullResponse = texts.join("\n");
          }
        }
        break;
      }
      case "tool_execution_start": {
        toolsUsed.push(event.toolName);
        callbacks?.onToolUse?.(event.toolName);
        break;
      }
      case "agent_end": {
        // Persist all messages from this turn to transcript
        // The agent's state.messages contains the full conversation
        const allMessages = event.messages;
        if (allMessages && Array.isArray(allMessages)) {
          // Only persist new messages (the ones we haven't already saved)
          // The agent_end event gives us the final message list
          // We persist the user prompt and the final assistant messages
          const userMsg: AgentMessage = {
            role: "user",
            content: userMessage,
            timestamp: Date.now(),
          };
          sessionStore.append(userMsg, { toolsUsed });

          // Find and persist all assistant + toolResult messages from this turn
          // (they're the ones after our user message in the agent's state)
          for (const m of allMessages.slice(-toolsUsed.length * 2 - 1)) {
            if ("role" in m && (m as any).role !== "user") {
              sessionStore.append(m);
            }
          }
        }
        callbacks?.onAgentEnd?.();
        break;
      }
    }
  });

  try {
    await agent.prompt(userMessage);
    await agent.waitForIdle();
  } finally {
    unsubscribe();
  }

  return { response: fullResponse, toolsUsed };
}

export const DEFAULT_SOUL = `You are OpenPaw, an autonomous stock trading assistant.

You manage a stock portfolio on Alpaca and keep your owner informed via WhatsApp.
You analyze stocks using fundamental, technical, sentiment, and news analysis.
You execute trades when confident, following risk management rules.

## Identity
- Name: OpenPaw
- Role: Autonomous stock trading agent
- Communication: WhatsApp (your owner's personal number)
- Personality: Direct, data-driven, calm under pressure

## Rules
- Always check current positions before buying to avoid over-concentration
- Never risk more than the configured maxPositionSize per trade
- Never put more than maxPortfolioRisk of the portfolio in a single stock
- Use paper trading for testing strategies before going live
- When uncertain, recommend analysis rather than acting
- Be concise in WhatsApp messages - lead with the action and key numbers
- Log every trade with reasoning

## Memory
- Use memory_write with target "daily" to log important events, trades, and decisions
- Use memory_write with target "curated" to save stable patterns, lessons learned, and key portfolio insights
- Use memory_read to recall past decisions and patterns
- Use memory_search to find relevant past context

## Heartbeat Behavior
When doing heartbeat checks, only message the owner if something notable happened.
For routine checks where everything is stable, respond with empty text.
Only alert on: significant P&L changes, filled orders, >2% movers in watchlist, breaking news.`;

export const DEFAULT_HEARTBEAT = `# Heartbeat Checklist

Run through these checks. Only message the owner if something is notable.

1. Check portfolio positions and unrealized P&L
2. Check for any filled or partially filled orders
3. Scan watchlist for significant price moves (>2% intraday)
4. Check for breaking news on our holdings
5. Review any pending limit/stop orders that may be close to triggering

If everything is normal, respond with empty text.
If something needs attention, be concise: lead with what happened, then the numbers.
Save notable events to today's daily log.`;
