import { Router } from "express";
import { handleIncomingWhatsAppMessage } from "./conversationController";
import { WhatsAppWebhookPayload } from "./types";

export const whatsappWebhookRouter = Router();

function extractInboundText(message: Record<string, unknown>): string | undefined {
  // Prefer interactive replies first so taps are never mistaken for plain text/context (fixes language + menu buttons).
  const interactive = message.interactive as
    | { button_reply?: { title?: unknown; id?: unknown }; list_reply?: { title?: unknown; id?: unknown } }
    | undefined;
  if (interactive?.button_reply) {
    const buttonId = interactive.button_reply.id;
    if (typeof buttonId === "string" && buttonId.trim()) return buttonId.trim();
    const buttonTitle = interactive.button_reply.title;
    if (typeof buttonTitle === "string" && buttonTitle.trim()) return buttonTitle.trim();
  }
  if (interactive?.list_reply) {
    const listId = interactive.list_reply.id;
    if (typeof listId === "string" && listId.trim()) return listId.trim();
    const listTitle = interactive.list_reply.title;
    if (typeof listTitle === "string" && listTitle.trim()) return listTitle.trim();
  }

  const textBody = (message.text as { body?: unknown } | undefined)?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const buttonText = (message.button as { text?: unknown } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const imageCaption = (message.image as { caption?: unknown } | undefined)?.caption;
  if (typeof imageCaption === "string" && imageCaption.trim()) return imageCaption.trim();

  const documentCaption = (message.document as { caption?: unknown } | undefined)?.caption;
  if (typeof documentCaption === "string" && documentCaption.trim()) return documentCaption.trim();

  return undefined;
}

whatsappWebhookRouter.get("/", (req, res) => {
  const mode = typeof req.query["hub.mode"] === "string" ? req.query["hub.mode"] : "";
  const verifyToken =
    typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"].trim() : "";
  const challenge = req.query["hub.challenge"];
  const expected = (process.env.WHATSAPP_VERIFY_TOKEN ?? "").trim();

  if (!expected) {
    console.error("WhatsApp webhook verify: WHATSAPP_VERIFY_TOKEN is not set in environment.");
    res.sendStatus(503);
    return;
  }

  if (mode === "subscribe" && verifyToken === expected && challenge !== undefined && challenge !== null) {
    res.status(200).type("text/plain").send(String(challenge));
    return;
  }

  console.warn("WhatsApp webhook verify failed", {
    modeOk: mode === "subscribe",
    tokenMatch: verifyToken === expected,
    hasChallenge: challenge !== undefined && challenge !== null
  });
  res.sendStatus(403);
});

whatsappWebhookRouter.post("/", async (req, res) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;
    if (payload.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const inboundPhoneNumberId = change.value?.metadata?.phone_number_id;
        for (const msg of change.value?.messages ?? []) {
          const text = extractInboundText(msg as unknown as Record<string, unknown>);
          if (!msg.from || !msg.id || !text) continue;
          await handleIncomingWhatsAppMessage({
            from: msg.from,
            messageId: msg.id,
            text,
            inboundPhoneNumberId
          });
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("WhatsApp webhook processing error:", message);
    return res.sendStatus(200);
  }
});

