import { ConversationState, MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "./partnerSetup";
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
      guestJourneyInStayWelcomeSentAt: true,
      referenceCode: true,
      checkIn: true,
      checkOut: true,
      roomType: { select: { name: true } },
      guest: { select: { phoneE164: true, fullName: true } }
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
    select: { displayName: true }
  });
  const hotelName = hotel?.displayName ?? "Hotel";

  const ref = booking.referenceCode ? ` (${booking.referenceCode})` : "";
  const body = [
    `Welcome — you are checked in at ${hotelName}${ref}.`,
    `Room: ${booking.roomType.name}`,
    `Stay: ${booking.checkIn.toISOString().slice(0, 10)} → ${booking.checkOut.toISOString().slice(0, 10)}`,
    "",
    "How can we help during your stay? Pick a service below."
  ].join("\n");

  const conversation = await getOrCreateGuestConversation(booking.hotelId, booking.guestId);

  let recordedBody = body;
  try {
    await sendWhatsAppList({
      to: phone,
      body,
      buttonText: "Services",
      sections: [
        {
          title: "In-stay",
          rows: [
            { id: "isv_view_stay", title: "View my stay", description: "Booking summary" },
            { id: "isv_book_meal", title: "Book meal time", description: "Buffet / set menu" },
            { id: "isv_order_meal", title: "Order meal / room svc", description: "Kitchen / folio" },
            { id: "isv_coffee", title: "Coffee / café", description: "Café" },
            { id: "isv_bike", title: "Bike / activity", description: "Activities" },
            { id: "isv_hk", title: "Housekeeping", description: "Room refresh" },
            { id: "isv_reception", title: "Reception", description: "Staff handoff" }
          ]
        }
      ],
      phoneNumberId,
      conversationId: conversation.id
    });
  } catch {
    const fallback = `${body}

Reply: isv_view_stay | isv_book_meal | isv_order_meal | isv_coffee | isv_bike | isv_hk | isv_reception`;
    const r = await trySendWhatsAppText({
      to: phone,
      body: fallback,
      phoneNumberId,
      conversationId: conversation.id
    });
    if (!r.ok) return { sent: false, reason: r.errorMessage.slice(0, 200) };
    recordedBody = fallback;
  }

  await prisma.$transaction([
    prisma.message.create({
      data: {
        hotelId: booking.hotelId,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: recordedBody.slice(0, 4000),
        aiIntent: "IN_STAY_WELCOME_MENU",
        aiConfidence: 0.98
      }
    }),
    prisma.booking.update({
      where: { id: booking.id },
      data: { guestJourneyInStayWelcomeSentAt: new Date() }
    }),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() }
    })
  ]);

  return { sent: true, reason: "ok" };
}
