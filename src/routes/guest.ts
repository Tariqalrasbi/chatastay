import { Router } from "express";
import crypto from "node:crypto";
import { ChannelProvider, GuestFeedbackStatus, PaymentStatus, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { findAvailableRoomType, findAvailableRoomTypes, getDayAvailability, toIsoDate } from "../core/availability";
import { createBookingPaymentLink } from "../core/bookingPayments";
import { createConfirmedBookingAtomic } from "../core/bookingService";
import {
  computeMealPlanSurchargeForStay,
  getMealPlanUnitRate,
  loadFrontDeskPricing,
  type MealPlanCode
} from "../core/frontDeskPricing";
import { formatHotelOfferDetails, readActiveHotelOffers } from "../core/hotelOffers";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { markCalendarSessionUsed, resolveCalendarSession, saveConversationSession, upsertBookingDraft } from "../core/sessionStore";
import { hashPassword, verifyPassword } from "../core/authSecurity";
import {
  consumeTravellerPasswordReset,
  isTravellerEmailVerified,
  isTravellerVerificationResendRateLimited,
  issueTravellerVerificationEmail,
  requestTravellerPasswordReset,
  travellerPasswordResetTokenValid,
  travellerRequireEmailVerification,
  verifyTravellerEmailOtp,
  verifyTravellerEmailToken
} from "../core/travellerAuth";
import { isEmailConfigured } from "../core/email";
import {
  issueTravellerEmailOtpForPreRegistration,
  readPreRegistrationVerifiedEmail,
  signPreRegistrationVerifiedEmail,
  verifyTravellerEmailOtpForPreRegistration
} from "../core/travellerEmailOtp";
import { parseGuestPhone, parseGuestPhoneFromFormFields, toWhatsAppDigits } from "../core/phoneNumber";
import { sendWhatsAppButtons, sendWhatsAppText } from "../whatsapp/send";

export const guestRouter = Router();

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizePhone(input: string, defaultCountryIso = "OM"): string {
  const parsed = parseGuestPhone(input, defaultCountryIso);
  if (parsed.phoneE164) return parsed.phoneE164;
  const digits = toWhatsAppDigits(input);
  return digits ? `+${digits}` : "";
}

function formatDate(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function addDays(input: Date, days: number): Date {
  const next = new Date(input);
  next.setDate(next.getDate() + days);
  return next;
}

const defaultHotelSlug = process.env.DEFAULT_HOTEL_SLUG ?? "al-ashkhara-beach-resort";
const travellerCookieName = "chatastay_traveller_session";
const travellerEmailVerifiedCookieName = "chatastay_traveller_email_verified";
const travellerSessionSecret = process.env.TRAVELLER_SESSION_SECRET ?? process.env.ADMIN_SESSION_SECRET ?? "dev-traveller-secret";

function signTravellerSession(accountId: string): string {
  const payload = `${accountId}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", travellerSessionSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyTravellerSession(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", travellerSessionSecret).update(payload).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts[2], "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return parts[0] || null;
}

function readCookie(req: { headers: { cookie?: string } }, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  return raw
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function getTravellerAccount(req: { headers: { cookie?: string } }) {
  const accountId = verifyTravellerSession(readCookie(req, travellerCookieName));
  if (!accountId) return null;
  return prisma.travellerAccount.findFirst({
    where: { id: accountId, isActive: true },
    include: { guest: true }
  });
}

function setTravellerCookie(res: { setHeader(name: string, value: string): void }, accountId: string): void {
  res.setHeader(
    "Set-Cookie",
    `${travellerCookieName}=${signTravellerSession(accountId)}; HttpOnly; Path=/guest; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`
  );
}

function clearTravellerCookie(res: { setHeader(name: string, value: string): void }): void {
  res.setHeader(
    "Set-Cookie",
    `${travellerCookieName}=; HttpOnly; Path=/guest; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`
  );
}

function setPreRegistrationVerifiedEmailCookie(
  res: { setHeader(name: string, value: string): void },
  email: string
): void {
  res.setHeader(
    "Set-Cookie",
    `${travellerEmailVerifiedCookieName}=${signPreRegistrationVerifiedEmail(email)}; HttpOnly; Path=/guest; Max-Age=${30 * 60}; SameSite=Lax`
  );
}

function readPreRegistrationVerifiedEmailFromRequest(req: { headers: { cookie?: string } }): string | null {
  return readPreRegistrationVerifiedEmail(readCookie(req, travellerEmailVerifiedCookieName));
}

function getRequestIp(req: { headers: Record<string, string | string[] | undefined>; ip?: string }): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (typeof raw === "string" ? raw.split(",")[0]?.trim() : undefined) || req.ip || "unknown";
}

function otpIssueNoticeHtml(result: { sent: boolean; reason?: string }): string {
  if (result.sent) return `<p class="badge ok">Verification code sent. Check your inbox and spam folder.</p>`;
  if (result.reason === "email_not_configured") {
    return `<p class="badge alert">Email is not configured on this server. Contact support.</p>`;
  }
  if (result.reason === "rate_limited") {
    return `<p class="badge alert">Too many requests. Please wait a few minutes and try again.</p>`;
  }
  if (result.reason === "not_eligible") {
    return `<p class="badge alert">This email already has an account. <a href="/guest/account/login">Sign in</a> instead.</p>`;
  }
  return `<p class="badge alert">Could not send the verification code. Please try again.</p>`;
}

function otpVerifyErrorHtml(reason?: string): string {
  if (reason === "expired") return "This code has expired. Request a new one.";
  if (reason === "too_many_attempts") return "Too many incorrect attempts. Request a new code.";
  if (reason === "missing") return "Enter the 6-digit code from your email.";
  if (reason === "rate_limited") return "Too many requests. Please wait a few minutes and try again.";
  if (reason === "send_failed") return "Could not send a verification code. Try resend in a moment.";
  return "That code is incorrect. Please try again.";
}

function normalizeMealPlan(raw: unknown): MealPlanCode {
  const value = String(raw ?? "NONE").toUpperCase();
  return value === "BREAKFAST" || value === "HALF_BOARD" || value === "FULL_BOARD" ? value : "NONE";
}

function parseIntSafe(raw: unknown, fallback: number, min: number, max: number): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function monthStartFromRaw(raw: string | undefined): Date {
  if (!raw) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const parsed = new Date(`${raw}-01T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return new Date(next.getFullYear(), next.getMonth(), 1);
}

function formatMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function normalizeEmail(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

function redirectToTravellerLogin(res: { redirect(url: string): void }, next: string = "/guest/trips"): void {
  res.redirect(`/guest/account/login?next=${encodeURIComponent(next)}`);
}

function redirectToVerifyPending(
  res: { redirect(url: string): void },
  email: string,
  opts?: { sent?: boolean }
): void {
  const params = new URLSearchParams({ email });
  if (opts?.sent) params.set("sent", "1");
  res.redirect(`/guest/account/verify-pending?${params.toString()}`);
}

async function requireVerifiedTraveller(
  req: { headers: { cookie?: string } },
  res: { redirect(url: string): void }
): Promise<Awaited<ReturnType<typeof getTravellerAccount>>> {
  const account = await getTravellerAccount(req);
  if (!account) return null;
  if (travellerRequireEmailVerification() && !isTravellerEmailVerified(account)) {
    redirectToVerifyPending(res, account.email);
    return null;
  }
  return account;
}

const PHONE_COUNTRY_OPTIONS: Array<{ iso: string; label: string; code: string }> = [
  { iso: "OM", label: "Oman (+968)", code: "+968" },
  { iso: "AE", label: "UAE (+971)", code: "+971" },
  { iso: "SA", label: "Saudi Arabia (+966)", code: "+966" },
  { iso: "KW", label: "Kuwait (+965)", code: "+965" },
  { iso: "BH", label: "Bahrain (+973)", code: "+973" },
  { iso: "QA", label: "Qatar (+974)", code: "+974" },
  { iso: "GB", label: "United Kingdom (+44)", code: "+44" },
  { iso: "US", label: "United States (+1)", code: "+1" },
  { iso: "IN", label: "India (+91)", code: "+91" },
  { iso: "EG", label: "Egypt (+20)", code: "+20" }
];

function phoneCountrySelectHtml(selectedIso = "OM"): string {
  return [...PHONE_COUNTRY_OPTIONS]
    .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }))
    .map(
      (c) =>
        `<option value="${escapeHtml(c.iso)}" data-code="${escapeHtml(c.code)}"${c.iso === selectedIso ? " selected" : ""}>${escapeHtml(c.label)}</option>`
    )
    .join("");
}

const NATIONALITY_OPTIONS = [
  "Oman",
  "United Arab Emirates",
  "Saudi Arabia",
  "Kuwait",
  "Bahrain",
  "Qatar",
  "United Kingdom",
  "United States",
  "India",
  "Egypt",
  "Other"
];

function nationalitySelectHtml(selected = ""): string {
  const sorted = [...NATIONALITY_OPTIONS]
    .filter((n) => n !== "Other")
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  if (NATIONALITY_OPTIONS.includes("Other")) sorted.push("Other");
  const opts = sorted
    .map((n) => `<option value="${escapeHtml(n)}"${n === selected ? " selected" : ""}>${escapeHtml(n)}</option>`)
    .join("");
  return `<option value="">— Optional —</option>${opts}`;
}

type GuestLayoutOpts = {
  title?: string;
  variant?: "default" | "auth";
  hidePartnerNav?: boolean;
  showPartnerFooter?: boolean;
};

const GUEST_OVERFLOW_STYLES = `
    html, body { overflow-x: clip; max-width: 100%; }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
`;

const GUEST_AUTH_STYLES = `
    .guest-auth-page main { max-width: 440px; margin: 32px auto 48px; padding: 0; background: transparent; border: 0; box-shadow: none; animation: none; }
    .guest-auth-card { background: linear-gradient(180deg, rgba(255,255,255,.98), rgba(252,255,253,.94)); border: 1px solid rgba(220,232,227,.9); border-radius: 24px; padding: 28px 24px 22px; box-shadow: 0 28px 70px -18px rgba(7,68,58,.22), inset 0 1px 0 rgba(255,255,255,.85); }
    .guest-auth-card h1 { font-size: 1.55rem; margin: 0 0 6px; color: #0b1f1c; background: none; -webkit-text-fill-color: unset; }
    .guest-auth-card .auth-lead { margin: 0 0 18px; color: #64748b; font-size: 14.5px; line-height: 1.5; }
    .guest-auth-logo { display: inline-flex; align-items: center; gap: 8px; font-weight: 900; font-size: 18px; color: #075e54; text-decoration: none; letter-spacing: -.03em; margin-bottom: 18px; }
    .guest-auth-logo::before { content: ""; width: 28px; height: 28px; border-radius: 10px; background: linear-gradient(135deg,#25d366,#b9f7d3); box-shadow: 0 8px 18px rgba(37,211,102,.22); }
    .guest-auth-card form { max-width: none; gap: 10px; }
    .guest-auth-card label { display: grid; gap: 5px; font-size: 13px; }
    .guest-auth-card .field-row { display: grid; grid-template-columns: 120px 1fr; gap: 8px; align-items: end; }
  @media (max-width: 480px) { .guest-auth-card .field-row { grid-template-columns: 1fr; } }
    .guest-auth-links { margin-top: 16px; font-size: 13.5px; display: flex; flex-wrap: wrap; gap: 8px 14px; }
    .guest-auth-links a { color: #0b6e6e; font-weight: 700; text-decoration: none; }
    .guest-auth-links a:hover { text-decoration: underline; }
    .guest-auth-foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid #e6efeb; font-size: 12.5px; text-align: center; }
    .guest-auth-foot a { color: #64748b; font-weight: 700; }
    @media (max-width: 640px) {
      .guest-topbar.guest-topbar--auth .links .hotel-login { display: none; }
      .guest-topbar .links a { font-size: 12px; padding: 6px 9px; }
      .guest-auth-page main { margin: 12px auto 24px; padding: 0 12px; }
    }
`;

function travellerBookingWhereClauses(account: {
  guestId?: string | null;
  email: string;
  phoneE164?: string | null;
}): Prisma.BookingWhereInput[] {
  const clauses: Prisma.BookingWhereInput[] = [{ guest: { email: account.email } }];
  if (account.guestId) clauses.push({ guestId: account.guestId });
  if (account.phoneE164) clauses.push({ guest: { phoneE164: account.phoneE164 } });
  return clauses;
}

function guestLayout(content: string, lang: "en" | "ar" = "en", opts: GuestLayoutOpts = {}): string {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const title = opts.title ?? "ChatAstay — Traveller";
  const isAuth = opts.variant === "auth";
  const bodyClass = isAuth ? "guest-auth-page" : "";
  const topbarClass = isAuth || opts.hidePartnerNav ? "guest-topbar guest-topbar--auth" : "guest-topbar";
  const partnerNav = opts.hidePartnerNav
    ? ""
    : `<a class="hotel-login" href="/admin/login">Hotel / Partner</a>`;
  const partnerFooter = opts.showPartnerFooter
    ? `<p class="guest-auth-foot muted">Hotel or partner? <a href="/admin/login">Sign in to the extranet</a></p>`
    : "";
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    ${GUEST_OVERFLOW_STYLES}
    ${isAuth ? GUEST_AUTH_STYLES : ""}
    body { font-family: Inter, Arial, sans-serif; margin: 0; background: radial-gradient(circle at 12% -10%, rgba(37,211,102,.22), transparent 30%), radial-gradient(circle at 92% 8%, rgba(18,140,126,.15), transparent 28%), linear-gradient(180deg, #f9fffc 0%, #eef7f4 100%); color: #0b1f1c; }
    main { max-width: 900px; margin: 24px auto; background: rgba(255,255,255,.96); border: 1px solid #dce8e3; border-radius: 24px; padding: 24px; box-shadow: 0 24px 70px rgba(15,44,38,.12); }
    h1, h2 { margin-top: 0; letter-spacing: -.03em; }
    html[dir="rtl"] body, html[dir="rtl"] th, html[dir="rtl"] td { text-align: right; }
    .muted { color: #475569; }
    .inline-link { color:#0b6e6e; font-weight: 700; text-decoration: none; padding: 6px 10px; border-radius: 999px; background: #ecfff5; border:1px solid #bbf7d0; }
    .inline-link:hover { text-decoration: underline; }
    .guest-topbar { max-width: 900px; margin: 18px auto -8px; display:flex; justify-content:space-between; align-items:center; gap:12px; padding:0 6px; }
    .guest-topbar .brand { color:#075e54; font-weight:900; text-decoration:none; letter-spacing:-.03em; }
    .guest-topbar .links { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .guest-topbar a, .guest-topbar button { color:#075e54; background:#ecfff5; border:1px solid #bbf7d0; border-radius:999px; padding:7px 11px; font-weight:800; text-decoration:none; font:inherit; cursor:pointer; box-shadow:none; }
    .guest-topbar a.hotel-login { background:linear-gradient(135deg,#075e54,#128c7e); color:#fff; border-color:transparent; }
    .badge { display:inline-block; padding:4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .ok { background:#dcfce7; color:#166534; }
    .pending { background:#fef9c3; color:#854d0e; }
    .alert { background:#fee2e2; color:#991b1b; }
    table { width:100%; border-collapse: separate; border-spacing:0; margin-top: 12px; }
    th, td { text-align:left; border-bottom: 1px solid #e6efeb; padding: 11px 9px; }
    th { background:#f5fbf8; color:#52635e; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    form { display:grid; gap: 8px; max-width: 460px; }
    input, select, textarea { padding: 11px 12px; border:1px solid #d7e5df; border-radius: 12px; font: inherit; background:#fff; transition:border-color .16s ease, box-shadow .16s ease; }
    input:focus, select:focus, textarea:focus { outline:0; border-color:#25d366; box-shadow:0 0 0 4px rgba(37,211,102,.16); }
    textarea { min-height: 78px; resize: vertical; }
    button { border:0; background:linear-gradient(135deg,#075e54,#128c7e); color:#fff; padding:11px 15px; border-radius: 13px; font-weight: 800; cursor: pointer; box-shadow:0 12px 24px rgba(7,94,84,.16); transition:transform .16s ease, filter .16s ease; }
    button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.04); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .row { display:grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .meal-plan-fieldset { border: 1px solid #cfe8e0; border-radius: 18px; padding: 14px 16px; margin: 0; background: #f7fdfb; box-shadow:0 8px 22px rgba(15,44,38,.05); }
    .meal-plan-fieldset legend { font-weight: 700; font-size: 15px; padding: 0 4px; color: #0f172a; }
    .meal-plan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 8px; }
    @media (min-width: 520px) { .meal-plan-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .meal-plan-card { display: flex; flex-direction: column; gap: 4px; border: 2px solid #d8eee5; border-radius: 14px; padding: 12px 10px; cursor: pointer; background: #fff; position: relative; min-height: 76px; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s, transform .15s; }
    .meal-plan-card:hover { border-color: #94d4c9; transform: translateY(-1px); }
    .meal-plan-card:has(input:checked) { border-color: #128c7e; box-shadow: 0 0 0 1px #128c7e; background: #ecfff8; }
    .meal-plan-card input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .meal-plan-card .t { font-weight: 700; font-size: 14px; }
    .meal-plan-card .d { font-size: 12px; color: #64748b; line-height: 1.35; }
    .hero-card { position:relative; overflow:hidden; background: linear-gradient(135deg, #064e46 0%, #128c7e 62%, #25d366 145%); color: #fff; border-radius: 24px; padding: 24px; margin-bottom: 16px; box-shadow:0 18px 45px rgba(7,94,84,.18); }
    .hero-card::after { content:""; position:absolute; right:-70px; top:-70px; width:190px; height:190px; border-radius:999px; background:rgba(255,255,255,.13); pointer-events:none; }
    .hero-card .muted { color: rgba(255,255,255,.82); }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration:.001ms!important; animation-iteration-count:1!important; transition-duration:.001ms!important; }
    }
    @media (max-width: 700px) {
      .row { grid-template-columns: 1fr; }
      main { margin: 0; min-height: 100vh; border-radius: 0; border: 0; padding: 14px; }
      .guest-topbar { padding: 0 10px; margin-top: 10px; }
    }

    /* ===== Polish layer 2: hierarchy, spacing, animations ===== */
    ::selection { background: rgba(37, 211, 102, 0.32); color: #053b18; }
    *:focus-visible { outline: 2px solid #25d366; outline-offset: 2px; border-radius: 8px; }
    main { padding: 32px; }
    h1, h2 { letter-spacing: -0.03em; }
    h1 { font-size: clamp(24px, 2vw + 14px, 32px); font-weight: 800; }
    h2 { font-size: clamp(18px, 0.6vw + 14px, 22px); font-weight: 800; }
    p, li { line-height: 1.6; }
    .hero-card { padding: 28px; border-radius: 26px; }
    .hero-card h1 { font-size: clamp(26px, 3vw + 14px, 36px); }
    .inline-link { padding: 7px 12px; font-weight: 700; }
    .inline-link:hover { background: #d9fbe8; }
    .badge { padding: 5px 11px; letter-spacing: 0.01em; }
    table { font-size: 13.5px; }
    th, td { padding: 13px 10px; }
    tbody tr { transition: background 0.18s ease; }
    tbody tr:hover { background: #f6fdf9; }
    label { font-weight: 600; color: #2c3a36; }
    button { padding: 13px 18px; font-size: 15px; letter-spacing: 0.005em; }
    button:active:not(:disabled) { transform: translateY(0) scale(0.985); }
    @keyframes wa-fade-up {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    main { animation: wa-fade-up 0.36s ease-out both; }
    html { scrollbar-width: thin; scrollbar-color: rgba(7, 94, 84, 0.32) transparent; }
    body::-webkit-scrollbar { width: 10px; height: 10px; }
    body::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, rgba(37, 211, 102, 0.5), rgba(7, 94, 84, 0.45));
      border-radius: 999px; border: 2px solid transparent; background-clip: padding-box;
    }
    @media (max-width: 700px) {
      main { padding: 18px; }
      .hero-card { padding: 22px; border-radius: 22px; }
    }

    /* ===== Polish layer 3: premium SaaS depth, hierarchy, micro-interactions ===== */
    body {
      font-family: "Inter", "SF Pro Display", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      background:
        radial-gradient(ellipse at 8% -8%, rgba(37, 211, 102, 0.16), transparent 35%),
        radial-gradient(ellipse at 95% 5%, rgba(18, 140, 126, 0.12), transparent 32%),
        linear-gradient(180deg, #f7fcf9 0%, #eef7f2 45%, #e6f1ec 100%);
      background-attachment: fixed;
    }
    main {
      background: linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(252,255,253,0.92) 100%);
      border: 1px solid rgba(220, 232, 227, 0.85);
      box-shadow:
        0 32px 80px -20px rgba(7, 68, 58, 0.22),
        0 12px 30px -10px rgba(15, 44, 38, 0.08),
        inset 0 1px 0 rgba(255, 255, 255, 0.85);
    }
    h1 {
      background: linear-gradient(135deg, #0b1f1c 0%, #0e3d34 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      letter-spacing: -0.04em;
    }
    .hero-card {
      background: linear-gradient(135deg, #064e46 0%, #0c7a6e 50%, #128c7e 100%),
                  radial-gradient(circle at 20% 0%, rgba(37, 211, 102, 0.32), transparent 45%);
      box-shadow: 0 28px 70px -16px rgba(7, 68, 58, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.12);
      color: #ffffff;
    }
    .hero-card h1 {
      background: linear-gradient(135deg, #ffffff 0%, #d9fbe8 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    button[type="submit"], .btn-primary {
      background: linear-gradient(135deg, #25d366 0%, #1bb673 50%, #128c7e 100%);
      color: #053b18;
      border: 0;
      box-shadow:
        0 14px 30px -8px rgba(37, 211, 102, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.45);
      transition: transform 0.18s cubic-bezier(0.25, 1, 0.5, 1),
                  box-shadow 0.18s cubic-bezier(0.25, 1, 0.5, 1),
                  filter 0.18s cubic-bezier(0.25, 1, 0.5, 1);
    }
    button[type="submit"]:hover:not(:disabled), .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow:
        0 22px 44px -10px rgba(37, 211, 102, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.5);
      filter: brightness(1.04);
    }
    input, select, textarea {
      transition: border-color 0.18s cubic-bezier(0.25, 1, 0.5, 1),
                  box-shadow 0.18s cubic-bezier(0.25, 1, 0.5, 1);
    }
    input:focus, select:focus, textarea:focus {
      border-color: #25d366;
      box-shadow: 0 0 0 4px rgba(37, 211, 102, 0.18);
      outline: 0;
    }
    ::selection { background: rgba(37, 211, 102, 0.3); color: #053b18; }
  </style>
  <link rel="stylesheet" href="/static/guest-calendar.css" />
  <script src="/static/guest-calendar.js" defer></script>
</head>
<body class="${bodyClass}">
  <div class="${topbarClass}">
    <a class="brand" href="/">ChatAstay</a>
    <div class="links">
      ${partnerNav}
      <a href="/guest/account/login">Sign in</a>
      <a href="/guest/trips">My Trips</a>
    </div>
  </div>
  <main>${isAuth ? `<div class="guest-auth-card">${content}${partnerFooter}</div>` : content}</main>
  <script>
  (function () {
    document.querySelectorAll("table").forEach(function (table) {
      var headers = Array.from(table.querySelectorAll("thead th")).map(function (th) {
        return th.textContent ? th.textContent.trim() : "";
      });
      table.querySelectorAll("tbody tr").forEach(function (row) {
        Array.from(row.querySelectorAll("td")).forEach(function (cell, index) {
          if (cell.hasAttribute("data-label") || Number(cell.getAttribute("colspan") || "1") > 1) return;
          cell.setAttribute("data-label", headers[index] || "Field " + (index + 1));
        });
      });
    });
  })();
  </script>
</body>
</html>`;
}

function guestAuthLayout(content: string, opts: Omit<GuestLayoutOpts, "variant"> = {}): string {
  return guestLayout(content, "en", { ...opts, variant: "auth", hidePartnerNav: true });
}

guestRouter.get("/account", async (req, res) => {
  const account = await getTravellerAccount(req);
  if (account) {
    if (travellerRequireEmailVerification() && !isTravellerEmailVerified(account)) {
      redirectToVerifyPending(res, account.email);
      return;
    }
    res.redirect("/guest/trips");
    return;
  }
  const content = `
<section class="hero-card">
  <h1>Traveller Account</h1>
  <p>Save your details, view booking history, manage My Trips, and leave post-stay reviews after checkout.</p>
</section>
<div class="row">
  <article>
    <h2>Traveller Login</h2>
    <p class="muted">For guests and repeat travellers.</p>
    <p><a class="inline-link" href="/guest/account/login">Login to My Trips</a></p>
  </article>
  <article>
    <h2>Create Traveller Account</h2>
    <p class="muted">Create a guest account separate from hotel staff access.</p>
    <p><a class="inline-link" href="/guest/account/register">Create account</a></p>
  </article>
</div>
<p class="muted" style="margin-top:14px">Hotel or partner? <a href="/admin/login">Sign in to the extranet</a> (separate from traveller access).</p>`;
  res.type("html").send(guestLayout(content, "en", { title: "Traveller account · ChatAstay" }));
});

guestRouter.get("/account/register", (req, res) => {
  const verifiedEmail = readPreRegistrationVerifiedEmailFromRequest(req);
  const queryEmail = typeof req.query.email === "string" ? normalizeEmail(req.query.email) : "";
  const emailForCode = queryEmail || verifiedEmail || "";
  const sentNotice = req.query.sent === "1" ? `<p class="badge ok">Verification code sent.</p>` : "";
  const verifiedNotice =
    req.query.verified === "1" && verifiedEmail
      ? `<p class="badge ok">Email verified. Complete your account below.</p>`
      : "";

  if (!verifiedEmail) {
    const stepOne = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Create account</h1>
<p class="auth-lead">Step 1 of 2 — verify your email with a one-time code before creating your account.</p>
${sentNotice}
<form method="post" action="/guest/account/send-verification-code">
  <label>Email <input name="email" type="email" required autocomplete="email" value="${escapeHtml(emailForCode)}" /></label>
  <button type="submit">Send verification code</button>
</form>
<div class="guest-auth-links"><a href="/guest/account/login">Already have an account? Sign in</a></div>`;
    res.type("html").send(guestAuthLayout(stepOne, { title: "Verify email · ChatAstay" }));
    return;
  }

  const content = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Create account</h1>
<p class="auth-lead">Step 2 of 2 — your email is verified. Set up your traveller account.</p>
${verifiedNotice}
<form method="post" action="/guest/account/register">
  <label>Full name <input name="fullName" required autocomplete="name" /></label>
  <label>Email <input name="email" type="email" required readonly value="${escapeHtml(verifiedEmail)}" autocomplete="email" /></label>
  <label>Mobile / WhatsApp
    <span class="field-row">
      <select name="phoneCountry" aria-label="Country code">${phoneCountrySelectHtml()}</select>
      <input name="phone" type="tel" autocomplete="tel" placeholder="9XXXXXXX" />
    </span>
  </label>
  <label>Nationality (optional) <select name="nationality">${nationalitySelectHtml()}</select></label>
  <label>Preferred language
    <select name="preferredLanguage">
      <option value="en">English</option>
      <option value="ar">Arabic</option>
      <option value="es">Spanish</option>
      <option value="fr">French</option>
    </select>
  </label>
  <label>Password <input name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
  <label>Confirm password <input name="confirmPassword" type="password" minlength="8" required autocomplete="new-password" /></label>
  <button type="submit">Create account</button>
</form>
<div class="guest-auth-links"><a href="/guest/account/login">Already have an account? Sign in</a></div>`;
  res.type("html").send(guestAuthLayout(content, { title: "Create account · ChatAstay" }));
});

guestRouter.post("/account/send-verification-code", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) {
    res.redirect("/guest/account/register");
    return;
  }
  const result = await issueTravellerEmailOtpForPreRegistration(email, { ip: getRequestIp(req) });
  if (result.sent) {
    res.redirect(`/guest/account/enter-verification-code?email=${encodeURIComponent(email)}&sent=1`);
    return;
  }
  const content = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Create account</h1>
${otpIssueNoticeHtml(result)}
<form method="post" action="/guest/account/send-verification-code">
  <label>Email <input name="email" type="email" required value="${escapeHtml(email)}" /></label>
  <button type="submit">Send verification code</button>
</form>
<div class="guest-auth-links"><a href="/guest/account/login">Sign in</a></div>`;
  res.type("html").status(result.reason === "rate_limited" ? 429 : 400).send(guestAuthLayout(content, { title: "Verify email · ChatAstay" }));
});

guestRouter.get("/account/enter-verification-code", (req, res) => {
  const email = typeof req.query.email === "string" ? normalizeEmail(req.query.email) : "";
  if (!email) {
    res.redirect("/guest/account/register");
    return;
  }
  const sentNotice = req.query.sent === "1" ? `<p class="badge ok">Code sent to <strong>${escapeHtml(email)}</strong>.</p>` : "";
  const errorNotice =
    typeof req.query.error === "string" && req.query.error
      ? `<p class="badge alert">${escapeHtml(otpVerifyErrorHtml(req.query.error))}</p>`
      : "";
  const content = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Enter verification code</h1>
<p class="auth-lead">We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>. Enter it below to confirm your email.</p>
${sentNotice}
${errorNotice}
<form method="post" action="/guest/account/verify-code">
  <input type="hidden" name="email" value="${escapeHtml(email)}" />
  <input type="hidden" name="flow" value="register" />
  <label>Verification code
    <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" required autocomplete="one-time-code" placeholder="123456" style="letter-spacing:4px;font-size:20px" />
  </label>
  <button type="submit">Verify email</button>
</form>
<form method="post" action="/guest/account/send-verification-code" style="margin-top:12px">
  <input type="hidden" name="email" value="${escapeHtml(email)}" />
  <button type="submit" style="background:transparent;border:0;padding:0;color:#128c7e;cursor:pointer;font-weight:600">Resend code</button>
</form>
<div class="guest-auth-links"><a href="/guest/account/register">Change email</a></div>`;
  res.type("html").send(guestAuthLayout(content, { title: "Enter code · ChatAstay" }));
});

guestRouter.post("/account/verify-code", async (req, res) => {
  const flow = String(req.body.flow ?? "login");
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code ?? "");

  if (flow === "register") {
    if (!email) {
      res.redirect("/guest/account/register");
      return;
    }
    const result = verifyTravellerEmailOtpForPreRegistration(email, code);
    if (!result.ok) {
      res.redirect(
        `/guest/account/enter-verification-code?email=${encodeURIComponent(email)}&error=${encodeURIComponent(result.reason ?? "invalid")}`
      );
      return;
    }
    setPreRegistrationVerifiedEmailCookie(res, email);
    res.redirect("/guest/account/register?verified=1");
    return;
  }

  const account = await getTravellerAccount(req);
  if (!account) {
    redirectToTravellerLogin(res, "/guest/trips");
    return;
  }
  const verifyResult = await verifyTravellerEmailOtp(account.id, code);
  if (!verifyResult.ok) {
    res.redirect(
      `/guest/account/verify-pending?email=${encodeURIComponent(account.email)}&error=${encodeURIComponent(verifyResult.reason ?? "invalid")}`
    );
    return;
  }
  res.redirect("/guest/trips");
});

guestRouter.post("/account/register", async (req, res) => {
  const fullName = String(req.body.fullName ?? "").trim().slice(0, 160);
  const email = normalizeEmail(req.body.email);
  const phoneCountryIso = String(req.body.phoneCountry ?? "OM").trim().toUpperCase();
  const phoneRaw = String(req.body.phone ?? "").trim();
  const password = String(req.body.password ?? "");
  const confirmPassword = String(req.body.confirmPassword ?? "");
  const nationality = String(req.body.nationality ?? "").trim().slice(0, 80) || null;
  const preferredLanguage = String(req.body.preferredLanguage ?? "en").trim().slice(0, 8) || "en";
  const parsedPhone = phoneRaw
    ? parseGuestPhoneFromFormFields({
        countryCodeRaw: PHONE_COUNTRY_OPTIONS.find((c) => c.iso === phoneCountryIso)?.code ?? "+968",
        phoneRaw,
        defaultCountryIso: phoneCountryIso
      })
    : null;
  const normalizedPhone = parsedPhone?.isValid ? parsedPhone.phoneE164 : phoneRaw ? normalizePhone(phoneRaw, phoneCountryIso) : "";
  const needsVerify = travellerRequireEmailVerification();
  const preVerifiedEmail = readPreRegistrationVerifiedEmailFromRequest(req);

  if (needsVerify && preVerifiedEmail !== email) {
    res.redirect("/guest/account/register");
    return;
  }

  if (!fullName || !email || password.length < 8 || password !== confirmPassword) {
    res
      .type("html")
      .status(400)
      .send(
        guestAuthLayout(
          `<h1>Create account</h1><p class="badge alert">Name, valid email, matching passwords (8+ characters) are required.</p><p class="guest-auth-links"><a href="/guest/account/register">Try again</a></p>`,
          { title: "Create account · ChatAstay" }
        )
      );
    return;
  }
  if (phoneRaw && parsedPhone && !parsedPhone.isValid && !normalizedPhone) {
    res
      .type("html")
      .status(400)
      .send(
        guestAuthLayout(
          `<h1>Create account</h1><p class="badge alert">Please enter a valid mobile number or leave it blank.</p><p class="guest-auth-links"><a href="/guest/account/register">Try again</a></p>`,
          { title: "Create account · ChatAstay" }
        )
      );
    return;
  }

  const hotel = await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug }, select: { id: true } });
  const guestRecord =
    hotel && normalizedPhone
      ? await prisma.guest.upsert({
          where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: normalizedPhone } },
          update: { fullName, email },
          create: { hotelId: hotel.id, phoneE164: normalizedPhone, fullName, email }
        })
      : null;

  try {
    const account = await prisma.travellerAccount.create({
      data: {
        guestId: guestRecord?.id ?? null,
        email,
        fullName,
        phoneE164: normalizedPhone || null,
        nationality,
        preferredLanguage,
        passwordHash: await hashPassword(password),
        emailVerifiedAt: needsVerify ? (preVerifiedEmail === email ? new Date() : null) : new Date()
      }
    });
    setTravellerCookie(res, account.id);
    if (needsVerify && !account.emailVerifiedAt) {
      const issued = await issueTravellerVerificationEmail(account.id, { ip: getRequestIp(req) });
      redirectToVerifyPending(res, email, { sent: issued.sent });
      return;
    }
    res.redirect("/guest/trips?created=1");
  } catch {
    res
      .type("html")
      .status(409)
      .send(
        guestAuthLayout(
          `<h1>Create account</h1><p class="badge alert">An account already exists for this email.</p><p class="guest-auth-links"><a href="/guest/account/login">Sign in instead</a></p>`,
          { title: "Create account · ChatAstay" }
        )
      );
  }
});

guestRouter.get("/account/login", (req, res) => {
  const next = typeof req.query.next === "string" ? req.query.next : "/guest/trips";
  const content = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Sign in</h1>
<p class="auth-lead">Access My Trips and your booking history.</p>
<form method="post" action="/guest/account/login">
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  <label>Email <input name="email" type="email" required autocomplete="email" /></label>
  <label>Password <input name="password" type="password" required autocomplete="current-password" /></label>
  <button type="submit">Sign in</button>
</form>
<div class="guest-auth-links">
  <a href="/guest/account/forgot-password">Forgot password?</a>
  <a href="/guest/account/register">Create account</a>
</div>`;
  res.type("html").send(guestAuthLayout(content, { title: "Sign in · ChatAstay" }));
});

guestRouter.post("/account/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password ?? "");
  const next = String(req.body.next ?? "/guest/trips");
  const account = await prisma.travellerAccount.findUnique({ where: { email } });
  if (!account?.isActive || !(await verifyPassword(password, account.passwordHash))) {
    res
      .type("html")
      .status(401)
      .send(
        guestAuthLayout(
          `<h1>Sign in</h1><p class="badge alert">Invalid email or password.</p><p class="guest-auth-links"><a href="/guest/account/login">Try again</a></p>`,
          { title: "Sign in · ChatAstay" }
        )
      );
    return;
  }
  await prisma.travellerAccount.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
  setTravellerCookie(res, account.id);
  if (travellerRequireEmailVerification() && !isTravellerEmailVerified(account)) {
    redirectToVerifyPending(res, email);
    return;
  }
  res.redirect(next.startsWith("/guest/") ? next : "/guest/trips");
});

guestRouter.get("/account/verify-pending", async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email : "";
  const account = await getTravellerAccount(req);
  const displayEmail = account?.email ?? email;
  const needsVerify =
    account && travellerRequireEmailVerification() && !isTravellerEmailVerified(account);

  if (needsVerify && account && req.query.sent !== "1" && !req.query.error) {
    const issued = await issueTravellerVerificationEmail(account.id, { ip: getRequestIp(req) });
    if (issued.sent) {
      res.redirect(`/guest/account/verify-pending?email=${encodeURIComponent(account.email)}&sent=1`);
      return;
    }
  }

  const providerHint =
    needsVerify && !isEmailConfigured()
      ? `<p class="badge pending">Email provider not configured on this server. Configure SMTP in the server environment.</p>`
      : "";
  const sentNotice =
    req.query.sent === "1" ? `<p class="badge ok">Verification code sent to <strong>${escapeHtml(displayEmail)}</strong>.</p>` : "";
  const errorNotice =
    typeof req.query.error === "string" && req.query.error
      ? `<p class="badge alert">${escapeHtml(otpVerifyErrorHtml(req.query.error))}</p>`
      : "";
  const codeForm = needsVerify
    ? `<form method="post" action="/guest/account/verify-code" style="margin-top:12px">
  <input type="hidden" name="flow" value="login" />
  <label>Verification code
    <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" required autocomplete="one-time-code" placeholder="123456" style="letter-spacing:4px;font-size:20px" />
  </label>
  <button type="submit">Confirm code</button>
</form>
<form method="post" action="/guest/account/resend-verification" style="margin-top:12px">
  <button type="submit">Resend code</button>
</form>`
    : "";
  const content = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Verify your email</h1>
<p class="auth-lead">Enter the 6-digit code we sent to ${displayEmail ? `<strong>${escapeHtml(displayEmail)}</strong>` : "your email"}.</p>
<p class="muted">Check your inbox and spam folder. Codes expire after 15 minutes.</p>
${sentNotice}
${errorNotice}
${providerHint}
${codeForm}
<div class="guest-auth-links"><a href="/guest/account/login">Back to sign in</a></div>`;
  res.type("html").send(guestAuthLayout(content, { title: "Verify email · ChatAstay" }));
});

guestRouter.post("/account/resend-verification", async (req, res) => {
  const account = await getTravellerAccount(req);
  if (!account) {
    redirectToTravellerLogin(res, "/guest/trips");
    return;
  }
  if (isTravellerEmailVerified(account)) {
    res.redirect("/guest/trips");
    return;
  }
  if (isTravellerVerificationResendRateLimited(req, account.id)) {
    res.redirect(
      `/guest/account/verify-pending?email=${encodeURIComponent(account.email)}&error=${encodeURIComponent("rate_limited")}`
    );
    return;
  }
  const result = await issueTravellerVerificationEmail(account.id, { ip: getRequestIp(req) });
  if (result.sent) {
    res.redirect(`/guest/account/verify-pending?email=${encodeURIComponent(account.email)}&sent=1`);
    return;
  }
  res.redirect(`/guest/account/verify-pending?email=${encodeURIComponent(account.email)}&error=send_failed`);
});

guestRouter.get("/account/verify-email", async (req, res) => {
  const token = String(req.query.token ?? "").trim();
  const result = await verifyTravellerEmailToken(token);
  if (!result.ok) {
    const message =
      result.reason === "expired"
        ? "This verification link has expired."
        : result.reason === "missing_token"
          ? "No verification token was provided."
          : "This verification link is invalid.";
    const title = result.reason === "expired" ? "Link expired" : "Verification failed";
    res
      .type("html")
      .status(400)
      .send(
        guestAuthLayout(
          `<h1>${escapeHtml(title)}</h1><p class="badge alert">${escapeHtml(message)}</p><p class="guest-auth-links"><a href="/guest/account/verify-pending">Request a new link</a></p>`,
          { title: `${title} · ChatAstay` }
        )
      );
    return;
  }
  res
    .type("html")
    .send(
      guestAuthLayout(
        `<h1>Email verified</h1><p class="badge ok">Your email is confirmed. You can now access My Trips.</p><p class="guest-auth-links"><a href="/guest/trips">Go to My Trips</a></p>`,
        { title: "Email verified · ChatAstay" }
      )
    );
});

guestRouter.get("/account/forgot-password", (_req, res) => {
  const sent = _req.query.sent === "1";
  const content = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Forgot password</h1>
<p class="auth-lead">Enter your traveller account email. We will send a secure reset link (15 minutes).</p>
${sent ? `<p class="badge ok">If an account exists for that email, we sent a reset link.</p>` : ""}
<form method="post" action="/guest/account/forgot-password">
  <label>Email <input name="email" type="email" required autocomplete="email" /></label>
  <button type="submit">Send reset link</button>
</form>
<div class="guest-auth-links"><a href="/guest/account/login">Back to sign in</a></div>`;
  res.type("html").send(guestAuthLayout(content, { title: "Forgot password · ChatAstay" }));
});

guestRouter.post("/account/forgot-password", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (email) await requestTravellerPasswordReset(email, req);
  res.redirect("/guest/account/forgot-password?sent=1");
});

guestRouter.get("/account/reset-password", async (req, res) => {
  const token = String(req.query.token ?? "").trim();
  const valid = await travellerPasswordResetTokenValid(token);
  if (!valid) {
    res
      .type("html")
      .status(400)
      .send(
        guestAuthLayout(
          `<h1>Reset password</h1><p class="badge alert">This link is invalid or has expired.</p><p class="guest-auth-links"><a href="/guest/account/forgot-password">Request a new link</a></p>`,
          { title: "Reset password · ChatAstay" }
        )
      );
    return;
  }
  const content = `
<a class="guest-auth-logo" href="/">ChatAstay</a>
<h1>Set new password</h1>
<p class="auth-lead">Choose a new password (at least 8 characters).</p>
<form method="post" action="/guest/account/reset-password">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <label>New password <input name="newPassword" type="password" minlength="8" required autocomplete="new-password" /></label>
  <label>Confirm password <input name="confirmPassword" type="password" minlength="8" required autocomplete="new-password" /></label>
  <button type="submit">Update password</button>
</form>`;
  res.type("html").send(guestAuthLayout(content, { title: "Reset password · ChatAstay" }));
});

guestRouter.post("/account/reset-password", async (req, res) => {
  const token = String(req.body.token ?? "").trim();
  const newPassword = String(req.body.newPassword ?? "");
  const confirmPassword = String(req.body.confirmPassword ?? "");
  const result = await consumeTravellerPasswordReset(token, newPassword, confirmPassword);
  if (!result.ok) {
    const msg =
      result.reason === "password_mismatch"
        ? "Passwords must match and be at least 8 characters."
        : "This reset link is invalid or has expired.";
    res
      .type("html")
      .status(400)
      .send(
        guestAuthLayout(
          `<h1>Reset password</h1><p class="badge alert">${escapeHtml(msg)}</p><p class="guest-auth-links"><a href="/guest/account/forgot-password">Request a new link</a></p>`,
          { title: "Reset password · ChatAstay" }
        )
      );
    return;
  }
  res
    .type("html")
    .send(
      guestAuthLayout(
        `<h1>Password updated</h1><p class="badge ok">You can now sign in with your new password.</p><p class="guest-auth-links"><a href="/guest/account/login">Sign in</a></p>`,
        { title: "Reset password · ChatAstay" }
      )
    );
});

guestRouter.post("/account/logout", (_req, res) => {
  clearTravellerCookie(res);
  res.redirect("/guest/account/login");
});

guestRouter.get("/trips", async (req, res) => {
  const account = await requireVerifiedTraveller(req, res);
  if (!account) return;
  const bookings = await prisma.booking.findMany({
    where: { OR: travellerBookingWhereClauses(account) },
    include: { hotel: true, property: true, roomType: true, guest: true, feedbacks: true },
    orderBy: { checkIn: "desc" },
    take: 30
  });
  const now = new Date();
  const rows = bookings
    .map((b) => {
      const paid = b.paymentStatus === PaymentStatus.SUCCEEDED;
      const checkedOut = b.checkOut <= now;
      const canReview = paid && checkedOut;
      const hasReview = b.feedbacks.length > 0;
      return `<tr>
        <td>${escapeHtml(b.referenceCode || b.id)}</td>
        <td>${escapeHtml(b.hotel.displayName)}</td>
        <td>${escapeHtml(b.roomType.name)}</td>
        <td>${formatDate(b.checkIn)} → ${formatDate(b.checkOut)}</td>
        <td><span class="badge ${b.status === "CONFIRMED" || b.status === "CHECKED_IN" ? "ok" : "pending"}">${escapeHtml(b.status)}</span></td>
        <td><span class="badge ${paid ? "ok" : "pending"}">${escapeHtml(b.paymentStatus)}</span></td>
        <td>${canReview && !hasReview ? `<a class="inline-link" href="/guest/review/${encodeURIComponent(b.id)}">Leave review</a>` : hasReview ? "Review received" : "Review after paid checkout"}</td>
      </tr>`;
    })
    .join("");
  const createdNotice =
    req.query.created === "1"
      ? '<p class="badge ok">Account created. Verify your email if prompted, then your bookings will appear below.</p>'
      : "";
  const reviewNotice =
    req.query.review === "1" ? '<p class="badge ok">Thank you — your review was submitted.</p>' : "";
  const content = `
<h1>My Trips</h1>
<p class="muted">Signed in as ${escapeHtml(account.fullName || account.email)}.</p>
${createdNotice}
${reviewNotice}
<form method="post" action="/guest/account/logout" style="display:inline"><button type="submit">Logout</button></form>
<div class="table-scroll">
<table>
  <thead><tr><th>Reference</th><th>Hotel</th><th>Room</th><th>Stay</th><th>Status</th><th>Payment</th><th>Review</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No trips found yet. Future website bookings will appear here.</td></tr>'}</tbody>
</table>
</div>`;
  res.type("html").send(guestLayout(content));
});

guestRouter.get("/review/:bookingId", async (req, res) => {
  const account = await requireVerifiedTraveller(req, res);
  if (!account) return;
  const booking = await prisma.booking.findFirst({
    where: {
      id: String(req.params.bookingId ?? ""),
      paymentStatus: PaymentStatus.SUCCEEDED,
      checkOut: { lte: new Date() },
      OR: travellerBookingWhereClauses(account)
    },
    include: { hotel: true, roomType: true, guest: true, feedbacks: true }
  });
  if (!booking) {
    res.status(404).type("html").send(guestLayout("<h1>Review unavailable</h1><p class=\"badge alert\">Reviews open only after paid checkout.</p>"));
    return;
  }
  const existing = booking.feedbacks[0];
  const content = `
<h1>Review your stay</h1>
<p class="muted">${escapeHtml(booking.hotel.displayName)} · ${escapeHtml(booking.roomType.name)} · ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}</p>
${existing ? '<p class="badge ok">Review already received. You can update it below.</p>' : ""}
<form method="post" action="/guest/review/${encodeURIComponent(booking.id)}">
  <label>Rating
    <select name="rating" required>
      ${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${existing?.rating === n ? "selected" : ""}>${n} star${n === 1 ? "" : "s"}</option>`).join("")}
    </select>
  </label>
  <label>Comment <textarea name="comment" maxlength="2000">${escapeHtml(existing?.comment ?? "")}</textarea></label>
  <button type="submit">Submit review</button>
</form>`;
  res.type("html").send(guestLayout(content));
});

guestRouter.post("/review/:bookingId", async (req, res) => {
  const account = await requireVerifiedTraveller(req, res);
  if (!account) return;
  const rating = Math.min(5, Math.max(1, parseIntSafe(req.body.rating, 5, 1, 5)));
  const comment = String(req.body.comment ?? "").trim().slice(0, 2000) || null;
  const booking = await prisma.booking.findFirst({
    where: {
      id: String(req.params.bookingId ?? ""),
      paymentStatus: PaymentStatus.SUCCEEDED,
      checkOut: { lte: new Date() },
      OR: travellerBookingWhereClauses(account)
    },
    include: { guest: true }
  });
  if (!booking) {
    res.status(403).type("html").send(guestLayout("<h1>Review unavailable</h1><p class=\"badge alert\">Reviews open only after paid checkout.</p>"));
    return;
  }
  const existing = await prisma.guestFeedback.findFirst({ where: { hotelId: booking.hotelId, bookingId: booking.id } });
  const data = {
    hotelId: booking.hotelId,
    bookingId: booking.id,
    guestId: booking.guestId,
    guestName: booking.guest.fullName ?? account.fullName ?? account.email,
    rating,
    comment,
    status: GuestFeedbackStatus.COMPLETED,
    isHappyGuest: rating >= 4,
    isPromoter: rating >= 5,
    isIssueCase: rating <= 2
  };
  if (existing) await prisma.guestFeedback.update({ where: { id: existing.id }, data });
  else await prisma.guestFeedback.create({ data });
  res.redirect("/guest/trips?review=1");
});

guestRouter.get("/", async (req, res) => {
  const bookingId = typeof req.query.bookingId === "string" ? req.query.bookingId.trim() : "";
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const error = typeof req.query.error === "string" ? req.query.error.trim() : "";

  if (!bookingId || !phone) {
    const hotel =
      (await prisma.hotel.findUnique({
        where: { slug: defaultHotelSlug },
        include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
      })) ??
      (await prisma.hotel.findFirst({
        include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
      }));
    const offers = readActiveHotelOffers();

    const roomRows = hotel?.roomTypes
      .map(
        (room) => `<tr>
      <td>${escapeHtml(room.name)}</td>
      <td>${room.capacity}</td>
      <td>${room.baseNightlyRate.toFixed(2)} ${escapeHtml(hotel.currency)}</td>
      <td>${room.totalInventory}</td>
    </tr>`
      )
      .join("");

    const offerRows = offers
      .map((offer) => {
        return `<tr>
      <td>${escapeHtml(offer.title)}</td>
      <td>${escapeHtml(offer.type)}</td>
      <td>${offer.discountPercent}%</td>
      <td>${escapeHtml(formatHotelOfferDetails(offer))}</td>
    </tr>`;
      })
      .join("");

    const contactPhone = normalizePhone(hotel?.whatsappPhone ?? "");
    const waLink = contactPhone ? `https://wa.me/${encodeURIComponent(contactPhone)}` : "";

    const content = `
<h1>Guest Booking Portal</h1>
<p class="muted">View rooms and offers, check booking details, and contact the hotel.</p>
${error ? `<p class="badge alert">${escapeHtml(error)}</p>` : ""}
<section style="margin-bottom:14px">
  <h2>Rooms</h2>
  <table>
    <thead><tr><th>Room</th><th>Capacity</th><th>Rate</th><th>Inventory</th></tr></thead>
    <tbody>${roomRows || '<tr><td colspan="4">No rooms available.</td></tr>'}</tbody>
  </table>
  <p style="margin-top:10px"><a class="inline-link" href="/guest/calendar${hotel ? `?hotelId=${encodeURIComponent(hotel.id)}` : ""}">Check availability calendar</a></p>
</section>
<section style="margin-bottom:14px">
  <h2>Offers</h2>
  <table>
    <thead><tr><th>Offer</th><th>Type</th><th>Discount</th><th>Details</th></tr></thead>
    <tbody>${offerRows || '<tr><td colspan="4">No active offers right now.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin-bottom:14px">
  <h2>Contact Hotel</h2>
  <p class="muted">Need help? Contact our team directly.</p>
  <div style="display:flex; gap:8px; flex-wrap:wrap">
    ${waLink ? `<a class="inline-link" href="${waLink}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ""}
    ${hotel?.whatsappPhone ? `<span class="inline-link" style="text-decoration:none">${escapeHtml(hotel.whatsappPhone)}</span>` : ""}
    <a class="inline-link" href="mailto:${escapeHtml(process.env.ADMIN_EMAIL ?? "reservations@chatastay.local")}">Email hotel</a>
  </div>
</section>
<section>
<h2>Check Booking Details</h2>
<p class="muted">Enter your booking information to view stay and payment status.</p>
<form method="post" action="/guest/lookup">
  <label>Booking ID
    <input type="text" name="bookingId" value="${escapeHtml(bookingId)}" placeholder="WB-ABC123" required />
  </label>
  <label>Phone number used for booking
    <input type="text" name="phone" value="${escapeHtml(phone)}" placeholder="9689XXXXXXX" required />
  </label>
  <button type="submit">Check Booking</button>
</form>
</section>`;
    res.type("html").send(guestLayout(content));
    return;
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId },
    include: { guest: true, hotel: true, property: true, roomType: true }
  });
  if (!booking) {
    res.redirect("/guest?error=Booking+not+found");
    return;
  }

  const expectedPhone = normalizePhone(booking.guest.phoneE164);
  const providedPhone = normalizePhone(phone);
  const phoneMatches =
    expectedPhone === providedPhone || expectedPhone.endsWith(providedPhone) || providedPhone.endsWith(expectedPhone);
  if (!phoneMatches) {
    res.redirect("/guest?error=Phone+number+does+not+match+booking+record");
    return;
  }

  const badgeClass =
    booking.status === "CONFIRMED" ? "ok" : booking.status === "CANCELLED" || booking.status === "NO_SHOW" ? "alert" : "pending";
  const paymentBadgeClass =
    booking.paymentStatus === "SUCCEEDED" ? "ok" : booking.paymentStatus === "FAILED" ? "alert" : "pending";

  const content = `
<h1>Booking Details</h1>
<p class="muted">Welcome ${escapeHtml(booking.guest.fullName ?? "Guest")}, this is your latest booking information.</p>
<div class="row">
  <article>
    <h2>Stay Summary</h2>
    <table>
      <tbody>
        <tr><th>Booking ID</th><td>${escapeHtml(booking.id)}</td></tr>
        <tr><th>Hotel</th><td>${escapeHtml(booking.hotel.displayName)}</td></tr>
        <tr><th>Property</th><td>${escapeHtml(booking.property.name)}</td></tr>
        <tr><th>Room Type</th><td>${escapeHtml(booking.roomType.name)}</td></tr>
        <tr><th>Check-in</th><td>${formatDate(booking.checkIn)}</td></tr>
        <tr><th>Check-out</th><td>${formatDate(booking.checkOut)}</td></tr>
        <tr><th>Nights</th><td>${booking.nights}</td></tr>
      </tbody>
    </table>
  </article>
  <article>
    <h2>Status</h2>
    <table>
      <tbody>
        <tr><th>Booking Status</th><td><span class="badge ${badgeClass}">${escapeHtml(booking.status)}</span></td></tr>
        <tr><th>Payment Status</th><td><span class="badge ${paymentBadgeClass}">${escapeHtml(booking.paymentStatus)}</span></td></tr>
        <tr><th>Total Amount</th><td>${booking.totalAmount.toFixed(2)} ${escapeHtml(booking.currency)}</td></tr>
        <tr><th>Adults</th><td>${booking.adults}</td></tr>
        <tr><th>Children</th><td>${booking.children}</td></tr>
      </tbody>
    </table>
  </article>
</div>
<p style="margin-top:12px"><a href="/guest">Check another booking</a></p>`;

  res.type("html").send(guestLayout(content));
});

guestRouter.post("/lookup", (req, res) => {
  const bookingId = String(req.body.bookingId ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  if (!bookingId || !phone) {
    res.redirect("/guest?error=Please+provide+both+Booking+ID+and+phone+number");
    return;
  }
  const query = new URLSearchParams({ bookingId, phone });
  res.redirect(`/guest?${query.toString()}`);
});

guestRouter.get("/book-now", async (req, res) => {
  const query = new URLSearchParams();
  const hotelId = typeof req.query.hotelId === "string" ? req.query.hotelId.trim() : "";
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (hotelId) query.set("hotelId", hotelId);
  if (phone) query.set("phone", phone);
  if (token) query.set("token", token);
  res.redirect(`/guest/book?${query.toString()}`);
});

guestRouter.get("/book", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const hotelIdFromQuery = typeof req.query.hotelId === "string" ? req.query.hotelId.trim() : "";
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const guestName = typeof req.query.guestName === "string" ? req.query.guestName.trim() : "";
  const error = typeof req.query.error === "string" ? req.query.error.trim() : "";
  let lang: "en" | "ar" = req.query.lang === "ar" ? "ar" : "en";

  let resolvedHotelId = hotelIdFromQuery;
  if (token) {
    try {
      const session = await resolveCalendarSession(token);
      resolvedHotelId = session.hotelId;
      lang = session.language === "ar" ? "ar" : lang;
    } catch (sessionError) {
      const message = sessionError instanceof Error ? sessionError.message : "Invalid booking session";
      res.redirect(`/guest/book?${new URLSearchParams({ error: message }).toString()}`);
      return;
    }
  }

  const hotel =
    (resolvedHotelId
      ? await prisma.hotel.findUnique({
          where: { id: resolvedHotelId },
          include: { roomTypes: { where: { isActive: true }, orderBy: { baseNightlyRate: "asc" } } }
        })
      : await prisma.hotel.findUnique({
          where: { slug: defaultHotelSlug },
          include: { roomTypes: { where: { isActive: true }, orderBy: { baseNightlyRate: "asc" } } }
        })) ??
    (await prisma.hotel.findFirst({
      orderBy: { createdAt: "asc" },
      include: { roomTypes: { where: { isActive: true }, orderBy: { baseNightlyRate: "asc" } } }
    }));
  if (!hotel) {
    res.type("html").send(guestLayout("<h1>Book Your Stay</h1><p class=\"badge alert\">No hotel found.</p>"));
    return;
  }

  const today = formatDate(new Date());
  const tomorrow = formatDate(addDays(new Date(), 1));
  const ar = lang === "ar";
  const mealPlanSuffix = (code: MealPlanCode) => {
    const { mode, rate } = getMealPlanUnitRate(code);
    const unit = mode === "PER_GUEST_PER_NIGHT" ? (ar ? "ضيف" : "guest") : ar ? "غرفة" : "room";
    return `(+${rate.toFixed(2)} ${escapeHtml(hotel.currency)}/${unit}/${ar ? "ليلة" : "night"})`;
  };
  const roomOptions = hotel.roomTypes
    .map(
      (room) =>
        `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)} · max ${room.capacity} · ${room.baseNightlyRate.toFixed(2)} ${escapeHtml(hotel.currency)}/night</option>`
    )
    .join("");
  const content = `
<section class="hero-card">
  <h1>${ar ? "احجز" : "Book"} ${escapeHtml(hotel.displayName)}</h1>
  <p class="muted">${ar ? "أكمل تفاصيل الحجز في شاشة واحدة واحصل على رقم الحجز فوراً." : "Fill everything in one mobile screen, confirm here, and receive your booking number immediately."}</p>
</section>
${error ? `<p class="badge alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/guest/book" style="display:grid; gap:12px; max-width:620px">
  <input type="hidden" name="hotelId" value="${escapeHtml(hotel.id)}" />
  <input type="hidden" name="lang" value="${lang}" />
  ${token ? `<input type="hidden" name="token" value="${escapeHtml(token)}" />` : ""}
  <div class="row">
    <label>${ar ? "تاريخ الوصول" : "Check-in"}
      <input type="date" name="checkIn" min="${escapeHtml(today)}" value="${escapeHtml(today)}" required />
    </label>
    <label>${ar ? "تاريخ المغادرة" : "Check-out"}
      <input type="date" name="checkOut" min="${escapeHtml(tomorrow)}" value="${escapeHtml(tomorrow)}" required />
    </label>
  </div>
  <div class="row">
    <label>${ar ? "البالغون" : "Adults"}
      <select name="adults" required>
        ${Array.from({ length: 10 }, (_, idx) => idx + 1)
          .map((n) => `<option value="${n}" ${n === 2 ? "selected" : ""}>${n} adult${n > 1 ? "s" : ""}</option>`)
          .join("")}
      </select>
    </label>
    <label>${ar ? "الأطفال" : "Children"}
      <select name="children">
        ${Array.from({ length: 7 }, (_, n) => `<option value="${n}">${n} child${n === 1 ? "" : "ren"}</option>`).join("")}
      </select>
    </label>
  </div>
  <fieldset class="meal-plan-fieldset">
    <legend>${ar ? "خطة الوجبات" : "Meal plan"}</legend>
    <p class="muted" style="margin:0 0 8px;font-size:13px">${ar ? "اختر الباقة قبل الغرفة والدفع — تظهر دائماً هنا." : "Choose your board plan before rooms & payment — always visible here."}</p>
    <div class="meal-plan-grid" role="radiogroup" aria-label="${ar ? "خطة الوجبات" : "Meal plan"}">
      <label class="meal-plan-card">
        <input type="radio" name="mealPlan" value="NONE" checked />
        <span class="t">${ar ? "غرفة فقط" : "Room only"}</span>
        <span class="d">${ar ? "بدون وجبات" : "Room rate only"}</span>
      </label>
      <label class="meal-plan-card">
        <input type="radio" name="mealPlan" value="BREAKFAST" />
        <span class="t">${ar ? "إفطار" : "Breakfast"}</span>
        <span class="d">${mealPlanSuffix("BREAKFAST")}</span>
      </label>
      <label class="meal-plan-card">
        <input type="radio" name="mealPlan" value="HALF_BOARD" />
        <span class="t">${ar ? "نصف إقامة" : "Half board"}</span>
        <span class="d">${mealPlanSuffix("HALF_BOARD")}</span>
      </label>
      <label class="meal-plan-card">
        <input type="radio" name="mealPlan" value="FULL_BOARD" />
        <span class="t">${ar ? "إقامة كاملة" : "Full board"}</span>
        <span class="d">${mealPlanSuffix("FULL_BOARD")}</span>
      </label>
    </div>
  </fieldset>
  <div class="row">
    <label>${ar ? "عدد الغرف" : "Rooms"}
      <select name="rooms" required>
        ${Array.from({ length: 6 }, (_, idx) => idx + 1)
          .map((n) => `<option value="${n}">${n} room${n > 1 ? "s" : ""}</option>`)
          .join("")}
      </select>
    </label>
    <label>${ar ? "نوع الغرفة" : "Preferred room"}
      <select name="roomTypeId">
        <option value="">${ar ? "أفضل غرفة متاحة" : "Best available"}</option>
        ${roomOptions}
      </select>
    </label>
  </div>
  <label>${ar ? "الدفع" : "Payment"}
    <select name="paymentPreference">
      <option value="PAY_LATER">${ar ? "الدفع لاحقاً في الفندق" : "Pay later at hotel"}</option>
      <option value="PAY_NOW">${ar ? "ادفع الآن برابط آمن" : "Pay now by secure link"}</option>
    </select>
  </label>
  <div class="row">
    <label>${ar ? "اسم الضيف" : "Guest name"}
      <input type="text" name="guestName" value="${escapeHtml(guestName)}" placeholder="Guest name" />
    </label>
    <label>${ar ? "رقم واتساب" : "WhatsApp number"}
      <input type="tel" name="phone" value="${escapeHtml(phone)}" placeholder="9689XXXXXXX" />
    </label>
  </div>
  <label>${ar ? "طلبات خاصة" : "Special requests"}
    <textarea name="specialRequests" placeholder="Extra bed, late check-in, meal preference, airport transfer..."></textarea>
  </label>
  <button type="submit">${ar ? "تأكيد الحجز" : "Confirm Booking"}</button>
  <p class="muted">${ar ? "تفضل التقويم؟" : "Prefer a calendar view?"} <a href="/guest/calendar?hotelId=${encodeURIComponent(hotel.id)}${token ? `&token=${encodeURIComponent(token)}` : ""}">${ar ? "افتح التقويم" : "Open calendar"}</a></p>
</form>`;
  res.type("html").send(guestLayout(content, lang));
});

guestRouter.post("/book", async (req, res) => {
  const token = String(req.body.token ?? "").trim();
  const hotelIdBody = String(req.body.hotelId ?? "").trim();
  const adults = parseIntSafe(req.body.adults, 2, 1, 16);
  const children = parseIntSafe(req.body.children, 0, 0, 12);
  const guests = adults + children;
  const rooms = parseIntSafe(req.body.rooms, 1, 1, 6);
  const roomTypeId = String(req.body.roomTypeId ?? "").trim();
  const guestName = String(req.body.guestName ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  const specialRequests = String(req.body.specialRequests ?? "").trim().slice(0, 500);
  const checkInRaw = String(req.body.checkIn ?? "").trim();
  const checkOutRaw = String(req.body.checkOut ?? "").trim();
  const lang: "en" | "ar" = req.body.lang === "ar" ? "ar" : "en";
  const ar = lang === "ar";
  const mealPlan = normalizeMealPlan(req.body.mealPlan);
  const paymentPreference = String(req.body.paymentPreference ?? "PAY_LATER") === "PAY_NOW" ? "PAY_NOW" : "PAY_LATER";

  let hotelId = hotelIdBody;
  let sessionGuestId: string | undefined;
  let sessionPhone = normalizePhone(phone);
  try {
    if (token) {
      const session = await resolveCalendarSession(token);
      hotelId = session.hotelId;
      sessionGuestId = session.guestId ?? undefined;
      if (!sessionPhone) sessionPhone = normalizePhone(session.phoneE164);
    }
  } catch (calendarError) {
    const message = calendarError instanceof Error ? calendarError.message : "Invalid booking session";
    res.redirect(`/guest/book?${new URLSearchParams({ hotelId, error: message }).toString()}`);
    return;
  }

  const hotel = hotelId
    ? await prisma.hotel.findUnique({ where: { id: hotelId } })
    : await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } });
  if (!hotel) {
    res.redirect("/guest/book?error=Hotel+not+found");
    return;
  }

  const checkIn = new Date(`${checkInRaw}T00:00:00.000Z`);
  const checkOut = new Date(`${checkOutRaw}T00:00:00.000Z`);
  if (!checkInRaw || !checkOutRaw || Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime()) || checkOut <= checkIn) {
    const query = new URLSearchParams({ hotelId: hotel.id, error: "Please select valid check-in and check-out dates." });
    if (token) query.set("token", token);
    if (phone) query.set("phone", phone);
    if (guestName) query.set("guestName", guestName);
    res.redirect(`/guest/book?${query.toString()}`);
    return;
  }

  const offers = await findAvailableRoomTypes({ hotelId: hotel.id, checkIn, checkOut, guests, rooms, adults, children });
  const offer = (roomTypeId ? offers.find((item) => item.roomTypeId === roomTypeId) : undefined) ?? offers[0];
  if (!offer) {
    const query = new URLSearchParams({ hotelId: hotel.id, error: "Selected dates are not available. Please choose different dates." });
    if (token) query.set("token", token);
    if (phone) query.set("phone", phone);
    if (guestName) query.set("guestName", guestName);
    res.redirect(`/guest/book?${query.toString()}`);
    return;
  }

  const normalizedGuestPhone = sessionPhone || normalizePhone(phone);
  if (!normalizedGuestPhone) {
    const query = new URLSearchParams({
      hotelId: hotel.id,
      error: "Please enter your WhatsApp number so we can confirm the booking."
    });
    if (token) query.set("token", token);
    if (guestName) query.set("guestName", guestName);
    res.redirect(`/guest/book?${query.toString()}`);
    return;
  }

  const guest = sessionGuestId
    ? await prisma.guest.update({
        where: { id: sessionGuestId },
        data: { phoneE164: normalizedGuestPhone, ...(guestName ? { fullName: guestName } : {}) }
      })
    : await prisma.guest.upsert({
        where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: normalizedGuestPhone } },
        update: { ...(guestName ? { fullName: guestName } : {}) },
        create: { hotelId: hotel.id, phoneE164: normalizedGuestPhone, ...(guestName ? { fullName: guestName } : {}) }
      });

  const conversation =
    (await prisma.conversation.findFirst({
      where: { hotelId: hotel.id, guestId: guest.id, state: { in: ["NEW", "QUALIFYING", "QUOTED", "PAYMENT_PENDING", "CONFIRMED"] } },
      orderBy: { updatedAt: "desc" }
    })) ??
    (await prisma.conversation.create({
      data: { hotelId: hotel.id, guestId: guest.id, state: "QUALIFYING", lastMessageAt: new Date() }
    }));
  const draftState = {
    language: guest.locale || "en",
    stage: "CONFIRMED",
    guestName: guestName || guest.fullName || undefined,
    checkIn: toIsoDate(checkIn),
    checkOut: toIsoDate(checkOut),
    guestCount: guests,
    adultCount: adults,
    childCount: children,
    roomCount: rooms,
    suggestedRoomTypeId: offer.roomTypeId,
    suggestedRoomTypeName: offer.roomTypeName,
    suggestedPropertyId: offer.propertyId,
    nightlyRate: offer.nightlyTotal,
    nights: offer.nights,
    totalAmount: Number(
      (
        offer.total +
        computeMealPlanSurchargeForStay({ mealPlan, adults, children, nights: offer.nights, rooms })
      ).toFixed(2)
    ),
    bookingMealPlanCode: mealPlan,
    specialRequests
  };
  await saveConversationSession({
    hotelId: hotel.id,
    guestId: guest.id,
    conversationId: conversation.id,
    phoneE164: guest.phoneE164,
    state: draftState,
    ttlMs: 60 * 60 * 1000
  });
  await upsertBookingDraft({
    hotelId: hotel.id,
    guestId: guest.id,
    conversationId: conversation.id,
    currency: hotel.currency,
    source: "CHATASTAY_WEBSITE",
    state: draftState
  });

  const booking = await createConfirmedBookingAtomic({
    hotelId: hotel.id,
    guestId: guest.id,
    conversationId: conversation.id,
    checkIn,
    checkOut,
    guests,
    rooms,
    currency: hotel.currency,
    adults,
    children,
    preferredRoomTypeId: offer.roomTypeId,
    mealPlan,
    source: ChannelProvider.CHATASTAY_MARKETPLACE
  });
  const traveller = await getTravellerAccount(req);
  if (traveller && (!traveller.guestId || traveller.guestId === guest.id)) {
    await prisma.travellerAccount.update({
      where: { id: traveller.id },
      data: {
        guestId: guest.id,
        fullName: traveller.fullName ?? guest.fullName ?? guestName ?? undefined,
        phoneE164: guest.phoneE164,
        email: traveller.email
      }
    }).catch(() => undefined);
  }
  if (token) {
    const session = await resolveCalendarSession(token).catch(() => null);
    if (session) await markCalendarSessionUsed(session.id);
  }

  let paymentLink: string | null = null;
  if (paymentPreference === "PAY_NOW") {
    const payment = await createBookingPaymentLink({
      hotelId: hotel.id,
      hotelName: hotel.displayName,
      bookingId: booking.bookingId,
      guestEmail: guest.email,
      amount: booking.totalAmount,
      currency: hotel.currency,
      description: `${booking.roomCount} room(s), ${booking.roomTypeName}, ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)}`,
      source: "guest_mobile_booking"
    }).catch(() => null);
    paymentLink = payment?.paymentLinkUrl ?? null;
  }

  const guestDisplayName = guestName || guest.fullName || (ar ? "الضيف" : "Guest");
  const mealLabel =
    mealPlan === "BREAKFAST"
      ? ar
        ? "إفطار"
        : "Breakfast"
      : mealPlan === "HALF_BOARD"
        ? ar
          ? "نصف إقامة"
          : "Half board"
        : mealPlan === "FULL_BOARD"
          ? ar
            ? "إقامة كاملة"
            : "Full board"
          : ar
            ? "غرفة فقط"
            : "Room only";
  const confirmationMessage = ar
    ? [
        `تم تأكيد الحجز في ${hotel.displayName}.`,
        `اسم الضيف: ${guestDisplayName}`,
        `رقم الحجز: ${booking.bookingId}`,
        booking.bookingIds.length > 1 ? `أرقام الغرف/الحجوزات: ${booking.bookingIds.join(", ")}` : "",
        `نوع الغرفة: ${booking.roomTypeName}`,
        `الإقامة: ${toIsoDate(checkIn)} إلى ${toIsoDate(checkOut)} (${booking.nights} ليلة)`,
        `الضيوف: ${guests} (${adults} بالغ، ${children} طفل) | الغرف: ${booking.roomCount}`,
        `الوجبات: ${mealLabel}`,
        `الإجمالي: ${booking.totalAmount.toFixed(2)} ${hotel.currency}`,
        paymentLink ? `رابط الدفع الآمن: ${paymentLink}` : "يمكنك الدفع لاحقاً حسب سياسة الفندق.",
        specialRequests ? `طلباتك: ${specialRequests}` : "",
        "شكراً لك. تم استلام الحجز من فريق الفندق."
      ].filter(Boolean).join("\n")
    : [
        `Booking confirmed at ${hotel.displayName}.`,
        `Guest name: ${guestDisplayName}`,
        `Booking ID: ${booking.bookingId}`,
        booking.bookingIds.length > 1 ? `Linked room bookings: ${booking.bookingIds.join(", ")}` : "",
        `Room: ${booking.roomTypeName}`,
        `Stay: ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)} (${booking.nights} night${booking.nights > 1 ? "s" : ""})`,
        `Guests: ${guests} (${adults} adults, ${children} children) | Rooms: ${booking.roomCount}`,
        `Meal plan: ${mealLabel}`,
        `Total: ${booking.totalAmount.toFixed(2)} ${hotel.currency}`,
        paymentLink ? `Secure payment link: ${paymentLink}` : "Payment can be completed later according to hotel policy.",
        specialRequests ? `Requests received: ${specialRequests}` : "",
        "Thank you. The hotel team has received your booking."
      ].filter(Boolean).join("\n");
  const config = loadPartnerSetupConfig(hotel.id);
  await sendWhatsAppText({
    to: normalizePhone(guest.phoneE164),
    body: confirmationMessage,
    phoneNumberId: config.whatsappPhoneNumberId || undefined,
    conversationId: conversation.id
  }).catch(() => undefined);

  const content = `
<section class="hero-card">
  <h1>${ar ? "تم تأكيد الحجز" : "Booking Confirmed"}</h1>
  <p class="muted">${ar ? "تم تأكيد إقامتك. لا تحتاج إلى تأكيد إضافي في واتساب." : "Your stay is confirmed. No extra WhatsApp confirmation is needed."}</p>
</section>
<table>
  <tbody>
    <tr><th>${ar ? "اسم الضيف" : "Guest name"}</th><td>${escapeHtml(guestDisplayName)}</td></tr>
    <tr><th>${ar ? "رقم الحجز" : "Booking ID"}</th><td><strong>${escapeHtml(booking.bookingId)}</strong></td></tr>
    ${booking.bookingIds.length > 1 ? `<tr><th>${ar ? "الحجوزات المرتبطة" : "Linked bookings"}</th><td>${escapeHtml(booking.bookingIds.join(", "))}</td></tr>` : ""}
    <tr><th>${ar ? "الفندق" : "Hotel"}</th><td>${escapeHtml(hotel.displayName)}</td></tr>
    <tr><th>${ar ? "الوصول" : "Check-in"}</th><td>${escapeHtml(toIsoDate(checkIn))}</td></tr>
    <tr><th>${ar ? "المغادرة" : "Check-out"}</th><td>${escapeHtml(toIsoDate(checkOut))}</td></tr>
    <tr><th>${ar ? "الضيوف" : "Guests"}</th><td>${guests} (${adults} adults, ${children} children)</td></tr>
    <tr><th>${ar ? "الغرف" : "Rooms"}</th><td>${booking.roomCount}</td></tr>
    <tr><th>${ar ? "نوع الغرفة" : "Room"}</th><td>${escapeHtml(booking.roomTypeName)}</td></tr>
    <tr><th>${ar ? "خطة الوجبات" : "Meal plan"}</th><td>${escapeHtml(mealLabel)}</td></tr>
    <tr><th>${ar ? "الإجمالي" : "Total"}</th><td>${booking.totalAmount.toFixed(2)} ${escapeHtml(hotel.currency)}</td></tr>
  </tbody>
</table>
${paymentLink ? `<p style="margin-top:12px"><a class="inline-link" href="${escapeHtml(paymentLink)}">${ar ? "ادفع الآن" : "Pay now"}</a></p>` : `<p class="badge pending">${ar ? "تم اختيار الدفع لاحقاً." : "Pay later selected."}</p>`}
<p class="badge ok">${ar ? "تم إرسال نسخة إلى واتساب." : "A copy was sent to your WhatsApp."}</p>
<p class="muted">${ar ? "يرجى حفظ رقم الحجز عند الوصول." : "Please keep this booking ID for check-in."}</p>`;
  res.type("html").send(guestLayout(content, lang));
});

guestRouter.get("/calendar", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const hotelIdFromQuery = typeof req.query.hotelId === "string" ? req.query.hotelId.trim() : "";
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const guestName = typeof req.query.guestName === "string" ? req.query.guestName.trim() : "";
  const error = typeof req.query.error === "string" ? req.query.error.trim() : "";
  const month = monthStartFromRaw(typeof req.query.month === "string" ? req.query.month.trim() : undefined);
  const guests = parseIntSafe(req.query.guests, 2, 1, 16);
  const rooms = parseIntSafe(req.query.rooms, 1, 1, 6);

  let resolvedHotelId = hotelIdFromQuery;
  if (token) {
    try {
      const session = await resolveCalendarSession(token);
      resolvedHotelId = session.hotelId;
    } catch (sessionError) {
      const message = sessionError instanceof Error ? sessionError.message : "Invalid calendar session";
      const query = new URLSearchParams({ error: message });
      if (hotelIdFromQuery) query.set("hotelId", hotelIdFromQuery);
      res.redirect(`/guest/calendar?${query.toString()}`);
      return;
    }
  }

  const hotel =
    (resolvedHotelId
      ? await prisma.hotel.findUnique({ where: { id: resolvedHotelId } })
      : await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } })) ??
    (await prisma.hotel.findFirst({ orderBy: { createdAt: "asc" } }));
  if (!hotel) {
    res.type("html").send(guestLayout("<h1>Booking Calendar</h1><p class=\"badge alert\">No hotel found.</p>"));
    return;
  }

  const monthKey = formatMonthKey(month);
  const prevMonth = formatMonthKey(addMonths(month, -1));
  const nextMonth = formatMonthKey(addMonths(month, 1));
  const preserved = new URLSearchParams({
    hotelId: hotel.id,
    guests: String(guests),
    rooms: String(rooms),
    month: monthKey
  });
  if (token) preserved.set("token", token);
  if (phone) preserved.set("phone", phone);
  if (guestName) preserved.set("guestName", guestName);

  const content = `
<h1>Mini Booking Calendar</h1>
<p class="muted">This mini calendar only allows selectable available dates.</p>
${error ? `<p class="badge alert">${escapeHtml(error)}</p>` : ""}
<form method="get" action="/guest/calendar" class="calendar-form compact-controls" style="display:grid; gap:8px; margin-bottom:12px">
  <input type="hidden" name="hotelId" value="${escapeHtml(hotel.id)}" />
  ${token ? `<input type="hidden" name="token" value="${escapeHtml(token)}" />` : ""}
  <input type="hidden" name="month" value="${escapeHtml(monthKey)}" />
  <div class="row">
    <label>Guests
      <input type="number" name="guests" min="1" max="16" value="${guests}" />
    </label>
    <label>Rooms
      <input type="number" name="rooms" min="1" max="6" value="${rooms}" />
    </label>
  </div>
  <div class="calendar-head">
    <a href="/guest/calendar?${new URLSearchParams({ ...Object.fromEntries(preserved.entries()), month: prevMonth }).toString()}" class="inline-link">Previous month</a>
    <a href="/guest/calendar?${new URLSearchParams({ ...Object.fromEntries(preserved.entries()), month: nextMonth }).toString()}" class="inline-link">Next month</a>
  </div>
  <button type="submit">Refresh availability</button>
</form>
<section class="mini-chat-wrap">
  <article class="mini-bubble mini-bubble-out">How about we meet at your selected stay dates?</article>
  <article class="mini-bubble mini-bubble-card">
    <section
      id="calendar-root"
      class="calendar-shell mini-calendar-shell"
      data-month="${escapeHtml(monthKey)}"
      data-token="${escapeHtml(token)}"
      data-hotel-id="${escapeHtml(hotel.id)}"
      data-guests="${guests}"
      data-rooms="${rooms}"
    ></section>
  </article>
</section>
<form id="select-form" method="post" action="/guest/calendar/select" class="calendar-form" style="display:grid; gap:8px; margin-top:12px">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <input type="hidden" name="hotelId" value="${escapeHtml(hotel.id)}" />
  <input type="hidden" name="month" value="${escapeHtml(monthKey)}" />
  <input type="hidden" name="checkIn" id="checkInInput" />
  <input type="hidden" name="checkOut" id="checkOutInput" />
  <input type="hidden" name="guests" value="${guests}" />
  <input type="hidden" name="rooms" value="${rooms}" />
  <input type="hidden" name="guestName" value="${escapeHtml(guestName)}" />
  <input type="hidden" name="phone" value="${escapeHtml(phone)}" />
  <div class="row">
    <label>Your name (optional)
      <input type="text" name="guestName" value="${escapeHtml(guestName)}" placeholder="Ahmed" />
    </label>
    <label>Your phone (optional)
      <input type="text" name="phone" value="${escapeHtml(phone)}" placeholder="9689XXXXXXX" />
    </label>
  </div>
  <p id="selectionText" class="selection-card muted">Select check-in and check-out dates.</p>
  <button type="submit" id="continueBtn" disabled>Continue to WhatsApp</button>
</form>`;
  res.type("html").send(guestLayout(content));
});

guestRouter.get("/calendar/availability", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const hotelIdFromQuery = typeof req.query.hotelId === "string" ? req.query.hotelId.trim() : "";
  const guests = parseIntSafe(req.query.guests, 2, 1, 16);
  const rooms = parseIntSafe(req.query.rooms, 1, 1, 6);
  const monthStart = monthStartFromRaw(typeof req.query.month === "string" ? req.query.month.trim() : undefined);

  let hotelId = hotelIdFromQuery;
  if (token) {
    try {
      const session = await resolveCalendarSession(token);
      hotelId = session.hotelId;
    } catch {
      res.status(400).json({ error: "Invalid calendar token" });
      return;
    }
  }
  if (!hotelId) {
    const fallbackHotel = await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } });
    hotelId = fallbackHotel?.id ?? "";
  }
  if (!hotelId) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }

  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const days = await Promise.all(
    Array.from({ length: 42 }, async (_, idx) => {
      const date = addDays(gridStart, idx);
      const inMonth = date.getMonth() === monthStart.getMonth();
      if (!inMonth) {
        return { date: toIsoDate(date), day: date.getDate(), inMonth, available: false };
      }
      const availability = await getDayAvailability({ hotelId, date, guests, rooms });
      return {
        date: availability.date,
        day: date.getDate(),
        inMonth: true,
        available: availability.available,
        cheapestRate: availability.cheapestRate ?? null,
        reason: availability.reason ?? null
      };
    })
  );
  const monthLabel = monthStart.toLocaleString("en", { month: "long", year: "numeric" });
  res.json({ month: formatMonthKey(monthStart), monthLabel, days });
});

guestRouter.post("/calendar/select", async (req, res) => {
  const token = String(req.body.token ?? "").trim();
  const hotelIdBody = String(req.body.hotelId ?? "").trim();
  const guests = parseIntSafe(req.body.guests, 2, 1, 16);
  const rooms = parseIntSafe(req.body.rooms, 1, 1, 6);
  const guestName = String(req.body.guestName ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  const checkInRaw = String(req.body.checkIn ?? "").trim();
  const checkOutRaw = String(req.body.checkOut ?? "").trim();
  const month = String(req.body.month ?? "").trim();

  let hotelId = hotelIdBody;
  let sessionGuestId: string | undefined;
  let sessionPhone = normalizePhone(phone);
  try {
    if (token) {
      const session = await resolveCalendarSession(token);
      hotelId = session.hotelId;
      sessionGuestId = session.guestId ?? undefined;
      if (!sessionPhone) sessionPhone = normalizePhone(session.phoneE164);
    }
  } catch (calendarError) {
    const message = calendarError instanceof Error ? calendarError.message : "Invalid calendar session";
    const query = new URLSearchParams({ hotelId, guests: String(guests), rooms: String(rooms), month, error: message });
    res.redirect(`/guest/calendar?${query.toString()}`);
    return;
  }

  const hotel = hotelId
    ? await prisma.hotel.findUnique({ where: { id: hotelId } })
    : await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } });
  if (!hotel) {
    res.redirect("/guest/calendar?error=Hotel+not+found");
    return;
  }

  const checkIn = new Date(checkInRaw);
  const checkOut = new Date(checkOutRaw);
  if (!checkInRaw || !checkOutRaw || Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime()) || checkOut <= checkIn) {
    const query = new URLSearchParams({
      hotelId: hotel.id,
      guests: String(guests),
      rooms: String(rooms),
      month,
      error: "Please select valid check-in and check-out dates."
    });
    if (token) query.set("token", token);
    if (phone) query.set("phone", phone);
    if (guestName) query.set("guestName", guestName);
    res.redirect(`/guest/calendar?${query.toString()}`);
    return;
  }

  const offer = await findAvailableRoomType({
    hotelId: hotel.id,
    checkIn,
    checkOut,
    guests,
    rooms
  });
  if (!offer) {
    const query = new URLSearchParams({
      hotelId: hotel.id,
      guests: String(guests),
      rooms: String(rooms),
      month,
      error: "Selected dates are no longer available. Please choose different dates."
    });
    if (token) query.set("token", token);
    if (phone) query.set("phone", phone);
    if (guestName) query.set("guestName", guestName);
    res.redirect(`/guest/calendar?${query.toString()}`);
    return;
  }

  const normalizedGuestPhone = sessionPhone || normalizePhone(phone);
  const guest =
    (sessionGuestId
      ? await prisma.guest.findUnique({ where: { id: sessionGuestId } })
      : normalizedGuestPhone
        ? await prisma.guest.upsert({
            where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: normalizedGuestPhone } },
            update: { ...(guestName ? { fullName: guestName } : {}) },
            create: { hotelId: hotel.id, phoneE164: normalizedGuestPhone, ...(guestName ? { fullName: guestName } : {}) }
          })
        : null) ??
    null;

  let conversationId: string | undefined;
  if (guest) {
    const conversation =
      (await prisma.conversation.findFirst({
        where: { hotelId: hotel.id, guestId: guest.id, state: { in: ["NEW", "QUALIFYING", "QUOTED", "PAYMENT_PENDING", "CONFIRMED"] } },
        orderBy: { updatedAt: "desc" }
      })) ??
      (await prisma.conversation.create({
        data: { hotelId: hotel.id, guestId: guest.id, state: "QUALIFYING", lastMessageAt: new Date() }
      }));
    conversationId = conversation.id;

    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId,
      phoneE164: guest.phoneE164,
      state: {
        language: guest.locale || "en",
        stage: "WAITING_CONFIRMATION",
        guestName: guestName || guest.fullName || undefined,
        checkIn: toIsoDate(checkIn),
        checkOut: toIsoDate(checkOut),
        guestCount: guests,
        roomCount: rooms,
        suggestedRoomTypeId: offer.roomTypeId,
        suggestedRoomTypeName: offer.roomTypeName,
        suggestedPropertyId: offer.propertyId,
        nightlyRate: offer.nightlyTotal,
        nights: offer.nights,
        totalAmount: offer.total
      },
      ttlMs: 60 * 60 * 1000
    });
    await upsertBookingDraft({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId,
      currency: hotel.currency,
      source: "WEB_CALENDAR",
      state: {
        language: guest.locale || "en",
        stage: "WAITING_CONFIRMATION",
        guestName: guestName || guest.fullName || undefined,
        checkIn: toIsoDate(checkIn),
        checkOut: toIsoDate(checkOut),
        guestCount: guests,
        roomCount: rooms,
        suggestedRoomTypeId: offer.roomTypeId,
        suggestedRoomTypeName: offer.roomTypeName,
        suggestedPropertyId: offer.propertyId,
        nightlyRate: offer.nightlyTotal,
        nights: offer.nights,
        totalAmount: offer.total
      }
    });
  }

  if (token) {
    const session = await resolveCalendarSession(token).catch(() => null);
    if (session) {
      await markCalendarSessionUsed(session.id);
    }
  }

  const summaryMessage = [
    `Great choice. I found availability for ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)}.`,
    `Room: ${offer.roomTypeName}`,
    `Guests: ${guests} | Rooms: ${rooms}`,
    `Total: ${offer.total.toFixed(2)} ${hotel.currency}`,
    "Reply with YES to confirm or NO to edit."
  ].join("\n");
  if (guest) {
    const config = loadPartnerSetupConfig(hotel.id);
    try {
      await sendWhatsAppButtons({
        to: normalizePhone(guest.phoneE164),
        body: summaryMessage,
        buttons: [
          { id: "confirm_booking", title: "Confirm" },
          { id: "edit_booking", title: "Edit" }
        ],
        phoneNumberId: config.whatsappPhoneNumberId || undefined
      });
    } catch {
      await sendWhatsAppText({
        to: normalizePhone(guest.phoneE164),
        body: summaryMessage,
        phoneNumberId: config.whatsappPhoneNumberId || undefined
      });
    }
  }

  const waHotelPhone = normalizePhone(hotel.whatsappPhone ?? "");
  const waLink = waHotelPhone
    ? `https://wa.me/${encodeURIComponent(waHotelPhone)}?text=${encodeURIComponent(`I selected ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)} for ${guests} guests and ${rooms} room${rooms > 1 ? "s" : ""}.`)}` 
    : "";
  const content = `
<h1>Dates Selected</h1>
<p class="muted">Your calendar selection is saved. Continue in WhatsApp to confirm.</p>
<table>
  <tbody>
    <tr><th>Hotel</th><td>${escapeHtml(hotel.displayName)}</td></tr>
    <tr><th>Check-in</th><td>${escapeHtml(toIsoDate(checkIn))}</td></tr>
    <tr><th>Check-out</th><td>${escapeHtml(toIsoDate(checkOut))}</td></tr>
    <tr><th>Room</th><td>${escapeHtml(offer.roomTypeName)}</td></tr>
    <tr><th>Total</th><td>${offer.total.toFixed(2)} ${escapeHtml(hotel.currency)}</td></tr>
  </tbody>
</table>
${waLink
    ? `<p style="margin-top:12px"><a href="${waLink}" style="display:inline-block; padding:10px 14px; border-radius:8px; background:#0b6e6e; color:#fff; text-decoration:none; font-weight:700">Open WhatsApp</a></p>`
    : `<p class="badge pending">Hotel WhatsApp number is not configured. Please continue in your existing WhatsApp chat.</p>`}
<p><a href="/guest/calendar?hotelId=${encodeURIComponent(hotel.id)}${token ? `&token=${encodeURIComponent(token)}` : ""}">Back to calendar</a></p>`;
  res.type("html").send(guestLayout(content));
});

