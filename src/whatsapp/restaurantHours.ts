import type { FbServiceMode } from "@prisma/client";

/** Minutes from midnight in hotel local time — lunch window */
const LUNCH_START_MIN = 12 * 60;
const LUNCH_END_MIN = 15 * 60;
/** Dinner window */
const DINNER_START_MIN = 18 * 60 + 30;
const DINNER_END_MIN = 22 * 60;

function minutesNowInTimeZone(now: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return hour * 60 + minute;
}

function isWithinRestaurantWindows(minutesFromMidnight: number): boolean {
  const lunch = minutesFromMidnight >= LUNCH_START_MIN && minutesFromMidnight < LUNCH_END_MIN;
  const dinner = minutesFromMidnight >= DINNER_START_MIN && minutesFromMidnight < DINNER_END_MIN;
  return lunch || dinner;
}

function parseHmToMinutes(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Dining-in must fall within published restaurant windows (hotel local time).
 * Room service allows any requested time (24h-style HH:MM or ASAP).
 */
export function validateMealServiceTime(params: {
  serviceMode: FbServiceMode;
  timeNote: string;
  now: Date;
  hotelTimezone: string;
}): { ok: true } | { ok: false; message: string } {
  if (params.serviceMode === "ROOM_SERVICE") {
    return { ok: true };
  }

  const tz = params.hotelTimezone || "Asia/Muscat";
  const note = params.timeNote.trim();

  if (note === "ASAP") {
    const m = minutesNowInTimeZone(params.now, tz);
    if (isWithinRestaurantWindows(m)) return { ok: true };
    return {
      ok: false,
      message:
        `Restaurant dining is closed at the moment. Service hours (hotel time, ${tz}): lunch *12:00–15:00*, dinner *18:30–22:00*. ` +
        `Reply with a time in those windows (e.g. *13:00* or *20:00*), or tap *Room service* for flexible timing.`
    };
  }

  const dateTimeMatch = note.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
  const hmOnly = parseHmToMinutes(note);
  let minutes: number | null = null;
  if (dateTimeMatch) {
    const h = parseInt(dateTimeMatch[2], 10);
    const min = parseInt(dateTimeMatch[3], 10);
    minutes = h * 60 + min;
  } else if (hmOnly !== null) {
    minutes = hmOnly;
  }

  if (minutes === null) {
    return { ok: true };
  }

  if (isWithinRestaurantWindows(minutes)) return { ok: true };

  return {
    ok: false,
    message:
      `That time is outside restaurant hours. Dining is served *12:00–15:00* or *18:30–22:00* (hotel local time). ` +
      `Pick a time in those ranges or choose *Room service*.`
  };
}
