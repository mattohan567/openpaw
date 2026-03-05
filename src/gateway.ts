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
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig, type OpenPawConfig } from "./config.js";
import { connectWhatsApp, type WhatsAppClient } from "./whatsapp.js";
import { createOpenPawTools } from "./tools/index.js";
import { createAgent, restoreSession, runAgentTurn } from "./agent.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import { openSession } from "./session.js";
import { startHeartbeat, startMarketOpenJob, startMarketCloseJob } from "./cron.js";
import { AlpacaStream } from "./streaming.js";
import type { Tool } from "./tools/types.js";

export interface GatewayServer {
  httpServer: Server;
  wss: WebSocketServer;
  whatsapp: WhatsAppClient | null;
  stream: AlpacaStream | null;
  config: OpenPawConfig;
  close: () => Promise<void>;
}

export async function startGateway(): Promise<GatewayServer> {
  const config = loadConfig();

  console.log("[Gateway] Starting OpenPaw...");
  console.log(`[Gateway] Port: ${config.gateway.port}`);
  console.log(`[Gateway] Paper trading: ${config.trading.paperTrading}`);

  // Start real-time market data stream
  let stream: AlpacaStream | null = null;
  if (config.streaming.enabled && config.trading.alpacaApiKey) {
    stream = new AlpacaStream(
      config.trading.alpacaApiKey,
      config.trading.alpacaSecretKey,
    );

    stream.on("error", (err) => {
      console.error("[Stream] Error:", err.message);
    });

    stream.on("connected", () => {
      console.log("[Stream] Connected to Alpaca real-time data.");
      // Auto-subscribe to watchlist if configured
      if (config.streaming.streamWatchlist && config.trading.watchlist.length > 0) {
        stream!.subscribe(config.trading.watchlist);
        console.log(`[Stream] Streaming watchlist: ${config.trading.watchlist.join(", ")}`);
      }
    });

    stream.connect();
  } else {
    console.log("[Gateway] Real-time streaming disabled or no API key.");
  }

  // Create tools (pass stream for alert tools)
  const tools = createOpenPawTools(config, stream);
  console.log(`[Gateway] ${tools.length} tools registered.`);

  // Create Pi SDK agent (same engine as OpenClaw)
  const agent = createAgent(tools, config);

  // Open persistent session (JSONL transcript)
  const session = openSession("main");
  console.log(`[Gateway] Session opened (${session.turnCount} entries in transcript).`);

  // Restore agent context from transcript (survives restarts)
  const restored = restoreSession(agent, session);
  if (restored > 0) {
    console.log(`[Gateway] Agent context restored with ${restored} messages.`);
  }

  // Connect WhatsApp (if configured)
  let whatsapp: WhatsAppClient | null = null;

  if (config.whatsapp.ownerNumber) {
    console.log("[Gateway] Connecting WhatsApp...");
    try {
      whatsapp = await connectWhatsApp(config);

      // Wire up: incoming WhatsApp messages → agent → streaming reply
      whatsapp.onMessage(async (text: string) => {
        console.log(`\n[WhatsApp] >>> Owner: ${text}`);

        try {
          const result = await runAgentTurn(agent, session, text, config, {
            onTextDelta: (delta) => {
              // Stream to terminal only, not WhatsApp
              process.stdout.write(delta);
            },
            onToolUse: (toolName) => {
              console.log(`\n[Agent] Using tool: ${toolName}`);
            },
          });

          console.log(`\n[Agent] Done. Tools used: ${result.toolsUsed.length ? result.toolsUsed.join(", ") : "none"}`);

          // Send only the final response to WhatsApp
          if (result.response.trim()) {
            await whatsapp!.sendMessage(result.response);
          }
        } catch (err) {
          console.error("[Agent] Error:", err);
          await whatsapp!.sendMessage(
            `Error processing your request: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
      });

      console.log("[Gateway] WhatsApp connected and listening.");
    } catch (err) {
      console.error("[Gateway] WhatsApp connection failed:", err);
      console.log("[Gateway] Continuing without WhatsApp. Run 'openpaw setup' to configure.");
    }
  } else {
    console.log("[Gateway] WhatsApp not configured. Run 'openpaw setup' to configure.");
  }

  // Notification helper
  const sendWhatsApp = async (text: string) => {
    if (whatsapp) {
      await whatsapp.sendMessage(text);
    } else {
      console.log(`[Notification] ${text}`);
    }
  };

  // Wire up real-time alerts → WhatsApp notifications
  if (stream) {
    stream.on("alert_triggered", async (event) => {
      const alert = event.alert!;
      const currentPrice = event.data.currentPrice as number;
      const msg = `*Alert* ${alert.symbol} ${alert.condition} $${alert.price.toFixed(2)} — now $${currentPrice.toFixed(2)}${alert.message ? `\n${alert.message}` : ""}`;

      console.log(`[Alert] ${msg}`);

      // Notify via WhatsApp
      await sendWhatsApp(msg);

      // Also tell the agent so it can decide what to do
      try {
        const result = await runAgentTurn(
          agent,
          session,
          `PRICE ALERT TRIGGERED: ${alert.symbol} ${alert.condition} $${alert.price.toFixed(2)}. Current price: $${currentPrice.toFixed(2)}.${alert.message ? ` Context: ${alert.message}` : ""} — Should you act on this?`,
          config,
        );
        if (result.response.trim()) {
          await sendWhatsApp(result.response);
        }
      } catch (err) {
        console.error("[Alert] Agent error:", err);
      }
    });
  }

  // Start cron jobs
  const cronCtx = { config, tools, sendWhatsApp, agent, session };
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
          const result = await runAgentTurn(agent, session, msg.text, config, {
            onTextDelta: (delta) => {
              ws.send(JSON.stringify({ type: "stream", delta }));
            },
            onToolUse: (toolName) => {
              ws.send(JSON.stringify({ type: "tool_use", tool: toolName }));
            },
          });
          ws.send(JSON.stringify({
            type: "response",
            text: result.response,
            toolsUsed: result.toolsUsed,
          }));
        }

        if (msg.type === "status") {
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
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: err instanceof Error ? err.message : "Unknown error",
          }),
        );
      }
    });
  });

  // Signal handling
  const shutdown = async () => {
    console.log("\n[Gateway] Shutting down gracefully...");
    try {
      await agent.waitForIdle();
    } catch {}
    heartbeatJob.stop();
    marketOpenJob?.stop();
    marketCloseJob?.stop();
    if (stream) stream.close();
    wss.close();
    httpServer.close();
    if (whatsapp) await whatsapp.close();
    console.log("[Gateway] Shut down.");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.gateway.port, config.gateway.host, () => {
      console.log(`[Gateway] Listening on ${config.gateway.host}:${config.gateway.port}`);
      resolve();
    });
  });

  return {
    httpServer,
    wss,
    whatsapp,
    stream,
    config,
    close: async () => {
      heartbeatJob.stop();
      marketOpenJob?.stop();
      marketCloseJob?.stop();
      if (stream) stream.close();
      wss.close();
      httpServer.close();
      if (whatsapp) await whatsapp.close();
      console.log("[Gateway] Shut down.");
    },
  };
}
