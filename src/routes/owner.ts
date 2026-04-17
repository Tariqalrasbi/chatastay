import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InvoiceStatus, MessageDirection, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig, savePartnerSetupConfig } from "../core/partnerSetup";
import { loadOwnerPortfolioKpis } from "../core/ownerPortfolioKpi";
import { parseKpiPreset } from "../core/managementKpiDashboard";
import { filterPlatformAlerts, loadPlatformAlerts } from "../core/ownerPlatformAlerts";
import { runOwnerDailyDigest } from "../core/ownerDailyDigest";
import { isOwnerDigestSmtpConfigured } from "../core/ownerDigestMail";

export const ownerRouter = Router();

type FeedbackHealthStatus = "normal" | "watch" | "action_needed" | "no_feedback";

function deriveFeedbackSignals(params: {
  averageRating: number | null;
  responseCount: number;
  lowRatingCount: number;
  recentLowRatingCount: number;
  latestLowRatingAt: Date | null;
}): {
  averageRating: number | null;
  responseCount: number;
  lowRatingCount: number;
  lowRatingRate: number;
  latestLowRatingAt: Date | null;
  recentNegativeFeedbackFlag: boolean;
  repeatedIssueAlert: boolean;
  feedbackStatus: FeedbackHealthStatus;
} {
  const responseCount = Math.max(0, params.responseCount || 0);
  const lowRatingCount = Math.max(0, params.lowRatingCount || 0);
  const averageRating = typeof params.averageRating === "number" ? params.averageRating : null;
  const lowRatingRate = responseCount > 0 ? Number(((lowRatingCount / responseCount) * 100).toFixed(1)) : 0;
  const recentNegativeFeedbackFlag = (params.recentLowRatingCount || 0) > 0;
  const repeatedIssueAlert = (params.recentLowRatingCount || 0) >= 2;
  const feedbackStatus: FeedbackHealthStatus =
    responseCount === 0
      ? "no_feedback"
      : averageRating !== null && (averageRating < 3 || lowRatingCount >= 2)
        ? "action_needed"
        : (averageRating !== null && averageRating < 4) || lowRatingCount >= 1
          ? "watch"
          : "normal";
  return {
    averageRating,
    responseCount,
    lowRatingCount,
    lowRatingRate,
    latestLowRatingAt: params.latestLowRatingAt,
    recentNegativeFeedbackFlag,
    repeatedIssueAlert,
    feedbackStatus
  };
}

const ownerSessionCookieName = "chatastay_owner_session";
const ownerSessions = new Map<string, { email: string; expiresAt: number }>();
const ownerSessionTtlMs = 8 * 60 * 60 * 1000;
const ownerActorEmail = process.env.OWNER_EMAIL ?? "owner@chatastay.local";
const ownerUsersFile = path.join(process.cwd(), "owner-users.json");
const ownerLockoutAttempts = 5;
const ownerLockoutDurationMs = 15 * 60 * 1000;
const twoFactorTtlMs = 10 * 60 * 1000;
const passwordResetTtlMs = 30 * 60 * 1000;
const twoFactorChallenges = new Map<string, { email: string; expiresAt: number }>();
const passwordResetChallenges = new Map<string, { email: string; expiresAt: number }>();
const totpTimeStepSeconds = 30;
const totpDigits = 6;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

interface OwnerUser {
  email: string;
  passwordHash: string;
  role: "OWNER" | "PLATFORM_ADMIN" | "SUPPORT";
  isActive: boolean;
  failedAttempts: number;
  lockedUntil: number | null;
  requirePasswordReset: boolean;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  pendingTwoFactorSecret: string | null;
}

interface LegacyOwnerUser {
  email: string;
  password?: string;
  passwordHash?: string;
  role?: "OWNER" | "PLATFORM_ADMIN" | "SUPPORT";
  isActive?: boolean;
  failedAttempts?: number;
  lockedUntil?: number | null;
  requirePasswordReset?: boolean;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string | null;
  pendingTwoFactorSecret?: string | null;
}

const defaultOwnerUsers: OwnerUser[] = [
  {
    email: "owner@chatastay.local",
    passwordHash: hashPassword("owner123"),
    role: "OWNER",
    isActive: true,
    failedAttempts: 0,
    lockedUntil: null,
    requirePasswordReset: false,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    pendingTwoFactorSecret: null
  }
];

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, passwordHash: string): boolean {
  const [salt, stored] = passwordHash.split(":");
  if (!salt || !stored) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(derived, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += base32Alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replaceAll("=", "").replaceAll(" ", "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const idx = base32Alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function getHotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = binary % 10 ** totpDigits;
  return String(code).padStart(totpDigits, "0");
}

function verifyTotpCode(secret: string, code: string, now = Date.now()): boolean {
  const normalized = code.replaceAll(" ", "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(now / 1000 / totpTimeStepSeconds);
  for (const offset of [-1, 0, 1]) {
    const expected = getHotp(secret, counter + offset);
    const a = Buffer.from(expected);
    const b = Buffer.from(normalized);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

function getTotpProvisioningUri(email: string, secret: string): string {
  const issuer = "ChatAstay";
  const label = `${issuer}:${email}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(totpDigits),
    period: String(totpTimeStepSeconds)
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function createOwnerSession(res: Response, email: string): void {
  const token = crypto.randomUUID();
  ownerSessions.set(token, { email, expiresAt: Date.now() + ownerSessionTtlMs });
  res.setHeader(
    "Set-Cookie",
    `${ownerSessionCookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
      ownerSessionTtlMs / 1000
    )}`
  );
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value: Date | null | undefined): string {
  if (!value) return "-";
  return value.toISOString().slice(0, 10);
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

/** Local YYYY-MM-DD for owner dashboard date filters (avoids UTC shift). */
function formatDateForOwnerInput(input: Date | null | undefined): string {
  if (!input) return "";
  const y = input.getFullYear();
  const m = input.getMonth() + 1;
  const d = input.getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

function ownerStartOfDay(input: Date): Date {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** Parse YYYY-MM-DD as local calendar date. */
function parseOwnerDateInput(raw: unknown, fallback: Date): Date {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const s = raw.trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    const d = Number(match[3]);
    const parsed = new Date(y, m, d);
    if (parsed.getFullYear() === y && parsed.getMonth() === m && parsed.getDate() === d) return parsed;
  }
  const legacy = new Date(s);
  return Number.isNaN(legacy.getTime()) ? fallback : ownerStartOfDay(legacy);
}

function toCsvCell(value: string): string {
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"`;
}

function parseInvoiceStatus(raw: string | undefined): InvoiceStatus | undefined {
  if (!raw) return undefined;
  const allowed: InvoiceStatus[] = [
    InvoiceStatus.DRAFT,
    InvoiceStatus.OPEN,
    InvoiceStatus.PAID,
    InvoiceStatus.VOID,
    InvoiceStatus.UNCOLLECTIBLE
  ];
  return allowed.includes(raw as InvoiceStatus) ? (raw as InvoiceStatus) : undefined;
}

function parseCookies(req: Request): Record<string, string> {
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return {};

  return rawCookie.split(";").reduce<Record<string, string>>((acc, pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join("=") ?? "");
    return acc;
  }, {});
}

function getOwnerSessionToken(req: Request): string | undefined {
  return parseCookies(req)[ownerSessionCookieName];
}

function isOwnerAuthenticated(req: Request): boolean {
  const token = getOwnerSessionToken(req);
  if (!token) return false;
  const session = ownerSessions.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    ownerSessions.delete(token);
    return false;
  }
  return true;
}

function requireOwnerAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getOwnerSessionToken(req);
  if (!token) {
    res.redirect("/owner/login");
    return;
  }
  const session = ownerSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) ownerSessions.delete(token);
    res.redirect("/owner/login");
    return;
  }
  // Sliding expiration while user is active.
  session.expiresAt = Date.now() + ownerSessionTtlMs;
  ownerSessions.set(token, session);
  next();
}

function loadOwnerUsers(): OwnerUser[] {
  try {
    if (!fs.existsSync(ownerUsersFile)) {
      fs.writeFileSync(ownerUsersFile, JSON.stringify(defaultOwnerUsers, null, 2), "utf8");
      return defaultOwnerUsers;
    }
    const raw = fs.readFileSync(ownerUsersFile, "utf8");
    const parsed = JSON.parse(raw) as LegacyOwnerUser[];
    if (!Array.isArray(parsed)) return defaultOwnerUsers;

    let mutated = false;
    const users: OwnerUser[] = parsed
      .filter((user) => typeof user.email === "string")
      .map((user) => {
        const passwordHash =
          typeof user.passwordHash === "string"
            ? user.passwordHash
            : typeof user.password === "string"
              ? (() => {
                  mutated = true;
                  return hashPassword(user.password);
                })()
              : (() => {
                  mutated = true;
                  return hashPassword("owner123");
                })();
        return {
          email: user.email.toLowerCase(),
          passwordHash,
          role: user.role === "OWNER" || user.role === "PLATFORM_ADMIN" || user.role === "SUPPORT" ? user.role : "SUPPORT",
          isActive: user.isActive ?? true,
          failedAttempts: Number.isFinite(user.failedAttempts) ? Math.max(0, Number(user.failedAttempts)) : 0,
          lockedUntil:
            typeof user.lockedUntil === "number" && Number.isFinite(user.lockedUntil) ? Number(user.lockedUntil) : null,
          requirePasswordReset: Boolean(user.requirePasswordReset),
          twoFactorEnabled: Boolean(user.twoFactorEnabled),
          twoFactorSecret: typeof user.twoFactorSecret === "string" ? user.twoFactorSecret : null,
          pendingTwoFactorSecret: typeof user.pendingTwoFactorSecret === "string" ? user.pendingTwoFactorSecret : null
        };
      });
    if (!users.length) return defaultOwnerUsers;
    if (mutated) saveOwnerUsers(users);
    return users;
  } catch {
    return defaultOwnerUsers;
  }
}

function saveOwnerUsers(users: OwnerUser[]): void {
  fs.writeFileSync(ownerUsersFile, JSON.stringify(users, null, 2), "utf8");
}

async function logOwnerAudit(params: {
  hotelId: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  actorEmail?: string;
}): Promise<void> {
  const email = params.actorEmail ?? ownerActorEmail;
  await prisma.auditLog.create({
    data: {
      hotelId: params.hotelId,
      actorEmail: email,
      actorUserId: `OWNER:${email}`,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : undefined
    }
  });
}

function getOwnerSessionEmail(req: Request): string | undefined {
  const token = getOwnerSessionToken(req);
  if (!token) return undefined;
  const session = ownerSessions.get(token);
  if (!session || session.expiresAt < Date.now()) return undefined;
  return session.email;
}

/** True for roles allowed to change physical room-type capacity (not SUPPORT). */
function canManageRoomCapacity(req: Request): boolean {
  const email = getOwnerSessionEmail(req);
  if (!email) return false;
  const ownerEmail = (process.env.OWNER_EMAIL ?? "owner@chatastay.local").trim().toLowerCase();
  if (email.toLowerCase() === ownerEmail) return true;
  const user = loadOwnerUsers().find((u) => u.email === email.toLowerCase());
  const role = user?.role ?? "SUPPORT";
  return role === "OWNER" || role === "PLATFORM_ADMIN";
}

function ownerLayout(content: string, authenticated: boolean): string {
  const navHtml = authenticated
    ? [
        '<a href="/owner/dashboard">Platform Dashboard</a>',
        '<a href="/owner/alerts">Alerts</a>',
        '<a href="/owner/digest">Daily digest</a>',
        '<a href="/owner/hotels">Hotels</a>',
        '<a href="/owner/subscriptions">Subscriptions</a>',
      '<a href="/owner/billing">Billing</a>',
      '<a href="/owner/users">Owner Users</a>',
        '<a href="/owner/health">System Health</a>',
        '<a href="/owner/routing-health">Routing Health</a>',
        '<form method="post" action="/owner/logout"><button type="submit">Logout</button></form>'
      ].join("")
    : '<a href="/owner/login">Login</a>';

  const ownerNotifScript = authenticated
    ? `<script>
(function () {
  var btn = document.getElementById("ownerNotifBell");
  var badge = document.getElementById("ownerNotifBadge");
  var panel = document.getElementById("ownerNotifPanel");
  var list = document.getElementById("ownerNotifList");
  if (!btn || !badge || !panel || !list) return;
  btn.addEventListener("click", function () { panel.hidden = !panel.hidden; });
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!panel.hidden && !panel.contains(t) && !btn.contains(t)) panel.hidden = true;
  });
  function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  async function poll() {
    var r = await fetch("/owner/alerts/summary", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!r.ok) return;
    var j = await r.json();
    var unread = Number(j.critical || 0) + Number(j.warning || 0);
    badge.hidden = unread <= 0;
    badge.textContent = String(Math.min(99, unread));
    var top = Array.isArray(j.items) ? j.items : [];
    list.innerHTML = top.map(function (it) {
      return '<li style="margin:0;padding:8px 10px;border-bottom:1px solid #e2e8f0"><a href="' + esc(it.href || "/owner/alerts") + '" style="text-decoration:none;color:#0f172a"><strong>' + esc(it.title || "Alert") + "</strong><div style=\"font-size:12px;color:#5f6b7a\">" + esc(it.detail || "") + "</div></a></li>";
    }).join("");
  }
  poll();
  window.setInterval(poll, 10000);
})();
</script>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ChatAstay Owner Console</title>
    <style>
      :root {
        --brand: #0b6e6e;
        --accent: #25d366;
        --bg: #eef6f4;
        --card: #ffffff;
        --text: #0f172a;
        --muted: #5f6b7a;
        --border: #d8dee6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, "Segoe UI", Arial, sans-serif;
        background: linear-gradient(180deg, #f7fbfa 0%, var(--bg) 100%);
        color: var(--text);
      }
      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 300px 1fr;
      }
      .sidebar {
        background: linear-gradient(180deg, #073b36 0%, var(--brand) 100%);
        color: #fff;
        padding: 22px 16px;
      }
      .brand {
        margin-bottom: 18px;
      }
      .brand h1 {
        margin: 0 0 6px;
        font-size: 18px;
      }
      .brand p {
        margin: 0;
        opacity: 0.9;
        font-size: 12px;
      }
      nav {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      nav a, nav button {
        text-decoration: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #fff;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.08);
        padding: 10px 12px;
        text-align: left;
        font-size: 14px;
        cursor: pointer;
      }
      nav a:hover, nav button:hover {
        background: rgba(255, 255, 255, 0.18);
      }
      nav form { margin: 0; }
      .content {
        padding: 24px;
      }
      .owner-topbar {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 10px;
      }
      .panel {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: 0 8px 30px rgba(16, 24, 40, 0.06);
        padding: 22px;
        overflow-x: auto;
      }
      h2 { margin-top: 0; }
      .muted { color: var(--muted); }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0 12px;
      }
      .btn-link {
        display: inline-block;
        text-decoration: none;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #f7faf9;
        color: #083d2d;
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 600;
      }
      .btn-link.primary {
        background: var(--accent);
        border-color: transparent;
      }
      .grid-4 {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .stat {
        border: 1px solid var(--border);
        border-left: 6px solid var(--accent);
        border-radius: 12px;
        padding: 12px;
      }
      .stat h3 {
        margin: 0;
        font-size: 12px;
        color: var(--muted);
        font-weight: 600;
      }
      .stat p {
        margin: 8px 0 0;
        font-size: 22px;
        font-weight: 700;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 10px;
        min-width: 560px;
      }
      th, td {
        border-bottom: 1px solid var(--border);
        padding: 10px 8px;
        text-align: left;
        font-size: 13px;
      }
      th {
        color: var(--muted);
        font-weight: 600;
      }
      .badge {
        display: inline-block;
        border-radius: 999px;
        padding: 4px 9px;
        font-size: 12px;
        font-weight: 600;
      }
      .badge.ok { background: #dcfce7; color: #166534; }
      .badge.pending { background: #fef9c3; color: #854d0e; }
      .badge.alert { background: #fee2e2; color: #991b1b; }
      @media (max-width: 980px) {
        .shell { grid-template-columns: 1fr; }
        .grid-4, .grid-2 { grid-template-columns: 1fr; }
        .sidebar {
          padding: 14px 12px;
        }
        nav {
          flex-direction: row;
          overflow-x: auto;
        }
        nav a, nav button {
          white-space: nowrap;
        }
        .content { padding: 14px; }
        .panel { padding: 14px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>ChatAstay Owner</h1>
          <p>Platform operations console</p>
        </div>
        <nav>${navHtml}</nav>
      </aside>
      <main class="content">
        <div class="owner-topbar">
          <div style="position:relative">
            <button id="ownerNotifBell" type="button" style="border:1px solid var(--border);background:#fff;border-radius:999px;width:36px;height:36px;cursor:pointer">🔔</button>
            <span id="ownerNotifBadge" hidden style="position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 4px;font-weight:700">0</span>
            <div id="ownerNotifPanel" hidden style="position:absolute;top:42px;right:0;width:min(360px,calc(100vw - 40px));max-height:380px;overflow:auto;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 16px 36px rgba(15,23,42,.15);z-index:999">
              <div style="padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700">Platform alerts</div>
              <ul id="ownerNotifList" style="list-style:none;margin:0;padding:0"></ul>
            </div>
          </div>
        </div>
        <section class="panel">${content}</section>
      </main>
    </div>
    ${ownerNotifScript}
  </body>
</html>`;
}

ownerRouter.get("/", (req, res) => {
  if (!isOwnerAuthenticated(req)) {
    res.redirect("/owner/login");
    return;
  }
  res.redirect("/owner/dashboard");
});

ownerRouter.get("/login", (req, res) => {
  if (isOwnerAuthenticated(req)) {
    res.redirect("/owner/dashboard");
    return;
  }
  const content = `
<h2>Owner Console Login</h2>
<p class="muted">Sign in as ChatAstay platform owner.</p>
<form method="post" action="/owner/login" style="max-width: 420px">
  <label for="email">Email</label><br />
  <input id="email" type="email" name="email" required style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <label for="password">Password</label><br />
  <input id="password" type="password" name="password" required style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <button type="submit" style="width: 100%; padding: 10px 14px; border: 0; border-radius: 10px; background: #25d366; color: #083d2d; font-weight: 700">Sign In</button>
</form>
<p class="muted" style="margin-top: 12px">Default: owner@chatastay.local / owner123</p>`;
  res.type("html").send(ownerLayout(content, false));
});

ownerRouter.post("/login", (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const ownerEmail = process.env.OWNER_EMAIL ?? "owner@chatastay.local";
  const ownerPassword = process.env.OWNER_PASSWORD ?? "owner123";
  const now = Date.now();
  const ownerUsers = loadOwnerUsers();
  const userIndex = ownerUsers.findIndex((user) => user.email === email);
  const matchedUser = userIndex >= 0 ? ownerUsers[userIndex] : undefined;
  const envOwnerMatch = email === ownerEmail && password === ownerPassword;

  if (!envOwnerMatch && matchedUser) {
    if (!matchedUser.isActive) {
      res.status(401).type("html").send(ownerLayout("<h2>Owner Console Login</h2><p>User is disabled.</p>", false));
      return;
    }
    if (matchedUser.lockedUntil && matchedUser.lockedUntil > now) {
      const minutes = Math.ceil((matchedUser.lockedUntil - now) / 60000);
      res
        .status(429)
        .type("html")
        .send(ownerLayout(`<h2>Owner Console Login</h2><p>Account locked. Try again in ${minutes} minute(s).</p>`, false));
      return;
    }
    if (!verifyPassword(password, matchedUser.passwordHash)) {
      const attempts = matchedUser.failedAttempts + 1;
      const shouldLock = attempts >= ownerLockoutAttempts;
      ownerUsers[userIndex] = {
        ...matchedUser,
        failedAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? now + ownerLockoutDurationMs : null
      };
      saveOwnerUsers(ownerUsers);
      const msg = shouldLock
        ? "Too many failed attempts. Account locked for 15 minutes."
        : `Invalid credentials. Failed attempt ${attempts}/${ownerLockoutAttempts}.`;
      res.status(401).type("html").send(ownerLayout(`<h2>Owner Console Login</h2><p>${msg}</p>`, false));
      return;
    }
  }

  if (!envOwnerMatch && !matchedUser) {
    res.status(401).type("html").send(ownerLayout("<h2>Owner Console Login</h2><p>Invalid credentials.</p>", false));
    return;
  }

  if (matchedUser) {
    ownerUsers[userIndex] = { ...matchedUser, failedAttempts: 0, lockedUntil: null };
    saveOwnerUsers(ownerUsers);

    if (matchedUser.requirePasswordReset) {
      const resetToken = crypto.randomUUID();
      passwordResetChallenges.set(resetToken, { email: matchedUser.email, expiresAt: Date.now() + passwordResetTtlMs });
      res.redirect(`/owner/reset-password?token=${encodeURIComponent(resetToken)}`);
      return;
    }

    if (matchedUser.twoFactorEnabled && matchedUser.twoFactorSecret) {
      const challengeToken = crypto.randomUUID();
      twoFactorChallenges.set(challengeToken, {
        email: matchedUser.email,
        expiresAt: Date.now() + twoFactorTtlMs
      });
      res.redirect(`/owner/2fa?token=${encodeURIComponent(challengeToken)}`);
      return;
    }
  }

  createOwnerSession(res, matchedUser?.email ?? ownerEmail);
  res.redirect("/owner/dashboard");
});

ownerRouter.get("/2fa", (req, res) => {
  if (isOwnerAuthenticated(req)) {
    res.redirect("/owner/dashboard");
    return;
  }
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const challenge = token ? twoFactorChallenges.get(token) : undefined;
  if (!challenge || challenge.expiresAt < Date.now()) {
    if (token) twoFactorChallenges.delete(token);
    res.status(400).type("html").send(ownerLayout("<h2>Two-Factor Verification</h2><p>Verification token expired.</p>", false));
    return;
  }

  const content = `
<h2>Two-Factor Verification</h2>
<p class="muted">Open your authenticator app and enter the current 6-digit code.</p>
<form method="post" action="/owner/2fa" style="max-width: 420px">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <label for="code">Code</label><br />
  <input id="code" name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <button type="submit" style="width: 100%; padding: 10px 14px; border: 0; border-radius: 10px; background: #25d366; color: #083d2d; font-weight: 700">Verify</button>
</form>`;
  res.type("html").send(ownerLayout(content, false));
});

ownerRouter.post("/2fa", (req, res) => {
  const token = String(req.body.token ?? "");
  const code = String(req.body.code ?? "").trim();
  const challenge = twoFactorChallenges.get(token);
  if (!challenge || challenge.expiresAt < Date.now()) {
    if (token) twoFactorChallenges.delete(token);
    res.status(400).type("html").send(ownerLayout("<h2>Two-Factor Verification</h2><p>Verification token expired.</p>", false));
    return;
  }
  const users = loadOwnerUsers();
  const user = users.find((item) => item.email === challenge.email);
  const valid = Boolean(user?.twoFactorEnabled && user.twoFactorSecret && verifyTotpCode(user.twoFactorSecret, code));
  if (!valid) {
    res.status(401).type("html").send(ownerLayout("<h2>Two-Factor Verification</h2><p>Invalid verification code.</p>", false));
    return;
  }

  twoFactorChallenges.delete(token);
  createOwnerSession(res, challenge.email);
  res.redirect("/owner/dashboard");
});

ownerRouter.get("/reset-password", (req, res) => {
  if (isOwnerAuthenticated(req)) {
    res.redirect("/owner/dashboard");
    return;
  }
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const challenge = token ? passwordResetChallenges.get(token) : undefined;
  if (!challenge || challenge.expiresAt < Date.now()) {
    if (token) passwordResetChallenges.delete(token);
    res.status(400).type("html").send(ownerLayout("<h2>Reset Password</h2><p>Password reset token expired.</p>", false));
    return;
  }
  const content = `
<h2>Reset Password</h2>
<p class="muted">Set a new password to continue.</p>
<form method="post" action="/owner/reset-password" style="max-width: 420px">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <label for="newPassword">New Password</label><br />
  <input id="newPassword" type="password" name="newPassword" required minlength="8" style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <label for="confirmPassword">Confirm Password</label><br />
  <input id="confirmPassword" type="password" name="confirmPassword" required minlength="8" style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <button type="submit" style="width: 100%; padding: 10px 14px; border: 0; border-radius: 10px; background: #25d366; color: #083d2d; font-weight: 700">Update Password</button>
</form>`;
  res.type("html").send(ownerLayout(content, false));
});

ownerRouter.post("/reset-password", (req, res) => {
  const token = String(req.body.token ?? "");
  const newPassword = String(req.body.newPassword ?? "");
  const confirmPassword = String(req.body.confirmPassword ?? "");
  const challenge = passwordResetChallenges.get(token);
  if (!challenge || challenge.expiresAt < Date.now()) {
    if (token) passwordResetChallenges.delete(token);
    res.status(400).type("html").send(ownerLayout("<h2>Reset Password</h2><p>Password reset token expired.</p>", false));
    return;
  }
  if (newPassword.length < 8 || newPassword !== confirmPassword) {
    res.status(400).type("html").send(ownerLayout("<h2>Reset Password</h2><p>Passwords must match and be at least 8 characters.</p>", false));
    return;
  }

  const users = loadOwnerUsers();
  const idx = users.findIndex((user) => user.email === challenge.email);
  if (idx === -1) {
    res.status(404).type("html").send(ownerLayout("<h2>Reset Password</h2><p>User not found.</p>", false));
    return;
  }
  users[idx] = {
    ...users[idx],
    passwordHash: hashPassword(newPassword),
    requirePasswordReset: false,
    failedAttempts: 0,
    lockedUntil: null
  };
  saveOwnerUsers(users);
  passwordResetChallenges.delete(token);

  if (users[idx].twoFactorEnabled && users[idx].twoFactorSecret) {
    const challengeToken = crypto.randomUUID();
    twoFactorChallenges.set(challengeToken, {
      email: users[idx].email,
      expiresAt: Date.now() + twoFactorTtlMs
    });
    res.redirect(`/owner/2fa?token=${encodeURIComponent(challengeToken)}`);
    return;
  }

  createOwnerSession(res, users[idx].email);
  res.redirect("/owner/dashboard");
});

ownerRouter.post("/logout", (req, res) => {
  const token = getOwnerSessionToken(req);
  if (token) ownerSessions.delete(token);
  res.setHeader(
    "Set-Cookie",
    `${ownerSessionCookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
  res.redirect("/owner/login");
});

ownerRouter.get("/dashboard", requireOwnerAuth, async (req, res) => {
  const presetRaw = typeof req.query.preset === "string" ? req.query.preset : "month";
  const nowSd = ownerStartOfDay(new Date());
  const customStart = parseOwnerDateInput(req.query.start, nowSd);
  const customEnd = parseOwnerDateInput(req.query.end, nowSd);
  const { rangeStart, rangeEndExclusive, presetLabel } = parseKpiPreset(
    presetRaw,
    presetRaw === "custom" ? customStart : undefined,
    presetRaw === "custom" ? customEnd : undefined
  );

  const [kpi, failedSyncJobs, pendingPayments] = await Promise.all([
    loadOwnerPortfolioKpis({ rangeStart, rangeEndExclusive, presetLabel }),
    prisma.syncJob.count({ where: { status: "FAILED" } }),
    prisma.paymentIntent.count({ where: { status: { in: ["PENDING", "REQUIRES_ACTION"] } } })
  ]);
  const hotelIds = kpi.hotelRows.map((h) => h.hotelId);
  const feedbackByHotel = hotelIds.length
    ? await prisma.guestFeedback.groupBy({
        by: ["hotelId"],
        where: { hotelId: { in: hotelIds } },
        _avg: { rating: true },
        _count: { _all: true }
      })
    : [];
  const feedbackMap = new Map(feedbackByHotel.map((x) => [x.hotelId, { avg: x._avg.rating ?? 0, count: x._count._all }]));
  const recentFeedbackSince = ownerStartOfDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const lowByHotel = hotelIds.length
    ? await prisma.guestFeedback.groupBy({
        by: ["hotelId"],
        where: { hotelId: { in: hotelIds }, rating: { lte: 2 } },
        _count: { _all: true }
      })
    : [];
  const lowMap = new Map(lowByHotel.map((x) => [x.hotelId, x._count._all]));
  const recentLowByHotel = hotelIds.length
    ? await prisma.guestFeedback.groupBy({
        by: ["hotelId"],
        where: { hotelId: { in: hotelIds }, rating: { lte: 2 }, createdAt: { gte: recentFeedbackSince } },
        _count: { _all: true }
      })
    : [];
  const recentLowMap = new Map(recentLowByHotel.map((x) => [x.hotelId, x._count._all]));
  const latestLowByHotel = hotelIds.length
    ? await prisma.guestFeedback.groupBy({
        by: ["hotelId"],
        where: { hotelId: { in: hotelIds }, rating: { lte: 2 } },
        _max: { createdAt: true }
      })
    : [];
  const latestLowMap = new Map(latestLowByHotel.map((x) => [x.hotelId, x._max.createdAt ?? null]));
  const feedbackSignalByHotel = new Map(
    hotelIds.map((hotelId) => {
      const fb = feedbackMap.get(hotelId);
      const signal = deriveFeedbackSignals({
        averageRating: fb && fb.count > 0 ? fb.avg : null,
        responseCount: fb?.count ?? 0,
        lowRatingCount: lowMap.get(hotelId) ?? 0,
        recentLowRatingCount: recentLowMap.get(hotelId) ?? 0,
        latestLowRatingAt: latestLowMap.get(hotelId) ?? null
      });
      return [hotelId, signal];
    })
  );

  const trialingSubs =
    kpi.subscriptionsByStatus.find((s) => s.status === "TRIALING")?.count ?? 0;
  const planByHotelCount = new Map<string, number>();
  for (const h of kpi.hotelRows) {
    const label = h.planName?.trim() || "No plan";
    planByHotelCount.set(label, (planByHotelCount.get(label) ?? 0) + 1);
  }
  const planRows = Array.from(planByHotelCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<tr><td>${escapeHtml(name)}</td><td>${n}</td></tr>`)
    .join("");
  const hotelRowsSorted = [...kpi.hotelRows].sort(
    (a, b) => b.roomRevenue + b.fbRevenue - (a.roomRevenue + a.fbRevenue)
  );
  const ratedRows = hotelRowsSorted.filter((h) => (feedbackMap.get(h.hotelId)?.count ?? 0) > 0);
  const topRated = [...ratedRows]
    .sort((a, b) => (feedbackMap.get(b.hotelId)?.avg ?? 0) - (feedbackMap.get(a.hotelId)?.avg ?? 0))
    .slice(0, 3);
  const lowRated = [...ratedRows]
    .sort((a, b) => (feedbackMap.get(a.hotelId)?.avg ?? 0) - (feedbackMap.get(b.hotelId)?.avg ?? 0))
    .slice(0, 3);
  const cancellationsTotal = kpi.hotelRows.reduce((sum, r) => sum + r.bookingsCancelled, 0);

  const roomRevLines = kpi.portfolioRoomRevenueByCurrency.length
    ? kpi.portfolioRoomRevenueByCurrency
        .map((x) => `${formatMoney(x.amount, x.currency)} room`)
        .join(" · ")
    : "—";
  const fbRevLines = kpi.portfolioFbRevenueByCurrency.length
    ? kpi.portfolioFbRevenueByCurrency
        .map((x) => `${formatMoney(x.amount, x.currency)} F&amp;B`)
        .join(" · ")
    : "";

  const attentionBlock =
    kpi.attentionNotes.length > 0
      ? `<div style="margin:14px 0;padding:12px 14px;border-radius:12px;border:1px solid #fbbf24;background:#fffbeb">
  <strong style="color:#92400e">Attention</strong>
  <ul style="margin:8px 0 0 18px;padding:0;color:#78350f;font-size:13px">
    ${kpi.attentionNotes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}
  </ul>
</div>`
      : "";

  const subRows = kpi.subscriptionsByStatus
    .map((r) => `<tr><td>${escapeHtml(r.status)}</td><td>${r.count}</td></tr>`)
    .join("");

  const sourceRows = kpi.bookingSourceSummary
    .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${r.count}</td></tr>`)
    .join("");

  const hotelTableRows = hotelRowsSorted
    .map((h) => {
      const statusBadge = h.isActive
        ? '<span class="badge ok">Active</span>'
        : '<span class="badge alert">Suspended</span>';
      const subBadge =
        h.subscriptionStatus === "PAST_DUE"
          ? '<span class="badge alert">Past due</span>'
          : h.subscriptionStatus === "TRIALING"
            ? '<span class="badge pending">Trial</span>'
            : h.subscriptionStatus === "ACTIVE"
              ? '<span class="badge ok">Active</span>'
              : h.subscriptionStatus
                ? `<span class="badge pending">${escapeHtml(h.subscriptionStatus)}</span>`
                : "—";
      const feedbackSignal = feedbackSignalByHotel.get(h.hotelId) ?? deriveFeedbackSignals({
        averageRating: null,
        responseCount: 0,
        lowRatingCount: 0,
        recentLowRatingCount: 0,
        latestLowRatingAt: null
      });
      const feedbackStatusBadge =
        feedbackSignal.feedbackStatus === "action_needed"
          ? '<span class="badge alert">Action needed</span>'
          : feedbackSignal.feedbackStatus === "watch"
            ? '<span class="badge pending">Watch</span>'
            : feedbackSignal.feedbackStatus === "normal"
              ? '<span class="badge ok">Normal</span>'
              : '<span class="badge">No feedback</span>';
      return `<tr>
  <td><a href="/owner/hotels/${encodeURIComponent(h.hotelId)}">${escapeHtml(h.displayName)}</a><div class="muted" style="font-size:11px">${escapeHtml(h.slug)}</div></td>
  <td>${statusBadge}</td>
  <td>${escapeHtml(h.planName ?? "—")}<div style="margin-top:4px">${subBadge}</div></td>
  <td>${h.bookingsTotal} <span class="muted">(${h.bookingsConfirmed} conf · ${h.bookingsCancelled} canc)</span></td>
  <td>${formatMoney(h.roomRevenue, h.currency)}</td>
  <td>${formatMoney(h.fbRevenue, h.currency)}</td>
  <td>${h.conversations}</td>
  <td>${
    feedbackSignal.responseCount > 0 && feedbackSignal.averageRating !== null
      ? `${feedbackSignal.averageRating.toFixed(1)} ⭐ <span class="muted">(${feedbackSignal.responseCount})</span><div class="muted" style="font-size:11px">Low: ${feedbackSignal.lowRatingCount} (${feedbackSignal.lowRatingRate.toFixed(1)}%)</div>`
      : "—"
  }</td>
  <td>${feedbackStatusBadge}${feedbackSignal.recentNegativeFeedbackFlag ? '<div class="muted" style="font-size:11px">Recent negative</div>' : ""}</td>
  <td><a class="btn-link" href="/hotel/${encodeURIComponent(h.slug)}" target="_blank" rel="noopener noreferrer">Public page</a></td>
  <td>${h.campaigns} <span class="muted">(${h.campaignSentOk} sent)</span></td>
  <td>${h.openInvoiceCount > 0 ? `${formatMoney(h.openInvoiceTotal, h.currency)} (${h.openInvoiceCount})` : "—"}</td>
</tr>`;
    })
    .join("");

  const content = `
<h2>Platform dashboard</h2>
<p class="muted">Multi-hotel portfolio: compare performance, subscriptions, and messaging across every property. Quick actions below; metrics respect the date range.</p>
<div class="actions">
  <a class="btn-link primary" href="/owner/hotels">Manage Hotels</a>
  <a class="btn-link" href="/owner/subscriptions">Manage Subscriptions</a>
  <a class="btn-link" href="/owner/billing">Billing Actions</a>
  <a class="btn-link" href="/owner/users">Owner Users</a>
  <a class="btn-link" href="/owner/health">System Health</a>
</div>

<form method="get" action="/owner/dashboard" style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; margin-bottom:16px">
  <label>Quick range
    <select name="preset" style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-top:4px;display:block">
      <option value="today" ${presetRaw === "today" ? "selected" : ""}>Today</option>
      <option value="week" ${presetRaw === "week" ? "selected" : ""}>This week</option>
      <option value="month" ${presetRaw === "month" ? "selected" : ""}>This month</option>
      <option value="custom" ${presetRaw === "custom" ? "selected" : ""}>Custom</option>
    </select>
  </label>
  <label>From <input type="date" name="start" value="${escapeHtml(formatDateForOwnerInput(customStart))}" style="padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
  <label>To <input type="date" name="end" value="${escapeHtml(formatDateForOwnerInput(customEnd))}" style="padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
  <button type="submit" style="padding:9px 14px;border:0;border-radius:8px;background:var(--brand);color:#fff;font-weight:700">Apply</button>
</form>
<p class="muted" style="font-size:13px;margin-top:-8px"><strong>${escapeHtml(
    kpi.presetLabel
  )}</strong> · Stay window <strong>${escapeHtml(kpi.rangeStart)}</strong> → <strong>${escapeHtml(
    kpi.rangeEndInclusive
  )}</strong> (inclusive). Bookings and room revenue use <strong>check-in</strong> in this window. F&amp;B and conversations use <strong>created</strong> time in the same window.</p>
<p class="muted" style="font-size:12px;margin-top:-4px">Portfolio revenue mixes hotel currencies; use per-hotel columns for apples-to-apples comparison.</p>

${attentionBlock}

<div class="grid-4">
  <article class="stat"><h3>Total hotels</h3><p>${kpi.hotelsTotal}</p></article>
  <article class="stat"><h3>Active hotels</h3><p>${kpi.hotelsActive}</p><p class="muted" style="font-size:12px;margin:0">Inactive: ${kpi.hotelsInactive}</p></article>
  <article class="stat"><h3>Active subscriptions</h3><p>${kpi.subscriptionsActiveOrTrial}</p><p class="muted" style="font-size:12px;margin:0">Trialing: ${trialingSubs} · Cancelled (all time): ${kpi.subscriptionsCancelled}</p></article>
  <article class="stat"><h3>Room revenue (range)</h3><p style="font-size:16px;line-height:1.35">${roomRevLines}</p>${fbRevLines ? `<p class="muted" style="font-size:12px;margin:6px 0 0">${fbRevLines}</p>` : ""}</article>
</div>

<div class="grid-4" style="margin-top:12px">
  <article class="stat"><h3>Bookings (check-in in range)</h3><p>${kpi.portfolioBookingsTotal}</p><p class="muted" style="font-size:12px;margin:0">Confirmed: ${kpi.portfolioBookingsConfirmed}</p></article>
  <article class="stat"><h3>Cancellations (range)</h3><p>${cancellationsTotal}</p></article>
  <article class="stat"><h3>New conversations</h3><p>${kpi.portfolioConversations}</p></article>
  <article class="stat"><h3>Campaigns</h3><p>${kpi.portfolioCampaigns}</p><p class="muted" style="font-size:12px;margin:0">Sent OK: ${kpi.portfolioCampaignSentOk} · Audience: ${kpi.portfolioCampaignAudience}</p></article>
</div>

<div class="grid-4" style="margin-top:12px">
  <article class="stat"><h3>Subscriptions renewing ≤14d</h3><p>${kpi.subscriptionsExpiring14d}</p></article>
  <article class="stat"><h3>Past-due subscriptions</h3><p>${kpi.pastDueSubscriptions}</p></article>
  <article class="stat"><h3>Open invoices (attention)</h3><p>${kpi.openInvoicesAttention}</p><p class="muted" style="font-size:12px;margin:0">Open with overdue or no due date</p></article>
  <article class="stat"><h3>Platform pulse</h3><p style="font-size:15px">Sync failures: ${failedSyncJobs}</p><p class="muted" style="font-size:12px;margin:0">Pending payment intents: ${pendingPayments}</p></article>
</div>

<h3 style="margin-top:22px">Guest rating overview</h3>
<table>
  <thead><tr><th>Hotel</th><th>Average rating</th><th>Reviews</th><th>Low ratings (≤2)</th><th>Alert</th><th>Preview</th></tr></thead>
  <tbody>${
    hotelRowsSorted
      .map((h) => {
        const signal = feedbackSignalByHotel.get(h.hotelId);
        const feedbackStatusBadge =
          signal?.feedbackStatus === "action_needed"
            ? '<span class="badge alert">Action needed</span>'
            : signal?.feedbackStatus === "watch"
              ? '<span class="badge pending">Watch</span>'
              : signal?.feedbackStatus === "normal"
                ? '<span class="badge ok">Normal</span>'
                : '<span class="badge">No feedback</span>';
        return `<tr>
    <td><a href="/owner/hotels/${encodeURIComponent(h.hotelId)}">${escapeHtml(h.displayName)}</a></td>
    <td>${signal?.responseCount ? `${(signal.averageRating ?? 0).toFixed(1)} ⭐` : "—"}</td>
    <td>${signal?.responseCount ?? 0}</td>
    <td>${signal?.lowRatingCount ?? 0} <span class="muted">(${(signal?.lowRatingRate ?? 0).toFixed(1)}%)</span></td>
    <td>${feedbackStatusBadge}${signal?.latestLowRatingAt ? `<div class="muted" style="font-size:11px">Last low: ${escapeHtml(formatDate(signal.latestLowRatingAt))}</div>` : ""}</td>
    <td><a class="btn-link" href="/hotel/${encodeURIComponent(h.slug)}" target="_blank" rel="noopener noreferrer">Open</a></td>
  </tr>`;
      })
      .join("") || `<tr><td colspan="6" class="muted">No feedback yet.</td></tr>`
  }</tbody>
</table>

<h3 style="margin-top:22px">Rating leaders and risks</h3>
<div class="grid-2">
  <article class="stat">
    <h3>Top 3 hotels</h3>
    <ul>${topRated
      .map(
        (h) =>
          `<li><a href="/owner/hotels/${encodeURIComponent(h.hotelId)}">${escapeHtml(h.displayName)}</a> · ${(feedbackMap.get(h.hotelId)?.avg ?? 0).toFixed(1)} ⭐ <a class="muted" href="/hotel/${encodeURIComponent(h.slug)}" target="_blank" rel="noopener noreferrer">preview</a></li>`
      )
      .join("") || `<li class="muted">Not enough rating data.</li>`}</ul>
  </article>
  <article class="stat">
    <h3>Lowest 3 hotels</h3>
    <ul>${lowRated
      .map(
        (h) =>
          `<li><a href="/owner/hotels/${encodeURIComponent(h.hotelId)}">${escapeHtml(h.displayName)}</a> · ${(feedbackMap.get(h.hotelId)?.avg ?? 0).toFixed(1)} ⭐ <a class="muted" href="/hotel/${encodeURIComponent(h.slug)}" target="_blank" rel="noopener noreferrer">preview</a></li>`
      )
      .join("") || `<li class="muted">Not enough rating data.</li>`}</ul>
  </article>
</div>

<h3 style="margin-top:22px">Subscription status (all hotels)</h3>
<table>
  <thead><tr><th>Status</th><th>Count</th></tr></thead>
  <tbody>${subRows}</tbody>
</table>

<h3 style="margin-top:18px">Plans in use (latest subscription per hotel)</h3>
<p class="muted" style="font-size:12px;margin-top:-6px">Each hotel is counted once by its most recent subscription record.</p>
<table>
  <thead><tr><th>Plan</th><th>Hotels</th></tr></thead>
  <tbody>${planRows}</tbody>
</table>

<h3 style="margin-top:22px">Booking source (range, portfolio)</h3>
<table>
  <thead><tr><th>Source</th><th>Bookings</th></tr></thead>
  <tbody>${sourceRows.length ? sourceRows : `<tr><td colspan="2" class="muted">No bookings in range</td></tr>`}</tbody>
</table>

<h3 style="margin-top:22px">Hotel comparison</h3>
<table>
  <thead><tr><th>Hotel</th><th>Status</th><th>Plan / subscription</th><th>Bookings</th><th>Room revenue</th><th>F&amp;B posted</th><th>Conversations</th><th>Rating</th><th>Feedback alert</th><th>Public</th><th>Campaigns</th><th>Open invoices</th></tr></thead>
  <tbody>${hotelTableRows.length ? hotelTableRows : `<tr><td colspan="12" class="muted">No hotels</td></tr>`}</tbody>
</table>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.get("/alerts", requireOwnerAuth, async (req, res) => {
  const snapshot = await loadPlatformAlerts();
  const sevRaw = typeof req.query.severity === "string" ? req.query.severity : "all";
  const catRaw = typeof req.query.category === "string" ? req.query.category : "all";
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const severity =
    sevRaw === "critical" || sevRaw === "warning" || sevRaw === "info" ? sevRaw : "all";
  const category =
    catRaw === "billing" ||
    catRaw === "activity" ||
    catRaw === "messaging" ||
    catRaw === "inventory" ||
    catRaw === "financial" ||
    catRaw === "system"
      ? catRaw
      : "all";

  const filtered = filterPlatformAlerts(snapshot, { severity, category, q });

  function severityBadge(s: string): string {
    if (s === "critical") return '<span class="badge alert">Critical</span>';
    if (s === "warning") return '<span class="badge pending">Warning</span>';
    return '<span class="badge" style="background:#e0e7ff;color:#312e81">Info</span>';
  }

  const rows = filtered
    .map(
      (a) => `<tr>
  <td>${severityBadge(a.severity)}</td>
  <td>${escapeHtml(a.category)}</td>
  <td><strong>${escapeHtml(a.hotelName)}</strong><div class="muted" style="font-size:11px">${escapeHtml(a.slug)}</div></td>
  <td>${escapeHtml(a.title)}<div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(a.detail)}</div></td>
  <td>${a.value ? escapeHtml(String(a.value)) : "—"}</td>
  <td><a class="btn-link" href="${escapeHtml(a.href)}">Investigate</a></td>
</tr>`
    )
    .join("");

  const content = `
<h2>Platform alerts</h2>
<p class="muted">Exception-focused view across hotels — subscription health, engagement, messaging backlog, inventory gaps, payments, and channel sync. Thresholds are tuned to reduce noise; refine rules in code as operations mature.</p>

<div class="grid-4" style="margin-bottom:14px">
  <article class="stat"><h3>Critical</h3><p>${snapshot.counts.critical}</p></article>
  <article class="stat"><h3>Warning</h3><p>${snapshot.counts.warning}</p></article>
  <article class="stat"><h3>Info</h3><p>${snapshot.counts.info}</p></article>
  <article class="stat"><h3>Showing</h3><p>${filtered.length}</p><p class="muted" style="font-size:12px;margin:0">of ${snapshot.counts.total} total</p></article>
</div>

<form method="get" action="/owner/alerts" style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; margin-bottom:16px">
  <label>Severity
    <select name="severity" style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-top:4px;display:block">
      <option value="all" ${severity === "all" ? "selected" : ""}>All</option>
      <option value="critical" ${severity === "critical" ? "selected" : ""}>Critical</option>
      <option value="warning" ${severity === "warning" ? "selected" : ""}>Warning</option>
      <option value="info" ${severity === "info" ? "selected" : ""}>Info</option>
    </select>
  </label>
  <label>Category
    <select name="category" style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-top:4px;display:block">
      <option value="all" ${category === "all" ? "selected" : ""}>All</option>
      <option value="billing" ${category === "billing" ? "selected" : ""}>Billing</option>
      <option value="activity" ${category === "activity" ? "selected" : ""}>Activity</option>
      <option value="messaging" ${category === "messaging" ? "selected" : ""}>Messaging</option>
      <option value="inventory" ${category === "inventory" ? "selected" : ""}>Inventory</option>
      <option value="financial" ${category === "financial" ? "selected" : ""}>Financial</option>
      <option value="system" ${category === "system" ? "selected" : ""}>System</option>
    </select>
  </label>
  <label style="min-width:200px">Search
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Hotel, title…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;margin-top:4px" />
  </label>
  <button type="submit" style="padding:9px 14px;border:0;border-radius:8px;background:var(--brand);color:#fff;font-weight:700">Apply</button>
</form>

<table>
  <thead><tr><th>Severity</th><th>Category</th><th>Hotel</th><th>Alert</th><th>Value</th><th>Action</th></tr></thead>
  <tbody>${rows.length ? rows : `<tr><td colspan="6" class="muted">No alerts match the current filters.</td></tr>`}</tbody>
</table>

<p class="muted" style="font-size:12px;margin-top:16px;max-width:900px">
  <strong>Notes:</strong> “Threads awaiting reply” uses the last message direction per conversation (SQLite window functions). “In-house without unit” checks overlapping stays for today. Daily cash close / folio carry-forward is not modeled here. Guest payment failures count Stripe-style <code>FAILED</code> intents in the lookback window.
</p>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.get("/alerts/summary", requireOwnerAuth, async (_req, res) => {
  const snapshot = await loadPlatformAlerts();
  const items = snapshot.alerts.slice(0, 8).map((a) => ({
    title: a.title,
    detail: a.detail,
    href: a.href,
    severity: a.severity
  }));
  res.json({
    ok: true,
    critical: snapshot.counts.critical,
    warning: snapshot.counts.warning,
    info: snapshot.counts.info,
    items
  });
});

ownerRouter.get("/digest", requireOwnerAuth, async (req, res) => {
  const logs = await prisma.ownerDailyDigestLog.findMany({
    orderBy: { digestKey: "desc" },
    take: 30
  });
  const tz = (process.env.OWNER_DIGEST_TZ ?? "Asia/Muscat").trim();
  const sendTime = (process.env.OWNER_DIGEST_TIME ?? "07:00").trim();
  const enabled = process.env.OWNER_DIGEST_ENABLED !== "false";
  const smtpOk = isOwnerDigestSmtpConfigured();
  const sentFlash = req.query.sent === "1";
  const errFlash = typeof req.query.err === "string" ? req.query.err : "";

  const logRows = logs
    .map((row) => {
      const sum = row.summaryJson
        ? (() => {
            try {
              const j = JSON.parse(row.summaryJson) as {
                hotelsTotal?: number;
                bookingsToday?: number;
                newAlertCount?: number;
              };
              return `Hotels ${j.hotelsTotal ?? "—"} · bookings ${j.bookingsToday ?? "—"} · new alerts ${j.newAlertCount ?? "—"}`;
            } catch {
              return "—";
            }
          })()
        : "—";
      return `<tr>
  <td>${escapeHtml(row.digestKey)}</td>
  <td>${escapeHtml(row.status)}</td>
  <td>${row.sentAt ? escapeHtml(row.sentAt.toISOString().slice(0, 19).replace("T", " ")) : "—"}</td>
  <td>${row.recipient ? escapeHtml(row.recipient) : "—"}</td>
  <td>${row.newAlertCount != null ? String(row.newAlertCount) : "—"}</td>
  <td class="muted" style="font-size:12px">${escapeHtml(sum)}</td>
  <td>${row.errorMessage ? `<span class="muted" style="font-size:12px">${escapeHtml(row.errorMessage.slice(0, 120))}${row.errorMessage.length > 120 ? "…" : ""}</span>` : "—"}</td>
</tr>`;
    })
    .join("");

  const flash =
    sentFlash && !errFlash
      ? '<p class="badge ok" style="display:inline-block;margin-bottom:12px">Digest run completed (check status below).</p>'
      : errFlash
        ? `<p class="badge alert" style="display:inline-block;margin-bottom:12px">${escapeHtml(errFlash)}</p>`
        : "";

  const content = `
<h2>Daily owner digest</h2>
<p class="muted">One email per calendar day (${tz}) after ${sendTime} when SMTP is set. Uses the same KPI and alert logic as the platform dashboard. Set <code>OWNER_DIGEST_ENABLED=false</code> to disable the scheduler.</p>
${flash}
<div class="grid-2" style="margin-bottom:14px;align-items:start">
  <section>
    <h3 style="margin-top:0">Schedule</h3>
    <table>
      <tbody>
        <tr><th>Scheduler</th><td>${enabled ? '<span class="badge ok">On</span>' : '<span class="badge pending">Off</span>'}</td></tr>
        <tr><th>Timezone</th><td>${escapeHtml(tz)}</td></tr>
        <tr><th>Send time</th><td>${escapeHtml(sendTime)}</td></tr>
        <tr><th>SMTP</th><td>${smtpOk ? '<span class="badge ok">Configured</span>' : '<span class="badge alert">Not configured</span> — digest is logged only.'}</td></tr>
        <tr><th>Recipient</th><td>${escapeHtml((process.env.OWNER_EMAIL ?? "owner@chatastay.local").trim())}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3 style="margin-top:0">Run now</h3>
    <form method="post" action="/owner/digest/send" style="margin:0">
      <label style="display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:10px">
        <input type="checkbox" name="force" value="1" /> Force resend even if today already sent
      </label>
      <button type="submit" style="padding:9px 14px;border:0;border-radius:8px;background:var(--brand);color:#fff;font-weight:700">Send digest now</button>
    </form>
    <p class="muted" style="font-size:12px;margin-top:10px">Manual runs set <code>manual</code> so a failed earlier attempt can retry the same day.</p>
  </section>
</div>

<h3>Recent digest log</h3>
<table>
  <thead><tr><th>Day (digest key)</th><th>Status</th><th>Sent at (UTC)</th><th>To</th><th>New alerts #</th><th>Summary</th><th>Error</th></tr></thead>
  <tbody>${logRows.length ? logRows : `<tr><td colspan="7" class="muted">No digest rows yet.</td></tr>`}</tbody>
</table>

<p class="muted" style="font-size:12px;margin-top:14px">
  Links in emails: <a href="/owner/dashboard">Dashboard</a> · <a href="/owner/alerts">Alerts</a>. Env: <code>OWNER_DIGEST_TZ</code>, <code>OWNER_DIGEST_TIME</code>, <code>APP_URL</code>, same SMTP vars as admin password reset.
</p>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.post("/digest/send", requireOwnerAuth, async (req, res) => {
  const force =
    req.body?.force === "1" || req.body?.force === "on" || req.body?.force === true || req.body?.force === "true";
  const result = await runOwnerDailyDigest({ manual: true, force });
  const params = new URLSearchParams();
  if (result.ok) params.set("sent", "1");
  else params.set("err", encodeURIComponent(result.message ?? result.status));
  res.redirect(`/owner/digest?${params.toString()}`);
});

ownerRouter.get("/hotels", requireOwnerAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const hotels = await prisma.hotel.findMany({
    where: q
      ? {
          OR: [{ displayName: { contains: q } }, { slug: { contains: q } }]
        }
      : undefined,
    include: {
      subscriptions: {
        where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 1
      },
      roomTypes: { where: { isActive: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  const rows = hotels
    .map((hotel) => {
      const activeSub = hotel.subscriptions[0];
      return `<tr>
      <td>${escapeHtml(hotel.displayName)}</td>
      <td>${escapeHtml(hotel.slug)}</td>
      <td>${hotel.isActive ? '<span class="badge ok">Active</span>' : '<span class="badge alert">Suspended</span>'}</td>
      <td>${activeSub ? `${escapeHtml(activeSub.plan.name)} (${escapeHtml(activeSub.status)})` : "-"}</td>
      <td>${hotel.roomTypes.length}</td>
      <td>${formatDate(hotel.createdAt)}</td>
      <td>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}">Open</a>
          <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/room-capacity">Room capacity</a>
          <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/whatsapp">WhatsApp Routing</a>
          <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/extranet">Open Extranet (Safe)</a>
          <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/impersonate">Read-only Extranet</a>
          <form method="post" action="/owner/hotels/${encodeURIComponent(hotel.id)}/toggle-active" style="margin:0">
            <button type="submit" style="padding:7px 10px; border:0; border-radius:8px; cursor:pointer; font-weight:700; background:${
              hotel.isActive ? "#fee2e2" : "#dcfce7"
            }; color:${hotel.isActive ? "#991b1b" : "#166534"}">${hotel.isActive ? "Suspend" : "Activate"}</button>
          </form>
        </div>
      </td>
      </tr>`;
    })
    .join("");

  const content = `
<h2>Hotels</h2>
<p class="muted">Manage all partner hotels, status, and subscriptions. Use <strong>Activate</strong> to reactivate a suspended hotel.</p>
<form method="get" action="/owner/hotels" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search by name or slug" style="min-width:260px; padding:9px; border:1px solid #d8dee6; border-radius:8px" />
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Search</button>
</form>
<table>
  <thead><tr><th>Hotel</th><th>Slug</th><th>Status</th><th>Plan</th><th>Active Room Types</th><th>Created</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No hotels found.</td></tr>'}</tbody>
</table>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.post("/hotels/:id/toggle-active", requireOwnerAuth, async (req, res) => {
  const hotelId = String(req.params.id ?? "");
  const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
  if (!hotel) {
    res.redirect("/owner/hotels");
    return;
  }
  await prisma.hotel.update({
    where: { id: hotel.id },
    data: { isActive: !hotel.isActive }
  });
  await logOwnerAudit({
    hotelId: hotel.id,
    action: hotel.isActive ? "HOTEL_SUSPENDED" : "HOTEL_ACTIVATED",
    entityType: "Hotel",
    entityId: hotel.id,
    metadata: { isActive: !hotel.isActive }
  });
  res.redirect("/owner/hotels");
});

ownerRouter.get("/hotels/:id/extranet", requireOwnerAuth, async (req, res) => {
  const hotelId = String(req.params.id ?? "");
  const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
  if (!hotel) {
    res.status(404).type("html").send(ownerLayout("<h2>Safe Extranet Mode</h2><p>Hotel not found.</p>", true));
    return;
  }

  const content = `
<h2>Safe Extranet Mode: ${escapeHtml(hotel.displayName)}</h2>
<p class="muted">Owner read-only scoped launchpad for partner pages. This mode does not expose write actions.</p>
<div class="actions">
  <a class="btn-link primary" href="/owner/hotels/${encodeURIComponent(hotel.id)}/impersonate">Open Read-only Snapshot</a>
  <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}">Back to Tenant Details</a>
</div>
<div class="grid-2">
  <section>
    <h3>Operational Views</h3>
    <table>
      <tbody>
        <tr><th>Rooms & Pricing</th><td><a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/impersonate#rooms">View</a></td></tr>
        <tr><th>Inventory</th><td><a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/impersonate#inventory">View</a></td></tr>
        <tr><th>Bookings</th><td><a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/impersonate#bookings">View</a></td></tr>
        <tr><th>Conversations</th><td><a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/impersonate#conversations">View</a></td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Scope Guard</h3>
    <table>
      <tbody>
        <tr><th>Hotel</th><td>${escapeHtml(hotel.displayName)}</td></tr>
        <tr><th>Mode</th><td><span class="badge pending">Read-only</span></td></tr>
        <tr><th>Writes</th><td>Blocked in this owner scope</td></tr>
        <tr><th>Purpose</th><td>Support, audit, QA</td></tr>
      </tbody>
    </table>
  </section>
</div>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.get("/hotels/:id/impersonate", requireOwnerAuth, async (req, res) => {
  const hotelId = String(req.params.id ?? "");
  const [hotel, roomTypes, inventories, bookings, conversations] = await Promise.all([
    prisma.hotel.findUnique({ where: { id: hotelId } }),
    prisma.roomType.findMany({ where: { hotelId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.inventory.findMany({
      where: { hotelId, date: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
      take: 100,
      orderBy: { date: "desc" }
    }),
    prisma.booking.findMany({
      where: { hotelId },
      take: 20,
      orderBy: { createdAt: "desc" },
      include: { guest: true, roomType: true }
    }),
    prisma.conversation.findMany({
      where: { hotelId },
      take: 20,
      orderBy: { lastMessageAt: "desc" },
      include: { guest: true }
    })
  ]);

  if (!hotel) {
    res.status(404).type("html").send(ownerLayout("<h2>Read-only Extranet</h2><p>Hotel not found.</p>", true));
    return;
  }

  const roomRows = roomTypes
    .map(
      (room) => `<tr>
      <td>${escapeHtml(room.name)}</td>
      <td>${room.capacity}</td>
      <td>${formatMoney(room.baseNightlyRate, hotel.currency)}</td>
      <td>${room.totalInventory}</td>
      </tr>`
    )
    .join("");
  const bookingRows = bookings
    .map(
      (booking) => `<tr>
      <td>${escapeHtml(booking.id)}</td>
      <td>${escapeHtml(booking.guest.fullName ?? booking.guest.phoneE164)}</td>
      <td>${escapeHtml(booking.roomType.name)}</td>
      <td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}</td>
      <td>${escapeHtml(booking.status)}</td>
      </tr>`
    )
    .join("");
  const convoRows = conversations
    .map(
      (conversation) => `<tr>
      <td>${escapeHtml(conversation.guest.fullName ?? conversation.guest.phoneE164)}</td>
      <td>${escapeHtml(conversation.state)}</td>
      <td>${formatDate(conversation.lastMessageAt ?? conversation.createdAt)}</td>
      </tr>`
    )
    .join("");
  const inventoryRows = inventories
    .slice(0, 20)
    .map(
      (item) => `<tr>
      <td>${formatDate(item.date)}</td>
      <td>${item.total}</td>
      <td>${item.reserved}</td>
      <td>${item.closedOut ? '<span class="badge alert">Closed</span>' : '<span class="badge ok">Open</span>'}</td>
      </tr>`
    )
    .join("");

  const content = `
<h2>Read-only Extranet: ${escapeHtml(hotel.displayName)}</h2>
<p class="muted">Owner impersonation view (read-only). No updates are allowed from this page.</p>
<div class="actions">
  <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}">Back to tenant details</a>
  <a class="btn-link primary" href="/owner/hotels">Back to hotels</a>
</div>
<div class="grid-4">
  <article class="stat"><h3>Active Room Types</h3><p>${roomTypes.length}</p></article>
  <article class="stat"><h3>Recent Bookings</h3><p>${bookings.length}</p></article>
  <article class="stat"><h3>Recent Conversations</h3><p>${conversations.length}</p></article>
  <article class="stat"><h3>Inventory Rows (Month)</h3><p>${inventories.length}</p></article>
</div>
<section id="rooms" style="margin-top:12px">
  <h3>Rooms Snapshot</h3>
  <table>
    <thead><tr><th>Room</th><th>Capacity</th><th>Rate</th><th>Inventory</th></tr></thead>
    <tbody>${roomRows || '<tr><td colspan="4">No active room types.</td></tr>'}</tbody>
  </table>
</section>
<section id="inventory" style="margin-top:12px">
  <h3>Inventory Snapshot</h3>
  <table>
    <thead><tr><th>Date</th><th>Total</th><th>Reserved</th><th>Status</th></tr></thead>
    <tbody>${inventoryRows || '<tr><td colspan="4">No inventory rows.</td></tr>'}</tbody>
  </table>
</section>
<div class="grid-2" style="margin-top:12px">
  <section id="bookings">
    <h3>Bookings Snapshot</h3>
    <table>
      <thead><tr><th>ID</th><th>Guest</th><th>Room</th><th>Stay</th><th>Status</th></tr></thead>
      <tbody>${bookingRows || '<tr><td colspan="5">No bookings.</td></tr>'}</tbody>
    </table>
  </section>
  <section id="conversations">
    <h3>Conversations Snapshot</h3>
    <table>
      <thead><tr><th>Guest</th><th>State</th><th>Last Activity</th></tr></thead>
      <tbody>${convoRows || '<tr><td colspan="3">No conversations.</td></tr>'}</tbody>
    </table>
  </section>
</div>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.get("/hotels/:id", requireOwnerAuth, async (req, res) => {
  const hotelId = String(req.params.id ?? "");
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    include: {
      roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } },
      bookings: { orderBy: { createdAt: "desc" }, take: 10, include: { guest: true, roomType: true } },
      conversations: { orderBy: { createdAt: "desc" }, take: 10 },
      subscriptions: {
        where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 1
      }
    }
  });

  if (!hotel) {
    res.status(404).type("html").send(ownerLayout("<h2>Hotel</h2><p>Hotel not found.</p>", true));
    return;
  }

  const sub = hotel.subscriptions[0];
  const bookingRows = hotel.bookings
    .map(
      (booking) => `<tr>
      <td>${escapeHtml(booking.id)}</td>
      <td>${escapeHtml(booking.guest.fullName ?? booking.guest.phoneE164)}</td>
      <td>${escapeHtml(booking.roomType.name)}</td>
      <td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}</td>
      <td>${formatMoney(booking.totalAmount, booking.currency)}</td>
      <td>${escapeHtml(booking.status)}</td>
      </tr>`
    )
    .join("");

  const content = `
<h2>${escapeHtml(hotel.displayName)}</h2>
<p class="muted">Tenant deep-dive for owner operations and support.</p>
<div class="actions">
  <a class="btn-link" href="/owner/hotels">Back to hotels</a>
  <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/whatsapp">WhatsApp Routing</a>
  <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}/room-capacity">Room capacity (totals)</a>
  <a class="btn-link primary" href="/admin/dashboard">Open partner extranet</a>
</div>
<div class="grid-2">
  <section>
    <h3>Tenant Profile</h3>
    <table>
      <tbody>
        <tr><th>Slug</th><td>${escapeHtml(hotel.slug)}</td></tr>
        <tr><th>Status</th><td>${hotel.isActive ? '<span class="badge ok">Active</span>' : '<span class="badge alert">Suspended</span>'}</td></tr>
        <tr><th>City</th><td>${escapeHtml(hotel.city ?? "-")}</td></tr>
        <tr><th>Currency</th><td>${escapeHtml(hotel.currency)}</td></tr>
        <tr><th>Created</th><td>${formatDate(hotel.createdAt)}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Plan & Usage</h3>
    <table>
      <tbody>
        <tr><th>Plan</th><td>${sub ? escapeHtml(sub.plan.name) : "-"}</td></tr>
        <tr><th>Status</th><td>${sub ? escapeHtml(sub.status) : "-"}</td></tr>
        <tr><th>Renewal</th><td>${sub ? formatDate(sub.currentPeriodEnd) : "-"}</td></tr>
        <tr><th>Active Room Types</th><td>${hotel.roomTypes.length}</td></tr>
        <tr><th>Recent Conversations</th><td>${hotel.conversations.length}</td></tr>
      </tbody>
    </table>
  </section>
</div>
<section style="margin-top:14px">
  <h3>Recent Bookings</h3>
  <table>
    <thead><tr><th>ID</th><th>Guest</th><th>Room</th><th>Stay</th><th>Total</th><th>Status</th></tr></thead>
    <tbody>${bookingRows || '<tr><td colspan="6">No bookings found.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.get("/hotels/:id/room-capacity", requireOwnerAuth, async (req, res) => {
  if (!canManageRoomCapacity(req)) {
    res
      .status(403)
      .type("html")
      .send(
        ownerLayout(
          '<h2>Access denied</h2><p>Only platform owner or platform admin can edit physical room totals.</p><p><a class="btn-link" href="/owner/hotels">Back to hotels</a></p>',
          true
        )
      );
    return;
  }
  const hotelId = String(req.params.id ?? "");
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    include: { roomTypes: { orderBy: { name: "asc" } } }
  });
  if (!hotel) {
    res.status(404).type("html").send(ownerLayout("<h2>Room capacity</h2><p>Hotel not found.</p>", true));
    return;
  }
  const saved = req.query.saved ? '<p class="badge ok">Physical room totals updated.</p>' : "";
  const rows = hotel.roomTypes
    .map(
      (rt) => `<tr>
      <td>${escapeHtml(rt.name)}</td>
      <td><code>${escapeHtml(rt.code)}</code></td>
      <td>${rt.isActive ? '<span class="badge ok">Active</span>' : '<span class="badge pending">Inactive</span>'}</td>
      <td>
        <input type="number" min="0" name="total_${escapeHtml(rt.id)}" value="${rt.totalInventory}" style="width:100px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </td>
    </tr>`
    )
    .join("");
  const content = `
<h2>Room capacity: ${escapeHtml(hotel.displayName)}</h2>
<p class="muted">Set the <strong>maximum number of sellable rooms</strong> per category (physical cap). Hotel admins cannot change these; they adjust daily bookable counts under <em>Room Availability</em> in the partner console (up to this cap).</p>
${saved}
<div class="actions">
  <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}">Back to hotel</a>
  <a class="btn-link primary" href="/owner/hotels">All hotels</a>
</div>
<form method="post" action="/owner/hotels/${encodeURIComponent(hotel.id)}/room-capacity" style="margin-top:12px">
  <table>
    <thead><tr><th>Room type</th><th>Code</th><th>Status</th><th>Total rooms (cap)</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No room types.</td></tr>'}</tbody>
  </table>
  <button type="submit" style="margin-top:12px; padding:10px 16px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Save totals</button>
</form>`;
  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.post("/hotels/:id/room-capacity", requireOwnerAuth, async (req, res) => {
  if (!canManageRoomCapacity(req)) {
    res.status(403).type("html").send(ownerLayout("<h2>Access denied</h2><p>Insufficient role.</p>", true));
    return;
  }
  const hotelId = String(req.params.id ?? "");
  const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
  if (!hotel) {
    res.redirect("/owner/hotels");
    return;
  }
  const actorEmail = getOwnerSessionEmail(req) ?? ownerActorEmail;
  const body = req.body as Record<string, unknown>;
  const roomTypes = await prisma.roomType.findMany({ where: { hotelId } });
  for (const rt of roomTypes) {
    const key = `total_${rt.id}`;
    if (body[key] === undefined) continue;
    const n = Math.max(0, parseInt(String(body[key]), 10) || 0);
    await prisma.roomType.update({ where: { id: rt.id }, data: { totalInventory: n } });
    const invs = await prisma.inventory.findMany({ where: { roomTypeId: rt.id, hotelId } });
    for (const inv of invs) {
      const nextTotal = Math.min(inv.total, n);
      const nextReserved = Math.min(inv.reserved, nextTotal);
      await prisma.inventory.update({
        where: { id: inv.id },
        data: { total: nextTotal, reserved: nextReserved }
      });
    }
    await logOwnerAudit({
      hotelId: hotel.id,
      action: "OWNER_ROOM_TYPE_TOTAL_SET",
      entityType: "RoomType",
      entityId: rt.id,
      metadata: { code: rt.code, totalInventory: n },
      actorEmail
    });
  }
  res.redirect(`/owner/hotels/${encodeURIComponent(hotelId)}/room-capacity?saved=1`);
});

ownerRouter.get("/hotels/:id/whatsapp", requireOwnerAuth, async (req, res) => {
  const hotelId = String(req.params.id ?? "");
  const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
  if (!hotel) {
    res.status(404).type("html").send(ownerLayout("<h2>WhatsApp Routing</h2><p>Hotel not found.</p>", true));
    return;
  }
  const config = loadPartnerSetupConfig(hotel.id);
  const updatedNotice = req.query.updated ? '<p><span class="badge ok">WhatsApp routing updated.</span></p>' : "";
  const content = `
<h2>WhatsApp Routing: ${escapeHtml(hotel.displayName)}</h2>
<p class="muted">Assign this hotel to its WhatsApp Cloud API phone number ID. Incoming webhooks will route follow-ups to this hotel.</p>
${updatedNotice}
<form method="post" action="/owner/hotels/${encodeURIComponent(hotel.id)}/whatsapp" style="max-width:520px; display:grid; gap:10px">
  <label>Hotel WhatsApp phone (display)
    <input type="text" name="whatsappPhone" value="${escapeHtml(hotel.whatsappPhone ?? "")}" placeholder="9689XXXXXXX" style="width:100%; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <label>WhatsApp Phone Number ID (Cloud API)
    <input type="text" name="whatsappPhoneNumberId" value="${escapeHtml(config.whatsappPhoneNumberId)}" placeholder="Meta WhatsApp → API setup → Phone number ID" required style="width:100%; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <button type="submit" style="padding:10px 14px; border:0; border-radius:10px; background:#0b6e6e; color:#fff; font-weight:700; cursor:pointer">Save Routing</button>
</form>
<div class="actions">
  <a class="btn-link" href="/owner/hotels/${encodeURIComponent(hotel.id)}">Back to hotel</a>
  <a class="btn-link primary" href="/owner/hotels">Back to list</a>
</div>`;
  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.post("/hotels/:id/whatsapp", requireOwnerAuth, async (req, res) => {
  const hotelId = String(req.params.id ?? "");
  const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
  if (!hotel) {
    res.redirect("/owner/hotels");
    return;
  }
  const whatsappPhone = String(req.body.whatsappPhone ?? "").trim();
  const whatsappPhoneNumberId = String(req.body.whatsappPhoneNumberId ?? "").trim();
  if (!whatsappPhoneNumberId) {
    res
      .status(400)
      .type("html")
      .send(ownerLayout("<h2>WhatsApp Routing</h2><p>Phone Number ID is required.</p><a class=\"btn-link\" href=\"/owner/hotels\">Back</a>", true));
    return;
  }

  await prisma.hotel.update({
    where: { id: hotel.id },
    data: { whatsappPhone: whatsappPhone || null }
  });
  const config = loadPartnerSetupConfig(hotel.id);
  savePartnerSetupConfig(
    {
      ...config,
      whatsappPhoneNumberId
    },
    hotel.id
  );
  await logOwnerAudit({
    hotelId: hotel.id,
    action: "HOTEL_WHATSAPP_ROUTING_UPDATED",
    entityType: "Hotel",
    entityId: hotel.id,
    metadata: { whatsappPhoneNumberId, whatsappPhone: whatsappPhone || null }
  });
  res.redirect(`/owner/hotels/${encodeURIComponent(hotel.id)}/whatsapp?updated=1`);
});

ownerRouter.get("/subscriptions", requireOwnerAuth, async (_req, res) => {
  const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { monthlyPrice: "asc" } });
  const subscriptions = await prisma.subscription.findMany({
    include: { hotel: true, plan: true },
    orderBy: { createdAt: "desc" }
  });

  const rows = subscriptions
    .map(
      (subscription) => {
        const isActiveOrTrialing =
          subscription.status === "ACTIVE" || subscription.status === "TRIALING";
        const badgeClass =
          subscription.status === "ACTIVE"
            ? "ok"
            : subscription.status === "PAST_DUE"
              ? "alert"
              : subscription.status === "CANCELED"
                ? "pending"
                : "pending";
        return `<tr>
      <td>${escapeHtml(subscription.hotel.displayName)}</td>
      <td>${escapeHtml(subscription.plan.name)}</td>
      <td>${formatMoney(subscription.plan.monthlyPrice, subscription.hotel.currency)}</td>
      <td><span class="badge ${badgeClass}">${escapeHtml(subscription.status)}</span></td>
      <td>${formatDate(subscription.currentPeriodEnd)}</td>
      <td>${escapeHtml(subscription.plan.code)}</td>
      <td>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
          <form method="post" action="/owner/subscriptions/${encodeURIComponent(subscription.id)}/set-status" style="margin:0">
            <input type="hidden" name="status" value="ACTIVE" />
            <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:#166534; color:#fff; font-weight:700; cursor:pointer" ${isActiveOrTrialing ? "disabled" : ""}>Enable</button>
          </form>
          <form method="post" action="/owner/subscriptions/${encodeURIComponent(subscription.id)}/set-status" style="margin:0">
            <input type="hidden" name="status" value="CANCELED" />
            <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:#991b1b; color:#fff; font-weight:700; cursor:pointer" ${!isActiveOrTrialing ? "disabled" : ""}>Disable</button>
          </form>
          <form method="post" action="/owner/subscriptions/${encodeURIComponent(subscription.id)}/update" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:0">
            <select name="planId" style="padding:6px; border:1px solid #d8dee6; border-radius:8px">
              ${plans
                .map(
                  (plan) =>
                    `<option value="${escapeHtml(plan.id)}" ${plan.id === subscription.planId ? "selected" : ""}>${escapeHtml(
                      plan.name
                    )}</option>`
                )
                .join("")}
            </select>
            <select name="status" style="padding:6px; border:1px solid #d8dee6; border-radius:8px">
              <option value="TRIALING" ${subscription.status === "TRIALING" ? "selected" : ""}>TRIALING</option>
              <option value="ACTIVE" ${subscription.status === "ACTIVE" ? "selected" : ""}>ACTIVE</option>
              <option value="PAST_DUE" ${subscription.status === "PAST_DUE" ? "selected" : ""}>PAST_DUE</option>
              <option value="CANCELED" ${subscription.status === "CANCELED" ? "selected" : ""}>CANCELED</option>
            </select>
            <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700; cursor:pointer">Save</button>
          </form>
        </div>
      </td>
      </tr>`;
      }
    )
    .join("");

  const content = `
<h2>Subscriptions</h2>
<p class="muted">Enable or disable subscriptions per hotel; reactivate canceled subscriptions. Suspended hotels can be reactivated from <a class="inline-link" href="/owner/hotels">Hotels</a> (Activate button).</p>
<table>
  <thead><tr><th>Hotel</th><th>Plan</th><th>Monthly Price</th><th>Status</th><th>Renewal</th><th>Plan Code</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No subscriptions found.</td></tr>'}</tbody>
</table>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.post("/subscriptions/:id/set-status", requireOwnerAuth, async (req, res) => {
  const subscriptionId = String(req.params.id ?? "");
  const status = String(req.body.status ?? "").toUpperCase();
  if (status !== "ACTIVE" && status !== "CANCELED") {
    res.redirect("/owner/subscriptions");
    return;
  }
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { hotel: true, plan: true }
  });
  if (!subscription) {
    res.redirect("/owner/subscriptions");
    return;
  }
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: status as SubscriptionStatus }
  });
  await logOwnerAudit({
    hotelId: subscription.hotelId,
    action: status === "ACTIVE" ? "SUBSCRIPTION_ENABLED_BY_OWNER" : "SUBSCRIPTION_DISABLED_BY_OWNER",
    entityType: "Subscription",
    entityId: subscription.id,
    metadata: { newStatus: status }
  });
  res.redirect("/owner/subscriptions");
});

ownerRouter.post("/subscriptions/:id/update", requireOwnerAuth, async (req, res) => {
  const subscriptionId = String(req.params.id ?? "");
  const planId = String(req.body.planId ?? "");
  const status = String(req.body.status ?? "");

  const allowedStatuses: SubscriptionStatus[] = [
    SubscriptionStatus.TRIALING,
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELED
  ];
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { hotel: true, plan: true }
  });
  if (!subscription) {
    res.redirect("/owner/subscriptions");
    return;
  }
  const plan = await prisma.plan.findUnique({ where: { id: planId } });

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      planId: plan ? plan.id : subscription.planId,
      status: allowedStatuses.includes(status as SubscriptionStatus)
        ? (status as SubscriptionStatus)
        : subscription.status
    }
  });
  await logOwnerAudit({
    hotelId: subscription.hotelId,
    action: "SUBSCRIPTION_UPDATED_BY_OWNER",
    entityType: "Subscription",
    entityId: subscription.id,
    metadata: {
      previousPlan: subscription.plan.code,
      nextPlan: plan?.code ?? subscription.plan.code,
      requestedStatus: status
    }
  });
  res.redirect("/owner/subscriptions");
});

ownerRouter.get("/users", requireOwnerAuth, (_req, res) => {
  const users = loadOwnerUsers();
  const rows = users
    .map(
      (user) => `<tr>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${user.isActive ? '<span class="badge ok">Active</span>' : '<span class="badge alert">Disabled</span>'}</td>
      <td>${
        user.twoFactorEnabled
          ? '<span class="badge ok">Enabled</span>'
          : user.pendingTwoFactorSecret
            ? '<span class="badge pending">Pending Setup</span>'
            : '<span class="badge pending">Optional</span>'
      }</td>
      <td>${user.requirePasswordReset ? '<span class="badge pending">Required</span>' : '<span class="badge ok">No</span>'}</td>
      <td>${user.lockedUntil && user.lockedUntil > Date.now() ? '<span class="badge alert">Locked</span>' : '<span class="badge ok">Open</span>'}</td>
      <td>
        <form method="post" action="/owner/users/${encodeURIComponent(user.email)}/toggle" style="display:inline">
          <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; font-weight:700; cursor:pointer; background:${
            user.isActive ? "#fee2e2" : "#dcfce7"
          }; color:${user.isActive ? "#991b1b" : "#166534"}">${user.isActive ? "Disable" : "Enable"}</button>
        </form>
        <form method="post" action="/owner/users/${encodeURIComponent(user.email)}/toggle-2fa" style="display:inline; margin-left:6px">
          <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; font-weight:700; cursor:pointer; background:#e0f2fe; color:#075985">${
            user.twoFactorEnabled ? "Disable 2FA" : "Setup 2FA"
          }</button>
        </form>
        <form method="post" action="/owner/users/${encodeURIComponent(user.email)}/force-reset" style="display:inline; margin-left:6px">
          <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; font-weight:700; cursor:pointer; background:#fef9c3; color:#854d0e">Force Reset</button>
        </form>
        <form method="post" action="/owner/users/${encodeURIComponent(user.email)}/unlock" style="display:inline; margin-left:6px">
          <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; font-weight:700; cursor:pointer; background:#ede9fe; color:#5b21b6">Unlock</button>
        </form>
      </td>
      </tr>`
    )
    .join("");

  const content = `
<h2>Owner Users</h2>
<p class="muted">Manage additional owner/support users with lockout, reset and 2FA controls.</p>
<form method="post" action="/owner/users" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <input type="email" name="email" required placeholder="user@chatastay.local" style="padding:8px; border:1px solid #d8dee6; border-radius:8px; min-width:220px" />
  <input type="text" name="password" required placeholder="Password" style="padding:8px; border:1px solid #d8dee6; border-radius:8px; min-width:180px" />
  <select name="role" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
    <option value="OWNER">OWNER</option>
    <option value="PLATFORM_ADMIN">PLATFORM_ADMIN</option>
    <option value="SUPPORT">SUPPORT</option>
  </select>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Add User</button>
</form>
<table>
  <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Force Reset</th><th>Lock</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No owner users configured.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.post("/users", requireOwnerAuth, (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "").trim();
  const roleRaw = String(req.body.role ?? "SUPPORT");
  const role: OwnerUser["role"] =
    roleRaw === "OWNER" || roleRaw === "PLATFORM_ADMIN" || roleRaw === "SUPPORT" ? roleRaw : "SUPPORT";

  if (!email || !password) {
    res.redirect("/owner/users");
    return;
  }

  const users = loadOwnerUsers();
  const exists = users.some((user) => user.email === email);
  if (!exists) {
    users.push({
      email,
      passwordHash: hashPassword(password),
      role,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      requirePasswordReset: false,
      twoFactorEnabled: false,
      twoFactorSecret: null,
      pendingTwoFactorSecret: null
    });
    saveOwnerUsers(users);
  }
  res.redirect("/owner/users");
});

ownerRouter.post("/users/:email/toggle", requireOwnerAuth, (req, res) => {
  const email = decodeURIComponent(String(req.params.email ?? "")).trim().toLowerCase();
  const users = loadOwnerUsers();
  const next = users.map((user) => (user.email === email ? { ...user, isActive: !user.isActive } : user));
  saveOwnerUsers(next);
  res.redirect("/owner/users");
});

ownerRouter.post("/users/:email/toggle-2fa", requireOwnerAuth, (req, res) => {
  const email = decodeURIComponent(String(req.params.email ?? "")).trim().toLowerCase();
  const users = loadOwnerUsers();
  const idx = users.findIndex((user) => user.email === email);
  if (idx === -1) {
    res.redirect("/owner/users");
    return;
  }
  const user = users[idx];
  if (user.twoFactorEnabled) {
    users[idx] = {
      ...user,
      twoFactorEnabled: false,
      twoFactorSecret: null,
      pendingTwoFactorSecret: null
    };
    saveOwnerUsers(users);
    res.redirect("/owner/users");
    return;
  }

  users[idx] = {
    ...user,
    pendingTwoFactorSecret: generateTotpSecret()
  };
  saveOwnerUsers(users);
  res.redirect(`/owner/users/${encodeURIComponent(email)}/2fa/setup`);
});

ownerRouter.get("/users/:email/2fa/setup", requireOwnerAuth, (req, res) => {
  const email = decodeURIComponent(String(req.params.email ?? "")).trim().toLowerCase();
  const users = loadOwnerUsers();
  const user = users.find((item) => item.email === email);
  if (!user || !user.pendingTwoFactorSecret) {
    res.redirect("/owner/users");
    return;
  }
  const secret = user.pendingTwoFactorSecret;
  const uri = getTotpProvisioningUri(email, secret);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(uri)}`;

  const content = `
<h2>Setup TOTP for ${escapeHtml(email)}</h2>
<p class="muted">Scan QR code with authenticator app, then verify using a current 6-digit code.</p>
<div class="grid-2">
  <section>
    <h3>Provisioning</h3>
    <p><strong>Secret</strong>: <code>${escapeHtml(secret)}</code></p>
    <p><strong>URI</strong>: <code style="word-break:break-all">${escapeHtml(uri)}</code></p>
    <p class="muted">If QR fails, enter secret manually in your app.</p>
  </section>
  <section>
    <h3>QR</h3>
    <img src="${qrUrl}" alt="TOTP QR" width="180" height="180" style="border:1px solid #d8dee6; border-radius:8px; padding:6px; background:#fff" />
  </section>
</div>
<form method="post" action="/owner/users/${encodeURIComponent(email)}/2fa/verify-setup" style="max-width:420px; margin-top:12px">
  <label for="code">Verification code</label><br />
  <input id="code" name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" style="width:100%; padding:10px; margin-top:6px; margin-bottom:12px; border:1px solid #d8dee6; border-radius:10px" />
  <button type="submit" style="width:100%; padding:10px 14px; border:0; border-radius:10px; background:#25d366; color:#083d2d; font-weight:700">Enable TOTP 2FA</button>
</form>
<div class="actions"><a class="btn-link" href="/owner/users">Back to Users</a></div>`;
  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.post("/users/:email/2fa/verify-setup", requireOwnerAuth, (req, res) => {
  const email = decodeURIComponent(String(req.params.email ?? "")).trim().toLowerCase();
  const code = String(req.body.code ?? "").trim();
  const users = loadOwnerUsers();
  const idx = users.findIndex((item) => item.email === email);
  if (idx === -1) {
    res.redirect("/owner/users");
    return;
  }
  const user = users[idx];
  if (!user.pendingTwoFactorSecret || !verifyTotpCode(user.pendingTwoFactorSecret, code)) {
    res
      .status(400)
      .type("html")
      .send(ownerLayout("<h2>2FA Setup</h2><p>Invalid code. Please retry setup.</p><a class=\"btn-link\" href=\"/owner/users\">Back</a>", true));
    return;
  }

  users[idx] = {
    ...user,
    twoFactorEnabled: true,
    twoFactorSecret: user.pendingTwoFactorSecret,
    pendingTwoFactorSecret: null
  };
  saveOwnerUsers(users);
  res.redirect("/owner/users");
});

ownerRouter.post("/users/:email/force-reset", requireOwnerAuth, (req, res) => {
  const email = decodeURIComponent(String(req.params.email ?? "")).trim().toLowerCase();
  const users = loadOwnerUsers();
  const next = users.map((user) =>
    user.email === email ? { ...user, requirePasswordReset: true, failedAttempts: 0, lockedUntil: null } : user
  );
  saveOwnerUsers(next);
  res.redirect("/owner/users");
});

ownerRouter.post("/users/:email/unlock", requireOwnerAuth, (req, res) => {
  const email = decodeURIComponent(String(req.params.email ?? "")).trim().toLowerCase();
  const users = loadOwnerUsers();
  const next = users.map((user) =>
    user.email === email ? { ...user, failedAttempts: 0, lockedUntil: null } : user
  );
  saveOwnerUsers(next);
  res.redirect("/owner/users");
});

ownerRouter.get("/billing", requireOwnerAuth, async (req, res) => {
  const hotelId = typeof req.query.hotelId === "string" ? req.query.hotelId : "";
  const statusRaw = typeof req.query.status === "string" ? req.query.status : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const parsedStatus = parseInvoiceStatus(statusRaw || undefined);
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  const where: {
    hotelId?: string;
    status?: InvoiceStatus;
    createdAt?: { gte?: Date; lte?: Date };
  } = {};
  if (hotelId) where.hotelId = hotelId;
  if (parsedStatus) where.status = parsedStatus;
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate && !Number.isNaN(fromDate.getTime())) where.createdAt.gte = fromDate;
    if (toDate && !Number.isNaN(toDate.getTime())) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const [invoices, hotels] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { hotel: true, subscription: { include: { plan: true } } },
      orderBy: { createdAt: "desc" },
      take: 200
    }),
    prisma.hotel.findMany({ orderBy: { displayName: "asc" } })
  ]);

  const totalAmount = invoices.reduce((sum, invoice) => sum + invoice.amountTotal, 0);
  const rows = invoices
    .map(
      (invoice) => `<tr>
      <td>${escapeHtml(invoice.id)}</td>
      <td>${escapeHtml(invoice.hotel.displayName)}</td>
      <td>${invoice.subscription?.plan ? escapeHtml(invoice.subscription.plan.name) : "-"}</td>
      <td>${formatMoney(invoice.amountTotal, invoice.currency)}</td>
      <td><span class="badge ${
        invoice.status === "PAID" ? "ok" : invoice.status === "OPEN" ? "pending" : "alert"
      }">${escapeHtml(invoice.status)}</span></td>
      <td>${formatDate(invoice.createdAt)}</td>
      <td>
        <div style="display:flex; gap:6px; flex-wrap:wrap">
          <form method="post" action="/owner/invoices/${encodeURIComponent(invoice.id)}/mark-paid" style="margin:0">
            <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:#dcfce7; color:#166534; font-weight:700">Mark Paid</button>
          </form>
          <form method="post" action="/owner/invoices/${encodeURIComponent(invoice.id)}/mark-past-due" style="margin:0">
            <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:#fee2e2; color:#991b1b; font-weight:700">Mark Past Due</button>
          </form>
        </div>
      </td>
      </tr>`
    )
    .join("");
  const hotelOptions = hotels
    .map(
      (hotel) =>
        `<option value="${escapeHtml(hotel.id)}" ${hotel.id === hotelId ? "selected" : ""}>${escapeHtml(
          hotel.displayName
        )}</option>`
    )
    .join("");

  const content = `
<h2>Billing Actions</h2>
<p class="muted">Owner-level billing control to mark invoices paid or move tenants to past due.</p>
<form method="get" action="/owner/billing" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Hotel
    <select name="hotelId" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="">All hotels</option>
      ${hotelOptions}
    </select>
  </label>
  <label>Status
    <select name="status" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="" ${statusRaw ? "" : "selected"}>All</option>
      <option value="DRAFT" ${statusRaw === "DRAFT" ? "selected" : ""}>DRAFT</option>
      <option value="OPEN" ${statusRaw === "OPEN" ? "selected" : ""}>OPEN</option>
      <option value="PAID" ${statusRaw === "PAID" ? "selected" : ""}>PAID</option>
      <option value="VOID" ${statusRaw === "VOID" ? "selected" : ""}>VOID</option>
      <option value="UNCOLLECTIBLE" ${statusRaw === "UNCOLLECTIBLE" ? "selected" : ""}>UNCOLLECTIBLE</option>
    </select>
  </label>
  <label>From <input type="date" name="from" value="${escapeHtml(from)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>To <input type="date" name="to" value="${escapeHtml(to)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Apply</button>
  <a class="btn-link" href="/owner/billing/export.csv?hotelId=${encodeURIComponent(hotelId)}&status=${encodeURIComponent(
    statusRaw
  )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}">Export CSV</a>
</form>
<div class="grid-4" style="margin-bottom:12px">
  <article class="stat"><h3>Invoices</h3><p>${invoices.length}</p></article>
  <article class="stat"><h3>Total Amount</h3><p>${formatMoney(totalAmount, "OMR")}</p></article>
  <article class="stat"><h3>Open</h3><p>${invoices.filter((i) => i.status === "OPEN").length}</p></article>
  <article class="stat"><h3>Paid</h3><p>${invoices.filter((i) => i.status === "PAID").length}</p></article>
</div>
<table>
  <thead><tr><th>Invoice</th><th>Hotel</th><th>Plan</th><th>Amount</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No invoices found.</td></tr>'}</tbody>
</table>`;

  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.get("/billing/export.csv", requireOwnerAuth, async (req, res) => {
  const hotelId = typeof req.query.hotelId === "string" ? req.query.hotelId : "";
  const statusRaw = typeof req.query.status === "string" ? req.query.status : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const parsedStatus = parseInvoiceStatus(statusRaw || undefined);
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  const where: {
    hotelId?: string;
    status?: InvoiceStatus;
    createdAt?: { gte?: Date; lte?: Date };
  } = {};
  if (hotelId) where.hotelId = hotelId;
  if (parsedStatus) where.status = parsedStatus;
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate && !Number.isNaN(fromDate.getTime())) where.createdAt.gte = fromDate;
    if (toDate && !Number.isNaN(toDate.getTime())) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const invoices = await prisma.invoice.findMany({
    where,
    include: { hotel: true, subscription: { include: { plan: true } } },
    orderBy: { createdAt: "desc" }
  });
  const header = ["invoice_id", "hotel", "plan", "amount_total", "currency", "status", "created_at", "paid_at"];
  const lines = invoices.map((invoice) =>
    [
      toCsvCell(invoice.id),
      toCsvCell(invoice.hotel.displayName),
      toCsvCell(invoice.subscription?.plan?.name ?? ""),
      toCsvCell(String(invoice.amountTotal)),
      toCsvCell(invoice.currency),
      toCsvCell(invoice.status),
      toCsvCell(invoice.createdAt.toISOString()),
      toCsvCell(invoice.paidAt ? invoice.paidAt.toISOString() : "")
    ].join(",")
  );

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="chatastay-owner-billing.csv"');
  res.send([header.join(","), ...lines].join("\n"));
});

ownerRouter.post("/invoices/:id/mark-paid", requireOwnerAuth, async (req, res) => {
  const invoiceId = String(req.params.id ?? "");
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) {
    res.redirect("/owner/billing");
    return;
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "PAID", paidAt: new Date() }
  });
  if (invoice.subscriptionId) {
    await prisma.subscription.updateMany({
      where: { id: invoice.subscriptionId },
      data: { status: "ACTIVE" }
    });
  }
  await logOwnerAudit({
    hotelId: invoice.hotelId,
    action: "INVOICE_MARKED_PAID_BY_OWNER",
    entityType: "Invoice",
    entityId: invoice.id
  });
  res.redirect("/owner/billing");
});

ownerRouter.post("/invoices/:id/mark-past-due", requireOwnerAuth, async (req, res) => {
  const invoiceId = String(req.params.id ?? "");
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) {
    res.redirect("/owner/billing");
    return;
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "OPEN", paidAt: null }
  });
  if (invoice.subscriptionId) {
    await prisma.subscription.updateMany({
      where: { id: invoice.subscriptionId },
      data: { status: "PAST_DUE" }
    });
  }
  await logOwnerAudit({
    hotelId: invoice.hotelId,
    action: "INVOICE_MARKED_PAST_DUE_BY_OWNER",
    entityType: "Invoice",
    entityId: invoice.id
  });
  res.redirect("/owner/billing");
});

ownerRouter.get("/routing-health", requireOwnerAuth, async (req, res) => {
  const hours = Math.max(1, Math.min(168, Math.trunc(Number(req.query.hours ?? 24) || 24)));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const hotels = await prisma.hotel.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, displayName: true, whatsappPhone: true }
  });

  const rows = await Promise.all(
    hotels.map(async (hotel) => {
      const [inbound, outbound, openSessions, draftCount] = await Promise.all([
        prisma.message.count({ where: { hotelId: hotel.id, direction: MessageDirection.INBOUND, createdAt: { gte: since } } }),
        prisma.message.count({ where: { hotelId: hotel.id, direction: MessageDirection.OUTBOUND, createdAt: { gte: since } } }),
        prisma.conversationSession.count({ where: { hotelId: hotel.id, expiresAt: { gt: new Date() } } }),
        prisma.bookingDraft.count({ where: { hotelId: hotel.id, status: "OPEN" } })
      ]);
      const ratio = inbound ? (outbound / inbound) * 100 : 0;
      return `<tr>
      <td>${escapeHtml(hotel.displayName)}</td>
      <td>${inbound}</td>
      <td>${outbound}</td>
      <td>${ratio.toFixed(1)}%</td>
      <td>${openSessions}</td>
      <td>${draftCount}</td>
      <td>${hotel.whatsappPhone ? '<span class="badge ok">Configured</span>' : '<span class="badge pending">Missing</span>'}</td>
      </tr>`;
    })
  );

  const content = `
<h2>Routing Health (Multi-hotel)</h2>
<p class="muted">Cross-hotel no-reply diagnostics and WhatsApp routing readiness.</p>
<form method="get" action="/owner/routing-health" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Range (hours)
    <input type="number" min="1" max="168" name="hours" value="${hours}" style="width:110px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
  </label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Apply</button>
</form>
<table>
  <thead><tr><th>Hotel</th><th>Inbound</th><th>Outbound</th><th>Reply Ratio</th><th>Open Sessions</th><th>Open Drafts</th><th>WhatsApp Phone</th></tr></thead>
  <tbody>${rows.join("") || '<tr><td colspan="7">No hotels found.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(ownerLayout(content, true));
});

ownerRouter.get("/health", requireOwnerAuth, async (_req, res) => {
  const [failedSync, queuedSync, pendingPayments, recentAudit] = await Promise.all([
    prisma.syncJob.count({ where: { status: "FAILED" } }),
    prisma.syncJob.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.paymentIntent.count({ where: { status: { in: ["PENDING", "REQUIRES_ACTION"] } } }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { hotel: true }
    })
  ]);

  const auditRows = recentAudit
    .map(
      (item) => `<tr>
      <td>${formatDate(item.createdAt)}</td>
      <td>${escapeHtml(item.hotel.displayName)}</td>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.entityType)}</td>
      <td>${escapeHtml(item.actorEmail ?? "-")}</td>
      </tr>`
    )
    .join("");

  const configChecks = [
    { label: "WHATSAPP_TOKEN", ok: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_TOKEN !== "PASTE_META_TEMP_ACCESS_TOKEN") },
    { label: "WHATSAPP_PHONE_NUMBER_ID", ok: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_PHONE_NUMBER_ID !== "PASTE_WHATSAPP_PHONE_NUMBER_ID") },
    { label: "WHATSAPP_VERIFY_TOKEN", ok: Boolean(process.env.WHATSAPP_VERIFY_TOKEN) },
    { label: "STRIPE_SECRET_KEY", ok: Boolean(process.env.STRIPE_SECRET_KEY) }
  ];
  const configRows = configChecks
    .map(
      (check) => `<tr>
      <td>${check.label}</td>
      <td>${check.ok ? '<span class="badge ok">Configured</span>' : '<span class="badge pending">Missing</span>'}</td>
      </tr>`
    )
    .join("");

  const content = `
<h2>System Health</h2>
<p class="muted">Platform-level diagnostics, queue status, and operational audit trail.</p>
<div class="grid-4">
  <article class="stat"><h3>Failed Sync Jobs</h3><p>${failedSync}</p></article>
  <article class="stat"><h3>Queued/Running Sync Jobs</h3><p>${queuedSync}</p></article>
  <article class="stat"><h3>Pending Payments</h3><p>${pendingPayments}</p></article>
  <article class="stat"><h3>Audit Events Shown</h3><p>${recentAudit.length}</p></article>
</div>
<div class="grid-2" style="margin-top:12px">
  <section>
    <h3>Config Checks</h3>
    <table>
      <thead><tr><th>Config</th><th>Status</th></tr></thead>
      <tbody>${configRows}</tbody>
    </table>
  </section>
  <section>
    <h3>Recent Audit Trail</h3>
    <table>
      <thead><tr><th>Date</th><th>Hotel</th><th>Action</th><th>Entity</th><th>Actor</th></tr></thead>
      <tbody>${auditRows || '<tr><td colspan="5">No audit logs yet.</td></tr>'}</tbody>
    </table>
  </section>
</div>`;

  res.type("html").send(ownerLayout(content, true));
});
