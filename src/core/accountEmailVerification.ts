import type { Request } from "express";
import { prisma } from "../db";
import { generateSecureToken, hashToken } from "./authSecurity";
import { isEmailConfigured, sendEmail } from "./email";
import { buildTravellerVerificationEmail } from "./emailTemplates";

/** Account kinds that can use the shared email-verification pipeline. */
export type AccountVerificationKind = "traveller" | "hotel_user" | "partner";

export type VerifyEmailTokenResult =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "invalid" | "expired" | "not_supported" };

export type IssueVerificationEmailResult = {
  sent: boolean;
  verifyLink?: string;
  reason?: "not_eligible" | "email_not_configured" | "send_failed" | "not_supported";
};

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const EMAIL_VERIFICATION_TTL_HOURS = 24;

const verificationResendRateLimitWindowMs = 15 * 60 * 1000;
const verificationResendRateLimitMax = 6;
const verificationResendRateLimit = new Map<string, number[]>();

export function getAppBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function hashVerificationToken(token: string): string {
  return hashToken(token.trim());
}

export function isAccountEmailVerified(account: { emailVerifiedAt: Date | null }): boolean {
  return Boolean(account.emailVerifiedAt);
}

function verificationResendRateLimitKey(req: Request, scope: string): string {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || "unknown";
  return `${scope}:${ip}`;
}

/** Rate-limit verification resend per IP + account scope (traveller id, hotel user id, etc.). */
export function isVerificationResendRateLimited(req: Request, scope: string): boolean {
  const key = verificationResendRateLimitKey(req, scope);
  const now = Date.now();
  const hits = (verificationResendRateLimit.get(key) ?? []).filter((at) => now - at <= verificationResendRateLimitWindowMs);
  hits.push(now);
  verificationResendRateLimit.set(key, hits);
  return hits.length > verificationResendRateLimitMax;
}

export type AccountVerificationProfile = {
  kind: AccountVerificationKind;
  /** Schema + routes wired for this kind. */
  supported: boolean;
  verifyPath: string;
  logLabel: string;
};

export const accountVerificationProfiles: Record<AccountVerificationKind, AccountVerificationProfile> = {
  traveller: {
    kind: "traveller",
    supported: true,
    verifyPath: "/guest/account/verify-email",
    logLabel: "TravellerAuth"
  },
  hotel_user: {
    kind: "hotel_user",
    supported: false,
    verifyPath: "/admin/verify-email",
    logLabel: "HotelUserAuth"
  },
  partner: {
    kind: "partner",
    supported: false,
    verifyPath: "/partner/verify-email",
    logLabel: "PartnerAuth"
  }
};

export function buildVerificationUrl(kind: AccountVerificationKind, token: string): string {
  const profile = accountVerificationProfiles[kind];
  return `${getAppBaseUrl()}${profile.verifyPath}?token=${encodeURIComponent(token)}`;
}

type VerificationRecipient = {
  id: string;
  email: string;
  fullName: string | null;
  isActive: boolean;
  emailVerifiedAt: Date | null;
};

type VerificationTokenRow = {
  id: string;
  isActive: boolean;
  emailVerificationExpiresAt: Date | null;
};

type VerificationEmailContent = {
  subject: string;
  html: string;
  text: string;
};

type VerificationStore = {
  loadRecipientById: (id: string) => Promise<VerificationRecipient | null>;
  findByTokenHash: (tokenHash: string) => Promise<VerificationTokenRow | null>;
  persistToken: (id: string, tokenHash: string, expiresAt: Date) => Promise<void>;
  markVerified: (id: string) => Promise<void>;
  buildEmail: (input: { verifyLink: string; fullName: string | null }) => VerificationEmailContent;
};

const travellerVerificationStore: VerificationStore = {
  async loadRecipientById(id) {
    return prisma.travellerAccount.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        emailVerifiedAt: true
      }
    });
  },
  async findByTokenHash(tokenHash) {
    return prisma.travellerAccount.findFirst({
      where: { emailVerificationTokenHash: tokenHash },
      select: { id: true, isActive: true, emailVerificationExpiresAt: true }
    });
  },
  async persistToken(id, tokenHash, expiresAt) {
    await prisma.travellerAccount.update({
      where: { id },
      data: {
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: expiresAt
      }
    });
  },
  async markVerified(id) {
    await prisma.travellerAccount.update({
      where: { id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null
      }
    });
  },
  buildEmail(input) {
    const message = buildTravellerVerificationEmail({
      verifyLink: input.verifyLink,
      fullName: input.fullName,
      expiresHours: EMAIL_VERIFICATION_TTL_HOURS
    });
    return {
      subject: "Verify your ChatAstay traveller account",
      html: message.html,
      text: message.text
    };
  }
};

/**
 * Future: wire when HotelUser gains emailVerifiedAt + token fields (see partner onboarding).
 * Store should mirror travellerVerificationStore against prisma.hotelUser.
 */
const hotelUserVerificationStore: VerificationStore | null = null;

const verificationStores: Partial<Record<AccountVerificationKind, VerificationStore>> = {
  traveller: travellerVerificationStore,
  hotel_user: hotelUserVerificationStore ?? undefined,
  partner: undefined
};

export async function issueAccountVerificationEmail(
  kind: AccountVerificationKind,
  accountId: string
): Promise<IssueVerificationEmailResult> {
  const profile = accountVerificationProfiles[kind];
  if (!profile.supported) {
    return { sent: false, reason: "not_supported" };
  }
  const store = verificationStores[kind];
  if (!store) {
    return { sent: false, reason: "not_supported" };
  }

  const account = await store.loadRecipientById(accountId);
  if (!account?.isActive || !account.email || account.emailVerifiedAt) {
    return { sent: false, reason: "not_eligible" };
  }

  const token = generateSecureToken();
  const tokenHash = hashVerificationToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  await store.persistToken(account.id, tokenHash, expiresAt);

  const verifyLink = buildVerificationUrl(kind, token);
  if (!isEmailConfigured()) {
    console.info(`[${profile.logLabel}] Email not configured — verification link:`, verifyLink);
    return { sent: false, verifyLink, reason: "email_not_configured" };
  }

  try {
    const message = store.buildEmail({ verifyLink, fullName: account.fullName });
    await sendEmail({
      to: account.email,
      subject: message.subject,
      html: message.html,
      text: message.text
    });
    return { sent: true };
  } catch (err) {
    console.error(
      `[${profile.logLabel}] Verification email failed:`,
      err instanceof Error ? err.message : err
    );
    return { sent: false, verifyLink, reason: "send_failed" };
  }
}

export async function verifyAccountEmailToken(
  kind: AccountVerificationKind,
  rawToken: string
): Promise<VerifyEmailTokenResult> {
  const profile = accountVerificationProfiles[kind];
  if (!profile.supported) {
    return { ok: false, reason: "not_supported" };
  }
  const store = verificationStores[kind];
  if (!store) {
    return { ok: false, reason: "not_supported" };
  }

  const token = rawToken.trim();
  if (!token) return { ok: false, reason: "missing_token" };

  const tokenHash = hashVerificationToken(token);
  const account = await store.findByTokenHash(tokenHash);
  if (!account?.isActive) return { ok: false, reason: "invalid" };
  if (!account.emailVerificationExpiresAt || account.emailVerificationExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  await store.markVerified(account.id);
  return { ok: true };
}

/** Per-kind policy for whether new accounts must verify email before full access. */
export function accountKindRequiresEmailVerification(kind: AccountVerificationKind): boolean {
  if (kind === "traveller") {
    if (process.env.TRAVELLER_REQUIRE_EMAIL_VERIFICATION === "false") return false;
    if (process.env.TRAVELLER_REQUIRE_EMAIL_VERIFICATION === "true") return true;
    if (!isEmailConfigured() && process.env.NODE_ENV !== "production") return false;
    return true;
  }
  if (kind === "hotel_user") {
    if (process.env.HOTEL_USER_REQUIRE_EMAIL_VERIFICATION !== "true") return false;
    return isEmailConfigured();
  }
  if (kind === "partner") {
    if (process.env.PARTNER_REQUIRE_EMAIL_VERIFICATION !== "true") return false;
    return isEmailConfigured();
  }
  return false;
}
