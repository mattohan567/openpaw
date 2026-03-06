import type { Tool } from "./types.js";

const QUANT_BASE = "http://127.0.0.1:8200";

async function debateRequest(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${QUANT_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Debate service ${path}: ${res.status} ${text}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export function createDebateTools(): Tool[] {
  return [
    {
      name: "debate_trade",
      description:
        "Run a structured bull/bear/risk debate before entering a new position. Calls bull_case, bear_case, and risk_assessment in parallel, then formats a structured analysis. Rule: only proceed if bull confidence > bear confidence by 20%+ AND risk score < 60. REQUIRED before any new position.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          period: { type: "string", description: "Analysis period (default: 6mo)" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const period = (params.period as string) || "6mo";

        try {
          // Run all three analyses in parallel
          const [bull, bear, risk] = await Promise.all([
            debateRequest(`/bull_case/${symbol}?period=${period}`),
            debateRequest(`/bear_case/${symbol}?period=${period}`),
            debateRequest(`/risk_assessment/${symbol}?period=${period}`),
          ]);

          const bullConf = (bull.overall_confidence as number) || 0;
          const bearConf = (bear.overall_confidence as number) || 0;
          const riskScore = (risk.risk_score as number) || 0;
          const confidenceGap = bullConf - bearConf;

          // Decision logic
          let decision: string;
          let proceed: boolean;

          if (confidenceGap >= 20 && riskScore < 60) {
            decision = "PROCEED — bull case dominates by " + confidenceGap + "pts and risk is manageable";
            proceed = true;
          } else if (confidenceGap >= 20 && riskScore >= 60) {
            decision = "CAUTION — bull case is strong but risk score is high (" + riskScore + "). Reduce size or wait for better entry.";
            proceed = false;
          } else if (confidenceGap > 0) {
            decision = "WEAK BULL — gap is only " + confidenceGap + "pts. Not enough edge. Pass or wait.";
            proceed = false;
          } else {
            decision = "PASS — bear case dominates. Do not enter.";
            proceed = false;
          }

          // Format report
          const lines: string[] = [];
          lines.push(`=== Trade Debate: ${symbol} ===\n`);
          lines.push(`*Decision: ${decision}*\n`);

          lines.push(`Bull case (${bull.strength}, ${bullConf}% confidence):`);
          const bullPoints = bull.points as string[];
          if (bullPoints?.length) {
            for (const p of bullPoints.slice(0, 5)) lines.push(`  + ${p}`);
          } else {
            lines.push("  (no bullish signals found)");
          }
          lines.push("");

          lines.push(`Bear case (${bear.strength}, ${bearConf}% confidence):`);
          const bearPoints = bear.points as string[];
          if (bearPoints?.length) {
            for (const p of bearPoints.slice(0, 5)) lines.push(`  - ${p}`);
          } else {
            lines.push("  (no bearish signals found)");
          }
          lines.push("");

          lines.push(`Risk assessment (score ${riskScore}/100, ${risk.risk_level}):`);
          const risks = risk.risks as Array<Record<string, unknown>>;
          if (risks?.length) {
            for (const r of risks.slice(0, 5)) lines.push(`  ! [${r.severity}] ${r.detail}`);
          } else {
            lines.push("  No significant risks identified");
          }
          lines.push("");

          lines.push(`Confidence gap: bull ${bullConf}% vs bear ${bearConf}% = ${confidenceGap > 0 ? "+" : ""}${confidenceGap}pts`);
          lines.push(`Proceed: ${proceed ? "YES" : "NO"}`);

          return lines.join("\n");
        } catch (err) {
          return `Trade debate failed (is the quant service running on port 8200?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "get_valuation",
      description:
        "Get intrinsic value estimate for a stock using DCF analysis and valuation multiples (P/E, P/B, PEG, EV/EBITDA). Shows margin of safety — how cheap or expensive the stock is vs its estimated fair value. Use this to avoid overpaying.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        try {
          const res = await fetch(`${QUANT_BASE}/valuation/${symbol}`);
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`Valuation ${res.status}: ${text}`);
          }
          return JSON.stringify(await res.json());
        } catch (err) {
          return `Valuation failed (is the quant service running on port 8200?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
    {
      name: "get_strategy_recommendations",
      description:
        "Get strategy performance analysis from trade history. Shows which strategies have the best win rate and returns, optionally filtered by current market regime. Use this to pick the right strategy for current conditions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          current_regime: {
            type: "string",
            description: 'Current regime: "bull", "bear", "sideways", or "unknown" (default: unknown)',
          },
          days: { type: "number", description: "Analyze last N days of trades (default: 90)" },
        },
      },
      execute: async (params) => {
        const body: Record<string, unknown> = {
          current_regime: (params.current_regime as string) || "unknown",
          days: (params.days as number) || 90,
        };
        try {
          const res = await fetch(`http://127.0.0.1:8300/strategy_performance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`Strategy performance ${res.status}: ${text}`);
          }
          return JSON.stringify(await res.json());
        } catch (err) {
          return `Strategy recommendations failed (is the backtest service running on port 8300?): ${err instanceof Error ? err.message : "unknown"}`;
        }
      },
    },
  ];
}
