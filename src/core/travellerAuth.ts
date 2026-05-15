import type { Request } from "express";
import { prisma } from "../db";
import { generateSecureToken, hashPassword, hashToken } from "./authSecurity";
import { sendEmail, isEmailConfigured } from "./email";
import { buildTravellerPasswordResetEmail, buildTravellerVerificationEmail } from "./emailTemplates";

const passwordResetTtlMs = 15 * 60 * 1000;
const verificationTtlMs = 24 * 60 * 60 * 1000;
const resetRequestRateLimitWindowMs = 15 * 60 * 1000;
const resetRequestRateLimitMax = 8;
const resetRequestRateLimit = new Map<string, number[]>();

export { isEmailConfigured };

export function getTravellerAppBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** When false, new signups are auto-verified (e.g. local dev without email). */
export function travellerRequireEmailVerification(): boolean {
  if (process.env.TRAVELLER_REQUIRE_EMAIL_VERIFICATION === "false") return false;
  if (!isEmailConfigured() && process.env.NODE_ENV !== "production") return false;
  return true;
}

function hashAuthToken(token: string): string {
  return hashToken(token);
}

function resetRateLimitKey(req: Request, email: string): string {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || "unknown";
  return `${ip}:${email}`;
}

function isResetRateLimited(req: Request, email: string): boolean {
  const key = resetRateLimitKey(req, email);
  const now = Date.now();
  const hits = (resetRequestRateLimit.get(key) ?? []).filter((at) => now - at <= resetRequestRateLimitWindowMs);
  hits.push(now);
  resetRequestRateLimit.set(key, hits);
  return hits.length > resetRequestRateLimitMax;
}

export function isTravellerEmailVerified(account: { emailVerifiedAt: Date | null }): boolean {
  return Boolean(account.emailVerifiedAt);
}

export async function issueTravellerVerificationEmail(
  accountId: string
): Promise<{ sent: boolean; verifyLink?: string; reason?: string }> {
  const account = await prisma.travellerAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, fullName: true, isActive: true, emailVerifiedAt: true }
  });
  if (!account?.isActive || !account.email || account.emailVerifiedAt) {
    return { sent: false, reason: "not_eligible" };
  }

  const token = generateSecureToken();
  const tokenHash = hashAuthToken(token);
  const expiresAt = new Date(Date.now() + verificationTtlMs);
  await prisma.travellerAccount.update({
    where: { id: account.id },
    data: {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: expiresAt
    }
  });

  const verifyLink = `${getTravellerAppBaseUrl()}/guest/account/verify-email?token=${encodeURIComponent(token)}`;
  if (!isEmailConfigured()) {
    console.info("[TravellerAuth] Email not configured — verification link:", verifyLink);
    return { sent: false, verifyLink, reason: "email_not_configured" };
  }

  try {
    const message = buildTravellerVerificationEmail({
      verifyLink,
      fullName: account.fullName,
      expiresHours: 24
    });
    await sendEmail({
      to: account.email,
      subject: "Verify your ChatAstay traveller account",
      html: message.html,
      text: message.text
    });
    return { sent: true };
  } catch (err) {
    console.error("[TravellerAuth] Verification email failed:", err instanceof Error ? err.message : err);
    return { sent: false, verifyLink, reason: "send_failed" };
  }
}

export async function verifyTravellerEmailToken(rawToken: string): Promise<{ ok: boolean; reason?: string }> {
  const token = rawToken.trim();
  if (!token) return { ok: false, reason: "missing_token" };
  const tokenHash = hashAuthToken(token);
  const account = await prisma.travellerAccount.findFirst({
    where: { emailVerificationTokenHash: tokenHash },
    select: { id: true, isActive: true, emailVerificationExpiresAt: true }
  });
  if (!account?.isActive) return { ok: false, reason: "invalid" };
  if (!account.emailVerificationExpiresAt || account.emailVerificationExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
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

export async function requestTravellerPasswordReset(email: string, req: Request): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || isResetRateLimited(req, normalized)) return;

  const account = await prisma.travellerAccount.findUnique({
    where: { email: normalized },
    select: { id: true, email: true, isActive: true }
  });
  if (!account?.isActive || !account.email) return;

  const token = generateSecureToken();
  const tokenHash = hashAuthToken(token);
  const expiresAt = new Date(Date.now() + passwordResetTtlMs);
  await prisma.travellerAccount.update({
    where: { id: account.id },
    data: {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
      passwordResetRequestedAt: new Date()
    }
  });

  const resetLink = `${getTravellerAppBaseUrl()}/guest/account/reset-password?token=${encodeURIComponent(token)}`;
  if (!isEmailConfigured()) {
    console.info("[TravellerAuth] Email not configured — password reset link:", resetLink);
    return;
  }

  try {
    const message = buildTravellerPasswordResetEmail({ resetLink, expiresMinutes: 15 });
    await sendEmail({
      to: account.email,
      subject: "Reset your ChatAstay traveller password",
      html: message.html,
      text: message.text
    });
  } catch (err) {
    console.error("[TravellerAuth] Password reset email failed:", err instanceof Error ? err.message : err);
  }
}

export async function consumeTravellerPasswordReset(
  rawToken: string,
  newPassword: string,
  confirmPassword: string
): Promise<{ ok: boolean; reason?: string }> {
  if (newPassword.length < 8 || newPassword !== confirmPassword) {
    return { ok: false, reason: "password_mismatch" };
  }
  const tokenHash = hashAuthToken(rawToken.trim());
  const account = await prisma.travellerAccount.findFirst({
    where: { passwordResetTokenHash: tokenHash },
    select: { id: true, isActive: true, passwordResetExpiresAt: true }
  });
  if (!account?.isActive) return { ok: false, reason: "invalid" };
  if (!account.passwordResetExpiresAt || account.passwordResetExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  await prisma.travellerAccount.update({
    where: { id: account.id },
    data: {
      passwordHash: await hashPassword(newPassword),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      passwordResetRequestedAt: null
    }
  });
  return { ok: true };
}

export function travellerPasswordResetTokenValid(rawToken: string): Promise<boolean> {
  const token = rawToken.trim();
  if (!token) return Promise.resolve(false);
  const tokenHash = hashAuthToken(token);
  return prisma.travellerAccount
    .findFirst({
      where: { passwordResetTokenHash: tokenHash },
      select: { isActive: true, passwordResetExpiresAt: true }
    })
    .then(
      (row) => Boolean(row?.isActive && row.passwordResetExpiresAt && row.passwordResetExpiresAt.getTime() > Date.now())
    );
}
