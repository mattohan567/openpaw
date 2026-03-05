import { execSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LOGS_DIR } from "./config.js";

const LABEL = "com.openpaw.gateway";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);

function getNodePath(): string {
  try {
    return execSync("which node", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/node";
  }
}

function getEntryPath(): string {
  // Use the openpaw.mjs in the project directory
  return join(process.cwd(), "openpaw.mjs");
}

function buildPlist(): string {
  const nodePath = getNodePath();
  const entryPath = getEntryPath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryPath}</string>
    <string>gateway</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${join(LOGS_DIR, "gateway.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(LOGS_DIR, "gateway.err.log")}</string>
  <key>WorkingDirectory</key>
  <string>${process.cwd()}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>`;
}

export function installDaemon(): void {
  if (process.platform !== "darwin") {
    console.error("Daemon install is currently only supported on macOS (launchd).");
    console.log("On Linux, create a systemd user service manually.");
    return;
  }

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  if (!existsSync(PLIST_DIR)) mkdirSync(PLIST_DIR, { recursive: true });

  // Unload existing if present
  try {
    execSync(`launchctl bootout gui/$(id -u) ${PLIST_PATH} 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // Ignore - may not be loaded
  }

  // Write plist
  writeFileSync(PLIST_PATH, buildPlist());
  console.log(`[Daemon] Plist written to ${PLIST_PATH}`);

  // Load and start
  try {
    execSync(`launchctl bootstrap gui/$(id -u) ${PLIST_PATH}`);
    execSync(`launchctl kickstart -k gui/$(id -u)/${LABEL}`);
    console.log("[Daemon] OpenPaw gateway installed and started.");
    console.log(`[Daemon] Logs: ${LOGS_DIR}/gateway.log`);
    console.log("[Daemon] The gateway will auto-start on login.");
  } catch (err) {
    console.error("[Daemon] Failed to install:", err);
  }
}

export function uninstallDaemon(): void {
  if (process.platform !== "darwin") {
    console.error("Daemon uninstall is currently only supported on macOS.");
    return;
  }

  try {
    execSync(`launchctl bootout gui/$(id -u) ${PLIST_PATH}`);
    console.log("[Daemon] OpenPaw gateway stopped and uninstalled.");
  } catch {
    console.log("[Daemon] Service was not loaded.");
  }
}

export function daemonStatus(): void {
  if (process.platform !== "darwin") {
    console.log("Daemon status check only supported on macOS.");
    return;
  }

  try {
    const output = execSync(`launchctl print gui/$(id -u)/${LABEL} 2>&1`, { encoding: "utf-8" });
    const running = output.includes("state = running");
    console.log(`[Daemon] Status: ${running ? "running" : "stopped/loaded"}`);
    // Extract PID if available
    const pidMatch = output.match(/pid\s*=\s*(\d+)/);
    if (pidMatch) console.log(`[Daemon] PID: ${pidMatch[1]}`);
  } catch {
    console.log("[Daemon] Not installed. Run 'openpaw daemon install' to set up.");
  }
}
