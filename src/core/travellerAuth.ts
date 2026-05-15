import type { Request } from "express";
import { prisma } from "../db";
import { generateSecureToken, hashPassword } from "./authSecurity";
import {
  accountKindRequiresEmailVerification,
  hashVerificationToken,
  isAccountEmailVerified,
  isVerificationResendRateLimited,
  issueAccountVerificationEmail,
  verifyAccountEmailToken
} from "./accountEmailVerification";
import { sendEmail, isEmailConfigured } from "./email";
import { buildTravellerPasswordResetEmail } from "./emailTemplates";

const passwordResetTtlMs = 15 * 60 * 1000;
const resetRequestRateLimitWindowMs = 15 * 60 * 1000;
const resetRequestRateLimitMax = 8;
const resetRequestRateLimit = new Map<string, number[]>();

export { isEmailConfigured };

export function getTravellerAppBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function travellerRequireEmailVerification(): boolean {
  return accountKindRequiresEmailVerification("traveller");
}

export function isTravellerEmailVerified(account: { emailVerifiedAt: Date | null }): boolean {
  return isAccountEmailVerified(account);
}

export function isTravellerVerificationResendRateLimited(req: Request, accountId: string): boolean {
  return isVerificationResendRateLimited(req, `traveller:${accountId}`);
}

export async function issueTravellerVerificationEmail(
  accountId: string
): Promise<{ sent: boolean; verifyLink?: string; reason?: string }> {
  return issueAccountVerificationEmail("traveller", accountId);
}

export async function verifyTravellerEmailToken(rawToken: string): Promise<{ ok: boolean; reason?: string }> {
  const result = await verifyAccountEmailToken("traveller", rawToken);
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason };
}

function hashAuthToken(token: string): string {
  return hashVerificationToken(token);
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
