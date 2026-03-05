/**
 * Gateway server - the always-running control plane.
 *
 * Like OpenClaw's gateway, this:
 * - Runs as a persistent Node.js process
 * - Connects to WhatsApp via Baileys
 * - Routes messages to the Pi SDK agent
 * - Streams responses back as they generate
 * - Runs heartbeat/cron for scheduled checks
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
import { readFileSync, existsSync } from "node:fs";
import type { Tool } from "./tools/types.js";

export interface GatewayServer {
  httpServer: Server;
  wss: WebSocketServer;
  whatsapp: WhatsAppClient | null;
  config: OpenPawConfig;
  close: () => Promise<void>;
}

export async function startGateway(): Promise<GatewayServer> {
  const config = loadConfig();

  console.log("[Gateway] Starting OpenPaw...");
  console.log(`[Gateway] Port: ${config.gateway.port}`);
  console.log(`[Gateway] Paper trading: ${config.trading.paperTrading}`);

  // Create tools
  const tools = createOpenPawTools(config);
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
        console.log(`[WhatsApp] Message from owner: ${text.slice(0, 100)}`);

        // Collect streamed text for WhatsApp (send at sentence boundaries)
        let streamBuffer = "";

        try {
          const result = await runAgentTurn(agent, session, text, config, {
            onTextDelta: (delta) => {
              streamBuffer += delta;

              // Send chunks at paragraph boundaries for WhatsApp readability
              const lastBreak = streamBuffer.lastIndexOf("\n\n");
              if (lastBreak > 100) {
                const chunk = streamBuffer.slice(0, lastBreak);
                streamBuffer = streamBuffer.slice(lastBreak);
                whatsapp!.sendMessage(chunk.trim()).catch(console.error);
              }
            },
            onToolUse: (toolName) => {
              console.log(`[Agent] Using tool: ${toolName}`);
            },
          });

          // Send any remaining text
          if (streamBuffer.trim()) {
            await whatsapp!.sendMessage(streamBuffer.trim());
          } else if (result.response.trim() && !streamBuffer) {
            // Fallback: send full response if streaming didn't produce chunks
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
          tools: tools.map((t) => t.name),
          paperTrading: config.trading.paperTrading,
          sessionTurns: session.turnCount,
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
              tools: tools.length,
              sessionTurns: session.turnCount,
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

  // Signal handling (like OpenClaw's run-loop.ts)
  const shutdown = async () => {
    console.log("\n[Gateway] Shutting down gracefully...");
    // Wait for agent to finish current turn
    try {
      await agent.waitForIdle();
    } catch {}
    heartbeatJob.stop();
    marketOpenJob?.stop();
    marketCloseJob?.stop();
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
    config,
    close: async () => {
      heartbeatJob.stop();
      marketOpenJob?.stop();
      marketCloseJob?.stop();
      wss.close();
      httpServer.close();
      if (whatsapp) await whatsapp.close();
      console.log("[Gateway] Shut down.");
    },
  };
}
