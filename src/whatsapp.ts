import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import pino from "pino";
import type { OpenPawConfig } from "./config.js";

const logger = pino({ level: "silent" });

export interface WhatsAppClient {
  sock: WASocket;
  sendMessage: (text: string) => Promise<void>;
  onMessage: (handler: (text: string) => Promise<void>) => void;
  close: () => Promise<void>;
}

export async function connectWhatsApp(config: OpenPawConfig): Promise<WhatsAppClient> {
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authDir);
  const { version } = await fetchLatestBaileysVersion();

  let messageHandler: ((text: string) => Promise<void>) | null = null;
  let sock!: WASocket;
  let onConnected: (() => void) | null = null;
  // Track message IDs sent by the bot so we don't respond to our own replies
  // Bounded to prevent memory leak over long runtime
  const sentMessageIds = new Set<string>();
  const MAX_SENT_IDS = 200;

  function createSocket(): WASocket {
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: true,
      browser: ["OpenPaw", "Trading Agent", "1.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp] Connection closed. ${shouldReconnect ? "Reconnecting..." : "Logged out."}`,
        );

        if (shouldReconnect) {
          setTimeout(() => {
            createSocket();
          }, 3000);
        }
      }

      if (connection === "open") {
        console.log("[WhatsApp] Connected successfully.");
        if (onConnected) {
          onConnected();
          onConnected = null;
        }
      }
    });

    // Listen for incoming messages - only from owner
    const ownerJid = config.whatsapp.ownerNumber.replace("+", "") + "@s.whatsapp.net";
    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;

        const sender = msg.key.remoteJid;
        if (!sender) continue;

        // Only process messages from the owner's JID
        if (sender !== ownerJid) continue;

        // Skip messages the bot itself sent (avoid echo loop)
        if (msg.key.id && sentMessageIds.has(msg.key.id)) {
          sentMessageIds.delete(msg.key.id);
          continue;
        }

        // Extract text
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!text.trim()) continue;

        // Send read receipt
        try { await sock.readMessages([msg.key]); } catch {}

        // Send composing indicator
        try { await sock.sendPresenceUpdate("composing", sender); } catch {}

        if (messageHandler) {
          try {
            await messageHandler(text);
          } catch (err) {
            console.error("[WhatsApp] Error handling message:", err);
          }
        }

        // Clear composing
        try { await sock.sendPresenceUpdate("paused", sender); } catch {}
      }
    });

    return sock;
  }

  createSocket();

  // Wait for connection (works across reconnects since onConnected is global)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WhatsApp connection timeout")), 120_000);
    onConnected = () => {
      clearTimeout(timeout);
      resolve();
    };
  });

  const ownerJid = config.whatsapp.ownerNumber.replace("+", "") + "@s.whatsapp.net";

  return {
    sock,
    sendMessage: async (text: string) => {
      // Chunk long messages (WhatsApp limit ~4000 chars for comfortable reading)
      const chunks = chunkText(text, 4000);
      for (const chunk of chunks) {
        const sent = await sock.sendMessage(ownerJid, { text: chunk });
        if (sent?.key?.id) {
          sentMessageIds.add(sent.key.id);
          // Evict oldest IDs if over limit
          if (sentMessageIds.size > MAX_SENT_IDS) {
            const first = sentMessageIds.values().next().value;
            if (first) sentMessageIds.delete(first);
          }
        }
      }
    },
    onMessage: (handler) => {
      messageHandler = handler;
    },
    close: async () => {
      sock.end(undefined);
    },
  };
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.5) breakAt = maxLen;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}
