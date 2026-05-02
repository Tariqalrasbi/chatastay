import { BookingStatus, ConversationState, MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { sendWhatsAppList, trySendWhatsAppText } from "../whatsapp/send";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function lastActivity(meta: Record<string, unknown>, fallback: Date): Date {
  const raw = typeof meta.lastActivityAt === "string" ? new Date(meta.lastActivityAt) : null;
  return raw && Number.isFinite(raw.getTime()) ? raw : fallback;
}

function isActiveBookingSession(meta: Record<string, unknown>): boolean {
  if (meta.conversationMode === "AGENT_MODE") return false;
  return meta.conversationMode === "BOOKING_MODE" && (typeof meta.bookingStep === "string" || Boolean(meta.awaitingGuestName));
}

function reminderBody(lang: string, hotelName: string): string {
  if (lang === "ar") {
    return `هل ترغب في متابعة حجزك في ${hotelName}؟ يمكنني إكماله من حيث توقفت.`;
  }
  return `Would you like to continue your booking at ${hotelName}? I can continue from where you left off.`;
}

function recheckBody(lang: string, hotelName: string): string {
  if (lang === "ar") {
    return `تذكير سريع من ${hotelName}: الأسعار والتوفر قد تتغير. هل ترغب في التحقق من التوفر مرة أخرى؟`;
  }
  return `Quick reminder from ${hotelName}: rates and availability may change. Would you like to check availability again?`;
}

async function sendBookingFollowup(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
  body: string;
  intent: string;
}): Promise<void> {
  try {
    await sendWhatsAppList({
      to: params.to,
      body: params.body,
      buttonText: "Continue",
      sections: [
        {
          title: "Booking",
          rows: [
            { id: "resume_booking", title: "Resume booking", description: "Continue where you stopped" },
            { id: "change_details", title: "Change details", description: "Edit dates, guests, rooms, or payment" },
            { id: "talk_to_reception", title: "Talk to reception", description: "Staff will help directly" }
          ]
        }
      ],
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch {
    await trySendWhatsAppText({
      to: params.to,
      body: `${params.body}\n\nReply *resume booking*, *change*, or *reception*.`,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
  await prisma.message.create({
    data: {
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      direction: MessageDirection.OUTBOUND,
      body: params.body,
      aiIntent: params.intent,
      aiConfidence: 0.92
    }
  });
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { lastMessageAt: new Date(), state: ConversationState.QUALIFYING }
  });
}

export async function runBookingSessionFollowupSweep(now = new Date()): Promise<void> {
  const sessions = await prisma.conversationSession.findMany({
    where: { conversationId: { not: null } },
    include: {
      hotel: { select: { displayName: true } },
      guest: { select: { phoneE164: true } }
    },
    take: 200,
    orderBy: { updatedAt: "asc" }
  });

  for (const session of sessions) {
    const meta = safeJson(session.metadataJson);
    if (!isActiveBookingSession(meta)) continue;

    const confirmed = await prisma.booking.findFirst({
      where: {
        hotelId: session.hotelId,
        guestId: session.guestId,
        status: BookingStatus.CONFIRMED,
        createdAt: { gte: session.updatedAt }
      },
      select: { id: true }
    });
    if (confirmed) continue;

    const activity = lastActivity(meta, session.updatedAt);
    const ageMs = now.getTime() - activity.getTime();
    const phone = session.guest.phoneE164.replace(/\D/g, "");
    if (!phone || !session.conversationId) continue;
    const phoneNumberId = loadPartnerSetupConfig(session.hotelId).whatsappPhoneNumberId || undefined;
    const lang = session.language === "ar" ? "ar" : "en";

    if (ageMs >= FIFTEEN_MINUTES_MS && typeof meta.bookingRecoveryNudgeSentAt !== "string") {
      await sendBookingFollowup({
        hotelId: session.hotelId,
        conversationId: session.conversationId,
        to: phone,
        phoneNumberId,
        body: reminderBody(lang, session.hotel.displayName),
        intent: "BOOKING_ABANDONED_15M"
      });
      meta.bookingRecoveryNudgeSentAt = now.toISOString();
      await prisma.conversationSession.update({
        where: { id: session.id },
        data: { metadataJson: JSON.stringify(meta) }
      });
      continue;
    }

    if (ageMs >= TWENTY_FOUR_HOURS_MS && typeof meta.bookingRecoveryRecheckSentAt !== "string") {
      await sendBookingFollowup({
        hotelId: session.hotelId,
        conversationId: session.conversationId,
        to: phone,
        phoneNumberId,
        body: recheckBody(lang, session.hotel.displayName),
        intent: "BOOKING_ABANDONED_24H"
      });
      meta.bookingRecoveryRecheckSentAt = now.toISOString();
      await prisma.conversationSession.update({
        where: { id: session.id },
        data: { metadataJson: JSON.stringify(meta) }
      });
    }
  }
}

export function startBookingSessionFollowupScheduler(): void {
  void runBookingSessionFollowupSweep().catch((err: unknown) =>
    console.error("[booking-session-followup] sweep failed:", err instanceof Error ? err.message : String(err))
  );
  setInterval(() => {
    void runBookingSessionFollowupSweep().catch((err: unknown) =>
      console.error("[booking-session-followup] sweep failed:", err instanceof Error ? err.message : String(err))
    );
  }, SWEEP_MS).unref();
}
