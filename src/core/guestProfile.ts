import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

/**
 * Updates guest profile fields from a confirmed booking without clearing existing data
 * with empty values. Use when the guest typed or confirmed a reservation name on WhatsApp.
 */
export async function mergeGuestProfileFromBooking(params: {
  guestId: string;
  fullName?: string | null;
  /** Applied only when the guest row has no locale yet (e.g. "en", "ar"). */
  localeHint?: string | null;
  /** Only set when non-empty; never writes null to clear an existing email. */
  email?: string | null;
}): Promise<void> {
  const trimmedName = params.fullName?.trim();
  const trimmedEmail = params.email?.trim();

  const existing = await prisma.guest.findUnique({ where: { id: params.guestId } });
  if (!existing) return;

  const data: Prisma.GuestUpdateInput = {};
  if (trimmedName && trimmedName.length >= 2) {
    data.fullName = trimmedName;
  }
  const hint = params.localeHint?.trim();
  if (hint && !existing.locale) {
    data.locale = hint;
  }
  if (trimmedEmail && trimmedEmail.length > 0 && !existing.email) {
    data.email = trimmedEmail;
  }

  if (Object.keys(data).length === 0) return;
  await prisma.guest.update({ where: { id: params.guestId }, data });
}
