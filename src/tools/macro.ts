import type { Tool } from "./types.js";

const QUANT_BASE = "http://127.0.0.1:8200";

async function macroRequest(path: string): Promise<string> {
  const res = await fetch(`${QUANT_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Macro service ${path}: ${res.status} ${text}`);
  }
  return JSON.stringify(await res.json());
}

export function createMacroTools(): Tool[] {
  return [
    {
      name: "get_market_regime",
      description:
        "Get current market regime: risk-on, risk-off, or transition. Checks VIX level, SPY trend, and market breadth. Run this before making new trades to adjust sizing and strategy.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      async execute(_params: Record<string, unknown>): Promise<string> {
        try {
          return await macroRequest("/regime");
        } catch (err) {
          return `Error fetching market regime: ${err instanceof Error ? err.message : String(err)} — is the quant service running on port 8200?`;
        }
      },
    },
    {
      name: "get_sector_rotation",
      description:
        "Get sector rotation analysis: ranks 11 sector ETFs by recent performance, identifies offensive vs defensive leadership. Helps identify where money is flowing.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      async execute(_params: Record<string, unknown>): Promise<string> {
        try {
          return await macroRequest("/sectors");
        } catch (err) {
          return `Error fetching sector rotation: ${err instanceof Error ? err.message : String(err)} — is the quant service running on port 8200?`;
        }
      },
    },
    {
      name: "get_macro_dashboard",
      description:
        "Get combined macro dashboard: VIX, SPY trend, sector leadership, TLT (bonds), and overall market regime. One-stop macro check before trading.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      async execute(_params: Record<string, unknown>): Promise<string> {
        try {
          return await macroRequest("/macro");
        } catch (err) {
          return `Error fetching macro dashboard: ${err instanceof Error ? err.message : String(err)} — is the quant service running on port 8200?`;
        }
      },
    },
  ];
}
