import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceAlert {
  id: string;
  symbol: string;
  condition: "above" | "below" | "crosses";
  price: number;
  createdAt: number;
  triggered: boolean;
  message?: string;
}

export interface StreamEvent {
  type: "trade" | "quote" | "alert_triggered";
  symbol: string;
  data: Record<string, unknown>;
  alert?: PriceAlert;
}

export interface AlpacaStreamOptions {
  apiKey: string;
  secretKey: string;
  /** Defaults to wss://stream.data.alpaca.markets/v2/iex */
  feedUrl?: string;
  /** Delay between reconnect attempts in ms (default 5000) */
  reconnectDelay?: number;
  /** Maximum reconnect attempts before giving up (default Infinity) */
  maxReconnectAttempts?: number;
}

// ---------------------------------------------------------------------------
// Internal message types coming off the Alpaca WebSocket
// ---------------------------------------------------------------------------

interface AlpacaTrade {
  T: "t";
  S: string; // symbol
  p: number; // price
  s: number; // size
  t: string; // timestamp
  [key: string]: unknown;
}

interface AlpacaQuote {
  T: "q";
  S: string;
  bp: number; // bid price
  bs: number; // bid size
  ap: number; // ask price
  as: number; // ask size
  t: string;
  [key: string]: unknown;
}

type AlpacaMessage = AlpacaTrade | AlpacaQuote | { T: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// AlpacaStream
// ---------------------------------------------------------------------------

export class AlpacaStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly feedUrl: string;
  private readonly reconnectDelay: number;
  private readonly maxReconnectAttempts: number;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private authenticated = false;

  /** Symbols we are currently subscribed to (trades + quotes). */
  private subscribedSymbols = new Set<string>();

  /** Last trade price per symbol. */
  private lastPrices = new Map<string, number>();

  /** Last quote per symbol (bid/ask). */
  private lastQuotes = new Map<string, { bid: number; ask: number; bidSize: number; askSize: number }>();

  /** Active price alerts. */
  private alerts = new Map<string, PriceAlert>();

  /** Previous prices for "crosses" condition — tracks the side relative to target. */
  private previousPrices = new Map<string, number>();

  constructor(apiKey: string, secretKey: string, options?: Partial<AlpacaStreamOptions>) {
    super();
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.feedUrl = options?.feedUrl ?? "wss://stream.data.alpaca.markets/v2/iex";
    this.reconnectDelay = options?.reconnectDelay ?? 5_000;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? Infinity;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Open the WebSocket connection and authenticate. */
  connect(): void {
    if (this.ws) return;
    this.intentionallyClosed = false;
    this._connect();
  }

  /** Subscribe to real-time trades + quotes for the given symbols. */
  subscribe(symbols: string[]): void {
    const upper = symbols.map((s) => s.toUpperCase());
    for (const s of upper) this.subscribedSymbols.add(s);
    console.log(`[stream] subscribing to: ${upper.join(", ")}`);
    this._sendSubscription("subscribe", upper);
  }

  /** Unsubscribe from the given symbols. */
  unsubscribe(symbols: string[]): void {
    const upper = symbols.map((s) => s.toUpperCase());
    for (const s of upper) this.subscribedSymbols.delete(s);
    console.log(`[stream] unsubscribing from: ${upper.join(", ")}`);
    this._sendSubscription("unsubscribe", upper);
  }

  /** Add a price alert. Returns the alert ID. */
  addAlert(alert: Omit<PriceAlert, "id" | "createdAt" | "triggered">): string {
    const id = randomUUID();
    const full: PriceAlert = {
      ...alert,
      symbol: alert.symbol.toUpperCase(),
      id,
      createdAt: Date.now(),
      triggered: false,
    };
    this.alerts.set(id, full);
    console.log(
      `[stream] alert added: ${full.symbol} ${full.condition} $${full.price} (id=${id})`,
    );

    // Make sure we're subscribed to the symbol so we actually receive data.
    if (!this.subscribedSymbols.has(full.symbol)) {
      this.subscribe([full.symbol]);
    }
    return id;
  }

  /** Remove an alert by ID. Returns true if it existed. */
  removeAlert(id: string): boolean {
    const existed = this.alerts.delete(id);
    if (existed) console.log(`[stream] alert removed: ${id}`);
    return existed;
  }

  /** Get all alerts (active and triggered). */
  getAlerts(): PriceAlert[] {
    return Array.from(this.alerts.values());
  }

  /** Get the last cached trade price for a symbol, or null. */
  getLastPrice(symbol: string): number | null {
    return this.lastPrices.get(symbol.toUpperCase()) ?? null;
  }

  /** Get the last cached quote for a symbol, or null. */
  getLastQuote(symbol: string): { bid: number; ask: number; bidSize: number; askSize: number } | null {
    return this.lastQuotes.get(symbol.toUpperCase()) ?? null;
  }

  /** Gracefully close the connection. */
  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
    console.log("[stream] closed");
  }

  // -----------------------------------------------------------------------
  // Connection internals
  // -----------------------------------------------------------------------

  private _connect(): void {
    console.log(`[stream] connecting to ${this.feedUrl}`);
    this.ws = new WebSocket(this.feedUrl);

    this.ws.on("open", () => {
      console.log("[stream] websocket open, authenticating...");
      this._send({ action: "auth", key: this.apiKey, secret: this.secretKey });
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const messages: AlpacaMessage[] = JSON.parse(raw.toString());
        for (const msg of messages) {
          this._handleMessage(msg);
        }
      } catch (err) {
        console.error("[stream] failed to parse message:", err);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[stream] disconnected (code=${code}, reason=${reason.toString()})`);
      this.authenticated = false;
      this.ws = null;
      if (!this.intentionallyClosed) {
        this._scheduleReconnect();
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error("[stream] websocket error:", err.message);
      // The close event will fire after this; reconnect is handled there.
    });
  }

  private _scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[stream] max reconnect attempts reached, giving up");
      this.emit("error", new Error("Max reconnect attempts reached"));
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 6); // basic backoff, caps at 6x
    console.log(
      `[stream] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  private _handleMessage(msg: AlpacaMessage): void {
    switch (msg.T) {
      // Connection messages
      case "success": {
        const m = msg as { T: string; msg: string };
        if (m.msg === "connected") {
          console.log("[stream] connected to Alpaca");
        } else if (m.msg === "authenticated") {
          console.log("[stream] authenticated successfully");
          this.authenticated = true;
          this.reconnectAttempts = 0;
          // Re-subscribe to any symbols we were tracking.
          if (this.subscribedSymbols.size > 0) {
            const syms = Array.from(this.subscribedSymbols);
            console.log(`[stream] re-subscribing to: ${syms.join(", ")}`);
            this._sendSubscription("subscribe", syms);
          }
          this.emit("authenticated");
          this.emit("connected");
        }
        break;
      }

      case "error": {
        const m = msg as { T: string; code: number; msg: string };
        console.error(`[stream] error from Alpaca: [${m.code}] ${m.msg}`);
        this.emit("error", new Error(`Alpaca stream error [${m.code}]: ${m.msg}`));
        break;
      }

      case "subscription": {
        const m = msg as { T: string; trades: string[]; quotes: string[] };
        console.log(
          `[stream] subscription confirmed — trades: [${m.trades?.join(", ")}], quotes: [${m.quotes?.join(", ")}]`,
        );
        break;
      }

      // Trade update
      case "t": {
        const trade = msg as AlpacaTrade;
        const symbol = trade.S;
        const price = trade.p;

        // Cache previous price for crosses detection, then update.
        const prev = this.lastPrices.get(symbol);
        if (prev !== undefined) {
          this.previousPrices.set(symbol, prev);
        }
        this.lastPrices.set(symbol, price);

        const event: StreamEvent = {
          type: "trade",
          symbol,
          data: {
            price,
            size: trade.s,
            timestamp: trade.t,
          },
        };
        this.emit("trade", event);
        this._checkAlerts(symbol, price);
        break;
      }

      // Quote update
      case "q": {
        const quote = msg as AlpacaQuote;
        const symbol = quote.S;

        this.lastQuotes.set(symbol, {
          bid: quote.bp,
          ask: quote.ap,
          bidSize: quote.bs,
          askSize: quote.as,
        });

        const event: StreamEvent = {
          type: "quote",
          symbol,
          data: {
            bidPrice: quote.bp,
            bidSize: quote.bs,
            askPrice: quote.ap,
            askSize: quote.as,
            timestamp: quote.t,
          },
        };
        this.emit("quote", event);
        break;
      }

      default:
        // Ignore unknown message types (e.g., bars, status, etc.)
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Alert checking
  // -----------------------------------------------------------------------

  private _checkAlerts(symbol: string, currentPrice: number): void {
    for (const alert of this.alerts.values()) {
      if (alert.triggered) continue;
      if (alert.symbol !== symbol) continue;

      let shouldTrigger = false;

      switch (alert.condition) {
        case "above":
          shouldTrigger = currentPrice >= alert.price;
          break;
        case "below":
          shouldTrigger = currentPrice <= alert.price;
          break;
        case "crosses": {
          const prev = this.previousPrices.get(symbol);
          if (prev !== undefined) {
            // Crossed if price moved from one side of target to the other.
            const wasBelowOrAt = prev <= alert.price;
            const wasAboveOrAt = prev >= alert.price;
            const nowAbove = currentPrice > alert.price;
            const nowBelow = currentPrice < alert.price;
            shouldTrigger = (wasBelowOrAt && nowAbove) || (wasAboveOrAt && nowBelow);
          }
          break;
        }
      }

      if (shouldTrigger) {
        alert.triggered = true;
        console.log(
          `[stream] ALERT TRIGGERED: ${alert.symbol} ${alert.condition} $${alert.price} (current=$${currentPrice}, id=${alert.id})`,
        );
        const event: StreamEvent = {
          type: "alert_triggered",
          symbol,
          data: { currentPrice, alertPrice: alert.price, condition: alert.condition },
          alert,
        };
        this.emit("alert_triggered", event);
      }
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket send helpers
  // -----------------------------------------------------------------------

  private _send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private _sendSubscription(action: "subscribe" | "unsubscribe", symbols: string[]): void {
    if (!this.authenticated) {
      // Will be sent on reconnect/auth.
      return;
    }
    this._send({
      action,
      trades: symbols,
      quotes: symbols,
    });
  }
}
