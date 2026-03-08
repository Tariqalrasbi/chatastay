import crypto from "node:crypto";
import { prisma } from "../db";

type LoggedDirection = "incoming" | "outgoing";

let ensureMessagesTablePromise: Promise<void> | null = null;

async function ensureMessagesTable(): Promise<void> {
  if (!ensureMessagesTablePromise) {
    ensureMessagesTablePromise = prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        phone_number TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
        message_text TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).then(() => undefined);
  }
  await ensureMessagesTablePromise;
}

export async function logWhatsAppMessage(params: {
  conversationId?: string;
  phoneNumber: string;
  direction: LoggedDirection;
  messageText: string;
  timestamp?: Date;
}): Promise<void> {
  await ensureMessagesTable();
  await prisma.$executeRaw`
    INSERT INTO messages (id, conversation_id, phone_number, direction, message_text, timestamp)
    VALUES (
      ${crypto.randomUUID()},
      ${params.conversationId ?? null},
      ${params.phoneNumber},
      ${params.direction},
      ${params.messageText},
      ${params.timestamp?.toISOString() ?? new Date().toISOString()}
    )
  `;
}

