import "dotenv/config";
import express from "express";
import path from "node:path";
import { apiRouter } from "./routes/api";
import { adminRouter, authRouter } from "./routes/admin";
import { housekeepingRouter } from "./routes/housekeeping";
import { guestRouter } from "./routes/guest";
import { ownerRouter } from "./routes/owner";
import { publicHotelRouter } from "./routes/publicHotel";
import { whatsappWebhookRouter } from "./whatsapp/webhookRouter";

/**
 * Express app with the same middleware + route stack as production.
 * Used by `src/index.ts` (listen) and by `scripts/critical-flows.test.ts` (in-process HTTP checks).
 */
export function createHttpApp(): express.Application {
  const app = express();

  app.use("/api/payments/webhook/stripe", express.raw({ type: "application/json" }));
  app.use("/api/payments/webhook/thawani", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/static", express.static(path.join(process.cwd(), "src", "public")));

  app.get("/", (_req, res) => {
    res.json({ name: "chatastay", status: "ok" });
  });
  app.get("/reset-password", (req, res) => {
    const token = String(req.query.token ?? "").trim();
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    res.redirect(`/admin/reset-password${query}`);
  });

  app.use("/api", apiRouter);
  app.use("/auth", authRouter);
  app.use("/admin", adminRouter);
  app.use("/hk", housekeepingRouter);
  app.use("/guest", guestRouter);
  app.use("/", publicHotelRouter);
  app.use("/owner", ownerRouter);
  app.use("/whatsapp/webhook", whatsappWebhookRouter);

  return app;
}
