import { runOwnerDailyDigest } from "../core/ownerDailyDigest";

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

function parseDigestClock(): { h: number; m: number } {
  const raw = (process.env.OWNER_DIGEST_TIME ?? "07:00").trim();
  const [a, b] = raw.split(":");
  const h = parseInt(a ?? "7", 10);
  const m = parseInt(b ?? "0", 10);
  return {
    h: Number.isFinite(h) ? h : 7,
    m: Number.isFinite(m) ? m : 0
  };
}

/**
 * Fires once per local calendar day in OWNER_DIGEST_TZ when the clock matches OWNER_DIGEST_TIME (default 07:00).
 */
export function startOwnerDailyDigestScheduler(): NodeJS.Timeout {
  if (process.env.OWNER_DIGEST_ENABLED === "false") {
    console.log("[owner-digest] Scheduler disabled (OWNER_DIGEST_ENABLED=false).");
    return setInterval(() => {}, 60_000);
  }
  const tz = (process.env.OWNER_DIGEST_TZ ?? "Asia/Muscat").trim() || "Asia/Muscat";
  const intervalMs = Math.max(30_000, parseInt(process.env.OWNER_DIGEST_TICK_MS ?? "60000", 10) || 60_000);
  let lastFiredYmd: string | null = null;

  const tick = () => {
    const now = new Date();
    const { ymd, minOfDay } = readWallClockInZone(now, tz);
    const { h, m } = parseDigestClock();
    const target = h * 60 + m;
    if (minOfDay !== target) {
      lastFiredYmd = null;
      return;
    }
    if (lastFiredYmd === ymd) return;
    lastFiredYmd = ymd;
    runOwnerDailyDigest({ manual: false, force: false }).then(
      (r) => {
        if (r.ok || r.status === "SKIPPED") {
          console.log(`[owner-digest] ${r.digestKey} ${r.status}${r.message ? `: ${r.message}` : ""}`);
        } else {
          console.warn(`[owner-digest] ${r.digestKey} ${r.status}${r.message ? `: ${r.message}` : ""}`);
        }
      },
      (err) => console.error("[owner-digest] run failed:", err instanceof Error ? err.message : String(err))
    );
  };

  tick();
  return setInterval(tick, intervalMs);
}
