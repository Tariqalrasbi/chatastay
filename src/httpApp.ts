import "dotenv/config";
import express from "express";
import path from "node:path";
import { apiRouter } from "./routes/api";
import { adminRouter, authRouter } from "./routes/admin";
import { housekeepingRouter } from "./routes/housekeeping";
import { guestRouter } from "./routes/guest";
import { ownerRouter } from "./routes/owner";
import { publicHotelRouter } from "./routes/publicHotel";
import { marketplaceRouter } from "./routes/marketplace";
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

  /// Phase D: explicit JSON health check for monitoring / uptime probes.
  /// (`/` is now served by the marketplace router; it still returns the same
  /// `{ status: "ok" }` JSON when the request advertises Accept: application/json
  /// without text/html — see `wantsJsonHealth` in routes/marketplace.ts.)
  app.get("/healthz", (_req, res) => {
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
  /// Marketplace mounts at `/` first so `GET /`, `GET /search`, `GET /h/:slug` resolve here.
  /// `publicHotelRouter` (rating page at `/hotel/:slug`) keeps a non-overlapping prefix.
  app.use("/", marketplaceRouter);
  app.use("/", publicHotelRouter);
  app.use("/owner", ownerRouter);
  app.use("/whatsapp/webhook", whatsappWebhookRouter);

  app.use((req, res) => {
    const wantsJson =
      req.path.startsWith("/api/") ||
      (req.accepts(["json", "html"]) === "json" && !req.accepts("html"));
    if (wantsJson) {
      res.status(404).json({ ok: false, error: "not_found", path: req.path });
      return;
    }
    const home = req.path.startsWith("/guest")
      ? "/guest"
      : req.path.startsWith("/admin") || req.path.startsWith("/auth")
        ? "/admin/login"
        : req.path.startsWith("/owner")
          ? "/owner/login"
          : "/";
    res.status(404).type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page not found · ChatStay</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, "Segoe UI", Arial, sans-serif; background: linear-gradient(180deg, #f7fcf9 0%, #eef7f2 100%); color: #0b1f1c; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    main { max-width: 420px; background: #fff; border: 1px solid #dce8e3; border-radius: 20px; padding: 28px 24px; box-shadow: 0 24px 70px rgba(15,44,38,.12); text-align: center; }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    p { margin: 0 0 20px; color: #64748b; line-height: 1.55; font-size: 15px; }
    a { display: inline-block; min-height: 44px; line-height: 44px; padding: 0 18px; border-radius: 12px; background: linear-gradient(135deg, #25d366, #128c7e); color: #053b18; font-weight: 800; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>Page not found</h1>
    <p>We could not find <code style="font-size:13px">${escapeHtml(req.path)}</code>. The link may be outdated or mistyped.</p>
    <a href="${escapeHtml(home)}">Go back</a>
  </main>
</body>
</html>`);
  });

  return app;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
