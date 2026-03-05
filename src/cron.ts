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
import { runAgentTurn, loadHeartbeatPrompt } from "./agent.js";
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

function isQuietHours(): boolean {
  const now = new Date();
  const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = eastern.getHours();
  // 11 PM - 7 AM ET = quiet hours (no heartbeats at all)
  return hour >= 23 || hour < 7;
}

export function startHeartbeat(ctx: HeartbeatContext): CronJob {
  const interval = ctx.config.cron.heartbeatMinutes;

  const job = new CronJob(`*/${interval} * * * *`, async () => {
    // Respect quiet hours — don't burn API credits overnight
    if (isQuietHours()) return;

    const marketOpen = isMarketHours();
    const prompt = marketOpen
      ? loadHeartbeatPrompt()
      : `Off-hours research. Market is closed — use this time to find tomorrow's plays:
- Use get_top_movers and get_most_active to see what moved today
- Check news for after-hours catalysts, earnings surprises, FDA decisions, short squeeze setups
- Look for penny stocks (under $5) with unusual volume or big % moves
- Research any promising tickers with get_bars to check the chart pattern
- Update your watchlist with anything worth watching at open
- Review and consolidate your memory

Only message the owner if you found something genuinely actionable for tomorrow. Save all research to daily memory either way. Respond with empty text if nothing notable.`;

    console.log(`[Heartbeat] Running at ${new Date().toISOString()} (market ${marketOpen ? "open" : "closed"})`);

    try {
      const result = await runAgentTurn(
        ctx.agent,
        ctx.session,
        prompt,
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
        const result = await runAgentTurn(
          ctx.agent,
          ctx.session,
          "Market just opened. Check the portfolio, scan watchlist for pre-market movers, check overnight news on our holdings. Send me a brief morning briefing. Save a summary to today's daily log.",
          ctx.config,
        );
        if (result.response.trim()) {
          await ctx.sendWhatsApp(result.response);
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
          "Market just closed. End-of-day report: portfolio P&L today, trades executed, notable movers on watchlist, any after-hours news. Save the report to daily log and update curated memory with new insights.",
          ctx.config,
        );
        if (result.response.trim()) {
          await ctx.sendWhatsApp(result.response);
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
