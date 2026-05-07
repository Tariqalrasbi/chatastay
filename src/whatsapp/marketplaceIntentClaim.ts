/**
 * Phase E — WhatsApp side of the marketplace continuation deep-link.
 *
 * When the public marketplace mints a `MarketplaceBookingIntent` and redirects
 * the guest to wa.me with `[#chatastay-mp:<token>]` in the message text, the
 * inbound webhook for that hotel calls `claimMarketplaceIntent` with the
 * resolved (or freshly created) Guest. We then:
 *   1. Find the intent by token (must be unclaimed and unexpired).
 *   2. Verify the intent's hotel matches the conversation's hotel.
 *   3. Create or update a `BookingDraft` for this Guest with the saved dates /
 *      occupancy so the WhatsApp menu skips the date prompts.
 *   4. Mark the intent as claimed (one-shot semantics).
 *
 * If anything is off (token missing/expired/mismatched hotel/already claimed)
 * we silently no-op and let the guest go through the normal WhatsApp flow.
 * This keeps the marketplace continuation purely additive — it never breaks
 * an existing conversation.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db";

export type MarketplaceClaimInput = {
  token: string;
  hotelId: string;
  guestId: string;
  conversationId?: string | null;
};

export type MarketplaceClaimResult = {
  claimed: boolean;
  reason?: "no_token" | "not_found" | "expired" | "already_claimed" | "wrong_hotel";
  bookingDraftId?: string;
};

export async function claimMarketplaceIntent(
  input: MarketplaceClaimInput,
  client: PrismaClient = defaultPrisma
): Promise<MarketplaceClaimResult> {
  if (!input.token) return { claimed: false, reason: "no_token" };

  const intent = await client.marketplaceBookingIntent.findUnique({
    where: { token: input.token }
  });
  if (!intent) return { claimed: false, reason: "not_found" };
  if (intent.claimedAt || intent.claimedByGuestId) return { claimed: false, reason: "already_claimed" };
  if (intent.expiresAt.getTime() < Date.now()) return { claimed: false, reason: "expired" };
  if (intent.hotelId !== input.hotelId) return { claimed: false, reason: "wrong_hotel" };

  // BookingDraft has no compound unique on (hotelId, guestId) — so we replicate
  // the existing `upsertBookingDraft` pattern: find an OPEN draft, then update
  // or create.
  const draft = await client.$transaction(async (tx) => {
    const openDraft = await tx.bookingDraft.findFirst({
      where: { hotelId: input.hotelId, guestId: input.guestId, status: "OPEN" },
      orderBy: { updatedAt: "desc" }
    });
    const data = {
      hotelId: input.hotelId,
      guestId: input.guestId,
      conversationId: input.conversationId ?? null,
      source: "MARKETPLACE",
      status: "OPEN",
      checkIn: intent.checkIn ?? null,
      checkOut: intent.checkOut ?? null,
      adults: intent.guests,
      rooms: intent.rooms,
      roomTypeId: intent.preferredRoomTypeId ?? null,
      metadataJson: JSON.stringify({ marketplaceIntentToken: intent.token })
    } as const;

    const draftRow = openDraft
      ? await tx.bookingDraft.update({ where: { id: openDraft.id }, data })
      : await tx.bookingDraft.create({ data });

    await tx.marketplaceBookingIntent.update({
      where: { id: intent.id },
      data: {
        claimedByGuestId: input.guestId,
        claimedAt: new Date()
      }
    });

    return draftRow;
  });

  return { claimed: true, bookingDraftId: draft.id };
}
