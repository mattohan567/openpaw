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
import type { Model, Message, UserMessage, AssistantMessage as PiAssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import type { OpenPawConfig } from "./config.js";
import type { Tool } from "./tools/types.js";
import type { SessionStore } from "./session.js";
import { loadCuratedMemory, loadTodayLog } from "./memory.js";

export type { AgentEvent, AgentMessage };

export interface AgentRunResult {
  response: string;
  toolsUsed: string[];
}

/**
 * Convert our simple Tool interface to Pi SDK's AgentTool interface.
 */
function toPiTool(tool: Tool): AgentTool<any> {
  // Use the raw JSON schema as TypeBox-compatible (pi-ai re-exports Type)
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
  // Try to get from built-in registry first
  try {
    return getModel("anthropic", config.agent.model as any);
  } catch {
    // Fallback: manually define the model
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
 * Build the full system prompt with memory injection.
 * Like OpenClaw's system-prompt.ts that injects SOUL.md + memory + time + context.
 */
export function buildSystemPrompt(basePrompt: string, config: OpenPawConfig): string {
  const parts = [basePrompt];

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
 * Create and configure the Pi SDK Agent instance.
 */
export function createAgent(
  tools: Tool[],
  config: OpenPawConfig,
  systemPrompt: string,
): Agent {
  const model = resolveModel(config);
  const piTools = tools.map(toPiTool);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(systemPrompt, config),
      model,
      thinkingLevel: "off" as ThinkingLevel,
      tools: piTools,
      messages: [],
    },
    streamFn: streamSimple,
    getApiKey: async (provider: string) => {
      return getEnvApiKey(provider) ?? undefined;
    },
  });

  return agent;
}

/**
 * Run a single agent turn with full event handling.
 *
 * Events flow:
 *   agent_start → turn_start → message_start → message_update* → message_end
 *   → tool_execution_start → tool_execution_end* → turn_end → agent_end
 *
 * onTextDelta is called with each text chunk as it streams.
 * onToolUse is called when a tool starts executing.
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
  // Refresh system prompt (memory may have changed)
  const basePrompt = DEFAULT_SOUL; // TODO: load from config.agent.systemPromptFile
  agent.setSystemPrompt(buildSystemPrompt(basePrompt, config));

  const toolsUsed: string[] = [];
  let fullResponse = "";

  // Subscribe to events
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        // Stream text deltas to callback
        const msg = event.message;
        if (msg && "content" in msg && Array.isArray((msg as PiAssistantMessage).content)) {
          const assistantMsg = msg as PiAssistantMessage;
          const evt = event.assistantMessageEvent;
          if (evt.type === "text_delta") {
            callbacks?.onTextDelta?.(evt.delta);
          }
        }
        break;
      }
      case "message_end": {
        // Capture full response text
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
        callbacks?.onAgentEnd?.();
        break;
      }
    }
  });

  // Persist user message to transcript
  sessionStore.append({
    role: "user",
    content: userMessage,
  });

  try {
    // Send the prompt - the agent loop handles tool calling automatically
    await agent.prompt(userMessage);
    await agent.waitForIdle();
  } finally {
    unsubscribe();
  }

  // Persist assistant response
  if (fullResponse) {
    sessionStore.append({
      role: "assistant",
      content: fullResponse,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
    });
  }

  return { response: fullResponse, toolsUsed };
}

export const DEFAULT_SOUL = `You are OpenPaw, an autonomous stock trading assistant.

You manage a stock portfolio on Alpaca and keep your owner informed via WhatsApp.
You analyze stocks using fundamental, technical, sentiment, and news analysis.
You execute trades when confident, following risk management rules.

Rules:
- Always check current positions before buying to avoid over-concentration
- Never risk more than the configured maxPositionSize per trade
- Never put more than maxPortfolioRisk of the portfolio in a single stock
- Use paper trading for testing strategies before going live
- When uncertain, recommend analysis rather than acting
- Be concise in WhatsApp messages - lead with the action and key numbers
- Log every trade with reasoning
- Use memory_write to save important decisions, trade reasoning, and insights to your daily log
- Use memory_write to update curated memory when you learn stable patterns

When doing heartbeat checks, only message the owner if something notable happened.
For routine checks where everything is stable, respond with empty text.`;
