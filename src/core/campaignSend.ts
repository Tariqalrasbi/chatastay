import { ConversationState, MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "./partnerSetup";
import { parseLightGuestMemory } from "./lightGuestMemory";
import { normalizeWhatsAppRecipientId } from "./whatsappPhone";
import { probeWhatsAppOutbound, resolveWhatsAppSendConfig, trySendWhatsAppTemplate, trySendWhatsAppText } from "../whatsapp/send";
import type { CampaignGuestRow } from "./campaignAudience";

const CAMPAIGN_INTENT = "MARKETING_CAMPAIGN";
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getOrCreateConversation(hotelId: string, guestId: string): Promise<{ id: string }> {
  const existing = await prisma.conversation.findFirst({
    where: { hotelId, guestId },
    orderBy: { updatedAt: "desc" },
    select: { id: true }
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: {
      hotelId,
      guestId,
      state: ConversationState.NEW,
      channel: "WHATSAPP",
      lastMessageAt: new Date()
    },
    select: { id: true }
  });
}

async function guestHasInboundWithinServiceWindow(hotelId: string, guestId: string): Promise<boolean> {
  const since = new Date(Date.now() - SERVICE_WINDOW_MS);
  const row = await prisma.message.findFirst({
    where: {
      hotelId,
      direction: MessageDirection.INBOUND,
      createdAt: { gte: since },
      conversation: { guestId }
    },
    select: { id: true }
  });
  return Boolean(row);
}

export type OfferSnippet = { title: string; code: string };

export function buildCampaignWhatsAppBody(params: {
  messageBody: string;
  hotelDisplayName: string;
  guestFirstName: string;
  offer?: OfferSnippet | null;
}): string {
  const who = params.guestFirstName.trim() || "Guest";
  let text = params.messageBody.trim();
  if (!text.includes("{guest_name}")) {
    text = `Dear ${who},\n\n${text}`;
  } else {
    text = text.replace(/\{guest_name\}/gi, who);
  }
  if (params.offer) {
    text += `\n\n— Offer: ${params.offer.title} (code ${params.offer.code})`;
  }
  text += `\n\n— ${params.hotelDisplayName}`;
  return text.slice(0, 4090);
}

export type CampaignSendResult = {
  attempted: number;
  sentOk: number;
  sentFailed: number;
  skippedNoPhone: number;
  skippedDoNotDisturb: number;
  skippedMarketingOptOut: number;
  skippedOutsideServiceWindow: number;
  usedTemplate: boolean;
  /** First Meta / config error (for staff-facing summary). */
  firstErrorMessage: string | null;
};

/** Campaign row status — never mark SENT when zero messages were delivered. */
export function deriveMarketingCampaignStatus(result: CampaignSendResult): "SENT" | "PARTIAL" | "FAILED" {
  if (result.sentOk <= 0) return "FAILED";
  const skipped =
    result.skippedNoPhone +
    result.skippedDoNotDisturb +
    result.skippedMarketingOptOut +
    result.skippedOutsideServiceWindow +
    result.sentFailed;
  if (skipped > 0) return "PARTIAL";
  return "SENT";
}

export function resolveCampaignTemplateConfig(hotelId: string): {
  templateName: string | null;
  languageCode: string;
} {
  const partner = loadPartnerSetupConfig(hotelId);
  const fromPartner = partner.whatsappCampaignTemplateName?.trim() ?? "";
  const fromEnv = process.env.WHATSAPP_CAMPAIGN_TEMPLATE_NAME?.trim() ?? "";
  const templateName = fromPartner || fromEnv || null;
  const languageCode =
    partner.whatsappCampaignTemplateLanguage?.trim() ||
    process.env.WHATSAPP_CAMPAIGN_TEMPLATE_LANGUAGE?.trim() ||
    "en";
  return { templateName, languageCode };
}

/** Pre-send: verify Meta credentials before creating a campaign row. */
export async function verifyCampaignWhatsAppReady(
  hotelId: string,
  phoneNumberIdOverride?: string
): Promise<{ ok: true; displayPhoneNumber: string | null } | { ok: false; errorMessage: string }> {
  const phoneNumberId =
    phoneNumberIdOverride?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || undefined;
  if (!resolveWhatsAppSendConfig(phoneNumberId)) {
    return {
      ok: false,
      errorMessage:
        "WhatsApp is not configured on the server (WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID must be real values, not placeholders)."
    };
  }
  const probe = await probeWhatsAppOutbound(phoneNumberId);
  if (!probe.ok) return probe;
  return { ok: true, displayPhoneNumber: probe.displayPhoneNumber };
}

/**
 * Sends WhatsApp to each guest; records Message + MarketingCampaignRecipient rows.
 */
export async function sendMarketingCampaignWhatsApp(params: {
  hotelId: string;
  hotelDisplayName: string;
  hotelCountryIso?: string;
  campaignId: string;
  guests: CampaignGuestRow[];
  messageBody: string;
  offer?: OfferSnippet | null;
}): Promise<CampaignSendResult> {
  const partner = loadPartnerSetupConfig(params.hotelId);
  const phoneNumberId = partner.whatsappPhoneNumberId?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const ready = await verifyCampaignWhatsAppReady(params.hotelId, phoneNumberId);
  if (!ready.ok) {
    throw new Error(ready.errorMessage);
  }

  const { templateName, languageCode } = resolveCampaignTemplateConfig(params.hotelId);
  const usedTemplate = Boolean(templateName);
  const countryIso = params.hotelCountryIso?.trim() || "OM";
  const gapMs = Math.min(5000, Math.max(0, parseInt(process.env.CAMPAIGN_MESSAGE_GAP_MS ?? "350", 10) || 350));

  let attempted = 0;
  let sentOk = 0;
  let sentFailed = 0;
  let skippedNoPhone = 0;
  let skippedDoNotDisturb = 0;
  let skippedMarketingOptOut = 0;
  let skippedOutsideServiceWindow = 0;
  let firstErrorMessage: string | null = null;

  for (let gi = 0; gi < params.guests.length; gi++) {
    const g = params.guests[gi]!;
    const phone = normalizeWhatsAppRecipientId(g.phoneE164, countryIso);
    if (phone.length < 10) {
      skippedNoPhone++;
      await prisma.marketingCampaignRecipient.create({
        data: {
          campaignId: params.campaignId,
          guestId: g.id,
          outcome: "NO_PHONE",
          errorDetail: `Invalid phone: ${g.phoneE164}`
        }
      });
      continue;
    }

    const prefs = parseLightGuestMemory(g.lightGuestMemoryJson ?? null);
    if (prefs.messagingDoNotDisturb || prefs.messagingMarketingOptOut) {
      if (prefs.messagingDoNotDisturb) skippedDoNotDisturb++;
      else skippedMarketingOptOut++;
      await prisma.marketingCampaignRecipient.create({
        data: {
          campaignId: params.campaignId,
          guestId: g.id,
          outcome: prefs.messagingDoNotDisturb ? "SKIPPED_DO_NOT_DISTURB" : "SKIPPED_MARKETING_OPT_OUT",
          errorDetail: null
        }
      });
      continue;
    }

    const first = (g.fullName ?? "").trim().split(/\s+/)[0] || "Guest";
    const body = buildCampaignWhatsAppBody({
      messageBody: params.messageBody,
      hotelDisplayName: params.hotelDisplayName,
      guestFirstName: first,
      offer: params.offer ?? null
    });

    if (!usedTemplate) {
      const inWindow = await guestHasInboundWithinServiceWindow(params.hotelId, g.id);
      if (!inWindow) {
        skippedOutsideServiceWindow++;
        await prisma.marketingCampaignRecipient.create({
          data: {
            campaignId: params.campaignId,
            guestId: g.id,
            outcome: "SKIPPED_OUTSIDE_24H",
            errorDetail:
              "Guest has not messaged in the last 24 hours — free-text promos require an approved Meta marketing template (set WHATSAPP_CAMPAIGN_TEMPLATE_NAME or Property setup → campaign template name)."
          }
        });
        continue;
      }
    }

    attempted++;
    const conversation = await getOrCreateConversation(params.hotelId, g.id);
    const result = usedTemplate
      ? await trySendWhatsAppTemplate({
          to: phone,
          templateName: templateName!,
          languageCode,
          bodyParameters: [body],
          phoneNumberId,
          conversationId: conversation.id
        })
      : await trySendWhatsAppText({
          to: phone,
          body,
          phoneNumberId,
          conversationId: conversation.id
        });

    const sentAt = new Date();
    if (result.ok) {
      sentOk++;
      await prisma.$transaction([
        prisma.message.create({
          data: {
            hotelId: params.hotelId,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body,
            aiIntent: usedTemplate ? `${CAMPAIGN_INTENT}_TEMPLATE` : CAMPAIGN_INTENT,
            aiConfidence: 1
          }
        }),
        prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: sentAt, updatedAt: sentAt }
        }),
        prisma.marketingCampaignRecipient.create({
          data: {
            campaignId: params.campaignId,
            guestId: g.id,
            outcome: "SENT",
            errorDetail: null
          }
        })
      ]);
    } else {
      sentFailed++;
      if (!firstErrorMessage) firstErrorMessage = result.errorMessage;
      await prisma.marketingCampaignRecipient.create({
        data: {
          campaignId: params.campaignId,
          guestId: g.id,
          outcome: "FAILED",
          errorDetail: result.errorMessage.slice(0, 500)
        }
      });
    }

    if (gapMs > 0 && gi < params.guests.length - 1) {
      await sleep(gapMs);
    }
  }

  if (!usedTemplate && skippedOutsideServiceWindow > 0 && sentOk === 0 && !firstErrorMessage) {
    firstErrorMessage =
      "No guests were in the 24-hour WhatsApp service window. Configure an approved Meta marketing template (WHATSAPP_CAMPAIGN_TEMPLATE_NAME) for bulk promos.";
  }

  return {
    attempted,
    sentOk,
    sentFailed,
    skippedNoPhone,
    skippedDoNotDisturb,
    skippedMarketingOptOut,
    skippedOutsideServiceWindow,
    usedTemplate,
    firstErrorMessage
  };
}
