import type { Tool } from "./types.js";

let _sender: ((text: string) => Promise<void>) | null = null;

export function setNotifySender(sender: (text: string) => Promise<void>) {
  _sender = sender;
}

export function createNotifyTools(): Tool[] {
  return [
    {
      name: "notify_owner",
      description:
        "Send a WhatsApp message to the owner. Use this ONLY when you have genuinely actionable or important information — e.g. a trade executed, a price alert worth acting on, a morning/evening briefing, or a notable catalyst found during research. Do NOT use for routine status updates, log confirmations, or memory housekeeping.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to send to the owner",
          },
        },
        required: ["message"],
      },
      execute: async (params) => {
        const message = params.message as string;
        if (!message.trim()) return "Empty message, not sent.";
        if (!_sender) return "WhatsApp not connected. Message not sent.";
        await _sender(message);
        return "Message sent to owner via WhatsApp.";
      },
    },
  ];
}
