/**
 * Gateway server - the always-running control plane.
 *
 * Like OpenClaw's gateway, this:
 * - Runs as a persistent Node.js process
 * - Connects to WhatsApp via Baileys
 * - Routes messages to the Pi SDK agent
 * - Streams responses back as they generate
 * - Runs heartbeat/cron for scheduled checks
 * - Streams real-time market data via Alpaca WebSocket
 * - Exposes HTTP health check and WebSocket for CLI
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig, type OpenPawConfig } from "./config.js";
import { connectWhatsApp, type WhatsAppClient } from "./whatsapp.js";
import { createOpenPawTools } from "./tools/index.js";
import { createAgent, restoreSession, runAgentTurn, type AgentRunResult } from "./agent.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import { openSession, archiveOldSessions, type SessionStore } from "./session.js";
import { startHeartbeat, startMarketOpenJob, startMarketCloseJob } from "./cron.js";
import { AlpacaStream } from "./streaming.js";
import { startSidecars, stopSidecars } from "./sidecars.js";
import { setNotifySender } from "./tools/notify-owner.js";
import { createSubsystemLogger, pruneOldLogs } from "./logger.js";
import { pruneOldDailyLogs } from "./memory.js";

const log = createSubsystemLogger("Gateway");

export interface GatewayServer {
  httpServer: Server;
  wss: WebSocketServer;
  whatsapp: WhatsAppClient | null;
  stream: AlpacaStream | null;
  config: OpenPawConfig;
  close: () => Promise<void>;
}

/**
 * Mutex for agent turns. The Pi SDK Agent is NOT safe for concurrent prompt() calls.
 * All agent interactions (WhatsApp, WebSocket, heartbeat, alerts) must be serialized.
 */
function createTurnQueue(
  agent: Agent,
  session: SessionStore,
  config: OpenPawConfig,
) {
  let queue: Promise<void> = Promise.resolve();

  return function enqueue(
    userMessage: string,
    callbacks?: Parameters<typeof runAgentTurn>[4],
  ): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve, reject) => {
      queue = queue.then(async () => {
        try {
          const result = await runAgentTurn(agent, session, userMessage, config, callbacks);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  };
}

export async function startGateway(): Promise<GatewayServer> {
  const config = loadConfig();

  log.info("Starting OpenPaw...");
  log.info(`Port: ${config.gateway.port}`);
  log.info(`Paper trading: ${config.trading.paperTrading}`);

  // Prune old logs, sessions, and daily memory on startup
  pruneOldLogs();
  archiveOldSessions();
  pruneOldDailyLogs();

  // Start Python sidecars (quant-analysis, backtesting)
  await startSidecars();

  // Start real-time market data stream
  let stream: AlpacaStream | null = null;
  if (config.streaming.enabled && config.trading.alpacaApiKey) {
    stream = new AlpacaStream(
      config.trading.alpacaApiKey,
      config.trading.alpacaSecretKey,
    );

    stream.on("error", (err) => {
      log.error("Stream error:", err.message);
    });

    stream.on("connected", () => {
      log.info("Connected to Alpaca real-time data.");
      if (config.streaming.streamWatchlist && config.trading.watchlist.length > 0) {
        stream!.subscribe(config.trading.watchlist);
        log.info(`Streaming watchlist: ${config.trading.watchlist.join(", ")}`);
      }
    });

    stream.connect();
  } else {
    log.info("Real-time streaming disabled or no API key.");
  }

  // Create tools (pass stream for alert tools)
  const tools = createOpenPawTools(config, stream);
  log.info(`${tools.length} tools registered.`);

  // Open persistent session (JSONL transcript)
  const session = openSession("main");

  // Create Pi SDK agent (same engine as OpenClaw), pass session for disk compaction
  const agent = createAgent(tools, config, session);
  log.info(`Session opened (${session.turnCount} entries in transcript).`);

  // Restore agent context from transcript (survives restarts)
  const restored = restoreSession(agent, session);
  if (restored > 0) {
    log.info(`Agent context restored with ${restored} messages.`);
  }

  // Serialized agent turn queue — prevents concurrent access
  const enqueueTurn = createTurnQueue(agent, session, config);

  // Connect WhatsApp (if configured)
  let whatsapp: WhatsAppClient | null = null;

  if (config.whatsapp.ownerNumber) {
    log.info("Connecting WhatsApp...");
    try {
      whatsapp = await connectWhatsApp(config);

      whatsapp.onMessage(async (text: string) => {
        log.info(`WhatsApp >>> Owner: ${text}`);

        try {
          const result = await enqueueTurn(text, {
            onTextDelta: (delta) => {
              process.stdout.write(delta);
            },
            onToolUse: (toolName) => {
              log.info(`Using tool: ${toolName}`);
            },
          });

          log.info(`Done. Tools used: ${result.toolsUsed.length ? result.toolsUsed.join(", ") : "none"}`);

          if (result.response.trim()) {
            await whatsapp!.sendMessage(result.response);
          }
        } catch (err) {
          log.error("Agent error:", err);
          try {
            await whatsapp!.sendMessage(
              `Error processing your request: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
          } catch {}
        }
      });

      log.info("WhatsApp connected and listening.");
    } catch (err) {
      log.error("WhatsApp connection failed:", err);
      log.info("Continuing without WhatsApp. Run 'openpaw setup' to configure.");
    }
  } else {
    log.info("WhatsApp not configured. Run 'openpaw setup' to configure.");
  }

  // Notification helper
  const sendWhatsApp = async (text: string) => {
    if (whatsapp) {
      try {
        await whatsapp.sendMessage(text);
      } catch (err) {
        log.error("WhatsApp send failed:", err);
      }
    } else {
      log.info(`Notification: ${text}`);
    }
  };

  // Wire up notify_owner tool so agent can message owner on demand
  setNotifySender(sendWhatsApp);

  // Wire up real-time alerts → WhatsApp notifications
  if (stream) {
    stream.on("alert_triggered", async (event) => {
      const alert = event.alert!;
      const currentPrice = event.data.currentPrice as number;
      const msg = `*Alert* ${alert.symbol} ${alert.condition} $${alert.price.toFixed(2)} — now $${currentPrice.toFixed(2)}${alert.message ? `\n${alert.message}` : ""}`;

      log.info(`Alert: ${msg}`);
      await sendWhatsApp(msg);

      try {
        await enqueueTurn(
          `[SYSTEM:HEARTBEAT] This is an automated price alert from your streaming engine, not a user message. Execute the following:\n\nPRICE ALERT TRIGGERED: ${alert.symbol} ${alert.condition} $${alert.price.toFixed(2)}. Current price: $${currentPrice.toFixed(2)}.${alert.message ? ` Context: ${alert.message}` : ""} — Should you act on this? Use notify_owner if you have actionable advice.`,
        );
      } catch (err) {
        log.error("Alert agent error:", err);
      }
    });
  }

  // Start cron jobs — pass enqueueTurn so heartbeats are serialized too
  const cronCtx = { config, tools, agent, session, enqueueTurn };
  const heartbeatJob = startHeartbeat(cronCtx);
  const marketOpenJob = startMarketOpenJob(cronCtx);
  const marketCloseJob = startMarketCloseJob(cronCtx);

  // HTTP + WebSocket server
  const httpServer = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          whatsapp: !!whatsapp,
          streaming: !!stream,
          tools: tools.map((t) => t.name),
          paperTrading: config.trading.paperTrading,
          sessionTurns: session.turnCount,
          alerts: stream?.getAlerts().length ?? 0,
          uptime: process.uptime(),
        }),
      );
      return;
    }

    if (req.url === "/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const safeConfig = {
        ...config,
        trading: {
          ...config.trading,
          alpacaApiKey: config.trading.alpacaApiKey ? "***configured***" : "",
          alpacaSecretKey: config.trading.alpacaSecretKey ? "***configured***" : "",
        },
      };
      res.end(JSON.stringify(safeConfig));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const wss = new WebSocketServer({ server: httpServer });

  // WebSocket for CLI → agent communication
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "message") {
          const result = await enqueueTurn(msg.text, {
            onTextDelta: (delta) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "stream", delta }));
              }
            },
            onToolUse: (toolName) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "tool_use", tool: toolName }));
              }
            },
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "response",
              text: result.response,
              toolsUsed: result.toolsUsed,
            }));
          }
        }

        if (msg.type === "status") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "status",
                whatsapp: !!whatsapp,
                streaming: !!stream,
                tools: tools.length,
                sessionTurns: session.turnCount,
                alerts: stream?.getAlerts().length ?? 0,
                uptime: process.uptime(),
              }),
            );
          }
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: err instanceof Error ? err.message : "Unknown error",
            }),
          );
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.gateway.port, config.gateway.host, () => {
      log.info(`Listening on ${config.gateway.host}:${config.gateway.port}`);
      resolve();
    });
  });

  const close = async () => {
    log.info("Shutting down gracefully...");
    try {
      await agent.waitForIdle();
    } catch {}
    heartbeatJob.stop();
    marketOpenJob?.stop();
    marketCloseJob?.stop();
    if (stream) stream.close();
    stopSidecars();
    wss.close();
    httpServer.close();
    if (whatsapp) await whatsapp.close();
    log.info("Shut down.");
  };

  return {
    httpServer,
    wss,
    whatsapp,
    stream,
    config,
    close,
  };
}
