import { BookingStatus } from "@prisma/client";
import { prisma } from "../db";

const NOTIFY_TYPE = "GUEST_JOURNEY_REPLY";

/**
 * When a guest replies after any automated guest-journey WhatsApp (24h pre-arrival, check-in day, post-checkout thank-you,
 * review request, repeat-guest promo, or legacy pre-arrival reminder), tag the message and create an in-app notification for staff.
 */
export async function handleGuestJourneyInboundReply(params: {
  hotelId: string;
  guestId: string;
  conversationId: string;
  prismaMessageId: string;
  messageBody: string;
  providerMessageId?: string;
}): Promise<void> {
  const booking = await prisma.booking.findFirst({
    where: {
      hotelId: params.hotelId,
      guestId: params.guestId,
      status: BookingStatus.CONFIRMED,
      OR: [
        { guestJourneyPreArrival24hSentAt: { not: null } },
        { guestJourneyCheckinDaySentAt: { not: null } },
        { guestJourneyPostCheckoutThankYouSentAt: { not: null } },
        { guestJourneyReviewRequestSentAt: { not: null } },
        { guestJourneyRepeatPromoSentAt: { not: null } },
        { preArrivalReminderSentAt: { not: null } }
      ]
    },
    orderBy: { checkOut: "desc" },
    include: { guest: true }
  });

  if (!booking) return;

  if (!booking.conversationId) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { conversationId: params.conversationId }
    });
  }

  const guestLabel = booking.guest.fullName?.trim() || booking.guest.phoneE164;
  const ref = booking.referenceCode?.trim() || booking.id.slice(0, 10);
  const preview = params.messageBody.trim().slice(0, 280);
  const title = `Guest journey reply · ${guestLabel} · ${ref}`;
  const body = `${guestLabel} (${ref}) replied after an automated stay message: ${preview}`;

  await prisma.$transaction([
    prisma.message.update({
      where: { id: params.prismaMessageId },
      data: { aiIntent: "GUEST_JOURNEY_REPLY", aiConfidence: 0.95 }
    }),
    prisma.notification.create({
      data: {
        hotelId: params.hotelId,
        guestId: params.guestId,
        channel: "IN_APP",
        type: NOTIFY_TYPE,
        title,
        body,
        status: "PENDING",
        payloadJson: JSON.stringify({
          bookingId: booking.id,
          conversationId: params.conversationId,
          referenceCode: booking.referenceCode,
          providerMessageId: params.providerMessageId ?? null,
          prismaMessageId: params.prismaMessageId,
          category: "guest_journey_guest_message"
        })
      }
    })
  ]);
}

/** @deprecated Use handleGuestJourneyInboundReply */
export const handlePreArrivalInboundGuestReply = handleGuestJourneyInboundReply;
