import { Command } from "commander";
import { startGateway } from "./gateway.js";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.js";
import { loadConfig, saveConfig, CONFIG_PATH, STATE_DIR } from "./config.js";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("openpaw")
    .description("Autonomous stock trading agent with WhatsApp notifications")
    .version("0.1.0");

  // Gateway commands
  const gateway = program.command("gateway").description("Manage the OpenPaw gateway");

  gateway
    .command("run")
    .description("Start the gateway (foreground)")
    .action(async () => {
      const server = await startGateway();

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\n[Gateway] Shutting down...");
        await server.close();
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });

  gateway
    .command("status")
    .description("Check gateway status")
    .action(async () => {
      const config = loadConfig();
      try {
        const res = await fetch(`http://${config.gateway.host}:${config.gateway.port}/health`);
        const data = await res.json();
        console.log("OpenPaw Gateway Status:");
        console.log(`  Status: ${data.status}`);
        console.log(`  WhatsApp: ${data.whatsapp ? "connected" : "not connected"}`);
        console.log(`  Tools: ${data.tools.length} registered`);
        console.log(`  Paper Trading: ${data.paperTrading}`);
        console.log(`  Uptime: ${Math.round(data.uptime)}s`);
      } catch {
        console.log("Gateway is not running.");
        console.log("Start with: openpaw gateway run");
        console.log("Or install daemon: openpaw daemon install");
      }
    });

  // Daemon commands
  const daemon = program.command("daemon").description("Manage the background daemon (macOS)");

  daemon
    .command("install")
    .description("Install OpenPaw as a background service (auto-start on login)")
    .action(() => installDaemon());

  daemon
    .command("uninstall")
    .description("Stop and remove the background service")
    .action(() => uninstallDaemon());

  daemon
    .command("status")
    .description("Check daemon status")
    .action(() => daemonStatus());

  // Setup wizard
  program
    .command("setup")
    .description("Configure OpenPaw (Alpaca keys, WhatsApp, etc.)")
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      const config = loadConfig();

      console.log("\n=== OpenPaw Setup ===\n");
      console.log(`Config: ${CONFIG_PATH}\n`);

      // Alpaca
      console.log("--- Alpaca Trading API ---");
      const apiKey = await ask(`Alpaca API Key [${config.trading.alpacaApiKey ? "***set***" : "not set"}]: `);
      if (apiKey) config.trading.alpacaApiKey = apiKey;

      const secretKey = await ask(`Alpaca Secret Key [${config.trading.alpacaSecretKey ? "***set***" : "not set"}]: `);
      if (secretKey) config.trading.alpacaSecretKey = secretKey;

      const paperStr = await ask(`Paper trading? (yes/no) [${config.trading.paperTrading ? "yes" : "no"}]: `);
      if (paperStr.toLowerCase() === "no") {
        config.trading.paperTrading = false;
        config.trading.alpacaBaseUrl = "https://api.alpaca.markets";
      } else if (paperStr.toLowerCase() === "yes") {
        config.trading.paperTrading = true;
        config.trading.alpacaBaseUrl = "https://paper-api.alpaca.markets";
      }

      // WhatsApp
      console.log("\n--- WhatsApp ---");
      const phone = await ask(`Your phone number (E.164, e.g. +15551234567) [${config.whatsapp.ownerNumber || "not set"}]: `);
      if (phone) config.whatsapp.ownerNumber = phone;

      // Watchlist
      console.log("\n--- Watchlist ---");
      console.log(`Current: ${config.trading.watchlist.join(", ")}`);
      const watchlist = await ask("Watchlist (comma-separated tickers, or Enter to keep): ");
      if (watchlist.trim()) {
        config.trading.watchlist = watchlist
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
      }

      // Risk
      console.log("\n--- Risk Management ---");
      const maxPos = await ask(`Max position size ($) [${config.trading.maxPositionSize}]: `);
      if (maxPos) config.trading.maxPositionSize = Number(maxPos);

      const maxRisk = await ask(
        `Max portfolio % in single stock [${config.trading.maxPortfolioRisk}]: `,
      );
      if (maxRisk) config.trading.maxPortfolioRisk = Number(maxRisk);

      saveConfig(config);
      console.log(`\nConfig saved to ${CONFIG_PATH}`);
      console.log("\nNext steps:");
      console.log("  1. Start: openpaw gateway run");
      console.log("  2. Scan the WhatsApp QR code when prompted");
      console.log("  3. Install daemon: openpaw daemon install");

      rl.close();
    });

  // Chat (send message to running gateway via WebSocket)
  program
    .command("chat")
    .description("Chat with the trading agent (connects to running gateway)")
    .action(async () => {
      const config = loadConfig();
      const wsUrl = `ws://${config.gateway.host}:${config.gateway.port}`;

      try {
        const ws = new WebSocket(wsUrl);

        await new Promise<void>((resolve, reject) => {
          ws.on("open", resolve);
          ws.on("error", reject);
        });

        const rl = createInterface({ input: process.stdin, output: process.stdout });

        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "response") {
            console.log(`\nOpenPaw: ${msg.text}`);
            if (msg.toolsUsed?.length) {
              console.log(`  [tools: ${msg.toolsUsed.join(", ")}]`);
            }
            rl.prompt();
          } else if (msg.type === "error") {
            console.log(`\nError: ${msg.error}`);
            rl.prompt();
          }
        });

        console.log("Connected to OpenPaw. Type your message (Ctrl+C to exit).\n");
        rl.setPrompt("You: ");
        rl.prompt();

        rl.on("line", (line: string) => {
          if (line.trim()) {
            ws.send(JSON.stringify({ type: "message", text: line.trim() }));
          } else {
            rl.prompt();
          }
        });

        rl.on("close", () => {
          ws.close();
          process.exit(0);
        });
      } catch {
        console.log("Could not connect to gateway. Is it running?");
        console.log("Start with: openpaw gateway run");
      }
    });

  // Quick status command
  program
    .command("status")
    .description("Quick status check")
    .action(async () => {
      const config = loadConfig();
      console.log(`Config: ${CONFIG_PATH}`);
      console.log(`Alpaca: ${config.trading.alpacaApiKey ? "configured" : "NOT configured"}`);
      console.log(`WhatsApp: ${config.whatsapp.ownerNumber || "NOT configured"}`);
      console.log(`Paper Trading: ${config.trading.paperTrading}`);
      console.log(`Watchlist: ${config.trading.watchlist.join(", ")}`);
      console.log(`Heartbeat: every ${config.cron.heartbeatMinutes} min`);

      // Check if gateway is running
      try {
        const res = await fetch(`http://${config.gateway.host}:${config.gateway.port}/health`);
        if (res.ok) console.log("Gateway: RUNNING");
      } catch {
        console.log("Gateway: NOT RUNNING");
      }
    });

  return program;
}
