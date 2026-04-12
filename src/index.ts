import "dotenv/config";
import express from "express";
import path from "node:path";
import { apiRouter } from "./routes/api";
import { adminRouter } from "./routes/admin";
import { guestRouter } from "./routes/guest";
import { ownerRouter } from "./routes/owner";
import { whatsappWebhookRouter } from "./whatsapp/webhookRouter";
import { logWhatsAppStartupHints } from "./whatsapp/send";
import { startPreArrivalReminderScheduler } from "./jobs/preArrivalReminderJob";
import { startOwnerDailyDigestScheduler } from "./jobs/ownerDailyDigestJob";
import { startHotelDailyDigestScheduler } from "./jobs/hotelDailyDigestJob";

const app = express();
const rawPort = process.env.PORT ?? "3000";
const parsedPort = Number.parseInt(String(rawPort), 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
/** Bind all interfaces by default so `localhost`, `127.0.0.1`, and LAN URLs behave consistently (override with HOST=127.0.0.1 if needed). */
const host = process.env.HOST ?? "0.0.0.0";

// Stripe webhook requires raw body for signature verification.
app.use("/api/payments/webhook/stripe", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/static", express.static(path.join(process.cwd(), "src", "public")));

app.get("/", (_req, res) => {
  res.json({ name: "chatastay", status: "ok" });
});

app.use("/api", apiRouter);
app.use("/admin", adminRouter);
app.use("/guest", guestRouter);
app.use("/owner", ownerRouter);
app.use("/whatsapp/webhook", whatsappWebhookRouter);

const server = app.listen(port, host, () => {
  const urlHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`ChatAstay server listening on http://${urlHost}:${port}`);
  console.log(`Open in browser: http://${urlHost}:${port}/admin/profile  (login required)`);
  console.log(`(Keep this terminal open while you use the app.)`);
  logWhatsAppStartupHints();
  startPreArrivalReminderScheduler();
  startOwnerDailyDigestScheduler();
  startHotelDailyDigestScheduler();
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
