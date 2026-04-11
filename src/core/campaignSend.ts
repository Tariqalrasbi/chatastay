import { ConversationState, MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "./partnerSetup";
import { trySendWhatsAppText } from "../whatsapp/send";
import type { CampaignGuestRow } from "./campaignAudience";

const CAMPAIGN_INTENT = "MARKETING_CAMPAIGN";

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
};

/**
 * Sends WhatsApp to each guest; records Message + optional MarketingCampaignRecipient rows.
 */
export async function sendMarketingCampaignWhatsApp(params: {
  hotelId: string;
  hotelDisplayName: string;
  campaignId: string;
  guests: CampaignGuestRow[];
  messageBody: string;
  offer?: OfferSnippet | null;
}): Promise<CampaignSendResult> {
  const partner = loadPartnerSetupConfig(params.hotelId);
  const phoneNumberId = partner.whatsappPhoneNumberId?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const gapMs = Math.min(5000, Math.max(0, parseInt(process.env.CAMPAIGN_MESSAGE_GAP_MS ?? "350", 10) || 350));

  let attempted = 0;
  let sentOk = 0;
  let sentFailed = 0;
  let skippedNoPhone = 0;

  for (let gi = 0; gi < params.guests.length; gi++) {
    const g = params.guests[gi]!;
    const phone = g.phoneE164.replace(/\D/g, "");
    if (phone.length < 8) {
      skippedNoPhone++;
      await prisma.marketingCampaignRecipient.create({
        data: {
          campaignId: params.campaignId,
          guestId: g.id,
          outcome: "NO_PHONE",
          errorDetail: "Invalid or missing phone"
        }
      });
      continue;
    }

    attempted++;
    const first = (g.fullName ?? "").trim().split(/\s+/)[0] || "Guest";
    const body = buildCampaignWhatsAppBody({
      messageBody: params.messageBody,
      hotelDisplayName: params.hotelDisplayName,
      guestFirstName: first,
      offer: params.offer ?? null
    });

    const conversation = await getOrCreateConversation(params.hotelId, g.id);
    const result = await trySendWhatsAppText({
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
            aiIntent: CAMPAIGN_INTENT,
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

  return { attempted, sentOk, sentFailed, skippedNoPhone };
}
