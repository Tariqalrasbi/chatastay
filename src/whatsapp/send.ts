import { logWhatsAppMessage } from "./messageLogger";

/** When true, WhatsApp failures throw (e.g. tests). Default: log and return so the HTTP server never dies on Meta/API errors. */
const whatsAppStrictErrors =
  process.env.WHATSAPP_STRICT_ERRORS === "true" || process.env.WHATSAPP_STRICT_ERRORS === "1";

function whatsAppFail(message: string): void {
  console.error("[WhatsApp]", message);
  if (whatsAppStrictErrors) throw new Error(message);
}

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

function getWhatsAppConfig(phoneNumberIdOverride?: string): { token: string; phoneNumberId: string } | null {
  const token = process.env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId =
    (phoneNumberIdOverride && phoneNumberIdOverride.trim()) || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();

  if (!token || !phoneNumberId) {
    return null;
  }
  return { token, phoneNumberId };
}

/** Call once at server startup — cannot fix Meta error 190 (expired token), but catches missing/placeholder env. */
export function logWhatsAppStartupHints(): void {
  const token = process.env.WHATSAPP_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const isPlaceholder = (s: string | undefined) =>
    !s ||
    /^replace-me$/i.test(s) ||
    /^PASTE_/i.test(s) ||
    s === "your-token-here";
  if (isPlaceholder(token)) {
    console.warn(
      "[chatastay] WHATSAPP_TOKEN is missing or still a placeholder. Set a Graph API token in .env (see .env.example)."
    );
  }
  if (isPlaceholder(phoneId)) {
    console.warn(
      "[chatastay] WHATSAPP_PHONE_NUMBER_ID is missing or placeholder. Copy the Phone number ID from Meta → WhatsApp → API setup."
    );
  }
}

function parseMetaErrorCode(bodyText: string): number | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: number } };
    return typeof parsed.error?.code === "number" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

function formatWhatsAppHttpError(status: number, bodyText: string): string {
  const snippet = bodyText.slice(0, 400);
  const metaCode = parseMetaErrorCode(bodyText);

  // Expired / invalid token — Meta may return 400, 401, or 403 with error.code 190 in the JSON body.
  if (metaCode === 190) {
    return (
      "WhatsApp API authentication failed (token invalid or expired, Meta code 190). " +
      "Create a new long-lived System User access token in Meta Business Suite → WhatsApp → API setup, " +
      "set WHATSAPP_TOKEN in your server environment (and ensure WHATSAPP_PHONE_NUMBER_ID matches this app), " +
      "then restart the server. Partner JSON `whatsappPhoneNumberId` must align with the same WABA."
    );
  }

  if (status === 400 && metaCode === 10) {
    return (
      "WhatsApp API permission denied (Meta OAuth code 10). The access token is not allowed to send messages for this phone number. " +
      "Fix: use a System User long-lived token from the same Meta Business that owns this WhatsApp Business Account; " +
      "set WHATSAPP_PHONE_NUMBER_ID to the Phone number ID from WhatsApp → API setup for that WABA (must match the token’s app/assets); " +
      "when generating the token, include whatsapp_business_messaging (and whatsapp_business_management if you manage assets via the app). " +
      "Raw: " +
      snippet
    );
  }

  if (status === 401 || status === 403) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: string; code?: number; type?: string } };
      if (parsed.error?.type === "OAuthException" || status === 401) {
        return (
          `WhatsApp API returned ${status} (OAuth). Check WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID. Raw: ${snippet}`
        );
      }
    } catch {
      /* use generic */
    }
    return (
      `WhatsApp API returned ${status}. Check WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in your environment ` +
      `and that the token has whatsapp_business_messaging permissions. Raw: ${snippet}`
    );
  }
  return `WhatsApp request failed (${status}): ${snippet}`;
}

/** Plain-text alternative when interactive messages are rejected (e.g. Meta OAuth code 10). */
function buildButtonsFallbackBody(originalBody: string, buttons: Array<{ reply: { title: string } }>): string {
  const lines = buttons.map((b, i) => `${i + 1}) ${b.reply.title}`).join("\n");
  return `${originalBody}\n\nReply with a number (1–${buttons.length}) or the option text:\n${lines}`.slice(0, 4096);
}

function buildListFallbackBody(
  originalBody: string,
  listButtonLabel: string,
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>
): string {
  const parts: string[] = [originalBody, "", `${listButtonLabel} — reply with a number from the list:`, ""];
  let n = 1;
  for (const sec of sections) {
    parts.push(sec.title);
    for (const row of sec.rows) {
      const desc = row.description ? ` — ${row.description}` : "";
      parts.push(`  ${n}) ${row.title}${desc}`);
      n++;
    }
  }
  return parts.join("\n").slice(0, 4096);
}

export async function sendWhatsAppText({ to, body, phoneNumberId, conversationId }: SendTextInput): Promise<void> {
  const cfg = getWhatsAppConfig(phoneNumberId);
  if (!cfg) {
    whatsAppFail("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be configured");
    return;
  }
  const { token, phoneNumberId: resolvedPhoneNumberId } = cfg;

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
    whatsAppFail(formatWhatsAppHttpError(response.status, errorText));
    return;
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: body
  });
}

/**
 * Same as sendWhatsAppText but returns success/failure for UI redirects (admin invoice send, etc.).
 * Does not throw; does not use WHATSAPP_STRICT_ERRORS for failure path.
 */
export async function trySendWhatsAppText({
  to,
  body,
  phoneNumberId,
  conversationId
}: SendTextInput): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  const cfg = getWhatsAppConfig(phoneNumberId);
  if (!cfg) {
    return {
      ok: false,
      errorMessage:
        "WhatsApp is not configured (set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID, or partner Phone number ID)."
    };
  }
  const { token, phoneNumberId: resolvedPhoneNumberId } = cfg;
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
    return { ok: false, errorMessage: formatWhatsAppHttpError(response.status, errorText) };
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: body
  });
  return { ok: true };
}

export async function sendWhatsAppDocument({ to, filename, body, caption, phoneNumberId, conversationId }: SendDocumentInput): Promise<void> {
  const cfg = getWhatsAppConfig(phoneNumberId);
  if (!cfg) {
    whatsAppFail("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be configured");
    return;
  }
  const { token, phoneNumberId: resolvedPhoneNumberId } = cfg;
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
    whatsAppFail(formatWhatsAppHttpError(mediaResponse.status, errorText));
    return;
  }

  const mediaPayload = (await mediaResponse.json()) as { id?: string };
  if (!mediaPayload.id) {
    whatsAppFail("WhatsApp media upload succeeded but no media id returned");
    return;
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
    whatsAppFail(formatWhatsAppHttpError(messageResponse.status, errorText));
    return;
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: caption ? `[document:${filename}] ${caption}` : `[document:${filename}]`
  });
}

export async function sendWhatsAppButtons({ to, body, buttons, phoneNumberId, conversationId }: SendButtonsInput): Promise<void> {
  const cfg = getWhatsAppConfig(phoneNumberId);
  if (!cfg) {
    whatsAppFail("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be configured");
    return;
  }
  const { token, phoneNumberId: resolvedPhoneNumberId } = cfg;
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

  const payload = {
    messaging_product: "whatsapp" as const,
    recipient_type: "individual" as const,
    to: to.replace(/^0+/, "") || to,
    type: "interactive" as const,
    interactive: {
      type: "button" as const,
      body: { text: body.slice(0, 1024) },
      action: { buttons: trimmedButtons }
    }
  };
  const url = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    const hint = formatWhatsAppHttpError(response.status, errorText);
    console.warn("[WhatsApp] Interactive buttons rejected; sending plain-text fallback. Cause:", hint.slice(0, 320));
    const fallbackBody = buildButtonsFallbackBody(body, trimmedButtons);
    await sendWhatsAppText({ to, body: fallbackBody, phoneNumberId, conversationId });
    return;
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: body
  });
}

export async function sendWhatsAppList({ to, body, buttonText, sections, phoneNumberId, conversationId }: SendListInput): Promise<void> {
  const cfg = getWhatsAppConfig(phoneNumberId);
  if (!cfg) {
    whatsAppFail("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be configured");
    return;
  }
  const { token, phoneNumberId: resolvedPhoneNumberId } = cfg;
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

  const payload = {
    messaging_product: "whatsapp" as const,
    recipient_type: "individual" as const,
    to: to.replace(/^0+/, "") || to,
    type: "interactive" as const,
    interactive: {
      type: "list" as const,
      body: { text: body.slice(0, 1024) },
      action: {
        button: buttonText.slice(0, 20),
        sections: normalizedSections
      }
    }
  };
  const url = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    const hint = formatWhatsAppHttpError(response.status, errorText);
    console.warn("[WhatsApp] Interactive list rejected; sending plain-text fallback. Cause:", hint.slice(0, 320));
    const fallbackBody = buildListFallbackBody(body, buttonText, normalizedSections);
    await sendWhatsAppText({ to, body: fallbackBody, phoneNumberId, conversationId });
    return;
  }
  await logWhatsAppMessage({
    conversationId,
    phoneNumber: to,
    direction: "outgoing",
    messageText: body
  });
}
