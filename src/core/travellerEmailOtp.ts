import crypto from "node:crypto";
import { prisma } from "../db";
import { hashToken } from "./authSecurity";
import { sendEmail, isEmailConfigured } from "./email";
import { buildTravellerVerificationCodeEmail } from "./emailTemplates";

export const TRAVELLER_EMAIL_OTP_TTL_MS = 15 * 60 * 1000;
export const TRAVELLER_EMAIL_OTP_MAX_ATTEMPTS = 6;
export const TRAVELLER_PRE_REG_VERIFIED_TTL_MS = 30 * 60 * 1000;

const otpRateLimitWindowMs = 15 * 60 * 1000;
const otpRateLimitMax = 8;
const otpSendRateLimit = new Map<string, number[]>();

type PendingPreRegOtp = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  plainCodeForTests?: string;
};

const pendingPreRegOtpByEmail = new Map<string, PendingPreRegOtp>();
const accountOtpPlainForTests = new Map<string, string>();

export type IssueTravellerOtpResult =
  | { sent: true }
  | { sent: false; reason: "not_eligible" | "email_not_configured" | "rate_limited" | "send_failed" };

export type VerifyTravellerOtpResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "too_many_attempts" | "not_found" };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function otpRateLimitKey(scope: string, email: string, ip?: string): string {
  return `${scope}:${normalizeEmail(email)}:${ip ?? "unknown"}`;
}

function isOtpSendRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (otpSendRateLimit.get(key) ?? []).filter((at) => now - at <= otpRateLimitWindowMs);
  hits.push(now);
  otpSendRateLimit.set(key, hits);
  return hits.length > otpRateLimitMax;
}

export function generateTravellerEmailOtpCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashTravellerEmailOtpCode(code: string): string {
  return hashToken(code.replace(/\D/g, "").trim());
}

function sessionSecret(): string {
  return process.env.TRAVELLER_SESSION_SECRET ?? process.env.ADMIN_SESSION_SECRET ?? "dev-traveller-secret";
}

export function signPreRegistrationVerifiedEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const exp = Date.now() + TRAVELLER_PRE_REG_VERIFIED_TTL_MS;
  const payload = `${normalized}.${exp}`;
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function readPreRegistrationVerifiedEmail(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const email = parts[0] ?? "";
  const exp = Number(parts[1]);
  if (!email || !Number.isFinite(exp) || exp <= Date.now()) return null;
  const payload = `${email}.${exp}`;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts[2] ?? "", "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return email;
}

async function sendTravellerOtpEmail(params: {
  to: string;
  code: string;
  fullName?: string | null;
  expiresMinutes: number;
}): Promise<void> {
  const message = buildTravellerVerificationCodeEmail({
    code: params.code,
    fullName: params.fullName,
    expiresMinutes: params.expiresMinutes
  });
  await sendEmail({
    to: params.to,
    subject: "Your ChatAstay verification code",
    html: message.html,
    text: message.text
  });
}

export async function issueTravellerEmailOtpForAccount(
  accountId: string,
  opts?: { ip?: string }
): Promise<IssueTravellerOtpResult> {
  const account = await prisma.travellerAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, fullName: true, isActive: true, emailVerifiedAt: true }
  });
  if (!account?.isActive || !account.email || account.emailVerifiedAt) {
    return { sent: false, reason: "not_eligible" };
  }
  if (isOtpSendRateLimited(otpRateLimitKey("account", account.email, opts?.ip))) {
    return { sent: false, reason: "rate_limited" };
  }
  if (!isEmailConfigured()) {
    return { sent: false, reason: "email_not_configured" };
  }

  const code = generateTravellerEmailOtpCode();
  const codeHash = hashTravellerEmailOtpCode(code);
  const expiresAt = new Date(Date.now() + TRAVELLER_EMAIL_OTP_TTL_MS);
  await prisma.travellerAccount.update({
    where: { id: account.id },
    data: {
      emailVerificationTokenHash: codeHash,
      emailVerificationExpiresAt: expiresAt
    }
  });

  if (process.env.NODE_ENV === "test") accountOtpPlainForTests.set(account.id, code);

  try {
    await sendTravellerOtpEmail({
      to: account.email,
      code,
      fullName: account.fullName,
      expiresMinutes: Math.round(TRAVELLER_EMAIL_OTP_TTL_MS / 60_000)
    });
    return { sent: true };
  } catch (err) {
    console.error(
      "[TravellerAuth] Verification code email failed:",
      err instanceof Error ? err.message : err
    );
    return { sent: false, reason: "send_failed" };
  }
}

export async function verifyTravellerEmailOtpForAccount(
  accountId: string,
  rawCode: string
): Promise<VerifyTravellerOtpResult> {
  const code = rawCode.replace(/\D/g, "").trim();
  if (code.length !== 6) return { ok: false, reason: "missing" };

  const account = await prisma.travellerAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      isActive: true,
      emailVerifiedAt: true,
      emailVerificationTokenHash: true,
      emailVerificationExpiresAt: true
    }
  });
  if (!account?.isActive) return { ok: false, reason: "not_found" };
  if (account.emailVerifiedAt) return { ok: true };

  if (!account.emailVerificationTokenHash || !account.emailVerificationExpiresAt) {
    return { ok: false, reason: "invalid" };
  }
  if (account.emailVerificationExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const codeHash = hashTravellerEmailOtpCode(code);
  if (codeHash !== account.emailVerificationTokenHash) {
    return { ok: false, reason: "invalid" };
  }

  await prisma.travellerAccount.update({
    where: { id: account.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null
    }
  });
  return { ok: true };
}

export async function issueTravellerEmailOtpForPreRegistration(
  email: string,
  opts?: { ip?: string }
): Promise<IssueTravellerOtpResult> {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    return { sent: false, reason: "not_eligible" };
  }

  const existing = await prisma.travellerAccount.findUnique({
    where: { email: normalized },
    select: { id: true, isActive: true }
  });
  if (existing?.isActive) {
    return { sent: false, reason: "not_eligible" };
  }

  if (isOtpSendRateLimited(otpRateLimitKey("prereg", normalized, opts?.ip))) {
    return { sent: false, reason: "rate_limited" };
  }
  if (!isEmailConfigured()) {
    return { sent: false, reason: "email_not_configured" };
  }

  const code = generateTravellerEmailOtpCode();
  const codeHash = hashTravellerEmailOtpCode(code);
  const pending: PendingPreRegOtp = {
    codeHash,
    expiresAt: Date.now() + TRAVELLER_EMAIL_OTP_TTL_MS,
    attempts: 0
  };
  if (process.env.NODE_ENV === "test") pending.plainCodeForTests = code;
  pendingPreRegOtpByEmail.set(normalized, pending);

  try {
    await sendTravellerOtpEmail({
      to: normalized,
      code,
      expiresMinutes: Math.round(TRAVELLER_EMAIL_OTP_TTL_MS / 60_000)
    });
    return { sent: true };
  } catch (err) {
    pendingPreRegOtpByEmail.delete(normalized);
    console.error(
      "[TravellerAuth] Pre-registration verification code failed:",
      err instanceof Error ? err.message : err
    );
    return { sent: false, reason: "send_failed" };
  }
}

export function verifyTravellerEmailOtpForPreRegistration(email: string, rawCode: string): VerifyTravellerOtpResult {
  const normalized = normalizeEmail(email);
  const code = rawCode.replace(/\D/g, "").trim();
  if (!normalized || code.length !== 6) return { ok: false, reason: "missing" };

  const pending = pendingPreRegOtpByEmail.get(normalized);
  if (!pending) return { ok: false, reason: "invalid" };
  if (pending.expiresAt <= Date.now()) {
    pendingPreRegOtpByEmail.delete(normalized);
    return { ok: false, reason: "expired" };
  }

  pending.attempts += 1;
  if (pending.attempts > TRAVELLER_EMAIL_OTP_MAX_ATTEMPTS) {
    pendingPreRegOtpByEmail.delete(normalized);
    return { ok: false, reason: "too_many_attempts" };
  }

  const codeHash = hashTravellerEmailOtpCode(code);
  if (codeHash !== pending.codeHash) {
    return { ok: false, reason: "invalid" };
  }

  pendingPreRegOtpByEmail.delete(normalized);
  return { ok: true };
}

/** Test helper: last issued OTP (non-production test runs only). */
export function peekTravellerEmailOtpForTests(input: { email?: string; accountId?: string }): string | null {
  if (process.env.NODE_ENV === "production") return null;
  if (input.accountId) return accountOtpPlainForTests.get(input.accountId) ?? null;
  if (input.email) return pendingPreRegOtpByEmail.get(normalizeEmail(input.email))?.plainCodeForTests ?? null;
  return null;
}
