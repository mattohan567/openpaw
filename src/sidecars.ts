/**
 * Python sidecar process manager.
 *
 * Auto-starts, health-checks, and stops the Python FastAPI services
 * (quant-analysis on port 8200, backtesting on port 8300).
 * Called from the gateway so `openpaw gateway run` is a single command.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface SidecarConfig {
  name: string;
  dir: string;
  port: number;
}

const SIDECARS: SidecarConfig[] = [
  {
    name: "quant-analysis",
    dir: join(PROJECT_ROOT, "services", "quant-analysis"),
    port: 8200,
  },
  {
    name: "backtesting",
    dir: join(PROJECT_ROOT, "services", "backtesting"),
    port: 8300,
  },
];

interface RunningService {
  config: SidecarConfig;
  process: ChildProcess;
}

const running: RunningService[] = [];

function findPython(serviceDir: string): string | null {
  // Check for venv inside the service directory first
  const venvPython = join(serviceDir, ".venv", "bin", "python");
  if (existsSync(venvPython)) return venvPython;

  // Check for venv python3
  const venvPython3 = join(serviceDir, ".venv", "bin", "python3");
  if (existsSync(venvPython3)) return venvPython3;

  // Fall back to system python
  return "python3";
}

async function waitForHealthy(port: number, timeoutMs: number = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function startSidecars(): Promise<void> {
  for (const sidecar of SIDECARS) {
    const serverFile = join(sidecar.dir, "server.py");

    if (!existsSync(serverFile)) {
      console.log(`[Sidecar] ${sidecar.name}: server.py not found, skipping.`);
      continue;
    }

    const python = findPython(sidecar.dir);
    if (!python) {
      console.log(`[Sidecar] ${sidecar.name}: no Python found, skipping.`);
      continue;
    }

    // Check if venv exists, if not prompt user
    const venvPath = join(sidecar.dir, ".venv");
    if (!existsSync(venvPath)) {
      console.log(
        `[Sidecar] ${sidecar.name}: no .venv found. Run: cd ${sidecar.dir} && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`,
      );
      continue;
    }

    // Check if already running on this port
    try {
      const res = await fetch(`http://127.0.0.1:${sidecar.port}/health`);
      if (res.ok) {
        console.log(`[Sidecar] ${sidecar.name}: already running on port ${sidecar.port}.`);
        continue;
      }
    } catch {
      // Not running, good — we'll start it
    }

    console.log(`[Sidecar] Starting ${sidecar.name} on port ${sidecar.port}...`);

    const child = spawn(python, [serverFile], {
      cwd: sidecar.dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Prefix child output with sidecar name
    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        console.log(`[${sidecar.name}] ${line}`);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        // Filter out noisy uvicorn info lines that go to stderr
        if (line.includes("INFO:")) {
          console.log(`[${sidecar.name}] ${line}`);
        } else {
          console.error(`[${sidecar.name}] ${line}`);
        }
      }
    });

    child.on("exit", (code) => {
      console.log(`[Sidecar] ${sidecar.name} exited (code ${code}).`);
    });

    running.push({ config: sidecar, process: child });

    // Wait for it to become healthy
    const healthy = await waitForHealthy(sidecar.port);
    if (healthy) {
      console.log(`[Sidecar] ${sidecar.name} ready on port ${sidecar.port}.`);
    } else {
      console.warn(
        `[Sidecar] ${sidecar.name} did not respond to health check within 15s. Quant tools may not work.`,
      );
    }
  }
}

export function stopSidecars(): void {
  for (const service of running) {
    try {
      service.process.kill("SIGTERM");
      console.log(`[Sidecar] Stopped ${service.config.name}.`);
    } catch {
      // Already dead
    }
  }
  running.length = 0;
}
