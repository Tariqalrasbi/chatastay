import { readWallClockInZone } from "./guestMessagingSchedule";

/** Default windows (minutes from midnight, hotel local). Override via env if needed. */
const BIKE_START = 8 * 60;
const BIKE_END = 18 * 60;
const HK_START = 8 * 60;
const HK_END = 21 * 60;

function parseEnvMin(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(v) && v >= 0 && v <= 24 * 60 ? v : fallback;
}

export function bikeRentalWindowMinutes(): { start: number; end: number } {
  return { start: parseEnvMin("CHATASTAY_BIKE_RENTAL_START_MIN", BIKE_START), end: parseEnvMin("CHATASTAY_BIKE_RENTAL_END_MIN", BIKE_END) };
}

export function housekeepingRequestWindowMinutes(): { start: number; end: number } {
  return { start: parseEnvMin("CHATASTAY_HK_REQUEST_START_MIN", HK_START), end: parseEnvMin("CHATASTAY_HK_REQUEST_END_MIN", HK_END) };
}

function minutesFromMidnightInZone(now: Date, timeZone: string): number {
  const { minOfDay } = readWallClockInZone(now, timeZone);
  return minOfDay;
}

function formatHm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function isWithinWindow(now: Date, timeZone: string, startMin: number, endMin: number): boolean {
  const m = minutesFromMidnightInZone(now, timeZone);
  return m >= startMin && m < endMin;
}

export function nextWindowStartMessage(now: Date, timeZone: string, startMin: number, endMin: number, label: string): string {
  const m = minutesFromMidnightInZone(now, timeZone);
  if (m < startMin) {
    return `${label} opens at *${formatHm(startMin)}* (hotel time). You can ask reception to schedule for later.`;
  }
  if (m >= endMin) {
    return `${label} is closed for today (hours *${formatHm(startMin)}–${formatHm(endMin)}* hotel time). We can arrange tomorrow at opening — tap *Talk to reception* if urgent.`;
  }
  return `${label} is available now until *${formatHm(endMin)}* (hotel time).`;
}
