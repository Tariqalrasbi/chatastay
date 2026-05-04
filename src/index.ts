import { prisma } from "./db";
import { createHttpApp } from "./httpApp";
import { ensureGuestFeedbackFollowupColumnsSqlite } from "./core/sqliteGuestFeedbackSchemaRepair";
import { ensureHotelAccountNumbersSqlite } from "./core/sqliteHotelAccountNumberRepair";
import { ensureHotelUserAuthColumnsSqlite } from "./core/sqliteHotelUserSchemaRepair";
import { localSqliteBackgroundSchedulersEnabled } from "./core/sqliteLocalDevSchemaGate";
import { logWhatsAppStartupHints } from "./whatsapp/send";
import { startPreArrivalReminderScheduler } from "./jobs/preArrivalReminderJob";
import { startOwnerDailyDigestScheduler } from "./jobs/ownerDailyDigestJob";
import { startHotelDailyDigestScheduler } from "./jobs/hotelDailyDigestJob";
import { startGuestAutoFollowupScheduler } from "./jobs/guestAutoFollowupJob";
import { startAutoOptimizationScheduler } from "./jobs/autoOptimizationLoopJob";
import { startBookingSessionFollowupScheduler } from "./jobs/bookingSessionFollowupJob";

const app = createHttpApp();
const rawPort = process.env.PORT ?? "3000";
const parsedPort = Number.parseInt(String(rawPort), 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
/** Bind all interfaces by default so `localhost`, `127.0.0.1`, and LAN URLs behave consistently (override with HOST=127.0.0.1 if needed). */
const host = process.env.HOST ?? "0.0.0.0";

async function start(): Promise<void> {
  await prisma.$connect();
  await ensureHotelAccountNumbersSqlite(prisma);
  await ensureHotelUserAuthColumnsSqlite(prisma);
  await ensureGuestFeedbackFollowupColumnsSqlite(prisma);

  const g = globalThis as typeof globalThis & { __server_started__?: boolean };
  if (g.__server_started__) {
    return;
  }
  g.__server_started__ = true;

  const server = app.listen(port, host, () => {
    const urlHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`ChatStay server listening on http://${urlHost}:${port}`);
    console.log(`Open in browser: http://${urlHost}:${port}/admin/profile  (login required)`);
    console.log(`(Keep this terminal open while you use the app.)`);
    logWhatsAppStartupHints();
    void localSqliteBackgroundSchedulersEnabled(prisma)
      .then((runSchedulers) => {
        if (!runSchedulers) return;
        startPreArrivalReminderScheduler();
        startOwnerDailyDigestScheduler();
        startHotelDailyDigestScheduler();
        startGuestAutoFollowupScheduler();
        startBookingSessionFollowupScheduler();
        startAutoOptimizationScheduler();
      })
      .catch((err: unknown) =>
        console.error("[chatastay] Scheduler gate failed:", err instanceof Error ? err.message : String(err))
      );
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[chatastay] Port ${port} is already in use. Stop the other process or use another port, e.g. PORT=3001 npm run dev\n` +
          `            (macOS) See what holds the port: lsof -nP -iTCP:${port} -sTCP:LISTEN`
      );
    } else {
      console.error("[chatastay] Server failed to start:", err.message);
    }
    process.exit(1);
  });
}

void start().catch((err: unknown) => {
  console.error("[chatastay] Server failed to start:", err);
  process.exit(1);
});
