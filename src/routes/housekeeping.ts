import { Router, type Request, type Response } from "express";

/**
 * Legacy `/hk` URLs: housekeeping now uses the same platform as the rest of the PMS
 * (`/admin/login` → `/admin/hk` for housekeeper roles). These routes keep old bookmarks
 * working and guide any remaining POSTs from saved forms.
 */
export const housekeepingRouter = Router();

const hkCookieName = "chatastay_hk_session";

function clearHkSessionCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${hkCookieName}=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`
  );
}

const legacyHkMovedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Housekeeping — same sign-in as staff</title>
</head>
<body style="font-family:system-ui,Segoe UI,sans-serif;background:#f0fdf4;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#0f172a">
  <div style="max-width:460px;background:#fff;border:1px solid #bbf7d0;border-radius:14px;padding:22px;box-shadow:0 8px 28px rgba(15,23,42,.08)">
    <h1 style="margin:0 0 10px;font-size:1.25rem">One platform for everyone</h1>
    <p style="margin:0 0 14px;line-height:1.5;color:#334155;font-size:15px">
      The old <code>/hk</code> housekeeping URL is retired. Use the same <strong>staff sign-in</strong> as the rest of the property
      (email or username and PIN/password). Housekeeping accounts open the task board automatically after login.
    </p>
    <p style="margin:0 0 18px">
      <a href="/admin/login?hk_moved=1" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#059669;color:#fff;font-weight:700;text-decoration:none">Go to staff sign-in</a>
    </p>
    <p style="margin:0;font-size:13px;color:#64748b">If this form was saved on a device, update the bookmark to <code>/admin/hk</code> after signing in.</p>
  </div>
</body>
</html>`;

function sendLegacyHkPostMessage(_req: Request, res: Response): void {
  res.status(200).type("html").send(legacyHkMovedHtml);
}

housekeepingRouter.get("/", (_req, res) => {
  res.redirect(302, "/admin/hk");
});

housekeepingRouter.get("/login", (_req, res) => {
  res.redirect(302, "/admin/login?hk_moved=1");
});

housekeepingRouter.get("/logout", (_req, res) => {
  clearHkSessionCookie(res);
  res.redirect(302, "/admin/login?hk_moved=1");
});

housekeepingRouter.post("/logout", (_req, res) => {
  clearHkSessionCookie(res);
  res.redirect(303, "/admin/login?hk_moved=1");
});

housekeepingRouter.post("/login", sendLegacyHkPostMessage);
housekeepingRouter.post("/room/:roomId/claim", sendLegacyHkPostMessage);
housekeepingRouter.post("/room/:roomId/status", sendLegacyHkPostMessage);
housekeepingRouter.post("/task/:taskId/start-cleaning", sendLegacyHkPostMessage);

/** Any other GET/HEAD under <code>/hk</code> (old deep links) → housekeeping home in admin. */
housekeepingRouter.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    res.redirect(302, "/admin/hk");
    return;
  }
  next();
});

housekeepingRouter.use((req, res) => {
  if (req.method === "POST") {
    sendLegacyHkPostMessage(req, res);
    return;
  }
  res.status(404).type("html").send("<p>Not found.</p>");
});
