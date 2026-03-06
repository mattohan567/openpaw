/**
 * Cron/heartbeat system - scheduled market checks and off-hours research.
 *
 * Heartbeats run all the time but do different things:
 * - During market hours: check positions, P&L, movers, news
 * - Off-hours: research, plan next day, review memory, analyze watchlist
 * - Market open/close: special briefings
 */

import { CronJob } from "cron";
import { isMarketHours, type OpenPawConfig } from "./config.js";
import { loadHeartbeatPrompt } from "./agent.js";
import type { AgentRunResult } from "./agent.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { SessionStore } from "./session.js";
import type { Tool } from "./tools/types.js";

export interface HeartbeatContext {
  config: OpenPawConfig;
  tools: Tool[];
  agent: Agent;
  session: SessionStore;
  enqueueTurn: (
    userMessage: string,
    callbacks?: {
      onTextDelta?: (delta: string) => void;
      onToolUse?: (toolName: string) => void;
      onAgentEnd?: () => void;
    },
  ) => Promise<AgentRunResult>;
}

function isQuietHours(): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(formatter.format(new Date()), 10);
  return hour >= 23 || hour < 7;
}

export function startHeartbeat(ctx: HeartbeatContext): CronJob {
  const interval = ctx.config.cron.heartbeatMinutes;
  let running = false;

  const job = new CronJob(`*/${interval} * * * *`, async () => {
    if (isQuietHours()) return;
    if (running) {
      console.log("[Heartbeat] Previous heartbeat still running, skipping.");
      return;
    }

    const marketOpen = isMarketHours();
    const rawPrompt = marketOpen
      ? loadHeartbeatPrompt()
      : `Off-hours research. Market is closed — use this time to find tomorrow's plays:
- Use get_top_movers and get_most_active to see what moved today
- Check news for after-hours catalysts, earnings surprises, FDA decisions, short squeeze setups
- Look for penny stocks (under $5) with unusual volume or big % moves
- Research any promising tickers with get_bars to check the chart pattern
- Update your watchlist with anything worth watching at open
- Review and consolidate your memory

Use notify_owner ONLY if you found something genuinely actionable for tomorrow. Save all research to daily memory either way. Do NOT notify for routine housekeeping.`;
    const prompt = `[SYSTEM:HEARTBEAT] This is an automated heartbeat from your cron scheduler, not a user message. Execute the following instructions:\n\n${rawPrompt}`;

    console.log(`[Heartbeat] Running at ${new Date().toISOString()} (market ${marketOpen ? "open" : "closed"})`);

    running = true;
    try {
      await ctx.enqueueTurn(prompt);
    } catch (err) {
      console.error("[Heartbeat] Error:", err);
    } finally {
      running = false;
    }
  });

  job.start();
  console.log(`[Heartbeat] Every ${interval}min (quiet hours 11PM-7AM ET skipped).`);
  return job;
}

export function startMarketOpenJob(ctx: HeartbeatContext): CronJob | null {
  if (!ctx.config.cron.marketOpenHeartbeat) return null;

  const job = new CronJob(
    "30 9 * * 1-5",
    async () => {
      console.log("[Cron] Market open - morning scan.");
      try {
        await ctx.enqueueTurn(
          "[SYSTEM:HEARTBEAT] This is an automated market-open trigger from your cron scheduler, not a user message. Execute the following instructions:\n\nMarket just opened. Check the portfolio, scan watchlist for pre-market movers, check overnight news on our holdings. Use notify_owner to send a brief morning briefing. Save a summary to today's daily log.",
        );
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
        await ctx.enqueueTurn(
          "[SYSTEM:HEARTBEAT] This is an automated market-close trigger from your cron scheduler, not a user message. Execute the following instructions:\n\nMarket just closed. End-of-day report: portfolio P&L today, trades executed, notable movers on watchlist, any after-hours news. Use notify_owner to send the report. Save the report to daily log and update curated memory with new insights.",
        );
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
