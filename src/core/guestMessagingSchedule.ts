/** Hotel-local quiet hours + safe daytime sends for guest lifecycle WhatsApp (shared by jobs and digests). */

/** Quiet hours start (24h clock, inclusive), default 22 = 10 PM hotel local. */
const QUIET_HOURS_START = Math.min(23, Math.max(0, parseInt(process.env.QUIET_HOURS_START ?? "22", 10) || 22));
/** Quiet hours end (24h clock, exclusive until this hour), default 8 = 8 AM hotel local. */
const QUIET_HOURS_END = Math.min(23, Math.max(0, parseInt(process.env.QUIET_HOURS_END ?? "8", 10) || 8));
/** Default civil hour when shifting sends out of quiet hours, default 9 = 9 AM. */
const DEFAULT_SEND_HOUR = Math.min(22, Math.max(0, parseInt(process.env.DEFAULT_SEND_HOUR ?? "9", 10) || 9));

export type GuestJourneySendWindowReason = "none" | "early_morning" | "late_night";

export function hotelTimezoneOrUtc(hotelTimezone: string | null | undefined): string {
  const t = (hotelTimezone ?? "").trim();
  return t || "UTC";
}

function ymdAddCalendarDays(ymd: string, deltaDays: number): string {
  const [y, mo, d] = ymd.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return ymd;
  const u = new Date(Date.UTC(y, mo - 1, d + deltaDays));
  return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, "0")}-${String(u.getUTCDate()).padStart(2, "0")}`;
}

export function readWallClockInZone(d: Date, timeZone: string): { ymd: string; minOfDay: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const p = f.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  const h = parseInt(get("hour"), 10);
  const m = parseInt(get("minute"), 10);
  return { ymd, minOfDay: h * 60 + m };
}

/** Interpret YYYY-MM-DD + HH:MM as civil time in `timeZone` and return the corresponding UTC instant. */
export function wallClockLocalToUtc(ymd: string, hm: string, timeZone: string): Date {
  const [y, mo, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const [hh, mm] = hm.split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d) || !Number.isFinite(hh) || !Number.isFinite(mm)) {
    return new Date(NaN);
  }
  const wantMin = hh * 60 + mm;
  const start = Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - 18 * 3600000;
  const end = start + 72 * 3600000;
  for (let t = start; t < end; t += 60 * 1000) {
    const { ymd: cy, minOfDay } = readWallClockInZone(new Date(t), timeZone);
    if (cy === ymd && minOfDay === wantMin) return new Date(t);
  }
  return new Date(NaN);
}

/**
 * Shift a desired send instant into an allowed daytime window in `timeZone` (hotel local).
 * Quiet: [QUIET_HOURS_START, 24) ∪ [0, QUIET_HOURS_END) — no sends overnight.
 * - If local time falls before QUIET_HOURS_END → same calendar day at DEFAULT_SEND_HOUR:00.
 * - If at or after QUIET_HOURS_START → next calendar day at DEFAULT_SEND_HOUR:00.
 */
export function getSafeSendTime(desiredSendUtc: Date, timeZone: string): {
  originalUtc: Date;
  adjustedUtc: Date;
  reason: GuestJourneySendWindowReason;
} {
  const tz = hotelTimezoneOrUtc(timeZone);
  const originalUtc = desiredSendUtc;
  if (Number.isNaN(originalUtc.getTime())) {
    return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
  }

  const quietStartMin = QUIET_HOURS_START * 60;
  const quietEndMin = QUIET_HOURS_END * 60;
  const { ymd, minOfDay } = readWallClockInZone(originalUtc, tz);
  const inQuiet = minOfDay >= quietStartMin || minOfDay < quietEndMin;

  if (!inQuiet) {
    return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
  }

  const hm = `${String(DEFAULT_SEND_HOUR).padStart(2, "0")}:00`;

  if (minOfDay < quietEndMin) {
    const adjustedUtc = wallClockLocalToUtc(ymd, hm, tz);
    if (Number.isNaN(adjustedUtc.getTime())) {
      return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
    }
    return { originalUtc, adjustedUtc, reason: "early_morning" };
  }

  const nextYmd = ymdAddCalendarDays(ymd, 1);
  const adjustedUtc = wallClockLocalToUtc(nextYmd, hm, tz);
  if (Number.isNaN(adjustedUtc.getTime())) {
    return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
  }
  return { originalUtc, adjustedUtc, reason: "late_night" };
}

export function formatYmdInHotelZone(iso: Date, hotelTimezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: hotelTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(iso);
}

export function isDuringHotelQuietHours(utc: Date, timeZone: string): boolean {
  const tz = hotelTimezoneOrUtc(timeZone);
  const quietStartMin = QUIET_HOURS_START * 60;
  const quietEndMin = QUIET_HOURS_END * 60;
  const { minOfDay } = readWallClockInZone(utc, tz);
  return minOfDay >= quietStartMin || minOfDay < quietEndMin;
}
