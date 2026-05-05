import { ConversationState, MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "./partnerSetup";
import { formatCheckInBillWhatsAppText, loadFolioSummaryForCheckInWhatsApp } from "./checkInBillSummary";
import { IN_STAY_SERVICE_MESSAGE_SECTIONS } from "./inStayServiceMenu";
import { sendWhatsAppList, trySendWhatsAppText } from "../whatsapp/send";

async function getOrCreateGuestConversation(hotelId: string, guestId: string): Promise<{ id: string }> {
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

export type InStayMenuBookingSlice = {
  id: string;
  referenceCode: string | null;
  checkIn: Date;
  checkOut: Date;
  roomType: { name: string };
};

export function buildInStayServiceMenuIntroBody(params: { hotelName: string; booking: InStayMenuBookingSlice }): string {
  const ref = params.booking.referenceCode ? ` (${params.booking.referenceCode})` : "";
  return [
    `You're in-house at ${params.hotelName}${ref}.`,
    `Room: ${params.booking.roomType.name}`,
    `Stay: ${params.booking.checkIn.toISOString().slice(0, 10)} → ${params.booking.checkOut.toISOString().slice(0, 10)}`,
    "",
    "How can we help during your stay? Pick a service below (tap *Services*)."
  ].join("\n");
}

async function sendInStayWhatsAppListCore(params: {
  toDigits: string;
  body: string;
  phoneNumberId?: string;
  conversationId: string;
}): Promise<{ ok: boolean; recordedBody: string }> {
  let recordedBody = params.body;
  try {
    await sendWhatsAppList({
      to: params.toDigits,
      body: params.body,
      buttonText: "Services",
      sections: IN_STAY_SERVICE_MESSAGE_SECTIONS,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
    return { ok: true, recordedBody };
  } catch {
    const fb = `${params.body}\n\nReply with: ${IN_STAY_SERVICE_MESSAGE_SECTIONS.flatMap((s) => s.rows)
      .map((r) => r.id)
      .join(" | ")}`;
    const r = await trySendWhatsAppText({
      to: params.toDigits,
      body: fb,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
    if (!r.ok) return { ok: false, recordedBody: fb };
    return { ok: true, recordedBody: fb };
  }
}

/**
 * Sends the expanded in-stay service menu on an existing conversation (does not set welcome idempotency flag).
 */
export async function sendInStayServiceMenuForActiveConversation(params: {
  hotelId: string;
  displayName: string;
  booking: InStayMenuBookingSlice;
  conversationId: string;
  normalizedPhoneDigits: string;
  phoneNumberId?: string;
}): Promise<{ ok: boolean; recordedBody: string }> {
  const body = buildInStayServiceMenuIntroBody({ hotelName: params.displayName, booking: params.booking });
  const r = await sendInStayWhatsAppListCore({
    toDigits: params.normalizedPhoneDigits,
    body,
    phoneNumberId: params.phoneNumberId,
    conversationId: params.conversationId
  });
  if (!r.ok) return r;
  await prisma.$transaction([
    prisma.message.create({
      data: {
        hotelId: params.hotelId,
        conversationId: params.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: r.recordedBody.slice(0, 4000),
        aiIntent: "IN_STAY_SERVICE_MENU",
        aiConfidence: 0.97
      }
    }),
    prisma.conversation.update({
      where: { id: params.conversationId },
      data: { lastMessageAt: new Date() }
    })
  ]);
  return r;
}

/**
 * Sends the in-stay service WhatsApp menu once per booking (idempotent via `guestJourneyInStayWelcomeSentAt`).
 * Call after manual check-in or when the room board marks a unit OCCUPIED with an active booking.
 */
export async function sendInStayWelcomeMenuIfEligible(bookingId: string): Promise<{ sent: boolean; reason: string }> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      hotelId: true,
      guestId: true,
      conversationId: true,
      guestJourneyInStayWelcomeSentAt: true,
      referenceCode: true,
      checkIn: true,
      checkOut: true,
      nights: true,
      totalAmount: true,
      currency: true,
      paymentStatus: true,
      mealPlan: true,
      roomType: { select: { name: true } },
      roomUnit: { select: { id: true, name: true, notes: true } },
      guest: { select: { phoneE164: true, fullName: true } },
      paymentIntents: { select: { status: true, amount: true } }
    }
  });
  if (!booking) return { sent: false, reason: "booking_not_found" };
  if (booking.guestJourneyInStayWelcomeSentAt) return { sent: false, reason: "already_sent" };

  const phone = booking.guest.phoneE164.replace(/\D/g, "");
  if (phone.length < 8) return { sent: false, reason: "no_phone" };

  const partner = loadPartnerSetupConfig(booking.hotelId);
  const phoneNumberId = partner.whatsappPhoneNumberId?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();

  const hotel = await prisma.hotel.findUnique({
    where: { id: booking.hotelId },
    select: { displayName: true, timezone: true }
  });
  const hotelName = hotel?.displayName ?? "Hotel";

  const paidSucceeded = booking.paymentIntents
    .filter((p) => p.status === "SUCCEEDED")
    .reduce((sum, p) => sum + p.amount, 0);
  const folio = await loadFolioSummaryForCheckInWhatsApp({
    hotelId: booking.hotelId,
    booking: {
      id: booking.id,
      referenceCode: booking.referenceCode,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      nights: booking.nights,
      totalAmount: booking.totalAmount,
      currency: booking.currency,
      paymentStatus: booking.paymentStatus,
      mealPlan: booking.mealPlan
    },
    paymentIntentsSucceededTotal: paidSucceeded
  });
  const roomName = booking.roomUnit?.name?.trim() || booking.roomType.name;
  const billBody = formatCheckInBillWhatsAppText({
    hotelName,
    roomName,
    guestName: booking.guest.fullName?.trim() || "Guest",
    booking: {
      id: booking.id,
      referenceCode: booking.referenceCode,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      nights: booking.nights,
      totalAmount: booking.totalAmount,
      currency: booking.currency,
      paymentStatus: booking.paymentStatus,
      mealPlan: booking.mealPlan
    },
    folio
  });

  const conversation = await getOrCreateGuestConversation(booking.hotelId, booking.guestId);

  const billTry = await trySendWhatsAppText({
    to: phone,
    body: billBody,
    phoneNumberId,
    conversationId: conversation.id
  });
  const billRecorded = billTry.ok ? billBody : "";

  const body = [
    `Welcome — you are checked in at ${hotelName}${booking.referenceCode ? ` (${booking.referenceCode})` : ""}.`,
    `Room: ${roomName}`,
    `Stay: ${booking.checkIn.toISOString().slice(0, 10)} → ${booking.checkOut.toISOString().slice(0, 10)}`,
    "",
    "How can we help during your stay? Pick a service below (tap *Services*)."
  ].join("\n");

  const r = await sendInStayWhatsAppListCore({
    toDigits: phone,
    body,
    phoneNumberId,
    conversationId: conversation.id
  });
  if (!r.ok) return { sent: false, reason: "send_failed" };

  const msgCreates = [];
  if (billRecorded) {
    msgCreates.push(
      prisma.message.create({
        data: {
          hotelId: booking.hotelId,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: billRecorded.slice(0, 4000),
          aiIntent: "CHECK_IN_BILL_SUMMARY",
          aiConfidence: 0.99
        }
      })
    );
  }
  msgCreates.push(
    prisma.message.create({
      data: {
        hotelId: booking.hotelId,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: r.recordedBody.slice(0, 4000),
        aiIntent: "IN_STAY_WELCOME_MENU",
        aiConfidence: 0.98
      }
    })
  );

  await prisma.$transaction([
    ...msgCreates,
    prisma.booking.update({
      where: { id: booking.id },
      data: {
        guestJourneyInStayWelcomeSentAt: new Date(),
        conversationId: booking.conversationId ?? conversation.id
      }
    }),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() }
    })
  ]);

  return { sent: true, reason: "ok" };
}
