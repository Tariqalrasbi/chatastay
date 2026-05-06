import { formatYmdInHotelZone, hotelTimezoneOrUtc } from "./guestMessagingSchedule";

export function isRoomUnitOccupiedFromNotes(notes: string | null | undefined): boolean {
  return Boolean(notes?.includes("[status:OCCUPIED]"));
}

/**
 * Guest is treated as on-property for WhatsApp in-stay flows when:
 * - booking is CHECKED_IN (front desk), or
 * - in-stay welcome was sent, or
 * - housekeeping board shows the unit as OCCUPIED.
 */
export function isGuestEffectivelyCheckedIn(booking: {
  status?: string;
  guestJourneyInStayWelcomeSentAt: Date | null;
  roomUnit: { notes: string | null } | null;
}): boolean {
  if (booking.status === "CHECKED_IN") return true;
  if (booking.guestJourneyInStayWelcomeSentAt) return true;
  if (booking.roomUnit && isRoomUnitOccupiedFromNotes(booking.roomUnit.notes)) return true;
  return false;
}

/**
 * In-stay WhatsApp (services menu, extras, etc.): same as {@link isGuestEffectivelyCheckedIn}, plus a
 * practical fallback when staff have **not** set the room board to OCCUPIED and have **not** flipped
 * the booking to CHECKED_IN — if the guest has a **CONFIRMED** stay with a **room unit assigned** and
 * the caller already scoped to active stay dates, treat them as in-house.
 *
 * Automated journey logic (e.g. check-in day nudges) still uses {@link isGuestEffectivelyCheckedIn} only.
 */
export function isGuestInHouseForWhatsAppServices(booking: {
  status?: string;
  guestJourneyInStayWelcomeSentAt: Date | null;
  roomUnit: { notes: string | null } | null;
  roomUnitId?: string | null;
}): boolean {
  if (isGuestEffectivelyCheckedIn(booking)) return true;
  if (booking.status === "CONFIRMED" && booking.roomUnitId) return true;
  return false;
}

/** Calendar overlap in hotel zone: arrival date through checkout date (inclusive). */
export function isBookingCalendarActiveOnDate(
  checkIn: Date,
  checkOut: Date,
  hotelTimeZone: string | null | undefined,
  asOf: Date
): boolean {
  const tz = hotelTimezoneOrUtc(hotelTimeZone);
  const ymd = formatYmdInHotelZone(asOf, tz);
  const cin = formatYmdInHotelZone(checkIn, tz);
  const cout = formatYmdInHotelZone(checkOut, tz);
  return ymd >= cin && ymd <= cout;
}
