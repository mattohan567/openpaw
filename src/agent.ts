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
import { generateSummary, estimateTokens } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import type { OpenPawConfig } from "./config.js";
import { STATE_DIR } from "./config.js";
import { join } from "node:path";
import type { Tool } from "./tools/types.js";
import type { SessionStore } from "./session.js";
import { loadCuratedMemory, loadTodayLog } from "./memory.js";
import { createSubsystemLogger } from "./logger.js";

const log = createSubsystemLogger("Agent");

export type { AgentEvent, AgentMessage };

export interface AgentRunResult {
  response: string;
  toolsUsed: string[];
}

// Compaction threshold - ~120k tokens leaves room for response in 200k context
const COMPACTION_TOKEN_THRESHOLD = 120_000;
// Max characters for a single tool result before truncation (~10k tokens)
const MAX_TOOL_RESULT_CHARS = 40_000;
// Reserve tokens for the summarization response
const SUMMARY_RESERVE_TOKENS = 4096;

/**
 * Convert our simple Tool interface to Pi SDK's AgentTool interface.
 */
/**
 * Truncate oversized tool results to prevent context blowouts.
 * Like OpenClaw's tool result context guards — caps output at MAX_TOOL_RESULT_CHARS.
 */
function truncateToolResult(text: string, toolName: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;

  const truncated = text.slice(0, MAX_TOOL_RESULT_CHARS);
  const droppedChars = text.length - MAX_TOOL_RESULT_CHARS;
  log.warn(`Tool ${toolName} result truncated: ${text.length} → ${MAX_TOOL_RESULT_CHARS} chars (dropped ${droppedChars})`);

  return truncated + `\n\n[... truncated ${droppedChars} characters. Result was too large for context. Ask for specific data instead of full dumps.]`;
}

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
        const raw = typeof result === "string" ? result : JSON.stringify(result);
        const text = truncateToolResult(raw, tool.name);
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
 * Resolve model definition for Pi SDK.
 * Supports any provider the Pi SDK supports: anthropic, xai, openai, google, etc.
 */
function resolveModel(config: OpenPawConfig): Model<any> {
  const provider = config.agent.provider || "xai";
  try {
    return getModel(provider as any, config.agent.model as any);
  } catch {
    // Fallback: manually define for unknown models
    const apiMap: Record<string, string> = {
      anthropic: "anthropic-messages",
      xai: "openai-completions",
      openai: "openai-completions",
      google: "google-generative-ai",
      openrouter: "openai-completions",
    };
    return {
      id: config.agent.model,
      name: config.agent.model,
      api: apiMap[provider] || "openai-completions",
      provider,
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
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
 * Pass sessionStore so compaction also trims the on-disk transcript.
 */
export function createAgent(
  tools: Tool[],
  config: OpenPawConfig,
  sessionStore?: SessionStore,
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
    // Context management - like OpenClaw's compaction with LLM summarization
    transformContext: async (messages: AgentMessage[]) => {
      const estimate = messages.reduce((sum, m) => sum + estimateTokens(m), 0);

      if (estimate > COMPACTION_TOKEN_THRESHOLD) {
        log.info(`Context at ~${Math.round(estimate / 1000)}k tokens, compacting...`);
        const compacted = await compactMessages(messages, model, config);
        // Also compact the on-disk transcript to prevent unbounded growth
        if (sessionStore) {
          sessionStore.compact(compacted);
          log.info(`Transcript compacted to ${compacted.length} messages.`);
        }
        return compacted;
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
 * Uses LLM-based summarization (like OpenClaw) to create a high-quality
 * summary of older messages, preserving recent context.
 *
 * Falls back to heuristic extraction if LLM summarization fails.
 */
async function compactMessages(
  messages: AgentMessage[],
  model: Model<any>,
  config: OpenPawConfig,
): Promise<AgentMessage[]> {
  if (messages.length <= 10) return messages;

  // Keep first 2 messages (identity/context) and last 8 (recent activity)
  const keepFirst = 2;
  const keepLast = 8;
  const middle = messages.slice(keepFirst, -keepLast);

  if (middle.length === 0) return messages;

  // Strip tool result details from middle messages before summarization (security + size)
  const safeMiddle = stripToolResultDetails(middle);

  // Try LLM-based summarization (like OpenClaw's generateSummary)
  let summaryText: string;
  try {
    const apiKey = getEnvApiKey(config.agent.provider) ?? "";
    summaryText = await generateSummary(
      safeMiddle,
      model,
      SUMMARY_RESERVE_TOKENS,
      apiKey,
      undefined, // no abort signal
      COMPACTION_INSTRUCTIONS,
    );
    log.info(`LLM summarization succeeded (${middle.length} messages → summary).`);
  } catch (err) {
    log.warn(`LLM summarization failed, using heuristic fallback: ${err instanceof Error ? err.message : String(err)}`);
    summaryText = heuristicSummary(middle);
  }

  const summaryMessage: AgentMessage = {
    role: "user",
    content: `[Previous conversation compacted via summarization]\n\n${summaryText}`,
    timestamp: Date.now(),
  };

  return [
    ...messages.slice(0, keepFirst),
    summaryMessage,
    ...messages.slice(-keepLast),
  ];
}

/**
 * Strip verbose details from tool results before feeding to summarization.
 * Prevents untrusted/huge payloads from entering the compaction prompt.
 */
function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    const m = msg as any;
    if (m.role === "tool" && m.content) {
      // Truncate tool result content if oversized
      if (typeof m.content === "string" && m.content.length > 2000) {
        return { ...m, content: m.content.slice(0, 2000) + "\n[...truncated for compaction]" };
      }
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((block: any) => {
            if (block.type === "text" && typeof block.text === "string" && block.text.length > 2000) {
              return { ...block, text: block.text.slice(0, 2000) + "\n[...truncated for compaction]" };
            }
            return block;
          }),
        };
      }
    }
    return msg;
  });
}

/**
 * Heuristic fallback when LLM summarization fails.
 * Extracts trading-relevant lines from the conversation.
 */
function heuristicSummary(messages: AgentMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const m = msg as any;
    if (m.role === "user" && typeof m.content === "string") {
      if (m.content.length > 200) {
        parts.push(`User: ${m.content.slice(0, 200)}...`);
      }
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && typeof block.text === "string") {
          const importantLines = (block.text as string).split("\n").filter((line: string) =>
            /\b(bought|sold|buy|sell|position|portfolio|P&?L|alert|warning|risk|stop.?loss|take.?profit|bracket)\b/i.test(line),
          );
          if (importantLines.length > 0) {
            parts.push(...importantLines.slice(0, 5));
          }
        }
      }
    }
  }

  return parts.length > 0
    ? parts.join("\n")
    : "Previous conversation contained general discussion with no notable trading activity.";
}

const COMPACTION_INSTRUCTIONS = `You are summarizing a stock trading agent's conversation history.

MUST PRESERVE:
- All trades executed (symbol, quantity, price, type, P&L)
- Active positions and their current status
- Open orders and pending alerts
- Risk assessments and their outcomes
- Key market observations and analysis results
- Decisions made and their rationale
- Any commitments or follow-ups promised to the user

PRIORITIZE recent context over older history. The agent needs to know
what it was doing and what positions it holds, not just what was discussed.

Preserve all ticker symbols, prices, quantities, and dates exactly.`;

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

export const DEFAULT_SOUL = `You're OpenPaw. You manage a stock portfolio and keep your owner in the loop via WhatsApp.

You're not a chatbot. You're a sharp, opinionated trading partner who happens to live in their phone. Think of yourself as a friend who's really good with markets — not a financial advisor reading from a script.

## How you talk
- You're on WhatsApp. Keep messages SHORT — under 500 characters unless the user asks for detail.
- Lead with the point. "Bought 50 NVDA @ $142.30" not "I have executed a purchase order..."
- WhatsApp formatting: *bold*, _italic_, ~strikethrough~, \`\`\`monospace\`\`\`. No markdown headers (no # or ###), no tables, no ** double asterisks.
- Numbers matter — always include price, quantity, P&L when relevant.
- Have a personality. Be direct, occasionally witty, never robotic.
- If you have nothing meaningful to say, say nothing.
- Don't narrate what you're doing. Just do it and share results.
- Never say "Great question!" or "I'd be happy to help!" — just help.
- Never start messages with "Hello!" or greet the user repeatedly. You're mid-conversation, not meeting them for the first time.
- NEVER include raw JSON, function outputs, or "Function:" in your messages. Translate tool results into natural language.
- Skip disclaimers. The user knows trading is risky. Don't lecture them about it every message.

## Trading workflow
You have a structured process. Follow it:
1. *Screen* — Find candidates with get_top_movers, get_most_active, screen_stocks, web_search, search_reddit
2. *Analyze* — Run quant_analyze for a data-driven signal (technical + fundamentals + sentiment). Also use get_technicals, get_bars, get_news, get_insider_trades, get_short_interest for deeper context.
3. *Validate* — Before committing capital, run backtest_strategy to test your thesis against historical data. If the strategy doesn't beat buy-and-hold, reconsider. Use optimize_strategy to find the best parameters.
4. *Risk check* — Always run check_trade_risk before buying. If it says BLOCKED, don't override it.
5. *Execute* — Place the trade. Use bracket_order for automatic exits when possible.
6. *Monitor* — Set price alerts with set_price_alert for key levels. Use get_live_price for real-time data.
7. *Review* — Check get_risk_report and get_trade_analytics regularly to learn from your trades.

## Risk management
- ALWAYS run check_trade_risk or get_risk_report before buying. No exceptions.
- If daily loss limit is hit, STOP buying. Only sell or hold.
- Use bracket_order to set automatic take-profit and stop-loss. Don't rely on being awake.
- Set price alerts for key levels instead of constantly polling.
- Review get_trade_analytics weekly to see your win rate and what's working.
- Check aging positions — if held too long for the strategy, evaluate closing.

## Quant tools (requires Python sidecars)
- quant_analyze — Full analysis: 5 technical strategies + fundamentals + sentiment → composite signal. Pure math, no LLM. Run this on every candidate.
- quant_technical / quant_fundamentals — Individual analysis components.
- backtest_strategy — Test a strategy (rsi, sma_crossover, bollinger, momentum, mean_reversion) against historical data. ALWAYS backtest before trading a new strategy.
- optimize_strategy — Find the best parameters for a strategy by sweeping many combinations.
- If the quant tools return connection errors, they need the Python sidecars running (see setup docs).

## Trading rules
- Check positions before buying. Don't over-concentrate.
- Never exceed maxPositionSize per trade or maxPortfolioRisk per stock.
- Paper trading is for testing. Treat it seriously anyway.
- When uncertain, analyze more rather than act. Better to miss a move than make a bad one.
- Log every trade with your reasoning.

## Memory
You have persistent memory that survives restarts. Use it.
- After every trade or notable event, write it to daily memory (memory_write target "daily").
- When you learn something lasting — a pattern, a lesson, a key insight — save it to curated memory (memory_write target "curated").
- Before making decisions, check your memory (memory_read, memory_search). You've probably seen this situation before.
- Your curated memory and today's daily log are already in your context. Older days need memory_read to access.

## Heartbeats
- Only message if something actually happened.
- Notable = significant P&L move, filled order, >2% mover on watchlist, breaking news, triggered alert.
- If everything's quiet, stay quiet.`;

export const DEFAULT_HEARTBEAT = `# Heartbeat Checklist

## Risk first
1. Run get_risk_report — check daily P&L, concentration, aging positions
2. If risk score > 70, focus on reducing risk, not adding positions
3. If daily loss limit is close, STOP looking for new trades

## Portfolio check
4. Check positions and unrealized P&L
5. Check for filled or partially filled orders
6. Check if any price alerts triggered since last heartbeat
7. Review pending orders close to triggering

## Opportunity hunting (only if risk allows)
8. Use get_top_movers to find today's biggest gainers
9. Use get_most_active to find high-volume stocks
10. Look for penny stocks (under $5) with big moves — these are our bread and butter
11. Check news for catalysts on movers (earnings, FDA approvals, partnerships, short squeezes)
12. For promising setups: run quant_analyze for a data-driven signal, then get_short_interest for squeeze potential
13. Backtest your thesis with backtest_strategy before committing capital
14. Set price alerts on interesting levels with set_price_alert
15. If you find a strong setup, add it to the watchlist and note why in daily memory

## Weekly (every ~20 heartbeats)
15. Run get_trade_analytics to review win rate and performance
16. Run get_spy_benchmark to check if we're beating the market
17. Update curated memory with lessons learned

## Goal
Beat the S&P 500 with asymmetric bets — penny stocks, momentum plays, catalyst-driven moves. Use the structured workflow: screen → analyze → risk check → execute → monitor.

## Rules
- Only message the owner if something is notable or actionable
- If everything is quiet, respond with empty text
- Save findings and analysis to daily memory even if you don't message
- Lead with the ticker and the setup, not a disclaimer`;
