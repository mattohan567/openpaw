import { Command } from "commander";
import { startGateway } from "./gateway.js";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.js";
import { loadConfig, saveConfig, CONFIG_PATH, STATE_DIR, ensureStateDir } from "./config.js";
import { DEFAULT_SOUL, DEFAULT_HEARTBEAT } from "./agent.js";
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";

function createWorkspaceFiles() {
  ensureStateDir();

  const soulPath = join(STATE_DIR, "SOUL.md");
  if (!existsSync(soulPath)) {
    writeFileSync(soulPath, DEFAULT_SOUL);
    console.log(`[Setup] Created ${soulPath}`);
  }

  const heartbeatPath = join(STATE_DIR, "HEARTBEAT.md");
  if (!existsSync(heartbeatPath)) {
    writeFileSync(heartbeatPath, DEFAULT_HEARTBEAT);
    console.log(`[Setup] Created ${heartbeatPath}`);
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("openpaw")
    .description("Autonomous stock trading agent with WhatsApp notifications")
    .version("0.1.0");

  // === ONBOARD (single command like OpenClaw) ===
  program
    .command("onboard")
    .description("Set up and start OpenPaw in one step (like openclaw onboard)")
    .option("--install-daemon", "Also install as background service")
    .action(async (opts) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      console.log("\n  OpenPaw - Autonomous Stock Trading Agent\n");
      console.log("  Let's get you set up.\n");

      const config = loadConfig();

      // 1. LLM Provider
      console.log("  Step 1: AI Model\n");
      console.log("  Providers: xai (Grok), anthropic (Claude), openai (GPT), google (Gemini)");
      const provider = await ask(`  Provider [${config.agent.provider}]: `);
      if (provider) config.agent.provider = provider;

      const modelHelp: Record<string, string> = {
        xai: "grok-3-fast, grok-4, grok-4-fast",
        anthropic: "claude-sonnet-4-20250514, claude-opus-4-20250514",
        openai: "gpt-5-mini, gpt-5.2",
        google: "gemini-2.5-pro",
      };
      const hint = modelHelp[config.agent.provider] || "";
      const model = await ask(`  Model${hint ? ` (${hint})` : ""} [${config.agent.model}]: `);
      if (model) config.agent.model = model;

      // Check API key
      const envKeyMap: Record<string, string> = {
        xai: "XAI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        google: "GOOGLE_API_KEY",
      };
      const envKey = envKeyMap[config.agent.provider];
      if (envKey && !process.env[envKey]) {
        console.log(`\n  Warning: ${envKey} not set in environment.`);
        console.log(`  Set it: export ${envKey}="your-key-here"`);
        const cont = await ask("  Continue anyway? (y/n) [y]: ");
        if (cont.toLowerCase() === "n") {
          rl.close();
          return;
        }
      } else if (envKey) {
        console.log(`  ${envKey}: set`);
      }

      // 2. Alpaca
      console.log("\n  Step 2: Alpaca Trading\n");
      console.log("  Get keys at https://app.alpaca.markets/paper/dashboard/overview");
      const apiKey = await ask(`  Alpaca API Key [${config.trading.alpacaApiKey ? "***set***" : "not set"}]: `);
      if (apiKey) config.trading.alpacaApiKey = apiKey;

      const secretKey = await ask(`  Alpaca Secret Key [${config.trading.alpacaSecretKey ? "***set***" : "not set"}]: `);
      if (secretKey) config.trading.alpacaSecretKey = secretKey;

      const paperStr = await ask(`  Paper trading? (yes/no) [${config.trading.paperTrading ? "yes" : "no"}]: `);
      if (paperStr.toLowerCase() === "no") {
        config.trading.paperTrading = false;
        config.trading.alpacaBaseUrl = "https://api.alpaca.markets";
      } else if (paperStr.toLowerCase() === "yes") {
        config.trading.paperTrading = true;
        config.trading.alpacaBaseUrl = "https://paper-api.alpaca.markets";
      }

      // 3. WhatsApp
      console.log("\n  Step 3: WhatsApp\n");
      const phone = await ask(`  Your phone number (E.164, e.g. +15551234567) [${config.whatsapp.ownerNumber || "not set"}]: `);
      if (phone) config.whatsapp.ownerNumber = phone;

      // 4. Watchlist & Risk
      console.log("\n  Step 4: Trading Preferences\n");
      console.log(`  Current watchlist: ${config.trading.watchlist.join(", ")}`);
      const watchlist = await ask("  Watchlist (comma-separated, or Enter to keep): ");
      if (watchlist.trim()) {
        config.trading.watchlist = watchlist.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      }

      const maxPos = await ask(`  Max $ per position [${config.trading.maxPositionSize}]: `);
      if (maxPos) config.trading.maxPositionSize = Number(maxPos);

      // Save config + create workspace files
      saveConfig(config);
      createWorkspaceFiles();
      console.log(`\n  Config saved to ${CONFIG_PATH}`);
      console.log(`  Workspace: ${STATE_DIR}/`);

      rl.close();

      // Install daemon if requested
      if (opts.installDaemon) {
        console.log("\n  Installing background daemon...");
        installDaemon();
      }

      // Start gateway
      console.log("\n  Starting OpenPaw gateway...\n");
      if (config.whatsapp.ownerNumber) {
        console.log("  Scan the QR code below with WhatsApp to link your agent.\n");
      }

      const server = await startGateway();

      const shutdown = async () => {
        console.log("\n[Gateway] Shutting down...");
        await server.close();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });

  // === Gateway commands ===
  const gateway = program.command("gateway").description("Manage the OpenPaw gateway");

  gateway
    .command("run")
    .description("Start the gateway (foreground)")
    .action(async () => {
      createWorkspaceFiles();
      const server = await startGateway();

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
      }
    });

  // === Daemon commands ===
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

  // === Setup (standalone, for reconfiguring) ===
  program
    .command("setup")
    .description("Reconfigure OpenPaw settings")
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      const config = loadConfig();

      console.log("\n=== OpenPaw Setup ===\n");
      console.log(`Config: ${CONFIG_PATH}\n`);

      // LLM
      console.log("--- LLM Provider ---");
      console.log("Supported: xai (Grok), anthropic (Claude), openai (GPT), google (Gemini)");
      const provider = await ask(`Provider [${config.agent.provider}]: `);
      if (provider) config.agent.provider = provider;

      const modelHelp: Record<string, string> = {
        xai: "grok-3-fast, grok-4, grok-4-fast",
        anthropic: "claude-sonnet-4-20250514, claude-opus-4-20250514",
        openai: "gpt-5-mini, gpt-5.2",
        google: "gemini-2.5-pro",
      };
      const hint = modelHelp[config.agent.provider] || "";
      const model = await ask(`Model${hint ? ` (e.g. ${hint})` : ""} [${config.agent.model}]: `);
      if (model) config.agent.model = model;

      // Alpaca
      console.log("\n--- Alpaca Trading API ---");
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
      const phone = await ask(`Your phone number [${config.whatsapp.ownerNumber || "not set"}]: `);
      if (phone) config.whatsapp.ownerNumber = phone;

      // Watchlist
      console.log("\n--- Watchlist ---");
      console.log(`Current: ${config.trading.watchlist.join(", ")}`);
      const watchlist = await ask("Watchlist (comma-separated, or Enter to keep): ");
      if (watchlist.trim()) {
        config.trading.watchlist = watchlist.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      }

      // Risk
      console.log("\n--- Risk Management ---");
      const maxPos = await ask(`Max position size ($) [${config.trading.maxPositionSize}]: `);
      if (maxPos) config.trading.maxPositionSize = Number(maxPos);

      const maxRisk = await ask(`Max portfolio % in single stock [${config.trading.maxPortfolioRisk}]: `);
      if (maxRisk) config.trading.maxPortfolioRisk = Number(maxRisk);

      saveConfig(config);
      createWorkspaceFiles();
      console.log(`\nConfig saved to ${CONFIG_PATH}`);

      rl.close();
    });

  // === Chat ===
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
          if (msg.type === "stream") {
            process.stdout.write(msg.delta);
          } else if (msg.type === "tool_use") {
            process.stdout.write(`\n  [using ${msg.tool}...]\n`);
          } else if (msg.type === "response") {
            if (msg.toolsUsed?.length) {
              console.log(`\n  [tools: ${msg.toolsUsed.join(", ")}]`);
            }
            console.log();
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
            console.log();
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

  // === Status ===
  program
    .command("status")
    .description("Quick status check")
    .action(async () => {
      const config = loadConfig();
      console.log(`Config: ${CONFIG_PATH}`);
      console.log(`Provider: ${config.agent.provider}/${config.agent.model}`);
      console.log(`Alpaca: ${config.trading.alpacaApiKey ? "configured" : "NOT configured"}`);
      console.log(`WhatsApp: ${config.whatsapp.ownerNumber || "NOT configured"}`);
      console.log(`Paper Trading: ${config.trading.paperTrading}`);
      console.log(`Watchlist: ${config.trading.watchlist.join(", ")}`);
      console.log(`Heartbeat: every ${config.cron.heartbeatMinutes} min`);

      try {
        const res = await fetch(`http://${config.gateway.host}:${config.gateway.port}/health`);
        if (res.ok) console.log("Gateway: RUNNING");
      } catch {
        console.log("Gateway: NOT RUNNING");
      }
    });

  return program;
}
