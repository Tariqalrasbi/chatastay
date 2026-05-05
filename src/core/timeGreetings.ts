import { hotelTimezoneOrUtc, readWallClockInZone } from "./guestMessagingSchedule";

export type DayPeriod = "morning" | "afternoon" | "evening";

export function dayPeriodFromHour24(hour24: number): DayPeriod {
  if (hour24 < 12) return "morning";
  if (hour24 < 18) return "afternoon";
  return "evening";
}

/** Current hour (0–23) in the given IANA timezone. */
export function hour24InTimeZone(now: Date, timeZone: string): number {
  const tz = hotelTimezoneOrUtc(timeZone);
  const { minOfDay } = readWallClockInZone(now, tz);
  return Math.floor(minOfDay / 60);
}

/** English greeting line only (no name); caller appends name if needed. */
export function englishDayPeriodGreetingLine(now: Date, hotelTimeZone?: string | null): string {
  const h = hour24InTimeZone(now, hotelTimeZone ?? "UTC");
  const p = dayPeriodFromHour24(h);
  if (p === "morning") return "Good morning";
  if (p === "afternoon") return "Good afternoon";
  return "Good evening";
}
