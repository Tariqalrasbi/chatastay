import type { ChannelProvider, Prisma } from "@prisma/client";

/** Prefix for guest-facing / staff booking reference (YYMMDD segment uses server local date at creation). */
export function channelToRefPrefix(source: ChannelProvider): string {
  switch (source) {
    case "WHATSAPP":
      return "WA";
    case "DIRECT":
      return "WI";
    case "PHONE":
      return "PH";
    case "CORPORATE":
      return "CO";
    case "REFERRAL":
      return "RF";
    case "BOOKING_COM":
      return "BC";
    case "AIRBNB":
      return "AB";
    case "EXPEDIA":
      return "EX";
    default:
      return "BK";
  }
}

function formatRefDate(d: Date): string {
  const y = d.getFullYear() % 100;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${String(y).padStart(2, "0")}${String(m).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/**
 * Allocates a unique `referenceCode` per hotel: PREFIX-YYMMDD-NNN (daily sequence).
 * Call inside a transaction. Internal `id` stays the primary key for URLs and APIs.
 */
export async function allocateBookingReferenceCode(
  tx: Prisma.TransactionClient,
  params: { hotelId: string; source: ChannelProvider; refDate?: Date }
): Promise<string> {
  const prefix = channelToRefPrefix(params.source);
  const refDate = params.refDate ?? new Date();
  const datePart = formatRefDate(refDate);
  const base = `${prefix}-${datePart}-`;

  const existing = await tx.booking.findMany({
    where: {
      hotelId: params.hotelId,
      referenceCode: { startsWith: base }
    },
    select: { referenceCode: true }
  });
  let maxSeq = 0;
  for (const row of existing) {
    const code = row.referenceCode;
    if (!code) continue;
    const m = /-(\d{3})$/.exec(code);
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  }
  let seq = maxSeq + 1;
  while (seq < 10000) {
    const candidate = `${base}${String(seq).padStart(3, "0")}`;
    const clash = await tx.booking.findFirst({
      where: { hotelId: params.hotelId, referenceCode: candidate },
      select: { id: true }
    });
    if (!clash) return candidate;
    seq += 1;
  }
  throw new Error("Could not allocate unique booking reference");
}

/** Display ref for UI; falls back to legacy `id` when unset. */
export function displayBookingReference(booking: { id: string; referenceCode: string | null }): string {
  return booking.referenceCode ?? booking.id;
}
