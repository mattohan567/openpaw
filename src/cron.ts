/**
 * Cron/heartbeat system - scheduled market checks.
 *
 * Like OpenClaw's cron system:
 * - Heartbeat runs every N minutes during market hours
 * - Market open job runs at 9:30 AM ET
 * - Market close job runs at 4:05 PM ET
 * - Each job runs a full agent turn and sends results via WhatsApp
 */

import { CronJob } from "cron";
import { isMarketHours, type OpenPawConfig } from "./config.js";
import { runAgentTurn } from "./agent.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { SessionStore } from "./session.js";
import type { Tool } from "./tools/types.js";

export interface HeartbeatContext {
  config: OpenPawConfig;
  tools: Tool[];
  sendWhatsApp: (text: string) => Promise<void>;
  agent: Agent;
  session: SessionStore;
}

export function startHeartbeat(ctx: HeartbeatContext): CronJob {
  const interval = ctx.config.cron.heartbeatMinutes;

  const job = new CronJob(`*/${interval} * * * *`, async () => {
    if (ctx.config.trading.tradingHoursOnly && !isMarketHours()) {
      return;
    }

    console.log(`[Heartbeat] Running at ${new Date().toISOString()}`);

    try {
      const result = await runAgentTurn(
        ctx.agent,
        ctx.session,
        buildHeartbeatPrompt(),
        ctx.config,
      );

      if (result.response.trim()) {
        await ctx.sendWhatsApp(result.response);
      }
    } catch (err) {
      console.error("[Heartbeat] Error:", err);
    }
  });

  job.start();
  console.log(`[Heartbeat] Every ${interval}min${ctx.config.trading.tradingHoursOnly ? " (market hours)" : ""}.`);
  return job;
}

export function startMarketOpenJob(ctx: HeartbeatContext): CronJob | null {
  if (!ctx.config.cron.marketOpenHeartbeat) return null;

  const job = new CronJob(
    "30 9 * * 1-5",
    async () => {
      console.log("[Cron] Market open - morning scan.");
      try {
        const result = await runAgentTurn(
          ctx.agent,
          ctx.session,
          "The market just opened. Check the portfolio, scan the watchlist for any pre-market movers, and check overnight news for our holdings. Give me a brief morning briefing. Save a summary to today's daily log.",
          ctx.config,
        );
        if (result.response.trim()) {
          await ctx.sendWhatsApp(`*Morning Briefing*\n\n${result.response}`);
        }
      } catch (err) {
        console.error("[Cron] Market open error:", err);
      }
    },
    null,
    false,
    "America/New_York",
  );

  job.start();
  console.log("[Cron] Market open: 9:30 AM ET, Mon-Fri.");
  return job;
}

export function startMarketCloseJob(ctx: HeartbeatContext): CronJob | null {
  if (!ctx.config.cron.marketCloseReport) return null;

  const job = new CronJob(
    "5 16 * * 1-5",
    async () => {
      console.log("[Cron] Market close - daily report.");
      try {
        const result = await runAgentTurn(
          ctx.agent,
          ctx.session,
          "The market just closed. Give me an end-of-day report: portfolio P&L for today, any trades executed, notable movers in our watchlist, and any after-hours news. Save the report to today's daily log and update curated memory with any new insights.",
          ctx.config,
        );
        if (result.response.trim()) {
          await ctx.sendWhatsApp(`*End of Day Report*\n\n${result.response}`);
        }
      } catch (err) {
        console.error("[Cron] Market close error:", err);
      }
    },
    null,
    false,
    "America/New_York",
  );

  job.start();
  console.log("[Cron] Market close: 4:05 PM ET, Mon-Fri.");
  return job;
}

function buildHeartbeatPrompt(): string {
  return [
    "Heartbeat check. Review the following and only message me if something is notable or needs attention:",
    "- Check portfolio positions and unrealized P&L",
    "- Check for any filled or partially filled orders",
    "- Scan watchlist for significant price moves (>2% intraday)",
    "- Check for breaking news on our holdings",
    "",
    "If everything looks normal and stable, respond with an empty message. Only alert me if there's something I should know about.",
    "If you do find something notable, save it to today's daily log.",
  ].join("\n");
}
