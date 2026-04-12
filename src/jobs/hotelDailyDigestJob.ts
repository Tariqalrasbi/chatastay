import { prisma } from "../db";
import { runHotelDailyDigest } from "../core/hotelDailyDigest";
import { loadPlatformAlerts } from "../core/ownerPlatformAlerts";

function readWallClockInZone(d: Date, timeZone: string): { ymd: string; minOfDay: number } {
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

/**
 * Sends each active hotel’s digest when local clock in that hotel’s timezone matches HOTEL_DIGEST_TIME (default 07:15).
 */
export function startHotelDailyDigestScheduler(): NodeJS.Timeout {
  if (process.env.HOTEL_DIGEST_ENABLED === "false") {
    console.log("[hotel-digest] Scheduler disabled (HOTEL_DIGEST_ENABLED=false).");
    return setInterval(() => {}, 60_000);
  }
  const raw = (process.env.HOTEL_DIGEST_TIME ?? "07:15").trim();
  const [a, b] = raw.split(":");
  const th = parseInt(a ?? "7", 10);
  const tm = parseInt(b ?? "15", 10);
  const targetMin = (Number.isFinite(th) ? th : 7) * 60 + (Number.isFinite(tm) ? tm : 15);
  const intervalMs = Math.max(30_000, parseInt(process.env.HOTEL_DIGEST_TICK_MS ?? "60000", 10) || 60_000);
  /** hotelId → digestKey already processed successfully this run-day */
  const lastOk = new Map<string, string>();

  const tick = async () => {
    let hotels: { id: string; timezone: string | null }[];
    try {
      hotels = await prisma.hotel.findMany({
        where: { isActive: true },
        select: { id: true, timezone: true }
      });
    } catch (e) {
      console.error("[hotel-digest] hotel list failed:", e instanceof Error ? e.message : String(e));
      return;
    }
    const now = new Date();
    const due: typeof hotels = [];
    for (const h of hotels) {
      const tz = (h.timezone ?? "Asia/Muscat").trim() || "Asia/Muscat";
      const { ymd, minOfDay } = readWallClockInZone(now, tz);
      if (minOfDay !== targetMin) continue;
      if (lastOk.get(h.id) === ymd) continue;
      due.push(h);
    }
    if (!due.length) return;
    const alertPack = await loadPlatformAlerts();
    for (const h of due) {
      const tz = (h.timezone ?? "Asia/Muscat").trim() || "Asia/Muscat";
      const { ymd } = readWallClockInZone(now, tz);
      const r = await runHotelDailyDigest({
        hotelId: h.id,
        manual: false,
        force: false,
        preloadedAlerts: alertPack
      });
      if (r.status !== "FAILED") lastOk.set(h.id, ymd);
      if (r.ok || r.status === "SENT" || r.status === "SKIPPED_NO_SMTP") {
        console.log(`[hotel-digest] ${h.id.slice(0, 8)}… ${r.digestKey} ${r.status}`);
      } else if (r.status !== "SKIPPED") {
        console.warn(`[hotel-digest] ${h.id.slice(0, 8)}… ${r.digestKey} ${r.status} ${r.message ?? ""}`);
      }
    }
  };

  void tick();
  return setInterval(() => void tick(), intervalMs);
}
