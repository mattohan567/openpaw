import type { Tool } from "./types.js";
import { wrapExternalContent } from "../security.js";

/** Max chars per search result snippet */
const MAX_SNIPPET_LEN = 2000;

/** Queries that should never be sent to external search */
const BLOCKED_TERMS =
  /\b(password|ssn|social security|credit card|phone number|home address|private key|api key|secret key|bank account)\b/i;

/**
 * Strip HTML tags and truncate to safe length.
 */
function cleanSnippet(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .trim()
    .slice(0, MAX_SNIPPET_LEN);
}

export function createWebSearchTools(): Tool[] {
  return [
    {
      name: "web_search",
      description:
        "Search the web for stock research, news, DD, sentiment, SEC filings, analyst opinions. Returns text snippets. Never search for personal or sensitive info.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g. 'PLUG power earnings 2026', 'penny stocks short squeeze catalyst')",
          },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
      execute: async (params) => {
        const query = params.query as string;
        const limit = (params.limit as number) || 5;

        if (BLOCKED_TERMS.test(query)) {
          return "BLOCKED: Query contains sensitive terms. Not searching.";
        }

        try {
          const encoded = encodeURIComponent(query);
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
            headers: { "User-Agent": "OpenPaw/1.0 Stock Research Agent" },
          });
          const html = await res.text();

          const results: string[] = [];
          const titleRegex = /class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
          const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

          const titles: string[] = [];
          let match;
          while ((match = titleRegex.exec(html)) !== null && titles.length < limit) {
            titles.push(cleanSnippet(match[1]));
          }

          const snippets: string[] = [];
          while ((match = snippetRegex.exec(html)) !== null && snippets.length < limit) {
            snippets.push(cleanSnippet(match[1]));
          }

          for (let i = 0; i < Math.max(titles.length, snippets.length); i++) {
            const title = titles[i] || "";
            const snippet = snippets[i] || "";
            if (title || snippet) {
              results.push(`${title}\n${snippet}`);
            }
          }

          if (results.length === 0) {
            return "No search results found.";
          }

          return wrapExternalContent(results.join("\n\n---\n\n"), "web_search");
        } catch (err) {
          return `Search failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
    {
      name: "search_reddit",
      description:
        "Search Reddit for stock sentiment, DD, and discussion. Great for retail sentiment on penny stocks, short squeeze targets, and momentum plays. Searches r/wallstreetbets, r/pennystocks, r/stocks etc.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g. 'PLUG short squeeze', 'penny stocks this week')",
          },
          subreddit: {
            type: "string",
            description: "Specific subreddit (e.g. wallstreetbets, pennystocks, stocks). Omit to search all.",
          },
          sort: { type: "string", description: "Sort by: relevance, hot, new, top (default: hot)" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["query"],
      },
      execute: async (params) => {
        const query = params.query as string;
        const subreddit = params.subreddit as string;
        const sort = (params.sort as string) || "hot";
        const limit = (params.limit as number) || 10;

        if (BLOCKED_TERMS.test(query)) {
          return "BLOCKED: Query contains sensitive terms.";
        }

        try {
          const base = subreddit
            ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json`
            : "https://www.reddit.com/search.json";
          const url = `${base}?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}&restrict_sr=${subreddit ? "on" : "off"}&t=week`;

          const res = await fetch(url, {
            headers: { "User-Agent": "OpenPaw/1.0 Stock Research" },
          });

          if (!res.ok) {
            return `Reddit search failed: ${res.status}`;
          }

          const data = (await res.json()) as {
            data: { children: Array<{ data: Record<string, unknown> }> };
          };

          const posts = data.data.children.map((child) => {
            const p = child.data;
            const selftext = p.selftext ? String(p.selftext).slice(0, 500) : "";
            return cleanSnippet(
              `r/${p.subreddit} | ${p.score} pts | ${p.num_comments} comments\n` +
                `${p.title}\n` +
                selftext,
            );
          });

          if (posts.length === 0) {
            return "No Reddit posts found.";
          }

          return wrapExternalContent(posts.join("\n\n---\n\n"), "reddit");
        } catch (err) {
          return `Reddit search failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    },
  ];
}
