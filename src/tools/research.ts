import type { OpenPawConfig } from "../config.js";
import type { Tool } from "./types.js";
import { wrapExternalContent } from "../security.js";

const SEC_BASE = "https://efts.sec.gov/LATEST";
const SEC_HEADERS = { "User-Agent": "OpenPaw/1.0 trading-agent@openpaw.dev", Accept: "application/json" };

export function createResearchTools(config: OpenPawConfig): Tool[] {
  function dataHeaders() {
    return {
      "APCA-API-KEY-ID": config.trading.alpacaApiKey,
      "APCA-API-SECRET-KEY": config.trading.alpacaSecretKey,
    };
  }

  return [
    {
      name: "get_insider_trades",
      description:
        "Get recent SEC insider trades (Form 4 filings) for a stock. Shows when insiders buy or sell their own company's stock — one of the strongest signals, especially for penny stocks.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol (e.g. PLUG)" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["ticker"],
      },
      execute: async (params) => {
        const ticker = (params.ticker as string).toUpperCase();
        const limit = (params.limit as number) || 10;

        try {
          // Search SEC EDGAR EFTS for Form 4 filings
          const res = await fetch(
            `${SEC_BASE}/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${getDateDaysAgo(90)}&enddt=${getToday()}&forms=4&from=0&size=${limit}`,
            { headers: SEC_HEADERS },
          );

          if (!res.ok) {
            return `SEC EDGAR search failed: ${res.status}`;
          }

          const data = (await res.json()) as {
            hits: { hits: Array<{ _source: Record<string, unknown> }> };
          };

          if (!data.hits?.hits?.length) {
            return `No recent insider filings found for ${ticker}.`;
          }

          const filings = data.hits.hits.map((hit) => {
            const s = hit._source;
            return `${s.file_date} | ${s.display_names ? (s.display_names as string[]).join(", ") : "Unknown"} | Form 4\n${s.entity_name || ""}`;
          });

          return wrapExternalContent(
            `Recent insider trades for ${ticker}:\n\n${filings.join("\n\n---\n\n")}`,
            "sec_edgar",
          );
        } catch (err) {
          return `SEC search failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
    {
      name: "get_earnings_calendar",
      description:
        "Get upcoming earnings dates. Earnings are the #1 catalyst for penny stock moves. Check before buying to know if a big move is coming.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbols: {
            type: "string",
            description: "Comma-separated ticker symbols (e.g. PLUG,AMC,SNDL). Omit to get general upcoming earnings.",
          },
          days_ahead: { type: "number", description: "How many days ahead to look (default: 14)" },
        },
      },
      execute: async (params) => {
        const symbols = params.symbols as string;
        const daysAhead = (params.days_ahead as number) || 14;

        try {
          // Use Alpaca's corporate actions calendar for earnings
          const start = getToday();
          const end = getDateDaysFromNow(daysAhead);

          if (symbols) {
            // Check news for earnings mentions for specific symbols
            const newsRes = await fetch(
              `https://data.alpaca.markets/v1beta1/news?symbols=${symbols}&limit=20`,
              { headers: dataHeaders() },
            );
            const newsData = (await newsRes.json()) as { news: Array<Record<string, unknown>> };

            const earningsNews = (newsData.news || []).filter((n) => {
              const headline = String(n.headline || "").toLowerCase();
              return headline.includes("earning") || headline.includes("revenue") ||
                headline.includes("quarterly") || headline.includes("q1") ||
                headline.includes("q2") || headline.includes("q3") || headline.includes("q4") ||
                headline.includes("fiscal") || headline.includes("results");
            });

            if (earningsNews.length === 0) {
              return `No recent earnings news found for ${symbols}. Check a financial calendar for exact dates.`;
            }

            const results = earningsNews.map((n) =>
              `${n.created_at} | ${(n.symbols as string[])?.join(", ")}\n${n.headline}`,
            );

            return wrapExternalContent(results.join("\n\n"), "alpaca_news");
          }

          // General: search for earnings-related news
          const newsRes = await fetch(
            `https://data.alpaca.markets/v1beta1/news?limit=20`,
            { headers: dataHeaders() },
          );
          const newsData = (await newsRes.json()) as { news: Array<Record<string, unknown>> };
          const earningsNews = (newsData.news || []).filter((n) => {
            const headline = String(n.headline || "").toLowerCase();
            return headline.includes("earning") || headline.includes("quarterly results") ||
              headline.includes("beats") || headline.includes("misses");
          });

          if (earningsNews.length === 0) {
            return "No earnings news in recent feed.";
          }

          const results = earningsNews.map((n) =>
            `${n.created_at} | ${(n.symbols as string[])?.join(", ")}\n${n.headline}`,
          );

          return wrapExternalContent(results.join("\n\n"), "alpaca_news");
        } catch (err) {
          return `Earnings search failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
    {
      name: "get_short_interest",
      description:
        "Search for short interest and short squeeze data on a stock. High short interest + catalyst = potential squeeze. Uses web search to find current short data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol (e.g. PLUG)" },
        },
        required: ["ticker"],
      },
      execute: async (params) => {
        const ticker = (params.ticker as string).toUpperCase();

        try {
          // Search for short interest data via DuckDuckGo
          const query = `${ticker} short interest percent float days to cover 2026`;
          const encoded = encodeURIComponent(query);
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
            headers: { "User-Agent": "OpenPaw/1.0 Stock Research" },
          });
          const html = await res.text();

          const snippets: string[] = [];
          const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          const titleRegex = /class="result__a"[^>]*>([\s\S]*?)<\/a>/g;

          const titles: string[] = [];
          let match;
          while ((match = titleRegex.exec(html)) !== null && titles.length < 5) {
            titles.push(match[1].replace(/<[^>]+>/g, "").trim());
          }
          while ((match = snippetRegex.exec(html)) !== null && snippets.length < 5) {
            snippets.push(match[1].replace(/<[^>]+>/g, "").trim());
          }

          const results: string[] = [];
          for (let i = 0; i < Math.max(titles.length, snippets.length); i++) {
            if (titles[i] || snippets[i]) {
              results.push(`${titles[i] || ""}\n${snippets[i] || ""}`);
            }
          }

          if (results.length === 0) {
            return `No short interest data found for ${ticker}.`;
          }

          return wrapExternalContent(
            `Short interest data for ${ticker}:\n\n${results.join("\n\n---\n\n")}`,
            "web_search",
          );
        } catch (err) {
          return `Short interest search failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
    {
      name: "get_spy_benchmark",
      description:
        "Compare portfolio performance against SPY (S&P 500 ETF). Returns your portfolio P&L vs SPY over the same period so you know if you're beating the market.",
      inputSchema: {
        type: "object" as const,
        properties: {
          period: {
            type: "string",
            description: "Time period: 1D, 1W, 1M, 3M, 1A (default: 1W)",
          },
        },
      },
      execute: async (params) => {
        const period = (params.period as string) || "1W";

        try {
          // Get portfolio history
          const portfolioRes = await fetch(
            `${config.trading.alpacaBaseUrl}/v2/account/portfolio/history?period=${period}&timeframe=1D`,
            { headers: { ...dataHeaders(), "Content-Type": "application/json" } },
          );
          const portfolio = (await portfolioRes.json()) as {
            equity: number[];
            timestamp: number[];
            profit_loss: number[];
            profit_loss_pct: number[];
            base_value: number;
          };

          // Get SPY bars for the same period
          const timeMap: Record<string, string> = {
            "1D": "1", "1W": "7", "1M": "30", "3M": "90", "1A": "365",
          };
          const days = parseInt(timeMap[period] || "7");
          const start = getDateDaysAgo(days);

          const spyRes = await fetch(
            `https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start=${start}&limit=${days + 5}`,
            { headers: dataHeaders() },
          );
          const spyData = (await spyRes.json()) as { bars: Array<{ c: number; t: string }> };
          const spyBars = spyData.bars || [];

          if (spyBars.length < 2) {
            return "Not enough SPY data for comparison.";
          }

          const spyStart = spyBars[0].c;
          const spyEnd = spyBars[spyBars.length - 1].c;
          const spyReturn = ((spyEnd - spyStart) / spyStart) * 100;

          // Portfolio return
          const equities = portfolio.equity || [];
          let portfolioReturn = 0;
          if (equities.length >= 2) {
            const pStart = equities[0];
            const pEnd = equities[equities.length - 1];
            portfolioReturn = pStart > 0 ? ((pEnd - pStart) / pStart) * 100 : 0;
          }

          const beating = portfolioReturn > spyReturn;
          const diff = portfolioReturn - spyReturn;

          return JSON.stringify({
            period,
            portfolio: {
              return_pct: Math.round(portfolioReturn * 100) / 100,
              start_value: equities[0] || 0,
              end_value: equities[equities.length - 1] || 0,
            },
            spy: {
              return_pct: Math.round(spyReturn * 100) / 100,
              start_price: spyStart,
              end_price: spyEnd,
            },
            beating_spy: beating,
            alpha: Math.round(diff * 100) / 100,
          });
        } catch (err) {
          return `Benchmark comparison failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
    {
      name: "get_technicals",
      description:
        "Calculate technical indicators for a stock: RSI, SMA (20/50), EMA, VWAP, volume trend, and support/resistance levels. Helps identify entry/exit points.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol" },
          period: { type: "number", description: "Number of daily bars to analyze (default: 50)" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const symbol = (params.symbol as string).toUpperCase();
        const period = (params.period as number) || 50;

        try {
          const res = await fetch(
            `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Day&limit=${period}`,
            { headers: dataHeaders() },
          );
          const data = (await res.json()) as { bars: Array<{ o: number; h: number; l: number; c: number; v: number; t: string }> };
          const bars = data.bars || [];

          if (bars.length < 14) {
            return `Not enough data for ${symbol} (need at least 14 bars, got ${bars.length}).`;
          }

          const closes = bars.map((b) => b.c);
          const volumes = bars.map((b) => b.v);
          const highs = bars.map((b) => b.h);
          const lows = bars.map((b) => b.l);

          // RSI (14-period)
          const rsi = calcRSI(closes, 14);

          // SMAs
          const sma20 = calcSMA(closes, 20);
          const sma50 = calcSMA(closes, Math.min(50, closes.length));

          // EMA 12 & 26 for MACD
          const ema12 = calcEMA(closes, 12);
          const ema26 = calcEMA(closes, 26);
          const macd = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;

          // Volume trend (avg last 5 vs avg last 20)
          const recentVol = avg(volumes.slice(-5));
          const avgVol = avg(volumes.slice(-20));
          const volumeTrend = avgVol > 0 ? recentVol / avgVol : 1;

          // Support & resistance (recent lows/highs)
          const recentLows = lows.slice(-20);
          const recentHighs = highs.slice(-20);
          const support = Math.min(...recentLows);
          const resistance = Math.max(...recentHighs);

          const currentPrice = closes[closes.length - 1];

          return JSON.stringify({
            symbol,
            current_price: currentPrice,
            rsi_14: rsi !== null ? Math.round(rsi * 100) / 100 : null,
            rsi_signal: rsi !== null ? (rsi > 70 ? "overbought" : rsi < 30 ? "oversold" : "neutral") : null,
            sma_20: sma20 !== null ? Math.round(sma20 * 100) / 100 : null,
            sma_50: sma50 !== null ? Math.round(sma50 * 100) / 100 : null,
            price_vs_sma20: sma20 !== null ? (currentPrice > sma20 ? "above" : "below") : null,
            macd: macd !== null ? Math.round(macd * 1000) / 1000 : null,
            macd_signal: macd !== null ? (macd > 0 ? "bullish" : "bearish") : null,
            volume_trend: Math.round(volumeTrend * 100) / 100,
            volume_signal: volumeTrend > 1.5 ? "high_volume" : volumeTrend < 0.5 ? "low_volume" : "normal",
            support: Math.round(support * 100) / 100,
            resistance: Math.round(resistance * 100) / 100,
            bars_analyzed: bars.length,
          });
        } catch (err) {
          return `Technicals failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
  ];
}

// === Helper functions ===

function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

function getDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
}

function getDateDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().split("T")[0];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calcSMA(data: number[], period: number): number | null {
  if (data.length < period) return null;
  return avg(data.slice(-period));
}

function calcEMA(data: number[], period: number): number | null {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = avg(data.slice(0, period));
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(data: number[], period: number): number | null {
  if (data.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smooth
  for (let i = period + 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
