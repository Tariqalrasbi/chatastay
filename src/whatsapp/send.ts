import { logWhatsAppMessage } from "./messageLogger";

interface SendTextInput {
  to: string;
  body: string;
  phoneNumberId?: string;
  conversationId?: string;
}

interface SendDocumentInput {
  to: string;
  filename: string;
  body: Buffer;
  caption?: string;
  phoneNumberId?: string;
  conversationId?: string;
}

interface SendButtonsInput {
  to: string;
  body: string;
  buttons: Array<{ id: string; title: string }>;
  phoneNumberId?: string;
  conversationId?: string;
}

interface SendListInput {
  to: string;
  body: string;
  buttonText: string;
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
  phoneNumberId?: string;
  conversationId?: string;
}

function getWhatsAppConfig(phoneNumberIdOverride?: string): { token: string; phoneNumberId: string } {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = phoneNumberIdOverride || process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    throw new Error("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be configured");
  }
  return { token, phoneNumberId };
}

export async function sendWhatsAppText({ to, body, phoneNumberId, conversationId }: SendTextInput): Promise<void> {
  const { token, phoneNumberId: resolvedPhoneNumberId } = getWhatsAppConfig(phoneNumberId);

  const url = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp send failed: ${response.status} ${errorText}`);
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: body
  });
}

export async function sendWhatsAppDocument({ to, filename, body, caption, phoneNumberId, conversationId }: SendDocumentInput): Promise<void> {
  const { token, phoneNumberId: resolvedPhoneNumberId } = getWhatsAppConfig(phoneNumberId);
  const mediaUrl = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/media`;
  const mediaForm = new FormData();
  const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  mediaForm.append("messaging_product", "whatsapp");
  mediaForm.append("type", "application/pdf");
  mediaForm.append("file", new Blob([arrayBuffer], { type: "application/pdf" }), filename);

  const mediaResponse = await fetch(mediaUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: mediaForm
  });
  if (!mediaResponse.ok) {
    const errorText = await mediaResponse.text();
    throw new Error(`WhatsApp media upload failed: ${mediaResponse.status} ${errorText}`);
  }

  const mediaPayload = (await mediaResponse.json()) as { id?: string };
  if (!mediaPayload.id) {
    throw new Error("WhatsApp media upload succeeded but no media id returned");
  }

  const messageUrl = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/messages`;
  const messageResponse = await fetch(messageUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: {
        id: mediaPayload.id,
        caption: caption ?? ""
      }
    })
  });
  if (!messageResponse.ok) {
    const errorText = await messageResponse.text();
    throw new Error(`WhatsApp document send failed: ${messageResponse.status} ${errorText}`);
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: caption ? `[document:${filename}] ${caption}` : `[document:${filename}]`
  });
}

export async function sendWhatsAppButtons({ to, body, buttons, phoneNumberId, conversationId }: SendButtonsInput): Promise<void> {
  const { token, phoneNumberId: resolvedPhoneNumberId } = getWhatsAppConfig(phoneNumberId);
  const trimmedButtons = buttons.slice(0, 3).map((button) => ({
    type: "reply" as const,
    reply: {
      id: button.id.slice(0, 256),
      title: button.title.slice(0, 20)
    }
  }));
  if (!trimmedButtons.length) {
    await sendWhatsAppText({ to, body, phoneNumberId, conversationId });
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: trimmedButtons
        }
      }
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp buttons send failed: ${response.status} ${errorText}`);
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: body
  });
}

export async function sendWhatsAppList({ to, body, buttonText, sections, phoneNumberId, conversationId }: SendListInput): Promise<void> {
  const { token, phoneNumberId: resolvedPhoneNumberId } = getWhatsAppConfig(phoneNumberId);
  const normalizedSections = sections
    .slice(0, 10)
    .map((section) => ({
      title: section.title.slice(0, 24),
      rows: section.rows.slice(0, 10).map((row) => ({
        id: row.id.slice(0, 200),
        title: row.title.slice(0, 24),
        ...(row.description ? { description: row.description.slice(0, 72) } : {})
      }))
    }))
    .filter((section) => section.rows.length > 0);

  if (!normalizedSections.length) {
    await sendWhatsAppText({ to, body, phoneNumberId, conversationId });
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body.slice(0, 1024) },
        action: {
          button: buttonText.slice(0, 20),
          sections: normalizedSections
        }
      }
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp list send failed: ${response.status} ${errorText}`);
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: body
  });
}
