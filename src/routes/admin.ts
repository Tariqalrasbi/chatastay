import { Router, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import multer from "multer";
import {
  Prisma,
  BookingStatus,
  ChannelProvider,
  ConversationState,
  FbOrderStatus,
  FbOutletType,
  FbServiceMode,
  FolioOutletCategory,
  FolioTransactionType,
  FolioTxnPaymentStatus,
  FolioTxnSourceType,
  HousekeepingAssignmentMode,
  HousekeepingTaskSource,
  HousekeepingTaskStatus,
  MessageDirection,
  NotificationStatus,
  OutletTicketSource,
  OutletTicketStatus,
  PaymentStatus,
  SegmentTagKind,
  SegmentTagSource,
  UserRole
} from "@prisma/client";
import Stripe from "stripe";
import { sendEmail } from "../core/email";
import {
  generateSecureToken,
  hashPassword as hashSecret,
  hashToken,
  verifyPassword as verifySecret,
  verifyPin
} from "../core/authSecurity";
import { buildPasswordResetEmail } from "../core/emailTemplates";
import {
  createNotification,
  createRoleRoutedNotification,
  getUnreadCount,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from "../core/notifications";
import {
  loadDecisionAnalyticsCrossPropertySummary,
  loadDecisionAnalyticsSummary,
  trackDecisionEventSafe
} from "../core/decisionAnalytics";
import { prisma } from "../db";
import {
  formatHousekeepingAssignmentMode,
  pickCleanerForAutoAssign,
  rankHousekeepingCleanersForAutoAssign
} from "../core/hkAssignment";
import { getHousekeepingStaffPerformance } from "../core/hkPerformance";
import { defaultHotelSlug } from "../config/tenancy";
import { inventoryDayRangeExclusive } from "../core/inventoryDate";
import {
  assertRoomUnitAvailableForBookingStayTx,
  autoAssignRoomUnitForBookingTx,
  isRoomUnitBlockedForGuestAssignment,
  reassignBookingRoomUnitTx,
  releaseInventoryForStayRange,
  reserveInventoryForBooking
} from "../core/bookingService";
import { recordBookingStatusChange } from "../core/bookingStatusHistory";
import { computeManualCheckInTotal, loadFrontDeskPricing, type MealPlanCode } from "../core/frontDeskPricing";
import { loadPartnerSetupConfig, savePartnerSetupConfig, applyPartnerTemplate, type PartnerSetupConfig } from "../core/partnerSetup";
import { buildBookingInvoicePdf, type GuestDocumentKind } from "../core/invoicePdf";
import { guestChatbotResumeMessage, guestReceptionistHandoffMessage } from "../whatsapp/guestNotifications";
import { createFbOrdersFromMenuLines, getFbFolioForBooking } from "../core/fbFolio";
import { notifyOutletForFolioCharge } from "../core/outletOrderNotify";
import {
  cancelOutletTicketForFolioTransaction,
  createOutletTicketForFolioCharge,
  folioChargeQualifiesForOutletTicket
} from "../core/outletTickets";
import {
  ensureActiveFolio,
  getFolioByBookingId,
  getFolioSummary,
  listFolioTransactions,
  postChargeToFolio,
  postPaymentToFolio,
  postRefundToFolio,
  voidFolioTransaction
} from "../core/folioService";
import { computeRoomUnitFolioSummary, mapChargeCategoryToFolio, parsePostingTarget, round2 } from "../core/roomUnitFolio";
import { DEFAULT_FB_MENU_2026, appendMissingFbMenuItems } from "../core/defaultFbMenuSeed";
import { manualCheckInFitsRoomType } from "../core/roomOccupancy";
import { allocateBookingReferenceCode, displayBookingReference } from "../core/bookingReference";
import {
  formatGuestVipAndTagsHtml,
  refreshGuestSegmentTagsForGuest,
  SEGMENT_TAG_LABELS
} from "../core/guestSegmentation";
import {
  deserializeCampaignFilters,
  isCampaignFiltersEmpty,
  parseCampaignFiltersFromBody,
  resolveCampaignAudience,
  serializeCampaignFilters
} from "../core/campaignAudience";
import { sendMarketingCampaignWhatsApp } from "../core/campaignSend";
import { renderCampaignComposePage } from "./campaignCenterHtml";
import { loadManagementKpis, parseKpiPreset } from "../core/managementKpiDashboard";
import { runHotelDailyDigest } from "../core/hotelDailyDigest";
import { isOwnerDigestSmtpConfigured } from "../core/ownerDigestMail";
import {
  computeExpectedClosingCash,
  computeShiftSnapshot,
  formatBusinessDateLocal,
  formatDateTimeLocalForInput,
  parseDateTimeLocalInput,
  renderShiftReportHtml,
  type ShiftCloseSnapshotFile
} from "../core/shiftCloseReport";
import { getFbOperationsSummary, listInHouseBookingsForHotelDay, recordWalkInDirectSale } from "../core/fbOperations";
import { buildManualCheckInPageHtml, manualCheckInFormFromBody, resolveRoomTypeIdForUnit } from "./manualCheckInForm";
import { computeManualCheckInRoomSelection } from "./manualCheckInRoomSelection";
import { sendWhatsAppDocument, sendWhatsAppText, trySendWhatsAppText } from "../whatsapp/send";
import {
  bookingComDomains,
  buildBookingComSyncPlan,
  type BookingComSyncDomain,
  type BookingComSyncMode
} from "../channelManager/bookingComArchitecture";

export const adminRouter = Router();
export const authRouter = Router();

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

const viewsDir = path.join(process.cwd(), "src", "views");
const sessionCookieName = "chatastay_admin_session";
type PermissionAction = "VIEW" | "EDIT" | "CREATE" | "DELETE" | "MANAGE";
type PermissionModule =
  | "ROOMS"
  | "BOOKINGS"
  | "REPORTS"
  | "BILLING"
  | "CONVERSATIONS"
  | "USERS"
  | "OUTLET"
  | "HOUSEKEEPING";
type ModulePermissionSet = Record<PermissionAction, boolean>;
type PermissionMatrix = Record<PermissionModule, ModulePermissionSet>;

const permissionModules: PermissionModule[] = [
  "ROOMS",
  "BOOKINGS",
  "REPORTS",
  "BILLING",
  "CONVERSATIONS",
  "USERS",
  "OUTLET",
  "HOUSEKEEPING"
];

/** Short labels for hotel staff UX (checkbox fieldset legends and summaries). */
const permissionModuleLabels: Record<PermissionModule, string> = {
  ROOMS: "Rooms & room board",
  BOOKINGS: "Reservations & bookings",
  REPORTS: "Reports & analytics",
  BILLING: "Billing & subscription",
  CONVERSATIONS: "WhatsApp / conversations",
  USERS: "User administration",
  OUTLET: "Restaurant & café — KOT, orders, outlet board",
  HOUSEKEEPING: "Housekeeping — tasks, cleaning queue, room readiness"
};

const permissionActions: PermissionAction[] = ["VIEW", "EDIT", "CREATE", "DELETE", "MANAGE"];
const adminPermissionsFile = path.join(process.cwd(), "admin-user-permissions.json");
const uploadsDir = path.join(process.cwd(), "src", "public", "uploads", "id-cards");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const idCardUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 10) || ".bin";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

type AdminSession = {
  staffId: string;
  email: string;
  role: string;
  permissions: PermissionMatrix;
  activePropertyId?: string | null;
};

const activeSessions = new Map<string, AdminSession>();
const auditActorContext = new AsyncLocalStorage<{
  staffId?: string;
  staffEmail?: string;
  session?: AdminSession;
}>();
const passwordResetTtlMs = 15 * 60 * 1000; // 15 minutes
const resetRequestRateLimitWindowMs = 15 * 60 * 1000;
const resetRequestRateLimitMax = 5;
const resetRequestRateLimit = new Map<string, number[]>();
const staffLoginRateLimitWindowMs = 10 * 60 * 1000;
const staffLoginRateLimitMaxFailures = 8;
const staffLoginFailures = new Map<string, number[]>();
const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
const platformHotelSlug = "al-ashkhara-beach-resort";
const allPropertiesKey = "ALL";

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

function getStripeClient(): Stripe | null {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) return null;
  return new Stripe(apiKey);
}

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function uniquePropertyCode(hotelId: string, baseName: string): Promise<string> {
  const base = (slugifyName(baseName).replace(/-/g, "_") || "property").toUpperCase().slice(0, 10);
  for (let i = 0; i < 100; i++) {
    const code = i === 0 ? base : `${base}${i}`;
    const existing = await prisma.property.findFirst({
      where: { hotelId, name: code },
      select: { id: true }
    });
    if (!existing) return code;
  }
  return `PROP${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

async function getPlatformHotelBase(): Promise<{ id: string; displayName?: string | null } | null> {
  return prisma.hotel.findUnique({ where: { slug: platformHotelSlug }, select: { id: true, displayName: true } });
}

function isScopedPropertyId(propertyId: string | null | undefined): propertyId is string {
  return Boolean(propertyId && propertyId !== allPropertiesKey);
}

async function resolveActivePropertyIdForHotel(req: Request, hotelId: string): Promise<string | null> {
  const session = getSession(req);
  const properties = await prisma.property.findMany({
    where: { hotelId },
    select: { id: true },
    orderBy: { createdAt: "asc" }
  });
  if (!properties.length) return null;
  const validIds = new Set(properties.map((p) => p.id));
  const queryPropertyId = typeof req.query.propertyId === "string" ? req.query.propertyId.trim() : "";
  if (queryPropertyId === allPropertiesKey && properties.length > 1) {
    if (session) session.activePropertyId = allPropertiesKey;
    return allPropertiesKey;
  }
  if (queryPropertyId && validIds.has(queryPropertyId)) {
    if (session) session.activePropertyId = queryPropertyId;
    return queryPropertyId;
  }
  if (session?.activePropertyId && validIds.has(session.activePropertyId)) {
    return session.activePropertyId;
  }
  if (session?.activePropertyId === allPropertiesKey && properties.length > 1) {
    return allPropertiesKey;
  }
  const fallback = properties[0].id;
  if (session) session.activePropertyId = fallback;
  return fallback;
}

function toMinorUnits(amount: number, currency: string): number {
  const zeroDecimal = new Set(["JPY", "KRW"]);
  const threeDecimal = new Set(["BHD", "KWD", "OMR"]);
  const upper = currency.toUpperCase();
  const factor = zeroDecimal.has(upper) ? 1 : threeDecimal.has(upper) ? 1000 : 100;
  return Math.round(amount * factor);
}

function buildFullPermissions(): PermissionMatrix {
  return {
    ROOMS: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true },
    BOOKINGS: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true },
    REPORTS: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true },
    BILLING: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true },
    CONVERSATIONS: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true },
    USERS: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true },
    OUTLET: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true },
    HOUSEKEEPING: { VIEW: true, EDIT: true, CREATE: true, DELETE: true, MANAGE: true }
  };
}

function buildNoPermissions(): PermissionMatrix {
  return {
    ROOMS: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false },
    BOOKINGS: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false },
    REPORTS: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false },
    BILLING: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false },
    CONVERSATIONS: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false },
    USERS: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false },
    OUTLET: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false },
    HOUSEKEEPING: { VIEW: false, EDIT: false, CREATE: false, DELETE: false, MANAGE: false }
  };
}

function defaultPermissionsForRole(role: string): PermissionMatrix {
  if (role === "MANAGER") return buildFullPermissions();
  if (role === "HOUSEKEEPING") {
    const p = buildNoPermissions();
    p.HOUSEKEEPING = { VIEW: true, EDIT: true, CREATE: false, DELETE: false, MANAGE: false };
    p.ROOMS = { VIEW: true, EDIT: true, CREATE: false, DELETE: false, MANAGE: false };
    return p;
  }
  if (role === "FINANCE") {
    const p = buildNoPermissions();
    p.BILLING = { VIEW: true, EDIT: true, CREATE: true, DELETE: false, MANAGE: false };
    p.REPORTS = { VIEW: true, EDIT: false, CREATE: false, DELETE: false, MANAGE: false };
    p.BOOKINGS = { VIEW: true, EDIT: false, CREATE: false, DELETE: false, MANAGE: false };
    return p;
  }
  if (role === "STAFF") {
    const p = buildNoPermissions();
    p.ROOMS = { VIEW: true, EDIT: true, CREATE: false, DELETE: false, MANAGE: false };
    p.BOOKINGS = { VIEW: true, EDIT: true, CREATE: true, DELETE: false, MANAGE: false };
    p.CONVERSATIONS = { VIEW: true, EDIT: true, CREATE: true, DELETE: false, MANAGE: false };
    p.REPORTS = { VIEW: true, EDIT: false, CREATE: false, DELETE: false, MANAGE: false };
    return p;
  }
  if (role === "FRONTDESK") {
    const p = buildNoPermissions();
    p.ROOMS = { VIEW: true, EDIT: true, CREATE: false, DELETE: false, MANAGE: false };
    p.BOOKINGS = { VIEW: true, EDIT: true, CREATE: true, DELETE: false, MANAGE: false };
    p.CONVERSATIONS = { VIEW: true, EDIT: true, CREATE: true, DELETE: false, MANAGE: false };
    return p;
  }
  return buildNoPermissions();
}

function normalizePermissionMatrix(input: unknown): PermissionMatrix {
  const empty = buildNoPermissions();
  if (!input || typeof input !== "object") return empty;
  const raw = input as Record<string, unknown>;
  for (const moduleName of permissionModules) {
    const row = raw[moduleName];
    if (!row || typeof row !== "object") continue;
    const rowRaw = row as Record<string, unknown>;
    for (const action of permissionActions) {
      empty[moduleName][action] = rowRaw[action] === true;
    }
  }
  return empty;
}

function readPermissionStore(): Record<string, PermissionMatrix> {
  try {
    if (!fs.existsSync(adminPermissionsFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(adminPermissionsFile, "utf8")) as Record<string, unknown>;
    const out: Record<string, PermissionMatrix> = {};
    for (const [email, matrix] of Object.entries(parsed)) {
      out[email.toLowerCase()] = normalizePermissionMatrix(matrix);
    }
    return out;
  } catch {
    return {};
  }
}

function writePermissionStore(store: Record<string, PermissionMatrix>): void {
  fs.writeFileSync(adminPermissionsFile, JSON.stringify(store, null, 2), "utf8");
}

function getPermissionsForEmail(email: string): PermissionMatrix {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@chatastay.local").trim().toLowerCase();
  if (email.toLowerCase() === adminEmail) return buildFullPermissions();
  const store = readPermissionStore();
  return normalizePermissionMatrix(store[email.toLowerCase()] ?? buildNoPermissions());
}

function effectivePermissionsForHotelUser(email: string, role: UserRole): PermissionMatrix {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@chatastay.local").trim().toLowerCase();
  if (email.toLowerCase() === adminEmail) return buildFullPermissions();
  const store = readPermissionStore();
  return normalizePermissionMatrix(store[email.toLowerCase()] ?? defaultPermissionsForRole(role));
}

function issueAdminSession(res: Response, params: { staffId: string; email: string; role: string; permissions: PermissionMatrix }): void {
  const token = crypto.randomUUID();
  activeSessions.set(token, {
    staffId: params.staffId,
    email: params.email,
    role: params.role,
    permissions: params.permissions
  });
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`
  );
}

function hashResetToken(token: string): string {
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

function getRequestIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || "unknown";
}

function staffLoginRateLimitKey(req: Request, hotelId: string, username: string): string {
  return `${getRequestIp(req)}:${hotelId}:${username}`;
}

function isStaffLoginRateLimited(req: Request, hotelId: string, username: string): boolean {
  const key = staffLoginRateLimitKey(req, hotelId, username);
  const now = Date.now();
  const failures = (staffLoginFailures.get(key) ?? []).filter((at) => now - at <= staffLoginRateLimitWindowMs);
  staffLoginFailures.set(key, failures);
  return failures.length >= staffLoginRateLimitMaxFailures;
}

function recordStaffLoginFailure(req: Request, hotelId: string, username: string): void {
  const key = staffLoginRateLimitKey(req, hotelId, username);
  const now = Date.now();
  const failures = (staffLoginFailures.get(key) ?? []).filter((at) => now - at <= staffLoginRateLimitWindowMs);
  failures.push(now);
  staffLoginFailures.set(key, failures);
}

function clearStaffLoginFailures(req: Request, hotelId: string, username: string): void {
  staffLoginFailures.delete(staffLoginRateLimitKey(req, hotelId, username));
}

async function sendPasswordResetEmail(to: string, resetLink: string): Promise<boolean> {
  try {
    const message = buildPasswordResetEmail({ resetLink, expiresMinutes: 15 });
    await sendEmail({
      to,
      subject: "Reset your ChatAstay password",
      html: message.html,
      text: message.text
    });
    return true;
  } catch (err) {
    console.error("[Auth] Password reset email failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
const hotelName = "Al Ashkhara Beach Resort";
const hotelSign = "Seafront Hospitality, Oman";
const reportStartDefault = "2026-03-01";
const reportEndDefault = "2026-03-31";
const tourOperatorDiscount = 0.15;
const offersFile = path.join(process.cwd(), "hotel-offers.json");
const seasonalBaseRates: Record<string, { high: number; low: number }> = {
  STD_SUPERIOR: { high: 30, low: 25 },
  STD_EXEC: { high: 35, low: 30 },
  SUITE: { high: 40, low: 35 },
  APARTMENT: { high: 50, low: 40 }
};

type OfferType =
  | "PERCENTAGE_DISCOUNT"
  | "STAY_X_GET_Y_FREE"
  | "EARLY_BOOKING"
  | "LONG_STAY"
  | "SEASONAL"
  | "CORPORATE_RATE";

type OfferDefinition = {
  id: string;
  code: string;
  title: string;
  type: OfferType;
  discountPercent: number;
  stayX?: number;
  stayY?: number;
  minDaysBeforeCheckIn?: number;
  minNights?: number;
  seasonStart?: string;
  seasonEnd?: string;
  corporateOnly?: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

function getDefaultOffers(): OfferDefinition[] {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      code: "TOUR_OPERATOR_15",
      title: "Tour Operator 15%",
      type: "PERCENTAGE_DISCOUNT",
      discountPercent: 15,
      isActive: true,
      createdAt: now,
      updatedAt: now
    },
    {
      id: crypto.randomUUID(),
      code: "STAY_3_GET_1",
      title: "Stay 3 Nights Get 1 Free",
      type: "STAY_X_GET_Y_FREE",
      discountPercent: 25,
      stayX: 3,
      stayY: 1,
      isActive: true,
      createdAt: now,
      updatedAt: now
    },
    {
      id: crypto.randomUUID(),
      code: "EARLY_BIRD_10",
      title: "Early Booking 10%",
      type: "EARLY_BOOKING",
      discountPercent: 10,
      minDaysBeforeCheckIn: 21,
      isActive: true,
      createdAt: now,
      updatedAt: now
    },
    {
      id: crypto.randomUUID(),
      code: "LONG_STAY_12",
      title: "Long Stay 12%",
      type: "LONG_STAY",
      discountPercent: 12,
      minNights: 7,
      isActive: true,
      createdAt: now,
      updatedAt: now
    },
    {
      id: crypto.randomUUID(),
      code: "SUMMER_18",
      title: "Seasonal Summer 18%",
      type: "SEASONAL",
      discountPercent: 18,
      seasonStart: "2026-06-01",
      seasonEnd: "2026-08-31",
      isActive: true,
      createdAt: now,
      updatedAt: now
    },
    {
      id: crypto.randomUUID(),
      code: "CORP_20",
      title: "Corporate Rate 20%",
      type: "CORPORATE_RATE",
      discountPercent: 20,
      corporateOnly: true,
      isActive: true,
      createdAt: now,
      updatedAt: now
    }
  ];
}

function readOffers(): OfferDefinition[] {
  try {
    if (!fs.existsSync(offersFile)) {
      const seeded = getDefaultOffers();
      fs.writeFileSync(offersFile, JSON.stringify(seeded, null, 2), "utf8");
      return seeded;
    }
    const raw = JSON.parse(fs.readFileSync(offersFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) return getDefaultOffers();
    return raw as OfferDefinition[];
  } catch {
    return getDefaultOffers();
  }
}

function writeOffers(offers: OfferDefinition[]): void {
  fs.writeFileSync(offersFile, JSON.stringify(offers, null, 2), "utf8");
}

function readView(name: string): string {
  return fs.readFileSync(path.join(viewsDir, name), "utf8");
}

/** Client-side polling for conversation activity (no WebSockets in this stack). */
function getAdminLiveScript(): string {
  return `<script>
(function () {
  var POLL_MS = 8000;
  var disabled = false;
  var lastSince = new Date(Date.now() - 15000).toISOString();
  var pendingBadge = 0;
  var listReloadTimer = null;

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }
  function formatDt(iso) {
    try {
      return new Date(iso).toISOString().replace("T", " ").slice(0, 16);
    } catch (e) {
      return "";
    }
  }
  function toast(title, body, kind) {
    var stack = document.getElementById("adminToastStack");
    if (!stack) return;
    var el = document.createElement("div");
    el.className = "admin-toast" + (kind === "booking" ? " admin-toast-booking" : "");
    el.innerHTML = '<strong class="admin-toast-title">' + esc(title) + '</strong><p class="admin-toast-body">' + esc(body) + '</p>';
    stack.appendChild(el);
    window.setTimeout(function () {
      el.classList.add("admin-toast-out");
      window.setTimeout(function () { el.remove(); }, 400);
    }, 9000);
  }
  function updateBadge(delta) {
    var badge = document.getElementById("adminConvLiveBadge");
    if (!badge) return;
    pendingBadge = Math.max(0, pendingBadge + delta);
    badge.textContent = String(Math.min(99, pendingBadge));
    badge.hidden = pendingBadge === 0;
  }
  function currentConversationId() {
    var n = document.querySelector("[data-chat-conversation-id]");
    return n ? n.getAttribute("data-chat-conversation-id") : null;
  }
  function buildBubble(m) {
    var inbound = m.direction === "INBOUND";
    var sender = inbound ? "Guest" : (m.aiIntent === "MANUAL_REPLY" ? "Staff" : "AI");
    var intentHtml = "";
    if (m.aiIntent && m.aiIntent !== "MANUAL_REPLY") {
      intentHtml = '<p class="bubble-meta">Intent: ' + esc(m.aiIntent) + "</p>";
    }
    return (
      '<article class="bubble ' + (inbound ? "inbound" : "outbound") + '">' +
      '<div class="bubble-head"><span><strong>' + esc(sender) + '</strong></span><span>' + formatDt(m.createdAt) + "</span></div>" +
      '<p class="bubble-body">' + esc(m.body) + "</p>" + intentHtml + "</article>"
    );
  }
  function refreshDetailMessages(cid) {
    var wrap = document.querySelector("[data-chat-conversation-id]");
    if (!wrap || wrap.getAttribute("data-chat-conversation-id") !== cid) return;
    var since = wrap.getAttribute("data-chat-last-msg-at") || "";
    var url = "/admin/conversations/live/" + encodeURIComponent(cid) + "/messages?since=" + encodeURIComponent(since);
    fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) return null;
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok || !data.messages || !data.messages.length) return;
        var timeline = document.querySelector(".chat-messages .timeline");
        if (!timeline) return;
        data.messages.forEach(function (m) {
          timeline.insertAdjacentHTML("beforeend", buildBubble(m));
        });
        var last = data.messages[data.messages.length - 1];
        if (last && last.createdAt) wrap.setAttribute("data-chat-last-msg-at", last.createdAt);
        var cm = document.querySelector(".chat-messages");
        if (cm) cm.scrollTop = cm.scrollHeight;
      })
      .catch(function () {});
  }
  function maybeReloadList() {
    var p = (window.location.pathname || "").replace(/\/+$/, "") || "/";
    if (p !== "/admin/conversations") return;
    if (listReloadTimer) window.clearTimeout(listReloadTimer);
    listReloadTimer = window.setTimeout(function () {
      window.location.reload();
    }, 500);
  }
  function handleEvents(events) {
    if (!events || !events.length) return;
    updateBadge(events.length);
    events.forEach(function (ev) {
      var t = ev.title || "Conversation";
      var b = ev.preview || "";
      toast(t, b, ev.category === "booking" ? "booking" : "inquiry");
      if (ev.conversationId && ev.conversationId === currentConversationId()) {
        refreshDetailMessages(ev.conversationId);
      }
    });
    maybeReloadList();
  }
  function pollActivity() {
    if (disabled) return;
    fetch("/admin/conversations/live/activity?since=" + encodeURIComponent(lastSince), {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          disabled = true;
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) return;
        if (data.serverTime) lastSince = data.serverTime;
        handleEvents(data.events || []);
      })
      .catch(function () {});
  }
  function pollDetailCatchUp() {
    var cid = currentConversationId();
    if (!cid) return;
    refreshDetailMessages(cid);
  }
  var link = document.querySelector("[data-admin-conv-link]");
  if (link) {
    link.addEventListener("click", function () {
      pendingBadge = 0;
      var badge = document.getElementById("adminConvLiveBadge");
      if (badge) badge.hidden = true;
    });
  }
  window.setInterval(function () {
    pollActivity();
    pollDetailCatchUp();
  }, POLL_MS);
  pollActivity();
  pollDetailCatchUp();
})();
<\/script>`;
}

function getAdminNotificationScript(): string {
  return `<script>
(function () {
  var POLL_MS = 9000;
  var notifBtn = document.getElementById("adminNotifBell");
  var notifBadge = document.getElementById("adminNotifBadge");
  var notifList = document.getElementById("adminNotifList");
  var notifEmpty = document.getElementById("adminNotifEmpty");
  var notifReadAll = document.getElementById("adminNotifReadAll");
  var muteBtn = document.getElementById("adminNotifMute");
  var panel = document.getElementById("adminNotifPanel");
  var attentionStrip = document.getElementById("adminAttentionStrip");
  var attentionList = document.getElementById("adminAttentionList");
  if (!notifBtn || !notifBadge || !notifList || !notifEmpty || !notifReadAll || !muteBtn || !panel) return;

  panel.hidden = true;
  panel.setAttribute("hidden", "");

  var knownIds = new Set();
  var soundMuted = localStorage.getItem("notifSoundMuted") === "true";
  var iconOn = "🔔";
  var iconOff = "🔕";
  muteBtn.textContent = soundMuted ? iconOff : iconOn;
  muteBtn.title = soundMuted ? "Enable alert sound" : "Mute alert sound";

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }
  function sevClass(sev) {
    if (sev === "critical") return "critical";
    if (sev === "high") return "high";
    if (sev === "normal") return "normal";
    return "info";
  }
  function shouldBeep(sev) {
    return sev === "critical" || sev === "high";
  }
  function beep() {
    if (soundMuted) return;
    if (document.visibilityState !== "visible") return;
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(880, ctx.currentTime);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.18);
    } catch (e) {}
  }
  function updateBadge(n) {
    var count = Number(n || 0);
    notifBadge.textContent = String(Math.min(99, count));
    notifBadge.hidden = count <= 0;
  }
  function renderList(items) {
    notifList.innerHTML = "";
    if (!items || !items.length) {
      notifEmpty.hidden = false;
      return;
    }
    notifEmpty.hidden = true;
    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "admin-notif-item sev-" + sevClass(item.severity);
      li.innerHTML =
        '<a href="' + esc(item.link || "#") + '" data-notif-id="' + esc(item.id) + '">' +
        '<div class="admin-notif-title">' + esc(item.title || item.type || "Notification") + "</div>" +
        '<div class="admin-notif-body">' + esc(item.body || "") + "</div>" +
        "</a>";
      notifList.appendChild(li);
    });
  }
  function renderAttention(items) {
    if (!attentionStrip || !attentionList) return;
    var urgent = (items || []).filter(function (x) { return x && x.readAt == null && (x.severity === "critical" || x.severity === "high"); }).slice(0, 5);
    if (!urgent.length) {
      attentionStrip.hidden = true;
      attentionList.innerHTML = "";
      return;
    }
    attentionStrip.hidden = false;
    attentionList.innerHTML = urgent
      .map(function (n) {
        var href = n.link || "#";
        return '<li><a href="' + esc(href) + '" style="color:#7f1d1d;text-decoration:none"><strong>' + esc(n.title || "Alert") + ":</strong> " + esc(n.body || "") + "</a></li>";
      })
      .join("");
  }
  async function fetchUnreadCount() {
    var r = await fetch("/auth/notifications/unread-count", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!r.ok) return;
    var j = await r.json();
    updateBadge(j.unreadCount || 0);
  }
  async function fetchLatest() {
    var r = await fetch("/auth/notifications?limit=10", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!r.ok) return;
    var j = await r.json();
    var items = Array.isArray(j.notifications) ? j.notifications : [];
    for (var i = 0; i < items.length; i++) {
      var n = items[i];
      if (!knownIds.has(n.id)) {
        knownIds.add(n.id);
        if (n.readAt == null && shouldBeep(n.severity)) beep();
      }
    }
    renderList(items);
    renderAttention(items);
  }
  notifBtn.addEventListener("click", function () {
    panel.hidden = !panel.hidden;
  });
  document.addEventListener("click", function (e) {
    if (panel.hidden) return;
    var t = e.target;
    if (!panel.contains(t) && !notifBtn.contains(t)) panel.hidden = true;
  });
  notifList.addEventListener("click", async function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest("[data-notif-id]") : null;
    if (!a) return;
    var id = a.getAttribute("data-notif-id");
    if (!id) return;
    fetch("/auth/notifications/" + encodeURIComponent(id) + "/read", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } })
      .catch(function () {});
  });
  notifReadAll.addEventListener("click", async function () {
    await fetch("/auth/notifications/read-all", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } }).catch(function () {});
    fetchUnreadCount();
    fetchLatest();
  });
  muteBtn.addEventListener("click", function () {
    soundMuted = !soundMuted;
    localStorage.setItem("notifSoundMuted", soundMuted ? "true" : "false");
    muteBtn.textContent = soundMuted ? iconOff : iconOn;
    muteBtn.title = soundMuted ? "Enable alert sound" : "Mute alert sound";
  });

  function poll() {
    fetchUnreadCount();
    fetchLatest();
  }
  poll();
  window.setInterval(poll, POLL_MS);
})();
<\/script>`;
}

function renderLayout(content: string, authenticated: boolean): string {
  const layout = readView("layout.html");
  const sess = authenticated ? auditActorContext.getStore()?.session : undefined;
  const uiErrorContextAttrs = sess
    ? ` data-ui-user-id="${escapeHtml(sess.staffId)}" data-ui-role="${escapeHtml(String(sess.role))}" data-ui-hotel-slug="${escapeHtml(platformHotelSlug)}"${
        sess.activePropertyId ? ` data-ui-property-id="${escapeHtml(String(sess.activePropertyId))}"` : ""
      }`
    : "";
  const perm = authenticated ? auditActorContext.getStore()?.session?.permissions : undefined;
  const role = authenticated ? auditActorContext.getStore()?.session?.role : undefined;
  const isFrontdesk = role === "FRONTDESK";
  const canNavHousekeeping =
    !perm ||
    hasPermission(perm, "HOUSEKEEPING", "VIEW") ||
    hasPermission(perm, "ROOMS", "EDIT");
  const canNavOutlet =
    !perm || hasPermission(perm, "OUTLET", "VIEW") || hasPermission(perm, "ROOMS", "VIEW");
  const canNavFb =
    !isFrontdesk && (!perm || hasPermission(perm, "OUTLET", "VIEW") || hasPermission(perm, "BOOKINGS", "VIEW"));
  const canNavComms = !perm || hasPermission(perm, "CONVERSATIONS", "VIEW");
  const navHtml = authenticated
    ? isFrontdesk
      ? [
          '<a class="top-level-link" data-top-group="dashboard" href="/admin/profile">Dashboard</a>',
          '<a class="top-level-link" data-top-group="reservations" href="/admin/bookings">Reservations</a>',
          '<a class="top-level-link" data-top-group="rooms" href="/admin/room-board">Rooms</a>',
          ...(canNavComms
            ? ['<a class="top-level-link" data-top-group="comms" href="/admin/conversations">Messages</a>']
            : [])
        ].join("")
      : [
          '<a class="top-level-link" data-top-group="dashboard" href="/admin/profile">Dashboard</a>',
          '<a class="top-level-link" data-top-group="reservations" href="/admin/bookings">Reservations</a>',
          '<a class="top-level-link" data-top-group="rooms" href="/admin/room-board">Rooms</a>',
          ...(canNavFb ? ['<a class="top-level-link" data-top-group="fb" href="/admin/fb/menu">F&amp;B</a>'] : []),
          ...(canNavComms
            ? ['<a class="top-level-link" data-top-group="comms" href="/admin/conversations">Messages</a>']
            : []),
          '<a class="top-level-link" data-top-group="insights" href="/admin/reports-center">Insights</a>',
          '<a class="top-level-link" data-top-group="account" href="/admin/setup">Settings</a>'
        ].join("")
    : '<a href="/admin/login">Login</a>';
  const logoutHtml = authenticated
    ? '<span id="adminPropertySwitchHost" style="display:none; align-items:center; gap:6px; margin-right:10px;"><label for="adminPropertySwitch" style="font-size:12px; color:#64748b">Property</label><select id="adminPropertySwitch" style="padding:6px 8px; border:1px solid #d8dee6; border-radius:8px; min-width:180px"></select></span><form method="post" action="/admin/logout"><button type="submit">Logout</button></form>'
    : "";
  const sectionTabsHtml = authenticated
    ? isFrontdesk
      ? [
          '<div class="section-tabs" data-section="dashboard">',
          '<a href="/admin/profile">Overview</a>',
          "</div>",
          '<div class="section-tabs" data-section="reservations">',
          '<a href="/admin/bookings">Bookings</a>',
          '<a href="/admin/calendar">Calendar</a>',
          '<a href="/admin/inventory">Availability</a>',
          '<a href="/admin/rooms">Rates</a>',
          '<a href="/admin/offers">Offers</a>',
          "</div>",
          '<div class="section-tabs" data-section="rooms">',
          '<a href="/admin/room-board">Room board</a>',
          ...(canNavHousekeeping ? ['<a href="/admin/housekeeping">Housekeeping</a>'] : []),
          '<a href="/admin/handover-sheet">Handover</a>',
          '<a href="/admin/front-desk/check-in">Check-in</a>',
          '<a href="/admin/front-desk/check-out">Check-out</a>',
          '<a href="/admin/shifts">Shifts</a>',
          '<a href="/admin/shift-close">Shift close</a>',
          '<span class="nav-tab-placeholder" title="Coming soon" aria-disabled="true">Maintenance</span>',
          "</div>",
          '<div class="section-tabs" data-section="comms">',
          '<a href="/admin/conversations" data-admin-conv-link>Guest conversations <span id="adminConvLiveBadge" class="nav-live-badge" hidden aria-live="polite">0</span></a>',
          '<a href="/admin/campaigns">Campaigns</a>',
          "</div>"
        ].join("")
      : [
          '<div class="section-tabs" data-section="dashboard">',
          '<a href="/admin/profile">Overview</a>',
          "</div>",
          '<div class="section-tabs" data-section="reservations">',
          '<a href="/admin/bookings">Bookings</a>',
          '<a href="/admin/calendar">Calendar</a>',
          '<a href="/admin/inventory">Availability</a>',
          '<a href="/admin/rooms">Rates</a>',
          '<a href="/admin/offers">Offers</a>',
          "</div>",
          '<div class="section-tabs" data-section="rooms">',
          '<a href="/admin/room-board">Room board</a>',
          ...(canNavHousekeeping ? ['<a href="/admin/housekeeping">Housekeeping</a>'] : []),
          '<a href="/admin/handover-sheet">Handover</a>',
          '<a href="/admin/front-desk/check-in">Check-in</a>',
          '<a href="/admin/front-desk/check-out">Check-out</a>',
          '<a href="/admin/shifts">Shifts</a>',
          '<a href="/admin/shift-close">Shift close</a>',
          '<span class="nav-tab-placeholder" title="Coming soon" aria-disabled="true">Maintenance</span>',
          "</div>",
          '<div class="section-tabs" data-section="fb">',
          '<a href="/admin/fb/menu">F&amp;B master</a>',
          ...(canNavOutlet
            ? [
                '<a href="/admin/outlet-dashboard">Outlet board</a>',
                '<a href="/admin/outlet-orders">Outlet orders</a>',
                '<a href="/admin/restaurant-ops">Restaurant operations guide</a>'
              ]
            : []),
          "</div>",
          '<div class="section-tabs" data-section="comms">',
          '<a href="/admin/conversations" data-admin-conv-link>Guest conversations <span id="adminConvLiveBadge" class="nav-live-badge" hidden aria-live="polite">0</span></a>',
          '<a href="/admin/campaigns">Campaigns</a>',
          "</div>",
          '<div class="section-tabs" data-section="account">',
          '<a href="/admin/setup">Settings</a>',
          '<a href="/admin/users">Users &amp; permissions</a>',
          '<a href="/admin/subscription">Subscription</a>',
          '<a href="/admin/billing">Billing</a>',
          '<a href="/admin/integrations">Integrations</a>',
          "</div>",
          '<div class="section-tabs" data-section="insights">',
          '<a href="/admin/reports-center">Reports</a>',
          '<a href="/admin/management-kpi">KPI dashboard</a>',
          '<a href="/admin/daily-digest">Daily digest</a>',
          '<a href="/admin/ai-analytics">AI analytics</a>',
          '<a href="/admin/booking-funnel">Booking funnel</a>',
          '<a href="/admin/routing-health">Routing health</a>',
          "</div>"
        ].join("")
    : "";
  const langSwitcherHtml = '<a href="?lang=en" data-lang-link="en">EN</a><a href="?lang=ar" data-lang-link="ar">AR</a>';

  return layout
    .replace("{{uiErrorContextAttrs}}", uiErrorContextAttrs)
    .replaceAll("{{lang}}", "en")
    .replaceAll("{{dir}}", "ltr")
    .replaceAll("{{adminTitle}}", "ChatAstay Admin")
    .replace("{{brandTagline}}", "WhatsApp-first booking ops")
    .replace("{{langSwitcher}}", langSwitcherHtml)
    .replace("{{hotelName}}", hotelName)
    .replace("{{hotelSign}}", hotelSign)
    .replace("{{navLinks}}", navHtml)
    .replace("{{sectionTabs}}", sectionTabsHtml)
    .replace("{{logoutAction}}", logoutHtml)
    .replace("{{content}}", content)
    .replace(
      "{{extraScripts}}",
      authenticated ? getAdminLiveScript() + getAdminNotificationScript() + getAdminPropertySwitcherScript() : ""
    );
}

function getAdminPropertySwitcherScript(): string {
  return `<script>
(function () {
  var host = document.getElementById("adminPropertySwitchHost");
  var select = document.getElementById("adminPropertySwitch");
  if (!host || !select) return;
  var currentPropertyId = "";

  function withPropertyId(url) {
    try {
      var u = new URL(url, window.location.origin);
      if (currentPropertyId) u.searchParams.set("propertyId", currentPropertyId);
      return u.pathname + u.search + u.hash;
    } catch {
      return url;
    }
  }

  function decorateLinksAndForms() {
    if (!currentPropertyId) return;
    document.querySelectorAll('a[href^="/admin/"]').forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href || href.includes("propertyId=")) return;
      a.setAttribute("href", withPropertyId(href));
    });
    document.querySelectorAll('form[method="get"]').forEach(function (f) {
      var input = f.querySelector('input[name="propertyId"]');
      if (!input) {
        input = document.createElement("input");
        input.setAttribute("type", "hidden");
        input.setAttribute("name", "propertyId");
        f.appendChild(input);
      }
      input.value = currentPropertyId;
    });
  }

  fetch("/auth/property-context", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.ok || !Array.isArray(data.properties) || data.properties.length <= 1) {
        return;
      }
      currentPropertyId = typeof data.activePropertyId === "string" ? data.activePropertyId : "";
      var allOpt = document.createElement("option");
      allOpt.value = "ALL";
      allOpt.textContent = "All Properties";
      if (currentPropertyId === "ALL") allOpt.selected = true;
      select.appendChild(allOpt);
      data.properties.forEach(function (p) {
        if (!p || typeof p.id !== "string") return;
        var opt = document.createElement("option");
        opt.value = p.id;
        var subtitle = p.city ? " (" + p.city + ")" : "";
        opt.textContent = (p.name || "Property") + subtitle;
        if (p.id === currentPropertyId) opt.selected = true;
        select.appendChild(opt);
      });
      host.style.display = "inline-flex";
      decorateLinksAndForms();
      select.addEventListener("change", function () {
        var nextId = String(select.value || "").trim();
        if (!nextId) return;
        fetch("/auth/property-context", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ propertyId: nextId })
        }).finally(function () {
          var u = new URL(window.location.href);
          u.searchParams.set("propertyId", nextId);
          window.location.assign(u.toString());
        });
      });
    })
    .catch(function () {});
})();
</script>`;
}

function renderHkLayout(params: { title: string; content: string; active: "tasks" | "board" }): string {
  const layout = readView("hk-layout.html");
  const hkSess = auditActorContext.getStore()?.session;
  const uiErrorContextAttrs = hkSess
    ? ` data-ui-user-id="${escapeHtml(hkSess.staffId)}" data-ui-role="${escapeHtml(String(hkSess.role))}" data-ui-hotel-slug="${escapeHtml(platformHotelSlug)}"${
        hkSess.activePropertyId ? ` data-ui-property-id="${escapeHtml(String(hkSess.activePropertyId))}"` : ""
      }`
    : "";
  const tasksCls = params.active === "tasks" ? ' class="active"' : "";
  const boardCls = params.active === "board" ? ' class="active"' : "";
  const navLinks = `<a href="/admin/hk"${tasksCls}>My tasks</a><a href="/admin/hk/room-board"${boardCls}>Room board</a>`;
  const logoutForm = '<form method="post" action="/admin/logout"><button type="submit">Logout</button></form>';
  return layout
    .replace("{{uiErrorContextAttrs}}", uiErrorContextAttrs)
    .replace("{{pageTitle}}", escapeHtml(params.title))
    .replace("{{navLinks}}", navLinks)
    .replace("{{logoutForm}}", logoutForm)
    .replace("{{content}}", params.content)
    .replace("{{extraScripts}}", getAdminNotificationScript());
}

function renderPage(pageFile: string, authenticated: boolean): string {
  const content = readView(pageFile);
  return renderLayout(content, authenticated);
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseShiftCloseSnapshot(raw: string): ShiftCloseSnapshotFile | null {
  try {
    const j = JSON.parse(raw) as ShiftCloseSnapshotFile;
    if (!j || typeof j !== "object" || !("computed" in j)) return null;
    return j;
  } catch {
    return null;
  }
}

function parseManualSegmentTagsFromBody(body: Record<string, unknown>): SegmentTagKind[] {
  const raw = body.manualTags;
  const arr = Array.isArray(raw) ? raw : raw != null && String(raw).length > 0 ? [String(raw)] : [];
  const allowed = new Set<string>(Object.values(SegmentTagKind));
  const out = new Set<SegmentTagKind>();
  for (const r of arr) {
    const s = String(r);
    if (allowed.has(s)) out.add(s as SegmentTagKind);
  }
  return Array.from(out);
}

function formatDate(input: Date | null | undefined): string {
  if (!input) return "-";
  return input.toISOString().slice(0, 10);
}

/** Local calendar date YYYY-MM-DD for <input type="date"> and date-filter round-trip. Avoids UTC shift. */
function formatDateForInput(input: Date | null | undefined): string {
  if (!input) return "";
  const y = input.getFullYear();
  const m = input.getMonth() + 1;
  const d = input.getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

function formatDateTime(input: Date | null | undefined): string {
  if (!input) return "-";
  return input.toISOString().replace("T", " ").slice(0, 16);
}

function startOfDay(input: Date): Date {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** Inclusive end date for default booking-report "to" filter: last day of the month +3 months ahead of `now` (shows upcoming WhatsApp stays, not only the current calendar month). */
function defaultBookingReportInclusiveEnd(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth() + 4, 0);
}

function addDays(input: Date, days: number): Date {
  const date = new Date(input);
  date.setDate(date.getDate() + days);
  return date;
}

/** Parse YYYY-MM-DD as local calendar date (no UTC). Prevents one-day shift in date filters. */
function parseDateInput(raw: unknown, fallback: Date): Date {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const s = raw.trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    const d = Number(match[3]);
    const parsed = new Date(y, m, d);
    if (parsed.getFullYear() === y && parsed.getMonth() === m && parsed.getDate() === d)
      return parsed;
  }
  const legacy = new Date(s);
  if (!Number.isNaN(legacy.getTime())) return startOfDay(legacy);
  return fallback;
}

function endOfDay(input: Date): Date {
  const date = new Date(input);
  date.setHours(23, 59, 59, 999);
  return date;
}

function parseNumberInput(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function parseIntegerInput(raw: unknown, fallback: number): number {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

function renderBookingWizard(currentStep: 1 | 2 | 3, links: { conversationId?: string; bookingId?: string }): string {
  const step1Url = links.conversationId ? `/admin/conversations/${encodeURIComponent(links.conversationId)}/create-booking` : "#";
  const step2Url = links.bookingId ? `/admin/bookings/${encodeURIComponent(links.bookingId)}/select-unit` : "#";
  const step3Url = links.bookingId ? `/admin/bookings/${encodeURIComponent(links.bookingId)}/confirm` : "#";

  const stepHtml = (num: 1 | 2 | 3, label: string, href: string) => {
    const cls = num < currentStep ? "ok" : num === currentStep ? "pending" : "alert";
    const clickable = href !== "#";
    return `<li style="display:flex; align-items:center; gap:8px">
      <span class="badge ${cls}" style="min-width:28px; text-align:center">${num}</span>
      ${clickable ? `<a class="inline-link" href="${href}">${label}</a>` : `<span class="muted">${label}</span>`}
    </li>`;
  };

  return `<section style="margin:10px 0 14px">
    <h3 style="margin-bottom:8px">Booking Wizard Progress</h3>
    <ol style="display:flex; flex-wrap:wrap; gap:12px; list-style:none; padding:0; margin:0">
      ${stepHtml(1, "Guest Details", step1Url)}
      ${stepHtml(2, "Unit Selection", step2Url)}
      ${stepHtml(3, "Final Confirmation", step3Url)}
    </ol>
  </section>`;
}

function buildTemplateMessage(template: string, values: Record<string, string | number | null | undefined>, fallback: string): string {
  const rendered = applyPartnerTemplate(template, values).trim();
  return rendered || fallback;
}

function normalizePhoneForWhatsApp(input: string): string {
  return input.replace(/\D/g, "");
}

function getBadgeClass(status: string): "ok" | "pending" | "alert" {
  if (status === "CONFIRMED" || status === "SUCCEEDED" || status === "ACTIVE") return "ok";
  if (status === "CANCELLED" || status === "FAILED" || status === "NO_SHOW") return "alert";
  return "pending";
}

function getConversationBadgeClass(state: ConversationState): "ok" | "pending" | "alert" {
  if (state === ConversationState.CONFIRMED || state === ConversationState.CLOSED) return "ok";
  if (state === ConversationState.NEW || state === ConversationState.QUALIFYING) return "pending";
  return "alert";
}

function enumerateDates(start: Date, days: number): Date[] {
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}

function csvEscapeField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function parseAuditMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function getBookingUnitCode(bookingId: string): Promise<string | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { roomUnit: { select: { name: true } } }
  });
  if (booking?.roomUnit?.name) return booking.roomUnit.name;

  const lastUnitSelection = await prisma.auditLog.findFirst({
    where: {
      action: "BOOKING_UNIT_SELECTED",
      entityType: "Booking",
      entityId: bookingId
    },
    orderBy: { createdAt: "desc" }
  });
  const metadata = parseAuditMetadata(lastUnitSelection?.metadataJson);
  return typeof metadata.unitCode === "string" ? metadata.unitCode : null;
}

async function getLatestInvoiceDispatch(bookingId: string): Promise<{
  sentAt: Date | null;
  paymentStatusAtSend: string | null;
  filename: string | null;
}> {
  const lastDispatch = await prisma.auditLog.findFirst({
    where: {
      action: "BOOKING_INVOICE_PDF_SENT",
      entityType: "Booking",
      entityId: bookingId
    },
    orderBy: { createdAt: "desc" }
  });
  if (!lastDispatch) {
    return { sentAt: null, paymentStatusAtSend: null, filename: null };
  }
  const metadata = parseAuditMetadata(lastDispatch.metadataJson);
  return {
    sentAt: lastDispatch.createdAt,
    paymentStatusAtSend: typeof metadata.paymentStatusAtSend === "string" ? metadata.paymentStatusAtSend : null,
    filename: typeof metadata.filename === "string" ? metadata.filename : null
  };
}

async function sendInvoicePdfForBooking(params: {
  hotelId: string;
  bookingId: string;
  trigger: string;
  force?: boolean;
  /** Defaults to invoice (folio). Quotation/receipt use distinct PDF titles and guest captions. */
  documentKind?: GuestDocumentKind;
}): Promise<{ sent: boolean; skipped: boolean; error?: string }> {
  const documentKind: GuestDocumentKind = params.documentKind ?? "invoice";
  const [hotel, booking] = await Promise.all([
    prisma.hotel.findUnique({ where: { id: params.hotelId } }),
    prisma.booking.findFirst({
      where: { id: params.bookingId, hotelId: params.hotelId },
      include: {
        guest: true,
        roomType: true,
        property: true,
        conversation: true
      }
    })
  ]);

  if (!hotel || !booking) {
    return { sent: false, skipped: false, error: "Booking or hotel not found for document send." };
  }

  if (documentKind === "quotation") {
    if (booking.status === BookingStatus.CANCELLED) {
      return { sent: false, skipped: true };
    }
  } else if (booking.status !== BookingStatus.CONFIRMED) {
    return { sent: false, skipped: true };
  }

  if (documentKind === "invoice") {
    const lastDispatch = await getLatestInvoiceDispatch(booking.id);
    if (!params.force && lastDispatch.sentAt && lastDispatch.paymentStatusAtSend === booking.paymentStatus) {
      return { sent: false, skipped: true };
    }
  }

  const selectedUnitCode = await getBookingUnitCode(booking.id);
  const fbFolio = await getFbFolioForBooking(booking.id);
  const grandTotal = Number((booking.totalAmount + fbFolio.subtotal).toFixed(2));
  const refPrefix = documentKind === "quotation" ? "QUO" : documentKind === "receipt" ? "RCP" : "INV";
  const invoiceNumber = `${refPrefix}-${booking.id}`;
  const filename = `${booking.id}-${documentKind}-${formatDate(new Date())}.pdf`;
  const invoicePdf = await buildBookingInvoicePdf({
    documentKind,
    invoiceNumber,
    issuedAt: new Date(),
    hotelName: hotel.displayName,
    hotelCity: hotel.city,
    hotelCountry: hotel.country,
    guestName: booking.guest.fullName ?? "Guest",
    guestPhone: booking.guest.phoneE164,
    bookingId: booking.id,
    bookingStatus: booking.status,
    paymentStatus: booking.paymentStatus,
    roomType: booking.roomType.name,
    selectedUnit: selectedUnitCode,
    propertyName: booking.property.name,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: booking.nights,
    adults: booking.adults,
    children: booking.children,
    totalAmount: booking.totalAmount,
    currency: booking.currency,
    fbLines: fbFolio.lines,
    fbSubtotal: fbFolio.subtotal,
    grandTotal
  });

  const toPhone = normalizePhoneForWhatsApp(booking.guest.phoneE164);
  if (!toPhone) {
    return { sent: false, skipped: false, error: "Guest phone number is missing or invalid." };
  }

  const hotelLead = hotel.displayName;
  const caption =
    documentKind === "quotation"
      ? `${hotelLead}: here is your stay quotation (${invoiceNumber}). This is not a booking confirmation—our team will confirm details with you.`
      : documentKind === "receipt"
        ? `${hotelLead}: receipt ${invoiceNumber} for booking ${booking.id}. Payment status: ${booking.paymentStatus}.`
        : `${hotelLead}: invoice ${invoiceNumber} for booking ${booking.id}. Payment status: ${booking.paymentStatus}.`;

  const partner = loadPartnerSetupConfig(hotel.id);
  try {
    await sendWhatsAppDocument({
      to: toPhone,
      filename,
      body: invoicePdf,
      caption,
      phoneNumberId: partner.whatsappPhoneNumberId || undefined
    });
  } catch (error) {
    let message = error instanceof Error ? error.message.slice(0, 500) : "Failed to send PDF";
    if (/fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|certificate/i.test(message)) {
      message =
        "Could not reach WhatsApp (Meta) from this server — network/DNS/firewall or SSL issue. Booking is saved; open the booking to resend the invoice when connectivity is fixed.";
    }
    return { sent: false, skipped: false, error: message };
  }

  const outboundLabel =
    documentKind === "quotation"
      ? `Quotation PDF ${invoiceNumber} sent to guest.`
      : documentKind === "receipt"
        ? `Receipt PDF ${invoiceNumber} sent to guest.`
        : `Invoice PDF ${invoiceNumber} sent to guest. Payment status at send: ${booking.paymentStatus}.`;

  if (booking.conversationId) {
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: booking.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: outboundLabel,
        aiIntent:
          documentKind === "quotation" ? "QUOTATION_SENT" : documentKind === "receipt" ? "RECEIPT_SENT" : "INVOICE_SENT"
      }
    });
    await prisma.conversation.update({
      where: { id: booking.conversationId },
      data: { lastMessageAt: new Date() }
    });
  }

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_INVOICE_PDF_SENT",
    entityType: "Booking",
    entityId: booking.id,
    metadata: {
      trigger: params.trigger,
      documentKind,
      invoiceNumber,
      filename,
      sentTo: toPhone,
      paymentStatusAtSend: booking.paymentStatus,
      bookingStatusAtSend: booking.status,
      checkIn: formatDate(booking.checkIn),
      checkOut: formatDate(booking.checkOut),
      totalAmount: booking.totalAmount,
      currency: booking.currency
    }
  });

  return { sent: true, skipped: false };
}

async function ensureDefaultFbMenu(hotelId: string): Promise<void> {
  const n = await prisma.menuItem.count({ where: { hotelId } });
  if (n > 0) return;
  await prisma.menuItem.createMany({
    data: DEFAULT_FB_MENU_2026.map((row) => ({ hotelId, ...row }))
  });
}

async function sendBookingPaymentLinkAfterConfirmation(params: {
  hotelId: string;
  bookingId: string;
}): Promise<{ sent: boolean; skipped: boolean; url?: string; error?: string }> {
  const [hotel, booking] = await Promise.all([
    prisma.hotel.findUnique({ where: { id: params.hotelId } }),
    prisma.booking.findFirst({
      where: { id: params.bookingId, hotelId: params.hotelId },
      include: { guest: true, roomType: true, conversation: true }
    })
  ]);
  if (!hotel || !booking) return { sent: false, skipped: false, error: "Booking or hotel not found." };
  if (booking.status !== BookingStatus.CONFIRMED) return { sent: false, skipped: true };

  const stripe = getStripeClient();
  if (!stripe) return { sent: false, skipped: false, error: "Stripe is not configured." };

  const localPaymentIntent = await prisma.paymentIntent.create({
    data: {
      hotelId: hotel.id,
      kind: "BOOKING",
      provider: "stripe",
      amount: booking.totalAmount,
      currency: hotel.currency,
      status: "REQUIRES_ACTION",
      bookingId: booking.id
    }
  });

  const successUrl =
    process.env.STRIPE_CHECKOUT_SUCCESS_URL ??
    `${appBaseUrl}/guest?bookingId=${encodeURIComponent(booking.id)}&phone=${encodeURIComponent(booking.guest.phoneE164)}`;
  const cancelUrl = process.env.STRIPE_CHECKOUT_CANCEL_URL ?? `${appBaseUrl}/guest?bookingId=${encodeURIComponent(booking.id)}&phone=${encodeURIComponent(booking.guest.phoneE164)}`;

  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: localPaymentIntent.id,
      customer_email: booking.guest.email ?? undefined,
      metadata: {
        paymentIntentId: localPaymentIntent.id,
        bookingId: booking.id,
        hotelId: hotel.id
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: hotel.currency.toLowerCase(),
            unit_amount: toMinorUnits(booking.totalAmount, hotel.currency),
            product_data: {
              name: `Booking ${booking.id} - ${hotel.displayName}`,
              description: `${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}`
            }
          }
        }
      ],
      payment_intent_data: {
        metadata: {
          paymentIntentId: localPaymentIntent.id,
          bookingId: booking.id,
          hotelId: hotel.id
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create payment link.";
    return { sent: false, skipped: false, error: message };
  }

  const paymentIntent = await prisma.paymentIntent.update({
    where: { id: localPaymentIntent.id },
    data: {
      externalIntentId: checkoutSession.id,
      paymentLinkUrl: checkoutSession.url ?? undefined,
      metadataJson: JSON.stringify({
        stripeCheckoutSessionId: checkoutSession.id,
        stripePaymentIntent: checkoutSession.payment_intent
      })
    }
  });

  const link = paymentIntent.paymentLinkUrl;
  if (!link) return { sent: false, skipped: false, error: "Payment link URL is unavailable." };
  const to = normalizePhoneForWhatsApp(booking.guest.phoneE164);
  if (!to) return { sent: false, skipped: false, error: "Guest phone number is invalid." };

  const config = loadPartnerSetupConfig(hotel.id);
  const msg = [
    `Booking ${booking.id} is confirmed.`,
    `Room: ${booking.roomType.name}`,
    `Stay: ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}`,
    `Amount due: ${booking.totalAmount.toFixed(2)} ${hotel.currency}`,
    `Pay securely using this link: ${link}`
  ].join("\n");

  try {
    await sendWhatsAppText({
      to,
      body: msg,
      phoneNumberId: config.whatsappPhoneNumberId || undefined,
      conversationId: booking.conversationId ?? undefined
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send payment link via WhatsApp.";
    return { sent: false, skipped: false, error: message };
  }

  await prisma.paymentIntent.update({
    where: { id: paymentIntent.id },
    data: { paymentLinkSentAt: new Date() }
  });

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_PAYMENT_LINK_SENT",
    entityType: "Booking",
    entityId: booking.id,
    metadata: {
      paymentIntentId: paymentIntent.id,
      checkoutSessionId: checkoutSession.id,
      sentTo: to
    }
  });
  return { sent: true, skipped: false, url: link };
}

async function getMinInventoryForStay(params: { hotelId: string; roomTypeId: string; checkIn: Date; checkOut: Date; fallback: number }): Promise<number> {
  const stayStart = startOfDay(params.checkIn);
  const stayEnd = startOfDay(params.checkOut);
  const inventoryRows = await prisma.inventory.findMany({
    where: {
      hotelId: params.hotelId,
      roomTypeId: params.roomTypeId,
      date: { gte: stayStart, lt: stayEnd }
    },
    select: { total: true }
  });
  if (!inventoryRows.length) return params.fallback;
  return inventoryRows.reduce((min, row) => Math.min(min, row.total), params.fallback);
}

async function getBookedUnitsForStay(params: {
  hotelId: string;
  roomTypeId: string;
  checkIn: Date;
  checkOut: Date;
  excludeBookingId?: string;
}): Promise<Set<string>> {
  const overlappingBookings = await prisma.booking.findMany({
    where: {
      hotelId: params.hotelId,
      roomTypeId: params.roomTypeId,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      checkIn: { lt: params.checkOut },
      checkOut: { gt: params.checkIn },
      ...(params.excludeBookingId ? { id: { not: params.excludeBookingId } } : {})
    },
    select: { id: true, roomUnit: { select: { name: true } } }
  });
  if (!overlappingBookings.length) return new Set<string>();

  const selectedUnits = new Set<string>(overlappingBookings.map((booking) => booking.roomUnit?.name).filter((name): name is string => Boolean(name)));
  const missingIds = overlappingBookings.filter((booking) => !booking.roomUnit).map((booking) => booking.id);
  if (!missingIds.length) return selectedUnits;

  const bookingIds = missingIds;
  const unitSelections = await prisma.auditLog.findMany({
    where: {
      action: "BOOKING_UNIT_SELECTED",
      entityType: "Booking",
      entityId: { in: bookingIds }
    },
    orderBy: { createdAt: "desc" }
  });

  const selectedByBooking = new Map<string, string>();
  for (const log of unitSelections) {
    if (!log.entityId || selectedByBooking.has(log.entityId)) continue;
    const metadata = parseAuditMetadata(log.metadataJson);
    if (typeof metadata.unitCode === "string") {
      selectedByBooking.set(log.entityId, metadata.unitCode);
    }
  }
  for (const value of selectedByBooking.values()) selectedUnits.add(value);
  return selectedUnits;
}

function buildBookingId(): string {
  return `WS-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
}

function normalizeGuestPhoneE164(input: string): string {
  const d = input.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("968")) return `+${d}`;
  if (d.length === 8) return `+968${d}`;
  return `+${d}`;
}

function nightsBetweenCheckInOut(checkIn: Date, checkOut: Date): number {
  const s = startOfDay(checkIn).getTime();
  const e = startOfDay(checkOut).getTime();
  const n = Math.round((e - s) / 86400000);
  return Math.max(1, n);
}

async function assertInventoryCanReserveTx(
  tx: Prisma.TransactionClient,
  params: { hotelId: string; roomTypeId: string; checkIn: Date; checkOut: Date; rooms: number }
): Promise<void> {
  const { hotelId, roomTypeId, checkIn, checkOut, rooms } = params;
  const roomType = await tx.roomType.findFirst({
    where: { id: roomTypeId, hotelId },
    select: { totalInventory: true }
  });
  const defaultTotal = roomType?.totalInventory ?? 1;
  let date = startOfDay(checkIn);
  const end = startOfDay(checkOut);
  while (date.getTime() < end.getTime()) {
    const dr = inventoryDayRangeExclusive(date);
    const row = await tx.inventory.findFirst({
      where: { hotelId, roomTypeId, date: { gte: dr.gte, lt: dr.lt } },
      select: { total: true, reserved: true, closedOut: true }
    });
    if (row?.closedOut) throw new Error("Inventory is closed for one or more nights in this stay.");
    const total = row?.total ?? defaultTotal;
    const reserved = row?.reserved ?? 0;
    if (reserved + rooms > total) throw new Error("Not enough availability for this stay (inventory is full for one or more nights).");
    date = addDays(date, 1);
  }
}

/** Synthetic platform session id is not a HotelUser row — must not be written to HotelUser FK columns. */
function hotelUserIdForPrismaFk(staffId: string | undefined | null): string | undefined {
  const s = typeof staffId === "string" ? staffId.trim() : "";
  if (!s || s === "STAFF-SUPERADMIN") return undefined;
  return s;
}

/** Real HotelUser id for folio FKs; never trust client-supplied staff ids — use session only. */
function requireHotelStaffIdForFolioJson(req: Request, res: Response): string | null {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return null;
  }
  const id = hotelUserIdForPrismaFk(session.staffId);
  if (!id) {
    res.status(401).json({ ok: false, error: "A hotel staff login is required for folio actions." });
    return null;
  }
  return id;
}

/** Prevent open redirects and protocol tricks in ?returnTo / form body. */
function safeAdminReturnToPath(raw: unknown, fallback: string): string {
  const t = String(raw ?? "").trim();
  if (!t.startsWith("/") || t.startsWith("//") || t.includes("://") || /[\n\r]/.test(t)) return fallback;
  return t;
}

async function logAudit(params: {
  hotelId: string;
  action: string;
  entityType: string;
  entityId?: string;
  bookingId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const actor = auditActorContext.getStore();
  await prisma.auditLog.create({
    data: {
      hotelId: params.hotelId,
      actorUserId: hotelUserIdForPrismaFk(actor?.staffId),
      actorEmail: actor?.staffEmail ?? process.env.ADMIN_EMAIL ?? "admin@chatastay.local",
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      bookingId: params.bookingId ?? undefined,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : undefined
    }
  });
}

async function ensureHousekeepingTaskForCleaningTx(
  tx: Prisma.TransactionClient,
  params: {
    hotelId: string;
    roomUnitId: string;
    source: HousekeepingTaskSource;
    bookingId?: string | null;
    createdByUserId?: string | null;
    notes?: string | null;
  }
): Promise<{ created: boolean; taskId: string | null }> {
  const open = await tx.housekeepingTask.findFirst({
    where: {
      hotelId: params.hotelId,
      roomUnitId: params.roomUnitId,
      status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
    },
    select: { id: true }
  });
  if (open) return { created: false, taskId: open.id };
  const task = await tx.housekeepingTask.create({
    data: {
      hotelId: params.hotelId,
      roomUnitId: params.roomUnitId,
      status: HousekeepingTaskStatus.PENDING,
      source: params.source,
      bookingId: params.bookingId ?? undefined,
      createdByUserId: hotelUserIdForPrismaFk(params.createdByUserId ?? undefined),
      notes: writeHousekeepingShift(params.notes ?? undefined, deriveHousekeepingShift(new Date()))
    }
  });
  const picked = await pickCleanerForAutoAssign(tx, params.hotelId);
  if (picked) {
    await tx.housekeepingTask.update({
      where: { id: task.id },
      data: {
        assignedToUserId: picked.id,
        assignmentMode: HousekeepingAssignmentMode.AUTO
      }
    });
  }
  return { created: true, taskId: task.id };
}

type HousekeepingShiftCode = "MORNING" | "EVENING" | "NIGHT";
type HousekeepingPriorityCode = "CRITICAL" | "HIGH" | "MEDIUM" | "NORMAL";

function parseHousekeepingShift(notes: string | null | undefined): HousekeepingShiftCode | null {
  if (!notes) return null;
  const m = notes.match(/@hk-shift:(MORNING|EVENING|NIGHT)@/i);
  return (m?.[1]?.toUpperCase() as HousekeepingShiftCode | undefined) ?? null;
}

function writeHousekeepingShift(notes: string | null | undefined, shift: HousekeepingShiftCode): string {
  const base = (notes ?? "").replace(/\s*@hk-shift:(MORNING|EVENING|NIGHT)@\s*/gi, " ").trim();
  const token = `@hk-shift:${shift}@`;
  return base ? `${base} ${token}` : token;
}

function deriveHousekeepingShift(at: Date): HousekeepingShiftCode {
  const hour = at.getHours();
  if (hour >= 6 && hour < 14) return "MORNING";
  if (hour >= 14 && hour < 22) return "EVENING";
  return "NIGHT";
}

function parseHousekeepingShiftInput(input: unknown): HousekeepingShiftCode {
  const v = String(input ?? "").trim().toUpperCase();
  if (v === "MORNING" || v === "EVENING" || v === "NIGHT") return v;
  return deriveHousekeepingShift(new Date());
}

/** In-progress cleans past this many minutes appear in supervisor "stalled" views. */
const HK_SUPERVISOR_STALLED_MINUTES = 90;
/** Unclaimed tasks with next arrival inside this window appear as "due soon". */
const HK_SUPERVISOR_DUE_SOON_MS = 4 * 60 * 60 * 1000;

type HkPortalListFilters = {
  priority: "ALL" | HousekeepingPriorityCode;
  shift: "ALL" | HousekeepingShiftCode;
  mine: boolean;
};

function buildHkPortalListQueryString(f: HkPortalListFilters): string {
  const p = new URLSearchParams();
  if (f.priority !== "ALL") p.set("priority", f.priority);
  if (f.shift !== "ALL") p.set("shift", f.shift);
  if (f.mine) p.set("mine", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

function parseHkPortalListFilters(req: { query: Record<string, unknown> }): HkPortalListFilters {
  const priorityRaw = typeof req.query.priority === "string" ? req.query.priority.trim().toUpperCase() : "ALL";
  const priority: "ALL" | HousekeepingPriorityCode =
    priorityRaw === "CRITICAL" || priorityRaw === "HIGH" || priorityRaw === "MEDIUM" || priorityRaw === "NORMAL" ? priorityRaw : "ALL";
  const shiftRaw = typeof req.query.shift === "string" ? req.query.shift.trim().toUpperCase() : "ALL";
  const shift: "ALL" | HousekeepingShiftCode =
    shiftRaw === "MORNING" || shiftRaw === "EVENING" || shiftRaw === "NIGHT" ? shiftRaw : "ALL";
  const mineRaw = typeof req.query.mine === "string" ? req.query.mine.trim().toLowerCase() : "";
  const mine = mineRaw === "1" || mineRaw === "true" || mineRaw === "yes";
  return { priority, shift, mine };
}

function hkPortalListHiddenInputs(f: HkPortalListFilters): string {
  const parts: string[] = [];
  if (f.priority !== "ALL") parts.push(`<input type="hidden" name="hkListPriority" value="${escapeHtml(f.priority)}" />`);
  if (f.shift !== "ALL") parts.push(`<input type="hidden" name="hkListShift" value="${escapeHtml(f.shift)}" />`);
  if (f.mine) parts.push('<input type="hidden" name="hkListMine" value="1" />');
  return parts.join("");
}

function redirectPathPreservingHkListFilters(path: string, body: Record<string, unknown>): string {
  const qMark = path.indexOf("?");
  const pathname = qMark === -1 ? path : path.slice(0, qMark);
  const existing = qMark === -1 ? "" : path.slice(qMark + 1);
  const sp = new URLSearchParams(existing);
  const priority = String(body.hkListPriority ?? "").trim().toUpperCase();
  if (priority === "CRITICAL" || priority === "HIGH" || priority === "MEDIUM" || priority === "NORMAL") sp.set("priority", priority);
  else sp.delete("priority");
  const shift = String(body.hkListShift ?? "").trim().toUpperCase();
  if (shift === "MORNING" || shift === "EVENING" || shift === "NIGHT") sp.set("shift", shift);
  else sp.delete("shift");
  if (String(body.hkListMine ?? "").trim() === "1") sp.set("mine", "1");
  else sp.delete("mine");
  const tail = sp.toString();
  return tail ? `${pathname}?${tail}` : pathname;
}

function housekeepingDashboardHref(
  current: {
    claimView: string;
    shift: string;
    priority: string;
    exception: "none" | "stalled" | "duesoon";
    statsDate: string;
    perfFrom: string;
    perfTo: string;
  },
  overrides: Partial<{
    claimView: string;
    shift: string;
    priority: string;
    exception: "none" | "stalled" | "duesoon";
    statsDate: string;
    perfFrom: string;
    perfTo: string;
  }>
): string {
  const p = new URLSearchParams();
  p.set("claimView", overrides.claimView ?? current.claimView);
  p.set("shift", overrides.shift ?? current.shift);
  p.set("priority", overrides.priority ?? current.priority);
  const ex = overrides.exception !== undefined ? overrides.exception : current.exception;
  if (ex !== "none") p.set("exception", ex === "stalled" ? "stalled" : "duesoon");
  p.set("statsDate", overrides.statsDate ?? current.statsDate);
  p.set("perfFrom", overrides.perfFrom ?? current.perfFrom);
  p.set("perfTo", overrides.perfTo ?? current.perfTo);
  return `/admin/housekeeping?${p.toString()}`;
}

function housekeepingDurationMinutes(start: Date | null | undefined, end: Date | null | undefined): number | null {
  if (!start || !end) return null;
  const diff = end.getTime() - start.getTime();
  if (!Number.isFinite(diff) || diff < 0) return null;
  return Math.round(diff / 60000);
}

function formatDurationMinutes(mins: number | null): string {
  if (mins === null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Rule-based housekeeping urgency (no duplicate task store; explainable for staff). */
function evaluateHousekeepingTaskPriority(params: {
  bookingCheckIn?: Date | null;
  bookingGuestVip?: boolean;
  taskSource?: HousekeepingTaskSource;
  /** Departing stay linked to the HK task (e.g. checkout clean). */
  linkedBookingCheckOut?: Date | null;
  /** Confirmed arrival on this unit with check-in calendar day = today. */
  hasArrivalToday?: boolean;
}): { level: HousekeepingPriorityCode; reason: string } {
  const now = new Date();
  const startToday = startOfDay(now);
  const beforeStandardCheckIn = now.getHours() < 15;
  const checkIn = params.bookingCheckIn ? startOfDay(params.bookingCheckIn) : null;
  const dayDiff =
    checkIn !== null ? Math.round((checkIn.getTime() - startToday.getTime()) / 86400000) : null;
  const checkoutDay = params.linkedBookingCheckOut ? startOfDay(params.linkedBookingCheckOut) : null;
  const checkoutToday = checkoutDay !== null && checkoutDay.getTime() === startToday.getTime();
  const sameDayTurnover = Boolean(checkoutToday && params.hasArrivalToday);

  if (params.bookingGuestVip && dayDiff !== null && dayDiff <= 0) {
    return { level: "CRITICAL", reason: "VIP arrival today" };
  }
  if (sameDayTurnover) {
    return { level: "CRITICAL", reason: "Same-day turnaround — arrival with checkout today" };
  }
  if (dayDiff === 0 && beforeStandardCheckIn) {
    return { level: "HIGH", reason: "Same-day arrival — early service window" };
  }
  if (params.bookingGuestVip && dayDiff === 1) {
    return { level: "HIGH", reason: "VIP arrival tomorrow" };
  }
  if (params.taskSource === HousekeepingTaskSource.CHECKOUT && checkoutToday) {
    return { level: "HIGH", reason: "Checkout today — prepare for next guest" };
  }
  if (dayDiff === 0 || dayDiff === 1) {
    return { level: "MEDIUM", reason: "Arrival due today or tomorrow" };
  }
  if (params.taskSource === HousekeepingTaskSource.CHECKOUT) {
    return { level: "MEDIUM", reason: "Post-checkout cleaning" };
  }
  if (params.taskSource === HousekeepingTaskSource.FRONTDESK) {
    return { level: "MEDIUM", reason: "Front desk cleaning request" };
  }
  return { level: "NORMAL", reason: "Standard cleaning queue" };
}

function housekeepingPriorityRank(level: HousekeepingPriorityCode): number {
  switch (level) {
    case "CRITICAL":
      return 0;
    case "HIGH":
      return 1;
    case "MEDIUM":
      return 2;
    default:
      return 3;
  }
}

function computeHousekeepingPriority(params: {
  bookingCheckIn?: Date | null;
  bookingGuestVip?: boolean;
}): HousekeepingPriorityCode {
  return evaluateHousekeepingTaskPriority({
    bookingCheckIn: params.bookingCheckIn,
    bookingGuestVip: params.bookingGuestVip
  }).level;
}

async function loadHousekeepingCleanerWorkloads(hotelId: string): Promise<Array<{ id: string; name: string; active: number }>> {
  const ranked = await rankHousekeepingCleanersForAutoAssign(prisma, hotelId);
  return ranked.map((r) => ({ id: r.id, name: r.fullName, active: r.activeWorkload }));
}

async function notifyHousekeepingStaff(opts: {
  hotelId: string;
  title: string;
  body: string;
  type: string;
  payloadJson?: string;
  severity?: "critical" | "high" | "normal" | "info";
  link?: string;
}): Promise<void> {
  const users = await prisma.hotelUser.findMany({
    where: { hotelId: opts.hotelId, isActive: true },
    select: { id: true, email: true, role: true }
  });
  for (const u of users) {
    if (!u.email) continue;
    const matrix = effectivePermissionsForHotelUser(u.email, u.role);
    if (!hasPermission(matrix, "HOUSEKEEPING", "VIEW")) continue;
    await createNotification({
      hotelId: opts.hotelId,
      userId: u.id,
      title: opts.title,
      body: opts.body,
      category: "housekeeping",
      severity: opts.severity ?? "high",
      link: opts.link ?? "/admin/housekeeping",
      sourceType: opts.type,
      sourceId: undefined,
      requiresAttention: (opts.severity ?? "high") !== "info"
    });
  }
}

function isOptionalHousekeepingSchemaError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.toLowerCase();
  if (!msg.includes("no such table")) return false;
  return msg.includes("housekeepingtask") || msg.includes("notification");
}

function isHotelUserSchemaMismatchError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2022") return true;
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.toLowerCase();
  if (msg.includes("does not exist in the current database")) return true;
  if (!msg.includes("hoteluser")) return false;
  return msg.includes("no such table") || msg.includes("no such column");
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

function getSessionToken(req: Request): string | undefined {
  return parseCookies(req)[sessionCookieName];
}

function getSession(req: Request): AdminSession | undefined {
  const token = getSessionToken(req);
  if (!token) return undefined;
  return activeSessions.get(token);
}

/** Platform (app) owner — same identity as full-permission admin login; optional extra list via env. */
function isPlatformOwnerEmail(email: string | undefined | null): boolean {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const primary = (process.env.ADMIN_EMAIL ?? "admin@chatastay.local").trim().toLowerCase();
  if (normalized === primary) return true;
  const extra = (process.env.PLATFORM_OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(normalized);
}

/** Leads + client property onboarding — platform owner / super-admin only (not hotel partner staff). */
function isPlatformAcquisitionSession(session: AdminSession | undefined): boolean {
  if (!session) return false;
  if (session.staffId === "STAFF-SUPERADMIN") return true;
  return isPlatformOwnerEmail(session.email);
}

function requirePlatformAcquisition(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session) {
    res.redirect("/admin/login");
    return;
  }
  if (!isPlatformAcquisitionSession(session)) {
    res
      .status(403)
      .type("html")
      .send(
        renderLayout(
          "<h2>Access denied</h2><p>Lead pipeline and platform property onboarding are restricted to platform administrators.</p>",
          true
        )
      );
    return;
  }
  next();
}

function requirePlatformOwner(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session) {
    res.redirect("/admin/login");
    return;
  }
  if (!isPlatformOwnerEmail(session.email)) {
    res
      .status(403)
      .type("html")
      .send(
        renderLayout(
          "<h2>Access denied</h2><p>Only the platform owner can create or change room units and physical inventory structure.</p>",
          true
        )
      );
    return;
  }
  next();
}

function isAuthenticated(req: Request): boolean {
  return Boolean(getSession(req));
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.redirect("/admin/login");
    return;
  }
  next();
}

function requireHousekeepingPortal(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session || session.role !== "HOUSEKEEPING") {
    res.redirect("/admin/login");
    return;
  }
  next();
}

function pickPostLoginRedirect(role: string): string {
  if (role === "HOUSEKEEPING") return "/admin/hk";
  if (role === "FRONTDESK") return "/admin/room-board";
  if (role === "MANAGER" || role === "OWNER" || role === "ADMIN") return "/admin/profile";
  return "/admin/dashboard";
}

function hasPermission(
  permissions: PermissionMatrix,
  moduleName: PermissionModule,
  action: PermissionAction
): boolean {
  const row = permissions[moduleName];
  return Boolean(row?.MANAGE || row?.[action]);
}

function requirePermission(moduleName: PermissionModule, action: PermissionAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.redirect("/admin/login");
      return;
    }
    if (!hasPermission(session.permissions, moduleName, action)) {
      res
        .status(403)
        .type("html")
        .send(renderLayout("<h2>Access denied</h2><p>You do not have permission to access this module.</p>", true));
      return;
    }
    next();
  };
}

function requirePermissionJson(moduleName: PermissionModule, action: PermissionAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    if (!hasPermission(session.permissions, moduleName, action)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    next();
  };
}

/** Grant access if any of the module/action pairs matches (OR). */
function requirePermissionAny(checks: Array<{ module: PermissionModule; action: PermissionAction }>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.redirect("/admin/login");
      return;
    }
    const ok = checks.some((c) => hasPermission(session.permissions, c.module, c.action));
    if (!ok) {
      res
        .status(403)
        .type("html")
        .send(renderLayout("<h2>Access denied</h2><p>You do not have permission to access this module.</p>", true));
      return;
    }
    next();
  };
}

function requirePermissionAnyJson(checks: Array<{ module: PermissionModule; action: PermissionAction }>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const ok = checks.some((c) => hasPermission(session.permissions, c.module, c.action));
    if (!ok) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    next();
  };
}

/** Master F&amp;B page: outlet/restaurant staff or reservations — backward compatible with BOOKINGS-only users. */
function requireFbOperationsView() {
  return requirePermissionAny([
    { module: "OUTLET", action: "VIEW" },
    { module: "BOOKINGS", action: "VIEW" }
  ]);
}

function requireFbOperationsEdit() {
  return requirePermissionAny([
    { module: "OUTLET", action: "EDIT" },
    { module: "BOOKINGS", action: "EDIT" }
  ]);
}

function classifyConversationActivity(
  state: ConversationState,
  hasBooking: boolean
): "booking" | "inquiry" {
  if (hasBooking) return "booking";
  if (
    state === ConversationState.QUALIFYING ||
    state === ConversationState.QUOTED ||
    state === ConversationState.PAYMENT_PENDING ||
    state === ConversationState.CONFIRMED
  ) {
    return "booking";
  }
  return "inquiry";
}

adminRouter.use((req, _res, next) => {
  const session = getSession(req);
  auditActorContext.run(
    {
      staffId: session?.staffId,
      staffEmail: session?.email ?? process.env.ADMIN_EMAIL ?? "admin@chatastay.local",
      session
    },
    () => next()
  );
});

/** Housekeeping staff: dedicated portal under /admin/hk (no full admin chrome). */
adminRouter.use((req, res, next) => {
  const session = getSession(req);
  if (session?.role === "HOUSEKEEPING") {
    if (req.path === "/logout") {
      next();
      return;
    }
    const p = req.path;
    if (p === "/hk" || p.startsWith("/hk/room-board") || p.startsWith("/hk/task/")) {
      next();
      return;
    }
    res.redirect("/admin/hk");
    return;
  }
  next();
});

adminRouter.get("/", (req, res) => {
  if (!isAuthenticated(req)) {
    res.redirect("/admin/login");
    return;
  }
  res.redirect("/admin/profile");
});

adminRouter.get("/login", (req, res) => {
  if (isAuthenticated(req)) {
    const s = getSession(req);
    res.redirect(pickPostLoginRedirect(s?.role ?? ""));
    return;
  }
  const resetNotice = req.query.reset ? '<p class="badge ok">Password updated. Sign in with your new password.</p>' : "";
  const authErrorNotice =
    req.query.auth === "error" ? '<p class="badge alert">Sign in is temporarily unavailable. Please try again.</p>' : "";
  const staffNotice = req.query.staff === "failed" ? '<p class="badge alert">Staff sign in failed. Check your username and PIN.</p>' : "";
  const staffErrorNotice =
    req.query.staff === "error" ? '<p class="badge alert">Staff sign in is temporarily unavailable. Please try again.</p>' : "";
  const onboardNotice =
    req.query.onboard === "1" ? '<p class="badge ok">Property onboarding complete. You can sign in now.</p>' : "";
  const onboardLink =
    '<p class="muted" style="margin-top:12px">New partner? <a class="inline-link" href="/admin/onboard">Start property onboarding</a></p>';
  const content = resetNotice + authErrorNotice + staffNotice + staffErrorNotice + onboardNotice + readView("login.html") + onboardLink;
  res.type("html").send(renderLayout(content, false));
});

adminRouter.get("/onboard", async (req, res) => {
  const session = getSession(req);
  if (session && !isPlatformAcquisitionSession(session)) {
    res.redirect("/admin/profile");
    return;
  }
  const err = typeof req.query.error === "string" ? String(req.query.error) : "";
  const leadId = typeof req.query.leadId === "string" ? String(req.query.leadId) : "";
  const errHtml = err ? `<p class="badge alert">${escapeHtml(err)}</p>` : "";
  const lead = leadId
    ? await prisma.lead.findFirst({
        where: { id: leadId },
        select: { id: true, hotelName: true, contactEmail: true, contactName: true, location: true }
      })
    : null;
  const propertyNameVal = escapeHtml(String(req.query.propertyName ?? lead?.hotelName ?? ""));
  const cityVal = escapeHtml(String(req.query.city ?? lead?.location ?? ""));
  const emailVal = escapeHtml(String(req.query.email ?? lead?.contactEmail ?? ""));
  const ownerNameVal = escapeHtml(String(req.query.ownerName ?? lead?.contactName ?? ""));
  const onboardTitle = session ? "Onboard new property" : "Partner onboarding";
  const onboardLead = session
    ? "Creates a new property under this platform account, default room type, units, and a property owner login."
    : "Set up your property in minutes. This creates your property, default room setup, and owner account.";
  const content = `
<h2>${escapeHtml(onboardTitle)}</h2>
<p class="muted">${onboardLead}</p>
${errHtml}
<form method="post" action="/admin/onboard" style="max-width:760px; display:grid; gap:12px">
  <input type="hidden" name="leadId" value="${escapeHtml(lead?.id ?? leadId)}" />
  <label>Property name
    <input name="propertyName" required placeholder="Example Beach Resort" value="${propertyNameVal}" style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <label>Location (city)
    <input name="city" required placeholder="Muscat" value="${cityVal}" style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <label>Contact email
    <input type="email" name="email" required placeholder="owner@property.com" value="${emailVal}" style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <label>Owner full name
    <input name="ownerName" required placeholder="Property Owner" value="${ownerNameVal}" style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <label>Password
    <input type="password" name="password" required minlength="8" placeholder="At least 8 characters" style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <label>Rooms / units
    <input type="number" name="units" min="1" max="500" value="12" required style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <label>Default language
    <select name="defaultLanguage" style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px">
      <option value="en">English</option>
      <option value="ar">Arabic</option>
    </select>
  </label>
  <label>WhatsApp number (optional)
    <input name="whatsappPhone" placeholder="+968..." style="width:100%; margin-top:6px; padding:10px; border:1px solid #d8dee6; border-radius:10px" />
  </label>
  <button type="submit" style="padding:10px 16px; border:0; border-radius:10px; background:#25d366; color:#083d2d; font-weight:700; width:fit-content">Create property</button>
</form>
<p class="muted" style="margin-top:12px">${session ? '<a class="inline-link" href="/admin/profile">Back to profile</a>' : '<a href="/admin/login">Back to login</a>'}</p>`;
  res.type("html").send(renderLayout(content, Boolean(session)));
});

adminRouter.post("/onboard", async (req, res) => {
  const session = getSession(req);
  if (session && !isPlatformAcquisitionSession(session)) {
    res.redirect("/admin/profile");
    return;
  }
  const propertyName = String(req.body.propertyName ?? "").trim();
  const city = String(req.body.city ?? "").trim();
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const ownerName = String(req.body.ownerName ?? "").trim();
  const password = String(req.body.password ?? "");
  const unitsRaw = parseInt(String(req.body.units ?? "12"), 10);
  const units = Number.isFinite(unitsRaw) ? Math.max(1, Math.min(500, unitsRaw)) : 12;
  const defaultLanguage = String(req.body.defaultLanguage ?? "en") === "ar" ? "ar" : "en";
  const whatsappPhone = String(req.body.whatsappPhone ?? "").trim();
  const leadId = String(req.body.leadId ?? "").trim();

  if (!propertyName || !city || !email || !ownerName || password.length < 8) {
    res.redirect("/admin/onboard?error=Please+complete+all+required+fields");
    return;
  }

  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/onboard?error=Platform+hotel+is+not+configured");
    return;
  }
  const existingUser = await prisma.hotelUser.findUnique({
    where: { hotelId_email: { hotelId: hotel.id, email } },
    select: { id: true }
  });
  if (existingUser) {
    res.redirect("/admin/onboard?error=Email+already+exists+for+this+platform");
    return;
  }

  const propertyCode = await uniquePropertyCode(hotel.id, propertyName);
  const ownerPasswordHash = await hashSecret(password);

  const created = await prisma.$transaction(async (tx) => {
    const property = await tx.property.create({
      data: {
        hotelId: hotel.id,
        name: propertyName,
        city,
        addressLine1: null,
        checkInTime: "14:00",
        checkOutTime: "11:00"
      }
    });
    const roomType = await tx.roomType.create({
      data: {
        hotelId: hotel.id,
        propertyId: property.id,
        name: "Standard Room",
        code: `${propertyCode}_STD`,
        capacity: 2,
        baseNightlyRate: 35,
        totalInventory: units,
        isActive: true
      }
    });
    if (units > 0) {
      await tx.roomUnit.createMany({
        data: Array.from({ length: units }).map((_, idx) => ({
          hotelId: hotel.id,
          roomTypeId: roomType.id,
          name: `${propertyCode}-${String(idx + 1).padStart(3, "0")}`,
          sortOrder: idx
        }))
      });
    }
    const owner = await tx.hotelUser.create({
      data: {
        hotelId: hotel.id,
        fullName: ownerName,
        email,
        username: slugifyName(`${ownerName}-${propertyCode}`).slice(0, 30) || `owner_${propertyCode.toLowerCase()}`,
        passwordHash: ownerPasswordHash,
        role: UserRole.OWNER,
        isActive: true
      }
    });
    await tx.auditLog.create({
      data: {
        hotelId: hotel.id,
        actorUserId: owner.id,
        actorEmail: email,
        action: "PARTNER_ONBOARDING_COMPLETED",
        entityType: "Property",
        entityId: property.id,
        metadataJson: JSON.stringify({
          propertyName,
          city,
          units,
          defaultLanguage,
          whatsappPhone
        })
      }
    });
    return { propertyId: property.id };
  });

  const cfg = loadPartnerSetupConfig(hotel.id);
  cfg.hotelDescription = `${propertyName} in ${city}.`;
  cfg.whatsappPhoneNumberId = cfg.whatsappPhoneNumberId || "";
  if (whatsappPhone) cfg.outletRestaurantWhatsAppE164 = cfg.outletRestaurantWhatsAppE164 || whatsappPhone;
  cfg.aiEnabled = true;
  savePartnerSetupConfig(cfg, hotel.id);

  await prisma.hotel.update({
    where: { id: hotel.id },
    data: { whatsappPhone: whatsappPhone || hotel.whatsappPhone, isActive: true }
  });
  await prisma.property.update({
    where: { id: created.propertyId },
    data: { city }
  });
  if (leadId) {
    await prisma.lead
      .updateMany({
        where: { id: leadId, hotelId: hotel.id },
        data: {
          status: "converted",
          convertedPropertyId: created.propertyId
        }
      })
      .catch(() => undefined);
    await trackDecisionEventSafe({
      hotelId: hotel.id,
      propertyId: created.propertyId,
      eventType: "lead_converted",
      source: "onboarding",
      dedupeKey: `lead_converted:${leadId}:${created.propertyId}`,
      metadata: { leadId, propertyId: created.propertyId, propertyName }
    });
  }
  if (session && isPlatformAcquisitionSession(session)) {
    res.redirect("/admin/profile?propertyOnboarded=1");
    return;
  }
  res.redirect("/admin/login?onboard=1");
});

async function createPasswordResetForEmail(email: string, req: Request): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  if (isResetRateLimited(req, normalized)) return;

  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) return;
  const user = await prisma.hotelUser.findUnique({
    where: { hotelId_email: { hotelId: hotel.id, email: normalized } },
    select: { id: true, email: true, isActive: true }
  });
  await prisma.auditLog.create({
    data: {
      hotelId: hotel.id,
      actorEmail: normalized,
      action: "PASSWORD_RESET_REQUESTED",
      entityType: "Auth",
      entityId: user?.id ?? null,
      metadataJson: JSON.stringify({
        outcome: user?.isActive ? "accepted" : "ignored",
        ip: getRequestIp(req)
      })
    }
  });
  if (!user?.isActive || !user.email) return;

  const token = generateSecureToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + passwordResetTtlMs);
  await prisma.hotelUser.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
      passwordResetRequestedAt: new Date()
    }
  });
  const resetBase = (process.env.APP_BASE_URL || appBaseUrl).replace(/\/$/, "") || "https://chatastay.com";
  const resetLink = `${resetBase}/reset-password?token=${encodeURIComponent(token)}`;
  const sent = await sendPasswordResetEmail(user.email, resetLink);
  if (!sent) {
    await prisma.auditLog.create({
      data: {
        hotelId: hotel.id,
        actorUserId: user.id,
        actorEmail: user.email,
        action: "PASSWORD_RESET_INVALID_TOKEN",
        entityType: "Auth",
        entityId: user.id,
        metadataJson: JSON.stringify({ reason: "email_send_failed" })
      }
    });
  }
}

async function consumePasswordResetToken(rawToken: string, newPassword: string): Promise<{ ok: boolean; reason?: string }> {
  if (!rawToken || newPassword.length < 8) return { ok: false, reason: "invalid_input" };
  const tokenHash = hashResetToken(rawToken);
  const user = await prisma.hotelUser.findFirst({
    where: { passwordResetTokenHash: tokenHash },
    select: {
      id: true,
      hotelId: true,
      email: true,
      role: true,
      isActive: true,
      passwordResetExpiresAt: true
    }
  });
  if (!user || !user.isActive) {
    const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (hotel) {
      await prisma.auditLog.create({
        data: {
          hotelId: hotel.id,
          action: "PASSWORD_RESET_INVALID_TOKEN",
          entityType: "Auth",
          metadataJson: JSON.stringify({ reason: "invalid_or_expired_token" })
        }
      });
    }
    return { ok: false, reason: "invalid_or_expired" };
  }
  if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() <= Date.now()) {
    await prisma.auditLog.create({
      data: {
        hotelId: user.hotelId,
        actorUserId: user.id,
        actorEmail: user.email ?? undefined,
        action: "PASSWORD_RESET_EXPIRED",
        entityType: "Auth",
        entityId: user.id
      }
    });
    return { ok: false, reason: "invalid_or_expired" };
  }
  const passwordHash = await hashSecret(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.hotelUser.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        passwordResetRequestedAt: null
      }
    });
    await tx.auditLog.create({
      data: {
        hotelId: user.hotelId,
        actorUserId: user.id,
        actorEmail: user.email ?? undefined,
        action: "PASSWORD_RESET_COMPLETED",
        entityType: "Auth",
        entityId: user.id
      }
    });
  });
  return { ok: true };
}

async function authenticateEmailLogin(req: Request, res: Response): Promise<string | null> {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");

  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@chatastay.local").trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? "admin123";

  if (email === adminEmail && password === adminPassword) {
    issueAdminSession(res, {
      staffId: "STAFF-SUPERADMIN",
      email,
      role: "MANAGER",
      permissions: getPermissionsForEmail(email)
    });
    return "MANAGER";
  }
  try {
    const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
    if (hotel) {
      const hotelUser = await prisma.hotelUser.findUnique({
        where: { hotelId_email: { hotelId: hotel.id, email } }
      });
      if (hotelUser?.isActive && hotelUser.passwordHash) {
        if (await verifySecret(password, hotelUser.passwordHash)) {
          const effectivePermissions = effectivePermissionsForHotelUser(email, hotelUser.role);
          issueAdminSession(res, {
            staffId: hotelUser.id,
            email,
            role: String(hotelUser.role),
            permissions: effectivePermissions
          });
          await prisma.hotelUser.update({
            where: { id: hotelUser.id },
            data: { lastLoginAt: new Date() }
          });
          return String(hotelUser.role);
        }
      }
    }
  } catch (err) {
    console.error("[Auth] email login failed safely:", err instanceof Error ? err.message : err);
    return null;
  }
  return null;
}

async function authenticateStaffLogin(req: Request, res: Response): Promise<string | null> {
  try {
    const username = String(req.body.username ?? "").trim().toLowerCase();
    const pin = String(req.body.pin ?? "").trim();
    if (!username || pin.length < 4) return null;
    const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) return null;
    if (isStaffLoginRateLimited(req, hotel.id, username)) {
      await prisma.auditLog.create({
        data: {
          hotelId: hotel.id,
          actorEmail: username,
          action: "STAFF_LOGIN_FAILED",
          entityType: "Auth",
          metadataJson: JSON.stringify({ reason: "rate_limited", ip: getRequestIp(req) })
        }
      });
      return null;
    }
    const hotelUser = await prisma.hotelUser.findUnique({
      where: { hotelId_username: { hotelId: hotel.id, username } }
    });
    if (!hotelUser?.isActive || !hotelUser.pinHash) {
      recordStaffLoginFailure(req, hotel.id, username);
      await prisma.auditLog.create({
        data: {
          hotelId: hotel.id,
          actorEmail: username,
          action: "STAFF_LOGIN_FAILED",
          entityType: "Auth",
          metadataJson: JSON.stringify({ reason: "user_not_found_or_pin_missing", ip: getRequestIp(req) })
        }
      });
      return null;
    }
    if (!["FRONTDESK", "HOUSEKEEPING", "STAFF"].includes(String(hotelUser.role))) {
      recordStaffLoginFailure(req, hotel.id, username);
      await prisma.auditLog.create({
        data: {
          hotelId: hotel.id,
          actorUserId: hotelUser.id,
          actorEmail: hotelUser.email ?? username,
          action: "STAFF_LOGIN_FAILED",
          entityType: "Auth",
          entityId: hotelUser.id,
          metadataJson: JSON.stringify({ reason: "role_not_allowed", role: String(hotelUser.role), ip: getRequestIp(req) })
        }
      });
      return null;
    }
    if (!(await verifyPin(pin, hotelUser.pinHash))) {
      recordStaffLoginFailure(req, hotel.id, username);
      await prisma.auditLog.create({
        data: {
          hotelId: hotel.id,
          actorUserId: hotelUser.id,
          actorEmail: hotelUser.email ?? username,
          action: "STAFF_LOGIN_FAILED",
          entityType: "Auth",
          entityId: hotelUser.id,
          metadataJson: JSON.stringify({ reason: "pin_invalid", ip: getRequestIp(req) })
        }
      });
      return null;
    }
    clearStaffLoginFailures(req, hotel.id, username);
    await prisma.auditLog.create({
      data: {
        hotelId: hotel.id,
        actorUserId: hotelUser.id,
        actorEmail: hotelUser.email ?? username,
        action: "STAFF_LOGIN_SUCCESS",
        entityType: "Auth",
        entityId: hotelUser.id,
        metadataJson: JSON.stringify({ role: String(hotelUser.role), ip: getRequestIp(req) })
      }
    });
    const effectivePermissions = effectivePermissionsForHotelUser(hotelUser.email ?? username, hotelUser.role);
    issueAdminSession(res, {
      staffId: hotelUser.id,
      email: hotelUser.email ?? username,
      role: String(hotelUser.role),
      permissions: effectivePermissions
    });
    await prisma.hotelUser.update({
      where: { id: hotelUser.id },
      data: { lastLoginAt: new Date() }
    });
    return String(hotelUser.role);
  } catch (err) {
    console.error("[Auth] staff login failed safely:", err instanceof Error ? err.message : err);
    return null;
  }
}

adminRouter.post("/login", async (req, res) => {
  try {
    const role = await authenticateEmailLogin(req, res);
    if (role) {
      res.redirect(pickPostLoginRedirect(role));
      return;
    }
    res.status(401).type("html").send(renderPage("login.html", false));
  } catch (err) {
    console.error("[Auth] /admin/login unexpected error:", err instanceof Error ? err.message : err);
    res.redirect("/admin/login?auth=error");
  }
});

adminRouter.get("/forgot-password", (req, res) => {
  if (isAuthenticated(req)) {
    res.redirect("/admin/dashboard");
    return;
  }
  const notice = req.query.sent ? '<p class="badge ok">If an account exists for that email, we sent a reset link. Check your inbox and spam folder.</p>' : "";
  const content = `
<h2>Forgot Password</h2>
<p class="muted">Enter the email address for your admin account. We will send a secure reset link (valid for 15 minutes).</p>
${notice}
<form method="post" action="/admin/forgot-password" style="max-width: 420px">
  <label for="email">Email</label><br />
  <input id="email" type="email" name="email" required style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <button type="submit" style="width: 100%; padding: 10px 14px; border: 0; border-radius: 10px; background: #25d366; color: #083d2d; font-weight: 700">Send reset link</button>
</form>
<p class="muted" style="margin-top: 12px"><a href="/admin/login">Back to login</a></p>`;
  res.type("html").send(renderLayout(content, false));
});

adminRouter.post("/forgot-password", async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  await createPasswordResetForEmail(email, req);
  res.redirect("/admin/forgot-password?sent=1");
});

adminRouter.get("/reset-password", async (req, res) => {
  if (isAuthenticated(req)) {
    res.redirect("/admin/dashboard");
    return;
  }
  const token = String(req.query.token ?? "").trim();
  const valid = Boolean(
    token &&
      (await prisma.hotelUser.findFirst({
        where: { passwordResetTokenHash: hashResetToken(token) },
        select: { id: true, isActive: true, passwordResetExpiresAt: true }
      }).then((r) => Boolean(r?.isActive && r.passwordResetExpiresAt && r.passwordResetExpiresAt.getTime() > Date.now())))
  );
  if (!valid) {
    const content = `
<h2>Reset Password</h2>
<p class="badge alert">This reset link is invalid or has expired. Request a new one from the <a href="/admin/forgot-password">forgot password</a> page.</p>
<p class="muted"><a href="/admin/login">Back to login</a></p>`;
    res.type("html").send(renderLayout(content, false));
    return;
  }
  const content = `
<h2>Set new password</h2>
<p class="muted">Choose a new password (at least 8 characters).</p>
<form method="post" action="/admin/reset-password" style="max-width: 420px">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <label for="newPassword">New password</label><br />
  <input id="newPassword" type="password" name="newPassword" required minlength="8" style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <label for="confirmPassword">Confirm password</label><br />
  <input id="confirmPassword" type="password" name="confirmPassword" required minlength="8" style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <button type="submit" style="width: 100%; padding: 10px 14px; border: 0; border-radius: 10px; background: #25d366; color: #083d2d; font-weight: 700">Update password</button>
</form>
<p class="muted" style="margin-top: 12px"><a href="/admin/login">Back to login</a></p>`;
  res.type("html").send(renderLayout(content, false));
});

adminRouter.post("/reset-password", async (req, res) => {
  const token = String(req.body.token ?? "").trim();
  const newPassword = String(req.body.newPassword ?? "");
  const confirmPassword = String(req.body.confirmPassword ?? "");
  if (newPassword.length < 8 || newPassword !== confirmPassword) {
    const content = `
<h2>Set new password</h2>
<p class="badge alert">Passwords must match and be at least 8 characters.</p>
<form method="post" action="/admin/reset-password" style="max-width: 420px">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <label for="newPassword">New password</label><br />
  <input id="newPassword" type="password" name="newPassword" required minlength="8" style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <label for="confirmPassword">Confirm password</label><br />
  <input id="confirmPassword" type="password" name="confirmPassword" required minlength="8" style="width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 12px; border: 1px solid #d8dee6; border-radius: 10px" />
  <button type="submit" style="width: 100%; padding: 10px 14px; border: 0; border-radius: 10px; background: #25d366; color: #083d2d; font-weight: 700">Update password</button>
</form>`;
    res.status(400).type("html").send(renderLayout(content, false));
    return;
  }
  const consumed = await consumePasswordResetToken(token, newPassword);
  if (!consumed.ok) {
    res.status(400).type("html").send(
      renderLayout("<h2>Reset Password</h2><p class=\"badge alert\">This reset link is invalid or has expired.</p><p><a href=\"/admin/forgot-password\">Request a new link</a></p>", false)
    );
    return;
  }
  res.redirect("/admin/login?reset=1");
});

authRouter.post("/request-password-reset", async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  await createPasswordResetForEmail(email, req);
  const accept = String(req.headers.accept ?? "").toLowerCase();
  if (accept.includes("text/html")) {
    res.redirect("/admin/forgot-password?sent=1");
    return;
  }
  res.json({ ok: true, message: "If an account exists for that email, a reset link was sent." });
});

authRouter.post("/reset-password", async (req, res) => {
  const token = String(req.body.token ?? "").trim();
  const newPassword = String(req.body.newPassword ?? "");
  const consumed = await consumePasswordResetToken(token, newPassword);
  if (!consumed.ok) {
    const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (hotel) {
      const action =
        consumed.reason === "invalid_or_expired" ? "PASSWORD_RESET_INVALID_TOKEN" : consumed.reason === "invalid_input" ? "PASSWORD_RESET_INVALID_TOKEN" : "PASSWORD_RESET_EXPIRED";
      await prisma.auditLog.create({
        data: {
          hotelId: hotel.id,
          action,
          entityType: "Auth",
          metadataJson: JSON.stringify({ reason: consumed.reason ?? "unknown" })
        }
      });
    }
    res.status(400).json({ ok: false, error: "invalid_or_expired_token" });
    return;
  }
  res.json({ ok: true });
});

authRouter.get("/reset-password", (req, res) => {
  const token = String(req.query.token ?? "").trim();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  res.redirect(`/admin/reset-password${query}`);
});

authRouter.post("/staff-login", async (req, res) => {
  try {
    const role = await authenticateStaffLogin(req, res);
    if (!role) {
      const accept = String(req.headers.accept ?? "").toLowerCase();
      if (accept.includes("text/html")) {
        res.redirect("/admin/login?staff=failed");
        return;
      }
      res.status(401).json({ ok: false, error: "invalid_credentials" });
      return;
    }
    const redirectTo = pickPostLoginRedirect(role);
    const accept = String(req.headers.accept ?? "").toLowerCase();
    if (accept.includes("text/html")) {
      res.redirect(redirectTo);
      return;
    }
    res.json({ ok: true, redirectTo });
  } catch (err) {
    console.error("[Auth] /auth/staff-login unexpected error:", err instanceof Error ? err.message : err);
    const accept = String(req.headers.accept ?? "").toLowerCase();
    if (accept.includes("text/html")) {
      res.redirect("/admin/login?staff=error");
      return;
    }
    res.status(500).json({ ok: false, error: "staff_login_unavailable" });
  }
});

authRouter.post("/email-login", async (req, res) => {
  try {
    const role = await authenticateEmailLogin(req, res);
    if (!role) {
      const accept = String(req.headers.accept ?? "").toLowerCase();
      if (accept.includes("text/html")) {
        res.redirect("/admin/login");
        return;
      }
      res.status(401).json({ ok: false, error: "invalid_credentials" });
      return;
    }
    const redirectTo = pickPostLoginRedirect(role);
    const accept = String(req.headers.accept ?? "").toLowerCase();
    if (accept.includes("text/html")) {
      res.redirect(redirectTo);
      return;
    }
    res.json({ ok: true, redirectTo });
  } catch (err) {
    console.error("[Auth] /auth/email-login unexpected error:", err instanceof Error ? err.message : err);
    const accept = String(req.headers.accept ?? "").toLowerCase();
    if (accept.includes("text/html")) {
      res.redirect("/admin/login?auth=error");
      return;
    }
    res.status(500).json({ ok: false, error: "email_login_unavailable" });
  }
});

authRouter.get("/notifications", async (req, res) => {
  const session = getSession(req);
  if (!session || !session.staffId || session.staffId === "STAFF-SUPERADMIN") {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const limitRaw = Number(req.query.limit ?? 10);
  const unreadOnly = String(req.query.unreadOnly ?? "").trim() === "1";
  const notifications = await listUserNotifications(session.staffId, {
    limit: Number.isFinite(limitRaw) ? limitRaw : 10,
    unreadOnly
  });
  res.json({ ok: true, notifications });
});

authRouter.get("/notifications/unread-count", async (req, res) => {
  const session = getSession(req);
  if (!session || !session.staffId || session.staffId === "STAFF-SUPERADMIN") {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const unreadCount = await getUnreadCount(session.staffId);
  res.json({ ok: true, unreadCount });
});

authRouter.post("/notifications/:id/read", async (req, res) => {
  const session = getSession(req);
  if (!session || !session.staffId || session.staffId === "STAFF-SUPERADMIN") {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    res.status(400).json({ ok: false, error: "invalid_id" });
    return;
  }
  const updated = await markNotificationRead(id, session.staffId);
  res.json({ ok: true, updated });
});

authRouter.post("/notifications/read-all", async (req, res) => {
  const session = getSession(req);
  if (!session || !session.staffId || session.staffId === "STAFF-SUPERADMIN") {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const updatedCount = await markAllNotificationsRead(session.staffId);
  res.json({ ok: true, updatedCount });
});

authRouter.get("/property-context", async (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const hotel = await getPlatformHotelBase();
  if (!hotel) {
    res.status(404).json({ ok: false, error: "hotel_not_found" });
    return;
  }
  const properties = await prisma.property.findMany({
    where: { hotelId: hotel.id },
    select: { id: true, name: true, city: true },
    orderBy: { createdAt: "asc" }
  });
  const validIds = new Set(properties.map((p) => p.id));
  let activePropertyId = session.activePropertyId ?? null;
  if (activePropertyId === allPropertiesKey && properties.length > 1) {
    res.json({ ok: true, activePropertyId, properties });
    return;
  }
  if (!activePropertyId || !validIds.has(activePropertyId)) {
    activePropertyId = properties[0]?.id ?? null;
    session.activePropertyId = activePropertyId;
  }
  res.json({ ok: true, activePropertyId, properties });
});

authRouter.post("/property-context", async (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const propertyId = String(req.body?.propertyId ?? "").trim();
  if (!propertyId) {
    res.status(400).json({ ok: false, error: "missing_property_id" });
    return;
  }
  const hotel = await getPlatformHotelBase();
  if (!hotel) {
    res.status(404).json({ ok: false, error: "hotel_not_found" });
    return;
  }
  if (propertyId === allPropertiesKey) {
    const propertyCount = await prisma.property.count({ where: { hotelId: hotel.id } });
    if (propertyCount > 1) {
      session.activePropertyId = allPropertiesKey;
      res.json({ ok: true, activePropertyId: allPropertiesKey });
      return;
    }
  }
  const property = await prisma.property.findFirst({
    where: { id: propertyId, hotelId: hotel.id },
    select: { id: true }
  });
  if (!property) {
    res.status(400).json({ ok: false, error: "invalid_property" });
    return;
  }
  session.activePropertyId = property.id;
  res.json({ ok: true, activePropertyId: property.id });
});

adminRouter.post("/logout", (req, res) => {
  const token = getSessionToken(req);
  if (token) activeSessions.delete(token);
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
  res.redirect("/admin/login");
});

function parsePermissionsFromBody(body: Record<string, unknown>): PermissionMatrix {
  const matrix = buildNoPermissions();
  for (const moduleName of permissionModules) {
    for (const action of permissionActions) {
      const key = `${moduleName}_${action}`;
      matrix[moduleName][action] = body[key] === "on";
    }
  }
  return matrix;
}

adminRouter.get("/users", requirePermission("USERS", "VIEW"), async (req, res) => {
  let users: Array<{
    fullName: string | null;
    email: string | null;
    username: string | null;
    role: UserRole | string | null;
    isActive: boolean | null;
  }> = [];
  try {
    const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
    if (!hotel) {
      res.type("html").send(renderLayout("<h2>Users</h2><p>No hotel data found.</p>", true));
      return;
    }
    users = await prisma.hotelUser.findMany({
      where: { hotelId: hotel.id },
      orderBy: { createdAt: "desc" },
      select: {
        fullName: true,
        email: true,
        username: true,
        role: true,
        isActive: true
      }
    });
  } catch (err) {
    const fallback =
      "<h2>Users &amp; permissions</h2><p class=\"badge alert\">Users page is temporarily unavailable because the user table schema is out of date.</p><p>Please run the latest Prisma migrations, then reload this page.</p>";
    if (isHotelUserSchemaMismatchError(err)) {
      res.type("html").send(renderLayout(fallback, true));
      return;
    }
    console.error("Admin users page failed:", err instanceof Error ? err.message : String(err));
    res
      .status(500)
      .type("html")
      .send(renderLayout("<h2>Users &amp; permissions</h2><p class=\"badge alert\">Could not load users right now. Please try again.</p>", true));
    return;
  }
  const store = readPermissionStore();
  const created = req.query.created ? '<p class="badge ok">User created with permissions.</p>' : "";

  const rows = users
    .map((user) => {
      const safeEmail = typeof user.email === "string" ? user.email : "";
      const safeUsername = typeof user.username === "string" ? user.username : "";
      const permKey = (safeEmail || safeUsername).toLowerCase();
      const roleKey = typeof user.role === "string" ? user.role : "MANAGER";
      const perms = normalizePermissionMatrix(store[permKey] ?? defaultPermissionsForRole(roleKey));
      const modulesSummary = permissionModules
        .filter((m) => perms[m].MANAGE || perms[m].VIEW || perms[m].EDIT || perms[m].CREATE || perms[m].DELETE)
        .map((m) => permissionModuleLabels[m])
        .join(", ");
      return `<tr>
      <td>${escapeHtml(typeof user.fullName === "string" ? user.fullName : "—")}</td>
      <td>${escapeHtml((typeof user.email === "string" && user.email) || (typeof user.username === "string" && user.username) || "—")}</td>
      <td>${escapeHtml(roleKey)}</td>
      <td>${user.isActive ? '<span class="badge ok">Active</span>' : '<span class="badge alert">Disabled</span>'}</td>
      <td>${escapeHtml(modulesSummary || "No permissions set")}</td>
      </tr>`;
    })
    .join("");

  const modulePermissionBlocks = permissionModules
    .map(
      (moduleName) => `<fieldset style="border:1px solid #d8dee6; border-radius:10px; padding:10px">
  <legend style="padding:0 6px">${escapeHtml(permissionModuleLabels[moduleName])}</legend>
  <label><input type="checkbox" name="${moduleName}_VIEW" /> View</label>
  <label style="margin-left:10px"><input type="checkbox" name="${moduleName}_EDIT" /> Edit</label>
  <label style="margin-left:10px"><input type="checkbox" name="${moduleName}_CREATE" /> Create</label>
  <label style="margin-left:10px"><input type="checkbox" name="${moduleName}_DELETE" /> Delete</label>
  <label style="margin-left:10px"><input type="checkbox" name="${moduleName}_MANAGE" /> Manage</label>
</fieldset>`
    )
    .join("");

  const content = `
<h2>Users &amp; permissions</h2>
<p class="muted">Create hotel staff accounts. Use <strong>database role</strong> (MANAGER / STAFF / FRONTDESK / FINANCE / HOUSEKEEPING) for defaults, then tune <strong>module permissions</strong> for operational roles — e.g. <em>Restaurant &amp; café</em> for KOT/outlet, <em>Housekeeping</em> for cleaning tasks. Platform owner retains full access.</p>
${created}
<div class="actions">
  <a class="btn-link primary" href="/admin/profile">Back to profile</a>
</div>
<section style="margin-top:12px">
  <h3>Create user</h3>
  <p id="admin-create-user-error" class="badge alert" style="display:none; margin-bottom:8px" role="alert"></p>
  <form id="admin-create-user-form" method="post" action="/admin/users" style="display:grid; gap:10px">
    <div class="grid-2">
      <label>Full name<br /><input type="text" name="fullName" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Email (optional for housekeeping)<br /><input type="email" name="email" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Username (for /hk login)<br /><input type="text" name="username" maxlength="64" placeholder="e.g. hk-01" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Password<br /><input type="password" name="password" minlength="8" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>PIN (optional, /hk login)<br /><input type="password" name="pin" minlength="4" maxlength="12" placeholder="4-12 digits" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Role
        <select name="role" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">
          <option value="MANAGER">MANAGER</option>
          <option value="STAFF">STAFF</option>
          <option value="FRONTDESK">FRONTDESK</option>
          <option value="FINANCE">FINANCE</option>
          <option value="HOUSEKEEPING">HOUSEKEEPING</option>
        </select>
      </label>
    </div>
    <h4 style="margin:6px 0 0">Permissions</h4>
    <div style="display:grid; gap:8px">${modulePermissionBlocks}</div>
    <button type="submit" style="padding:10px 14px; border:0; border-radius:10px; background:#0b6e6e; color:#fff; font-weight:700; width:max-content">Create user</button>
  </form>
  <script>
  (function () {
    var form = document.getElementById("admin-create-user-form");
    var errEl = document.getElementById("admin-create-user-error");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }
      var fd = new FormData(form);
      var params = new URLSearchParams();
      fd.forEach(function (v, k) { params.append(k, v); });
      fetch("/admin/users", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        credentials: "same-origin"
      })
        .then(function (r) { return r.json().then(function (data) { return { r: r, data: data }; }); })
        .then(function (o) {
          if (o.r.ok && o.data && o.data.success === true) {
            window.location.href = "/admin/users?created=1";
            return;
          }
          var msg = (o.data && o.data.error) ? String(o.data.error) : "Could not create user.";
          if (errEl) { errEl.textContent = msg; errEl.style.display = "block"; }
          else { alert(msg); }
        })
        .catch(function () {
          var msg = "Network error. Please try again.";
          if (errEl) { errEl.textContent = msg; errEl.style.display = "block"; }
          else { alert(msg); }
        });
    });
  })();
  </script>
</section>
<section style="margin-top:14px">
  <h3>Existing users</h3>
  <table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Permission modules</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No users yet.</td></tr>'}</tbody>
  </table>
</section>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/users", requirePermission("USERS", "CREATE"), async (req, res) => {
  const jsonErr = (status: number, message: string) => {
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  try {
    const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
    if (!hotel) {
      jsonErr(404, "Hotel not found.");
      return;
    }

    const fullName = String(req.body.fullName ?? "").trim();
    const emailRaw = String(req.body.email ?? "").trim().toLowerCase();
    const email = emailRaw || null;
    const username = String(req.body.username ?? "").trim().toLowerCase() || null;
    const password = String(req.body.password ?? "");
    const pin = String(req.body.pin ?? "").trim();
    const role = String(req.body.role ?? "MANAGER");

    if (!fullName) {
      jsonErr(400, "Full name is required.");
      return;
    }
    if (password.length < 8) {
      jsonErr(400, "Password must be at least 8 characters.");
      return;
    }
    if (!email && !username) {
      jsonErr(400, "Provide at least an email or a username.");
      return;
    }

    const roleMap: Record<string, UserRole> = {
      MANAGER: UserRole.MANAGER,
      STAFF: UserRole.STAFF,
      FRONTDESK: UserRole.FRONTDESK,
      FINANCE: UserRole.FINANCE,
      HOUSEKEEPING: UserRole.HOUSEKEEPING
    };

    const permissions = parsePermissionsFromBody(req.body as Record<string, unknown>);
    const roleSafe = roleMap[role] ?? UserRole.MANAGER;
    const pinHash = pin.length >= 4 ? hashPassword(pin) : null;
    const passwordHash = hashPassword(password);

    const createPayload = {
      hotelId: hotel.id,
      fullName,
      email,
      username,
      passwordHash,
      pinHash,
      role: roleSafe,
      isActive: true,
      passwordResetTokenHash: null as string | null,
      passwordResetExpiresAt: null as Date | null,
      passwordResetRequestedAt: null as Date | null
    };

    if (email) {
      await prisma.hotelUser.upsert({
        where: { hotelId_email: { hotelId: hotel.id, email } },
        create: createPayload,
        update: {
          fullName,
          username,
          passwordHash,
          pinHash,
          role: roleSafe,
          isActive: true
        }
      });
    } else {
      await prisma.hotelUser.upsert({
        where: { hotelId_username: { hotelId: hotel.id, username: username! } },
        create: createPayload,
        update: {
          fullName,
          passwordHash,
          pinHash,
          role: roleSafe,
          isActive: true
        }
      });
    }

    try {
      const store = readPermissionStore();
      const permKey = email ? email.toLowerCase() : String(username).toLowerCase();
      store[permKey] = permissions;
      writePermissionStore(store);
    } catch (permErr) {
      console.error(
        "[admin] POST /users permission file write failed:",
        permErr instanceof Error ? permErr.message : String(permErr)
      );
      jsonErr(
        500,
        "User was created but permission settings could not be saved (server file write failed)."
      );
      return;
    }

    if (!res.headersSent) res.status(200).json({ success: true });
  } catch (err) {
    if (res.headersSent) {
      console.error("[admin] POST /users: response already sent", err);
      return;
    }
    if (isHotelUserSchemaMismatchError(err)) {
      console.error(
        "[admin] POST /users schema drift:",
        err instanceof Error ? err.message : String(err)
      );
      jsonErr(
        503,
        "Database schema is out of date. Run prisma migrate deploy on the server and restart the app."
      );
      return;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      console.warn("[admin] POST /users duplicate key:", err.meta);
      jsonErr(409, "A user with this email or username already exists for this hotel.");
      return;
    }
    console.error("[admin] POST /users failed:", err instanceof Error ? err.message : String(err));
    jsonErr(500, "Could not create the user. Please try again.");
  }
});

adminRouter.get("/dashboard", requireAuth, (_req, res) => {
  res.redirect("/admin/profile");
});

adminRouter.get("/analytics/decision", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: platformHotelSlug },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Decision analytics</h2><p>No hotel data found.</p>", true));
    return;
  }
  const qDays = parseInt(String(req.query.days ?? "30"), 10);
  const days = Number.isFinite(qDays) ? Math.max(7, Math.min(120, qDays)) : 30;
  const activePropertyId = await resolveActivePropertyIdForHotel(req, hotel.id);
  const isAllPropertiesMode = activePropertyId === allPropertiesKey;
  if (isAllPropertiesMode) {
    const cross = await loadDecisionAnalyticsCrossPropertySummary({ hotelId: hotel.id, days });
    const breakdownRows = cross.perProperty
      .map(
        (p) => `<tr>
<td><a class="inline-link" href="/admin/analytics/decision?days=${days}&propertyId=${encodeURIComponent(p.propertyId)}">${escapeHtml(p.propertyName)}</a><div class="muted" style="font-size:11px">${escapeHtml(p.propertyCity ?? "—")}</div></td>
<td>${p.bookingsTotal}</td>
<td>${formatMoney(p.revenue, hotel.currency)}</td>
<td>${formatMoney(p.commission, hotel.currency)}</td>
<td>${formatMoney(p.avgBookingValue, hotel.currency)}</td>
<td>${p.summary.metrics.bookingConversionRatePct.toFixed(2)}%</td>
<td>${p.summary.metrics.upsellAcceptanceRatePct.toFixed(2)}%</td>
</tr>`
      )
      .join("");
    const content = `
<h2>Decision analytics</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — aggregated owner view across all properties.</p>
<div class="actions">
  <a class="btn-link" href="/admin/profile">Back to profile</a>
  <a class="btn-link" href="/admin/analytics/decision?days=30&propertyId=ALL">30 days</a>
  <a class="btn-link" href="/admin/analytics/decision?days=60&propertyId=ALL">60 days</a>
  <a class="btn-link" href="/admin/analytics/decision?days=90&propertyId=ALL">90 days</a>
</div>
<div class="grid-4">
  <article class="stat"><h3>Total bookings</h3><p>${cross.totals.bookingsTotal}</p></article>
  <article class="stat"><h3>Total revenue</h3><p>${formatMoney(cross.totals.revenue, hotel.currency)}</p></article>
  <article class="stat"><h3>Total commission</h3><p>${formatMoney(cross.totals.commission, hotel.currency)}</p></article>
  <article class="stat"><h3>Avg booking value</h3><p>${formatMoney(cross.totals.avgBookingValue, hotel.currency)}</p></article>
  <article class="stat"><h3>Conversion rate</h3><p>${cross.aggregate.metrics.bookingConversionRatePct.toFixed(2)}%</p></article>
  <article class="stat"><h3>Abandonment rate</h3><p>${cross.aggregate.metrics.abandonmentRatePct.toFixed(2)}%</p></article>
  <article class="stat"><h3>Upsell acceptance</h3><p>${cross.aggregate.metrics.upsellAcceptanceRatePct.toFixed(2)}%</p></article>
  <article class="stat"><h3>Follow-up conversion</h3><p>${cross.aggregate.metrics.followupConversionRatePct.toFixed(2)}%</p></article>
</div>
<section style="margin:16px 0; max-width:1100px">
  <h3>Property drill-down</h3>
  <table>
    <thead><tr><th>Property</th><th>Bookings</th><th>Revenue</th><th>Commission</th><th>Avg booking</th><th>Conversion</th><th>Upsell acceptance</th></tr></thead>
    <tbody>${breakdownRows || '<tr><td colspan="7">No property data.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:980px">
  <h3 style="margin-top:0">Aggregated decision summary (${days} days)</h3>
  <pre style="white-space:pre-wrap; font-size:12px; line-height:1.5; background:#f6f8fa; padding:12px; border-radius:10px; border:1px solid var(--border)">${escapeHtml(JSON.stringify(cross.aggregate, null, 2))}</pre>
</section>`;
    res.type("html").send(renderLayout(content, true));
    return;
  }
  const summary = await loadDecisionAnalyticsSummary({
    hotelId: hotel.id,
    propertyId: isScopedPropertyId(activePropertyId) ? activePropertyId : undefined,
    days
  });
  const bookingRevenueAgg = await prisma.booking.aggregate({
    where: {
      hotelId: hotel.id,
      ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}),
      createdAt: { gte: startOfDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000)) }
    },
    _sum: { totalAmount: true },
    _avg: { totalAmount: true }
  });
  const bookingCount = await prisma.booking.count({
    where: {
      hotelId: hotel.id,
      ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}),
      createdAt: { gte: startOfDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000)) }
    }
  });
  const estimatedCommission = (bookingRevenueAgg._sum?.totalAmount ?? 0) * 0;
  const pretty = escapeHtml(JSON.stringify(summary, null, 2));
  const content = `
<h2>Decision analytics</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — lightweight event tracking and derived insights for WhatsApp conversion, upsell, support, and follow-ups.</p>
<div class="actions">
  <a class="btn-link" href="/admin/profile">Back to profile</a>
  <a class="btn-link" href="/admin/analytics/decision?days=30${isScopedPropertyId(activePropertyId) ? `&propertyId=${encodeURIComponent(activePropertyId)}` : ""}">30 days</a>
  <a class="btn-link" href="/admin/analytics/decision?days=60${isScopedPropertyId(activePropertyId) ? `&propertyId=${encodeURIComponent(activePropertyId)}` : ""}">60 days</a>
  <a class="btn-link" href="/admin/analytics/decision?days=90${isScopedPropertyId(activePropertyId) ? `&propertyId=${encodeURIComponent(activePropertyId)}` : ""}">90 days</a>
</div>
<div class="grid-4">
  <article class="stat"><h3>Total bookings</h3><p>${bookingCount}</p></article>
  <article class="stat"><h3>Total revenue</h3><p>${formatMoney(bookingRevenueAgg._sum?.totalAmount ?? 0, hotel.currency)}</p></article>
  <article class="stat"><h3>Total commission</h3><p>${formatMoney(estimatedCommission, hotel.currency)}</p></article>
  <article class="stat"><h3>Avg booking value</h3><p>${formatMoney(bookingRevenueAgg._avg?.totalAmount ?? 0, hotel.currency)}</p></article>
  <article class="stat"><h3>Conversion rate</h3><p>${summary.metrics.bookingConversionRatePct.toFixed(2)}%</p></article>
  <article class="stat"><h3>Abandonment rate</h3><p>${summary.metrics.abandonmentRatePct.toFixed(2)}%</p></article>
  <article class="stat"><h3>Upsell acceptance</h3><p>${summary.metrics.upsellAcceptanceRatePct.toFixed(2)}%</p></article>
  <article class="stat"><h3>Repeat guest rate</h3><p>${summary.metrics.repeatGuestRatePct.toFixed(2)}%</p></article>
</div>
<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:980px">
  <h3 style="margin-top:0">Summary (${days} days)</h3>
  <pre style="white-space:pre-wrap; font-size:12px; line-height:1.5; background:#f6f8fa; padding:12px; border-radius:10px; border:1px solid var(--border)">${pretty}</pre>
</section>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/analytics/optimization", requireAuth, async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Optimization settings</h2><p>No hotel data found.</p>", true));
    return;
  }
  const cfg = loadPartnerSetupConfig(hotel.id);
  const recent = await prisma.auditLog.findMany({
    where: {
      hotelId: hotel.id,
      action: "AUTO_OPTIMIZATION_ADJUSTED"
    },
    orderBy: { createdAt: "desc" },
    take: 20
  });
  const rows = recent
    .map((r) => {
      const meta = r.metadataJson ? escapeHtml(r.metadataJson.slice(0, 800)) : "";
      return `<tr><td>${formatDateTime(r.createdAt)}</td><td><pre style="white-space:pre-wrap;font-size:11px;margin:0">${meta}</pre></td></tr>`;
    })
    .join("");
  const content = `
<h2>Auto optimization</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — safe, incremental optimization settings driven by analytics feedback.</p>
<div class="actions">
  <a class="btn-link" href="/admin/profile">Back to profile</a>
  <a class="btn-link" href="/admin/analytics/decision">Decision analytics</a>
</div>
<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:980px">
  <h3 style="margin-top:0">Current parameters</h3>
  <pre style="white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:12px;border-radius:10px;border:1px solid var(--border)">${escapeHtml(
    JSON.stringify(cfg.optimizationSettings, null, 2)
  )}</pre>
</section>
<section style="margin:16px 0; max-width:980px">
  <h3>Recent optimization changes</h3>
  <table>
    <thead><tr><th>Timestamp</th><th>Change details</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="2">No optimization changes yet.</td></tr>'}</tbody>
  </table>
</section>`;
  res.type("html").send(renderLayout(content, true));
});

function leadOutreachTemplate(template: "initial_intro" | "followup_1" | "followup_2", leadHotelName: string): string {
  if (template === "followup_1") {
    return `Hello, just following up from WhatsStay regarding ${leadHotelName}. Would you be open to a short demo on how AI WhatsApp booking and operations can help your hotel team?`;
  }
  if (template === "followup_2") {
    return `Quick follow-up from WhatsStay for ${leadHotelName}. If this is not a fit now, we are happy to reconnect later.`;
  }
  return `Hello from WhatsStay. We help hotels like ${leadHotelName} automate WhatsApp booking, guest operations, upsell, and follow-up in one platform. Would you like a quick walkthrough?`;
}

adminRouter.get("/leads", requireAuth, requirePlatformAcquisition, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true, displayName: true } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Leads</h2><p>No hotel data found.</p>", true));
    return;
  }
  const status = String(req.query.status ?? "all").toLowerCase();
  const where = {
    hotelId: hotel.id,
    ...(status !== "all" ? { status } : {})
  };
  const leads = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { outreachLogs: { orderBy: { createdAt: "desc" }, take: 1 }, convertedProperty: true }
  });
  const rows = leads
    .map((l) => {
      const latest = l.outreachLogs[0];
      const latestLine = latest ? `${latest.channel} · ${formatDateTime(latest.sentAt)} · ${latest.templateKey}` : "—";
      const badgeClass =
        l.status === "converted" ? "ok" : l.status === "not_interested" ? "pending" : l.status === "interested" ? "ok" : "badge";
      return `<tr>
<td>${escapeHtml(l.hotelName)}</td>
<td>${escapeHtml(l.contactName ?? "—")}</td>
<td>${escapeHtml(l.contactEmail ?? "—")}<br/><span class="muted">${escapeHtml(l.contactPhone ?? "—")}</span></td>
<td>${escapeHtml(l.location ?? "—")}</td>
<td><span class="badge ${badgeClass}">${escapeHtml(l.status)}</span></td>
<td>${escapeHtml(latestLine)}</td>
<td>
  <form method="post" action="/admin/leads/${encodeURIComponent(l.id)}/status" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center">
    <select name="status" style="padding:6px; border:1px solid #d8dee6; border-radius:8px">
      ${["new", "contacted", "responded", "interested", "converted", "not_interested"]
        .map((s) => `<option value="${s}" ${l.status === s ? "selected" : ""}>${s}</option>`)
        .join("")}
    </select>
    <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Update</button>
  </form>
  <form method="post" action="/admin/leads/${encodeURIComponent(l.id)}/outreach" style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center">
    <select name="channel" style="padding:6px; border:1px solid #d8dee6; border-radius:8px">
      <option value="email">email</option>
      <option value="whatsapp">whatsapp</option>
    </select>
    <select name="templateKey" style="padding:6px; border:1px solid #d8dee6; border-radius:8px">
      <option value="initial_intro">initial_intro</option>
      <option value="followup_1">followup_1</option>
      <option value="followup_2">followup_2</option>
    </select>
    <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:#25d366; color:#083d2d; font-weight:700">Send</button>
  </form>
  ${
    l.status === "interested" || l.status === "responded"
      ? `<p style="margin-top:6px"><a class="inline-link" href="/admin/onboard?leadId=${encodeURIComponent(l.id)}">Convert & onboard</a></p>`
      : l.status === "converted"
        ? `<p class="muted" style="margin-top:6px">Converted${l.convertedProperty ? ` → ${escapeHtml(l.convertedProperty.name)}` : ""}</p>`
        : ""
  }
</td>
</tr>`;
    })
    .join("");

  const content = `
<h2>Lead pipeline</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — lightweight outreach and acquisition tracking.</p>
<div class="actions">
  <a class="btn-link" href="/admin/profile">Back to profile</a>
  <a class="btn-link" href="/admin/leads">All</a>
  <a class="btn-link" href="/admin/leads?status=interested">Interested</a>
  <a class="btn-link" href="/admin/leads?status=converted">Converted</a>
</div>
<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:920px">
  <h3 style="margin-top:0">Add lead</h3>
  <form method="post" action="/admin/leads" style="display:grid; gap:10px; max-width:760px">
    <label>Hotel name<input name="hotelName" required style="width:100%; margin-top:4px; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    <label>Contact name (optional)<input name="contactName" style="width:100%; margin-top:4px; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    <label>Email<input type="email" name="contactEmail" style="width:100%; margin-top:4px; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    <label>Phone<input name="contactPhone" style="width:100%; margin-top:4px; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    <label>Location<input name="location" style="width:100%; margin-top:4px; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    <label>Source
      <select name="source" style="width:100%; margin-top:4px; padding:8px; border:1px solid #d8dee6; border-radius:8px">
        <option value="manual">manual</option>
        <option value="import">import</option>
        <option value="campaign">campaign</option>
      </select>
    </label>
    <button type="submit" style="padding:8px 14px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700; width:fit-content">Add lead</button>
  </form>
</section>
<section>
  <h3>Leads</h3>
  <table>
    <thead><tr><th>Hotel</th><th>Contact</th><th>Email / Phone</th><th>Location</th><th>Status</th><th>Last outreach</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">No leads yet.</td></tr>'}</tbody>
  </table>
</section>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/leads", requireAuth, requirePlatformAcquisition, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/leads");
    return;
  }
  const hotelName = String(req.body.hotelName ?? "").trim();
  const contactName = String(req.body.contactName ?? "").trim() || null;
  const contactEmail = String(req.body.contactEmail ?? "").trim().toLowerCase() || null;
  const contactPhone = String(req.body.contactPhone ?? "").trim() || null;
  const location = String(req.body.location ?? "").trim() || null;
  const source = String(req.body.source ?? "manual").trim() || "manual";
  if (!hotelName) {
    res.redirect("/admin/leads");
    return;
  }
  await prisma.lead.create({
    data: {
      hotelId: hotel.id,
      hotelName,
      contactName,
      contactEmail,
      contactPhone,
      location,
      source,
      status: "new"
    }
  });
  res.redirect("/admin/leads");
});

adminRouter.post("/leads/:leadId/status", requireAuth, requirePlatformAcquisition, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/leads");
    return;
  }
  const leadId = String(req.params.leadId ?? "");
  const status = String(req.body.status ?? "").trim();
  const allowed = new Set(["new", "contacted", "responded", "interested", "converted", "not_interested"]);
  if (!allowed.has(status)) {
    res.redirect("/admin/leads");
    return;
  }
  const lead = await prisma.lead.findFirst({ where: { id: leadId, hotelId: hotel.id }, select: { id: true } });
  if (!lead) {
    res.redirect("/admin/leads");
    return;
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { status } });
  if (status === "responded" || status === "interested" || status === "not_interested") {
    await prisma.leadOutreachLog.updateMany({
      where: { hotelId: hotel.id, leadId: lead.id, responseStatus: "pending" },
      data: { responseStatus: status === "not_interested" ? "not_interested" : "responded" }
    });
  }
  if (status === "responded" || status === "interested") {
    await trackDecisionEventSafe({
      hotelId: hotel.id,
      eventType: "lead_responded",
      source: "lead_status_update",
      dedupeKey: `lead_responded:${lead.id}:${Date.now()}`,
      metadata: { leadId: lead.id }
    });
  }
  res.redirect("/admin/leads");
});

adminRouter.post("/leads/:leadId/outreach", requireAuth, requirePlatformAcquisition, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true, displayName: true } });
  if (!hotel) {
    res.redirect("/admin/leads");
    return;
  }
  const leadId = String(req.params.leadId ?? "");
  const channel = String(req.body.channel ?? "email").trim().toLowerCase();
  const templateKey = String(req.body.templateKey ?? "initial_intro").trim() as "initial_intro" | "followup_1" | "followup_2";
  const lead = await prisma.lead.findFirst({ where: { id: leadId, hotelId: hotel.id } });
  if (!lead) {
    res.redirect("/admin/leads");
    return;
  }
  const recentCount = await prisma.leadOutreachLog.count({
    where: { hotelId: hotel.id, leadId: lead.id }
  });
  if (recentCount >= 3) {
    res.redirect("/admin/leads");
    return;
  }
  if (templateKey !== "initial_intro") {
    const lastOutreach = await prisma.leadOutreachLog.findFirst({
      where: { hotelId: hotel.id, leadId: lead.id, status: "SENT" },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true }
    });
    if (lastOutreach && Date.now() - lastOutreach.sentAt.getTime() < 48 * 60 * 60 * 1000) {
      res.redirect("/admin/leads");
      return;
    }
  }
  const body = leadOutreachTemplate(templateKey, lead.hotelName);
  let sent = false;
  let sendStatus = "FAILED";
  if (channel === "email" && lead.contactEmail) {
    try {
      await sendEmail({
        to: lead.contactEmail,
        subject: `WhatsStay for ${lead.hotelName}`,
        html: `<p>${escapeHtml(body).replace(/\n/g, "<br/>")}</p>`,
        text: body
      });
      sent = true;
      sendStatus = "SENT";
    } catch {
      sent = false;
    }
  } else if (channel === "whatsapp" && lead.contactPhone) {
    const cfg = loadPartnerSetupConfig(hotel.id);
    const r = await trySendWhatsAppText({
      to: lead.contactPhone,
      body,
      phoneNumberId: cfg.whatsappPhoneNumberId || undefined
    });
    sent = r.ok;
    sendStatus = r.ok ? "SENT" : "FAILED";
  }
  await prisma.$transaction(async (tx) => {
    await tx.leadOutreachLog.create({
      data: {
        hotelId: hotel.id,
        leadId: lead.id,
        channel,
        templateKey,
        messageBody: body,
        status: sendStatus,
        responseStatus: "pending"
      }
    });
    await tx.lead.update({
      where: { id: lead.id },
      data: {
        status: sent ? "contacted" : lead.status,
        lastContactedAt: sent ? new Date() : lead.lastContactedAt
      }
    });
  });
  if (sent) {
    await trackDecisionEventSafe({
      hotelId: hotel.id,
      eventType: "lead_contacted",
      source: `lead_outreach_${channel}`,
      dedupeKey: `lead_contacted:${lead.id}:${templateKey}:${Date.now()}`,
      metadata: { leadId: lead.id, channel, templateKey }
    });
  }
  res.redirect("/admin/leads");
});

adminRouter.get("/profile", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: defaultHotelSlug },
    include: {
      subscriptions: {
        where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        orderBy: { createdAt: "desc" },
        include: { plan: true },
        take: 1
      },
      properties: true,
      roomTypes: true,
      integrations: { orderBy: { provider: "asc" } },
      invoices: { orderBy: { createdAt: "desc" }, take: 10 }
    }
  });

  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Hotel Profile</h2><p>No hotel data found.</p>", true));
    return;
  }

  const config = loadPartnerSetupConfig(hotel.id);
  const whatsappConfigured = Boolean(config.whatsappPhoneNumberId?.trim());
  const whatsappStatus = whatsappConfigured ? "Connected" : "Not connected";
  const whatsappStatusClass = whatsappConfigured ? "ok" : "pending";
  const whatsappDisplay = hotel.whatsappPhone || config.whatsappPhoneNumberId || "—";

  const sub = hotel.subscriptions[0];
  const subscriptionStart = sub?.currentPeriodStart ?? sub?.startedAt ?? sub?.createdAt;

  const invoiceRows = hotel.invoices
    .map(
      (inv) => `<tr>
        <td><a class="inline-link" href="/admin/billing">${escapeHtml(inv.id.slice(0, 12))}</a></td>
        <td>${formatDate(inv.createdAt)}</td>
        <td>${inv.amountTotal} ${escapeHtml(inv.currency)}</td>
        <td><span class="badge ${inv.status === "PAID" ? "ok" : "pending"}">${escapeHtml(inv.status)}</span></td>
      </tr>`
    )
    .join("");

  const integrationRows = hotel.integrations
    .map(
      (int) => `<tr>
        <td>${escapeHtml(String(int.provider))}</td>
        <td><span class="badge ${int.status === "connected" ? "ok" : "pending"}">${escapeHtml(int.status)}</span></td>
        <td>${int.lastSyncedAt ? formatDateTime(int.lastSyncedAt) : "—"}</td>
      </tr>`
    )
    .join("");

  const now = startOfDay(new Date());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const dayStart = now;
  const dayEndExclusive = addDays(dayStart, 1);
  const profileUnitUpdated = req.query.unitUpdated ? '<p class="badge ok">Room status updated.</p>' : "";
  const profilePropertyOnboarded =
    req.query.propertyOnboarded === "1" ? '<p class="badge ok">New client property was onboarded successfully.</p>' : "";
  const sessionProfile = getSession(req);
  const platformAcquisitionActions =
    sessionProfile && isPlatformAcquisitionSession(sessionProfile)
      ? `<a class="btn-link" href="/admin/onboard">Onboard new property</a>
  <a class="btn-link" href="/admin/leads">Lead pipeline</a>`
      : "";
  const profileDayRange = inventoryDayRangeExclusive(dayStart);
  const feedbackRecentSince = addDays(now, -30);
  const [bookingsCount, bookingsThisMonth, confirmedCount, conversationsThisMonth, todayInventoryRows, todayBookings, feedbackAgg, feedbackRecent, lowFeedbackCount, unresolvedFeedbackCount, recentLowFeedbackCount, latestLowFeedback] = await Promise.all([
    prisma.booking.count({ where: { hotelId: hotel.id } }),
    prisma.booking.count({
      where: { hotelId: hotel.id, createdAt: { gte: monthStart } }
    }),
    prisma.booking.count({
      where: { hotelId: hotel.id, status: "CONFIRMED" }
    }),
    prisma.conversation.count({
      where: { hotelId: hotel.id, createdAt: { gte: monthStart } }
    }),
    prisma.inventory.findMany({
      where: { hotelId: hotel.id, date: { gte: profileDayRange.gte, lt: profileDayRange.lt } },
      select: { roomTypeId: true, total: true, reserved: true, closedOut: true }
    }),
    prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        checkIn: { lt: dayEndExclusive },
        checkOut: { gt: dayStart },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      include: { guest: true, roomUnit: true },
      orderBy: { checkIn: "asc" }
    }),
    prisma.guestFeedback.aggregate({
      where: { hotelId: hotel.id },
      _avg: { rating: true },
      _count: { _all: true }
    }),
    prisma.guestFeedback.findMany({
      where: { hotelId: hotel.id },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        rating: true,
        category: true,
        comment: true,
        createdAt: true,
        guestName: true,
        managerFollowUpRequestedAt: true,
        managerFollowUpClosedAt: true
      }
    }),
    prisma.guestFeedback.count({
      where: { hotelId: hotel.id, rating: { lte: 2 } }
    }),
    prisma.guestFeedback.count({
      where: {
        hotelId: hotel.id,
        managerFollowUpRequestedAt: { not: null },
        managerFollowUpClosedAt: null
      }
    }),
    prisma.guestFeedback.count({
      where: { hotelId: hotel.id, rating: { lte: 2 }, createdAt: { gte: feedbackRecentSince } }
    }),
    prisma.guestFeedback.findFirst({
      where: { hotelId: hotel.id, rating: { lte: 2 } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true }
    })
  ]);
  const feedbackSignals = deriveFeedbackSignals({
    averageRating: feedbackAgg._avg.rating ?? null,
    responseCount: feedbackAgg._count._all,
    lowRatingCount: lowFeedbackCount,
    recentLowRatingCount: recentLowFeedbackCount,
    latestLowRatingAt: latestLowFeedback?.createdAt ?? null
  });
  const feedbackAvg = feedbackSignals.averageRating === null ? null : Number(feedbackSignals.averageRating.toFixed(2));
  const feedbackCount = feedbackSignals.responseCount;
  const feedbackStatusBadge =
    feedbackSignals.feedbackStatus === "action_needed"
      ? '<span class="badge alert">Action needed</span>'
      : feedbackSignals.feedbackStatus === "watch"
        ? '<span class="badge pending">Watch</span>'
        : feedbackSignals.feedbackStatus === "normal"
          ? '<span class="badge ok">Normal</span>'
          : '<span class="badge">No feedback yet</span>';
  const feedbackRows = feedbackRecent
    .map(
      (r) => `<tr>
      <td>${"⭐".repeat(Math.max(1, Math.min(5, r.rating)))}</td>
      <td>${escapeHtml(r.category ? String(r.category).replaceAll("_", " ") : "—")}</td>
      <td>${escapeHtml((r.comment ?? "—").slice(0, 220))}</td>
      <td>${escapeHtml(r.guestName ?? "Guest")}</td>
      <td>${
        r.managerFollowUpRequestedAt && !r.managerFollowUpClosedAt
          ? '<span class="badge alert">Needs follow-up</span>'
          : '<span class="badge ok">Closed</span>'
      }</td>
      <td>${formatDateTime(r.createdAt)}</td>
    </tr>`
    )
    .join("");

  await ensureDefaultRoomUnitsForBoard(
    hotel.id,
    hotel.roomTypes
      .filter((rt) => rt.isActive)
      .map((rt) => ({ id: rt.id, code: rt.code, name: rt.name }))
  );
  await backfillMissingRoomUnitAssignmentsForDate({
    hotelId: hotel.id,
    dateStart: dayStart,
    dateEndExclusive: dayEndExclusive
  });
  const roomTypesWithUnits = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { name: "asc" },
    include: {
      roomUnits: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }
    }
  });

  const inventoryByRoomTypeProfile = new Map(todayInventoryRows.map((row) => [row.roomTypeId, row]));
  const roomStatusCards: Array<{
    roomTypeId: string;
    roomTypeName: string;
    unitId: string | null;
    unitName: string;
    status: RoomBoardStatus;
    guestName: string | null;
    checkIn: Date | null;
    checkOut: Date | null;
    bookingId: string | null;
  }> = [];

  for (const rt of roomTypesWithUnits) {
    const inv = inventoryByRoomTypeProfile.get(rt.id);
    const closedOut = inv?.closedOut ?? false;
    const bookableTotal = inv?.total ?? rt.totalInventory;
    const reservedCount = inv?.reserved ?? 0;
    const aggregateAvailable = closedOut ? 0 : Math.max(0, bookableTotal - reservedCount);
    const units = rt.roomUnits;
    const activeUnits = units.filter((u) => u.isActive);
    const overlapForType = todayBookings.filter((b) => b.roomTypeId === rt.id);
    const bookingSlotCount = overlapForType.length;
    const unbookedActiveUnits = activeUnits.filter((u) => !overlapForType.some((b) => b.roomUnitId === u.id));
    const effectiveReserved = Math.min(reservedCount, bookableTotal);
    const needInvReserved = Math.max(0, effectiveReserved - bookingSlotCount);
    const reservedFromInventoryUnitIds = new Set<string>();
    {
      let remaining = needInvReserved;
      for (const u of unbookedActiveUnits) {
        if (remaining <= 0) break;
        if (parseManualRoomStatusFromNotes(u.notes)) continue;
        reservedFromInventoryUnitIds.add(u.id);
        remaining -= 1;
      }
    }

    for (const unit of units) {
      const bookingsForUnit = todayBookings.filter((b) => b.roomUnitId === unit.id);
      const firstBooking = bookingsForUnit[0] ?? null;
      const hasConfirmed = bookingsForUnit.some((b) => b.status === "CONFIRMED");
      const hasPending = bookingsForUnit.some((b) => b.status === "PENDING");
      const manualStatus = parseManualRoomStatusFromNotes(unit.notes);
      const activeIndex = activeUnits.findIndex((u) => u.id === unit.id);
      const beyondInventoryCap = unit.isActive && activeIndex >= 0 && activeIndex >= bookableTotal;

      let status: RoomBoardStatus;
      const fromBooking = roomBoardStatusFromBookingOverlap({ hasConfirmed, hasPending, manualStatus });
      if (fromBooking !== null) {
        status = fromBooking;
      } else if (closedOut) {
        status = "MAINTENANCE";
      } else if (manualStatus) {
        status = manualStatus;
      } else if (!unit.isActive) {
        status = "MAINTENANCE";
      } else if (beyondInventoryCap) {
        status = "MAINTENANCE";
      } else if (reservedFromInventoryUnitIds.has(unit.id)) {
        status = "RESERVED";
      } else if (aggregateAvailable <= 0) {
        status = "RESERVED";
      } else {
        status = "AVAILABLE";
      }

      roomStatusCards.push({
        roomTypeId: rt.id,
        roomTypeName: rt.name,
        unitId: unit.id,
        unitName: unit.name,
        status,
        guestName: firstBooking?.guest.fullName ?? firstBooking?.guest.phoneE164 ?? null,
        checkIn: firstBooking?.checkIn ?? null,
        checkOut: firstBooking?.checkOut ?? null,
        bookingId: firstBooking?.id ?? null
      });
    }

    for (const b of overlapForType.filter((x) => !x.roomUnitId)) {
      const hasConfirmed = b.status === "CONFIRMED";
      const hasPending = b.status === "PENDING";
      let status: RoomBoardStatus;
      const fromBooking = roomBoardStatusFromBookingOverlap({ hasConfirmed, hasPending, manualStatus: null });
      if (fromBooking !== null) {
        status = fromBooking;
      } else {
        status = "RESERVED";
      }
      roomStatusCards.push({
        roomTypeId: rt.id,
        roomTypeName: rt.name,
        unitId: null,
        unitName: "Unassigned",
        status,
        guestName: b.guest?.fullName ?? b.guest?.phoneE164 ?? null,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        bookingId: b.id
      });
    }
  }
  roomStatusCards.sort((a, b) => {
    const rankDiff = getPreferredUnitSortRank(a.unitName) - getPreferredUnitSortRank(b.unitName);
    if (rankDiff !== 0) return rankDiff;
    return a.unitName.localeCompare(b.unitName);
  });
  const roomStatusHtml = roomStatusCards
    .map((card) => {
      const colorClass =
        card.status === "AVAILABLE"
          ? "room-board-green"
          : card.status === "RESERVED"
            ? "room-board-blue"
            : card.status === "OCCUPIED"
              ? "room-board-red"
              : card.status === "CLEANING"
                ? "room-board-yellow"
                : "room-board-purple";
      const detailHref = card.unitId
        ? `/admin/room-board/unit/${encodeURIComponent(card.unitId)}/details?date=${formatDateForInput(dayStart)}`
        : `/admin/bookings/${encodeURIComponent(card.bookingId ?? "")}`;
      const statusForm = card.unitId
        ? roomBoardStatusFormHtml({
            unitId: card.unitId,
            boardDate: dayStart,
            status: card.status,
            returnTo: "/admin/profile",
            variant: "profile"
          })
        : "";
      const unitDataAttr = card.unitId ? ` data-room-unit-id="${escapeHtml(card.unitId)}"` : "";
      return `<div class="room-board-card ${colorClass}"${unitDataAttr} style="display:flex;flex-direction:column;min-width:0;max-width:100%;overflow-x:clip;align-items:stretch">
        <strong>${escapeHtml(card.unitName)}</strong>${card.unitId ? "" : ' <span class="badge pending" style="font-size:10px">no unit</span>'}
        <div class="muted" style="font-size:12px; margin-top:3px">${escapeHtml(card.roomTypeName)}</div>
        <div class="muted" style="font-size:12px; margin-top:3px">${escapeHtml(card.status)}</div>
        ${card.guestName ? `<div style="margin-top:6px; font-size:12px">Guest: ${escapeHtml(card.guestName)}</div>` : ""}
        ${card.checkIn && card.checkOut ? `<div class="muted" style="font-size:11px">${formatDateForInput(card.checkIn)} - ${formatDateForInput(card.checkOut)}</div>` : ""}
        <div class="room-board-card-meta-links" style="margin-top:8px">
          <a class="inline-link" href="${detailHref}">${card.unitId ? "details" : "booking"}</a>
        </div>
        ${statusForm}
      </div>`;
    })
    .join("");

  const content = `
<h2>Property overview</h2>
<p class="muted">Operational snapshot for ${escapeHtml(hotel.displayName)}.</p>
${profilePropertyOnboarded}
<div class="actions">
  <a class="btn-link primary" href="/admin/setup">Edit profile &amp; WhatsApp</a>
  ${platformAcquisitionActions}
  <a class="btn-link" href="/admin/room-board">Rooms</a>
  <a class="btn-link" href="/admin/rooms">Room rates &amp; configuration</a>
</div>

<div class="grid-2">
  <section>
    <h3>Hotel information</h3>
    <table>
      <tbody>
        <tr><th>Name</th><td>${escapeHtml(hotel.displayName)}</td></tr>
        <tr><th>Legal name</th><td>${escapeHtml(hotel.legalName)}</td></tr>
        <tr><th>City</th><td>${escapeHtml(hotel.city ?? "—")}</td></tr>
        <tr><th>Country</th><td>${escapeHtml(hotel.country)}</td></tr>
        <tr><th>Currency</th><td>${escapeHtml(hotel.currency)}</td></tr>
        <tr><th>Timezone</th><td>${escapeHtml(hotel.timezone)}</td></tr>
        <tr><th>Status</th><td><span class="badge ${hotel.isActive ? "ok" : "pending"}">${hotel.isActive ? "Active" : "Inactive"}</span></td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Subscription plan</h3>
    <table>
      <tbody>
        <tr><th>Plan</th><td>${escapeHtml(sub?.plan.name ?? "No active plan")}</td></tr>
        <tr><th>Status</th><td><span class="badge ${sub?.status === "ACTIVE" ? "ok" : "pending"}">${escapeHtml(sub?.status ?? "—")}</span></td></tr>
        <tr><th>Price</th><td>${sub ? `${sub.plan.monthlyPrice} ${escapeHtml(hotel.currency)} / month` : "—"}</td></tr>
        <tr><th>Subscription start</th><td>${subscriptionStart ? formatDate(subscriptionStart) : "—"}</td></tr>
        <tr><th>Period end</th><td>${formatDate(sub?.currentPeriodEnd)}</td></tr>
      </tbody>
    </table>
    <p><a class="btn-link" href="/admin/subscription">View plan &amp; limits</a></p>
  </section>
</div>

<div class="grid-2">
  <section>
    <h3>WhatsApp number status</h3>
    <table>
      <tbody>
        <tr><th>Status</th><td><span class="badge ${whatsappStatusClass}">${escapeHtml(whatsappStatus)}</span></td></tr>
        <tr><th>Phone / Number ID</th><td>${escapeHtml(whatsappDisplay)}</td></tr>
      </tbody>
    </table>
    <p><a class="btn-link" href="/admin/setup">Configure WhatsApp</a></p>
  </section>
  <section>
    <h3>Booking integration status</h3>
    <table>
      <thead><tr><th>Provider</th><th>Status</th><th>Last sync</th></tr></thead>
      <tbody>${integrationRows || '<tr><td colspan="3">No integrations connected.</td></tr>'}</tbody>
    </table>
    <p><a class="btn-link" href="/admin/integrations">Manage integrations</a></p>
  </section>
</div>

<section style="margin-top: 14px">
  <h3>Payment history</h3>
  <table>
    <thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
    <tbody>${invoiceRows || '<tr><td colspan="4">No invoices yet.</td></tr>'}</tbody>
  </table>
  <p><a class="btn-link" href="/admin/billing">View all billing</a></p>
</section>

<section style="margin-top: 14px">
  <h3>Room status board</h3>
  <p class="muted">Live visual room status for today. Green=available, Blue=reserved, Red=occupied, Yellow=cleaning, Purple=maintenance.</p>
  ${profileUnitUpdated}
  <div class="room-board-grid">
    ${roomStatusHtml || '<p class="muted">No room types found.</p>'}
  </div>
  <p style="margin-top:8px"><a class="btn-link" href="/admin/room-board">Open full room board</a></p>
  <style>
    .room-board-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; align-items:stretch; }
    .room-board-card { text-decoration:none; border-radius:10px; padding:10px; border:1px solid transparent; color:inherit; background:#fff; contain:layout; min-height:0; }
    .room-board-card-actions { margin-top:auto; padding-top:10px; border-top:1px solid rgba(15,23,42,.12); width:100%; max-width:100%; box-sizing:border-box; flex-shrink:0; }
    .room-board-card:hover { opacity:0.92; }
    .room-board-green { border-color:#22c55e; background:#dcfce7; color:#166534; }
    .room-board-blue { border-color:#3b82f6; background:#dbeafe; color:#1e40af; }
    .room-board-red { border-color:#ef4444; background:#fee2e2; color:#991b1b; }
    .room-board-yellow { border-color:#eab308; background:#fef9c3; color:#854d0e; }
    .room-board-purple { border-color:#a855f7; background:#f3e8ff; color:#6b21a8; }
  </style>
</section>

<section style="margin-top: 14px">
  <h3>Guest feedback</h3>
  <div class="grid-4">
    <article class="stat"><h3>Average rating</h3><p>${feedbackCount && feedbackAvg !== null ? `${feedbackAvg.toFixed(1)} ⭐` : "—"}</p></article>
    <article class="stat"><h3>Total reviews</h3><p>${feedbackCount}</p></article>
    <article class="stat"><h3>Low ratings (≤2)</h3><p>${feedbackSignals.lowRatingCount} <span class="muted">(${feedbackSignals.lowRatingRate.toFixed(1)}%)</span></p></article>
    <article class="stat"><h3>Unresolved issues</h3><p>${unresolvedFeedbackCount}</p></article>
  </div>
  <p class="muted" style="margin-top:8px">
    Feedback alert: ${feedbackStatusBadge}
    ${feedbackSignals.recentNegativeFeedbackFlag ? ' · <span class="badge pending">Recent negative feedback</span>' : ""}
    ${feedbackSignals.repeatedIssueAlert ? ' · <span class="badge alert">Repeated issue alert</span>' : ""}
    · Latest low rating: ${feedbackSignals.latestLowRatingAt ? formatDateTime(feedbackSignals.latestLowRatingAt) : "—"}
  </p>
  <table>
    <thead><tr><th>Rating</th><th>Category</th><th>Comment</th><th>Guest</th><th>Recovery</th><th>Date</th></tr></thead>
    <tbody>${feedbackRows || '<tr><td colspan="6">No feedback yet.</td></tr>'}</tbody>
  </table>
  <p class="muted" style="margin-top:8px">Public trust page: <a class="inline-link" href="/hotel/${encodeURIComponent(hotel.slug)}" target="_blank" rel="noopener noreferrer">Open public rating page</a></p>
</section>

<section style="margin-top: 14px">
  <h3>Operational activity summary</h3>
  <div class="grid-4">
    <article class="stat">
      <h3>Total bookings</h3>
      <p><a class="stat-link" href="/admin/bookings">${bookingsCount}</a></p>
    </article>
    <article class="stat">
      <h3>Bookings this month</h3>
      <p><a class="stat-link" href="/admin/bookings">${bookingsThisMonth}</a></p>
    </article>
    <article class="stat">
      <h3>Confirmed</h3>
      <p><a class="stat-link" href="/admin/bookings?status=CONFIRMED">${confirmedCount}</a></p>
    </article>
    <article class="stat">
      <h3>Conversations this month</h3>
      <p><a class="stat-link" href="/admin/conversations">${conversationsThisMonth}</a></p>
    </article>
  </div>
  <p class="muted" style="margin-top: 8px">Quick links: <a class="inline-link" href="/admin/room-board">Room board</a> · <a class="inline-link" href="/admin/calendar">Calendar</a> · <a class="inline-link" href="/admin/inventory">Inventory</a> · <a class="inline-link" href="/admin/fb/menu">Restaurant &amp; Café</a> · <a class="inline-link" href="/admin/conversations">Conversations</a></p>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

type RoomBoardStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";

type RoomBoardCardRow = {
  unitId: string | null;
  unitName: string;
  roomTypeId: string;
  name: string;
  status: RoomBoardStatus;
  guestName: string | null;
  checkIn: Date | null;
  checkOut: Date | null;
  bookingId: string | null;
  isUnassignedBooking: boolean;
  adults: number | null;
  children: number | null;
  bookingNights: number | null;
};

type RoomBoardLoadViewOpts = { omitFilters?: boolean; boardPath?: string };

type RoomBoardLoadViewResult = {
  hotelId: string;
  hotelDisplayName: string;
  boardDate: Date;
  filterRoomTypeId: string;
  filterUnitId: string;
  filterStatus: string;
  buildRoomBoardQuery: (day: Date) => string;
  prevRoomBoardHref: string;
  nextRoomBoardHref: string;
  dateStart: Date;
  dateEndExclusive: Date;
  roomTypes: Awaited<ReturnType<typeof prisma.roomType.findMany>>;
  cards: RoomBoardCardRow[];
  filteredCards: RoomBoardCardRow[];
  statusCounts: Record<RoomBoardStatus, number>;
  totalRooms: number;
  updatedNotice: string;
  manualCheckInNotice: string;
  manualCheckOutNotice: string;
  invoiceSentFromCheckIn: string;
  invoiceErrFromCheckIn: string;
  printInvoiceScript: string;
};

async function loadRoomBoardViewData(req: Request, opts?: RoomBoardLoadViewOpts): Promise<RoomBoardLoadViewResult | null> {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: defaultHotelSlug },
    include: {
      roomTypes: { where: { isActive: true }, orderBy: { name: "asc" }, include: { property: true, roomUnits: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } } }
    }
  });
  if (!hotel) return null;

  const now = startOfDay(new Date());
  const boardDate = parseDateInput(req.query.date, now);
  let filterRoomTypeId = typeof req.query.roomTypeId === "string" ? req.query.roomTypeId.trim() : "";
  let filterUnitId = typeof req.query.unitId === "string" ? req.query.unitId.trim() : "";
  let filterStatus = typeof req.query.status === "string" ? req.query.status.trim().toUpperCase() : "";
  if (opts?.omitFilters) {
    filterRoomTypeId = "";
    filterUnitId = "";
    filterStatus = "";
  }
  const boardBase = opts?.boardPath ?? "/admin/room-board";

  const buildRoomBoardQuery = (day: Date): string => {
    const p = new URLSearchParams();
    p.set("date", formatDateForInput(day));
    if (filterRoomTypeId) p.set("roomTypeId", filterRoomTypeId);
    if (filterUnitId) p.set("unitId", filterUnitId);
    if (filterStatus) p.set("status", filterStatus);
    return p.toString();
  };
  const prevRoomBoardHref = `${boardBase}?${buildRoomBoardQuery(addDays(boardDate, -1))}`;
  const nextRoomBoardHref = `${boardBase}?${buildRoomBoardQuery(addDays(boardDate, 1))}`;

  const dateStart = boardDate;
  const dateEndExclusive = addDays(boardDate, 1);
  const updatedNotice = req.query.unitUpdated ? '<p class="badge ok">Room status updated.</p>' : "";
  const manualCheckInNotice = req.query.manualCheckIn ? '<p class="badge ok">Manual check-in saved. Booking created and room board updated.</p>' : "";
  const manualCheckOutNotice = req.query.manualCheckOut ? '<p class="badge ok">Room marked for housekeeping (cleaning).</p>' : "";
  const invoiceSentFromCheckIn = req.query.invoiceSent ? '<p class="badge ok">Invoice PDF was sent to the guest on WhatsApp.</p>' : "";
  const invoiceErrFromCheckIn =
    typeof req.query.invoiceError === "string" && req.query.invoiceError.trim()
      ? `<p class="badge alert">${escapeHtml(req.query.invoiceError.trim().slice(0, 600))}</p>`
      : "";
  const printBookingIdRaw = typeof req.query.printBookingId === "string" ? req.query.printBookingId.trim() : "";
  const printInvoiceScript = printBookingIdRaw
    ? `<script>(function(){var u=${JSON.stringify(`/admin/bookings/${encodeURIComponent(printBookingIdRaw)}/invoice-print`)};window.open(u,"_blank","noopener");})();</script>`
    : "";

  await ensureDefaultRoomUnitsForBoard(
    hotel.id,
    hotel.roomTypes.map((rt) => ({ id: rt.id, code: rt.code, name: rt.name }))
  );
  await backfillMissingRoomUnitAssignmentsForDate({
    hotelId: hotel.id,
    dateStart,
    dateEndExclusive
  });
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { name: "asc" },
    include: { property: true, roomUnits: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }
  });

  const boardDayRange = inventoryDayRangeExclusive(dateStart);
  const [inventoryRows, overlappingBookings] = await Promise.all([
    prisma.inventory.findMany({
      where: { hotelId: hotel.id, date: { gte: boardDayRange.gte, lt: boardDayRange.lt } },
      select: { roomTypeId: true, total: true, reserved: true, closedOut: true }
    }),
    prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: dateStart },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      include: { guest: true, roomType: true, roomUnit: true },
      orderBy: { checkIn: "asc" }
    })
  ]);

  const inventoryByRoomType = new Map(inventoryRows.map((r) => [r.roomTypeId, r]));

  const cards: RoomBoardCardRow[] = [];
  const statusCounts = { AVAILABLE: 0, RESERVED: 0, OCCUPIED: 0, CLEANING: 0, MAINTENANCE: 0 };

  for (const roomType of roomTypes) {
    const inv = inventoryByRoomType.get(roomType.id);
    const closedOut = inv?.closedOut ?? false;
    const bookableTotal = inv?.total ?? roomType.totalInventory;
    const reservedCount = inv?.reserved ?? 0;
    const aggregateAvailable = closedOut ? 0 : Math.max(0, bookableTotal - reservedCount);
    const units = roomType.roomUnits;
    const activeUnits = units.filter((u) => u.isActive);
    const overlapForType = overlappingBookings.filter((b) => b.roomTypeId === roomType.id);
    const bookingSlotCount = overlapForType.length;
    const unbookedActiveUnits = activeUnits.filter((u) => !overlapForType.some((b) => b.roomUnitId === u.id));
    const effectiveReserved = Math.min(reservedCount, bookableTotal);
    const needInvReserved = Math.max(0, effectiveReserved - bookingSlotCount);
    const reservedFromInventoryUnitIds = new Set<string>();
    {
      let remaining = needInvReserved;
      for (const u of unbookedActiveUnits) {
        if (remaining <= 0) break;
        if (parseManualRoomStatusFromNotes(u.notes)) continue;
        reservedFromInventoryUnitIds.add(u.id);
        remaining -= 1;
      }
    }

    for (const unit of units) {
      const bookingsForUnit = overlappingBookings.filter((b) => b.roomUnitId === unit.id);
      const firstBooking = bookingsForUnit[0] ?? null;
      const hasConfirmed = bookingsForUnit.some((b) => b.status === "CONFIRMED");
      const hasPending = bookingsForUnit.some((b) => b.status === "PENDING");
      const manualStatus = parseManualRoomStatusFromNotes(unit.notes);
      const activeIndex = activeUnits.findIndex((u) => u.id === unit.id);
      const beyondInventoryCap = unit.isActive && activeIndex >= 0 && activeIndex >= bookableTotal;

      let status: RoomBoardStatus;
      const fromBooking = roomBoardStatusFromBookingOverlap({ hasConfirmed, hasPending, manualStatus });
      if (fromBooking !== null) {
        status = fromBooking;
      } else if (closedOut) {
        status = "MAINTENANCE";
      } else if (manualStatus) {
        status = manualStatus;
      } else if (!unit.isActive) {
        status = "MAINTENANCE";
      } else if (beyondInventoryCap) {
        status = "MAINTENANCE";
      } else if (reservedFromInventoryUnitIds.has(unit.id)) {
        status = "RESERVED";
      } else if (aggregateAvailable <= 0) {
        status = "RESERVED";
      } else {
        status = "AVAILABLE";
      }
      statusCounts[status] += 1;

      cards.push({
        unitId: unit.id,
        unitName: unit.name,
        roomTypeId: roomType.id,
        name: roomType.name,
        status,
        guestName: firstBooking?.guest?.fullName ?? firstBooking?.guest?.phoneE164 ?? null,
        checkIn: firstBooking?.checkIn ?? null,
        checkOut: firstBooking?.checkOut ?? null,
        bookingId: firstBooking?.id ?? null,
        isUnassignedBooking: false,
        adults: firstBooking ? firstBooking.adults : null,
        children: firstBooking ? firstBooking.children : null,
        bookingNights: firstBooking ? firstBooking.nights : null
      });
    }

    const unassignedForType = overlappingBookings.filter((b) => b.roomTypeId === roomType.id && !b.roomUnitId);
    for (const b of unassignedForType) {
      const hasConfirmed = b.status === "CONFIRMED";
      const hasPending = b.status === "PENDING";
      let status: RoomBoardStatus;
      const fromBooking = roomBoardStatusFromBookingOverlap({ hasConfirmed, hasPending, manualStatus: null });
      if (fromBooking !== null) {
        status = fromBooking;
      } else {
        status = "RESERVED";
      }
      statusCounts[status] += 1;
      cards.push({
        unitId: null,
        unitName: "Unassigned",
        roomTypeId: roomType.id,
        name: roomType.name,
        status,
        guestName: b.guest?.fullName ?? b.guest?.phoneE164 ?? null,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        bookingId: b.id,
        isUnassignedBooking: true,
        adults: b.adults,
        children: b.children,
        bookingNights: b.nights
      });
    }
  }

  let filteredCards = cards;
  if (filterRoomTypeId) filteredCards = filteredCards.filter((c) => c.roomTypeId === filterRoomTypeId);
  if (filterUnitId) filteredCards = filteredCards.filter((c) => c.unitId === filterUnitId);
  if (filterStatus) filteredCards = filteredCards.filter((c) => c.status === filterStatus);

  const totalRooms = cards.length;

  return {
    hotelId: hotel.id,
    hotelDisplayName: hotel.displayName,
    boardDate,
    filterRoomTypeId,
    filterUnitId,
    filterStatus,
    buildRoomBoardQuery,
    prevRoomBoardHref,
    nextRoomBoardHref,
    dateStart,
    dateEndExclusive,
    roomTypes,
    cards,
    filteredCards,
    statusCounts,
    totalRooms,
    updatedNotice,
    manualCheckInNotice,
    manualCheckOutNotice,
    invoiceSentFromCheckIn,
    invoiceErrFromCheckIn,
    printInvoiceScript
  };
}

function getRoomBoardStatusClass(status: RoomBoardStatus): string {
  switch (status) {
    case "AVAILABLE": return "room-status-available";
    case "RESERVED": return "room-status-reserved";
    case "OCCUPIED": return "room-status-occupied";
    case "CLEANING": return "room-status-cleaning";
    case "MAINTENANCE": return "room-status-maintenance";
    default: return "room-status-available";
  }
}

/** Total stay length in nights; prefers PMS `booking.nights`, else calendar nights between check-in and check-out. */
function totalNightsForRoomBoard(checkIn: Date, checkOut: Date, bookingNights: number | null | undefined): number {
  if (typeof bookingNights === "number" && bookingNights >= 1 && Number.isFinite(bookingNights)) {
    return Math.floor(bookingNights);
  }
  const span = Math.round((startOfDay(checkOut).getTime() - startOfDay(checkIn).getTime()) / 86400000);
  return Math.max(1, span);
}

/**
 * Which night of the stay the board date falls on (1-based), capped at total nights (e.g. departure day).
 * Example: check-in Apr 12, check-out Apr 14, 2 nights → Apr 12 = 1/2, Apr 13 = 2/2, Apr 14 = 2/2.
 */
function roomBoardNightIndexForBoardDate(boardDate: Date, checkIn: Date, totalNights: number): number {
  const offsetDays = Math.round((startOfDay(boardDate).getTime() - startOfDay(checkIn).getTime()) / 86400000);
  if (offsetDays < 0) return 1;
  return Math.min(offsetDays + 1, Math.max(1, totalNights));
}

/** Compact adults/children + Night x/y for room status cards when a booking is attached. */
function formatRoomBoardStayDetailHtml(params: {
  bookingId: string | null;
  adults: number | null | undefined;
  children: number | null | undefined;
  boardDate: Date;
  checkIn: Date | null;
  checkOut: Date | null;
  bookingNights: number | null | undefined;
}): string {
  if (!params.bookingId || !params.checkIn || !params.checkOut) return "";
  const adults = Math.max(0, Number(params.adults ?? 0));
  const children = Math.max(0, Number(params.children ?? 0));
  const total = totalNightsForRoomBoard(params.checkIn, params.checkOut, params.bookingNights);
  const nightIdx = roomBoardNightIndexForBoardDate(params.boardDate, params.checkIn, total);
  const childPart =
    children > 0
      ? ` <span title="Children">👶 ${children}</span>`
      : "";
  return `<div class="room-board-stay-detail" style="margin-top:4px;font-size:10px;line-height:1.35">
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap" aria-label="Party size"><span title="Adults">👤 ${adults}</span>${childPart}</div>
  <div style="font-weight:650;margin-top:2px;letter-spacing:0.02em" title="Stay progression for this board date">Night ${nightIdx}/${total}</div>
</div>`;
}

/**
 * PENDING/CONFIRMED bookings show as RESERVED on the board (future or same-day reservation).
 * OCCUPIED is only shown after front desk sets the room unit to OCCUPIED (stored in unit notes).
 * CLEANING / MAINTENANCE in notes still win when staff set them explicitly.
 */
function roomBoardStatusFromBookingOverlap(params: {
  hasConfirmed: boolean;
  hasPending: boolean;
  manualStatus: RoomBoardStatus | null;
}): RoomBoardStatus | null {
  if (!params.hasConfirmed && !params.hasPending) return null;
  if (params.manualStatus === "OCCUPIED") return "OCCUPIED";
  if (params.manualStatus === "CLEANING" || params.manualStatus === "MAINTENANCE") {
    return params.manualStatus;
  }
  return "RESERVED";
}

function parseManualRoomStatusFromNotes(notes: string | null | undefined): RoomBoardStatus | null {
  if (!notes) return null;
  const match = notes.match(/\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)\]/);
  return (match?.[1] as RoomBoardStatus | undefined) ?? null;
}

function writeManualRoomStatusToNotes(notes: string | null | undefined, status: RoomBoardStatus): string {
  const cleaned = (notes ?? "").replace(/\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)\]/g, "").trim();
  return `${cleaned ? `${cleaned} ` : ""}[status:${status}]`.trim();
}

/** Shared markup for room status POST — keeps one card’s form scoped to that unit (avoids ambiguous flex rows). */
function roomBoardStatusFormHtml(opts: {
  unitId: string;
  boardDate: Date;
  status: RoomBoardStatus;
  returnTo?: string | null;
  variant: "profile" | "full" | "hk";
}): string {
  const hiddenReturn =
    opts.returnTo != null && String(opts.returnTo).length > 0
      ? `<input type="hidden" name="returnTo" value="${escapeHtml(String(opts.returnTo))}" />`
      : "";
  const selPad = opts.variant === "profile" ? "6px" : "4px 6px";
  const btnPad = opts.variant === "profile" ? "6px 10px" : "4px 8px";
  const s = opts.status;
  const selIdRaw = `rbsel-${opts.unitId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const selId = selIdRaw.length > 0 ? selIdRaw : "rbsel-unit";
  return `<div class="room-board-card-actions" data-room-unit-id="${escapeHtml(opts.unitId)}">
  <form method="post" action="/admin/room-board/unit/${encodeURIComponent(opts.unitId)}/status" class="room-board-status-form" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;width:100%;max-width:100%;min-width:0;box-sizing:border-box;margin:0">
    <input type="hidden" name="date" value="${formatDateForInput(opts.boardDate)}" />
    ${hiddenReturn}
    <select id="${selId}" name="status" aria-label="Set room status" style="padding:${selPad};border:1px solid #d8dee6;border-radius:8px;font-size:12px;flex:1 1 auto;min-width:0;max-width:100%">
      <option value="AVAILABLE" ${s === "AVAILABLE" ? "selected" : ""}>Available</option>
      <option value="RESERVED" ${s === "RESERVED" ? "selected" : ""}>Reserved</option>
      <option value="OCCUPIED" ${s === "OCCUPIED" ? "selected" : ""}>Occupied</option>
      <option value="CLEANING" ${s === "CLEANING" ? "selected" : ""}>Cleaning</option>
      <option value="MAINTENANCE" ${s === "MAINTENANCE" ? "selected" : ""}>Maintenance</option>
    </select>
    <button type="submit" style="padding:${btnPad};border:0;border-radius:8px;background:#0b6e6e;color:#fff;font-weight:700;white-space:nowrap">Set</button>
  </form>
</div>`;
}

function getPreferredUnitSortRank(unitName: string): number {
  const normalized = unitName.trim().toUpperCase();
  const match = normalized.match(/^([NSF])(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const prefix = match[1];
  const num = Number.parseInt(match[2], 10);
  if (prefix === "N" && num >= 1 && num <= 12) return num;
  if (prefix === "S" && num >= 1 && num <= 8) return 100 + num;
  if (prefix === "F" && num >= 1 && num <= 7) return 200 + num;
  return Number.MAX_SAFE_INTEGER;
}

function stripLegacyNationalityFromNotes(notes: string): string {
  return notes
    .split("\n")
    .filter((line) => !/^\s*Nationality:\s*/i.test(line))
    .join("\n")
    .trim();
}

type ManualGuestDetails = {
  fullName: string;
  phone: string;
  email: string;
  nationality: string;
  notes: string;
  adults: number | null;
  children: number | null;
  mealPlan: "BREAKFAST" | "HALF_BOARD" | "NONE";
  idCardPath: string;
  paymentMethod: string;
  paymentAmount: number | null;
  balanceAmount: number | null;
  transactionNumber: string;
  bookedBy: string;
  tourCompany: string;
  handoverId: string;
  handoverAt: string;
  handoverBy: string;
  handoverSignature: string;
};

async function getManualGuestDetailsForUnitOnDate(unitId: string, dateKey: string): Promise<ManualGuestDetails | null> {
  const logs = await prisma.auditLog.findMany({
    where: { action: "ROOM_UNIT_GUEST_DETAILS", entityType: "RoomUnit", entityId: unitId },
    orderBy: { createdAt: "desc" },
    take: 20
  });
  for (const log of logs) {
    const metadata = parseAuditMetadata(log.metadataJson);
    if (typeof metadata.date !== "string" || metadata.date !== dateKey) continue;
    return {
      fullName: typeof metadata.fullName === "string" ? metadata.fullName : "",
      phone: typeof metadata.phone === "string" ? metadata.phone : "",
      email: typeof metadata.email === "string" ? metadata.email : "",
      nationality: typeof metadata.nationality === "string" ? metadata.nationality : "",
      notes: typeof metadata.notes === "string" ? metadata.notes : "",
      adults: typeof metadata.adults === "number" ? metadata.adults : null,
      children: typeof metadata.children === "number" ? metadata.children : null,
      mealPlan: metadata.mealPlan === "BREAKFAST" || metadata.mealPlan === "HALF_BOARD" ? metadata.mealPlan : "NONE",
      idCardPath: typeof metadata.idCardPath === "string" ? metadata.idCardPath : "",
      paymentMethod: typeof metadata.paymentMethod === "string" ? metadata.paymentMethod : "",
      paymentAmount: typeof metadata.paymentAmount === "number" ? metadata.paymentAmount : null,
      balanceAmount: typeof metadata.balanceAmount === "number" ? metadata.balanceAmount : null,
      transactionNumber: typeof metadata.transactionNumber === "string" ? metadata.transactionNumber : "",
      bookedBy: typeof metadata.bookedBy === "string" ? metadata.bookedBy : "",
      tourCompany: typeof metadata.tourCompany === "string" ? metadata.tourCompany : "",
      handoverId: typeof metadata.handoverId === "string" ? metadata.handoverId : "",
      handoverAt: typeof metadata.handoverAt === "string" ? metadata.handoverAt : "",
      handoverBy: typeof metadata.handoverBy === "string" ? metadata.handoverBy : "",
      handoverSignature: typeof metadata.handoverSignature === "string" ? metadata.handoverSignature : ""
    };
  }
  return null;
}

async function ensureDefaultRoomUnitsForBoard(hotelId: string, roomTypes: Array<{ id: string; code: string; name: string }>): Promise<void> {
  const templates: Array<{ matcher: (roomType: { code: string; name: string }) => boolean; names: string[] }> = [
    {
      matcher: (rt) => {
        const code = rt.code.toUpperCase();
        const name = rt.name.toLowerCase();
        return (
          code.includes("APART") ||
          name.includes("apart") ||
          /\b1\s*bed\b/i.test(rt.name) ||
          code.includes("1BED") ||
          code.includes("1-BED")
        );
      },
      names: ["N7", "N8", "N9", "N10", "N11", "N12"]
    },
    { matcher: (rt) => rt.code.toUpperCase().includes("STD_EXEC") || rt.name.toLowerCase().includes("executive"), names: ["N1", "N2", "N3", "N4", "N5", "N6"] },
    { matcher: (rt) => rt.code.toUpperCase().includes("STD_SUPERIOR") || rt.name.toLowerCase().includes("superior"), names: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"] },
    { matcher: (rt) => rt.code.toUpperCase().includes("SUITE") || rt.name.toLowerCase().includes("suite"), names: ["F1", "F2", "F3", "F4", "F5", "F6", "F7"] }
  ];

  for (const roomType of roomTypes) {
    const template = templates.find((entry) => entry.matcher(roomType));
    if (!template) continue;
    const existing = await prisma.roomUnit.findMany({
      where: { hotelId, roomTypeId: roomType.id },
      select: { name: true }
    });
    const existingSet = new Set(existing.map((row) => row.name.toUpperCase()));
    const toCreate = template.names
      .filter((name) => !existingSet.has(name.toUpperCase()))
      .map((name, index) => ({
        hotelId,
        roomTypeId: roomType.id,
        name,
        sortOrder: index + 1
      }));
    if (toCreate.length) await prisma.roomUnit.createMany({ data: toCreate });
  }
}

async function backfillMissingRoomUnitAssignmentsForDate(params: { hotelId: string; dateStart: Date; dateEndExclusive: Date }): Promise<void> {
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: params.hotelId, isActive: true },
    select: { id: true }
  });
  for (const roomType of roomTypes) {
    const units = await prisma.roomUnit.findMany({
      where: { hotelId: params.hotelId, roomTypeId: roomType.id, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true }
    });
    if (!units.length) continue;

    const bookings = await prisma.booking.findMany({
      where: {
        hotelId: params.hotelId,
        roomTypeId: roomType.id,
        checkIn: { lt: params.dateEndExclusive },
        checkOut: { gt: params.dateStart },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      select: { id: true, roomUnitId: true, checkIn: true, createdAt: true },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }]
    });

    const occupied = new Set<string>(bookings.map((b) => b.roomUnitId).filter((id): id is string => Boolean(id)));
    for (const booking of bookings) {
      if (booking.roomUnitId) continue;
      const candidate = units.find((u) => !occupied.has(u.id));
      if (!candidate) continue;
      await prisma.booking.update({
        where: { id: booking.id },
        data: { roomUnitId: candidate.id }
      });
      occupied.add(candidate.id);
      await logAudit({
        hotelId: params.hotelId,
        action: "BOOKING_UNIT_AUTO_ASSIGNED_BACKFILL",
        entityType: "Booking",
        entityId: booking.id,
        metadata: { roomUnitId: candidate.id, date: formatDateForInput(params.dateStart) }
      });
    }
  }
}

adminRouter.post("/room-board/unit/:unitId/status", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: defaultHotelSlug }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/room-board");
    return;
  }
  const unitId = String(req.params.unitId ?? "");
  const statusInput = String(req.body.status ?? "").trim().toUpperCase();
  const returnTo = safeAdminReturnToPath(req.body.returnTo, "");
  const validStatuses: RoomBoardStatus[] = ["AVAILABLE", "RESERVED", "OCCUPIED", "CLEANING", "MAINTENANCE"];
  const status = validStatuses.includes(statusInput as RoomBoardStatus) ? (statusInput as RoomBoardStatus) : "AVAILABLE";
  const boardDate = parseDateInput(req.body.date, startOfDay(new Date()));
  const unit = await prisma.roomUnit.findFirst({
    where: { id: unitId, hotelId: hotel.id },
    select: { id: true, notes: true }
  });
  if (!unit) {
    const fallback = `/admin/room-board?date=${formatDateForInput(boardDate)}`;
    res.redirect(returnTo === "/admin/profile" ? "/admin/profile" : fallback);
    return;
  }
  const staffSession = getSession(req);
  const staffId = staffSession?.staffId;

  let hkCreatedFromBoard: { created: boolean; taskId: string | null } = { created: false, taskId: null };
  let hkOpsSkipped = false;
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.roomUnit.findUnique({ where: { id: unit.id }, select: { notes: true } });
    await tx.roomUnit.update({
      where: { id: unit.id },
      data: { notes: writeManualRoomStatusToNotes(fresh?.notes, status) }
    });
    try {
      if (status === "CLEANING") {
        hkCreatedFromBoard = await ensureHousekeepingTaskForCleaningTx(tx, {
          hotelId: hotel.id,
          roomUnitId: unit.id,
          source: HousekeepingTaskSource.MANUAL,
          createdByUserId: staffId ?? null,
          notes: "Room board set to CLEANING"
        });
      }
      if (status === "AVAILABLE") {
        await tx.housekeepingTask.updateMany({
          where: {
            hotelId: hotel.id,
            roomUnitId: unit.id,
            status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
          },
          data: {
            status: HousekeepingTaskStatus.COMPLETED,
            completedAt: new Date(),
            completedByUserId: hotelUserIdForPrismaFk(staffId) ?? null,
            notes: "Marked AVAILABLE from room board (bypassed HK screen)"
          }
        });
      }
    } catch (err) {
      if (!isOptionalHousekeepingSchemaError(err)) throw err;
      hkOpsSkipped = true;
    }
  });

  if (!hkOpsSkipped && hkCreatedFromBoard.created && hkCreatedFromBoard.taskId) {
    try {
      const unitLabel = await prisma.roomUnit.findUnique({
        where: { id: unit.id },
        select: { name: true, roomType: { select: { name: true } } }
      });
      const label = unitLabel ? `${unitLabel.name} (${unitLabel.roomType.name})` : unit.id;
      await notifyHousekeepingStaff({
        hotelId: hotel.id,
        type: "HK_TASK_NEW",
        title: "Room marked for cleaning",
        body: `${label} — new housekeeping task from room board.`,
        payloadJson: JSON.stringify({ taskId: hkCreatedFromBoard.taskId, roomUnitId: unit.id })
      });
    } catch (err) {
      if (!isOptionalHousekeepingSchemaError(err)) throw err;
    }
  }

  await logAudit({
    hotelId: hotel.id,
    action: "ROOM_BOARD_UNIT_STATUS",
    entityType: "RoomUnit",
    entityId: unit.id,
    metadata: { status, source: "room_board" }
  });

  if (status === "MAINTENANCE" || status === "CLEANING") {
    const now = new Date();
    const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const nextArrival = await prisma.booking.findFirst({
      where: {
        hotelId: hotel.id,
        roomUnitId: unit.id,
        status: BookingStatus.CONFIRMED,
        checkIn: { gte: now, lte: soon }
      },
      orderBy: { checkIn: "asc" },
      select: { id: true, checkIn: true, referenceCode: true }
    });
    if (status === "MAINTENANCE" || nextArrival) {
      await createRoleRoutedNotification({
        hotelId: hotel.id,
        roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.OWNER],
        title: status === "MAINTENANCE" ? "Room moved to maintenance" : "Room status requires attention",
        body:
          status === "MAINTENANCE"
            ? `Room ${unit.id} is now in maintenance mode and may affect upcoming stays.`
            : `Room ${unit.id} is cleaning with an arrival in the next 24 hours${nextArrival?.referenceCode ? ` (${nextArrival.referenceCode})` : ""}.`,
        category: "rooms",
        severity: status === "MAINTENANCE" ? "high" : "critical",
        link: "/admin/room-board",
        sourceType: "ROOM_BOARD_UNIT_STATUS",
        sourceId: unit.id,
        requiresAttention: true
      }).catch(() => undefined);
    }
  }

  if (returnTo === "/admin/profile") {
    res.redirect("/admin/profile?unitUpdated=1");
    return;
  }
  if (returnTo.startsWith("/admin/hk")) {
    const join = returnTo.includes("?") ? "&" : "?";
    res.redirect(`${returnTo}${join}unitUpdated=1`);
    return;
  }
  res.redirect(`/admin/room-board?date=${formatDateForInput(boardDate)}&unitUpdated=1`);
});

adminRouter.get("/hk", requireAuth, requireHousekeepingPortal, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true, displayName: true } });
  if (!hotel) {
    res.type("html").send(renderHkLayout({ title: "My tasks", active: "tasks", content: "<h2>My tasks</h2><p>No hotel data.</p>" }));
    return;
  }
  const session = getSession(req)!;
  const hkListFilters = parseHkPortalListFilters(req);
  const hkListHidden = hkPortalListHiddenInputs(hkListFilters);
  const assignNotice =
    req.query.assign === "blocked"
      ? '<p class="badge alert">That room was claimed by another teammate.</p>'
      : req.query.start === "blocked"
        ? '<p class="badge alert">Unable to start cleaning (refresh and try again).</p>'
        : req.query.complete === "need-start"
          ? '<p class="badge alert">Start cleaning before marking the room ready.</p>'
          : "";
  const openTasks = await prisma.housekeepingTask.findMany({
    where: { hotelId: hotel.id, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: 200,
    include: {
      roomUnit: { select: { name: true, roomType: { select: { name: true } } } },
      assignedTo: { select: { fullName: true } },
      booking: { select: { id: true, checkIn: true, checkOut: true, guest: { select: { isVip: true } } } }
    }
  });
  const hkRoomIds = Array.from(new Set(openTasks.map((t) => t.roomUnitId)));
  const hkUpcoming = new Map<string, { checkIn: Date; isVip: boolean }>();
  const hkTodayStart = startOfDay(new Date());
  if (hkRoomIds.length > 0) {
    const hkArrivals = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        roomUnitId: { in: hkRoomIds },
        status: BookingStatus.CONFIRMED,
        checkIn: { gte: hkTodayStart }
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: { roomUnitId: true, checkIn: true, guest: { select: { isVip: true } } }
    });
    for (const b of hkArrivals) {
      if (!b.roomUnitId) continue;
      if (!hkUpcoming.has(b.roomUnitId)) {
        hkUpcoming.set(b.roomUnitId, { checkIn: b.checkIn, isVip: b.guest.isVip });
      }
    }
  }
  const hkNextAuto = await pickCleanerForAutoAssign(prisma, hotel.id);
  const hkSuggest = hkNextAuto?.fullName;
  const hkDecorated = openTasks.map((t) => {
    const hkShift = parseHousekeepingShift(t.notes) ?? deriveHousekeepingShift(t.startedAt ?? t.createdAt);
    const hint = t.booking?.checkIn
      ? { checkIn: t.booking.checkIn, isVip: t.booking.guest?.isVip === true }
      : hkUpcoming.get(t.roomUnitId);
    const hasArrivalToday = Boolean(hint && startOfDay(hint.checkIn).getTime() === hkTodayStart.getTime());
    const ev = evaluateHousekeepingTaskPriority({
      bookingCheckIn: hint?.checkIn,
      bookingGuestVip: hint?.isVip === true,
      taskSource: t.source,
      linkedBookingCheckOut: t.booking?.checkOut ?? null,
      hasArrivalToday
    });
    return {
      ...t,
      hkShift,
      hkPriority: ev.level,
      hkReason: ev.reason,
      nextArrivalAt: hint?.checkIn ?? null
    };
  });
  const hkFiltered = hkDecorated.filter((t) => {
    if (hkListFilters.mine && t.assignedToUserId !== session.staffId) return false;
    if (hkListFilters.shift !== "ALL" && t.hkShift !== hkListFilters.shift) return false;
    if (hkListFilters.priority !== "ALL" && t.hkPriority !== hkListFilters.priority) return false;
    return true;
  });
  const hkSorted = [...hkFiltered].sort((a, b) => {
    const d = housekeepingPriorityRank(a.hkPriority) - housekeepingPriorityRank(b.hkPriority);
    if (d !== 0) return d;
    const at = a.nextArrivalAt ? a.nextArrivalAt.getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.nextArrivalAt ? b.nextArrivalAt.getTime() : Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  const hkChip = (label: string, target: HkPortalListFilters) => {
    const active =
      hkListFilters.mine === target.mine &&
      hkListFilters.priority === target.priority &&
      hkListFilters.shift === target.shift;
    const href = "/admin/hk" + buildHkPortalListQueryString(target);
    const style = active
      ? "border:2px solid #128c7e;background:#e6fffa;font-weight:700"
      : "border:1px solid #d8dee6;background:#fff;font-weight:500";
    return `<a href="${href}" style="padding:6px 10px;border-radius:999px;font-size:12px;text-decoration:none;color:#111;${style}">${escapeHtml(label)}</a>`;
  };
  const hkFilterBar = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;align-items:center">
<span class="muted" style="font-size:12px;width:100%">Quick filters</span>
${hkChip("All", { mine: false, priority: "ALL", shift: "ALL" })}
${hkChip("My tasks", { mine: true, priority: hkListFilters.priority, shift: hkListFilters.shift })}
${hkChip("Critical", { mine: hkListFilters.mine, priority: "CRITICAL", shift: hkListFilters.shift })}
${hkChip("High", { mine: hkListFilters.mine, priority: "HIGH", shift: hkListFilters.shift })}
${hkChip("Medium", { mine: hkListFilters.mine, priority: "MEDIUM", shift: hkListFilters.shift })}
${hkChip("Morning", { mine: hkListFilters.mine, priority: hkListFilters.priority, shift: "MORNING" })}
${hkChip("Evening", { mine: hkListFilters.mine, priority: hkListFilters.priority, shift: "EVENING" })}
${hkChip("Night", { mine: hkListFilters.mine, priority: hkListFilters.priority, shift: "NIGHT" })}
</div>`;
  const shiftSelect = () => `<select name="shift" style="padding:4px 6px;border:1px solid #d8dee6;border-radius:8px">
    <option value="MORNING">Morning</option>
    <option value="EVENING">Evening</option>
    <option value="NIGHT">Night</option>
  </select>`;
  const rows = hkSorted
    .map((t) => {
      const roomLabel = `${escapeHtml(t.roomUnit.name)} (${escapeHtml(t.roomUnit.roomType.name)})`;
      const priColor =
        t.hkPriority === "CRITICAL" ? "#b91c1c" : t.hkPriority === "HIGH" ? "#dc2626" : t.hkPriority === "MEDIUM" ? "#ca8a04" : "#475569";
      const priCell = `<span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:${priColor};color:#fff">${t.hkPriority}</span><div class="muted" style="font-size:10px;margin-top:4px;line-height:1.35">${escapeHtml(t.hkReason)}</div>`;
      const suggestLine =
        !t.assignedToUserId && hkSuggest
          ? `<div class="muted" style="font-size:11px;margin-top:4px">Fair queue — next auto-assign: ${escapeHtml(hkSuggest)}</div>`
          : "";
      const assignee = t.assignedToUserId
        ? t.assignedToUserId === session.staffId
          ? `<span class="badge ok">You</span>`
          : `<span class="badge pending">${escapeHtml(t.assignedTo?.fullName ?? "Assigned")}</span>`
        : '<span class="muted">—</span>';
      const modeHint = `<div class="muted" style="font-size:10px;margin-top:3px">${escapeHtml(formatHousekeepingAssignmentMode(t.assignmentMode, Boolean(t.assignedToUserId)))}</div>`;
      const claimedMeta =
        t.startedAt != null
          ? `<div class="muted" style="font-size:12px;margin-top:4px">Started ${escapeHtml(formatDateTime(t.startedAt))}</div>`
          : t.assignedToUserId
            ? '<div class="muted" style="font-size:12px;margin-top:4px">Claimed — not started</div>'
            : "";
      let actions = "";
      if (t.status === HousekeepingTaskStatus.PENDING && !t.assignedToUserId) {
        actions = `<form method="post" action="/admin/hk/task/${encodeURIComponent(t.id)}/assign" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0">${hkListHidden}${shiftSelect()}<button type="submit" style="padding:6px 12px;border-radius:8px;border:0;background:#128c7e;color:#fff;font-weight:700;cursor:pointer">Claim</button></form>`;
      } else if (t.status === HousekeepingTaskStatus.PENDING && t.assignedToUserId === session.staffId && !t.startedAt) {
        actions = `<form method="post" action="/admin/hk/task/${encodeURIComponent(t.id)}/start-cleaning" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0">${hkListHidden}${shiftSelect()}<button type="submit" style="padding:6px 12px;border-radius:8px;border:0;background:#0b6e6e;color:#fff;font-weight:700;cursor:pointer">Start cleaning</button></form>`;
      } else if (
        (t.status === HousekeepingTaskStatus.IN_PROGRESS || t.status === HousekeepingTaskStatus.PENDING) &&
        t.assignedToUserId === session.staffId &&
        t.startedAt
      ) {
        actions = `<form method="post" action="/admin/hk/task/${encodeURIComponent(t.id)}/complete" style="display:inline;margin:0 6px 0 0">${hkListHidden}<input type="hidden" name="targetStatus" value="AVAILABLE" /><button type="submit" style="padding:6px 12px;border-radius:8px;border:0;background:#128c7e;color:#fff;font-weight:700;cursor:pointer">Mark ready</button></form>
        <form method="post" action="/admin/hk/task/${encodeURIComponent(t.id)}/complete" style="display:inline;margin:0">${hkListHidden}<input type="hidden" name="targetStatus" value="MAINTENANCE" /><button type="submit" style="padding:6px 12px;border-radius:8px;border:0;background:#6b21a8;color:#fff;font-weight:700;cursor:pointer">Maintenance</button></form>`;
      } else if (t.assignedToUserId && t.assignedToUserId !== session.staffId) {
        actions = '<span class="muted">In use by another housekeeper</span>';
      }
      return `<tr><td>${roomLabel}</td><td>${priCell}</td><td>${escapeHtml(t.status)}</td><td>${assignee}${modeHint}${suggestLine}${claimedMeta}</td><td style="white-space:nowrap">${actions}</td></tr>`;
    })
    .join("");
  const hkCrit = hkDecorated.filter((t) => t.hkPriority === "CRITICAL").length;
  const hkProg = hkDecorated.filter((t) => t.status === HousekeepingTaskStatus.IN_PROGRESS).length;
  const hkShowingNote =
    hkFiltered.length !== hkDecorated.length
      ? `<p class="muted" style="font-size:12px;margin:0 0 8px">Showing <strong>${hkFiltered.length}</strong> of <strong>${hkDecorated.length}</strong> open tasks (filters active).</p>`
      : "";
  const content = `<h2>My tasks</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — sorted by urgency. Use filters to focus your queue; claim, start cleaning, then mark ready or maintenance.</p>
${assignNotice}
${hkFilterBar}
${hkShowingNote}
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px">
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;background:#fff"><strong>Open</strong><div>${hkDecorated.length}</div></div>
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;background:#fff"><strong>Critical</strong><div>${hkCrit}</div></div>
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;background:#fff"><strong>In progress</strong><div>${hkProg}</div></div>
</div>
<table style="width:100%;border-collapse:collapse;margin-top:12px">
<thead><tr><th>Room</th><th>Priority</th><th>Status</th><th>Assignment</th><th>Actions</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">No open tasks.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderHkLayout({ title: "My tasks", active: "tasks", content }));
});

adminRouter.post("/hk/task/:taskId/assign", requireAuth, requireHousekeepingPortal, requirePermissionAny([{ module: "HOUSEKEEPING", action: "EDIT" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  const taskId = String(req.params.taskId ?? "");
  const shift = parseHousekeepingShiftInput(req.body.shift);
  const hkBody = req.body as Record<string, unknown>;
  if (!hotel || !session || session.staffId === "STAFF-SUPERADMIN") {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
    return;
  }
  const task = await prisma.housekeepingTask.findFirst({
    where: { id: taskId, hotelId: hotel.id, status: HousekeepingTaskStatus.PENDING, assignedToUserId: null }
  });
  if (!task) {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk?assign=blocked", hkBody));
    return;
  }
  const claim = await prisma.housekeepingTask.updateMany({
    where: { id: task.id, hotelId: hotel.id, status: HousekeepingTaskStatus.PENDING, assignedToUserId: null },
    data: {
      assignedToUserId: session.staffId,
      assignmentMode: HousekeepingAssignmentMode.SELF_CLAIMED,
      claimedAt: new Date(),
      manualAssignedByUserId: null
    }
  });
  if (claim.count === 0) {
    await logAudit({
      hotelId: hotel.id,
      action: "HOUSEKEEPING_TASK_ASSIGN_BLOCKED",
      entityType: "HousekeepingTask",
      entityId: task.id,
      metadata: { roomUnitId: task.roomUnitId, blockedForUserId: session.staffId }
    });
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk?assign=blocked", hkBody));
    return;
  }
  const refreshed = await prisma.housekeepingTask.findUnique({ where: { id: task.id }, select: { notes: true } });
  await prisma.housekeepingTask.update({
    where: { id: task.id },
    data: { notes: writeHousekeepingShift(refreshed?.notes, shift) }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "HOUSEKEEPING_TASK_ASSIGNED",
    entityType: "HousekeepingTask",
    entityId: task.id,
    metadata: {
      roomUnitId: task.roomUnitId,
      claimedByUserId: session.staffId,
      shift,
      claimedAt: new Date().toISOString()
    }
  });
  res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
});

adminRouter.post("/hk/task/:taskId/start-cleaning", requireAuth, requireHousekeepingPortal, requirePermissionAny([{ module: "HOUSEKEEPING", action: "EDIT" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  const taskId = String(req.params.taskId ?? "");
  const shift = parseHousekeepingShiftInput(req.body.shift);
  const hkBody = req.body as Record<string, unknown>;
  if (!hotel || !session || session.staffId === "STAFF-SUPERADMIN") {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
    return;
  }
  const task = await prisma.housekeepingTask.findFirst({
    where: {
      id: taskId,
      hotelId: hotel.id,
      status: HousekeepingTaskStatus.PENDING,
      assignedToUserId: session.staffId,
      startedAt: null
    }
  });
  if (!task) {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk?start=blocked", hkBody));
    return;
  }
  const upd = await prisma.housekeepingTask.updateMany({
    where: {
      id: task.id,
      hotelId: hotel.id,
      status: HousekeepingTaskStatus.PENDING,
      assignedToUserId: session.staffId,
      startedAt: null
    },
    data: { status: HousekeepingTaskStatus.IN_PROGRESS, startedAt: new Date() }
  });
  if (upd.count === 0) {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk?start=blocked", hkBody));
    return;
  }
  await prisma.roomUnit.update({
    where: { id: task.roomUnitId },
    data: {
      notes: writeManualRoomStatusToNotes(
        (await prisma.roomUnit.findUnique({ where: { id: task.roomUnitId }, select: { notes: true } }))?.notes,
        "CLEANING"
      )
    }
  });
  const noteRef = await prisma.housekeepingTask.findUnique({ where: { id: task.id }, select: { notes: true } });
  await prisma.housekeepingTask.update({
    where: { id: task.id },
    data: { notes: writeHousekeepingShift(noteRef?.notes, shift) }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "HOUSEKEEPING_TASK_STARTED",
    entityType: "HousekeepingTask",
    entityId: task.id,
    metadata: {
      roomUnitId: task.roomUnitId,
      claimedByUserId: session.staffId,
      startedAt: new Date().toISOString(),
      shift
    }
  });
  res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
});

adminRouter.post("/hk/task/:taskId/complete", requireAuth, requireHousekeepingPortal, requirePermissionAny([{ module: "HOUSEKEEPING", action: "EDIT" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  const taskId = String(req.params.taskId ?? "");
  const targetStatusRaw = String(req.body.targetStatus ?? "AVAILABLE").trim().toUpperCase();
  const targetStatus: RoomBoardStatus = targetStatusRaw === "MAINTENANCE" ? "MAINTENANCE" : "AVAILABLE";
  const hkBody = req.body as Record<string, unknown>;
  if (!hotel || !session) {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
    return;
  }
  const task = await prisma.housekeepingTask.findFirst({
    where: {
      id: taskId,
      hotelId: hotel.id,
      status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
    },
    include: { roomUnit: { select: { notes: true } } }
  });
  if (!task) {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
    return;
  }
  if (!task.startedAt) {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk?complete=need-start", hkBody));
    return;
  }
  if (task.assignedToUserId && session.staffId !== task.assignedToUserId) {
    res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
    return;
  }
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.roomUnit.findUnique({ where: { id: task.roomUnitId }, select: { notes: true } });
    await tx.roomUnit.update({
      where: { id: task.roomUnitId },
      data: { notes: writeManualRoomStatusToNotes(fresh?.notes, targetStatus) }
    });
    await tx.housekeepingTask.update({
      where: { id: task.id },
      data: {
        status: HousekeepingTaskStatus.COMPLETED,
        completedAt: new Date(),
        completedByUserId: session.staffId !== "STAFF-SUPERADMIN" ? session.staffId : null
      }
    });
  });
  const completed = await prisma.housekeepingTask.findUnique({
    where: { id: task.id },
    select: { startedAt: true, completedAt: true, notes: true }
  });
  const shift = parseHousekeepingShift(completed?.notes ?? task.notes) ?? deriveHousekeepingShift(new Date());
  const durationMins = housekeepingDurationMinutes(completed?.startedAt, completed?.completedAt);
  await logAudit({
    hotelId: hotel.id,
    action: "HOUSEKEEPING_TASK_COMPLETED",
    entityType: "HousekeepingTask",
    entityId: task.id,
    bookingId: task.bookingId ?? undefined,
    metadata: {
      roomUnitId: task.roomUnitId,
      completedByUserId: session.staffId,
      targetStatus,
      shift,
      durationMinutes: durationMins,
      startedAt: completed?.startedAt?.toISOString() ?? undefined,
      completedAt: completed?.completedAt?.toISOString() ?? undefined,
      portal: "hk"
    }
  });
  res.redirect(redirectPathPreservingHkListFilters("/admin/hk", hkBody));
});

adminRouter.get("/hk/room-board", requireAuth, requireHousekeepingPortal, requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const view = await loadRoomBoardViewData(req, { omitFilters: true, boardPath: "/admin/hk/room-board" });
  if (!view) {
    res.type("html").send(renderHkLayout({ title: "Room board", active: "board", content: "<h2>Room board</h2><p>No hotel data.</p>" }));
    return;
  }
  const { boardDate, prevRoomBoardHref, nextRoomBoardHref, filteredCards, statusCounts, totalRooms, updatedNotice } = view;
  const hkReturn = `/admin/hk/room-board?date=${formatDateForInput(boardDate)}`;
  const hkCards = filteredCards.filter((c) => c.unitId && !c.isUnassignedBooking);
  const roomCardsHtml = hkCards
    .map((c) => {
      const statusClass = getRoomBoardStatusClass(c.status);
      const statusForm = roomBoardStatusFormHtml({
        unitId: c.unitId!,
        boardDate,
        status: c.status,
        returnTo: hkReturn,
        variant: "hk"
      });
      return `<div class="room-board-card ${statusClass}" style="display:flex;flex-direction:column;min-width:0;max-width:100%;overflow-x:clip;align-items:stretch;border-radius:10px; padding:10px; border:2px solid currentColor; contain:layout;" data-room-unit-id="${escapeHtml(c.unitId!)}">
  <div style="font-weight:800; font-size:1rem;">${escapeHtml(c.unitName)}</div>
  <div style="margin-top:6px;"><span class="room-board-badge ${statusClass}">${escapeHtml(c.status)}</span></div>
  ${statusForm}
</div>`;
    })
    .join("");
  const content = `<h2>Room board</h2>
<p class="muted">Housekeeping view — room number and status only.</p>
${updatedNotice}
<form method="get" action="/admin/hk/room-board" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:16px">
  <a class="btn-link" href="${escapeHtml(prevRoomBoardHref)}" style="padding:8px 12px;border:1px solid #d8dee6;border-radius:8px;text-decoration:none;color:#0f172a;font-weight:700">‹</a>
  <input type="date" name="date" value="${formatDateForInput(boardDate)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" />
  <a class="btn-link" href="${escapeHtml(nextRoomBoardHref)}" style="padding:8px 12px;border:1px solid #d8dee6;border-radius:8px;text-decoration:none;color:#0f172a;font-weight:700">›</a>
  <button type="submit" style="padding:8px 14px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Go</button>
</form>
<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:10px; margin-bottom:14px;">
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;"><strong>Total</strong><div>${totalRooms}</div></div>
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;"><strong>Available</strong><div>${statusCounts.AVAILABLE}</div></div>
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;"><strong>Reserved</strong><div>${statusCounts.RESERVED}</div></div>
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;"><strong>Occupied</strong><div>${statusCounts.OCCUPIED}</div></div>
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;"><strong>Cleaning</strong><div>${statusCounts.CLEANING}</div></div>
  <div style="border:1px solid #d8dee6;border-radius:10px;padding:8px;"><strong>Maintenance</strong><div>${statusCounts.MAINTENANCE}</div></div>
</div>
<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; align-items:stretch;">
  ${roomCardsHtml || '<p class="muted">No rooms.</p>'}
</div>
<style>
  .room-board-badge { display:inline-block; padding:2px 7px; border-radius:999px; font-size:10px; font-weight:700; }
  .room-board-card { display:flex; flex-direction:column; min-width:0; max-width:100%; overflow-x:clip; align-items:stretch; }
  .room-board-card-actions { margin-top:auto; padding-top:8px; border-top:1px solid rgba(15,23,42,.12); width:100%; max-width:100%; box-sizing:border-box; flex-shrink:0; }
  .room-status-available { background:#dcfce7; color:#166534; }
  .room-status-reserved { background:#dbeafe; color:#1e40af; }
  .room-status-occupied { background:#fee2e2; color:#991b1b; }
  .room-status-cleaning { background:#fef9c3; color:#854d0e; }
  .room-status-maintenance { background:#f3e8ff; color:#6b21a8; }
</style>`;
  res.type("html").send(renderHkLayout({ title: "Room board", active: "board", content }));
});

adminRouter.get("/room-board", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const view = await loadRoomBoardViewData(req);
  if (!view) {
    res.type("html").send(renderLayout("<h2>Room Status Board</h2><p>No hotel data found.</p>", true));
    return;
  }
  const {
    boardDate,
    filterRoomTypeId,
    filterUnitId,
    filterStatus,
    prevRoomBoardHref,
    nextRoomBoardHref,
    dateStart,
    roomTypes,
    cards,
    filteredCards,
    statusCounts,
    totalRooms,
    updatedNotice,
    manualCheckInNotice,
    manualCheckOutNotice,
    invoiceSentFromCheckIn,
    invoiceErrFromCheckIn,
    printInvoiceScript
  } = view;

  const roomTypeOptions = roomTypes
    .map((rt) => `<option value="${escapeHtml(rt.id)}" ${rt.id === filterRoomTypeId ? "selected" : ""}>${escapeHtml(rt.name)}</option>`)
    .join("");
  const unitOptions = cards
    .filter((c) => c.unitId)
    .map(
      (c) =>
        `<option value="${escapeHtml(c.unitId!)}" ${c.unitId === filterUnitId ? "selected" : ""}>${escapeHtml(c.unitName)} (${escapeHtml(c.name)})</option>`
    )
    .join("");

  const roomCardsHtml = filteredCards
    .map(
      (c) => {
        const statusClass = getRoomBoardStatusClass(c.status);
        const detailUrl = c.unitId
          ? `/admin/room-board/unit/${encodeURIComponent(c.unitId)}/details?date=${formatDateForInput(boardDate)}`
          : `/admin/bookings/${encodeURIComponent(c.bookingId ?? "")}`;
        const statusForm =
          c.unitId && !c.isUnassignedBooking
            ? roomBoardStatusFormHtml({
                unitId: c.unitId,
                boardDate,
                status: c.status,
                returnTo: null,
                variant: "full"
              })
            : "";
        const stayDetailHtml =
          c.bookingId && c.checkIn && c.checkOut
            ? formatRoomBoardStayDetailHtml({
                bookingId: c.bookingId,
                adults: c.adults,
                children: c.children,
                boardDate: dateStart,
                checkIn: c.checkIn,
                checkOut: c.checkOut,
                bookingNights: c.bookingNights
              })
            : "";
        const unitAttr =
          c.unitId && !c.isUnassignedBooking ? ` data-room-unit-id="${escapeHtml(c.unitId)}"` : "";
        return `<div class="room-board-card ${statusClass}" style="display:flex;flex-direction:column;min-width:0;max-width:100%;overflow-x:clip;align-items:stretch;border-radius:10px; padding:8px; border:2px solid currentColor; min-height:72px; contain:layout;"${unitAttr}>
  <div style="font-weight:700; font-size:0.92rem; margin-bottom:2px;">${escapeHtml(c.unitName)}${c.isUnassignedBooking ? ' <span class="badge pending" style="font-size:10px">no unit</span>' : ""}</div>
  <div style="font-size:11px; color:var(--muted); margin-bottom:4px;">${escapeHtml(c.name)}</div>
  <div style="margin-bottom:4px;"><span class="room-board-badge ${statusClass}">${escapeHtml(c.status)}</span></div>
  ${c.guestName ? `<div style="font-size:11px; margin-top:4px;">Guest: ${escapeHtml(c.guestName)}</div>` : ""}
  ${stayDetailHtml}
  ${c.checkIn && c.checkOut ? `<div style="font-size:11px; color:var(--muted);">${formatDateForInput(c.checkIn)} – ${formatDateForInput(c.checkOut)}</div>` : ""}
  <div class="room-board-card-meta-links" style="margin-top:6px; display:flex; gap:6px; align-items:center; flex-wrap:wrap">
    <a class="inline-link" href="${detailUrl}">${c.isUnassignedBooking ? "booking" : "details"}</a>
  </div>
  ${statusForm}
</div>`;
      }
    )
    .join("");

  const content = `
<h2>Room Status Board</h2>
<p class="muted">Front-desk view of room status for the selected date. Click a room for details.</p>
${updatedNotice}${manualCheckInNotice}${manualCheckOutNotice}${invoiceSentFromCheckIn}${invoiceErrFromCheckIn}${printInvoiceScript}
<div class="actions" style="margin-bottom:14px; display:flex; flex-wrap:wrap; gap:8px; align-items:center">
  <a class="btn-link primary" href="/admin/calendar?start=${formatDateForInput(boardDate)}&days=7">Calendar</a>
  <a class="btn-link" href="/admin/front-desk/check-in?date=${formatDateForInput(boardDate)}" target="_blank" rel="noopener noreferrer">Manual check-in</a>
  <a class="btn-link" href="/admin/bookings/search" target="_blank" rel="noopener noreferrer">Find booking</a>
  <a class="btn-link" href="/admin/front-desk/check-out?date=${formatDateForInput(boardDate)}" target="_blank" rel="noopener noreferrer">Manual check-out</a>
</div>
<form method="get" action="/admin/room-board" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:16px">
  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
    <span style="font-size:14px; font-weight:600; color:var(--muted)">Date</span>
    <a class="room-board-date-arrow" href="${escapeHtml(prevRoomBoardHref)}" title="Previous day" aria-label="Previous day">&#8249;</a>
    <input type="date" name="date" value="${formatDateForInput(boardDate)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    <a class="room-board-date-arrow" href="${escapeHtml(nextRoomBoardHref)}" title="Next day" aria-label="Next day">&#8250;</a>
  </div>
  <label>Room type <select name="roomTypeId" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
    <option value="">All</option>${roomTypeOptions}
  </select></label>
  <label>Room unit <select name="unitId" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
    <option value="">All</option>${unitOptions}
  </select></label>
  <label>Status <select name="status" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
    <option value="" ${filterStatus === "" ? "selected" : ""}>All</option>
    <option value="AVAILABLE" ${filterStatus === "AVAILABLE" ? "selected" : ""}>Available</option>
    <option value="RESERVED" ${filterStatus === "RESERVED" ? "selected" : ""}>Reserved</option>
    <option value="OCCUPIED" ${filterStatus === "OCCUPIED" ? "selected" : ""}>Occupied</option>
    <option value="CLEANING" ${filterStatus === "CLEANING" ? "selected" : ""}>Cleaning</option>
    <option value="MAINTENANCE" ${filterStatus === "MAINTENANCE" ? "selected" : ""}>Maintenance</option>
  </select></label>
  <button type="submit" style="padding:8px 14px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
</form>
<div class="room-board-summary" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:10px; margin-bottom:18px;">
  <article class="stat" style="border-left-color:#64748b"><h3>Total rooms</h3><p>${totalRooms}</p></article>
  <article class="stat" style="border-left-color:#22c55e"><h3>Available</h3><p>${statusCounts.AVAILABLE}</p></article>
  <article class="stat" style="border-left-color:#3b82f6"><h3>Reserved</h3><p>${statusCounts.RESERVED}</p></article>
  <article class="stat" style="border-left-color:#ef4444"><h3>Occupied</h3><p>${statusCounts.OCCUPIED}</p></article>
  <article class="stat" style="border-left-color:#eab308"><h3>Cleaning</h3><p>${statusCounts.CLEANING}</p></article>
  <article class="stat" style="border-left-color:#a855f7"><h3>Maintenance</h3><p>${statusCounts.MAINTENANCE}</p></article>
</div>
<p class="muted" style="margin-bottom:8px">Legend: <span class="room-board-badge room-status-available">Available</span> <span class="room-board-badge room-status-reserved">Reserved</span> <span class="room-board-badge room-status-occupied">Occupied</span> <span class="room-board-badge room-status-cleaning">Cleaning</span> <span class="room-board-badge room-status-maintenance">Maintenance</span></p>
<div class="room-board-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:8px; align-items:stretch;">
  ${roomCardsHtml || '<p class="muted">No rooms match the filter.</p>'}
</div>
<style>
  .room-board-date-arrow {
    display:inline-flex;
    align-items:center;
    justify-content:center;
    min-width:36px;
    min-height:36px;
    border:1px solid #d8dee6;
    border-radius:8px;
    background:#f8fafc;
    color:#0f172a;
    font-size:1.35rem;
    font-weight:700;
    text-decoration:none;
    line-height:1;
    flex-shrink:0;
  }
  .room-board-date-arrow:hover { background:#e2e8f0; color:#075e54; }
  .room-board-grid { align-items: stretch; }
  .room-board-card { display:flex; flex-direction:column; min-width:0; max-width:100%; overflow-x:clip; align-items:stretch; }
  .room-board-card:hover { opacity:0.92; }
  .room-board-card-actions { margin-top:auto; padding-top:8px; border-top:1px solid rgba(15,23,42,.12); width:100%; max-width:100%; box-sizing:border-box; flex-shrink:0; }
  .room-board-badge { display:inline-block; padding:2px 7px; border-radius:999px; font-size:10px; font-weight:700; }
  .room-status-available { background:#dcfce7; color:#166534; border-color:#22c55e; }
  .room-status-reserved { background:#dbeafe; color:#1e40af; border-color:#3b82f6; }
  .room-status-occupied { background:#fee2e2; color:#991b1b; border-color:#ef4444; }
  .room-status-cleaning { background:#fef9c3; color:#854d0e; border-color:#eab308; }
  .room-status-maintenance { background:#f3e8ff; color:#6b21a8; border-color:#a855f7; }
  @media (max-width: 900px) { .room-board-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); } }
  @media (max-width: 640px) {
    .room-board-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap:6px; }
    .room-board-summary { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 420px) {
    .room-board-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .room-board-card { padding:7px !important; }
  }
</style>`;

  res.type("html").send(renderLayout(content, true));
});

async function respondManualCheckInValidationError(
  res: Response,
  req: Request,
  hotel: { id: string; displayName: string; currency: string },
  errorMsg: string
): Promise<void> {
  const form = manualCheckInFormFromBody(req);
  const defaultDay = form.checkIn.trim()
    ? startOfDay(parseDateInput(form.checkIn, startOfDay(new Date())))
    : startOfDay(new Date());
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { name: "asc" },
    include: { roomUnits: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }
  });
  const checkIn = form.checkIn.trim()
    ? startOfDay(parseDateInput(form.checkIn, startOfDay(new Date())))
    : startOfDay(new Date());
  const checkOut = form.checkOut.trim()
    ? startOfDay(parseDateInput(form.checkOut, addDays(checkIn, 1)))
    : addDays(checkIn, 1);
  const adultsParsed = parseInt(String(form.adults ?? "2"), 10);
  const adultsNum = Number.isFinite(adultsParsed) ? Math.min(12, Math.max(1, adultsParsed)) : 2;
  const childrenParsed = parseInt(String(form.children ?? "0"), 10);
  const childrenNum = Number.isFinite(childrenParsed) ? Math.min(8, Math.max(0, childrenParsed)) : 0;
  const roomSelection = await computeManualCheckInRoomSelection({
    hotelId: hotel.id,
    checkIn,
    checkOut,
    adults: adultsNum,
    children: childrenNum,
    roomTypes
  });
  const selectedRoomTypeId = resolveRoomTypeIdForUnit(roomTypes, form.roomUnitId || null);
  const fdPricing = loadFrontDeskPricing();
  const content = buildManualCheckInPageHtml(
    { formatMoney, formatDateForInput, parseDateInput, addDays },
    hotel,
    roomTypes,
    fdPricing,
    { defaultDay, errorMsg, form, roomSelection, selectedRoomTypeId }
  );
  res.status(200).type("html").send(renderLayout(content, true));
}

adminRouter.get("/front-desk/check-in", requirePermission("BOOKINGS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Manual check-in</h2><p>No hotel data found.</p>", true));
    return;
  }
  const defaultDay = parseDateInput(req.query.date, startOfDay(new Date()));
  const errRaw = typeof req.query.error === "string" ? req.query.error : "";
  const errorMsg = errRaw ? errRaw.slice(0, 500) : "";
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { name: "asc" },
    include: { roomUnits: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }
  });
  const checkIn0 = startOfDay(defaultDay);
  const checkOut0 = addDays(checkIn0, 1);
  const roomSelection = await computeManualCheckInRoomSelection({
    hotelId: hotel.id,
    checkIn: checkIn0,
    checkOut: checkOut0,
    adults: 2,
    children: 0,
    roomTypes
  });
  const fdPricing = loadFrontDeskPricing();
  const content = buildManualCheckInPageHtml(
    { formatMoney, formatDateForInput, parseDateInput, addDays },
    hotel,
    roomTypes,
    fdPricing,
    { defaultDay, errorMsg: errorMsg || undefined, roomSelection }
  );
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/front-desk/check-in/room-options", requirePermission("BOOKINGS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true }
  });
  if (!hotel) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }
  const checkIn = startOfDay(parseDateInput(req.query.checkIn, startOfDay(new Date())));
  const checkOut = startOfDay(parseDateInput(req.query.checkOut, addDays(checkIn, 1)));
  const adults = clamp(parseIntegerInput(req.query.adults, 2), 1, 12);
  const children = clamp(parseIntegerInput(req.query.children, 0), 0, 8);
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { name: "asc" },
    include: { roomUnits: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }
  });
  const roomSelection = await computeManualCheckInRoomSelection({
    hotelId: hotel.id,
    checkIn,
    checkOut,
    adults,
    children,
    roomTypes
  });
  res.json(roomSelection);
});

adminRouter.post("/front-desk/check-in", requirePermission("BOOKINGS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.redirect("/admin/room-board");
    return;
  }
  const guestFullName = String(req.body.guestFullName ?? "").trim();
  const guestPhoneRaw = String(req.body.guestPhone ?? "").trim();
  const guestEmail = String(req.body.guestEmail ?? "").trim();
  const nationality = String(req.body.nationality ?? "").trim();
  const idNumber = String(req.body.idNumber ?? "").trim();
  const internalNotes = String(req.body.internalNotes ?? "").trim();
  const roomUnitId = String(req.body.roomUnitId ?? "").trim();
  const returnBoardDate = String(req.body.returnBoardDate ?? "").trim();
  const checkIn = startOfDay(parseDateInput(req.body.checkIn, startOfDay(new Date())));
  const checkOut = startOfDay(parseDateInput(req.body.checkOut, addDays(checkIn, 1)));
  const adults = clamp(parseIntegerInput(req.body.adults, 2), 1, 12);
  const children = clamp(parseIntegerInput(req.body.children, 0), 0, 8);
  const mealPlanRaw = String(req.body.mealPlan ?? "NONE").toUpperCase();
  const mealPlan = mealPlanRaw === "BREAKFAST" || mealPlanRaw === "HALF_BOARD" ? mealPlanRaw : "NONE";
  const paymentStatusRaw = String(req.body.paymentStatus ?? "PENDING").toUpperCase();
  const manualPaymentMap: Record<string, PaymentStatus> = {
    PENDING: PaymentStatus.PENDING,
    REQUIRES_ACTION: PaymentStatus.REQUIRES_ACTION,
    LPO: PaymentStatus.LPO,
    FRIENDS_TRANSFER: PaymentStatus.FRIENDS_TRANSFER,
    SUCCEEDED: PaymentStatus.SUCCEEDED,
    FAILED: PaymentStatus.FAILED,
    REFUNDED: PaymentStatus.REFUNDED
  };
  const paymentStatus = manualPaymentMap[paymentStatusRaw] ?? PaymentStatus.PENDING;
  const paymentMethod = String(req.body.paymentMethod ?? "").trim();
  const extraIdsRaw = req.body.extraIds;
  const extraIdsList = Array.isArray(extraIdsRaw) ? extraIdsRaw.map(String) : extraIdsRaw ? [String(extraIdsRaw)] : [];
  const allowedExtras = new Set(loadFrontDeskPricing().extras.map((x) => x.id));
  const selectedExtraIds = extraIdsList.filter((id) => allowedExtras.has(id));
  const extraHoursById: Record<string, number> = {};
  for (const ex of loadFrontDeskPricing().extras) {
    if (!ex.applyPerHour || !selectedExtraIds.includes(ex.id)) continue;
    const raw = req.body[`extraHour_${ex.id}`];
    const h = parseFloat(typeof raw === "string" || typeof raw === "number" ? String(raw) : "1");
    extraHoursById[ex.id] = Number.isFinite(h) && h >= 0.25 ? Math.min(168, h) : 1;
  }
  const adjustmentAmount = parseNumberInput(req.body.adjustmentAmount, 0);
  const sendInvoiceWhatsApp = req.body.sendInvoiceWhatsApp === "1" || req.body.sendInvoiceWhatsApp === "on";
  const openInvoicePrint = req.body.openInvoicePrint === "1" || req.body.openInvoicePrint === "on";

  const fail = async (msg: string) => {
    await respondManualCheckInValidationError(res, req, hotel, msg);
  };

  if (!guestFullName) {
    await fail("Guest full name is required.");
    return;
  }
  const phoneE164 = normalizeGuestPhoneE164(guestPhoneRaw);
  if (!phoneE164 || phoneE164.length < 8) {
    await fail("Enter a valid phone number.");
    return;
  }
  if (checkOut.getTime() <= checkIn.getTime()) {
    await fail("Check-out must be after check-in.");
    return;
  }
  const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86400000);
  if (nights < 1) {
    await fail("Stay must be at least one night.");
    return;
  }
  if (!roomUnitId) {
    await fail("Select a room unit.");
    return;
  }

  const unit = await prisma.roomUnit.findFirst({
    where: { id: roomUnitId, hotelId: hotel.id, isActive: true },
    include: { roomType: true }
  });
  if (!unit) {
    await fail("Room unit not found.");
    return;
  }
  const rt = unit.roomType;
  if (!rt.isActive) {
    await fail("Room type is inactive.");
    return;
  }
  const occ = manualCheckInFitsRoomType(rt, adults, children);
  if (!occ.ok) {
    await fail(occ.message);
    return;
  }

  const priced = computeManualCheckInTotal({
    baseNightlyRate: rt.baseNightlyRate,
    nights,
    mealPlan: mealPlan as MealPlanCode,
    adults,
    children,
    selectedExtraIds,
    extraHoursById
  });
  const totalAmount = Number((priced.total + adjustmentAmount).toFixed(2));
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    await fail("Total amount must be greater than zero. Check dates, room, meal plan, extras, and adjustment.");
    return;
  }

  const bookingChannelRaw = String(req.body.bookingChannel ?? "DIRECT").toUpperCase();
  const bookingSourceChannel: ChannelProvider =
    bookingChannelRaw === "PHONE"
      ? ChannelProvider.PHONE
      : bookingChannelRaw === "CORPORATE"
        ? ChannelProvider.CORPORATE
        : bookingChannelRaw === "REFERRAL"
          ? ChannelProvider.REFERRAL
          : ChannelProvider.DIRECT;

  try {
    const bookingId = buildBookingId();
    await prisma.$transaction(async (tx) => {
      const overlap = await tx.booking.count({
        where: {
          hotelId: hotel.id,
          roomUnitId: unit.id,
          status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
          checkIn: { lt: checkOut },
          checkOut: { gt: checkIn }
        }
      });
      if (overlap > 0) throw new Error("This room is already booked for overlapping dates.");

      await assertInventoryCanReserveTx(tx, {
        hotelId: hotel.id,
        roomTypeId: rt.id,
        checkIn,
        checkOut,
        rooms: 1
      });

      const guest = await tx.guest.upsert({
        where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164 } },
        create: {
          hotelId: hotel.id,
          phoneE164,
          fullName: guestFullName,
          email: guestEmail || null,
          ...(nationality ? { nationality } : {})
        },
        update: {
          fullName: guestFullName,
          ...(guestEmail ? { email: guestEmail } : {}),
          ...(nationality ? { nationality } : {})
        }
      });

      const referenceCode = await allocateBookingReferenceCode(tx, {
        hotelId: hotel.id,
        source: bookingSourceChannel,
        refDate: new Date()
      });

      await tx.booking.create({
        data: {
          id: bookingId,
          hotelId: hotel.id,
          propertyId: rt.propertyId,
          roomTypeId: rt.id,
          roomUnitId: unit.id,
          guestId: guest.id,
          conversationId: null,
          checkIn,
          checkOut,
          nights,
          adults,
          children,
          totalAmount,
          currency: hotel.currency,
          status: BookingStatus.CONFIRMED,
          source: bookingSourceChannel,
          referenceCode,
          paymentStatus
        }
      });

      await recordBookingStatusChange(tx, {
        hotelId: hotel.id,
        bookingId,
        fromStatus: null,
        toStatus: BookingStatus.CONFIRMED,
        source: "MANUAL_CHECK_IN"
      });

      await ensureActiveFolio(tx, {
        hotelId: hotel.id,
        bookingId,
        guestId: guest.id,
        roomUnitId: unit.id,
        currency: hotel.currency,
        staffId: null
      });

      await reserveInventoryForBooking({
        tx,
        hotelId: hotel.id,
        roomTypeId: rt.id,
        propertyId: rt.propertyId,
        checkIn,
        checkOut,
        rooms: 1
      });
    });

    const segGuestId = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { guestId: true }
    });
    if (segGuestId) {
      await refreshGuestSegmentTagsForGuest(segGuestId.guestId).catch(() => undefined);
    }

    const dateKey = formatDateForInput(checkIn);
    await logAudit({
      hotelId: hotel.id,
      action: "MANUAL_FRONT_DESK_CHECK_IN",
      entityType: "Booking",
      entityId: bookingId,
      bookingId,
      metadata: {
        roomUnitId: unit.id,
        guestPhone: phoneE164,
        checkIn: dateKey,
        checkOut: formatDateForInput(checkOut),
        nights,
        totalAmount,
        paymentStatus: paymentStatusRaw,
        mealPlan,
        rackNightlyRate: rt.baseNightlyRate,
        roomSubtotal: priced.roomSubtotal,
        mealSubtotal: priced.mealSubtotal,
        extrasSubtotal: priced.extrasSubtotal,
        adjustmentAmount,
        extraIds: selectedExtraIds,
        extraHoursById
      }
    });

    await logAudit({
      hotelId: hotel.id,
      action: "ROOM_UNIT_GUEST_DETAILS",
      entityType: "RoomUnit",
      entityId: unit.id,
      metadata: {
        date: dateKey,
        fullName: guestFullName,
        phone: phoneE164,
        email: guestEmail,
        nationality: nationality || undefined,
        idNumber: idNumber || undefined,
        notes: internalNotes,
        adults,
        children,
        mealPlan,
        idCardPath: "",
        paymentMethod,
        paymentAmount: paymentStatus === PaymentStatus.SUCCEEDED ? totalAmount : null,
        balanceAmount: paymentStatus === PaymentStatus.SUCCEEDED ? 0 : totalAmount
      }
    });

    let invoiceSendError: string | undefined;
    if (sendInvoiceWhatsApp) {
      const inv = await sendInvoicePdfForBooking({
        hotelId: hotel.id,
        bookingId,
        trigger: "MANUAL_CHECK_IN_FORM",
        force: true
      });
      if (inv.error) invoiceSendError = inv.error;
    }

    const boardDate = formatDateForInput(checkIn);
    const qs = new URLSearchParams();
    qs.set("date", boardDate);
    qs.set("manualCheckIn", "1");
    if (sendInvoiceWhatsApp) {
      if (invoiceSendError) qs.set("invoiceError", invoiceSendError.slice(0, 500));
      else qs.set("invoiceSent", "1");
    }
    if (openInvoicePrint) qs.set("printBookingId", bookingId);
    res.redirect(`/admin/room-board?${qs.toString()}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Check-in could not be completed.";
    await fail(msg);
  }
});

adminRouter.get("/front-desk/check-out", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Manual check-out</h2><p>No hotel data found.</p>", true));
    return;
  }
  const boardDay = parseDateInput(req.query.date, startOfDay(new Date()));
  const boardDateStr = formatDateForInput(boardDay);
  const errRaw = typeof req.query.error === "string" ? req.query.error : "";
  const errorMsg = errRaw ? errRaw.slice(0, 500) : "";
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { name: "asc" },
    include: { roomUnits: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }
  });
  const unitOptions = roomTypes
    .flatMap((rt) => rt.roomUnits.map((u) => ({ rt, u })))
    .map(({ rt, u }) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)} — ${escapeHtml(rt.name)}</option>`)
    .join("");

  const content = `
<h2>Manual check-out</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — Record departure: shortens an active stay (releases future nights in inventory), updates the room charge (prorated minus any staff discount), and marks the room for housekeeping. The action is logged with your staff account.</p>
${errorMsg ? `<p class="badge" style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:8px 12px">${escapeHtml(errorMsg)}</p>` : ""}
<form method="post" action="/admin/front-desk/check-out" style="max-width:640px;display:grid;gap:12px">
  <label>Room unit <span style="color:#b91c1c">*</span>
    <select name="roomUnitId" required style="width:100%;padding:8px;border:1px solid #d8dee6;border-radius:8px">
      <option value="">Select…</option>${unitOptions}
    </select>
  </label>
  <label>Departure date (checkout day) <span style="color:#b91c1c">*</span>
    <input type="date" name="departureDate" value="${escapeHtml(boardDateStr)}" required style="width:100%;padding:8px;border:1px solid #d8dee6;border-radius:8px" />
  </label>
  <label>Departure time (optional)
    <input type="time" name="departureTime" style="width:100%;max-width:200px;padding:8px;border:1px solid #d8dee6;border-radius:8px" />
  </label>
  <p class="muted" style="margin:0;font-size:12px">You can check out on the <strong>same calendar day as check-in</strong> (0 nights stay). Pick that day above and add the time if useful. For early checkout before the scheduled end date, room revenue is prorated by nights; then apply an optional discount (e.g. short stay).</p>
  <label>Room discount (${escapeHtml(hotel.currency)}) — optional
    <input type="number" name="discountAmount" min="0" step="0.001" placeholder="0" style="width:100%;max-width:200px;padding:8px;border:1px solid #d8dee6;border-radius:8px" />
  </label>
  <p class="muted" style="margin:0;font-size:12px">Applied after prorating the accommodation total to actual nights (cannot exceed the prorated room amount).</p>
  <label>Reason / notes (optional)
    <textarea name="departureReason" rows="3" maxlength="2000" placeholder="e.g. Guest left after a few hours, early flight…" style="width:100%;padding:8px;border:1px solid #d8dee6;border-radius:8px;resize:vertical"></textarea>
  </label>
  <div class="actions" style="display:flex;gap:10px;flex-wrap:wrap">
    <button type="submit" style="padding:10px 18px;border:0;border-radius:10px;background:#128c7e;color:#fff;font-weight:700">Confirm check-out</button>
    <a class="btn-link" href="/admin/room-board?date=${escapeHtml(boardDateStr)}">Back to room board</a>
  </div>
</form>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/front-desk/check-out", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true }
  });
  if (!hotel) {
    res.redirect("/admin/room-board");
    return;
  }
  const roomUnitId = String(req.body.roomUnitId ?? "").trim();
  const departureDate = startOfDay(parseDateInput(req.body.departureDate, startOfDay(new Date())));
  const departureTimeRaw = String(req.body.departureTime ?? "").trim();
  const departureReason = String(req.body.departureReason ?? "").trim().slice(0, 2000);
  const discountParsed = parseFloat(String(req.body.discountAmount ?? ""));
  const discountRequested = Number.isFinite(discountParsed) && discountParsed > 0 ? discountParsed : 0;

  const errRedirect = (msg: string) => {
    res.redirect(`/admin/front-desk/check-out?date=${encodeURIComponent(formatDateForInput(departureDate))}&error=${encodeURIComponent(msg)}`);
  };

  if (!roomUnitId) {
    errRedirect("Select a room unit.");
    return;
  }

  const unit = await prisma.roomUnit.findFirst({
    where: { id: roomUnitId, hotelId: hotel.id },
    select: { id: true, notes: true }
  });
  if (!unit) {
    errRedirect("Room not found.");
    return;
  }

  const staffSession = getSession(req);
  const executedByEmail = staffSession?.email ?? "unknown";

  try {
    let auditBookingId: string | undefined;
    let hkFromCheckout: { created: boolean; taskId: string | null } = { created: false, taskId: null };
    let auditMetadata: Record<string, unknown> = {
      roomUnitId: unit.id,
      departureDate: formatDateForInput(departureDate),
      departureTime: departureTimeRaw || undefined,
      departureReason: departureReason || undefined,
      discountRequested,
      executedByEmail
    };

    await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: {
          hotelId: hotel.id,
          roomUnitId: unit.id,
          status: BookingStatus.CONFIRMED,
          checkIn: { lte: departureDate },
          checkOut: { gt: departureDate }
        },
        orderBy: { checkIn: "asc" }
      });

      if (booking) {
        const checkInDay = startOfDay(booking.checkIn);
        const oldCheckOut = startOfDay(booking.checkOut);
        const newCheckOut = departureDate;
        if (newCheckOut.getTime() < checkInDay.getTime()) {
          throw new Error("Departure cannot be before check-in.");
        }
        if (newCheckOut.getTime() >= oldCheckOut.getTime()) {
          throw new Error("Departure must be before the scheduled checkout date (pick an earlier day).");
        }
        const priorNights = Math.round((oldCheckOut.getTime() - checkInDay.getTime()) / 86400000);
        if (priorNights < 1) {
          throw new Error("Could not determine stay length from this booking.");
        }
        const newNights = Math.round((newCheckOut.getTime() - checkInDay.getTime()) / 86400000);
        if (newNights < 0) throw new Error("Invalid stay length after checkout.");

        const proRated = Math.round(((booking.totalAmount * newNights) / priorNights) * 1000) / 1000;
        const cappedDiscount = Math.min(discountRequested, proRated);
        const newTotal = Math.max(0, Math.round((proRated - cappedDiscount) * 1000) / 1000);

        await tx.booking.update({
          where: { id: booking.id },
          data: {
            checkOut: newCheckOut,
            nights: newNights,
            totalAmount: newTotal
          }
        });

        await releaseInventoryForStayRange({
          tx,
          roomTypeId: booking.roomTypeId,
          start: newCheckOut,
          endExclusive: oldCheckOut,
          rooms: 1
        });

        auditBookingId = booking.id;
        auditMetadata = {
          ...auditMetadata,
          bookingId: booking.id,
          previousCheckOut: formatDateForInput(oldCheckOut),
          newCheckOut: formatDateForInput(newCheckOut),
          previousNights: priorNights,
          newNights,
          previousTotalAmount: booking.totalAmount,
          proRatedRoomTotal: proRated,
          discountApplied: cappedDiscount,
          newTotalAmount: newTotal
        };
      } else {
        auditMetadata = {
          ...auditMetadata,
          noActiveBooking: true
        };
      }

      const fresh = await tx.roomUnit.findUnique({ where: { id: unit.id }, select: { notes: true } });
      await tx.roomUnit.update({
        where: { id: unit.id },
        data: { notes: writeManualRoomStatusToNotes(fresh?.notes, "CLEANING") }
      });
      hkFromCheckout = await ensureHousekeepingTaskForCleaningTx(tx, {
        hotelId: hotel.id,
        roomUnitId: unit.id,
        source: HousekeepingTaskSource.CHECKOUT,
        bookingId: auditBookingId ?? null,
        createdByUserId: staffSession?.staffId ?? null,
        notes: "Guest departure (manual check-out)"
      });
    });

    await logAudit({
      hotelId: hotel.id,
      action: "MANUAL_FRONT_DESK_CHECK_OUT",
      entityType: auditBookingId ? "Booking" : "RoomUnit",
      entityId: auditBookingId ?? unit.id,
      metadata: auditMetadata
    });

    if (hkFromCheckout.created && hkFromCheckout.taskId) {
      const unitLabel = await prisma.roomUnit.findUnique({
        where: { id: unit.id },
        select: { name: true, roomType: { select: { name: true } } }
      });
      const label = unitLabel ? `${unitLabel.name} (${unitLabel.roomType.name})` : unit.id;
      await notifyHousekeepingStaff({
        hotelId: hotel.id,
        type: "HK_TASK_NEW",
        title: "Checkout — room needs cleaning",
        body: `${label} — task created after manual check-out.`,
        payloadJson: JSON.stringify({ taskId: hkFromCheckout.taskId, roomUnitId: unit.id, bookingId: auditBookingId })
      });
    }

    res.redirect(`/admin/room-board?date=${encodeURIComponent(formatDateForInput(departureDate))}&manualCheckOut=1`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Check-out could not be completed.";
    errRedirect(msg);
  }
});

adminRouter.get("/shifts", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Shifts</h2><p>No hotel data found.</p>", true));
    return;
  }

  const dateFilter = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : "";
  const slotRaw = typeof req.query.slot === "string" ? req.query.slot.toUpperCase() : "";
  const slotFilter = ["MORNING", "EVENING", "NIGHT", "CUSTOM"].includes(slotRaw) ? slotRaw : "";

  const where: { hotelId: string; businessDate?: string; shiftSlot?: string } = { hotelId: hotel.id };
  if (dateFilter) where.businessDate = dateFilter;
  if (slotFilter) where.shiftSlot = slotFilter;

  const rows = await prisma.frontDeskShift.findMany({
    where,
    orderBy: { closedAt: "desc" },
    take: 250,
    include: { closedBy: { select: { fullName: true, email: true } } }
  });

  const tableRows = rows
    .map((s) => {
      const reportHref = `/admin/shift-report/${encodeURIComponent(s.id)}`;
      const nextHandoverHref = `/admin/shift-close?prior_shift_id=${encodeURIComponent(s.id)}&opening_cash_source=CARRY_FROM_PRIOR&business_date=${encodeURIComponent(s.businessDate)}&suggested_opening=${encodeURIComponent(String(s.closingCashActual))}`;
      const slotShow = s.shiftLabel?.trim()
        ? `${escapeHtml(s.shiftSlot)} (${escapeHtml(s.shiftLabel.trim())})`
        : escapeHtml(s.shiftSlot);
      return `<tr>
  <td>${slotShow}</td>
  <td>${escapeHtml(s.businessDate)}</td>
  <td>${escapeHtml(formatDateTimeLocalForInput(s.shiftStart))} → ${escapeHtml(formatDateTimeLocalForInput(s.shiftEnd))}</td>
  <td>${escapeHtml(s.closedAt.toISOString().slice(0, 16).replace("T", " "))}</td>
  <td>${s.closedBy ? escapeHtml(s.closedBy.fullName) : "—"}</td>
  <td>${s.expectedClosingCash.toFixed(3)}</td>
  <td>${s.closingCashActual.toFixed(3)}</td>
  <td style="font-weight:700;color:${s.cashVariance === 0 ? "#166534" : "#991b1b"}">${s.cashVariance.toFixed(3)}</td>
  <td><a href="${reportHref}">Print report</a> · <a href="${nextHandoverHref}">Next shift (carry)</a></td>
</tr>`;
    })
    .join("");

  const slotSel = (val: string, label: string) =>
    `<option value="${escapeHtml(val)}" ${slotFilter === val ? "selected" : ""}>${escapeHtml(label)}</option>`;

  const filterForm = `
<form method="get" action="/admin/shifts" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:14px 0;padding:14px;border:1px solid #d8dee6;border-radius:12px">
  <label>Business date <input type="date" name="date" value="${escapeHtml(dateFilter)}" style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px" /></label>
  <label>Slot
    <select name="slot" style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px;min-width:140px">
      ${slotSel("", "All slots")}
      ${slotSel("MORNING", "Morning")}
      ${slotSel("EVENING", "Evening")}
      ${slotSel("NIGHT", "Night")}
      ${slotSel("CUSTOM", "Custom")}
    </select>
  </label>
  <button type="submit" class="btn-link primary" style="border:0;padding:10px 16px">Apply filters</button>
  <a href="/admin/shifts" class="muted" style="align-self:center">Reset</a>
</form>`;

  const content = `
<h2>Front desk shifts</h2>
<p class="muted">${escapeHtml(hotel.displayName)} · ${escapeHtml(hotel.currency)} · Closed shifts only (locked). Use <a href="/admin/shift-close">Shift close</a> to close the current shift.</p>
${filterForm}
<table>
  <thead><tr><th>Slot</th><th>Business date</th><th>Window</th><th>Closed (UTC)</th><th>By</th><th>Expected</th><th>Counted</th><th>Var</th><th>Actions</th></tr></thead>
  <tbody>${tableRows.length ? tableRows : `<tr><td colspan="9" class="muted">No shifts match.</td></tr>`}</tbody>
</table>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/shift-report/:id", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.status(404).type("html").send(renderLayout("<h2>Shift report</h2><p>No hotel data found.</p>", true));
    return;
  }

  const shift = await prisma.frontDeskShift.findFirst({
    where: { id: req.params.id, hotelId: hotel.id },
    include: { closedBy: { select: { fullName: true } } }
  });
  if (!shift || !shift.locked) {
    res.status(404).type("html").send(renderLayout("<h2>Shift report</h2><p>Shift not found or not locked.</p>", true));
    return;
  }

  const snap = parseShiftCloseSnapshot(shift.snapshotJson);
  const html = renderShiftReportHtml({
    hotelName: hotel.displayName,
    currency: shift.currency || hotel.currency,
    shiftId: shift.id,
    closedAtIso: shift.closedAt.toISOString(),
    shiftStartIso: shift.shiftStart.toISOString(),
    shiftEndIso: shift.shiftEnd.toISOString(),
    closedByName: shift.closedBy?.fullName ?? null,
    shiftSlot: shift.shiftSlot,
    shiftLabel: shift.shiftLabel,
    businessDate: shift.businessDate,
    openingCashSource: shift.openingCashSource,
    priorShiftId: shift.priorShiftId,
    handoverNote: shift.handoverNote,
    snapshot: snap
  });

  res.type("html").send(html);
});

adminRouter.get("/shift-close", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Shift close</h2><p>No hotel data found.</p>", true));
    return;
  }

  const flashOk = req.query.closed === "1" ? '<p class="badge ok" style="margin-bottom:12px">Shift closed and locked.</p>' : "";
  const reportHint =
    typeof req.query.report_id === "string" && req.query.report_id.trim()
      ? `<p class="badge ok" style="margin-bottom:12px"><a href="/admin/shift-report/${escapeHtml(req.query.report_id.trim())}" style="color:inherit;font-weight:700">Open printable shift report</a></p>`
      : "";
  const errFlash =
    typeof req.query.err === "string" && req.query.err.trim()
      ? `<p class="badge alert" style="margin-bottom:12px">${escapeHtml(req.query.err)}</p>`
      : "";

  const now = new Date();
  const defaultEnd = now;
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
  if (defaultStart.getTime() > defaultEnd.getTime()) {
    defaultStart.setDate(defaultStart.getDate() - 1);
  }

  const shiftStart = parseDateTimeLocalInput(req.query.shift_start, defaultStart);
  const shiftEnd = parseDateTimeLocalInput(req.query.shift_end, defaultEnd);

  const qSlotRaw = typeof req.query.shift_slot === "string" ? req.query.shift_slot.toUpperCase() : "";
  const shiftSlot = ["MORNING", "EVENING", "NIGHT", "CUSTOM"].includes(qSlotRaw) ? qSlotRaw : "CUSTOM";

  const bdRaw = typeof req.query.business_date === "string" ? req.query.business_date.trim() : "";
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(bdRaw) ? bdRaw : formatBusinessDateLocal(shiftStart);

  const priorIdQ = typeof req.query.prior_shift_id === "string" ? req.query.prior_shift_id.trim() : "";
  let priorShiftPreview: {
    id: string;
    closingCashActual: number;
    businessDate: string;
    shiftSlot: string;
    closedAt: Date;
  } | null = null;
  if (priorIdQ) {
    const p = await prisma.frontDeskShift.findFirst({
      where: { id: priorIdQ, hotelId: hotel.id, locked: true, status: "CLOSED" },
      select: { id: true, closingCashActual: true, businessDate: true, shiftSlot: true, closedAt: true }
    });
    if (p) priorShiftPreview = p;
  }

  const ocsQ = typeof req.query.opening_cash_source === "string" ? req.query.opening_cash_source.toUpperCase() : "MANUAL";
  const openingCashSourcePreview = ocsQ === "CARRY_FROM_PRIOR" ? "CARRY_FROM_PRIOR" : "MANUAL";

  const openingCashParsed = parseFloat(String(req.query.opening_cash ?? ""));
  const suggestedOpening = parseFloat(String(req.query.suggested_opening ?? ""));
  let opening: number;
  if (Number.isFinite(openingCashParsed)) {
    opening = openingCashParsed;
  } else if (Number.isFinite(suggestedOpening)) {
    opening = suggestedOpening;
  } else if (openingCashSourcePreview === "CARRY_FROM_PRIOR" && priorShiftPreview) {
    opening = priorShiftPreview.closingCashActual;
  } else {
    opening = 0;
  }

  const shiftLabel =
    typeof req.query.shift_label === "string" ? req.query.shift_label.trim().slice(0, 64) : "";

  const priorBanner = priorShiftPreview
    ? `<p class="muted" style="font-size:13px;margin:0 0 12px;padding:10px;border:1px solid #bae6fd;border-radius:10px;background:#f0f9ff">Handover from <strong>${escapeHtml(
        priorShiftPreview.shiftSlot
      )}</strong> shift on <strong>${escapeHtml(priorShiftPreview.businessDate)}</strong> (closed ${escapeHtml(
      priorShiftPreview.closedAt.toISOString().slice(0, 16).replace("T", " ")
    )} UTC). Carry-forward basis: <strong>${priorShiftPreview.closingCashActual.toFixed(3)}</strong> ${escapeHtml(hotel.currency)}.</p>`
    : "";

  let snapshotHtml = "";
  let computed: Awaited<ReturnType<typeof computeShiftSnapshot>> | null = null;
  if (shiftEnd.getTime() > shiftStart.getTime()) {
    try {
      computed = await computeShiftSnapshot({
        hotelId: hotel.id,
        currency: hotel.currency,
        shiftStart,
        shiftEnd
      });
      const payRows = computed.paymentBuckets
        .map(
          (b) =>
            `<tr><td>${escapeHtml(b.label)}</td><td>${escapeHtml(String(b.count))}</td><td>${escapeHtml(String(b.amount.toFixed(3)))} ${escapeHtml(hotel.currency)}</td></tr>`
        )
        .join("");
      snapshotHtml = `
<section style="margin:16px 0;padding:14px;border:1px solid #d8dee6;border-radius:12px;background:#f8fafc">
  <h3 style="margin-top:0;font-size:15px">Auto summary (folio activity, chargeDate in range)</h3>
  <div class="grid-4" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px">
    <article class="stat"><h3>Lines</h3><p>${computed.transactionCount}</p></article>
    <article class="stat"><h3>Charges (net)</h3><p>${computed.revenueTotal.toFixed(3)}</p></article>
    <article class="stat"><h3>Payments in</h3><p>${computed.totalPaymentsRecorded.toFixed(3)}</p></article>
    <article class="stat"><h3>Cash in (folio)</h3><p>${computed.cashReceived.toFixed(3)}</p></article>
  </div>
  <p class="muted" style="font-size:12px;margin:0 0 8px">Room ${computed.revenueRoom.toFixed(3)} · F&amp;B ${computed.revenueFb.toFixed(3)} · Activity ${computed.revenueActivity.toFixed(3)} · Other ${computed.revenueOtherCharges.toFixed(3)} (${hotel.currency})</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr><th>Method</th><th>Count</th><th>Amount</th></tr></thead>
    <tbody>${payRows || `<tr><td colspan="3" class="muted">No payments</td></tr>`}</tbody>
  </table>
  <p class="muted" style="font-size:12px;margin-top:10px">Outstanding: ${computed.pendingPaymentIntents} pending payment intent(s), ${computed.pendingPaymentAmount.toFixed(3)} ${hotel.currency} total.</p>
  <p class="muted" style="font-size:12px;margin-top:8px">If there were <strong>no</strong> cash expenses and <strong>no</strong> bank deposit, expected drawer cash would be <strong>${(opening + computed.cashReceived).toFixed(3)}</strong> ${escapeHtml(hotel.currency)} (opening + folio cash in).</p>
</section>`;
    } catch (e) {
      snapshotHtml = `<p class="badge alert">Could not load summary: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
    }
  } else {
    snapshotHtml = `<p class="muted">Set shift end after shift start to see the summary.</p>`;
  }

  const history = await prisma.frontDeskShift.findMany({
    where: { hotelId: hotel.id },
    orderBy: { closedAt: "desc" },
    take: 15,
    include: { closedBy: { select: { fullName: true, email: true } } }
  });
  const histRows = history
    .map((s) => {
      const reportHref = `/admin/shift-report/${encodeURIComponent(s.id)}`;
      const slotShow = s.shiftLabel?.trim()
        ? `${escapeHtml(s.shiftSlot)} (${escapeHtml(s.shiftLabel.trim())})`
        : escapeHtml(s.shiftSlot);
      return `<tr>
  <td>${slotShow}</td>
  <td>${escapeHtml(s.businessDate)}</td>
  <td>${escapeHtml(formatDateTimeLocalForInput(s.shiftStart))} → ${escapeHtml(formatDateTimeLocalForInput(s.shiftEnd))}</td>
  <td>${escapeHtml(s.closedAt.toISOString().slice(0, 16).replace("T", " "))}</td>
  <td>${s.closedBy ? escapeHtml(s.closedBy.fullName) : "—"}</td>
  <td>${s.expectedClosingCash.toFixed(3)}</td>
  <td>${s.closingCashActual.toFixed(3)}</td>
  <td style="font-weight:700;color:${s.cashVariance === 0 ? "#166534" : "#991b1b"}">${s.cashVariance.toFixed(3)}</td>
  <td><span class="badge ok">Locked</span> <a href="${reportHref}">Report</a></td>
</tr>`;
    })
    .join("");

  const slotOptionsHtml = ["MORNING", "EVENING", "NIGHT", "CUSTOM"]
    .map((s) => {
      const lab = s === "CUSTOM" ? "Custom (optional label below)" : s.charAt(0) + s.slice(1).toLowerCase();
      return `<option value="${s}" ${shiftSlot === s ? "selected" : ""}>${escapeHtml(lab)}</option>`;
    })
    .join("");

  const ocsCheckedManual = openingCashSourcePreview === "MANUAL" ? "checked" : "";
  const ocsCheckedCarry = openingCashSourcePreview === "CARRY_FROM_PRIOR" ? "checked" : "";

  const content = `
<h2>Shift close / cashier report</h2>
${flashOk}${reportHint}${errFlash}
<p class="muted">Review folio payments and charges for the shift window, reconcile cash, record petty payouts and bank deposits, then close. Each closed shift is independent — pick a <strong>slot</strong> and <strong>business date</strong> so morning/evening/night reports stay separate. <a href="/admin/shifts">View all shifts</a>.</p>
${priorBanner}
${snapshotHtml}
<form method="get" action="/admin/shift-close" style="margin:14px 0;padding:14px;border:1px solid #d8dee6;border-radius:12px">
  <h3 style="margin-top:0;font-size:15px">1. Shift identity, window &amp; opening float</h3>
  <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
    <label>Shift slot
      <select name="shift_slot" style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px;min-width:160px">${slotOptionsHtml}</select>
    </label>
    <label>Business date
      <input type="date" name="business_date" value="${escapeHtml(businessDate)}" required style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px" />
    </label>
    <label>Custom label (optional)
      <input type="text" name="shift_label" value="${escapeHtml(shiftLabel)}" maxlength="64" placeholder="e.g. Pre-event" style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px;width:200px" />
    </label>
    <label>Shift start<input type="datetime-local" name="shift_start" value="${escapeHtml(formatDateTimeLocalForInput(shiftStart))}" required style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px" /></label>
    <label>Shift end<input type="datetime-local" name="shift_end" value="${escapeHtml(formatDateTimeLocalForInput(shiftEnd))}" required style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px" /></label>
    <label>Prior shift (handover from)
      <input type="text" name="prior_shift_id" value="${escapeHtml(priorIdQ)}" placeholder="Paste closed shift ID" style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px;width:220px" />
    </label>
    <div style="min-width:200px">
      <span style="font-size:13px;display:block;margin-bottom:4px">Opening float source</span>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="radio" name="opening_cash_source" value="MANUAL" ${ocsCheckedManual} /> Manual</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="radio" name="opening_cash_source" value="CARRY_FROM_PRIOR" ${ocsCheckedCarry} /> Carry from prior shift</label>
    </div>
    <label>Opening cash (${escapeHtml(hotel.currency)})<input type="number" name="opening_cash" value="${opening}" min="0" step="0.001" style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px;width:140px" /></label>
    <button type="submit" class="btn-link primary" style="border:0;padding:10px 16px">Refresh summary</button>
  </div>
</form>

<form method="post" action="/admin/shift-close" style="margin:14px 0;padding:14px;border:1px solid #d8dee6;border-radius:12px">
  <h3 style="margin-top:0;font-size:15px">2. Close shift (cash &amp; expenses)</h3>
  <input type="hidden" name="shift_start" value="${escapeHtml(formatDateTimeLocalForInput(shiftStart))}" />
  <input type="hidden" name="shift_end" value="${escapeHtml(formatDateTimeLocalForInput(shiftEnd))}" />
  <input type="hidden" name="opening_cash" value="${opening}" />
  <input type="hidden" name="shift_slot" value="${escapeHtml(shiftSlot)}" />
  <input type="hidden" name="business_date" value="${escapeHtml(businessDate)}" />
  <input type="hidden" name="shift_label" value="${escapeHtml(shiftLabel)}" />
  <input type="hidden" name="prior_shift_id" value="${escapeHtml(priorIdQ)}" />
  <input type="hidden" name="opening_cash_source" value="${escapeHtml(openingCashSourcePreview)}" />
  <label style="display:block;margin-top:4px;font-size:13px">Handover / desk notes (optional)
    <textarea name="handover_note" rows="3" maxlength="2000" style="display:block;margin-top:6px;width:100%;max-width:520px;padding:8px;border:1px solid #d8dee6;border-radius:8px;font-family:inherit"></textarea>
  </label>
  <label>Counted cash in drawer (${escapeHtml(hotel.currency)}) — actual
    <input type="number" name="closing_cash_actual" min="0" step="0.001" required style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px;width:180px" />
  </label>
  <label style="display:block;margin-top:10px">Bank deposit (cash taken to bank, ${escapeHtml(hotel.currency)})
    <input type="number" name="bank_deposit" value="0" min="0" step="0.001" style="display:block;margin-top:4px;padding:8px;border:1px solid #d8dee6;border-radius:8px;width:180px" />
  </label>
  <p class="muted" style="font-size:12px;margin:12px 0 6px">Cash expenses / payouts (petty cash out) — ${escapeHtml(hotel.currency)}</p>
  <table style="width:100%;max-width:720px;border-collapse:collapse;font-size:13px">
    <thead><tr><th>Category</th><th>Amount</th><th>Note</th></tr></thead>
    <tbody>
      ${[1, 2, 3, 4, 5]
        .map(
          (i) => `<tr>
        <td><input name="exp_cat_${i}" placeholder="e.g. SUPPLIES" style="width:100%;padding:6px;border:1px solid #d8dee6;border-radius:6px" /></td>
        <td><input type="number" name="exp_amt_${i}" min="0" step="0.001" placeholder="0" style="width:120px;padding:6px;border:1px solid #d8dee6;border-radius:6px" /></td>
        <td><input name="exp_note_${i}" placeholder="optional" style="width:100%;padding:6px;border:1px solid #d8dee6;border-radius:6px" /></td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>
  <p class="muted" style="font-size:12px">Expected closing cash = opening + folio cash in − expenses − bank deposit. Variance = counted − expected.</p>
  <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14px">
    <input type="checkbox" name="confirm_close" value="1" required /> I confirm this shift is accurate and should be locked.
  </label>
  <button type="submit" style="margin-top:12px;padding:10px 18px;border:0;border-radius:10px;background:#128c7e;color:#fff;font-weight:700">Close &amp; lock shift</button>
</form>

<h3 style="margin-top:22px">Recent closed shifts</h3>
<table>
  <thead><tr><th>Slot</th><th>Date</th><th>Window</th><th>Closed (UTC)</th><th>By</th><th>Expected</th><th>Counted</th><th>Var</th><th></th></tr></thead>
  <tbody>${histRows.length ? histRows : `<tr><td colspan="9" class="muted">No shifts closed yet.</td></tr>`}</tbody>
</table>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/shift-close", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const session = getSession(req);
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, currency: true }
  });
  if (!hotel || !session) {
    res.redirect("/admin/shift-close?err=" + encodeURIComponent("Session or hotel missing."));
    return;
  }
  if (req.body?.confirm_close !== "1" && req.body?.confirm_close !== "on") {
    res.redirect("/admin/shift-close?err=" + encodeURIComponent("Confirm the shift to close."));
    return;
  }

  const shiftStart = parseDateTimeLocalInput(req.body.shift_start, new Date());
  const shiftEnd = parseDateTimeLocalInput(req.body.shift_end, new Date());
  const openingCash = parseFloat(String(req.body.opening_cash ?? "0"));
  const closingCashActual = parseFloat(String(req.body.closing_cash_actual ?? ""));
  const bankDeposit = parseFloat(String(req.body.bank_deposit ?? "0"));

  const qSlotRaw = String(req.body.shift_slot ?? "CUSTOM").toUpperCase();
  const shiftSlot = ["MORNING", "EVENING", "NIGHT", "CUSTOM"].includes(qSlotRaw) ? qSlotRaw : "CUSTOM";

  const bdRaw = String(req.body.business_date ?? "").trim();
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(bdRaw) ? bdRaw : formatBusinessDateLocal(shiftStart);

  const shiftLabel = String(req.body.shift_label ?? "").trim().slice(0, 64) || null;

  const ocsBody = String(req.body.opening_cash_source ?? "MANUAL").toUpperCase();
  const openingCashSource = ocsBody === "CARRY_FROM_PRIOR" ? "CARRY_FROM_PRIOR" : "MANUAL";

  const priorShiftIdRaw = String(req.body.prior_shift_id ?? "").trim();
  let priorShift: {
    id: string;
    closingCashActual: number;
    businessDate: string;
    shiftSlot: string;
    closedAt: Date;
  } | null = null;
  if (priorShiftIdRaw) {
    const p = await prisma.frontDeskShift.findFirst({
      where: { id: priorShiftIdRaw, hotelId: hotel.id, locked: true, status: "CLOSED" },
      select: { id: true, closingCashActual: true, businessDate: true, shiftSlot: true, closedAt: true }
    });
    if (!p) {
      res.redirect("/admin/shift-close?err=" + encodeURIComponent("Prior shift not found or not locked."));
      return;
    }
    priorShift = p;
  }

  if (openingCashSource === "CARRY_FROM_PRIOR" && !priorShift) {
    res.redirect(
      "/admin/shift-close?err=" + encodeURIComponent("Carry-forward requires a valid prior shift ID, or choose Manual opening.")
    );
    return;
  }

  const handoverNote = String(req.body.handover_note ?? "").trim().slice(0, 2000) || null;

  if (!(shiftEnd.getTime() > shiftStart.getTime())) {
    res.redirect("/admin/shift-close?err=" + encodeURIComponent("Shift end must be after start."));
    return;
  }
  if (!Number.isFinite(closingCashActual) || closingCashActual < 0) {
    res.redirect("/admin/shift-close?err=" + encodeURIComponent("Enter a valid counted cash amount."));
    return;
  }

  if (shiftSlot !== "CUSTOM") {
    const dup = await prisma.frontDeskShift.findFirst({
      where: { hotelId: hotel.id, businessDate, shiftSlot }
    });
    if (dup) {
      res.redirect(
        "/admin/shift-close?err=" +
          encodeURIComponent(
            `A ${shiftSlot} shift for ${businessDate} is already closed. Use CUSTOM or another date, or consult shift history.`
          )
      );
      return;
    }
  }

  const expenseLines: { category: string; amount: number; note: string | null }[] = [];
  for (let i = 1; i <= 5; i++) {
    const cat = String(req.body[`exp_cat_${i}`] ?? "").trim();
    const amtRaw = parseFloat(String(req.body[`exp_amt_${i}`] ?? ""));
    const note = String(req.body[`exp_note_${i}`] ?? "").trim().slice(0, 500) || null;
    if (!cat && (!Number.isFinite(amtRaw) || amtRaw <= 0)) continue;
    if (!Number.isFinite(amtRaw) || amtRaw <= 0) continue;
    expenseLines.push({ category: cat.slice(0, 48) || "OTHER", amount: amtRaw, note });
  }
  const expenseTotal = expenseLines.reduce((s, e) => s + e.amount, 0);

  let computed: Awaited<ReturnType<typeof computeShiftSnapshot>>;
  try {
    computed = await computeShiftSnapshot({
      hotelId: hotel.id,
      currency: hotel.currency,
      shiftStart,
      shiftEnd
    });
  } catch (e) {
    res.redirect("/admin/shift-close?err=" + encodeURIComponent(e instanceof Error ? e.message : "Compute failed"));
    return;
  }

  const opening = Number.isFinite(openingCash) ? openingCash : 0;
  const bank = Number.isFinite(bankDeposit) && bankDeposit >= 0 ? bankDeposit : 0;
  const expectedClosing = computeExpectedClosingCash({
    openingCash: opening,
    cashReceived: computed.cashReceived,
    expenseTotal,
    bankDepositAmount: bank
  });
  const variance = closingCashActual - expectedClosing;

  const closedNow = new Date();
  const handoverSnap =
    priorShift != null
      ? {
          priorShiftId: priorShift.id,
          priorShiftSlot: priorShift.shiftSlot,
          priorBusinessDate: priorShift.businessDate,
          priorClosingCounted: priorShift.closingCashActual,
          handoverAt: closedNow.toISOString(),
          handedOverByUserId: session.staffId,
          receivedByUserId: null as string | null,
          openingCashSource,
          handoverNote
        }
      : undefined;

  const snapshotJson = JSON.stringify({
    meta: {
      shiftSlot,
      businessDate,
      shiftLabel,
      openingCashSource,
      handoverNote,
      priorShiftId: priorShift?.id ?? null
    },
    handover: handoverSnap,
    computed,
    expenses: expenseLines,
    openingCash: opening,
    bankDepositAmount: bank,
    expectedClosingCash: expectedClosing,
    closingCashActual,
    cashVariance: variance
  });

  let createdId: string;
  try {
    const row = await prisma.frontDeskShift.create({
      data: {
        hotelId: hotel.id,
        shiftSlot,
        shiftLabel,
        businessDate,
        shiftStart,
        shiftEnd,
        closedAt: closedNow,
        closedByUserId: session.staffId,
        openingCash: opening,
        openingCashSource,
        priorShiftId: priorShift?.id ?? null,
        handoverNote,
        closingCashActual,
        bankDepositAmount: bank,
        expectedClosingCash: expectedClosing,
        cashVariance: variance,
        currency: hotel.currency,
        status: "CLOSED",
        locked: true,
        snapshotJson,
        expenses: {
          create: expenseLines.map((e) => ({
            category: e.category,
            amount: e.amount,
            note: e.note
          }))
        }
      }
    });
    createdId = row.id;
  } catch (e) {
    res.redirect("/admin/shift-close?err=" + encodeURIComponent(e instanceof Error ? e.message : "Save failed"));
    return;
  }

  await logAudit({
    hotelId: hotel.id,
    action: "FRONT_DESK_SHIFT_CLOSED",
    entityType: "FrontDeskShift",
    entityId: createdId,
    metadata: {
      shiftSlot,
      businessDate,
      priorShiftId: priorShift?.id ?? null,
      shiftStart: shiftStart.toISOString(),
      shiftEnd: shiftEnd.toISOString(),
      expectedClosingCash: expectedClosing,
      closingCashActual,
      variance
    }
  });

  res.redirect("/admin/shift-close?closed=1&report_id=" + encodeURIComponent(createdId));
});

adminRouter.get("/handover-sheet", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true, displayName: true, currency: true } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Handover Sheet</h2><p>No hotel data found.</p>", true));
    return;
  }

  const selectedDate = parseDateInput(req.query.date, startOfDay(new Date()));
  const dayStart = selectedDate;
  const dayEnd = addDays(dayStart, 1);
  const shiftInput = typeof req.query.shift === "string" ? req.query.shift.toUpperCase() : "MORNING";
  type ShiftKey = "MORNING" | "EVENING" | "NIGHT" | "FULL_DAY";
  const selectedShift: ShiftKey =
    shiftInput === "EVENING" || shiftInput === "NIGHT" || shiftInput === "FULL_DAY" ? shiftInput : "MORNING";
  const shiftRanges: Record<ShiftKey, { label: string; startHour: number; startMinute: number; endHour: number; endMinute: number }> = {
    MORNING: { label: "Morning", startHour: 7, startMinute: 0, endHour: 14, endMinute: 0 },
    EVENING: { label: "Evening", startHour: 14, startMinute: 0, endHour: 22, endMinute: 0 },
    NIGHT: { label: "Night", startHour: 22, startMinute: 0, endHour: 23, endMinute: 59 },
    FULL_DAY: { label: "Full day", startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 }
  };
  const activeShift = shiftRanges[selectedShift];
  const windowStart = new Date(dayStart);
  windowStart.setHours(activeShift.startHour, activeShift.startMinute, 0, 0);
  const shiftEnd = new Date(dayStart);
  shiftEnd.setHours(activeShift.endHour, activeShift.endMinute, 59, 999);
  const uptoRaw = typeof req.query.upto === "string" ? req.query.upto : "";
  let uptoTime = new Date(Math.min(Date.now(), shiftEnd.getTime()));
  if (uptoRaw) {
    const parsed = new Date(uptoRaw);
    if (!Number.isNaN(parsed.getTime())) uptoTime = parsed;
  }
  if (uptoTime < windowStart) uptoTime = windowStart;
  if (uptoTime > shiftEnd) uptoTime = shiftEnd;
  if (uptoTime > dayEnd) uptoTime = dayEnd;
  const uptoValue = `${formatDateForInput(dayStart)}T${String(uptoTime.getHours()).padStart(2, "0")}:${String(uptoTime.getMinutes()).padStart(2, "0")}`;
  const shiftWindowLabel = `${activeShift.label} (${String(activeShift.startHour).padStart(2, "0")}:${String(activeShift.startMinute).padStart(2, "0")} - ${String(activeShift.endHour).padStart(2, "0")}:${String(activeShift.endMinute).padStart(2, "0")})`;
  const selectedStaffId = typeof req.query.staffId === "string" ? req.query.staffId.trim() : "";

  const [bookingActivities, paymentActivities, guestUpdates] = await Promise.all([
    prisma.booking.findMany({
      where: { hotelId: hotel.id, createdAt: { gte: windowStart, lte: uptoTime } },
      include: { guest: true, roomType: true, roomUnit: true },
      orderBy: { createdAt: "desc" },
      take: 300
    }),
    prisma.paymentIntent.findMany({
      where: { hotelId: hotel.id, createdAt: { gte: windowStart, lte: uptoTime } },
      include: { booking: { include: { guest: true, roomUnit: true, roomType: true } } },
      orderBy: { createdAt: "desc" },
      take: 300
    }),
    prisma.auditLog.findMany({
      where: {
        hotelId: hotel.id,
        action: "ROOM_UNIT_GUEST_DETAILS",
        createdAt: { gte: windowStart, lte: uptoTime }
      },
      orderBy: { createdAt: "desc" },
      take: 300
    })
  ]);
  const bookingIds = bookingActivities.map((b) => b.id);
  const bookingActorLogs = bookingIds.length
    ? await prisma.auditLog.findMany({
        where: {
          hotelId: hotel.id,
          entityType: "Booking",
          entityId: { in: bookingIds },
          createdAt: { gte: windowStart, lte: uptoTime }
        },
        orderBy: { createdAt: "desc" }
      })
    : [];
  const bookingActorById = new Map<string, { staffId: string; staffEmail: string }>();
  for (const log of bookingActorLogs) {
    if (!log.entityId || bookingActorById.has(log.entityId)) continue;
    bookingActorById.set(log.entityId, {
      staffId: log.actorUserId || "SYSTEM",
      staffEmail: log.actorEmail || "system@chatastay.local"
    });
  }
  const staffIdOptionsSet = new Set<string>([
    ...Array.from(bookingActorById.values()).map((v) => v.staffId),
    ...guestUpdates.map((g) => g.actorUserId || "SYSTEM")
  ]);
  if (selectedStaffId) staffIdOptionsSet.add(selectedStaffId);
  const staffIdOptions = Array.from(staffIdOptionsSet)
    .sort((a, b) => a.localeCompare(b))
    .map((staffId) => `<option value="${escapeHtml(staffId)}" ${staffId === selectedStaffId ? "selected" : ""}>${escapeHtml(staffId)}</option>`)
    .join("");

  const filteredBookingActivities = selectedStaffId
    ? bookingActivities.filter((b) => (bookingActorById.get(b.id)?.staffId || "SYSTEM") === selectedStaffId)
    : bookingActivities;
  const filteredPaymentActivities = selectedStaffId
    ? paymentActivities.filter((p) => ((p.booking?.id ? bookingActorById.get(p.booking.id)?.staffId : undefined) || "SYSTEM") === selectedStaffId)
    : paymentActivities;
  const filteredGuestUpdates = selectedStaffId ? guestUpdates.filter((g) => (g.actorUserId || "SYSTEM") === selectedStaffId) : guestUpdates;

  const statusCounts = {
    PENDING: filteredBookingActivities.filter((b) => b.status === "PENDING").length,
    CONFIRMED: filteredBookingActivities.filter((b) => b.status === "CONFIRMED").length,
    CANCELLED: filteredBookingActivities.filter((b) => b.status === "CANCELLED").length
  };
  const paymentsSucceeded = filteredPaymentActivities.filter((p) => p.status === "SUCCEEDED");
  const paymentTotal = paymentsSucceeded.reduce((sum, p) => sum + p.amount, 0);
  const uniqueUnitsTouched = new Set(
    filteredBookingActivities
      .map((b) => b.roomUnit?.name)
      .filter((name): name is string => Boolean(name))
  ).size;
  const uniqueStaffTouched = new Set([
    ...filteredBookingActivities.map((b) => bookingActorById.get(b.id)?.staffId || "SYSTEM"),
    ...filteredGuestUpdates.map((g) => g.actorUserId || "SYSTEM")
  ]).size;

  const bookingActivityRows = filteredBookingActivities
    .map(
      (b) => `<tr>
        <td>${formatDateTime(b.createdAt)}</td>
        <td>${escapeHtml(b.status)}</td>
        <td>${escapeHtml(b.guest?.fullName || b.guest?.phoneE164 || "—")}</td>
        <td>${escapeHtml(b.roomUnit?.name || "Pending assignment")}</td>
        <td>${escapeHtml(b.roomType?.name || "—")}</td>
        <td>${escapeHtml(bookingActorById.get(b.id)?.staffId || "SYSTEM")}</td>
        <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(b.id)}">${escapeHtml(b.id)}</a></td>
      </tr>`
    )
    .join("");
  const paymentActivityRows = filteredPaymentActivities
    .map(
      (p) => `<tr>
        <td>${formatDateTime(p.createdAt)}</td>
        <td>${escapeHtml(p.status)}</td>
        <td>${escapeHtml(p.kind || "—")}</td>
        <td>${formatMoney(p.amount, p.currency || hotel.currency)}</td>
        <td>${escapeHtml(p.booking?.guest?.fullName || p.booking?.guest?.phoneE164 || "—")}</td>
        <td>${escapeHtml(p.booking?.roomUnit?.name || "—")}</td>
        <td>${escapeHtml((p.booking?.id ? bookingActorById.get(p.booking.id)?.staffId : undefined) || "SYSTEM")}</td>
      </tr>`
    )
    .join("");
  const guestUpdateRows = filteredGuestUpdates
    .map((log) => {
      const metadata = parseAuditMetadata(log.metadataJson);
      const guestName = typeof metadata.fullName === "string" ? metadata.fullName : "—";
      const unitName = typeof metadata.unitName === "string" ? metadata.unitName : log.entityId ?? "—";
      return `<tr>
        <td>${formatDateTime(log.createdAt)}</td>
        <td>${escapeHtml(unitName)}</td>
        <td>${escapeHtml(guestName || "—")}</td>
        <td>${escapeHtml(log.action)}</td>
        <td>${escapeHtml(log.actorUserId || "SYSTEM")}</td>
      </tr>`;
    })
    .join("");

  const content = `
<h2>Handover Sheet</h2>
<p class="muted">Shift summary of reservation operations up to selected time for one day.</p>
<div class="actions" style="margin-bottom:14px">
  <button type="button" class="btn-link" onclick="window.print()">Print handover sheet</button>
</div>
<form method="get" action="/admin/handover-sheet" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:14px">
  <label>Date <input type="date" name="date" value="${formatDateForInput(dayStart)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>Shift
    <select name="shift" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="MORNING" ${selectedShift === "MORNING" ? "selected" : ""}>Morning (07:00-14:00)</option>
      <option value="EVENING" ${selectedShift === "EVENING" ? "selected" : ""}>Evening (14:00-22:00)</option>
      <option value="NIGHT" ${selectedShift === "NIGHT" ? "selected" : ""}>Night (22:00-23:59)</option>
      <option value="FULL_DAY" ${selectedShift === "FULL_DAY" ? "selected" : ""}>Full day (00:00-23:59)</option>
    </select>
  </label>
  <label>Staff ID
    <select name="staffId" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="">All staff</option>${staffIdOptions}
    </select>
  </label>
  <label>Up to time <input type="datetime-local" name="upto" value="${uptoValue}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <button type="submit" style="padding:8px 14px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
</form>
<p class="muted" style="margin-top:-6px; margin-bottom:10px">Window: ${escapeHtml(shiftWindowLabel)} · showing activity from ${formatDateTime(windowStart)} to ${formatDateTime(uptoTime)}</p>
<div class="grid-4" style="margin-bottom:12px">
  <article class="stat"><h3>New reservations</h3><p>${statusCounts.PENDING + statusCounts.CONFIRMED}</p></article>
  <article class="stat"><h3>Confirmed</h3><p>${statusCounts.CONFIRMED}</p></article>
  <article class="stat"><h3>Pending</h3><p>${statusCounts.PENDING}</p></article>
  <article class="stat"><h3>Cancelled</h3><p>${statusCounts.CANCELLED}</p></article>
  <article class="stat"><h3>Payments captured</h3><p>${paymentsSucceeded.length}</p></article>
  <article class="stat"><h3>Payment value</h3><p>${formatMoney(paymentTotal, hotel.currency)}</p></article>
  <article class="stat"><h3>Units touched</h3><p>${uniqueUnitsTouched}</p></article>
  <article class="stat"><h3>Staff touched</h3><p>${uniqueStaffTouched}</p></article>
  <article class="stat"><h3>Guest updates</h3><p>${filteredGuestUpdates.length}</p></article>
</div>
<section style="margin-top:12px">
  <h3>Reservation activity log</h3>
  <table>
    <thead><tr><th>Time</th><th>Status</th><th>Guest</th><th>Unit</th><th>Room type</th><th>Staff ID</th><th>Booking</th></tr></thead>
    <tbody>${bookingActivityRows || '<tr><td colspan="7">No reservation activity in this time window.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin-top:12px">
  <h3>Payment activity log</h3>
  <table>
    <thead><tr><th>Time</th><th>Status</th><th>Method</th><th>Amount</th><th>Guest</th><th>Unit</th><th>Staff ID</th></tr></thead>
    <tbody>${paymentActivityRows || '<tr><td colspan="7">No payment activity in this time window.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin-top:12px">
  <h3>Guest-details update log</h3>
  <table>
    <thead><tr><th>Time</th><th>Unit</th><th>Guest</th><th>Action</th><th>Staff ID</th></tr></thead>
    <tbody>${guestUpdateRows || '<tr><td colspan="5">No guest-detail updates in this time window.</td></tr>'}</tbody>
  </table>
</section>
<style>
  @media print {
    .sidebar, .section-tabs, nav, .actions, form button { display:none !important; }
    body { background:#fff; }
  }
</style>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/room-board/detail/:roomTypeId", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { roomTypes: { where: { isActive: true }, include: { property: true } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Room detail</h2><p>No hotel data found.</p>", true));
    return;
  }
  const roomTypeId = String(req.params.roomTypeId ?? "");
  const roomType = hotel.roomTypes.find((r) => r.id === roomTypeId);
  if (!roomType) {
    res.redirect("/admin/room-board");
    return;
  }
  const now = startOfDay(new Date());
  const boardDate = parseDateInput(req.query.date, now);
  const dateEndExclusive = addDays(boardDate, 1);
  const detailDayRange = inventoryDayRangeExclusive(boardDate);
  const [inv, bookings] = await Promise.all([
    prisma.inventory.findFirst({
      where: { hotelId: hotel.id, roomTypeId, date: { gte: detailDayRange.gte, lt: detailDayRange.lt } }
    }),
    prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        roomTypeId,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      include: { guest: true, roomUnit: true },
      orderBy: { checkIn: "asc" }
    })
  ]);
  const total = inv?.total ?? roomType.totalInventory;
  const reserved = inv?.reserved ?? 0;
  const closedOut = inv?.closedOut ?? false;
  const available = closedOut ? 0 : Math.max(0, total - reserved);
  const bookingRows = bookings
    .map(
      (b) => `<tr>
        <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(b.id)}">${escapeHtml(b.id.slice(0, 8))}</a></td>
        <td>${escapeHtml(b.guest.fullName ?? b.guest.phoneE164)}</td>
        <td>${formatDateForInput(b.checkIn)} – ${formatDateForInput(b.checkOut)}</td>
        <td>${b.roomUnit?.name ? escapeHtml(b.roomUnit.name) : '<span class="badge pending">Not assigned</span>'}</td>
        <td><span class="badge ${b.status === "CONFIRMED" ? "ok" : "pending"}">${escapeHtml(b.status)}</span></td>
      </tr>`
    )
    .join("");
  const content = `
<h2>${escapeHtml(roomType.name)}</h2>
<p class="muted">Room type: ${escapeHtml(roomType.code)} · ${escapeHtml(roomType.property.name)}</p>
<div class="actions" style="margin-bottom:14px">
  <a class="btn-link" href="/admin/room-board?date=${formatDateForInput(boardDate)}">Back to board</a>
  <a class="btn-link primary" href="/admin/calendar?start=${formatDateForInput(boardDate)}&days=7">Calendar</a>
  <a class="btn-link" href="/admin/rooms">Edit room</a>
</div>
<div class="grid-2">
  <section>
    <h3>Status for ${formatDateForInput(boardDate)}</h3>
    <table><tbody>
      <tr><th>Total units</th><td>${total}</td></tr>
      <tr><th>Reserved</th><td>${reserved}</td></tr>
      <tr><th>Available</th><td>${available}</td></tr>
      <tr><th>Closed out</th><td>${closedOut ? "Yes" : "No"}</td></tr>
    </tbody></table>
  </section>
  <section>
    <h3>Bookings overlapping this date</h3>
    <table>
      <thead><tr><th>Booking</th><th>Guest</th><th>Stay</th><th>Unit</th><th>Status</th></tr></thead>
      <tbody>${bookingRows || "<tr><td colspan=\"5\">None</td></tr>"}</tbody>
    </table>
  </section>
</div>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/room-board/unit/:unitId/details", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Room unit details</h2><p>No hotel data found.</p>", true));
    return;
  }

  const unitId = String(req.params.unitId ?? "");
  const boardDate = parseDateInput(req.query.date, startOfDay(new Date()));
  const editMode = req.query.edit === "1";
  const dateKey = formatDateForInput(boardDate);
  const dateEndExclusive = addDays(boardDate, 1);
  const unitDetailDayRange = inventoryDayRangeExclusive(boardDate);
  const savedNotice = req.query.saved ? '<p class="badge ok">Room &amp; guest details saved.</p>' : "";

  const unit = await prisma.roomUnit.findFirst({
    where: { id: unitId, hotelId: hotel.id },
    include: { roomType: { include: { property: true } } }
  });
  if (!unit) {
    res.redirect(`/admin/room-board?date=${dateKey}`);
    return;
  }

  const [inventoryRow, booking, manualDetails, activeSiblings, typeOverlappingBookings] = await Promise.all([
    prisma.inventory.findFirst({
      where: { hotelId: hotel.id, roomTypeId: unit.roomTypeId, date: { gte: unitDetailDayRange.gte, lt: unitDetailDayRange.lt } },
      select: { closedOut: true, total: true, reserved: true }
    }),
    prisma.booking.findFirst({
      where: {
        hotelId: hotel.id,
        roomTypeId: unit.roomTypeId,
        roomUnitId: unit.id,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      include: { guest: true, paymentIntents: { orderBy: { createdAt: "desc" } } },
      orderBy: { checkIn: "asc" }
    }),
    getManualGuestDetailsForUnitOnDate(unit.id, dateKey),
    prisma.roomUnit.findMany({
      where: { hotelId: hotel.id, roomTypeId: unit.roomTypeId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, notes: true }
    }),
    prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        roomTypeId: unit.roomTypeId,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      select: { roomUnitId: true }
    })
  ]);

  let linkedRoomsBanner = "";
  if (booking?.bookingGroupId) {
    const siblings = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        bookingGroupId: booking.bookingGroupId,
        id: { not: booking.id },
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] }
      },
      orderBy: { checkIn: "asc" },
      select: { id: true, referenceCode: true, roomUnit: { select: { name: true } } },
      take: 12
    });
    if (siblings.length) {
      const parts: string[] = [];
      for (const s of siblings) {
        const uc = s.roomUnit?.name ?? (await getBookingUnitCode(s.id));
        parts.push(
          `<a class="inline-link" href="/admin/bookings/${encodeURIComponent(s.id)}">${escapeHtml(
            displayBookingReference(s)
          )}</a>${uc ? ` <span class="muted">(${escapeHtml(uc)})</span>` : ""}`
        );
      }
      linkedRoomsBanner = `<p class="rud-banner-warn" style="margin:0 0 10px"><strong>Other linked rooms (same group):</strong> ${parts.join(
        " · "
      )}</p>`;
    }
  }
  const rudChangeRoomLink =
    booking && (booking.status === BookingStatus.CONFIRMED || booking.status === BookingStatus.PENDING)
      ? `<a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/change-room">Change room</a>`
      : "";

  const manualStatus = parseManualRoomStatusFromNotes(unit.notes);
  const hasConfirmed = Boolean(booking && booking.status === "CONFIRMED");
  const hasPending = Boolean(booking && booking.status === "PENDING");
  const closedOut = inventoryRow?.closedOut ?? false;
  const bookableTotal = inventoryRow?.total ?? unit.roomType.totalInventory;
  const reservedCount = inventoryRow?.reserved ?? 0;
  const aggregateAvailable = closedOut ? 0 : Math.max(0, bookableTotal - reservedCount);
  const activeIndex = activeSiblings.findIndex((u) => u.id === unit.id);
  const beyondInventoryCap = unit.isActive && activeIndex >= 0 && activeIndex >= bookableTotal;
  const bookingSlotCount = typeOverlappingBookings.length;
  const unbookedActiveForInv = activeSiblings.filter(
    (u) => !typeOverlappingBookings.some((b) => b.roomUnitId === u.id)
  );
  const effectiveReserved = Math.min(reservedCount, bookableTotal);
  const needInvReserved = Math.max(0, effectiveReserved - bookingSlotCount);
  const reservedFromInventoryUnitIds = new Set<string>();
  {
    let remaining = needInvReserved;
    for (const u of unbookedActiveForInv) {
      if (remaining <= 0) break;
      if (parseManualRoomStatusFromNotes(u.notes)) continue;
      reservedFromInventoryUnitIds.add(u.id);
      remaining -= 1;
    }
  }

  let status: RoomBoardStatus;
  const fromBooking = roomBoardStatusFromBookingOverlap({ hasConfirmed, hasPending, manualStatus });
  if (fromBooking !== null) {
    status = fromBooking;
  } else if (closedOut) {
    status = "MAINTENANCE";
  } else if (manualStatus) {
    status = manualStatus;
  } else if (!unit.isActive) {
    status = "MAINTENANCE";
  } else if (beyondInventoryCap) {
    status = "MAINTENANCE";
  } else if (reservedFromInventoryUnitIds.has(unit.id)) {
    status = "RESERVED";
  } else if (aggregateAvailable <= 0) {
    status = "RESERVED";
  } else {
    status = "AVAILABLE";
  }
  const statusClass = getRoomBoardStatusClass(status);

  const effectiveFullName = booking?.guest.fullName ?? manualDetails?.fullName ?? "";
  const effectivePhone = booking?.guest.phoneE164 ?? manualDetails?.phone ?? "";
  const effectiveEmail = booking?.guest.email ?? manualDetails?.email ?? "";
  const effectiveNationality =
    (booking?.guest.nationality ?? "").trim() || (manualDetails?.nationality ?? "").trim() || "";
  const effectiveNotes = stripLegacyNationalityFromNotes(manualDetails?.notes ?? "");
  const effectiveAdults = manualDetails?.adults ?? (booking ? booking.adults : null);
  const effectiveChildren = manualDetails?.children ?? (booking ? booking.children : null);
  const effectiveMealPlan = manualDetails?.mealPlan ?? "NONE";
  const effectiveIdCardPath = manualDetails?.idCardPath ?? "";
  const paidAmount = booking
    ? booking.paymentIntents
        .filter((p) => p.status === PaymentStatus.SUCCEEDED)
        .reduce((sum, p) => sum + p.amount, 0)
    : 0;
  const bookingBalance = booking ? Math.max(0, booking.totalAmount - paidAmount) : 0;
  const latestPaymentIntent = booking?.paymentIntents[0];
  const effectivePaymentMethod = manualDetails?.paymentMethod || latestPaymentIntent?.kind || "";
  const effectivePaymentAmount = manualDetails?.paymentAmount ?? (booking ? paidAmount : null);
  const effectiveBalanceAmount = manualDetails?.balanceAmount ?? (booking ? bookingBalance : null);
  const effectiveTransactionNumber = manualDetails?.transactionNumber || latestPaymentIntent?.id || "";
  const effectiveBookedBy = manualDetails?.bookedBy || (booking?.source ? String(booking.source) : "");
  const effectiveTourCompany = manualDetails?.tourCompany || "";
  const sourceNote = booking
    ? `From booking ${displayBookingReference(booking)} (${booking.status}). Internal notes below are staff-only.`
    : "No linked booking on this date. Use the form to enter guest details manually.";

  const cur = booking?.currency ?? hotel.currency;
  const [folioRows, menuItemsFolio, folioSummary] = await Promise.all([
    booking
      ? prisma.folioTransaction.findMany({
          where: { hotelId: hotel.id, bookingId: booking.id },
          orderBy: { chargeDate: "desc" },
          include: {
            createdBy: { select: { fullName: true, email: true } },
            voidedBy: { select: { fullName: true, email: true } },
            parentTransaction: { select: { id: true, transactionType: true, itemName: true } }
          }
        })
      : Promise.resolve([]),
    prisma.menuItem.findMany({
      where: { hotelId: hotel.id, isActive: true },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, unitPrice: true, outletType: true, description: true }
    }),
    computeRoomUnitFolioSummary({
      hotelId: hotel.id,
      currency: cur,
      booking: booking ? { id: booking.id, totalAmount: booking.totalAmount } : null,
      paymentIntentsSucceededTotal: paidAmount
    })
  ]);

  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const chargeDateInputDefault = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}`;

  const rudLedgerFilter = (r: (typeof folioRows)[number]): string => {
    if (r.transactionType === FolioTransactionType.PAYMENT) return "payment";
    if (r.transactionType === FolioTransactionType.REFUND) return "payment";
    if (r.transactionType === FolioTransactionType.ADJUSTMENT) return "adjustment";
    if (r.transactionType === FolioTransactionType.DISCOUNT) return "adjustment";
    if (r.transactionType === FolioTransactionType.ACTIVITY_CHARGE) return "activity";
    return "fnb";
  };
  const rudTypeLabel = (t: FolioTransactionType): string => {
    switch (t) {
      case FolioTransactionType.PAYMENT:
        return "Payment";
      case FolioTransactionType.REFUND:
        return "Refund";
      case FolioTransactionType.ADJUSTMENT:
        return "Adjustment";
      case FolioTransactionType.DISCOUNT:
        return "Discount";
      case FolioTransactionType.ACTIVITY_CHARGE:
        return "Activity";
      case FolioTransactionType.FNB_CHARGE:
        return "F&B";
      case FolioTransactionType.OTHER_SERVICE_CHARGE:
        return "Service";
      default:
        return String(t);
    }
  };
  const rudPayBadge = (voided: boolean, status: FolioTxnPaymentStatus): string => {
    if (voided) return `<span class="rud-badge rud-badge-voided">Voided</span>`;
    if (status === FolioTxnPaymentStatus.PAID) return `<span class="rud-badge rud-badge-paid">Paid</span>`;
    if (status === FolioTxnPaymentStatus.UNPAID)
      return `<span class="rud-badge rud-badge-unpaid" title="Posted to guest folio, not yet settled">Unpaid</span>`;
    if (status === FolioTxnPaymentStatus.REFUNDED)
      return `<span class="rud-badge rud-badge-refunded">Refunded</span>`;
    if (status === FolioTxnPaymentStatus.PENDING)
      return `<span class="rud-badge rud-badge-neutral">Pending</span>`;
    if (status === FolioTxnPaymentStatus.PARTIALLY_PAID)
      return `<span class="rud-badge rud-badge-neutral">Partial</span>`;
    return `<span class="rud-badge rud-badge-neutral">${escapeHtml(status)}</span>`;
  };
  const outletLabel = (o: string) =>
    o === "RESTAURANT"
      ? "Restaurant"
      : o === "CAFE"
        ? "Café"
        : o === "ACTIVITY"
          ? "Activity"
          : o === "ROOM_SERVICE"
            ? "Room service"
            : "Other";

  const roomLedgerSearch = booking
    ? `room accommodation booking ${displayBookingReference(booking)} ${booking.id} ${unit.name}`.toLowerCase()
    : "";
  const roomLedgerRow = booking
    ? `<tr class="rud-ledger-row" data-ledger-kind="room" data-ledger-search="${escapeHtml(roomLedgerSearch)}">
        <td>${escapeHtml(formatDate(booking.checkIn))} → ${escapeHtml(formatDate(booking.checkOut))}</td>
        <td><span class="rud-badge rud-badge-room">Room</span></td>
        <td>—</td>
        <td><strong>Accommodation</strong> <span class="muted">· ${booking.nights} night${booking.nights === 1 ? "" : "s"} · ref ${escapeHtml(displayBookingReference(booking))}</span></td>
        <td style="text-align:right">1</td>
        <td style="text-align:right">—</td>
        <td style="text-align:right;font-weight:700">${formatMoney(booking.totalAmount, cur)}</td>
        <td><span class="rud-badge rud-badge-neutral">On folio</span></td>
        <td class="muted">—</td>
        <td class="muted">—</td>
        <td>${escapeHtml(displayBookingReference(booking))}</td>
        <td class="muted">—</td>
        <td class="muted">—</td>
      </tr>`
    : "";

  const folioActivityRows =
    roomLedgerRow +
    folioRows
      .map((r) => {
        const voided = Boolean(r.voidedAt);
        const staff = r.createdBy?.fullName ?? r.createdBy?.email ?? "—";
        const kind = rudLedgerFilter(r);
        const lineTotal =
          r.transactionType === FolioTransactionType.PAYMENT || r.transactionType === FolioTransactionType.REFUND
            ? r.grossAmount
            : r.netAmount;
        const search = [
          r.itemName,
          r.description,
          r.outletCategory,
          rudTypeLabel(r.transactionType),
          staff,
          r.referenceNumber,
          r.folioPaymentMethod,
          r.notes
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const payMethodCell =
          r.transactionType === FolioTransactionType.PAYMENT || r.transactionType === FolioTransactionType.REFUND
            ? escapeHtml(r.folioPaymentMethod ?? "—")
            : "—";
        const refNoteParts: string[] = [];
        if (r.referenceNumber) refNoteParts.push(`Ref: ${escapeHtml(r.referenceNumber)}`);
        if (r.notes) refNoteParts.push(`<span class="muted">${escapeHtml(r.notes.length > 100 ? `${r.notes.slice(0, 100)}…` : r.notes)}</span>`);
        if (r.parentTransactionId && r.parentTransaction) {
          refNoteParts.push(
            `<span class="muted" title="Linked parent line">↩ ${escapeHtml(rudTypeLabel(r.parentTransaction.transactionType))} · ${escapeHtml(r.parentTransaction.itemName.slice(0, 40))}</span>`
          );
        }
        const refNoteCell = refNoteParts.length ? refNoteParts.join("<br/>") : "—";
        const voidBtn =
          !voided && booking
            ? `<button type="button" class="btn-link rud-void-btn" data-txn-id="${escapeHtml(r.id)}">Void transaction</button>`
            : voided
              ? `<span class="muted" title="${escapeHtml(r.voidReason ?? "")}">—</span>`
              : "—";
        const postHuman =
          r.postingTarget === "GUEST_FOLIO"
            ? "Guest folio"
            : r.postingTarget === "ROOM_ACCOUNT"
              ? "Room account"
              : "Booking folio";
        return `<tr class="rud-ledger-row${voided ? " rud-ledger-voided" : ""}" data-ledger-kind="${escapeHtml(kind)}" data-ledger-search="${escapeHtml(search)}">
        <td>${formatDateTime(r.chargeDate)}</td>
        <td><span class="rud-badge rud-badge-type">${escapeHtml(rudTypeLabel(r.transactionType))}</span></td>
        <td>${escapeHtml(outletLabel(r.outletCategory))}</td>
        <td><strong>${escapeHtml(r.itemName)}</strong>${r.description ? `<br/><span class="muted" style="font-size:12px">${escapeHtml(r.description)}</span>` : ""}</td>
        <td style="text-align:right">${r.quantity}</td>
        <td style="text-align:right">${formatMoney(r.unitPrice, cur)}</td>
        <td style="text-align:right;font-weight:700">${formatMoney(lineTotal, cur)}</td>
        <td>${rudPayBadge(voided, r.folioPaymentStatus)}</td>
        <td>${payMethodCell}</td>
        <td style="font-size:12px;max-width:200px">${refNoteCell}</td>
        <td>${escapeHtml(postHuman)}</td>
        <td>${escapeHtml(staff)}</td>
        <td>${voidBtn}</td>
      </tr>`;
      })
      .join("");

  const recentLines = folioRows.filter((r) => !r.voidedAt).slice(0, 3);
  const recentSnapshotHtml =
    recentLines.length === 0 && !booking
      ? `<p class="muted" style="margin:0;font-size:13px">No recent folio lines yet.</p>`
      : `<ul class="rud-recent-list">
      ${
        booking
          ? `<li><span class="rud-recent-amt">${formatMoney(booking.totalAmount, cur)}</span> <span class="rud-recent-meta">Room · Accommodation</span></li>`
          : ""
      }
      ${recentLines
        .map((r) => {
          const amt =
            r.transactionType === FolioTransactionType.PAYMENT || r.transactionType === FolioTransactionType.REFUND
              ? r.grossAmount
              : r.netAmount;
          return `<li><span class="rud-recent-amt">${formatMoney(amt, cur)}</span> <span class="rud-recent-meta">${escapeHtml(rudTypeLabel(r.transactionType))} · ${escapeHtml(r.itemName)}</span></li>`;
        })
        .join("")}
    </ul>`;

  const folioMenuJson = JSON.stringify(
    menuItemsFolio.map((m) => ({
      id: m.id,
      name: m.name,
      unitPrice: m.unitPrice,
      outletType: m.outletType,
      description: m.description ?? ""
    }))
  );
  const canPostFolio = Boolean(booking);

  const bookingRefShort = booking ? escapeHtml(displayBookingReference(booking)) : "—";
  const stayCheck = booking
    ? `${escapeHtml(formatDate(booking.checkIn))} → ${escapeHtml(formatDate(booking.checkOut))}`
    : "—";
  const stayNights = booking ? String(booking.nights) : "—";
  const ledgerTbodyEmpty = !booking && folioRows.length === 0;

  const content = `
<div class="rud-page">
  <header class="rud-page-head">
    <div>
      <h2 class="rud-title">Room unit &amp; guest</h2>
      <p class="rud-sub muted">${escapeHtml(unit.name)} · ${escapeHtml(unit.roomType.name)} · Board date <strong>${escapeHtml(dateKey)}</strong></p>
    </div>
  </header>
  ${savedNotice}
  ${linkedRoomsBanner}
  <div id="folio-toast" class="rud-toast" role="status" aria-live="polite"></div>

  <nav class="rud-toolbar" aria-label="Page actions">
    <div class="rud-toolbar-row rud-toolbar-secondary">
      <a class="btn-link" href="/admin/profile">Back to Hotel Profile</a>
      <a class="btn-link primary" href="/admin/room-board?date=${dateKey}">Back to Room Board</a>
      ${rudChangeRoomLink}
      <a class="btn-link" href="/admin/room-board/unit/${encodeURIComponent(unit.id)}/invoice?date=${dateKey}">Open guest invoice</a>
      <form method="post" action="/admin/room-board/unit/${encodeURIComponent(unit.id)}/send-whatsapp" style="display:inline-flex;margin:0">
        <input type="hidden" name="date" value="${dateKey}" />
        <button type="submit" class="btn-link">Send invoice via WhatsApp</button>
      </form>
      ${
        editMode
          ? `<a class="btn-link" href="/admin/room-board/unit/${encodeURIComponent(unit.id)}/details?date=${dateKey}">Cancel edit</a>`
          : `<a class="btn-link" href="/admin/room-board/unit/${encodeURIComponent(unit.id)}/details?date=${dateKey}&edit=1">Edit</a>`
      }
    </div>
    <div class="rud-toolbar-row rud-toolbar-primary">
      <button type="button" class="rud-btn rud-btn-charge folio-open-charge" ${canPostFolio ? "" : "disabled"}>Post charge</button>
      <button type="button" class="rud-btn rud-btn-pay folio-open-payment" ${canPostFolio ? "" : "disabled"}>Add payment</button>
    </div>
  </nav>
  ${canPostFolio ? "" : `<p class="rud-banner-warn"><strong>No folio link.</strong> There is no active booking on <strong>${escapeHtml(dateKey)}</strong> for this unit. Post charge and Add payment stay disabled until a booking covers this night.</p>`}

  <div class="rud-layout">
    <div class="rud-main">
      <div class="rud-card-grid">
        <article class="rud-card rud-card-stay">
          <h3 class="rud-card-title">Stay summary</h3>
          <dl class="rud-dl">
            <div><dt>Unit</dt><dd>${escapeHtml(unit.name)}</dd></div>
            <div><dt>Room type</dt><dd>${escapeHtml(unit.roomType.name)}</dd></div>
            <div><dt>Property</dt><dd>${escapeHtml(unit.roomType.property.name)}</dd></div>
            <div><dt>Board date</dt><dd>${escapeHtml(dateKey)}</dd></div>
            <div><dt>Stay status</dt><dd><span class="room-board-badge ${statusClass}">${escapeHtml(status)}</span></dd></div>
            <div><dt>Booking reference</dt><dd><code class="rud-code">${bookingRefShort}</code></dd></div>
            <div><dt>Check-in / check-out</dt><dd>${stayCheck}</dd></div>
            <div><dt>Nights</dt><dd>${stayNights}</dd></div>
          </dl>
        </article>
        <article class="rud-card rud-card-guest">
          <h3 class="rud-card-title">Guest profile</h3>
          <dl class="rud-dl">
            <div><dt>Full name</dt><dd>${escapeHtml(effectiveFullName) || "—"}</dd></div>
            <div><dt>Phone</dt><dd>${escapeHtml(effectivePhone) || "—"}</dd></div>
            <div><dt>Email</dt><dd>${escapeHtml(effectiveEmail) || "—"}</dd></div>
            <div><dt>Booked by</dt><dd>${escapeHtml(effectiveBookedBy) || "—"}</dd></div>
            <div><dt>Tour company</dt><dd>${escapeHtml(effectiveTourCompany) || "—"}</dd></div>
            <div><dt>Adults / children</dt><dd>${effectiveAdults ?? "—"} / ${effectiveChildren ?? "—"}</dd></div>
            <div><dt>Nationality</dt><dd>${escapeHtml(effectiveNationality) || "—"}</dd></div>
            <div><dt>Meal plan</dt><dd>${escapeHtml(effectiveMealPlan === "NONE" ? "Room only" : effectiveMealPlan === "BREAKFAST" ? "Breakfast" : "Half board")}</dd></div>
          </dl>
          <p class="muted rud-card-foot">${escapeHtml(sourceNote)}</p>
        </article>
      </div>

      <article class="rud-card rud-card-form">
        <h3 class="rud-card-title">Registration &amp; on-file billing</h3>
        <p class="muted" style="margin-top:0;font-size:13px">Used for handover, invoices, and front-desk records. ${editMode ? "You are in edit mode." : "Select Edit to change."}</p>
        <form method="post" action="/admin/room-board/unit/${encodeURIComponent(unit.id)}/details" enctype="multipart/form-data" class="rud-form">
      <input type="hidden" name="date" value="${dateKey}" />
      <input type="hidden" name="existingIdCardPath" value="${escapeHtml(effectiveIdCardPath)}" />
      <label>Guest full name
        <input name="fullName" value="${escapeHtml(effectiveFullName)}" ${editMode ? "" : "readonly"} />
      </label>
      <label>Phone
        <input name="phone" value="${escapeHtml(effectivePhone)}" ${editMode ? "" : "readonly"} />
      </label>
      <label>Email
        <input name="email" value="${escapeHtml(effectiveEmail)}" ${editMode ? "" : "readonly"} />
      </label>
      <label>Nationality
        <input name="nationality" value="${escapeHtml(effectiveNationality)}" ${editMode ? "" : "readonly"} placeholder="As on passport" autocomplete="country-name" />
      </label>
      <div class="grid-2">
        <label>Booked by
          <select name="bookedBy" ${editMode ? "" : "disabled"}>
            <option value="WHATSAPP" ${effectiveBookedBy.toUpperCase() === "WHATSAPP" ? "selected" : ""}>WhatsApp</option>
            <option value="PHONE" ${effectiveBookedBy.toUpperCase() === "PHONE" ? "selected" : ""}>Phone</option>
            <option value="OTAS" ${effectiveBookedBy.toUpperCase() === "OTAS" ? "selected" : ""}>OTAs</option>
            <option value="WALK_IN" ${effectiveBookedBy.toUpperCase() === "WALK_IN" ? "selected" : ""}>Walk in</option>
            <option value="FRIEND_GIFT" ${effectiveBookedBy.toUpperCase() === "FRIEND_GIFT" ? "selected" : ""}>Friend gift</option>
            <option value="TOUR_COMPANY" ${effectiveBookedBy.toUpperCase() === "TOUR_COMPANY" ? "selected" : ""}>Tour company</option>
            ${
              effectiveBookedBy &&
              !["WHATSAPP", "PHONE", "OTAS", "WALK_IN", "FRIEND_GIFT", "TOUR_COMPANY"].includes(effectiveBookedBy.toUpperCase())
                ? `<option value="${escapeHtml(effectiveBookedBy)}" selected>${escapeHtml(effectiveBookedBy)}</option>`
                : ""
            }
          </select>
        </label>
        <label>Tour company
          <input name="tourCompany" value="${escapeHtml(effectiveTourCompany)}" ${editMode ? "" : "readonly"} />
        </label>
      </div>
      <div class="grid-2">
        <label>Adults
          <input type="number" min="0" name="adults" value="${effectiveAdults ?? ""}" ${editMode ? "" : "readonly"} />
        </label>
        <label>Children
          <input type="number" min="0" name="children" value="${effectiveChildren ?? ""}" ${editMode ? "" : "readonly"} />
        </label>
      </div>
      <label>Meal plan
        <select name="mealPlan" ${editMode ? "" : "disabled"}>
          <option value="NONE" ${effectiveMealPlan === "NONE" ? "selected" : ""}>None</option>
          <option value="BREAKFAST" ${effectiveMealPlan === "BREAKFAST" ? "selected" : ""}>Breakfast</option>
          <option value="HALF_BOARD" ${effectiveMealPlan === "HALF_BOARD" ? "selected" : ""}>Half board</option>
        </select>
      </label>
      <div class="grid-2">
        <label>Payment method
          <select name="paymentMethod" ${editMode ? "" : "disabled"}>
            <option value="CASH" ${effectivePaymentMethod.toUpperCase() === "CASH" ? "selected" : ""}>Cash</option>
            <option value="CARD" ${effectivePaymentMethod.toUpperCase() === "CARD" ? "selected" : ""}>Card</option>
            <option value="MBANKING" ${effectivePaymentMethod.toUpperCase() === "MBANKING" ? "selected" : ""}>mBanking</option>
            <option value="TRANSFER" ${effectivePaymentMethod.toUpperCase() === "TRANSFER" ? "selected" : ""}>Transfer</option>
            <option value="CREDIT" ${effectivePaymentMethod.toUpperCase() === "CREDIT" ? "selected" : ""}>Credit</option>
            <option value="LPO" ${effectivePaymentMethod.toUpperCase() === "LPO" ? "selected" : ""}>LPO</option>
            ${
              effectivePaymentMethod &&
              !["CASH", "CARD", "MBANKING", "TRANSFER", "CREDIT", "LPO"].includes(effectivePaymentMethod.toUpperCase())
                ? `<option value="${escapeHtml(effectivePaymentMethod)}" selected>${escapeHtml(effectivePaymentMethod)}</option>`
                : ""
            }
          </select>
        </label>
        <label>Transaction number
          <input name="transactionNumber" value="${escapeHtml(effectiveTransactionNumber)}" ${editMode ? "" : "readonly"} />
        </label>
      </div>
      <div class="grid-2">
        <label>Amount paid (${booking?.currency ?? "OMR"})
          <input type="number" step="0.001" min="0" name="paymentAmount" value="${effectivePaymentAmount ?? ""}" ${editMode ? "" : "readonly"} />
        </label>
        <label>Balance (${booking?.currency ?? "OMR"})
          <input type="number" step="0.001" min="0" name="balanceAmount" value="${effectiveBalanceAmount ?? ""}" ${editMode ? "" : "readonly"} />
        </label>
      </div>
      <label>ID card copy ${editMode ? '(upload)' : "(saved file)"}
        <input type="file" name="idCard" accept=".jpg,.jpeg,.png,.pdf,.webp" ${editMode ? "" : "disabled"} />
      </label>
      ${
        effectiveIdCardPath
          ? `<p class="muted" style="margin:0">Current ID copy: <a class="inline-link" target="_blank" href="${escapeHtml(effectiveIdCardPath)}">Open file</a></p>`
          : '<p class="muted" style="margin:0">No ID copy uploaded yet.</p>'
      }
      <label>Internal notes
        <textarea name="notes" rows="4" ${editMode ? "" : "readonly"}>${escapeHtml(effectiveNotes)}</textarea>
      </label>
      ${
        editMode
          ? '<button type="submit" class="rud-btn rud-btn-save">Save guest details</button>'
          : '<p class="muted" style="margin:0">Read-only — click <strong>Edit</strong> in the toolbar to change.</p>'
      }
    </form>
      </article>

      <section class="rud-ledger">
        <div class="rud-ledger-head">
          <div>
            <h3 class="rud-ledger-title">Guest ledger</h3>
            <p class="muted rud-ledger-desc">Posted charges, adjustments, and folio payments. Voided lines stay visible for audit and are excluded from balances.</p>
          </div>
        </div>
        <div class="rud-recent">
          <span class="rud-recent-label">Recent snapshot</span>
          ${recentSnapshotHtml}
        </div>
        <div class="rud-filter-bar">
          <span class="muted" style="font-size:12px;font-weight:600;margin-right:8px">Show:</span>
          <button type="button" class="rud-filter-chip active" data-filter="all">All</button>
          <button type="button" class="rud-filter-chip" data-filter="room">Room charges</button>
          <button type="button" class="rud-filter-chip" data-filter="fnb">F&amp;B</button>
          <button type="button" class="rud-filter-chip" data-filter="activity">Activities</button>
          <button type="button" class="rud-filter-chip" data-filter="payment">Payments</button>
          <button type="button" class="rud-filter-chip" data-filter="adjustment">Adjustments</button>
        </div>
        <label class="rud-search-wrap">Search ledger
          <input type="search" id="rud-ledger-search" class="rud-search-input" placeholder="Filter by item, staff, reference…" autocomplete="off" />
        </label>
        <div class="rud-table-wrap">
          <table class="rud-ledger-table">
            <thead>
              <tr>
                <th>Date / time</th>
                <th>Type</th>
                <th>Outlet</th>
                <th>Description</th>
                <th class="num">Qty</th>
                <th class="num">Unit price</th>
                <th class="num">Amount</th>
                <th>Status</th>
                <th>Pay method</th>
                <th>Reference / note</th>
                <th>Posted to</th>
                <th>Posted by</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${
              ledgerTbodyEmpty
                ? `<tr><td colspan="13" class="rud-table-empty">No ledger lines yet. Use <strong>Post charge</strong> or <strong>Add payment</strong> when a booking is linked.</td></tr>`
                : folioActivityRows
            }</tbody>
          </table>
        </div>
      </section>
    </div>

    <aside class="rud-sidebar">
      <div class="rud-card rud-card-fin">
        <h3 class="rud-card-title">Financial summary</h3>
        <p class="muted" style="margin-top:0;font-size:12px">Folio view for this booking. Menu F&amp;B: <a class="inline-link" href="/admin/fb/menu?bookingId=${booking ? escapeHtml(booking.id) : ""}">Open F&amp;B menu</a></p>
        <ul class="rud-fin-lines">
          <li><span>Room charges</span><strong>${formatMoney(folioSummary.roomCharges, cur)}</strong></li>
          <li><span>F&amp;B / extras</span><strong>${formatMoney(folioSummary.fnbExtrasTotal, cur)}</strong></li>
          <li class="muted" style="font-size:12px;padding-left:0;border:0"><span>· Menu posted</span><span>${formatMoney(folioSummary.fbMenuSubtotal, cur)}</span></li>
          <li class="muted" style="font-size:12px;padding-left:0;border:0"><span>· Folio lines</span><span>${formatMoney(folioSummary.folioChargesSubtotal, cur)}</span></li>
          <li><span>Discounts / adjustments</span><strong class="${folioSummary.folioAdjustmentsSubtotal < 0 ? "rud-neg" : ""}">${formatMoney(folioSummary.folioAdjustmentsSubtotal, cur)}</strong></li>
          <li class="rud-fin-total"><span>Total charges</span><strong>${formatMoney(folioSummary.totalCharges, cur)}</strong></li>
          <li><span>Amount paid</span><strong>${formatMoney(folioSummary.totalPaid, cur)}</strong></li>
          <li class="muted" style="font-size:12px;padding-left:0;border:0"><span>· On booking</span><span>${formatMoney(folioSummary.amountPaidBooking, cur)}</span></li>
          <li class="muted" style="font-size:12px;padding-left:0;border:0"><span>· Folio payments</span><span>${formatMoney(folioSummary.amountPaidFolio, cur)}</span></li>
        </ul>
        <div class="rud-outstanding">
          <div class="rud-outstanding-label">Outstanding balance</div>
          <div class="rud-outstanding-value">${formatMoney(folioSummary.outstandingBalance, cur)}</div>
          <p class="muted" style="margin:8px 0 0;font-size:11px">Charge to room items are unpaid until settled or recorded via <strong>Add payment</strong>.</p>
        </div>
      </div>
    </aside>
  </div>
</div>

<div id="folio-modal-backdrop" class="rud-drawer-backdrop" style="display:none" aria-hidden="true"></div>
<div id="folio-charge-modal" class="rud-drawer" style="display:none" role="dialog" aria-modal="true" aria-labelledby="folio-charge-title" aria-hidden="true">
  <div class="rud-drawer-sheet">
    <div class="rud-drawer-head">
      <div>
        <p class="rud-drawer-kicker muted">Guest ledger</p>
        <h3 id="folio-charge-title" class="rud-drawer-title">Post charge</h3>
        <p class="rud-drawer-context muted">${escapeHtml(unit.name)}${
          booking ? " · " + bookingRefShort + " · " + stayCheck : ""
        }</p>
      </div>
      <button type="button" class="rud-drawer-close" data-close-charge aria-label="Close">&times;</button>
    </div>
    <form id="folio-charge-form" class="rud-drawer-form">
      <div class="rud-drawer-scroll">
      <input type="hidden" name="date" value="${dateKey}" />
      <select id="folio-charge-category" name="chargeCategory" class="rud-sr-only" tabindex="-1" aria-hidden="true">
        <option value="RESTAURANT">Restaurant</option>
        <option value="CAFE">Café</option>
        <option value="ACTIVITY">Activity</option>
        <option value="ROOM_SERVICE">Room service</option>
        <option value="OTHER_SERVICE">Other</option>
        <option value="CUSTOM">Custom</option>
      </select>
      <div class="rud-field">
        <span class="rud-field-label">Outlet</span>
        <div class="rud-outlet-chips" role="group" aria-label="Outlet">
          <button type="button" class="rud-outlet-chip active" data-category="RESTAURANT">Restaurant</button>
          <button type="button" class="rud-outlet-chip" data-category="CAFE">Café</button>
          <button type="button" class="rud-outlet-chip" data-category="ACTIVITY">Activity</button>
          <button type="button" class="rud-outlet-chip" data-category="ROOM_SERVICE">Room service</button>
          <button type="button" class="rud-outlet-chip" data-category="OTHER_SERVICE">Other</button>
        </div>
      </div>
      <fieldset class="rud-fieldset">
        <legend class="rud-field-label">Line source</legend>
        <div class="rud-seg">
          <label class="rud-seg-item"><input type="radio" name="folioMode" value="catalog" checked /> Menu item</label>
          <label class="rud-seg-item"><input type="radio" name="folioMode" value="custom" /> Custom</label>
        </div>
      </fieldset>
      <div id="folio-catalog-block">
        <label class="rud-field">Search item
          <input type="text" id="folio-catalog-search" class="rud-input" list="folio-menu-datalist" placeholder="Type to filter menu…" autocomplete="off" />
          <datalist id="folio-menu-datalist">${menuItemsFolio.map((m) => `<option value="${escapeHtml(m.name)}"></option>`).join("")}</datalist>
        </label>
        <input type="hidden" id="folio-menu-item-id" value="" />
        <p class="muted rud-hint">Match a catalog line for instant price, or switch to Custom.</p>
      </div>
      <div id="folio-custom-block" class="rud-hidden">
        <label class="rud-field">Item name <span class="rud-req">*</span>
          <input type="text" id="folio-custom-name" class="rud-input" />
        </label>
        <label class="rud-field">Description
          <input type="text" id="folio-custom-desc" class="rud-input" />
        </label>
        <label class="rud-field">Unit price (${escapeHtml(cur)}) <span class="rud-req">*</span>
          <input type="number" id="folio-custom-price" class="rud-input" min="0" step="0.01" />
        </label>
      </div>
      <div class="rud-field">
        <span class="rud-field-label">Quantity</span>
        <div class="rud-stepper">
          <button type="button" class="rud-stepper-btn" id="folio-qty-minus" aria-label="Decrease quantity">−</button>
          <input type="number" id="folio-qty" name="quantity" class="rud-stepper-input" min="1" max="999" value="1" />
          <button type="button" class="rud-stepper-btn" id="folio-qty-plus" aria-label="Increase quantity">+</button>
        </div>
      </div>
      <div class="rud-line-total">
        <span>Line total</span>
        <strong id="folio-line-total">0.00 ${escapeHtml(cur)}</strong>
      </div>
      <label class="rud-field">Charge date / time
        <input type="datetime-local" id="folio-charge-when" class="rud-input" value="${chargeDateInputDefault}" />
      </label>
      <label class="rud-field">Posting target
        <select id="folio-post-target" class="rud-input">
          <option value="BOOKING_ACCOUNT" selected>Guest folio (booking)</option>
          <option value="GUEST_FOLIO">Guest folio</option>
          <option value="ROOM_ACCOUNT">Room account</option>
        </select>
      </label>
      <div class="rud-field">
        <span class="rud-field-label">Payment status</span>
        <div class="rud-pay-chips" role="group" aria-label="Payment status">
          <button type="button" class="rud-pay-chip active" data-paid="0">Charge to room</button>
          <button type="button" class="rud-pay-chip" data-paid="1">Paid</button>
        </div>
        <input type="checkbox" id="folio-paid-now" class="rud-sr-only" tabindex="-1" />
      </div>
      <div id="folio-paid-fields" class="rud-hidden">
        <label class="rud-field">Payment method
          <select id="folio-pay-method" class="rud-input">
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="MIXED">Mixed</option>
          </select>
        </label>
      </div>
      <label class="rud-field">Reference (optional)
        <input type="text" id="folio-ref" class="rud-input" maxlength="120" />
      </label>
      <label class="rud-field">Notes
        <textarea id="folio-notes" class="rud-input rud-textarea" rows="2"></textarea>
      </label>
      <p id="folio-charge-err" class="rud-form-err badge alert" style="display:none"></p>
      </div>
      <div class="rud-drawer-actions" role="group" aria-label="Charge actions">
        <button type="button" class="btn-link rud-drawer-cancel" data-close-charge>Cancel</button>
        <button type="submit" class="rud-drawer-submit rud-drawer-submit-charge">Post charge</button>
      </div>
    </form>
  </div>
</div>

<div id="folio-payment-modal" class="rud-drawer rud-drawer-pay" style="display:none" role="dialog" aria-modal="true" aria-labelledby="folio-pay-title" aria-hidden="true">
  <div class="rud-drawer-sheet">
    <div class="rud-drawer-head">
      <div>
        <p class="rud-drawer-kicker muted">Guest ledger</p>
        <h3 id="folio-pay-title" class="rud-drawer-title">Add payment</h3>
        <p class="rud-drawer-context muted">${escapeHtml(unit.name)}${
          booking ? " · " + bookingRefShort + " · " + stayCheck : ""
        }</p>
      </div>
      <button type="button" class="rud-drawer-close" data-close-payment aria-label="Close">&times;</button>
    </div>
    <form id="folio-payment-form" class="rud-drawer-form">
      <div class="rud-drawer-scroll">
      <input type="hidden" name="date" value="${dateKey}" />
      <label class="rud-field">Amount (${escapeHtml(cur)}) <span class="rud-req">*</span>
        <input type="number" id="folio-pay-amount" class="rud-input" min="0.01" step="0.01" required />
      </label>
      <label class="rud-field">Payment method
        <select id="folio-pay-method2" class="rud-input">
          <option value="CASH">Cash</option>
          <option value="CARD">Card</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
        </select>
      </label>
      <label class="rud-field">Applies to
        <select id="folio-pay-post-target" class="rud-input">
          <option value="BOOKING_ACCOUNT" selected>Guest folio (booking)</option>
          <option value="GUEST_FOLIO">Guest folio</option>
          <option value="ROOM_ACCOUNT">Room account</option>
        </select>
      </label>
      <label class="rud-field">Date / time
        <input type="datetime-local" id="folio-pay-when" class="rud-input" value="${chargeDateInputDefault}" />
      </label>
      <label class="rud-field">Reference (optional)
        <input type="text" id="folio-pay-ref" class="rud-input" maxlength="120" />
      </label>
      <label class="rud-field">Notes
        <textarea id="folio-pay-notes" class="rud-input rud-textarea" rows="2"></textarea>
      </label>
      <p id="folio-pay-err" class="rud-form-err badge alert" style="display:none"></p>
      </div>
      <div class="rud-drawer-actions" role="group" aria-label="Payment actions">
        <button type="button" class="btn-link rud-drawer-cancel" data-close-payment>Cancel</button>
        <button type="submit" class="rud-drawer-submit rud-drawer-submit-pay">Add payment</button>
      </div>
    </form>
  </div>
</div>

<script>
(function () {
  var unitId = ${JSON.stringify(unit.id)};
  var dateKey = ${JSON.stringify(dateKey)};
  var currency = ${JSON.stringify(cur)};
  var canPost = ${canPostFolio ? "true" : "false"};
  var menuCatalog = ${folioMenuJson};
  var currentLedgerFilter = "all";
  function showToast(msg, isWarn) {
    var el = document.getElementById("folio-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("rud-toast-warn", !!isWarn);
    el.classList.add("rud-toast-visible");
    el.style.display = "block";
    setTimeout(function () {
      el.classList.remove("rud-toast-visible", "rud-toast-warn");
      el.style.display = "none";
    }, isWarn ? 9000 : 4000);
  }
  function openBackdrop(on) {
    var b = document.getElementById("folio-modal-backdrop");
    if (b) {
      b.style.display = on ? "block" : "none";
      b.setAttribute("aria-hidden", on ? "false" : "true");
    }
    document.body.classList.toggle("rud-drawer-open", !!on);
  }
  function closeAllDrawers() {
    var ch = document.getElementById("folio-charge-modal");
    var pay = document.getElementById("folio-payment-modal");
    if (ch) { ch.style.display = "none"; ch.setAttribute("aria-hidden", "true"); }
    if (pay) { pay.style.display = "none"; pay.setAttribute("aria-hidden", "true"); }
    openBackdrop(false);
  }
  function openChargeDrawer() {
    closeAllDrawers();
    openBackdrop(true);
    var m = document.getElementById("folio-charge-modal");
    if (m) { m.style.display = "block"; m.setAttribute("aria-hidden", "false"); }
  }
  function openPaymentDrawer() {
    closeAllDrawers();
    openBackdrop(true);
    var m = document.getElementById("folio-payment-modal");
    if (m) { m.style.display = "block"; m.setAttribute("aria-hidden", "false"); }
  }
  document.querySelectorAll(".folio-open-charge").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!canPost) return;
      openChargeDrawer();
    });
  });
  document.querySelectorAll(".folio-open-payment").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!canPost) return;
      openPaymentDrawer();
    });
  });
  document.querySelectorAll("[data-close-charge]").forEach(function (btn) {
    btn.addEventListener("click", function () { closeAllDrawers(); });
  });
  document.querySelectorAll("[data-close-payment]").forEach(function (btn) {
    btn.addEventListener("click", function () { closeAllDrawers(); });
  });
  var backdrop = document.getElementById("folio-modal-backdrop");
  if (backdrop) {
    backdrop.addEventListener("click", function () { closeAllDrawers(); });
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") closeAllDrawers();
  });
  var catSel = document.getElementById("folio-charge-category");
  document.querySelectorAll(".rud-outlet-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      document.querySelectorAll(".rud-outlet-chip").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      var v = chip.getAttribute("data-category");
      if (catSel && v) catSel.value = v;
    });
  });
  function syncPaidUi() {
    var paidCb = document.getElementById("folio-paid-now");
    var pf = document.getElementById("folio-paid-fields");
    var on = paidCb && paidCb.checked;
    if (pf) pf.classList.toggle("rud-hidden", !on);
    document.querySelectorAll(".rud-pay-chip").forEach(function (c) {
      var want = c.getAttribute("data-paid") === "1";
      c.classList.toggle("active", want === !!on);
    });
  }
  document.querySelectorAll(".rud-pay-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var paid = chip.getAttribute("data-paid") === "1";
      var paidCb = document.getElementById("folio-paid-now");
      if (paidCb) paidCb.checked = paid;
      syncPaidUi();
    });
  });
  var paidCb = document.getElementById("folio-paid-now");
  if (paidCb) paidCb.addEventListener("change", syncPaidUi);
  syncPaidUi();
  function syncMode() {
    var mode = (document.querySelector('input[name="folioMode"]:checked') || {}).value || "catalog";
    var cat = document.getElementById("folio-catalog-block");
    var cust = document.getElementById("folio-custom-block");
    if (cat) cat.classList.toggle("rud-hidden", mode !== "catalog");
    if (cust) cust.classList.toggle("rud-hidden", mode !== "custom");
    recalcLine();
  }
  document.querySelectorAll('input[name="folioMode"]').forEach(function (r) {
    r.addEventListener("change", syncMode);
  });
  function findMenuByName(name) {
    var n = (name || "").trim().toLowerCase();
    if (!n) return null;
    for (var i = 0; i < menuCatalog.length; i++) {
      if (menuCatalog[i].name.toLowerCase() === n) return menuCatalog[i];
    }
    return null;
  }
  var catSearch = document.getElementById("folio-catalog-search");
  var menuIdEl = document.getElementById("folio-menu-item-id");
  if (catSearch) {
    catSearch.addEventListener("input", function () {
      var m = findMenuByName(catSearch.value);
      if (menuIdEl) menuIdEl.value = m ? m.id : "";
      recalcLine();
    });
    catSearch.addEventListener("change", function () {
      var m = findMenuByName(catSearch.value);
      if (menuIdEl) menuIdEl.value = m ? m.id : "";
      recalcLine();
    });
  }
  var qtyEl = document.getElementById("folio-qty");
  function bumpQty(delta) {
    if (!qtyEl) return;
    var q = parseInt(qtyEl.value, 10);
    if (!isFinite(q)) q = 1;
    q = Math.min(999, Math.max(1, q + delta));
    qtyEl.value = String(q);
    recalcLine();
  }
  var qm = document.getElementById("folio-qty-minus");
  var qp = document.getElementById("folio-qty-plus");
  if (qm) qm.addEventListener("click", function () { bumpQty(-1); });
  if (qp) qp.addEventListener("click", function () { bumpQty(1); });
  ["folio-qty", "folio-custom-price"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", recalcLine);
  });
  function recalcLine() {
    var mode = (document.querySelector('input[name="folioMode"]:checked') || {}).value || "catalog";
    var qty = parseFloat(qtyEl && qtyEl.value, 10);
    if (!isFinite(qty) || qty < 1) qty = 1;
    var unit = 0;
    if (mode === "catalog") {
      var m = findMenuByName(catSearch && catSearch.value);
      unit = m ? Number(m.unitPrice) : 0;
    } else {
      unit = parseFloat(document.getElementById("folio-custom-price") && document.getElementById("folio-custom-price").value, 10);
      if (!isFinite(unit)) unit = 0;
    }
    var total = Math.round(qty * unit * 100) / 100;
    var out = document.getElementById("folio-line-total");
    if (out) out.textContent = total.toFixed(2) + " " + currency;
  }
  syncMode();
  recalcLine();
  var chargeForm = document.getElementById("folio-charge-form");
  if (chargeForm) {
    chargeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var US = window.UIState;
      if (US && !US.beginSubmitGuard(chargeForm)) return;
      var submitBtn = chargeForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.setAttribute("data-ui-state-disabled", "1");
      }
      var err = document.getElementById("folio-charge-err");
      if (err) { err.style.display = "none"; err.textContent = ""; }
      var mode = (document.querySelector('input[name="folioMode"]:checked') || {}).value || "catalog";
      var body = {
        date: dateKey,
        chargeCategory: document.getElementById("folio-charge-category") && document.getElementById("folio-charge-category").value,
        mode: mode,
        menuItemId: menuIdEl && menuIdEl.value ? menuIdEl.value : undefined,
        itemName: document.getElementById("folio-custom-name") && document.getElementById("folio-custom-name").value,
        description: document.getElementById("folio-custom-desc") && document.getElementById("folio-custom-desc").value,
        unitPrice: document.getElementById("folio-custom-price") && document.getElementById("folio-custom-price").value,
        quantity: document.getElementById("folio-qty") && document.getElementById("folio-qty").value,
        chargeDate: document.getElementById("folio-charge-when") && document.getElementById("folio-charge-when").value,
        postingTarget: document.getElementById("folio-post-target") && document.getElementById("folio-post-target").value,
        paidNow: document.getElementById("folio-paid-now") && document.getElementById("folio-paid-now").checked,
        folioPaymentMethod: document.getElementById("folio-pay-method") && document.getElementById("folio-pay-method").value,
        referenceNumber: document.getElementById("folio-ref") && document.getElementById("folio-ref").value,
        notes: document.getElementById("folio-notes") && document.getElementById("folio-notes").value
      };
      if (mode === "catalog") {
        body.itemName = catSearch ? catSearch.value : "";
        delete body.unitPrice;
      }
      function doFetch() {
        return fetch("/admin/room-board/unit/" + encodeURIComponent(unitId) + "/folio/charge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.ok) {
            var msg = "Posted to guest ledger.";
            if (j.outletNotifyWarning) msg += " " + j.outletNotifyWarning;
            showToast(msg, !!j.outletNotifyWarning);
            window.location.reload();
          } else {
            if (err) { err.textContent = j.error || "Failed"; err.style.display = "block"; }
          }
        }).catch(function () {
          if (err) { err.textContent = "Network error"; err.style.display = "block"; }
        });
      }
      function release() {
        if (US) US.endSubmitGuard(chargeForm);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.removeAttribute("data-ui-state-disabled");
        }
      }
      var p =
        US && US.withBlocking
          ? US.withBlocking(doFetch, "folio-charge", { timeoutMs: 60000, timeoutLabel: "folio-charge" })
          : doFetch();
      Promise.resolve(p).catch(function () {}).finally(release);
    });
  }
  var payForm = document.getElementById("folio-payment-form");
  if (payForm) {
    payForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var US = window.UIState;
      if (US && !US.beginSubmitGuard(payForm)) return;
      var submitBtn = payForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.setAttribute("data-ui-state-disabled", "1");
      }
      var err = document.getElementById("folio-pay-err");
      if (err) { err.style.display = "none"; }
      var pt = document.getElementById("folio-pay-post-target");
      var body = {
        date: dateKey,
        amount: document.getElementById("folio-pay-amount") && document.getElementById("folio-pay-amount").value,
        folioPaymentMethod: document.getElementById("folio-pay-method2") && document.getElementById("folio-pay-method2").value,
        chargeDate: document.getElementById("folio-pay-when") && document.getElementById("folio-pay-when").value,
        referenceNumber: document.getElementById("folio-pay-ref") && document.getElementById("folio-pay-ref").value,
        notes: document.getElementById("folio-pay-notes") && document.getElementById("folio-pay-notes").value,
        postingTarget: pt && pt.value ? pt.value : "BOOKING_ACCOUNT"
      };
      function doFetch() {
        return fetch("/admin/room-board/unit/" + encodeURIComponent(unitId) + "/folio/payment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.ok) {
            showToast("Payment added — balance updated.");
            window.location.reload();
          } else {
            if (err) { err.textContent = j.error || "Failed"; err.style.display = "block"; }
          }
        }).catch(function () {
          if (err) { err.textContent = "Network error"; err.style.display = "block"; }
        });
      }
      function release() {
        if (US) US.endSubmitGuard(payForm);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.removeAttribute("data-ui-state-disabled");
        }
      }
      var p =
        US && US.withBlocking
          ? US.withBlocking(doFetch, "folio-payment", { timeoutMs: 60000, timeoutLabel: "folio-payment" })
          : doFetch();
      Promise.resolve(p).catch(function () {}).finally(release);
    });
  }
  function applyLedgerFilter() {
    var inp = document.getElementById("rud-ledger-search");
    var q = ((inp && inp.value) || "").toLowerCase().trim();
    document.querySelectorAll("tr.rud-ledger-row").forEach(function (tr) {
      var kind = tr.getAttribute("data-ledger-kind") || "";
      var search = (tr.getAttribute("data-ledger-search") || "").toLowerCase();
      var okKind = currentLedgerFilter === "all" || kind === currentLedgerFilter;
      var okSearch = !q || search.indexOf(q) !== -1;
      tr.style.display = okKind && okSearch ? "" : "none";
    });
  }
  document.querySelectorAll(".rud-filter-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      document.querySelectorAll(".rud-filter-chip").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      currentLedgerFilter = chip.getAttribute("data-filter") || "all";
      applyLedgerFilter();
    });
  });
  var ledgerSearch = document.getElementById("rud-ledger-search");
  if (ledgerSearch) {
    ledgerSearch.addEventListener("input", applyLedgerFilter);
  }
  document.querySelectorAll(".rud-void-btn, .folio-void-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.getAttribute("data-txn-id");
      if (!id) return;
      var reason = window.prompt("Reason to void this transaction? (required for audit)");
      if (!reason || !reason.trim()) return;
      fetch("/admin/room-board/unit/" + encodeURIComponent(unitId) + "/folio/" + encodeURIComponent(id) + "/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateKey, reason: reason.trim() })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.ok) {
          showToast("Transaction voided.");
          window.location.reload();
        } else {
          window.alert(j.error || "Void failed");
        }
      });
    });
  });
})();
</script>

<style>
  .room-board-badge { display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:700; }
  .room-status-available { background:#dcfce7; color:#166534; border-color:#22c55e; }
  .room-status-reserved { background:#dbeafe; color:#1e40af; border-color:#3b82f6; }
  .room-status-occupied { background:#fee2e2; color:#991b1b; border-color:#ef4444; }
  .room-status-cleaning { background:#fef9c3; color:#854d0e; border-color:#eab308; }
  .room-status-maintenance { background:#f3e8ff; color:#6b21a8; border-color:#a855f7; }
  body.rud-drawer-open { overflow:hidden; }
  .rud-page { max-width:1280px; margin:0 auto; padding-bottom:48px; }
  .rud-page-head { margin-bottom:8px; }
  .rud-title { margin:0; font-size:1.5rem; font-weight:800; letter-spacing:-0.02em; color:#0f172a; }
  .rud-sub { margin:6px 0 0; font-size:14px; }
  #folio-toast.rud-toast { display:none; position:fixed; bottom:24px; right:24px; z-index:10050; background:#0f766e; color:#fff; padding:14px 20px; border-radius:10px; font-weight:600; box-shadow:0 12px 32px rgba(15,23,42,.25); max-width:420px; white-space:pre-wrap; }
  #folio-toast.rud-toast.rud-toast-warn { background:#b45309; }
  #folio-toast.rud-toast-visible { animation:rud-toast-in .25s ease; }
  @keyframes rud-toast-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  .rud-banner-warn { margin:12px 0 0; padding:12px 16px; border-radius:10px; background:#fffbeb; border:1px solid #fcd34d; color:#78350f; font-size:14px; }
  .rud-toolbar { display:flex; flex-direction:column; gap:10px; margin:16px 0 24px; }
  .rud-toolbar-row { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; }
  .rud-toolbar-secondary { padding-bottom:10px; border-bottom:1px solid #e2e8f0; }
  .rud-toolbar-primary { gap:12px; }
  .rud-btn { padding:10px 18px; border-radius:10px; border:0; font-weight:700; font-size:14px; cursor:pointer; transition:transform .08s ease, box-shadow .15s ease; }
  .rud-btn:disabled { opacity:.45; cursor:not-allowed; }
  .rud-btn-charge { background:linear-gradient(180deg,#0d9488,#0f766e); color:#fff; box-shadow:0 4px 14px rgba(15,118,110,.35); }
  .rud-btn-charge:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 6px 18px rgba(15,118,110,.4); }
  .rud-btn-pay { background:linear-gradient(180deg,#0284c7,#0369a1); color:#fff; box-shadow:0 4px 14px rgba(3,105,161,.35); }
  .rud-btn-pay:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 6px 18px rgba(3,105,161,.4); }
  .rud-btn-save { padding:9px 16px; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700; width:max-content; border:0; cursor:pointer; }
  .rud-layout { display:grid; grid-template-columns:1fr min(320px,34%); gap:28px; align-items:start; }
  @media (max-width:960px) { .rud-layout { grid-template-columns:1fr; } .rud-sidebar { order:-1; } }
  .rud-main { min-width:0; }
  .rud-card-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:16px; margin-bottom:20px; }
  @media (max-width:720px) { .rud-card-grid { grid-template-columns:1fr; } }
  .rud-card { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:18px 20px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
  .rud-card-title { margin:0 0 14px; font-size:15px; font-weight:800; color:#0f172a; letter-spacing:-0.01em; }
  .rud-card-foot { margin:14px 0 0; font-size:13px; }
  .rud-dl { margin:0; display:grid; gap:10px 20px; }
  .rud-dl > div { display:grid; grid-template-columns:minmax(100px,38%) 1fr; gap:10px; font-size:14px; border-bottom:1px solid #f1f5f9; padding-bottom:10px; }
  .rud-dl > div:last-child { border-bottom:0; padding-bottom:0; }
  .rud-dl dt { margin:0; color:#64748b; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .rud-dl dd { margin:0; font-weight:600; color:#1e293b; }
  .rud-code { font-size:12px; background:#f1f5f9; padding:2px 8px; border-radius:6px; }
  .rud-card-form { margin-bottom:24px; }
  .rud-form .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:640px) { .rud-form .grid-2 { grid-template-columns:1fr; } }
  .rud-form label { display:grid; gap:6px; font-size:13px; font-weight:600; color:#334155; margin-bottom:14px; }
  .rud-form input:not([type=file]), .rud-form select, .rud-form textarea { width:100%; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px; font-size:14px; box-sizing:border-box; }
  .rud-form input[type=file] { padding:8px; border:1px dashed #cbd5e1; border-radius:8px; }
  .rud-ledger { margin-top:8px; }
  .rud-ledger-head { margin-bottom:12px; }
  .rud-ledger-title { margin:0; font-size:1.1rem; font-weight:800; color:#0f172a; }
  .rud-ledger-desc { margin:6px 0 0; font-size:13px; }
  .rud-recent { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px 16px; margin-bottom:16px; }
  .rud-recent-label { display:block; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:#64748b; margin-bottom:8px; }
  .rud-recent-list { margin:0; padding:0; list-style:none; display:grid; gap:8px; }
  .rud-recent-list li { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; font-size:13px; }
  .rud-recent-amt { font-weight:800; color:#0f172a; }
  .rud-recent-meta { color:#64748b; }
  .rud-filter-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px; }
  .rud-filter-chip { padding:6px 12px; border-radius:999px; border:1px solid #cbd5e1; background:#fff; font-size:12px; font-weight:700; color:#475569; cursor:pointer; transition:background .15s,border-color .15s,color .15s; }
  .rud-filter-chip:hover { border-color:#94a3b8; color:#0f172a; }
  .rud-filter-chip.active { background:#0f172a; border-color:#0f172a; color:#fff; }
  .rud-search-wrap { display:grid; gap:6px; font-size:12px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:.04em; margin-bottom:12px; }
  .rud-search-input { padding:10px 14px; border:1px solid #cbd5e1; border-radius:10px; font-size:14px; width:100%; max-width:420px; box-sizing:border-box; }
  .rud-table-wrap { overflow-x:auto; border:1px solid #e2e8f0; border-radius:12px; background:#fff; }
  .rud-ledger-table { width:100%; border-collapse:collapse; font-size:13px; }
  .rud-ledger-table thead th { text-align:left; padding:12px 14px; background:#f8fafc; border-bottom:1px solid #e2e8f0; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; color:#64748b; white-space:nowrap; }
  .rud-ledger-table th.num, .rud-ledger-table td:nth-child(5), .rud-ledger-table td:nth-child(6), .rud-ledger-table td:nth-child(7) { text-align:right; }
  .rud-ledger-table tbody td { padding:12px 14px; border-bottom:1px solid #f1f5f9; vertical-align:top; color:#334155; }
  .rud-ledger-table tbody tr:last-child td { border-bottom:0; }
  .rud-table-empty { padding:28px 16px !important; text-align:center; color:#64748b; }
  .rud-ledger-voided { opacity:.55; }
  .rud-badge { display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; white-space:nowrap; }
  .rud-badge-unpaid { background:#fef3c7; color:#92400e; }
  .rud-badge-paid { background:#d1fae5; color:#065f46; }
  .rud-badge-voided { background:#f1f5f9; color:#64748b; }
  .rud-badge-refunded { background:#e0e7ff; color:#3730a3; }
  .rud-badge-neutral { background:#f1f5f9; color:#475569; }
  .rud-badge-room { background:#dbeafe; color:#1e40af; }
  .rud-badge-type { background:#ecfeff; color:#0e7490; }
  .rud-sidebar { position:sticky; top:16px; }
  .rud-card-fin { border-color:#cbd5e1; box-shadow:0 4px 20px rgba(15,23,42,.06); }
  .rud-fin-lines { list-style:none; margin:0; padding:0; }
  .rud-fin-lines li { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:10px 0; border-bottom:1px solid #f1f5f9; font-size:14px; }
  .rud-fin-lines li span:first-child { color:#64748b; }
  .rud-fin-total { font-weight:800; padding-top:12px !important; border-bottom:0 !important; font-size:15px; color:#0f172a; }
  .rud-fin-total strong { font-size:1.05rem; }
  .rud-neg { color:#b45309; }
  .rud-outstanding { margin-top:18px; padding:16px; border-radius:12px; background:linear-gradient(135deg,#fffbeb 0%,#fef3c7 100%); border:1px solid #fbbf24; }
  .rud-outstanding-label { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; color:#92400e; }
  .rud-outstanding-value { font-size:1.75rem; font-weight:900; color:#78350f; letter-spacing:-0.02em; margin-top:4px; }
  /* Panel shell: sticky head + scroll body + pinned action footer (reuse for future drawers). */
  .rud-drawer-backdrop { position:fixed; inset:0; background:rgba(15,23,42,.5); z-index:10040; }
  .rud-drawer { position:fixed; top:0; right:0; bottom:0; z-index:10045; width:min(440px,100%); max-width:100%; height:100dvh; max-height:100dvh; pointer-events:none; padding-bottom:env(safe-area-inset-bottom,0); box-sizing:border-box; }
  .rud-drawer > .rud-drawer-sheet { pointer-events:auto; }
  .rud-drawer-sheet { height:100%; max-height:100%; background:#fff; box-shadow:-12px 0 40px rgba(15,23,42,.18); display:flex; flex-direction:column; border-left:1px solid #e2e8f0; animation:rud-drawer-slide .22s ease; min-height:0; }
  @keyframes rud-drawer-slide { from { transform:translateX(12px); opacity:.92; } to { transform:translateX(0); opacity:1; } }
  .rud-drawer-head { flex-shrink:0; display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:16px 18px 14px; padding-top:max(16px,env(safe-area-inset-top,0)); border-bottom:1px solid #e2e8f0; background:linear-gradient(180deg,#fafafa,#fff); }
  .rud-drawer-kicker { margin:0 0 4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
  .rud-drawer-title { margin:0; font-size:1.15rem; font-weight:800; color:#0f172a; }
  .rud-drawer-context { margin:6px 0 0; font-size:12px; line-height:1.45; max-width:min(360px,100%); word-break:break-word; }
  .rud-drawer-close { border:0; background:#f1f5f9; min-width:44px; min-height:44px; width:44px; height:44px; border-radius:10px; font-size:1.35rem; line-height:1; cursor:pointer; color:#64748b; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
  .rud-drawer-close:hover { background:#e2e8f0; color:#0f172a; }
  .rud-drawer-form { flex:1; min-height:0; display:flex; flex-direction:column; }
  .rud-drawer-scroll { flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:16px 18px 20px; padding-bottom:calc(24px + env(safe-area-inset-bottom,0)); display:flex; flex-direction:column; gap:14px; }
  .rud-field { display:grid; gap:6px; margin:0; }
  .rud-field-label { font-size:12px; font-weight:700; color:#475569; text-transform:uppercase; letter-spacing:.04em; }
  .rud-fieldset { border:1px solid #e2e8f0; border-radius:10px; padding:12px 14px; margin:0; }
  .rud-fieldset .rud-field-label { padding:0 4px; }
  .rud-seg { display:flex; gap:16px; flex-wrap:wrap; margin-top:8px; }
  .rud-seg-item { font-size:13px; font-weight:600; color:#334155; display:flex; align-items:center; gap:8px; cursor:pointer; }
  .rud-outlet-chips { display:flex; flex-wrap:wrap; gap:8px; }
  .rud-outlet-chip { padding:8px 12px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; font-size:12px; font-weight:700; color:#475569; cursor:pointer; transition:all .12s ease; }
  .rud-outlet-chip:hover { border-color:#0d9488; color:#0f766e; }
  .rud-outlet-chip.active { background:#0f766e; border-color:#0f766e; color:#fff; }
  .rud-stepper { display:flex; align-items:center; gap:0; max-width:200px; border:1px solid #cbd5e1; border-radius:10px; overflow:hidden; background:#fff; }
  .rud-stepper-btn { width:44px; height:44px; border:0; background:#f8fafc; font-size:1.25rem; font-weight:700; color:#334155; cursor:pointer; }
  .rud-stepper-btn:hover { background:#e2e8f0; }
  .rud-stepper-input { width:56px; border:0; text-align:center; font-size:16px; font-weight:700; padding:8px; }
  .rud-line-total { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-radius:10px; background:#f0fdfa; border:1px solid #99f6e4; font-size:14px; color:#134e4a; }
  .rud-line-total strong { font-size:1.1rem; }
  .rud-pay-chips { display:flex; gap:8px; flex-wrap:wrap; }
  .rud-pay-chip { padding:8px 14px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; font-size:13px; font-weight:700; color:#475569; cursor:pointer; }
  .rud-pay-chip.active { background:#0f172a; border-color:#0f172a; color:#fff; }
  .rud-input, .rud-textarea { width:100%; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px; font-size:14px; box-sizing:border-box; }
  .rud-textarea { resize:vertical; min-height:64px; }
  .rud-hint { margin:4px 0 0; font-size:12px; }
  .rud-req { color:#b91c1c; }
  .rud-form-err { margin:0; }
  .rud-drawer-actions { flex-shrink:0; display:flex; justify-content:flex-end; align-items:center; flex-wrap:wrap; gap:12px; padding:12px 18px 14px; padding-bottom:max(14px,calc(10px + env(safe-area-inset-bottom,0))); border-top:1px solid #e2e8f0; background:#fff; box-shadow:0 -10px 28px rgba(15,23,42,.07); }
  .rud-drawer-cancel { min-height:44px; padding:8px 14px; display:inline-flex; align-items:center; font-size:14px; font-weight:600; }
  .rud-drawer-submit { min-height:44px; padding:11px 22px; border:0; border-radius:10px; font-weight:800; font-size:14px; cursor:pointer; }
  .rud-drawer-submit:disabled { opacity:.55; cursor:not-allowed; }
  .rud-drawer-submit-charge { background:#0f766e; color:#fff; }
  .rud-drawer-submit-pay { background:#0369a1; color:#fff; }
  .rud-hidden { display:none !important; }
  .rud-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  tr.folio-row-voided { opacity:0.55; }
</style>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/room-board/unit/:unitId/folio/charge", requirePermissionJson("ROOMS", "EDIT"), async (req, res) => {
  try {
    const staffId = requireHotelStaffIdForFolioJson(req, res);
    if (staffId === null) return;
    const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) {
      res.status(400).json({ ok: false, error: "Hotel not found" });
      return;
    }
    const unitId = String(req.params.unitId ?? "");
    const body = req.body as Record<string, unknown>;
    const dateKey = String(body.date ?? "").trim();
    const boardDate = parseDateInput(dateKey, startOfDay(new Date()));
    const unit = await prisma.roomUnit.findFirst({
      where: { id: unitId, hotelId: hotel.id },
      select: { id: true, roomTypeId: true }
    });
    if (!unit) {
      res.status(404).json({ ok: false, error: "Unit not found" });
      return;
    }
    const dateEndExclusive = addDays(boardDate, 1);
    const booking = await prisma.booking.findFirst({
      where: {
        hotelId: hotel.id,
        roomTypeId: unit.roomTypeId,
        roomUnitId: unit.id,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      }
    });
    if (!booking) {
      res.status(400).json({
        ok: false,
        error: "No active booking on this unit for the selected date. Link a booking before posting folio charges."
      });
      return;
    }
    const mode = String(body.mode ?? "custom") === "catalog" ? "catalog" : "custom";
    let itemName = String(body.itemName ?? "").trim();
    let description: string | null = String(body.description ?? "").trim() || null;
    let unitPrice =
      typeof body.unitPrice === "number" ? body.unitPrice : parseFloat(String(body.unitPrice ?? "NaN"));
    const qty = Math.min(999, Math.max(1, parseIntegerInput(body.quantity, 1)));
    let menuItemId: string | null = null;
    let outletCategory: FolioOutletCategory;
    let transactionType: FolioTransactionType;
    const categoryRaw = String(body.chargeCategory ?? "RESTAURANT").toUpperCase();
    const mapped = mapChargeCategoryToFolio(categoryRaw);
    outletCategory = mapped.outletCategory;
    transactionType = mapped.transactionType;
    if (mode === "catalog" && body.menuItemId) {
      const mid = String(body.menuItemId).trim();
      const mi = await prisma.menuItem.findFirst({
        where: { id: mid, hotelId: hotel.id, isActive: true }
      });
      if (mi) {
        menuItemId = mi.id;
        itemName = mi.name;
        unitPrice = mi.unitPrice;
        if (!description && mi.description) description = mi.description;
        outletCategory =
          mi.outletType === FbOutletType.COFFEE_SHOP ? FolioOutletCategory.CAFE : FolioOutletCategory.RESTAURANT;
        transactionType = FolioTransactionType.FNB_CHARGE;
      }
    }
    if (!itemName || !Number.isFinite(unitPrice) || unitPrice < 0) {
      res.status(400).json({ ok: false, error: "Item name and a valid unit price are required." });
      return;
    }
    const gross = round2(qty * unitPrice);
    const tax = 0;
    const paidNow = body.paidNow === true || body.paidNow === "1";
    const folioPaymentMethod = paidNow
      ? String(body.folioPaymentMethod ?? "CASH").trim().slice(0, 48) || "CASH"
      : null;
    const folioPaymentStatus = paidNow ? FolioTxnPaymentStatus.PAID : FolioTxnPaymentStatus.UNPAID;
    const chargeDateRaw = body.chargeDate ? new Date(String(body.chargeDate)) : new Date();
    const chargeDate = Number.isNaN(chargeDateRaw.getTime()) ? new Date() : chargeDateRaw;
    const postingTarget = parsePostingTarget(String(body.postingTarget ?? "BOOKING_ACCOUNT"));
    const folioNotes = String(body.notes ?? "").trim().slice(0, 2000) || null;
    const txn = await postChargeToFolio(prisma, {
      hotelId: hotel.id,
      bookingId: booking.id,
      guestId: booking.guestId,
      roomUnitId: unit.id,
      roomTypeId: unit.roomTypeId,
      currency: booking.currency,
      staffId,
      sourceType: FolioTxnSourceType.MANUAL_FRONTDESK,
      outletCategory,
      transactionType,
      menuItemId,
      itemName,
      description,
      quantity: qty,
      unitPrice,
      taxAmount: tax,
      postingTarget,
      folioPaymentStatus,
      folioPaymentMethod,
      referenceNumber: String(body.referenceNumber ?? "").trim().slice(0, 120) || null,
      chargeDate,
      notes: folioNotes
    });
    if (folioChargeQualifiesForOutletTicket(transactionType, outletCategory)) {
      try {
        await createOutletTicketForFolioCharge(prisma, {
          hotelId: hotel.id,
          bookingId: booking.id,
          guestId: booking.guestId,
          folioTransactionId: txn.id,
          outletCategory,
          notes: folioNotes
        });
      } catch (ticketErr) {
        console.error("[admin] outlet order ticket (folio)", ticketErr);
      }
    }
    await logAudit({
      hotelId: hotel.id,
      action: "FOLIO_CHARGE_POSTED",
      entityType: "FolioTransaction",
      entityId: txn.id,
      metadata: { bookingId: booking.id, roomUnitId: unit.id, gross }
    });
    const outletNotifyWarning = await notifyOutletForFolioCharge({
      hotelId: hotel.id,
      bookingId: booking.id,
      transactionType,
      outletCategory,
      itemName,
      quantity: qty,
      unitPrice,
      lineTotal: gross,
      currency: booking.currency,
      notes: folioNotes,
      chargeTime: chargeDate,
      folioTransactionId: txn.id
    });
    res.json({ ok: true, id: txn.id, outletNotifyWarning: outletNotifyWarning ?? undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Failed to post charge" });
  }
});

adminRouter.post("/room-board/unit/:unitId/folio/payment", requirePermissionJson("ROOMS", "EDIT"), async (req, res) => {
  try {
    const staffId = requireHotelStaffIdForFolioJson(req, res);
    if (staffId === null) return;
    const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) {
      res.status(400).json({ ok: false, error: "Hotel not found" });
      return;
    }
    const unitId = String(req.params.unitId ?? "");
    const body = req.body as Record<string, unknown>;
    const dateKey = String(body.date ?? "").trim();
    const boardDate = parseDateInput(dateKey, startOfDay(new Date()));
    const unit = await prisma.roomUnit.findFirst({
      where: { id: unitId, hotelId: hotel.id },
      select: { id: true, roomTypeId: true }
    });
    if (!unit) {
      res.status(404).json({ ok: false, error: "Unit not found" });
      return;
    }
    const dateEndExclusive = addDays(boardDate, 1);
    const booking = await prisma.booking.findFirst({
      where: {
        hotelId: hotel.id,
        roomTypeId: unit.roomTypeId,
        roomUnitId: unit.id,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      }
    });
    if (!booking) {
      res.status(400).json({ ok: false, error: "No active booking for this unit on the selected date." });
      return;
    }
    const amount =
      typeof body.amount === "number" ? body.amount : parseFloat(String(body.amount ?? "NaN"));
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ ok: false, error: "Enter a valid payment amount." });
      return;
    }
    const gross = round2(amount);
    const chargeDateRaw = body.chargeDate ? new Date(String(body.chargeDate)) : new Date();
    const chargeDate = Number.isNaN(chargeDateRaw.getTime()) ? new Date() : chargeDateRaw;
    const txn = await postPaymentToFolio(prisma, {
      hotelId: hotel.id,
      bookingId: booking.id,
      guestId: booking.guestId,
      roomUnitId: unit.id,
      roomTypeId: unit.roomTypeId,
      currency: booking.currency,
      staffId,
      amount: gross,
      folioPaymentMethod: String(body.folioPaymentMethod ?? "CASH").trim().slice(0, 48) || "CASH",
      postingTarget: parsePostingTarget(String(body.postingTarget ?? "BOOKING_ACCOUNT")),
      chargeDate,
      referenceNumber: String(body.referenceNumber ?? "").trim().slice(0, 120) || null,
      notes: String(body.notes ?? "").trim().slice(0, 2000) || null,
      sourceType: FolioTxnSourceType.MANUAL_FRONTDESK,
      allocateFifo: body.allocateFifo === true || body.allocateFifo === "1"
    });
    await logAudit({
      hotelId: hotel.id,
      action: "FOLIO_PAYMENT_POSTED",
      entityType: "FolioTransaction",
      entityId: txn.id,
      metadata: { bookingId: booking.id, amount: gross }
    });
    res.json({ ok: true, id: txn.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Failed to record payment" });
  }
});

adminRouter.post("/room-board/unit/:unitId/folio/:txnId/void", requirePermissionJson("ROOMS", "EDIT"), async (req, res) => {
  try {
    const staffId = requireHotelStaffIdForFolioJson(req, res);
    if (staffId === null) return;
    const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) {
      res.status(400).json({ ok: false, error: "Hotel not found" });
      return;
    }
    const unitId = String(req.params.unitId ?? "");
    const txnId = String(req.params.txnId ?? "");
    const body = req.body as Record<string, unknown>;
    const dateKey = String(body.date ?? "").trim();
    const boardDate = parseDateInput(dateKey, startOfDay(new Date()));
    const unit = await prisma.roomUnit.findFirst({
      where: { id: unitId, hotelId: hotel.id },
      select: { id: true, roomTypeId: true }
    });
    if (!unit) {
      res.status(404).json({ ok: false, error: "Unit not found" });
      return;
    }
    const dateEndExclusive = addDays(boardDate, 1);
    const booking = await prisma.booking.findFirst({
      where: {
        hotelId: hotel.id,
        roomTypeId: unit.roomTypeId,
        roomUnitId: unit.id,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      }
    });
    if (!booking) {
      res.status(400).json({ ok: false, error: "No active booking for this unit." });
      return;
    }
    const txn = await prisma.folioTransaction.findFirst({
      where: { id: txnId, hotelId: hotel.id, bookingId: booking.id }
    });
    if (!txn) {
      res.status(404).json({ ok: false, error: "Transaction not found on this folio." });
      return;
    }
    if (txn.voidedAt) {
      res.status(400).json({ ok: false, error: "Already voided." });
      return;
    }
    const reason = String(body.reason ?? "").trim().slice(0, 500) || "Voided";
    await voidFolioTransaction(prisma, {
      hotelId: hotel.id,
      bookingId: booking.id,
      transactionId: txnId,
      staffId,
      reason
    });
    try {
      await cancelOutletTicketForFolioTransaction(prisma, {
        hotelId: hotel.id,
        folioTransactionId: txnId
      });
    } catch (e) {
      console.error("[admin] cancel outlet ticket on void", e);
    }
    await logAudit({
      hotelId: hotel.id,
      action: "FOLIO_TXN_VOIDED",
      entityType: "FolioTransaction",
      entityId: txnId,
      metadata: { bookingId: booking.id, reason }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Void failed" });
  }
});

adminRouter.get("/api/bookings/:bookingId/folio", requirePermissionJson("BOOKINGS", "VIEW"), async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) {
      res.status(400).json({ ok: false, error: "Hotel not found" });
      return;
    }
    const bookingId = String(req.params.bookingId ?? "");
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, hotelId: hotel.id },
      select: { id: true }
    });
    if (!booking) {
      res.status(404).json({ ok: false, error: "Booking not found" });
      return;
    }
    const folio = await getFolioByBookingId(hotel.id, bookingId);
    res.json({ ok: true, folio });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Failed" });
  }
});

adminRouter.get("/api/bookings/:bookingId/folio/summary", requirePermissionJson("BOOKINGS", "VIEW"), async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) {
      res.status(400).json({ ok: false, error: "Hotel not found" });
      return;
    }
    const bookingId = String(req.params.bookingId ?? "");
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, hotelId: hotel.id },
      include: { paymentIntents: { orderBy: { createdAt: "desc" } } }
    });
    if (!booking) {
      res.status(404).json({ ok: false, error: "Booking not found" });
      return;
    }
    const paidAmount = booking.paymentIntents
      .filter((p) => p.status === PaymentStatus.SUCCEEDED)
      .reduce((sum, p) => sum + p.amount, 0);
    const summary = await getFolioSummary({
      hotelId: hotel.id,
      bookingId: booking.id,
      bookingTotalAmount: booking.totalAmount,
      currency: booking.currency,
      paymentIntentsSucceededTotal: paidAmount
    });
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Failed" });
  }
});

adminRouter.get("/api/bookings/:bookingId/folio/transactions", requirePermissionJson("BOOKINGS", "VIEW"), async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) {
      res.status(400).json({ ok: false, error: "Hotel not found" });
      return;
    }
    const bookingId = String(req.params.bookingId ?? "");
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, hotelId: hotel.id },
      select: { id: true }
    });
    if (!booking) {
      res.status(404).json({ ok: false, error: "Booking not found" });
      return;
    }
    const includeVoided = req.query.includeVoided === "1" || req.query.includeVoided === "true";
    const rows = await listFolioTransactions({
      hotelId: hotel.id,
      bookingId,
      includeVoided,
      take: Math.min(500, Math.max(1, parseInt(String(req.query.take ?? "200"), 10) || 200))
    });
    res.json({ ok: true, transactions: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Failed" });
  }
});

adminRouter.post("/api/bookings/:bookingId/folio/refund", requirePermissionJson("BILLING", "EDIT"), async (req, res) => {
  try {
    const staffId = requireHotelStaffIdForFolioJson(req, res);
    if (staffId === null) return;
    const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
    if (!hotel) {
      res.status(400).json({ ok: false, error: "Hotel not found" });
      return;
    }
    const bookingId = String(req.params.bookingId ?? "");
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, hotelId: hotel.id },
      select: { id: true, guestId: true, roomUnitId: true, roomTypeId: true, currency: true }
    });
    if (!booking) {
      res.status(404).json({ ok: false, error: "Booking not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const amount =
      typeof body.amount === "number" ? body.amount : parseFloat(String(body.amount ?? "NaN"));
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ ok: false, error: "Valid refund amount required." });
      return;
    }
    const parentId = String(body.parentTransactionId ?? "").trim();
    if (!parentId) {
      res.status(400).json({ ok: false, error: "parentTransactionId required." });
      return;
    }
    const chargeDateRaw = body.chargeDate ? new Date(String(body.chargeDate)) : new Date();
    const chargeDate = Number.isNaN(chargeDateRaw.getTime()) ? new Date() : chargeDateRaw;
    const txn = await postRefundToFolio(prisma, {
      hotelId: hotel.id,
      bookingId: booking.id,
      guestId: booking.guestId,
      roomUnitId: booking.roomUnitId,
      roomTypeId: booking.roomTypeId,
      currency: booking.currency,
      staffId,
      amount,
      parentTransactionId: parentId,
      folioPaymentMethod: String(body.folioPaymentMethod ?? "CASH"),
      chargeDate,
      referenceNumber: String(body.referenceNumber ?? "").trim().slice(0, 120) || null,
      notes: String(body.notes ?? "").trim().slice(0, 2000) || null
    });
    await logAudit({
      hotelId: hotel.id,
      action: "FOLIO_REFUND_POSTED",
      entityType: "FolioTransaction",
      entityId: txn.id,
      metadata: { bookingId: booking.id, parentTransactionId: parentId, amount }
    });
    res.json({ ok: true, id: txn.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "Refund failed" });
  }
});

adminRouter.post("/room-board/unit/:unitId/details", requirePermission("ROOMS", "EDIT"), idCardUpload.single("idCard"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/room-board");
    return;
  }
  const unitId = String(req.params.unitId ?? "");
  const boardDate = parseDateInput(req.body.date, startOfDay(new Date()));
  const dateKey = formatDateForInput(boardDate);
  const unit = await prisma.roomUnit.findFirst({
    where: { id: unitId, hotelId: hotel.id },
    select: { id: true }
  });
  if (!unit) {
    res.redirect(`/admin/room-board?date=${dateKey}`);
    return;
  }

  const fullName = String(req.body.fullName ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  const email = String(req.body.email ?? "").trim();
  const nationality = String(req.body.nationality ?? "").trim();
  const notes = String(req.body.notes ?? "").trim();
  const paymentMethod = String(req.body.paymentMethod ?? "").trim();
  const transactionNumber = String(req.body.transactionNumber ?? "").trim();
  const bookedBy = String(req.body.bookedBy ?? "").trim();
  const tourCompany = String(req.body.tourCompany ?? "").trim();
  const adultsRaw = String(req.body.adults ?? "").trim();
  const childrenRaw = String(req.body.children ?? "").trim();
  const paymentAmountRaw = String(req.body.paymentAmount ?? "").trim();
  const balanceAmountRaw = String(req.body.balanceAmount ?? "").trim();
  const adults = adultsRaw ? Math.max(0, parseIntegerInput(adultsRaw, 0)) : null;
  const children = childrenRaw ? Math.max(0, parseIntegerInput(childrenRaw, 0)) : null;
  const paymentAmount = paymentAmountRaw ? Math.max(0, parseNumberInput(paymentAmountRaw, 0)) : null;
  const balanceAmount = balanceAmountRaw ? Math.max(0, parseNumberInput(balanceAmountRaw, 0)) : null;
  const mealPlanRaw = String(req.body.mealPlan ?? "NONE").toUpperCase();
  const mealPlan = mealPlanRaw === "BREAKFAST" || mealPlanRaw === "HALF_BOARD" ? mealPlanRaw : "NONE";
  const uploadedPath = req.file ? `/static/uploads/id-cards/${req.file.filename}` : "";
  const existingIdCardPath = String(req.body.existingIdCardPath ?? "").trim();
  const idCardPath = uploadedPath || existingIdCardPath;

  const dateEndExclusive = addDays(boardDate, 1);
  const linkedBooking = await prisma.booking.findFirst({
    where: {
      hotelId: hotel.id,
      roomUnitId: unit.id,
      checkIn: { lt: dateEndExclusive },
      checkOut: { gt: boardDate },
      status: { in: ["CONFIRMED", "PENDING"] }
    },
    select: { id: true, guestId: true }
  });
  if (linkedBooking) {
    await prisma.guest.update({
      where: { id: linkedBooking.guestId },
      data: { nationality: nationality || null }
    });
  }

  await logAudit({
    hotelId: hotel.id,
    action: "ROOM_UNIT_GUEST_DETAILS",
    entityType: "RoomUnit",
    entityId: unit.id,
    metadata: {
      date: dateKey,
      fullName,
      phone,
      email,
      nationality: nationality || undefined,
      notes,
      adults,
      children,
      mealPlan,
      idCardPath,
      paymentMethod,
      paymentAmount,
      balanceAmount,
      transactionNumber,
      bookedBy,
      tourCompany
    }
  });

  res.redirect(`/admin/room-board/unit/${encodeURIComponent(unit.id)}/details?date=${dateKey}&saved=1`);
});

adminRouter.get("/room-board/unit/:unitId/invoice", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true, displayName: true, currency: true } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Guest Invoice</h2><p>No hotel data found.</p>", true));
    return;
  }
  const unitId = String(req.params.unitId ?? "");
  const boardDate = parseDateInput(req.query.date, startOfDay(new Date()));
  const dateKey = formatDateForInput(boardDate);
  const dateEndExclusive = addDays(boardDate, 1);
  const unit = await prisma.roomUnit.findFirst({
    where: { id: unitId, hotelId: hotel.id },
    include: { roomType: true }
  });
  if (!unit) {
    res.redirect(`/admin/room-board?date=${dateKey}`);
    return;
  }
  const [booking, manualDetails] = await Promise.all([
    prisma.booking.findFirst({
      where: {
        hotelId: hotel.id,
        roomUnitId: unit.id,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      include: { guest: true, paymentIntents: { orderBy: { createdAt: "desc" } } },
      orderBy: { checkIn: "asc" }
    }),
    getManualGuestDetailsForUnitOnDate(unit.id, dateKey)
  ]);

  const whatsappSent = req.query.whatsappSent === "1";
  const whatsappError =
    typeof req.query.whatsappError === "string" && req.query.whatsappError.trim().length > 0 ? req.query.whatsappError.trim() : undefined;
  const invoiceNotice =
    typeof req.query.invoiceNotice === "string" && req.query.invoiceNotice.trim().length > 0 ? req.query.invoiceNotice.trim() : undefined;

  const paidSucceeded = booking
    ? booking.paymentIntents.filter((p) => p.status === PaymentStatus.SUCCEEDED).reduce((sum, p) => sum + p.amount, 0)
    : 0;
  const folioSummary = booking
    ? await computeRoomUnitFolioSummary({
        hotelId: hotel.id,
        currency: booking.currency,
        booking: { id: booking.id, totalAmount: booking.totalAmount },
        paymentIntentsSucceededTotal: paidSucceeded
      })
    : null;

  const currency = booking?.currency ?? hotel.currency;
  const manualPaid = manualDetails?.paymentAmount ?? 0;
  const manualBalance = manualDetails?.balanceAmount ?? 0;
  const transactionNumber = manualDetails?.transactionNumber || booking?.paymentIntents[0]?.id || "—";
  const paymentMethod = manualDetails?.paymentMethod || booking?.paymentIntents[0]?.kind || "—";
  const invoiceNumber = booking ? `INV-${booking.id}` : `INV-MANUAL-${unit.name}-${dateKey}`;

  const financialRows =
    folioSummary != null
      ? `
      <tr><th>Room charges</th><td>${formatMoney(folioSummary.roomCharges, currency)}</td></tr>
      <tr><th>F&amp;B / extras</th><td>${formatMoney(folioSummary.fnbExtrasTotal, currency)}</td></tr>
      <tr><th>Discounts / adjustments</th><td>${formatMoney(folioSummary.folioAdjustmentsSubtotal, currency)}</td></tr>
      <tr><th>Total charges</th><td><strong>${formatMoney(folioSummary.totalCharges, currency)}</strong></td></tr>
      <tr><th>Amount paid</th><td>${formatMoney(folioSummary.totalPaid, currency)}</td></tr>
      <tr><td colspan="2" class="muted" style="font-size:13px;padding-top:0">On booking: ${formatMoney(folioSummary.amountPaidBooking, currency)} · Folio payments: ${formatMoney(folioSummary.amountPaidFolio, currency)}</td></tr>
      <tr><th>Outstanding balance</th><td><strong>${formatMoney(folioSummary.outstandingBalance, currency)}</strong></td></tr>`
      : `
      <tr><th>Total (manual)</th><td>${formatMoney(manualPaid + manualBalance, currency)}</td></tr>
      <tr><th>Amount paid</th><td>${formatMoney(manualPaid, currency)}</td></tr>
      <tr><th>Outstanding balance</th><td>${formatMoney(manualBalance, currency)}</td></tr>`;

  const successBanner = whatsappSent
    ? `<p class="invoice-banner invoice-banner-success" role="status"><strong>WhatsApp sent.</strong> The invoice summary message was delivered.${invoiceNotice ? ` ${escapeHtml(invoiceNotice)}` : ""}</p>`
    : "";
  const errorBanner = whatsappError
    ? `<p class="invoice-banner invoice-banner-error" role="alert">${escapeHtml(whatsappError)}</p>`
    : "";

  const content = `
<h2>Guest invoice</h2>
<p class="muted">Same folio totals as <strong>Room unit &amp; guest</strong> for this board date. Print or send via WhatsApp below.</p>
${successBanner}
${errorBanner}
<div class="actions" style="margin-bottom:14px">
  <a class="btn-link" href="/admin/room-board/unit/${encodeURIComponent(unit.id)}/details?date=${dateKey}">Back to room &amp; guest details</a>
  <button type="button" class="btn-link" onclick="window.print()">Print</button>
  <form method="post" action="/admin/room-board/unit/${encodeURIComponent(unit.id)}/send-whatsapp" style="display:inline-flex; margin:0">
    <input type="hidden" name="date" value="${dateKey}" />
    <button type="submit" class="btn-link">Send invoice via WhatsApp</button>
  </form>
</div>
<section class="invoice-sheet" style="max-width:900px; border:1px solid #d8dee6; border-radius:12px; padding:14px; background:#fff">
  <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:10px">
    <div>
      <h3 style="margin-bottom:6px">${escapeHtml(hotel.displayName)}</h3>
      <p class="muted" style="margin:0">Unit ${escapeHtml(unit.name)} · ${escapeHtml(unit.roomType.name)}</p>
    </div>
    <div style="text-align:right">
      <p style="margin:0"><strong>Invoice #:</strong> ${escapeHtml(invoiceNumber)}</p>
      <p style="margin:0"><strong>Date:</strong> ${dateKey}</p>
      <p style="margin:0"><strong>Status:</strong> ${escapeHtml(booking?.status || "MANUAL")}</p>
    </div>
  </div>
  <table>
    <tbody>
      <tr><th>Guest</th><td>${escapeHtml(booking?.guest.fullName || manualDetails?.fullName || "—")}</td></tr>
      <tr><th>Phone</th><td>${escapeHtml(booking?.guest.phoneE164 || manualDetails?.phone || "—")}</td></tr>
      <tr><th>Email</th><td>${escapeHtml(manualDetails?.email || "—")}</td></tr>
      <tr><th>Check-in / Check-out</th><td>${booking ? `${formatDateForInput(booking.checkIn)} - ${formatDateForInput(booking.checkOut)}` : dateKey}</td></tr>
      <tr><th>Booked by</th><td>${escapeHtml(manualDetails?.bookedBy || String(booking?.source ?? "DIRECT"))}</td></tr>
      <tr><th>Payment method</th><td>${escapeHtml(paymentMethod)}</td></tr>
      <tr><th>Transaction #</th><td>${escapeHtml(transactionNumber)}</td></tr>
      ${financialRows}
    </tbody>
  </table>
</section>
<style>
  .invoice-banner { margin: 0 0 14px; padding: 12px 16px; border-radius: 10px; font-size: 14px; max-width: 900px; }
  .invoice-banner-success { background: #ecfdf5; border: 1px solid #6ee7b7; color: #065f46; }
  .invoice-banner-error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
  @media print {
    .sidebar, .section-tabs, nav, .actions { display:none !important; }
    body { background:#fff; }
    .invoice-sheet { border-color:#888 !important; }
    .invoice-banner { display: none !important; }
  }
</style>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/room-board/unit/:unitId/send-whatsapp", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.redirect("/admin/room-board");
    return;
  }
  const unitId = String(req.params.unitId ?? "");
  const boardDate = parseDateInput(req.body.date, startOfDay(new Date()));
  const dateKey = formatDateForInput(boardDate);
  const dateEndExclusive = addDays(boardDate, 1);
  const unit = await prisma.roomUnit.findFirst({
    where: { id: unitId, hotelId: hotel.id },
    include: { roomType: true }
  });
  if (!unit) {
    res.redirect(`/admin/room-board?date=${dateKey}`);
    return;
  }
  const [booking, manualDetails] = await Promise.all([
    prisma.booking.findFirst({
      where: {
        hotelId: hotel.id,
        roomUnitId: unit.id,
        checkIn: { lt: dateEndExclusive },
        checkOut: { gt: boardDate },
        status: { in: ["CONFIRMED", "PENDING"] }
      },
      include: { guest: true, paymentIntents: { orderBy: { createdAt: "desc" } } },
      orderBy: { checkIn: "asc" }
    }),
    getManualGuestDetailsForUnitOnDate(unit.id, dateKey)
  ]);

  const redirectInvoice = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ date: dateKey, ...extra });
    res.redirect(`/admin/room-board/unit/${encodeURIComponent(unit.id)}/invoice?${q.toString()}`);
  };

  const toPhoneRaw = booking?.guest.phoneE164 || manualDetails?.phone || "";
  const toPhone = normalizePhoneForWhatsApp(toPhoneRaw);
  if (!toPhone) {
    redirectInvoice({ whatsappError: "Guest phone number is missing or invalid. Add a phone number on room & guest details, then try again." });
    return;
  }

  const paidSucceeded = booking
    ? booking.paymentIntents.filter((p) => p.status === PaymentStatus.SUCCEEDED).reduce((sum, p) => sum + p.amount, 0)
    : 0;
  const folioSummary = booking
    ? await computeRoomUnitFolioSummary({
        hotelId: hotel.id,
        currency: booking.currency,
        booking: { id: booking.id, totalAmount: booking.totalAmount },
        paymentIntentsSucceededTotal: paidSucceeded
      })
    : null;

  const cur = booking?.currency ?? hotel.currency;
  const transactionNumber = manualDetails?.transactionNumber || booking?.paymentIntents[0]?.id || "—";
  const paymentMethod = manualDetails?.paymentMethod || booking?.paymentIntents[0]?.kind || "—";

  const msgLines = folioSummary
    ? [
        `Dear guest, your invoice summary for ${hotel.displayName}:`,
        `Unit: ${unit.name} (${unit.roomType.name})`,
        `Board date: ${dateKey}`,
        `Guest: ${booking?.guest.fullName || manualDetails?.fullName || "—"}`,
        `Room charges: ${formatMoney(folioSummary.roomCharges, cur)}`,
        `F&B / extras: ${formatMoney(folioSummary.fnbExtrasTotal, cur)}`,
        `Discounts / adjustments: ${formatMoney(folioSummary.folioAdjustmentsSubtotal, cur)}`,
        `Total charges: ${formatMoney(folioSummary.totalCharges, cur)}`,
        `Amount paid: ${formatMoney(folioSummary.totalPaid, cur)} (on booking ${formatMoney(folioSummary.amountPaidBooking, cur)}, folio ${formatMoney(folioSummary.amountPaidFolio, cur)})`,
        `Outstanding balance: ${formatMoney(folioSummary.outstandingBalance, cur)}`,
        `Payment method: ${paymentMethod}`,
        `Transaction #: ${transactionNumber}`
      ]
    : [
        `Dear guest, your invoice summary for ${hotel.displayName}:`,
        `Unit: ${unit.name} (${unit.roomType.name})`,
        `Date: ${dateKey}`,
        `Guest: ${manualDetails?.fullName || "—"}`,
        `Adults/Children: ${manualDetails?.adults ?? 0}/${manualDetails?.children ?? 0}`,
        `Meal: ${manualDetails?.mealPlan ?? "NONE"}`,
        `Payment method: ${paymentMethod}`,
        `Amount paid: ${formatMoney(manualDetails?.paymentAmount ?? 0, cur)}`,
        `Outstanding balance: ${formatMoney(manualDetails?.balanceAmount ?? 0, cur)}`,
        `Transaction #: ${transactionNumber}`
      ];

  const config = loadPartnerSetupConfig(hotel.id);
  const sendResult = await trySendWhatsAppText({
    to: toPhone,
    body: msgLines.join("\n"),
    phoneNumberId: config.whatsappPhoneNumberId || undefined,
    conversationId: booking?.conversationId ?? undefined
  });

  if (!sendResult.ok) {
    redirectInvoice({ whatsappError: sendResult.errorMessage });
    return;
  }

  let invoiceNotice: string | undefined;
  if (booking) {
    const pdfResult = await sendInvoicePdfForBooking({
      hotelId: hotel.id,
      bookingId: booking.id,
      trigger: "ROOM_UNIT_INVOICE_SEND",
      force: true
    });
    if (pdfResult.error) {
      invoiceNotice = `Invoice PDF was not sent: ${pdfResult.error.slice(0, 400)}`;
    } else if (pdfResult.skipped && !pdfResult.sent) {
      invoiceNotice =
        "Invoice PDF was not attached (e.g. booking not confirmed yet, or duplicate send skipped). The summary message was still sent.";
    }
  }

  await logAudit({
    hotelId: hotel.id,
    action: "ROOM_UNIT_DETAILS_SENT_WHATSAPP",
    entityType: "RoomUnit",
    entityId: unit.id,
    metadata: { date: dateKey, toPhone, bookingId: booking?.id ?? null }
  });

  const params: Record<string, string> = { whatsappSent: "1" };
  if (invoiceNotice) params.invoiceNotice = invoiceNotice;
  redirectInvoice(params);
});

adminRouter.get("/ai-analytics", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>AI Analytics</h2><p>No hotel data found.</p>", true));
    return;
  }
  const days = clamp(parseIntegerInput(req.query.days, 14), 1, 90);
  const since = addDays(startOfDay(new Date()), -days + 1);
  const messages = await prisma.message.findMany({
    where: {
      hotelId: hotel.id,
      direction: MessageDirection.OUTBOUND,
      createdAt: { gte: since },
      aiIntent: { not: null }
    },
    select: { aiIntent: true, aiConfidence: true, createdAt: true },
    orderBy: { createdAt: "desc" }
  });

  const total = messages.length;
  const byIntent = new Map<string, { count: number; confidenceSum: number; confidenceCount: number }>();
  for (const msg of messages) {
    const key = msg.aiIntent || "UNKNOWN";
    const current = byIntent.get(key) ?? { count: 0, confidenceSum: 0, confidenceCount: 0 };
    current.count += 1;
    if (typeof msg.aiConfidence === "number") {
      current.confidenceSum += msg.aiConfidence;
      current.confidenceCount += 1;
    }
    byIntent.set(key, current);
  }
  const sorted = Array.from(byIntent.entries())
    .map(([intent, stats]) => ({
      intent,
      count: stats.count,
      avgConfidence: stats.confidenceCount ? stats.confidenceSum / stats.confidenceCount : null
    }))
    .sort((a, b) => b.count - a.count);

  const avgConfidenceAll =
    messages.filter((msg) => typeof msg.aiConfidence === "number").reduce((sum, msg) => sum + Number(msg.aiConfidence), 0) /
    Math.max(1, messages.filter((msg) => typeof msg.aiConfidence === "number").length);
  const lowConfidence = messages.filter((msg) => typeof msg.aiConfidence === "number" && (msg.aiConfidence ?? 0) < 0.35).length;
  const faqResponses = messages.filter((msg) => (msg.aiIntent ?? "").startsWith("FAQ_")).length;
  const bookingAutomation = messages.filter((msg) =>
    ["ASK_BOOKING_DETAILS", "BOOKING_CONFIRMED_AUTOMATION", "BOOKING_EDIT_REQUESTED"].includes(msg.aiIntent ?? "")
  ).length;

  const rows = sorted
    .map(
      (row) => `<tr>
      <td>${escapeHtml(row.intent)}</td>
      <td>${row.count}</td>
      <td>${row.avgConfidence === null ? "-" : `${(row.avgConfidence * 100).toFixed(1)}%`}</td>
    </tr>`
    )
    .join("");

  const content = `
<h2>AI Analytics</h2>
<p class="muted">Intent distribution, confidence quality, and automation performance.</p>
<form method="get" action="/admin/ai-analytics" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Range (days)
    <input type="number" min="1" max="90" name="days" value="${days}" style="width:110px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
  </label>
  <button type="submit" style="padding:8px 12px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Apply</button>
</form>
<div class="grid-4">
  <article class="stat"><h3>Total AI replies</h3><p>${total}</p></article>
  <article class="stat"><h3>FAQ responses</h3><p>${faqResponses}</p></article>
  <article class="stat"><h3>Booking automation replies</h3><p>${bookingAutomation}</p></article>
  <article class="stat"><h3>Avg confidence</h3><p>${Number.isFinite(avgConfidenceAll) ? `${(avgConfidenceAll * 100).toFixed(1)}%` : "-"}</p></article>
</div>
<p class="muted" style="margin-top:10px">Low-confidence replies (&lt;35%): <strong>${lowConfidence}</strong></p>
<table>
  <thead><tr><th>Intent</th><th>Count</th><th>Average Confidence</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3">No AI intent activity in selected range.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/offers", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const offers = readOffers().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const createdNotice = req.query.created ? '<p class="badge ok">Offer created.</p>' : "";
  const toggledNotice = req.query.toggled ? '<p class="badge ok">Offer status updated.</p>' : "";

  const rows = offers
    .map((offer) => {
      const details: string[] = [];
      if (offer.type === "STAY_X_GET_Y_FREE") details.push(`Stay ${offer.stayX ?? "-"} get ${offer.stayY ?? "-"}`);
      if (offer.type === "EARLY_BOOKING") details.push(`Min ${offer.minDaysBeforeCheckIn ?? "-"} days in advance`);
      if (offer.type === "LONG_STAY") details.push(`Min ${offer.minNights ?? "-"} nights`);
      if (offer.type === "SEASONAL") details.push(`${offer.seasonStart ?? "-"} to ${offer.seasonEnd ?? "-"}`);
      if (offer.type === "CORPORATE_RATE") details.push("Corporate guests");
      return `<tr>
      <td>${escapeHtml(offer.title)}</td>
      <td>${escapeHtml(offer.code)}</td>
      <td>${escapeHtml(offer.type)}</td>
      <td>${offer.discountPercent}%</td>
      <td>${escapeHtml(details.join(" • ") || "-")}</td>
      <td><span class="badge ${offer.isActive ? "ok" : "pending"}">${offer.isActive ? "Active" : "Inactive"}</span></td>
      <td>
        <form method="post" action="/admin/offers/${encodeURIComponent(offer.id)}/toggle" style="margin:0">
          <button type="submit" style="padding:6px 10px; border:0; border-radius:8px; background:${offer.isActive ? "#fee2e2" : "#dcfce7"}; color:${offer.isActive ? "#991b1b" : "#166534"}; font-weight:700; cursor:pointer">${offer.isActive ? "Disable" : "Enable"}</button>
        </form>
      </td>
      </tr>`;
    })
    .join("");

  const content = `
<h2>Offer Management</h2>
<p class="muted">Create and manage promotional offers for room pricing.</p>
${createdNotice}${toggledNotice}
<section style="margin-bottom:14px">
  <h3>Create Offer</h3>
  <form method="post" action="/admin/offers" style="display:grid; gap:10px">
    <div class="grid-2">
      <label>Title<br /><input type="text" name="title" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Code<br /><input type="text" name="code" required placeholder="SUMMER_20" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Offer type
        <select name="type" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">
          <option value="PERCENTAGE_DISCOUNT">Percentage discounts</option>
          <option value="STAY_X_GET_Y_FREE">Stay X nights get Y free</option>
          <option value="EARLY_BOOKING">Early booking discounts</option>
          <option value="LONG_STAY">Long stay discounts</option>
          <option value="SEASONAL">Seasonal offers</option>
          <option value="CORPORATE_RATE">Corporate rates</option>
        </select>
      </label>
      <label>Discount %<br /><input type="number" min="0" max="90" step="0.1" name="discountPercent" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Stay X (for Stay X Get Y)<br /><input type="number" min="1" name="stayX" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Get Y free<br /><input type="number" min="1" name="stayY" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Min days before check-in (Early booking)<br /><input type="number" min="1" name="minDaysBeforeCheckIn" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Min nights (Long stay)<br /><input type="number" min="1" name="minNights" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Season start<br /><input type="date" name="seasonStart" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
      <label>Season end<br /><input type="date" name="seasonEnd" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    </div>
    <label style="display:flex; gap:8px; align-items:center"><input type="checkbox" name="corporateOnly" /> Corporate only</label>
    <button type="submit" style="width:max-content; padding:9px 14px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Create offer</button>
  </form>
</section>
<section>
  <h3>Existing Offers</h3>
  <table>
    <thead><tr><th>Title</th><th>Code</th><th>Type</th><th>Discount</th><th>Conditions</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">No offers yet.</td></tr>'}</tbody>
  </table>
</section>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/offers", requirePermission("ROOMS", "CREATE"), async (req, res) => {
  const title = String(req.body.title ?? "").trim();
  const code = String(req.body.code ?? "").trim().toUpperCase();
  const type = String(req.body.type ?? "PERCENTAGE_DISCOUNT") as OfferType;
  const validTypes: OfferType[] = [
    "PERCENTAGE_DISCOUNT",
    "STAY_X_GET_Y_FREE",
    "EARLY_BOOKING",
    "LONG_STAY",
    "SEASONAL",
    "CORPORATE_RATE"
  ];
  if (!title || !code || !validTypes.includes(type)) {
    res.status(400).type("html").send(renderLayout("<h2>Offer Management</h2><p>Invalid offer input.</p>", true));
    return;
  }
  const nowIso = new Date().toISOString();
  const offers = readOffers();
  offers.push({
    id: crypto.randomUUID(),
    title,
    code,
    type,
    discountPercent: clamp(parseNumberInput(req.body.discountPercent, 0), 0, 90),
    stayX: parseIntegerInput(req.body.stayX, 0) || undefined,
    stayY: parseIntegerInput(req.body.stayY, 0) || undefined,
    minDaysBeforeCheckIn: parseIntegerInput(req.body.minDaysBeforeCheckIn, 0) || undefined,
    minNights: parseIntegerInput(req.body.minNights, 0) || undefined,
    seasonStart: String(req.body.seasonStart ?? "").trim() || undefined,
    seasonEnd: String(req.body.seasonEnd ?? "").trim() || undefined,
    corporateOnly: req.body.corporateOnly === "on",
    isActive: true,
    createdAt: nowIso,
    updatedAt: nowIso
  });
  writeOffers(offers);
  res.redirect("/admin/offers?created=1");
});

adminRouter.post("/offers/:id/toggle", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const offerId = String(req.params.id ?? "");
  const offers = readOffers();
  const idx = offers.findIndex((o) => o.id === offerId);
  if (idx < 0) {
    res.redirect("/admin/offers");
    return;
  }
  offers[idx] = { ...offers[idx], isActive: !offers[idx].isActive, updatedAt: new Date().toISOString() };
  writeOffers(offers);
  res.redirect("/admin/offers?toggled=1");
});

adminRouter.get("/campaigns", requirePermission("BOOKINGS", "VIEW"), async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Campaigns</h2><p>No hotel data found.</p>", true));
    return;
  }

  const campaigns = await prisma.marketingCampaign.findMany({
    where: { hotelId: hotel.id },
    orderBy: { createdAt: "desc" },
    take: 80
  });

  const rows = campaigns
    .map(
      (c) => `<tr>
  <td><a class="inline-link" href="/admin/campaigns/${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a></td>
  <td>${formatDateTime(c.createdAt)}</td>
  <td><span class="badge ${c.status === "SENT" ? "ok" : c.status === "FAILED" ? "alert" : "pending"}">${escapeHtml(c.status)}</span></td>
  <td>${c.audienceCount}</td>
  <td>${c.sentOkCount}</td>
  <td>${c.sentFailedCount}</td>
  <td>${c.skippedNoPhoneCount}</td>
</tr>`
    )
    .join("");

  const content = `
<h2>Campaign center</h2>
<p class="muted">Targeted WhatsApp campaigns using guest tags, VIP, and booking history. <a class="inline-link" href="/admin/campaigns/new">Compose new campaign</a></p>
<table>
  <thead><tr><th>Name</th><th>Created</th><th>Status</th><th>Audience</th><th>Sent</th><th>Failed</th><th>No phone</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No campaigns yet.</td></tr>'}</tbody>
</table>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/campaigns/new", requirePermission("BOOKINGS", "VIEW"), async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Campaign</h2><p>No hotel data found.</p>", true));
    return;
  }

  const [roomTypes, offers] = await Promise.all([
    prisma.roomType.findMany({
      where: { hotelId: hotel.id, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    }),
    Promise.resolve(readOffers())
  ]);

  const inner = renderCampaignComposePage({
    hotelDisplayName: hotel.displayName,
    roomTypes,
    offers,
    body: {},
    previewCount: null,
    errorMsg: null
  });

  res.type("html").send(renderLayout(inner, true));
});

adminRouter.post("/campaigns/new", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/campaigns");
    return;
  }

  const body = req.body as Record<string, unknown>;
  const action = String(body._action ?? "");
  const filters = parseCampaignFiltersFromBody(body);
  const ackBroad = body.ackBroadAudience === "1" || body.ackBroadAudience === "on";

  const [roomTypes, offers] = await Promise.all([
    prisma.roomType.findMany({
      where: { hotelId: hotel.id, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    }),
    Promise.resolve(readOffers())
  ]);

  const renderForm = (previewCount: number | null, errorMsg: string | null) => {
    const inner = renderCampaignComposePage({
      hotelDisplayName: hotel.displayName,
      roomTypes,
      offers,
      body,
      previewCount,
      errorMsg
    });
    res.type("html").send(renderLayout(inner, true));
  };

  if (isCampaignFiltersEmpty(filters) && !ackBroad) {
    renderForm(
      null,
      "Select at least one audience filter, or tick the acknowledgement to include all guests with a phone number."
    );
    return;
  }

  const { guests, count } = await resolveCampaignAudience(hotel.id, filters);

  if (action === "preview") {
    renderForm(count, null);
    return;
  }

  if (action !== "send") {
    renderForm(null, "Unknown action.");
    return;
  }

  const campaignName = String(body.campaignName ?? "").trim();
  const messageBody = String(body.messageBody ?? "").trim();
  const purposeNote = String(body.purposeNote ?? "").trim() || null;
  const linkedOfferIdRaw = String(body.linkedOfferId ?? "").trim();
  const linkedOfferId = linkedOfferIdRaw.length ? linkedOfferIdRaw : null;

  if (!campaignName) {
    renderForm(count, "Campaign name is required to send.");
    return;
  }
  if (!messageBody) {
    renderForm(count, "Message body is required to send.");
    return;
  }
  if (count === 0) {
    renderForm(count, "No guests match these filters. Adjust filters and preview again.");
    return;
  }

  const campaign = await prisma.marketingCampaign.create({
    data: {
      hotelId: hotel.id,
      name: campaignName,
      purposeNote,
      filtersJson: serializeCampaignFilters(filters),
      messageBody,
      linkedOfferId,
      channel: "WHATSAPP",
      status: "SENDING",
      audienceCount: count,
      attemptedCount: 0,
      sentOkCount: 0,
      sentFailedCount: 0,
      skippedNoPhoneCount: 0
    }
  });

  const offerDef = linkedOfferId ? offers.find((o) => o.id === linkedOfferId && o.isActive) : undefined;
  const offerSnip = offerDef ? { title: offerDef.title, code: offerDef.code } : null;

  try {
    const result = await sendMarketingCampaignWhatsApp({
      hotelId: hotel.id,
      hotelDisplayName: hotel.displayName,
      campaignId: campaign.id,
      guests,
      messageBody,
      offer: offerSnip
    });

    const failedAll = result.attempted > 0 && result.sentOk === 0;
    await prisma.marketingCampaign.update({
      where: { id: campaign.id },
      data: {
        status: failedAll ? "FAILED" : "SENT",
        attemptedCount: result.attempted,
        sentOkCount: result.sentOk,
        sentFailedCount: result.sentFailed,
        skippedNoPhoneCount: result.skippedNoPhone,
        sentAt: new Date()
      }
    });

    await logAudit({
      hotelId: hotel.id,
      action: "MARKETING_CAMPAIGN_SENT",
      entityType: "MarketingCampaign",
      entityId: campaign.id,
      metadata: {
        name: campaignName,
        audienceCount: count,
        sentOk: result.sentOk,
        sentFailed: result.sentFailed,
        skippedNoPhone: result.skippedNoPhone
      }
    });
  } catch (err) {
    await prisma.marketingCampaign.update({
      where: { id: campaign.id },
      data: { status: "FAILED" }
    });
    throw err;
  }

  res.redirect(`/admin/campaigns/${encodeURIComponent(campaign.id)}?sent=1`);
});

adminRouter.get("/campaigns/:id", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Campaign</h2><p>No hotel data found.</p>", true));
    return;
  }

  const id = String(req.params.id ?? "");
  const campaign = await prisma.marketingCampaign.findFirst({
    where: { id, hotelId: hotel.id },
    include: {
      recipients: {
        orderBy: { createdAt: "desc" },
        take: 40,
        include: { guest: { select: { fullName: true, phoneE164: true } } }
      }
    }
  });

  if (!campaign) {
    res.status(404).type("html").send(renderLayout("<h2>Campaign not found</h2>", true));
    return;
  }

  const sentNotice = req.query.sent ? '<p class="badge ok">Campaign processed.</p>' : "";
  const filters = deserializeCampaignFilters(campaign.filtersJson);
  const filterSummary = escapeHtml(JSON.stringify(filters, null, 2).slice(0, 2000));

  const sampleRows = campaign.recipients
    .map(
      (r) => `<tr>
  <td>${escapeHtml(r.guest.fullName ?? "—")}</td>
  <td>${escapeHtml(r.guest.phoneE164)}</td>
  <td><span class="badge ${r.outcome === "SENT" ? "ok" : r.outcome === "NO_PHONE" ? "pending" : "alert"}">${escapeHtml(r.outcome)}</span></td>
  <td>${r.errorDetail ? escapeHtml(r.errorDetail.slice(0, 120)) : "—"}</td>
</tr>`
    )
    .join("");

  const content = `
<h2>${escapeHtml(campaign.name)}</h2>
${sentNotice}
<p class="muted">Created ${formatDateTime(campaign.createdAt)}${campaign.sentAt ? ` · Sent ${formatDateTime(campaign.sentAt)}` : ""}</p>
<div class="grid-2" style="align-items:start">
  <section>
    <h3>Summary</h3>
    <table>
      <tbody>
        <tr><th>Status</th><td>${escapeHtml(campaign.status)}</td></tr>
        <tr><th>Audience (matched)</th><td>${campaign.audienceCount}</td></tr>
        <tr><th>Attempted</th><td>${campaign.attemptedCount}</td></tr>
        <tr><th>Sent (WhatsApp)</th><td>${campaign.sentOkCount}</td></tr>
        <tr><th>Failed</th><td>${campaign.sentFailedCount}</td></tr>
        <tr><th>Skipped (no phone)</th><td>${campaign.skippedNoPhoneCount}</td></tr>
        <tr><th>Channel</th><td>${escapeHtml(campaign.channel)}</td></tr>
        <tr><th>Linked offer ID</th><td>${campaign.linkedOfferId ? escapeHtml(campaign.linkedOfferId) : "—"}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Purpose</h3>
    <p>${campaign.purposeNote ? escapeHtml(campaign.purposeNote) : '<span class="muted">—</span>'}</p>
    <h3>Message body</h3>
    <pre style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px;border:1px solid var(--border);font-size:13px">${escapeHtml(campaign.messageBody)}</pre>
  </section>
</div>
<h3>Filters (JSON)</h3>
<pre style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px;border:1px solid var(--border);font-size:12px;max-height:220px;overflow:auto">${filterSummary}</pre>
<h3>Recent delivery sample (up to 40)</h3>
<table>
  <thead><tr><th>Guest</th><th>Phone</th><th>Outcome</th><th>Detail</th></tr></thead>
  <tbody>${sampleRows || '<tr><td colspan="4">No recipient rows (campaign may not have been sent yet).</td></tr>'}</tbody>
</table>
<p><a class="btn-link" href="/admin/campaigns">All campaigns</a></p>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/booking-funnel", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Booking Funnel</h2><p>No hotel data found.</p>", true));
    return;
  }
  const days = clamp(parseIntegerInput(req.query.days, 14), 1, 90);
  const since = addDays(startOfDay(new Date()), -days + 1);
  const [sessions, drafts, bookings] = await Promise.all([
    prisma.conversationSession.findMany({
      where: { hotelId: hotel.id, updatedAt: { gte: since } },
      select: { stage: true, updatedAt: true }
    }),
    prisma.bookingDraft.findMany({
      where: { hotelId: hotel.id, updatedAt: { gte: since } },
      select: { status: true, source: true, updatedAt: true }
    }),
    prisma.booking.findMany({
      where: { hotelId: hotel.id, createdAt: { gte: since } },
      select: { id: true, status: true, createdAt: true }
    })
  ]);

  const stageCount = new Map<string, number>();
  for (const row of sessions) {
    stageCount.set(row.stage, (stageCount.get(row.stage) ?? 0) + 1);
  }
  const draftStatusCount = new Map<string, number>();
  for (const row of drafts) {
    draftStatusCount.set(row.status, (draftStatusCount.get(row.status) ?? 0) + 1);
  }
  const totalSessions = sessions.length;
  const totalConfirmed = bookings.filter((b) => b.status === "CONFIRMED").length;
  const conversion = totalSessions ? (totalConfirmed / totalSessions) * 100 : 0;

  const stageRows = Array.from(stageCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(
      ([stage, count]) => `<tr>
      <td>${escapeHtml(stage)}</td>
      <td>${count}</td>
      <td>${((count / Math.max(totalSessions, 1)) * 100).toFixed(1)}%</td>
    </tr>`
    )
    .join("");
  const draftRows = Array.from(draftStatusCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(
      ([status, count]) => `<tr>
      <td>${escapeHtml(status)}</td>
      <td>${count}</td>
    </tr>`
    )
    .join("");

  const content = `
<h2>Booking Funnel</h2>
<p class="muted">Track where guests drop off from conversation to confirmed booking.</p>
<form method="get" action="/admin/booking-funnel" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Range (days)
    <input type="number" min="1" max="90" name="days" value="${days}" style="width:110px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
  </label>
  <button type="submit" style="padding:8px 12px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Apply</button>
</form>
<div class="grid-4">
  <article class="stat"><h3>Active sessions</h3><p>${totalSessions}</p></article>
  <article class="stat"><h3>Draft records</h3><p>${drafts.length}</p></article>
  <article class="stat"><h3>Confirmed bookings</h3><p>${totalConfirmed}</p></article>
  <article class="stat"><h3>Session to confirmed</h3><p>${conversion.toFixed(1)}%</p></article>
</div>
<div class="grid-2" style="margin-top:12px">
  <section>
    <h3>Conversation stages</h3>
    <table>
      <thead><tr><th>Stage</th><th>Count</th><th>Share</th></tr></thead>
      <tbody>${stageRows || '<tr><td colspan="3">No sessions in range.</td></tr>'}</tbody>
    </table>
  </section>
  <section>
    <h3>Draft statuses</h3>
    <table>
      <thead><tr><th>Status</th><th>Count</th></tr></thead>
      <tbody>${draftRows || '<tr><td colspan="2">No draft activity in range.</td></tr>'}</tbody>
    </table>
  </section>
</div>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/routing-health", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Routing Health</h2><p>No hotel data found.</p>", true));
    return;
  }
  const hours = clamp(parseIntegerInput(req.query.hours, 24), 1, 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [inbound, outbound, recentOutbound] = await Promise.all([
    prisma.message.count({ where: { hotelId: hotel.id, direction: MessageDirection.INBOUND, createdAt: { gte: since } } }),
    prisma.message.count({ where: { hotelId: hotel.id, direction: MessageDirection.OUTBOUND, createdAt: { gte: since } } }),
    prisma.message.findMany({
      where: { hotelId: hotel.id, direction: MessageDirection.OUTBOUND, createdAt: { gte: since } },
      select: { aiIntent: true, aiConfidence: true, createdAt: true, body: true },
      orderBy: { createdAt: "desc" },
      take: 25
    })
  ]);
  const replyRate = inbound ? (outbound / inbound) * 100 : 0;
  const lowConfidence = recentOutbound.filter((m) => typeof m.aiConfidence === "number" && (m.aiConfidence ?? 0) < 0.35).length;
  const rows = recentOutbound
    .map(
      (msg) => `<tr>
      <td>${formatDateTime(msg.createdAt)}</td>
      <td>${escapeHtml(msg.aiIntent ?? "-")}</td>
      <td>${msg.aiConfidence === null || msg.aiConfidence === undefined ? "-" : `${(msg.aiConfidence * 100).toFixed(1)}%`}</td>
      <td>${escapeHtml(msg.body.slice(0, 120))}</td>
    </tr>`
    )
    .join("");

  const content = `
<h2>Routing Health</h2>
<p class="muted">Monitor inbound/outbound flow to quickly detect no-reply incidents.</p>
<form method="get" action="/admin/routing-health" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Range (hours)
    <input type="number" min="1" max="168" name="hours" value="${hours}" style="width:110px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
  </label>
  <button type="submit" style="padding:8px 12px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Apply</button>
</form>
<div class="grid-4">
  <article class="stat"><h3>Inbound messages</h3><p>${inbound}</p></article>
  <article class="stat"><h3>Outbound replies</h3><p>${outbound}</p></article>
  <article class="stat"><h3>Reply ratio</h3><p>${replyRate.toFixed(1)}%</p></article>
  <article class="stat"><h3>Low-confidence replies</h3><p>${lowConfidence}</p></article>
</div>
<table>
  <thead><tr><th>Time</th><th>Intent</th><th>Confidence</th><th>Message Preview</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">No outbound messages in range.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/rooms", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    include: {
      roomTypes: {
        where: { isActive: true },
        orderBy: { name: "asc" },
        include: { roomUnits: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } }
      }
    }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Rooms</h2><p>No hotel data found.</p>", true));
    return;
  }

  const canEditStructure = isPlatformOwnerEmail(getSession(req)?.email);
  const structureNote = canEditStructure
    ? ""
    : '<p class="badge pending" style="margin:8px 0">Physical room units can only be added or changed by the platform owner (same login as <code>ADMIN_EMAIL</code>).</p>';

  const season = req.query.season === "high" ? "high" : "low";
  const info = req.query.saved ? '<p class="badge ok">Room settings saved.</p>' : "";
  const unitSavedInfo = req.query.unitSaved ? '<p class="badge ok">Room units updated.</p>' : "";
  const offerInfo = req.query.offer ? '<p class="badge ok">Offer scheme applied.</p>' : "";
  const seasonInfo = req.query.seasonApplied
    ? `<p class="badge ok">${season === "high" ? "High" : "Low"} season rates applied.</p>`
    : "";
  const offers = readOffers().filter((offer) => offer.isActive);
  const offerOptions = offers
    .map((offer) => `<option value="${escapeHtml(offer.code)}">${escapeHtml(offer.title)} (${escapeHtml(offer.type)})</option>`)
    .join("");
  const roomOptions = hotel.roomTypes
    .map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)}</option>`)
    .join("");
  const roomRows = hotel.roomTypes
    .map(
      (room) => `<tr>
      <td>${escapeHtml(room.name)}</td>
      <td>${room.capacity} Guests</td>
      <td>${seasonalBaseRates[room.code]?.high ?? "-"}</td>
      <td>${seasonalBaseRates[room.code]?.low ?? "-"}</td>
      <td>
        <form method="post" action="/admin/rooms/update/${encodeURIComponent(room.id)}" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
          <input type="number" step="0.1" min="0" name="baseNightlyRate" value="${room.baseNightlyRate}" style="width:120px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </td>
      <td>${Number((room.baseNightlyRate * (1 - tourOperatorDiscount)).toFixed(2))}</td>
      <td>
          <span style="display:inline-block; min-width:48px; padding:8px; background:#f1f5f9; border-radius:8px; font-weight:600">${room.totalInventory}</span>
      </td>
      <td>
          <label style="display:flex; gap:6px; align-items:center"><input type="checkbox" name="isActive" ${room.isActive ? "checked" : ""} /> Active</label>
      </td>
      <td>
          <button type="submit" style="padding:8px 12px; border:0; border-radius:8px; background:#25d366; color:#083d2d; font-weight:700">Save</button>
        </form>
      </td>
      </tr>`
    )
    .join("");
  const unitWarnings = hotel.roomTypes
    .filter((room) => room.roomUnits.filter((unit) => unit.isActive).length < room.totalInventory)
    .map(
      (room) =>
        `<p class="badge alert" style="margin:6px 0">Warning: ${escapeHtml(room.name)} has ${room.roomUnits.filter((u) => u.isActive).length} active units but inventory is ${room.totalInventory}.</p>`
    )
    .join("");
  const unitSections = hotel.roomTypes
    .map((room) => {
      const units = room.roomUnits;
      const unitRows = units.length
        ? units
            .map(
              (unit) => `<tr>
          <td>${escapeHtml(unit.name)}</td>
          <td>${unit.sortOrder ?? "-"}</td>
          <td>${unit.isActive ? '<span class="badge ok">Active</span>' : '<span class="badge pending">Disabled</span>'}</td>
          <td style="display:flex; gap:8px; flex-wrap:wrap">
            ${
              canEditStructure
                ? `<form method="post" action="/admin/rooms/units/${encodeURIComponent(unit.id)}/rename" style="display:flex; gap:8px">
              <input name="name" required value="${escapeHtml(unit.name)}" style="width:130px; padding:7px; border:1px solid #d8dee6; border-radius:8px" />
              <input type="number" name="sortOrder" value="${unit.sortOrder ?? ""}" placeholder="Order" style="width:90px; padding:7px; border:1px solid #d8dee6; border-radius:8px" />
              <button type="submit" style="padding:7px 11px; border:0; border-radius:8px; background:#0b6e6e; color:#fff">Save</button>
            </form>
            <form method="post" action="/admin/rooms/units/${encodeURIComponent(unit.id)}/toggle">
              <button type="submit" style="padding:7px 11px; border:0; border-radius:8px; background:${unit.isActive ? "#ef4444" : "#128c7e"}; color:#fff">${
                unit.isActive ? "Disable" : "Enable"
              }</button>
            </form>`
                : '<span class="muted" style="font-size:12px">—</span>'
            }
          </td>
        </tr>`
            )
            .join("")
        : '<tr><td colspan="4">No units added yet.</td></tr>';
      const addUnitForms = canEditStructure
        ? `<form method="post" action="/admin/rooms/${encodeURIComponent(room.id)}/units/add" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px">
          <input name="name" placeholder="Unit name (e.g. N7)" required style="padding:8px; border:1px solid #d8dee6; border-radius:8px" />
          <input type="number" name="sortOrder" placeholder="Sort order" style="width:110px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
          <button type="submit" style="padding:8px 12px; border:0; border-radius:8px; background:#25d366; color:#083d2d; font-weight:700">Add Unit</button>
        </form>
        <form method="post" action="/admin/rooms/${encodeURIComponent(room.id)}/units/bulk" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px">
          <input name="prefix" placeholder="Prefix (e.g. N)" style="width:120px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
          <input type="number" min="1" name="start" placeholder="Start" style="width:90px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
          <input type="number" min="1" name="count" placeholder="Count" required style="width:90px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
          <button type="submit" style="padding:8px 12px; border:0; border-radius:8px; background:#075e54; color:#fff">Bulk Generate</button>
        </form>`
        : "";
      return `<section style="margin-top:14px; border:1px solid #e6edf3; border-radius:12px; padding:12px">
        <h4 style="margin:0 0 8px">${escapeHtml(room.name)} units</h4>
        ${addUnitForms}
        <table>
          <thead><tr><th>Name</th><th>Sort</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${unitRows}</tbody>
        </table>
      </section>`;
    })
    .join("");

  const content = `
<h2>Rooms & Pricing</h2>
<p class="muted">Edit room availability, nightly pricing, and quickly apply offer schemes. Physical room totals per category are set in the <strong>platform owner</strong> console under Room capacity (not here).</p>
${info}${offerInfo}${seasonInfo}
${unitSavedInfo}
<section style="margin-bottom:14px">
  <h3>Apply Seasonal Rate Set</h3>
  <form method="post" action="/admin/rooms/season" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
    <select name="season" style="padding:9px; border:1px solid #d8dee6; border-radius:8px">
      <option value="high" ${season === "high" ? "selected" : ""}>High season rates</option>
      <option value="low" ${season === "low" ? "selected" : ""}>Low season rates</option>
    </select>
    <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Apply season pricing</button>
  </form>
  <p class="muted" style="margin-top:8px">Tour operating company discount: 15% from selected/base rate.</p>
</section>
<section style="margin-bottom:14px">
  <h3>Apply Offer Scheme</h3>
  <form method="post" action="/admin/rooms/offers" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
    <select name="targetRoomId" style="padding:9px; border:1px solid #d8dee6; border-radius:8px">
      <option value="ALL">All room types</option>
      ${roomOptions}
    </select>
    <select name="offerCode" style="padding:9px; border:1px solid #d8dee6; border-radius:8px">${offerOptions}</select>
    <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
  </form>
  <p class="muted" style="margin-top:8px"><a class="inline-link" href="/admin/offers">Manage offers</a> to create percentage, stay-x-get-y, early booking, long stay, seasonal, and corporate rates.</p>
</section>
<table>
  <thead>
    <tr><th>Room Type</th><th>Capacity</th><th>High (${escapeHtml(hotel.currency)})</th><th>Low (${escapeHtml(
      hotel.currency
    )})</th><th>Base/Edit Rate</th><th>Tour Operator (${escapeHtml(hotel.currency)})</th><th>Room cap (owner)</th><th>Status</th><th>Action</th></tr>
  </thead>
  <tbody>${roomRows || '<tr><td colspan="9">No room types found.</td></tr>'}</tbody>
</table>
<section style="margin-top:14px">
  <h3>Room Units</h3>
  <p class="muted">Manage real units (N7, N8...) per room type. This does not change inventory logic.</p>
  ${structureNote}
  ${unitWarnings}
  ${unitSections}
</section>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/rooms/update/:roomTypeId", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/rooms");
    return;
  }
  const roomTypeId = String(req.params.roomTypeId ?? "");
  const existingRt = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId: hotel.id } });
  if (!existingRt) {
    res.redirect("/admin/rooms");
    return;
  }
  const baseNightlyRate = Math.max(0, parseNumberInput(req.body.baseNightlyRate, 0));
  const totalInventory = existingRt.totalInventory;
  const isActive = req.body.isActive === "on";

  await prisma.roomType.updateMany({
    where: { id: roomTypeId, hotelId: hotel.id },
    data: { baseNightlyRate, totalInventory, isActive }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "ROOM_TYPE_UPDATED",
    entityType: "RoomType",
    entityId: roomTypeId,
    metadata: { baseNightlyRate, totalInventory, isActive }
  });

  res.redirect("/admin/rooms?saved=1");
});

adminRouter.post("/rooms/:roomTypeId/units/add", requirePermission("ROOMS", "MANAGE"), requirePlatformOwner, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/rooms");
    return;
  }
  const roomTypeId = String(req.params.roomTypeId ?? "");
  const name = String(req.body.name ?? "").trim();
  if (!name) {
    res.redirect("/admin/rooms");
    return;
  }
  const sortOrderInput = String(req.body.sortOrder ?? "").trim();
  const sortOrder = sortOrderInput ? parseIntegerInput(sortOrderInput, 0) : null;
  await prisma.roomUnit.create({
    data: {
      hotelId: hotel.id,
      roomTypeId,
      name,
      sortOrder
    }
  });
  res.redirect("/admin/rooms?unitSaved=1");
});

adminRouter.post("/rooms/:roomTypeId/units/bulk", requirePermission("ROOMS", "MANAGE"), requirePlatformOwner, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/rooms");
    return;
  }
  const roomTypeId = String(req.params.roomTypeId ?? "");
  const prefix = String(req.body.prefix ?? "").trim();
  const start = Math.max(1, parseIntegerInput(req.body.start, 1));
  const count = Math.max(1, parseIntegerInput(req.body.count, 1));
  const names = Array.from({ length: count }, (_, index) => `${prefix}${start + index}`.trim()).filter(Boolean);
  const existing = await prisma.roomUnit.findMany({
    where: { roomTypeId, name: { in: names } },
    select: { name: true }
  });
  const existingNames = new Set(existing.map((row) => row.name));
  const createRows = names.filter((name) => !existingNames.has(name)).map((name, index) => ({ hotelId: hotel.id, roomTypeId, name, sortOrder: start + index }));
  if (createRows.length) {
    await prisma.roomUnit.createMany({ data: createRows });
  }
  res.redirect("/admin/rooms?unitSaved=1");
});

adminRouter.post("/rooms/units/:id/rename", requirePermission("ROOMS", "MANAGE"), requirePlatformOwner, async (req, res) => {
  const unitId = String(req.params.id ?? "");
  const name = String(req.body.name ?? "").trim();
  const sortOrderInput = String(req.body.sortOrder ?? "").trim();
  const sortOrder = sortOrderInput ? parseIntegerInput(sortOrderInput, 0) : null;
  if (!unitId || !name) {
    res.redirect("/admin/rooms");
    return;
  }
  await prisma.roomUnit.update({
    where: { id: unitId },
    data: { name, sortOrder }
  });
  res.redirect("/admin/rooms?unitSaved=1");
});

adminRouter.post("/rooms/units/:id/toggle", requirePermission("ROOMS", "MANAGE"), requirePlatformOwner, async (req, res) => {
  const unitId = String(req.params.id ?? "");
  const current = await prisma.roomUnit.findUnique({ where: { id: unitId }, select: { isActive: true } });
  if (!current) {
    res.redirect("/admin/rooms");
    return;
  }
  await prisma.roomUnit.update({ where: { id: unitId }, data: { isActive: !current.isActive } });
  res.redirect("/admin/rooms?unitSaved=1");
});

adminRouter.post("/rooms/season", requirePermission("ROOMS", "MANAGE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/rooms");
    return;
  }

  const season = req.body.season === "high" ? "high" : "low";
  const roomTypes = await prisma.roomType.findMany({ where: { hotelId: hotel.id } });

  await prisma.$transaction(
    roomTypes.map((room) =>
      prisma.roomType.update({
        where: { id: room.id },
        data: {
          baseNightlyRate: seasonalBaseRates[room.code]?.[season] ?? room.baseNightlyRate
        }
      })
    )
  );

  await logAudit({
    hotelId: hotel.id,
    action: "SEASONAL_RATE_APPLIED",
    entityType: "RoomType",
    metadata: {
      season,
      affectedRoomTypeIds: roomTypes.map((room) => room.id)
    }
  });

  res.redirect(`/admin/rooms?season=${season}&seasonApplied=1`);
});

adminRouter.post("/rooms/offers", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/rooms");
    return;
  }

  const offerCode = String(req.body.offerCode ?? "");
  const targetRoomId = String(req.body.targetRoomId ?? "ALL");
  const offer = readOffers().find((entry) => entry.code === offerCode && entry.isActive);
  if (!offer) {
    res.redirect("/admin/rooms");
    return;
  }
  const computedDiscount =
    offer.type === "STAY_X_GET_Y_FREE" && (offer.stayX ?? 0) > 0 && (offer.stayY ?? 0) > 0
      ? (offer.stayY ?? 0) / ((offer.stayX ?? 0) + (offer.stayY ?? 0))
      : offer.discountPercent / 100;
  const discount = clamp(computedDiscount, 0, 0.9);

  const roomTypes = await prisma.roomType.findMany({
    where: {
      hotelId: hotel.id,
      ...(targetRoomId !== "ALL" ? { id: targetRoomId } : {})
    }
  });

  await prisma.$transaction(
    roomTypes.map((room) =>
      prisma.roomType.update({
        where: { id: room.id },
        data: { baseNightlyRate: Number((room.baseNightlyRate * (1 - discount)).toFixed(2)) }
      })
    )
  );
  await logAudit({
    hotelId: hotel.id,
    action: "ROOM_OFFER_APPLIED",
    entityType: "RoomType",
    entityId: targetRoomId !== "ALL" ? targetRoomId : undefined,
    metadata: {
      offerCode,
      offerType: offer.type,
      discount,
      condition: {
        stayX: offer.stayX,
        stayY: offer.stayY,
        minDaysBeforeCheckIn: offer.minDaysBeforeCheckIn,
        minNights: offer.minNights,
        seasonStart: offer.seasonStart,
        seasonEnd: offer.seasonEnd,
        corporateOnly: offer.corporateOnly ?? false
      },
      affectedRoomTypeIds: roomTypes.map((room) => room.id)
    }
  });

  res.redirect("/admin/rooms?offer=1");
});

adminRouter.get("/inventory", requirePermission("ROOMS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Room Availability</h2><p>No hotel data found.</p>", true));
    return;
  }

  const start = parseDateInput(req.query.start, startOfDay(new Date()));
  const days = clamp(parseIntegerInput(req.query.days, 7), 3, 21);
  const endExclusive = addDays(start, days);
  const dates = enumerateDates(start, days);

  const inventoryRows = await prisma.inventory.findMany({
    where: { hotelId: hotel.id, date: { gte: start, lt: endExclusive } }
  });
  const inventoryMap = new Map<string, (typeof inventoryRows)[number]>();
  for (const row of inventoryRows) {
    inventoryMap.set(`${row.roomTypeId}_${formatDateForInput(row.date)}`, row);
  }

  const info = req.query.saved ? '<p class="badge ok">Inventory updated.</p>' : "";
  const rows = hotel.roomTypes
    .map((room) => {
      const cells = dates
        .map((date) => {
          const dateKey = formatDateForInput(date);
          const inv = inventoryMap.get(`${room.id}_${dateKey}`);
          const bookableTotal = inv?.total ?? room.totalInventory;
          const reserved = inv?.reserved ?? 0;
          const closedOut = inv?.closedOut ?? false;
          return `<td>
          <form method="post" action="/admin/inventory/update" style="display:grid; gap:6px">
            <input type="hidden" name="roomTypeId" value="${escapeHtml(room.id)}" />
            <input type="hidden" name="date" value="${dateKey}" />
            <input type="hidden" name="start" value="${formatDateForInput(start)}" />
            <input type="hidden" name="days" value="${days}" />
            <label style="font-size:12px; color:#5f6b7a">Bookable (max ${room.totalInventory})
              <input type="number" min="0" max="${room.totalInventory}" name="total" value="${bookableTotal}" style="width:100%; padding:6px; border:1px solid #d8dee6; border-radius:7px" />
            </label>
            <label style="font-size:12px; color:#5f6b7a">Reserved <input type="number" min="0" name="reserved" value="${reserved}" style="width:100%; padding:6px; border:1px solid #d8dee6; border-radius:7px" /></label>
            <label style="font-size:12px; display:flex; gap:6px; align-items:center"><input type="checkbox" name="closedOut" ${closedOut ? "checked" : ""} /> Closed</label>
            <button type="submit" style="padding:6px 10px; border:0; border-radius:7px; background:#25d366; color:#083d2d; font-weight:700">Save</button>
          </form>
          </td>`;
        })
        .join("");
      return `<tr><th>${escapeHtml(room.name)}</th>${cells}</tr>`;
    })
    .join("");

  const header = dates.map((date) => `<th>${formatDate(date)}</th>`).join("");
  const content = `
<h2>Room Availability</h2>
<p class="muted">Set <strong>bookable</strong> rooms per day (up to the owner-defined cap), reserved counts, and close-outs. To change the maximum rooms per category, the platform owner uses <strong>Room capacity</strong> under <code>/owner</code>.</p>
${info}
<form method="get" action="/admin/inventory" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Start <input type="date" name="start" value="${formatDateForInput(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>Days <input type="number" min="3" max="21" name="days" value="${days}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px; width:90px" /></label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Filter</button>
</form>
<table>
  <thead><tr><th>Room Type</th>${header}</tr></thead>
  <tbody>${rows || '<tr><td colspan="8">No room types found.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/inventory/update", requirePermission("ROOMS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/inventory");
    return;
  }

  const roomTypeId = String(req.body.roomTypeId ?? "");
  const date = parseDateInput(req.body.date, startOfDay(new Date()));
  const closedOut = req.body.closedOut === "on";

  const roomType = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId: hotel.id } });
  if (!roomType) {
    res.redirect("/admin/inventory");
    return;
  }

  const cap = roomType.totalInventory;
  const requestedTotal = Math.max(0, parseIntegerInput(req.body.total, 0));
  const total = Math.min(requestedTotal, cap);
  const reserved = clamp(parseIntegerInput(req.body.reserved, 0), 0, total);

  await prisma.inventory.upsert({
    where: { roomTypeId_date: { roomTypeId: roomType.id, date } },
    update: { total, reserved, closedOut },
    create: {
      hotelId: hotel.id,
      propertyId: roomType.propertyId,
      roomTypeId: roomType.id,
      date,
      total,
      reserved,
      closedOut
    }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "INVENTORY_UPDATED",
    entityType: "Inventory",
    entityId: `${roomType.id}:${formatDate(date)}`,
    metadata: { roomTypeId: roomType.id, date: formatDate(date), total, reserved, closedOut }
  });

  const start = encodeURIComponent(String(req.body.start ?? formatDateForInput(startOfDay(new Date()))));
  const days = encodeURIComponent(String(req.body.days ?? "7"));
  res.redirect(`/admin/inventory?start=${start}&days=${days}&saved=1`);
});

adminRouter.get("/bookings/search", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Find booking</h2><p>No hotel data found.</p>", true));
    return;
  }

  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const digitsOnly = qRaw.replace(/\D/g, "");
  const skipAutoRedirect = req.query.noredirect === "1";
  const queryOk = qRaw.length >= 2 || digitsOnly.length >= 3;

  const bookings = queryOk
    ? await prisma.booking.findMany({
        where: {
          hotelId: hotel.id,
          OR: (() => {
            const or: Prisma.BookingWhereInput[] = [];
            if (qRaw.length >= 2) {
              or.push({ id: { contains: qRaw } });
              or.push({ guest: { fullName: { contains: qRaw } } });
            }
            if (digitsOnly.length >= 3) {
              or.push({ guest: { phoneE164: { contains: digitsOnly } } });
              if (!qRaw.includes("+") && digitsOnly.length >= 8) {
                or.push({ guest: { phoneE164: { contains: `+${digitsOnly}` } } });
              }
            }
            return or;
          })()
        },
        include: {
          roomType: true,
          guest: { select: { id: true, fullName: true, phoneE164: true, isVip: true } },
          roomUnit: { select: { name: true } }
        },
        orderBy: [{ checkIn: "desc" }],
        take: 50
      })
    : [];

  if (queryOk && bookings.length === 1 && !skipAutoRedirect) {
    res.redirect(`/admin/bookings/${encodeURIComponent(bookings[0].id)}`);
    return;
  }

  const errMsg =
    qRaw.length > 0 && !queryOk
      ? '<p class="badge" style="background:#fef9c3;color:#854d0e;border-radius:8px;padding:8px 12px">Enter at least 2 characters, or 3+ digits for phone search.</p>'
      : "";
  const noResults =
    queryOk && bookings.length === 0
      ? '<p class="badge" style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:8px 12px">No bookings matched. Try booking ID, guest name, or phone.</p>'
      : "";
  const multiHint =
    queryOk && bookings.length > 1
      ? `<p class="muted" style="margin:0 0 8px">${bookings.length} matches — open the correct row below. <a class="inline-link" href="/admin/bookings/search?q=${encodeURIComponent(qRaw)}&noredirect=1">Pin this list</a> (no auto-open).</p>`
      : "";

  const rows = bookings
    .map(
      (b) => `<tr>
      <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(b.id)}">${escapeHtml(b.id)}</a></td>
      <td>${b.guest.isVip ? '<span class="badge" style="background:#d97706;color:#fff;border:0;font-weight:700" title="VIP">VIP</span> ' : ""}${escapeHtml(b.guest.fullName ?? "—")}</td>
      <td>${escapeHtml(b.guest.phoneE164)}</td>
      <td>${escapeHtml(b.roomType.name)}</td>
      <td>${b.roomUnit?.name ? escapeHtml(b.roomUnit.name) : '<span class="badge pending">—</span>'}</td>
      <td>${formatDate(b.checkIn)}</td>
      <td>${formatDate(b.checkOut)}</td>
      <td><span class="badge ${getBadgeClass(b.status)}">${escapeHtml(b.status)}</span></td>
      <td><span class="badge ${getBadgeClass(b.paymentStatus)}">${escapeHtml(b.paymentStatus)}</span></td>
      <td><a class="btn-link primary" style="padding:6px 10px;font-size:13px" href="/admin/bookings/${encodeURIComponent(b.id)}">Open details</a></td>
    </tr>`
    )
    .join("");

  const content = `
<h2>Find booking</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — Search by <strong>booking / reservation ID</strong>, <strong>guest name</strong>, or <strong>phone</strong>. A single match opens the booking page automatically.</p>
${errMsg}${noResults}${multiHint}
<form method="get" action="/admin/bookings/search" style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-bottom:16px; max-width:640px">
  <label style="flex:1; min-width:220px">Search
    <input type="search" name="q" value="${escapeHtml(qRaw)}" autocomplete="off" placeholder="e.g. WS-…, guest name, or phone" style="width:100%; margin-top:4px; padding:10px 12px; border:1px solid #d8dee6; border-radius:10px" autofocus />
  </label>
  <button type="submit" style="padding:10px 18px; border:0; border-radius:10px; background:#128c7e; color:#fff; font-weight:700">Search</button>
  <a class="btn-link" href="/admin/bookings">Booking report</a>
  <a class="btn-link" href="/admin/room-board">Room board</a>
</form>
${
  queryOk && bookings.length > 0
    ? `<table>
  <thead><tr><th>Booking ID</th><th>Guest</th><th>Phone</th><th>Room type</th><th>Unit</th><th>Check-in</th><th>Check-out</th><th>Booking</th><th>Payment</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
    : queryOk
      ? ""
      : '<p class="muted">Tip: paste the WhatsStay booking ID, type part of the guest name, or enter mobile digits (with or without country code).</p>'
}`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/guests/:guestId", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Guest</h2><p>No hotel data found.</p>", true));
    return;
  }

  const guestId = String(req.params.guestId ?? "");
  const g = await prisma.guest.findFirst({
    where: { id: guestId, hotelId: hotel.id },
    include: {
      segmentTags: { orderBy: { tag: "asc" } },
      bookings: {
        orderBy: { checkIn: "desc" },
        take: 24,
        select: {
          id: true,
          referenceCode: true,
          checkIn: true,
          checkOut: true,
          status: true,
          source: true,
          nights: true
        }
      }
    }
  });

  if (!g) {
    res.status(404).type("html").send(renderLayout("<h2>Guest not found</h2><p>Check the link or open the guest from a booking.</p>", true));
    return;
  }

  const lightGuestMemoryJson =
    (g as { lightGuestMemoryJson?: string | null }).lightGuestMemoryJson ?? null;

  const savedNotice = req.query.saved ? '<p class="badge ok">Profile saved.</p>' : "";
  const manualSet = new Set(
    g.segmentTags.filter((t) => t.source === SegmentTagSource.MANUAL).map((t) => t.tag)
  );
  const tagCheckboxes = (Object.keys(SEGMENT_TAG_LABELS) as SegmentTagKind[])
    .map(
      (tag) => `<label style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:14px">
  <input type="checkbox" name="manualTags" value="${escapeHtml(tag)}" ${manualSet.has(tag) ? "checked" : ""} />
  <span>${escapeHtml(SEGMENT_TAG_LABELS[tag])}</span>
</label>`
    )
    .join("");

  const summaryHtml = formatGuestVipAndTagsHtml({
    guestId: g.id,
    isVip: g.isVip,
    vipNote: g.vipNote,
    tags: g.segmentTags,
    showProfileLink: false
  });

  const bookingRows = g.bookings
    .map(
      (b) => `<tr>
  <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(b.id)}">${escapeHtml(b.id)}</a></td>
  <td>${escapeHtml(b.referenceCode ?? "—")}</td>
  <td>${formatDate(b.checkIn)}</td>
  <td>${formatDate(b.checkOut)}</td>
  <td>${b.nights}</td>
  <td>${escapeHtml(b.source)}</td>
  <td><span class="badge ${getBadgeClass(b.status)}">${escapeHtml(b.status)}</span></td>
</tr>`
    )
    .join("");

  const content = `
<h2>Guest profile</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — Segmentation, VIP, and recent bookings.</p>
${savedNotice}
<div class="actions">
  <a class="btn-link" href="/admin/bookings/search">Find booking</a>
  <a class="btn-link" href="/admin/bookings">Booking report</a>
  <a class="btn-link" href="/admin/conversations">Conversations</a>
</div>

<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:920px">
  <h3 style="margin-top:0">Current labels</h3>
  <div style="line-height:1.7">${summaryHtml}</div>
  <p class="muted" style="margin:12px 0 0;font-size:13px">Automatic tags refresh from booking history after saves and when bookings change. Manual tags are chosen below.</p>
</section>

<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:920px">
  <h3 style="margin-top:0">Guest details</h3>
  <table>
    <tbody>
      <tr><th>Name</th><td>${escapeHtml(g.fullName ?? "—")}</td></tr>
      <tr><th>Phone</th><td>${escapeHtml(g.phoneE164)}</td></tr>
      <tr><th>Email</th><td>${escapeHtml(g.email ?? "—")}</td></tr>
    </tbody>
  </table>
</section>

<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:920px">
  <h3 style="margin-top:0">WhatsApp light memory</h3>
  <p class="muted" style="margin-top:0;font-size:13px">Read-only summary used for subtle personalization in chat (preferences, repeat stay signals, spending band). Updated from confirmed bookings and journey replies — not a medical or payment record.</p>
  ${
    lightGuestMemoryJson
      ? (() => {
          try {
            const formatted = JSON.stringify(JSON.parse(lightGuestMemoryJson), null, 2);
            return `<pre style="white-space:pre-wrap;font-size:12px;max-height:360px;overflow:auto;background:#f6f8fa;padding:12px;border-radius:8px;border:1px solid var(--border)">${escapeHtml(formatted)}</pre>`;
          } catch {
            return `<p class="badge">Could not parse stored JSON.</p><pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(
              lightGuestMemoryJson.slice(0, 2000)
            )}</pre>`;
          }
        })()
      : '<p class="muted">No automated memory stored yet.</p>'
  }
</section>

<section style="margin:16px 0; padding:16px; background:var(--card); border:1px solid var(--border); border-radius:12px; max-width:920px">
  <h3 style="margin-top:0">VIP &amp; manual tags</h3>
  <form method="post" action="/admin/guests/${encodeURIComponent(g.id)}" style="display:grid; gap:12px; max-width:560px">
    <label style="display:flex; align-items:center; gap:10px; font-weight:600">
      <input type="checkbox" name="isVip" value="1" ${g.isVip ? "checked" : ""} /> Mark as VIP
    </label>
    <label>VIP / service note (internal)
      <textarea name="vipNote" rows="3" placeholder="Preferences, anniversaries, recognition…" style="width:100%; padding:10px; border:1px solid var(--border); border-radius:8px; font-family:inherit">${escapeHtml(g.vipNote ?? "")}</textarea>
    </label>
    <div>
      <p class="muted" style="margin:0 0 8px;font-size:13px">Manual segment tags (in addition to automatic rules)</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:4px">${tagCheckboxes}</div>
    </div>
    <button type="submit" style="padding:10px 16px; border:0; border-radius:10px; background:#128c7e; color:#fff; font-weight:700; width:fit-content">Save</button>
  </form>
</section>

<section style="margin:16px 0; max-width:920px">
  <h3>Recent bookings</h3>
  <table>
    <thead><tr><th>ID</th><th>Reference</th><th>Check-in</th><th>Check-out</th><th>Nights</th><th>Source</th><th>Status</th></tr></thead>
    <tbody>${bookingRows || '<tr><td colspan="7">No bookings yet.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/guests/:guestId", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }

  const guestId = String(req.params.guestId ?? "");
  const existing = await prisma.guest.findFirst({
    where: { id: guestId, hotelId: hotel.id },
    select: { id: true }
  });
  if (!existing) {
    res.status(404).type("html").send(renderLayout("<h2>Guest not found</h2>", true));
    return;
  }

  const body = req.body as Record<string, unknown>;
  const isVip = body.isVip === "1" || body.isVip === "on";
  const vipNote = String(body.vipNote ?? "").trim().slice(0, 500) || null;
  const manual = parseManualSegmentTagsFromBody(body);

  await prisma.$transaction(async (tx) => {
    await tx.guest.update({
      where: { id: guestId },
      data: { isVip, vipNote }
    });
    await tx.guestSegmentTag.deleteMany({
      where: { guestId, source: SegmentTagSource.MANUAL }
    });
    if (manual.length) {
      await tx.guestSegmentTag.createMany({
        data: manual.map((tag) => ({ guestId, tag, source: SegmentTagSource.MANUAL }))
      });
    }
  });
  await refreshGuestSegmentTagsForGuest(guestId);
  await logAudit({
    hotelId: hotel.id,
    action: "GUEST_SEGMENTATION_UPDATED",
    entityType: "Guest",
    entityId: guestId,
    metadata: { isVip, manualTags: manual }
  });
  res.redirect(`/admin/guests/${encodeURIComponent(guestId)}?saved=1`);
});

adminRouter.get("/bookings", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: platformHotelSlug } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Bookings</h2><p>No hotel data found.</p>", true));
    return;
  }

  const activePropertyId = await resolveActivePropertyIdForHotel(req, hotel.id);
  const now = startOfDay(new Date());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultEndInclusive = defaultBookingReportInclusiveEnd(now);
  const start = parseDateInput(req.query.start, monthStart);
  const end = parseDateInput(req.query.end, defaultEndInclusive);
  const endExclusive = addDays(end, 1);
  const status = typeof req.query.status === "string" ? req.query.status : "ALL";
  const allowedStatuses: BookingStatus[] = [
    BookingStatus.PENDING,
    BookingStatus.CONFIRMED,
    BookingStatus.CANCELLED,
    BookingStatus.NO_SHOW
  ];
  const selectedStatus: BookingStatus | null = allowedStatuses.includes(status as BookingStatus)
    ? (status as BookingStatus)
    : null;

  const paymentStatusParam = typeof req.query.paymentStatus === "string" ? req.query.paymentStatus.trim() : "ALL";
  const allPaymentFilterValues: PaymentStatus[] = [
    PaymentStatus.REQUIRES_ACTION,
    PaymentStatus.PENDING,
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.REFUNDED,
    PaymentStatus.LPO,
    PaymentStatus.FRIENDS_TRANSFER
  ];
  const selectedPaymentStatus: PaymentStatus | null =
    paymentStatusParam !== "ALL" && allPaymentFilterValues.includes(paymentStatusParam as PaymentStatus)
      ? (paymentStatusParam as PaymentStatus)
      : null;

  const bookings = await prisma.booking.findMany({
    where: {
      hotelId: hotel.id,
      ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}),
      checkIn: { gte: start, lt: endExclusive },
      ...(selectedStatus ? { status: selectedStatus } : {}),
      ...(selectedPaymentStatus ? { paymentStatus: selectedPaymentStatus } : {})
    },
    include: { roomType: true, guest: true, conversation: { select: { id: true } }, roomUnit: { select: { name: true } } },
    orderBy: { checkIn: "asc" }
  });

  const conversationsCount = await prisma.conversation.count({
    where: { hotelId: hotel.id, ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}), createdAt: { gte: start, lt: endExclusive } }
  });

  const revenue = bookings.reduce((sum, booking) => sum + booking.totalAmount, 0);
  const confirmed = bookings.filter((booking) => booking.status === "CONFIRMED").length;
  const pending = bookings.filter((booking) => booking.status === "PENDING").length;
  const cancelled = bookings.filter((booking) => booking.status === "CANCELLED").length;
  const whatsappConfirmed = bookings.filter((booking) => booking.status === "CONFIRMED" && Boolean(booking.conversationId)).length;

  const rows = bookings
    .map(
      (booking) => {
        const sourceLabel = booking.conversationId ? "WhatsApp" : booking.source;
        const guestName = booking.guest.fullName ?? "-";
        const vipMark = booking.guest.isVip
          ? '<span class="badge" style="background:#d97706;color:#fff;border:0;font-weight:700;margin-right:6px" title="VIP guest">VIP</span>'
          : "";
        const rowClass = booking.status === "CONFIRMED" && sourceLabel === "WhatsApp" ? ' class="booking-whatsapp-confirmed"' : "";
        const unitAssignmentBadge = booking.roomUnitId
          ? `<span class="badge ok">Unit assigned${booking.roomUnit?.name ? ` (${escapeHtml(booking.roomUnit.name)})` : ""}</span>`
          : '<span class="badge pending">Pending assignment</span>';
        return `<tr${rowClass}>
      <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">${escapeHtml(displayBookingReference(booking))}</a></td>
      <td>${vipMark}${escapeHtml(guestName)} <a class="inline-link" style="font-size:12px" href="/admin/guests/${encodeURIComponent(booking.guest.id)}" title="Guest profile">Profile</a></td>
      <td>${escapeHtml(booking.guest.phoneE164)}</td>
      <td>${escapeHtml(booking.roomType.name)}</td>
      <td>${formatDate(booking.checkIn)}</td>
      <td>${formatDate(booking.checkOut)}</td>
      <td>${booking.adults}</td>
      <td>${booking.nights}</td>
      <td>${formatMoney(booking.totalAmount, hotel.currency)}</td>
      <td><span class="badge ${getBadgeClass(booking.status)}">${escapeHtml(booking.status)}</span></td>
      <td><span class="badge ${getBadgeClass(booking.paymentStatus)}">${escapeHtml(booking.paymentStatus)}</span></td>
      <td>${unitAssignmentBadge}</td>
      <td><span class="badge ${sourceLabel === "WhatsApp" ? "ok" : "pending"}">${escapeHtml(String(sourceLabel))}</span></td>
      <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">Open details</a></td>
      </tr>`
      }
    )
    .join("");

  const content = `
<h2>Reports & Bookings</h2>
<p class="muted">Filter performance by date range, booking status, and track revenue trends. Default range uses <strong>check-in from the start of this month through the end of the month three months ahead</strong> so newly confirmed WhatsApp stays (often for future dates) appear without changing dates.</p>
<form method="get" action="/admin/bookings" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end">
  <label>From <input type="date" name="start" value="${formatDateForInput(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>To <input type="date" name="end" value="${formatDateForInput(end)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>Booking status
    <select name="status" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="ALL" ${status === "ALL" ? "selected" : ""}>All</option>
      <option value="PENDING" ${status === "PENDING" ? "selected" : ""}>Pending</option>
      <option value="CONFIRMED" ${status === "CONFIRMED" ? "selected" : ""}>Confirmed</option>
      <option value="CANCELLED" ${status === "CANCELLED" ? "selected" : ""}>Cancelled</option>
      <option value="NO_SHOW" ${status === "NO_SHOW" ? "selected" : ""}>No Show</option>
    </select>
  </label>
  <label>Payment status
    <select name="paymentStatus" style="padding:8px; border:1px solid #d8dee6; border-radius:8px; max-width:220px">
      <option value="ALL" ${paymentStatusParam === "ALL" ? "selected" : ""}>All</option>
      <option value="PENDING" ${paymentStatusParam === "PENDING" ? "selected" : ""}>Pending</option>
      <option value="REQUIRES_ACTION" ${paymentStatusParam === "REQUIRES_ACTION" ? "selected" : ""}>Requires action</option>
      <option value="LPO" ${paymentStatusParam === "LPO" ? "selected" : ""}>LPO (company PO)</option>
      <option value="FRIENDS_TRANSFER" ${paymentStatusParam === "FRIENDS_TRANSFER" ? "selected" : ""}>Friends transfer</option>
      <option value="SUCCEEDED" ${paymentStatusParam === "SUCCEEDED" ? "selected" : ""}>Succeeded</option>
      <option value="FAILED" ${paymentStatusParam === "FAILED" ? "selected" : ""}>Failed</option>
      <option value="REFUNDED" ${paymentStatusParam === "REFUNDED" ? "selected" : ""}>Refunded</option>
    </select>
  </label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
  <a class="btn-link" href="/admin/bookings/export?start=${encodeURIComponent(formatDateForInput(start))}&end=${encodeURIComponent(formatDateForInput(end))}&status=${encodeURIComponent(status)}&paymentStatus=${encodeURIComponent(paymentStatusParam)}">Export CSV</a>
  <a class="btn-link" href="/admin/bookings/export?start=${encodeURIComponent(formatDateForInput(start))}&end=${encodeURIComponent(formatDateForInput(end))}&paymentStatus=LPO">Export LPO follow-up</a>
  <a class="btn-link" href="/admin/bookings/export?start=${encodeURIComponent(formatDateForInput(start))}&end=${encodeURIComponent(formatDateForInput(end))}&paymentStatus=FRIENDS_TRANSFER">Export friends transfer</a>
</form>
<div class="grid-4">
  <article class="stat"><h3>Total bookings</h3><p><a class="stat-link" href="/admin/bookings?start=${formatDateForInput(start)}&end=${formatDateForInput(end)}&status=ALL">${bookings.length}</a></p></article>
  <article class="stat"><h3>Confirmed</h3><p><a class="stat-link" href="/admin/bookings?start=${formatDateForInput(start)}&end=${formatDateForInput(end)}&status=CONFIRMED">${confirmed}</a></p></article>
  <article class="stat"><h3>WhatsApp Confirmed</h3><p>${whatsappConfirmed}</p></article>
  <article class="stat"><h3>Pending / Cancelled</h3><p><a class="stat-link" href="/admin/bookings?start=${formatDateForInput(start)}&end=${formatDateForInput(end)}&status=PENDING">${pending}</a> / <a class="stat-link" href="/admin/bookings?start=${formatDateForInput(start)}&end=${formatDateForInput(end)}&status=CANCELLED">${cancelled}</a></p></article>
  <article class="stat"><h3>Revenue</h3><p><a class="stat-link" href="/admin/billing">${formatMoney(revenue, hotel.currency)}</a></p></article>
</div>
<p class="muted" style="margin-top:10px">Conversations in range: <strong><a class="inline-link" href="/admin/conversations?start=${formatDateForInput(start)}&end=${formatDateForInput(end)}">${conversationsCount}</a></strong> (opens conversations filtered by this date range)</p>
<style>
  .booking-whatsapp-confirmed { background: #f3fff8; }
</style>
<table>
  <thead><tr><th>Reference</th><th>Guest Name</th><th>Phone Number</th><th>Room Type</th><th>Check-in</th><th>Check-out</th><th>Guests</th><th>Nights</th><th>Total Amount</th><th>Booking Status</th><th>Payment Status</th><th>Unit Assignment</th><th>Source</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="14">No bookings in selected range.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/bookings/export", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: platformHotelSlug }, select: { id: true, currency: true } });
  if (!hotel) {
    res.status(404).send("Hotel not found");
    return;
  }
  const activePropertyId = await resolveActivePropertyIdForHotel(req, hotel.id);
  const now = startOfDay(new Date());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultEndInclusive = defaultBookingReportInclusiveEnd(now);
  const start = parseDateInput(req.query.start, monthStart);
  const end = parseDateInput(req.query.end, defaultEndInclusive);
  const endExclusive = addDays(end, 1);
  const status = typeof req.query.status === "string" ? req.query.status : "ALL";
  const allowedStatuses: BookingStatus[] = [
    BookingStatus.PENDING,
    BookingStatus.CONFIRMED,
    BookingStatus.CANCELLED,
    BookingStatus.NO_SHOW
  ];
  const selectedStatus: BookingStatus | null = allowedStatuses.includes(status as BookingStatus) ? (status as BookingStatus) : null;
  const paymentStatusParam = typeof req.query.paymentStatus === "string" ? req.query.paymentStatus.trim() : "ALL";
  const allPaymentFilterValues: PaymentStatus[] = [
    PaymentStatus.REQUIRES_ACTION,
    PaymentStatus.PENDING,
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.REFUNDED,
    PaymentStatus.LPO,
    PaymentStatus.FRIENDS_TRANSFER
  ];
  const selectedPaymentStatus: PaymentStatus | null =
    paymentStatusParam !== "ALL" && allPaymentFilterValues.includes(paymentStatusParam as PaymentStatus)
      ? (paymentStatusParam as PaymentStatus)
      : null;

  const bookings = await prisma.booking.findMany({
    where: {
      hotelId: hotel.id,
      ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}),
      checkIn: { gte: start, lt: endExclusive },
      ...(selectedStatus ? { status: selectedStatus } : {}),
      ...(selectedPaymentStatus ? { paymentStatus: selectedPaymentStatus } : {})
    },
    include: {
      guest: true,
      roomType: true,
      conversation: { select: { id: true } },
      roomUnit: { select: { name: true } }
    },
    orderBy: { checkIn: "asc" }
  });

  const header = [
    "Booking ID",
    "Guest name",
    "Phone",
    "Email",
    "Room type",
    "Unit",
    "Check-in",
    "Check-out",
    "Nights",
    "Total amount",
    "Currency",
    "Booking status",
    "Payment status",
    "Source"
  ];
  const lines = [header.map(csvEscapeField).join(",")];
  for (const b of bookings) {
    const sourceLabel = b.conversationId ? "WhatsApp" : b.source;
    lines.push(
      [
        b.id,
        b.guest.fullName ?? "",
        b.guest.phoneE164,
        b.guest.email ?? "",
        b.roomType.name,
        b.roomUnit?.name ?? "",
        formatDateForInput(b.checkIn),
        formatDateForInput(b.checkOut),
        String(b.nights),
        String(b.totalAmount),
        b.currency,
        b.status,
        b.paymentStatus,
        sourceLabel
      ]
        .map((cell) => csvEscapeField(String(cell)))
        .join(",")
    );
  }
  const filename = `bookings-${formatDateForInput(start)}-to-${formatDateForInput(end)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\ufeff" + lines.join("\n"));
});

adminRouter.get("/reports", requirePermission("REPORTS", "VIEW"), (_req, res) => {
  res.redirect("/admin/reports-center");
});

adminRouter.get("/daily-digest", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Daily digest</h2><p>No hotel data found.</p>", true));
    return;
  }
  const logs = await prisma.hotelDailyDigestLog.findMany({
    where: { hotelId: hotel.id },
    orderBy: { digestKey: "desc" },
    take: 25
  });
  const tz = (hotel.timezone ?? "Asia/Muscat").trim();
  const sendTime = (process.env.HOTEL_DIGEST_TIME ?? "07:15").trim();
  const enabled = process.env.HOTEL_DIGEST_ENABLED !== "false";
  const smtpOk = isOwnerDigestSmtpConfigured();
  const sentFlash = req.query.sent === "1";
  const errFlash = typeof req.query.err === "string" ? req.query.err : "";

  const logRows = logs
    .map((row) => {
      let sumLine = "—";
      if (row.summaryJson) {
        try {
          const j = JSON.parse(row.summaryJson) as { bookingsTotal?: number; alertCount?: number };
          sumLine = `Bookings ${j.bookingsTotal ?? "—"} · alerts ${j.alertCount ?? "—"}`;
        } catch {
          /* ignore */
        }
      }
      return `<tr>
  <td>${escapeHtml(row.digestKey)}</td>
  <td>${escapeHtml(row.status)}</td>
  <td>${row.sentAt ? escapeHtml(row.sentAt.toISOString().slice(0, 19).replace("T", " ")) : "—"}</td>
  <td>${row.recipientsCsv ? escapeHtml(row.recipientsCsv.length > 90 ? `${row.recipientsCsv.slice(0, 90)}…` : row.recipientsCsv) : "—"}</td>
  <td class="muted" style="font-size:12px">${escapeHtml(sumLine)}</td>
  <td>${row.errorMessage ? escapeHtml(row.errorMessage.slice(0, 120)) : "—"}</td>
</tr>`;
    })
    .join("");

  const flash =
    sentFlash && !errFlash
      ? '<p class="badge ok" style="display:inline-block;margin-bottom:12px">Digest run finished. See log below.</p>'
      : errFlash
        ? `<p class="badge alert" style="display:inline-block;margin-bottom:12px">${escapeHtml(errFlash)}</p>`
        : "";

  const content = `
<h2>Daily digest email</h2>
<p class="muted">One automated email per property per day in the hotel timezone. Recipients: active <strong>OWNER</strong> and <strong>MANAGER</strong> users; if none, <code>ADMIN_EMAIL</code>. Content is scoped to this hotel only.</p>
${flash}
<div class="grid-2" style="margin-bottom:14px;align-items:start">
  <section>
    <h3 style="margin-top:0">Schedule</h3>
    <table>
      <tbody>
        <tr><th>Scheduler</th><td>${enabled ? '<span class="badge ok">On</span>' : '<span class="badge pending">Off</span>'}</td></tr>
        <tr><th>Hotel timezone</th><td>${escapeHtml(tz)}</td></tr>
        <tr><th>Send time (local)</th><td>${escapeHtml(sendTime)}</td></tr>
        <tr><th>SMTP</th><td>${smtpOk ? '<span class="badge ok">Configured</span>' : '<span class="badge alert">Not configured</span>'}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3 style="margin-top:0">Send now</h3>
    <form method="post" action="/admin/daily-digest/send" style="margin:0">
      <label style="display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:10px">
        <input type="checkbox" name="force" value="1" /> Force resend even if today already sent
      </label>
      <button type="submit" style="padding:9px 14px;border:0;border-radius:10px;background:#075e54;color:#fff;font-weight:700">Run digest now</button>
    </form>
  </section>
</div>
<h3>Recent log</h3>
<table>
  <thead><tr><th>Day</th><th>Status</th><th>Sent (UTC)</th><th>Recipients</th><th>Summary</th><th>Error</th></tr></thead>
  <tbody>${logRows.length ? logRows : `<tr><td colspan="6" class="muted">No rows yet.</td></tr>`}</tbody>
</table>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/daily-digest/send", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" }
  });
  if (!hotel) {
    res.redirect("/admin/daily-digest?err=" + encodeURIComponent("No hotel"));
    return;
  }
  const force =
    req.body?.force === "1" || req.body?.force === "on" || req.body?.force === true || req.body?.force === "true";
  const result = await runHotelDailyDigest({ hotelId: hotel.id, manual: true, force });
  const p = new URLSearchParams();
  if (result.ok) p.set("sent", "1");
  else p.set("err", encodeURIComponent(result.message ?? result.status));
  res.redirect(`/admin/daily-digest?${p.toString()}`);
});

adminRouter.get("/management-kpi", requirePermission("REPORTS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { roomTypes: { where: { isActive: true }, select: { id: true, totalInventory: true } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Management KPI</h2><p>No hotel data found.</p>", true));
    return;
  }

  const presetRaw = typeof req.query.preset === "string" ? req.query.preset : "today";
  const customStart = parseDateInput(req.query.start, startOfDay(new Date()));
  const customEnd = parseDateInput(req.query.end, startOfDay(new Date()));
  const { rangeStart, rangeEndExclusive, presetLabel } = parseKpiPreset(
    presetRaw,
    presetRaw === "custom" ? customStart : undefined,
    presetRaw === "custom" ? customEnd : undefined
  );

  const kpi = await loadManagementKpis({
    hotelId: hotel.id,
    currency: hotel.currency,
    rangeStart,
    rangeEndExclusive,
    roomTypes: hotel.roomTypes
  });

  const srcRows = kpi.bookingSources
    .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${r.count}</td></tr>`)
    .join("");
  const folioPayRows = kpi.paymentFolioBuckets
    .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${r.count}</td><td>${formatMoney(r.amount, hotel.currency)}</td></tr>`)
    .join("");
  const bookingPayRows = kpi.bookingPaymentStatusMix
    .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${r.count}</td></tr>`)
    .join("");

  const content = `
<h2>Management KPI dashboard</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — ${escapeHtml(presetLabel)} · <strong>${escapeHtml(kpi.rangeLabel)}</strong>. ${escapeHtml(kpi.operationalDayNote)}</p>
<p class="muted" style="font-size:12px;max-width:900px">
  Bookings and room revenue use stays with <strong>check-in</strong> in the selected range (same idea as the booking report).
  <strong>Total revenue (approx.)</strong> = room (confirmed) + posted <code>FbOrder</code> totals + all non-void folio <strong>charge</strong> lines (excl. payments/refunds) with <strong>charge date</strong> in range.
  F&amp;B appears twice in concept: WhatsApp/menu <code>FbOrder</code> totals are separate from F&amp;B <strong>folio ledger</strong> lines — do not add those two columns together (they are different posting paths).
  Folio <strong>payments</strong> are cash-flow collections by method; walk-in vs guest split shows cashier-style activity. Occupancy / ADR / RevPAR use room-type inventory × days in range (simplified PMS-style view).
</p>

<form method="get" action="/admin/management-kpi" style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; margin-bottom:16px">
  <label>Quick range
    <select name="preset" style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-top:4px;display:block">
      <option value="today" ${presetRaw === "today" ? "selected" : ""}>Today</option>
      <option value="week" ${presetRaw === "week" ? "selected" : ""}>This week</option>
      <option value="month" ${presetRaw === "month" ? "selected" : ""}>This month</option>
      <option value="custom" ${presetRaw === "custom" ? "selected" : ""}>Custom</option>
    </select>
  </label>
  <label>From <input type="date" name="start" value="${escapeHtml(formatDateForInput(customStart))}" style="padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
  <label>To <input type="date" name="end" value="${escapeHtml(formatDateForInput(customEnd))}" style="padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
  <button type="submit" style="padding:9px 14px;border:0;border-radius:8px;background:#075e54;color:#fff;font-weight:700">Apply</button>
</form>

<div class="grid-4">
  <article class="stat"><h3>Occupancy (range)</h3><p>${kpi.occupancyRatePct.toFixed(1)}%</p><p class="muted" style="font-size:12px;margin:0">Booked nights / capacity nights</p></article>
  <article class="stat"><h3>Room revenue</h3><p>${formatMoney(kpi.roomRevenue, hotel.currency)}</p><p class="muted" style="font-size:12px;margin:0">Confirmed stays, check-in in range</p></article>
  <article class="stat"><h3>Total revenue (approx.)</h3><p>${formatMoney(kpi.totalRevenueApprox, hotel.currency)}</p><p class="muted" style="font-size:12px;margin:0">Room + F&amp;B posted + folio charges</p></article>
  <article class="stat"><h3>Bookings</h3><p>${kpi.bookingsTotal}</p><p class="muted" style="font-size:12px;margin:0">Check-in in range (all statuses)</p></article>
</div>

<div class="grid-4" style="margin-top:12px">
  <article class="stat"><h3>Conversations</h3><p>${kpi.conversationsTotal}</p><p class="muted" style="font-size:12px;margin:0">New threads in range</p></article>
  <article class="stat"><h3>ADR</h3><p>${formatMoney(kpi.adr, hotel.currency)}</p><p class="muted" style="font-size:12px;margin:0">Room revenue / booked nights</p></article>
  <article class="stat"><h3>RevPAR</h3><p>${formatMoney(kpi.revpar, hotel.currency)}</p><p class="muted" style="font-size:12px;margin:0">Room revenue / capacity nights</p></article>
  <article class="stat"><h3>Messages</h3><p>${kpi.messagesInbound + kpi.messagesOutbound}</p><p class="muted" style="font-size:12px;margin:0">In ${kpi.messagesInbound} · Out ${kpi.messagesOutbound}</p></article>
</div>

<div class="grid-2" style="margin-top:18px;align-items:start">
  <section style="padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
    <h3 style="margin-top:0">Operational snapshot</h3>
    <p class="muted" style="font-size:13px">Arrivals, departures, and stayovers on the snapshot day described above.</p>
    <table>
      <tbody>
        <tr><th>Active room units</th><td>${kpi.totalRoomUnits}</td></tr>
        <tr><th>Inactive / off-sale units</th><td>${kpi.inactiveRoomUnits}</td></tr>
        <tr><th>Arrivals</th><td>${kpi.arrivalsOnSnapshot}</td></tr>
        <tr><th>Departures</th><td>${kpi.departuresOnSnapshot}</td></tr>
        <tr><th>Stayovers (in-house)</th><td>${kpi.stayoversOnSnapshot}</td></tr>
        <tr><th>Capacity nights (range)</th><td>${kpi.totalRoomNightsCapacity}</td></tr>
        <tr><th>Booked nights (range)</th><td>${kpi.bookedRoomNightsInPeriod}</td></tr>
      </tbody>
    </table>
  </section>
  <section style="padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
    <h3 style="margin-top:0">Booking pipeline</h3>
    <table>
      <tbody>
        <tr><th>Confirmed</th><td>${kpi.bookingsConfirmed}</td></tr>
        <tr><th>Pending</th><td>${kpi.bookingsPending}</td></tr>
        <tr><th>Cancelled</th><td>${kpi.bookingsCancelled}</td></tr>
        <tr><th>No-show</th><td>${kpi.bookingsNoShow}</td></tr>
      </tbody>
    </table>
  </section>
</div>

<div class="grid-2" style="margin-top:18px;align-items:start">
  <section style="padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
    <h3 style="margin-top:0">Revenue mix</h3>
    <p class="muted" style="font-size:12px;margin:0 0 10px">Top-level components of <strong>total revenue (approx.)</strong>. Folio rows are ledger charges (not payments).</p>
    <table>
      <tbody>
        <tr><th>Room (confirmed)</th><td>${formatMoney(kpi.roomRevenue, hotel.currency)}</td></tr>
        <tr><th>F&amp;B — posted guest orders (<code>FbOrder</code>)</th><td>${formatMoney(kpi.fbRevenue, hotel.currency)}</td></tr>
        <tr><th>Folio charges total (excl. payments / refunds)</th><td>${formatMoney(kpi.folioExtraRevenue, hotel.currency)}</td></tr>
      </tbody>
    </table>
    <h4 style="margin:14px 0 8px;font-size:14px">Folio charge breakdown (same period)</h4>
    <table>
      <tbody>
        <tr><th>F&amp;B — in-house guest folio</th><td>${formatMoney(kpi.folioFnbGuestChargesNet, hotel.currency)}</td></tr>
        <tr><th>F&amp;B — walk-in / direct (no booking)</th><td>${formatMoney(kpi.folioFnbDirectChargesNet, hotel.currency)}</td></tr>
        <tr><th>Activities</th><td>${formatMoney(kpi.folioActivityChargesNet, hotel.currency)}</td></tr>
        <tr><th>Other services</th><td>${formatMoney(kpi.folioOtherServiceChargesNet, hotel.currency)}</td></tr>
        <tr><th>Adjustments &amp; discounts (net)</th><td>${formatMoney(kpi.folioAdjustmentsAndDiscountsNet, hotel.currency)}</td></tr>
      </tbody>
    </table>
    <p class="muted" style="font-size:11px;margin:10px 0 0">The five breakdown lines sum to the folio charges total (minor rounding differences possible). <code>FbOrder</code> revenue is additional visibility for menu orders, not a subset of the folio F&amp;B lines above.</p>
  </section>
  <section style="padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
    <h3 style="margin-top:0">Guest messaging</h3>
    <table>
      <tbody>
        <tr><th>Conversations (new in range)</th><td>${kpi.conversationsTotal}</td></tr>
        <tr><th>With at least one booking</th><td>${kpi.conversationsWithBooking}</td></tr>
        <tr><th>Human handoff</th><td>${kpi.conversationsHumanHandoff}</td></tr>
        <tr><th>Inbound messages</th><td>${kpi.messagesInbound}</td></tr>
        <tr><th>Outbound messages</th><td>${kpi.messagesOutbound}</td></tr>
      </tbody>
    </table>
  </section>
</div>

<div class="grid-2" style="margin-top:18px;align-items:start">
  <section style="padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
    <h3 style="margin-top:0">Booking source (check-in in range)</h3>
    <table>
      <thead><tr><th>Source</th><th>Bookings</th></tr></thead>
      <tbody>${srcRows || '<tr><td colspan="2">No data</td></tr>'}</tbody>
    </table>
  </section>
  <section style="padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
    <h3 style="margin-top:0">Booking payment status</h3>
    <table>
      <thead><tr><th>Status</th><th>Count</th></tr></thead>
      <tbody>${bookingPayRows || '<tr><td colspan="2">No data</td></tr>'}</tbody>
    </table>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Stripe prepayments appear when payment status is updated on the booking; folio desk payments are broken out below.</p>
  </section>
</div>

<section style="margin-top:18px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
  <h3 style="margin-top:0">Folio desk payments (by method)</h3>
  <p class="muted" style="font-size:13px">Posted folio payment lines with <strong>charge date</strong> in range. Labels are derived from <code>folioPaymentMethod</code> (normalized buckets).</p>
  <table style="margin-bottom:12px">
    <tbody>
      <tr><th>Guest / booking-linked payments</th><td>${kpi.folioPaymentsGuestBooking.count} lines</td><td>${formatMoney(kpi.folioPaymentsGuestBooking.amount, hotel.currency)}</td></tr>
      <tr><th>Walk-in (no booking) — cashier / POS</th><td>${kpi.folioPaymentsWalkIn.count} lines</td><td>${formatMoney(kpi.folioPaymentsWalkIn.amount, hotel.currency)}</td></tr>
    </tbody>
  </table>
  <table>
    <thead><tr><th>Bucket</th><th>Lines</th><th>Amount</th></tr></thead>
    <tbody>${folioPayRows || '<tr><td colspan="3">No folio payments in range</td></tr>'}</tbody>
  </table>
</section>

<section style="margin-top:18px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px">
  <h3 style="margin-top:0">Campaigns (marketing)</h3>
  <table>
    <tbody>
      <tr><th>Campaigns created</th><td>${kpi.campaignsInPeriod}</td></tr>
      <tr><th>Audience seats (sum)</th><td>${kpi.campaignAudienceReached}</td></tr>
      <tr><th>WhatsApp sent (ok)</th><td>${kpi.campaignSentOk}</td></tr>
      <tr><th>WhatsApp failed</th><td>${kpi.campaignSentFailed}</td></tr>
    </tbody>
  </table>
  <p class="muted" style="font-size:12px;margin:8px 0 0"><a class="inline-link" href="/admin/campaigns">Open campaign center</a></p>
</section>
`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/reports-center", requirePermission("REPORTS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: platformHotelSlug },
    include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Reports Center</h2><p>No hotel data found.</p>", true));
    return;
  }

  const activePropertyId = await resolveActivePropertyIdForHotel(req, hotel.id);
  const now = startOfDay(new Date());
  const defaultStart = addDays(now, -29);
  const defaultEnd = now;
  const start = parseDateInput(req.query.start, defaultStart);
  const end = parseDateInput(req.query.end, defaultEnd);
  const endExclusive = addDays(end, 1);
  const daysInRange = Math.max(1, Math.round((endExclusive.getTime() - start.getTime()) / (24 * 3600 * 1000)));

  const [bookings, conversations, messages] = await Promise.all([
    prisma.booking.findMany({
      where: { hotelId: hotel.id, ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}), checkIn: { gte: start, lt: endExclusive } },
      include: { roomType: true },
      orderBy: { checkIn: "asc" }
    }),
    prisma.conversation.findMany({
      where: { hotelId: hotel.id, ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}), createdAt: { gte: start, lt: endExclusive } },
      orderBy: { createdAt: "asc" }
    }),
    prisma.message.findMany({
      where: { hotelId: hotel.id, ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}), createdAt: { gte: start, lt: endExclusive } },
      orderBy: { createdAt: "asc" }
    })
  ]);

  const revenue = bookings.reduce((sum, b) => sum + b.totalAmount, 0);
  const totalRoomNights = hotel.roomTypes.reduce((sum, rt) => sum + rt.totalInventory * daysInRange, 0);
  const bookedRoomNights = bookings.reduce((sum, b) => sum + Math.max(1, b.nights), 0);
  const occupancyRate = totalRoomNights ? (bookedRoomNights / totalRoomNights) * 100 : 0;

  const bookingsByDay = new Map<string, number>();
  for (const b of bookings) {
    const d = formatDateForInput(startOfDay(b.checkIn));
    bookingsByDay.set(d, (bookingsByDay.get(d) ?? 0) + 1);
  }
  const bookingTrendRows = enumerateDates(start, daysInRange)
    .map((d) => {
      const key = formatDateForInput(d);
      return `<tr><td>${key}</td><td>${bookingsByDay.get(key) ?? 0}</td></tr>`;
    })
    .join("");

  const roomPerformance = new Map<string, { bookings: number; revenue: number; nights: number }>();
  for (const b of bookings) {
    const current = roomPerformance.get(b.roomTypeId) ?? { bookings: 0, revenue: 0, nights: 0 };
    current.bookings += 1;
    current.revenue += b.totalAmount;
    current.nights += Math.max(1, b.nights);
    roomPerformance.set(b.roomTypeId, current);
  }
  const roomPerformanceRows = hotel.roomTypes
    .map((rt) => {
      const p = roomPerformance.get(rt.id) ?? { bookings: 0, revenue: 0, nights: 0 };
      return {
        name: rt.name,
        bookings: p.bookings,
        revenue: p.revenue,
        nights: p.nights
      };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.name)}</td>
        <td>${row.bookings}</td>
        <td>${row.nights}</td>
        <td>${formatMoney(row.revenue, hotel.currency)}</td>
      </tr>`
    )
    .join("");

  const inboundMessages = messages.filter((m) => m.direction === "INBOUND").length;
  const outboundMessages = messages.filter((m) => m.direction === "OUTBOUND").length;
  const conversationByDay = new Map<string, number>();
  for (const c of conversations) {
    const d = formatDateForInput(startOfDay(c.createdAt));
    conversationByDay.set(d, (conversationByDay.get(d) ?? 0) + 1);
  }
  const messageTrendRows = enumerateDates(start, daysInRange)
    .map((d) => {
      const key = formatDateForInput(d);
      return `<tr><td>${key}</td><td>${conversationByDay.get(key) ?? 0}</td></tr>`;
    })
    .join("");

  const bestSelling = [...roomPerformance.entries()]
    .sort((a, b) => b[1].bookings - a[1].bookings)
    .slice(0, 3)
    .map(([roomTypeId, v]) => {
      const room = hotel.roomTypes.find((r) => r.id === roomTypeId);
      return `${room?.name ?? roomTypeId} (${v.bookings} bookings)`;
    });
  const peakDay = [...bookingsByDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const selectedUnitId = typeof req.query.unitId === "string" ? req.query.unitId : "";
  const onlyMissingSignature = String(req.query.onlyMissingSignature ?? "") === "1";
  const onlyMissingIdCopy = String(req.query.onlyMissingIdCopy ?? "") === "1";
  const onlyMissingTransactionNumber = String(req.query.onlyMissingTransactionNumber ?? "") === "1";
  const showIncompleteHandoverOnly = String(req.query.showIncompleteHandoverOnly ?? "") === "1";
  const guestStart = parseDateInput(req.query.guestStart, start);
  const guestEnd = parseDateInput(req.query.guestEnd, end);
  const guestStartKey = formatDateForInput(guestStart);
  const guestEndKey = formatDateForInput(guestEnd);
  const broadcastNotice = req.query.broadcastSent ? '<p class="badge ok">WhatsApp message sent to selected guests.</p>' : "";
  const guestLogs = await prisma.auditLog.findMany({
    where: {
      hotelId: hotel.id,
      action: "ROOM_UNIT_GUEST_DETAILS",
      entityType: "RoomUnit",
      createdAt: { gte: start, lt: endExclusive }
    },
    orderBy: { createdAt: "desc" },
    take: 500
  });
  const latestByUnitDate = new Map<
    string,
    {
      unitId: string;
      date: string;
      fullName: string;
      phone: string;
      email: string;
      adults: number;
      children: number;
      mealPlan: string;
      idCardPath: string;
      handoverId: string;
      handoverAt: string;
      handoverBy: string;
      handoverSignature: string;
      transactionNumber: string;
    }
  >();
  for (const log of guestLogs) {
    const m = parseAuditMetadata(log.metadataJson);
    const unitId = log.entityId ?? "";
    const date = typeof m.date === "string" ? m.date : "";
    if (!unitId || !date) continue;
    const key = `${unitId}::${date}`;
    if (latestByUnitDate.has(key)) continue;
    latestByUnitDate.set(key, {
      unitId,
      date,
      fullName: typeof m.fullName === "string" ? m.fullName : "",
      phone: typeof m.phone === "string" ? m.phone : "",
      email: typeof m.email === "string" ? m.email : "",
      adults: typeof m.adults === "number" ? m.adults : 0,
      children: typeof m.children === "number" ? m.children : 0,
      mealPlan: typeof m.mealPlan === "string" ? m.mealPlan : "NONE",
      idCardPath: typeof m.idCardPath === "string" ? m.idCardPath : "",
      handoverId: typeof m.handoverId === "string" ? m.handoverId : "",
      handoverAt: typeof m.handoverAt === "string" ? m.handoverAt : "",
      handoverBy: typeof m.handoverBy === "string" ? m.handoverBy : "",
      handoverSignature: typeof m.handoverSignature === "string" ? m.handoverSignature : "",
      transactionNumber: typeof m.transactionNumber === "string" ? m.transactionNumber : ""
    });
  }
  const roomUnits = await prisma.roomUnit.findMany({
    where: { hotelId: hotel.id, isActive: true },
    select: { id: true, name: true, roomType: { select: { name: true } } },
    orderBy: [{ roomTypeId: "asc" }, { sortOrder: "asc" }, { name: "asc" }]
  });
  const unitNameMap = new Map(roomUnits.map((u) => [u.id, `${u.name} (${u.roomType.name})`]));
  let guestRowsData = Array.from(latestByUnitDate.values()).filter(
    (row) => (!selectedUnitId || row.unitId === selectedUnitId) && row.date >= guestStartKey && row.date <= guestEndKey
  );
  if (showIncompleteHandoverOnly) {
    guestRowsData = guestRowsData.filter(
      (row) => !row.handoverSignature.trim() || !row.idCardPath.trim() || !row.transactionNumber.trim()
    );
  }
  if (onlyMissingSignature) {
    guestRowsData = guestRowsData.filter((row) => !row.handoverSignature.trim());
  }
  if (onlyMissingIdCopy) {
    guestRowsData = guestRowsData.filter((row) => !row.idCardPath.trim());
  }
  if (onlyMissingTransactionNumber) {
    guestRowsData = guestRowsData.filter((row) => !row.transactionNumber.trim());
  }
  guestRowsData = guestRowsData.sort((a, b) => a.date.localeCompare(b.date));
  const unitFilterOptions = roomUnits
    .map((u) => `<option value="${escapeHtml(u.id)}" ${u.id === selectedUnitId ? "selected" : ""}>${escapeHtml(`${u.name} (${u.roomType.name})`)}</option>`)
    .join("");
  const guestHistoryRows = guestRowsData
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(unitNameMap.get(row.unitId) ?? row.unitId)}</td>
        <td>${escapeHtml(row.fullName || "—")}</td>
        <td>${escapeHtml(row.phone || "—")}</td>
        <td>${escapeHtml(row.email || "—")}</td>
        <td>${row.adults}</td>
        <td>${row.children}</td>
        <td>${escapeHtml(row.mealPlan)}</td>
        <td>${escapeHtml(row.transactionNumber || "—")}</td>
        <td>${escapeHtml(row.handoverId || "—")}</td>
        <td>${escapeHtml(row.handoverAt || "—")}</td>
        <td>${escapeHtml(row.handoverBy || "—")}</td>
        <td>${escapeHtml(row.handoverSignature || "—")}</td>
        <td>${row.idCardPath ? `<a class="inline-link" target="_blank" href="${escapeHtml(row.idCardPath)}">Open ID</a>` : "—"}</td>
      </tr>`
    )
    .join("");
  const targetPhones = Array.from(new Set(guestRowsData.map((row) => row.phone).filter((phone) => phone.length > 5)));

  const content = `
<h2>Reports Center</h2>
<p class="muted">Revenue, occupancy, booking trends, room performance, and messaging analytics in one place.</p>
${broadcastNotice}
<form method="get" action="/admin/reports-center" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>From <input type="date" name="start" value="${formatDateForInput(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>To <input type="date" name="end" value="${formatDateForInput(end)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
</form>
<div class="grid-4">
  <article class="stat"><h3>Revenue</h3><p>${formatMoney(revenue, hotel.currency)}</p></article>
  <article class="stat"><h3>Occupancy</h3><p>${occupancyRate.toFixed(1)}%</p></article>
  <article class="stat"><h3>Total bookings</h3><p>${bookings.length}</p></article>
  <article class="stat"><h3>Conversations</h3><p>${conversations.length}</p></article>
</div>
<div class="grid-2" style="margin-top:12px">
  <section>
    <h3>Booking trends</h3>
    <table>
      <thead><tr><th>Date</th><th>Bookings</th></tr></thead>
      <tbody>${bookingTrendRows || '<tr><td colspan="2">No booking trend data.</td></tr>'}</tbody>
    </table>
  </section>
  <section>
    <h3>Conversation volume trends</h3>
    <table>
      <thead><tr><th>Date</th><th>Conversations</th></tr></thead>
      <tbody>${messageTrendRows || '<tr><td colspan="2">No conversation trend data.</td></tr>'}</tbody>
    </table>
    <p class="muted" style="margin-top:8px">Inbound messages: ${inboundMessages} · Outbound messages: ${outboundMessages}</p>
  </section>
</div>
<section style="margin-top:12px">
  <h3>Room performance</h3>
  <table>
    <thead><tr><th>Room type</th><th>Bookings</th><th>Nights</th><th>Revenue</th></tr></thead>
    <tbody>${roomPerformanceRows || '<tr><td colspan="4">No room performance data.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin-top:12px">
  <h3>Insights</h3>
  <table>
    <tbody>
      <tr><th>Best selling room types</th><td>${escapeHtml(bestSelling.join(" • ") || "No data yet")}</td></tr>
      <tr><th>Peak booking period</th><td>${peakDay ? `${escapeHtml(peakDay[0])} (${peakDay[1]} bookings)` : "No data yet"}</td></tr>
      <tr><th>Conversation volume trend</th><td>${conversations.length > 0 ? `${conversations.length} total conversations in selected range` : "No data yet"}</td></tr>
    </tbody>
  </table>
</section>
<section style="margin-top:12px">
  <h3>Guest details & historical report</h3>
  <form method="get" action="/admin/reports-center" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px">
    <input type="hidden" name="start" value="${formatDateForInput(start)}" />
    <input type="hidden" name="end" value="${formatDateForInput(end)}" />
    <label>From
      <input type="date" name="guestStart" value="${guestStartKey}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
    <label>To
      <input type="date" name="guestEnd" value="${guestEndKey}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
    <label>Room unit
      <select name="unitId" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
        <option value="">All units</option>${unitFilterOptions}
      </select>
    </label>
    <label style="display:flex; align-items:center; gap:6px; padding-top:24px">
      <input type="checkbox" name="onlyMissingSignature" value="1" ${onlyMissingSignature ? "checked" : ""} />
      Only missing handover signature
    </label>
    <label style="display:flex; align-items:center; gap:6px; padding-top:24px">
      <input type="checkbox" name="onlyMissingIdCopy" value="1" ${onlyMissingIdCopy ? "checked" : ""} />
      Only missing ID copy
    </label>
    <label style="display:flex; align-items:center; gap:6px; padding-top:24px">
      <input type="checkbox" name="onlyMissingTransactionNumber" value="1" ${onlyMissingTransactionNumber ? "checked" : ""} />
      Only missing payment transaction #
    </label>
    <label style="display:flex; align-items:center; gap:6px; padding-top:24px">
      <input type="checkbox" name="showIncompleteHandoverOnly" value="1" ${showIncompleteHandoverOnly ? "checked" : ""} />
      Show incomplete handover only
    </label>
    <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Filter guest report</button>
  </form>
  <table>
    <thead><tr><th>Date</th><th>Room unit</th><th>Guest</th><th>Phone</th><th>Email</th><th>Adults</th><th>Children</th><th>Meal</th><th>Transaction #</th><th>Handover ID</th><th>Handover at</th><th>Handover by</th><th>Signature</th><th>ID copy</th></tr></thead>
    <tbody>${guestHistoryRows || '<tr><td colspan="14">No guest details found for selected filters.</td></tr>'}</tbody>
  </table>
  <form method="post" action="/admin/reports-center/guest-broadcast" style="margin-top:10px; display:grid; gap:8px; max-width:700px">
    <input type="hidden" name="start" value="${formatDateForInput(start)}" />
    <input type="hidden" name="end" value="${formatDateForInput(end)}" />
    <input type="hidden" name="guestStart" value="${guestStartKey}" />
    <input type="hidden" name="guestEnd" value="${guestEndKey}" />
    <input type="hidden" name="unitId" value="${escapeHtml(selectedUnitId)}" />
    <input type="hidden" name="onlyMissingSignature" value="${onlyMissingSignature ? "1" : "0"}" />
    <input type="hidden" name="onlyMissingIdCopy" value="${onlyMissingIdCopy ? "1" : "0"}" />
    <input type="hidden" name="onlyMissingTransactionNumber" value="${onlyMissingTransactionNumber ? "1" : "0"}" />
    <input type="hidden" name="showIncompleteHandoverOnly" value="${showIncompleteHandoverOnly ? "1" : "0"}" />
    <input type="hidden" name="phonesCsv" value="${escapeHtml(targetPhones.join(","))}" />
    <label>Broadcast message (offers / ads / updates)
      <textarea name="message" rows="3" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px"></textarea>
    </label>
    <p class="muted" style="margin:0">Recipients in current filter: ${targetPhones.length}</p>
    <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#128c7e; color:#fff; font-weight:700; width:max-content">Send WhatsApp broadcast</button>
  </form>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/fb/menu", requireFbOperationsView(), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true, displayName: true, currency: true } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>F&amp;B menu</h2><p>No hotel data found.</p>", true));
    return;
  }
  await ensureDefaultFbMenu(hotel.id);
  const saved = req.query.saved ? '<p class="badge ok">Menu saved.</p>' : "";
  const mergedN = typeof req.query.merged === "string" ? req.query.merged.trim() : "";
  const mergedBanner =
    mergedN && /^\d+$/.test(mergedN) && Number(mergedN) > 0
      ? `<p class="badge ok">Added ${escapeHtml(mergedN)} new menu line(s) from the resort 2026 pack (duplicates skipped).</p>`
      : "";
  const bookingIdParam = typeof req.query.bookingId === "string" ? req.query.bookingId.trim() : "";
  const chargeErr = typeof req.query.chargeError === "string" ? req.query.chargeError.slice(0, 500) : "";
  const outletWarnFb = typeof req.query.outletWarn === "string" ? req.query.outletWarn.slice(0, 800) : "";
  const bookingForBanner = bookingIdParam
    ? await prisma.booking.findFirst({
        where: { id: bookingIdParam, hotelId: hotel.id },
        select: {
          id: true,
          status: true,
          referenceCode: true,
          checkIn: true,
          checkOut: true,
          guest: true,
          roomUnit: { select: { name: true } }
        }
      })
    : null;
  const chargeSuccessFlag =
    req.query.chargeSuccess === "1" || String(req.query.chargeSuccess ?? "").toLowerCase() === "true";
  const chargeSuccessBanner =
    chargeSuccessFlag && bookingForBanner
      ? `<p class="badge ok" role="status" style="margin:0;padding:0;background:transparent;line-height:1.55;font-size:15px;font-weight:600;color:#064e3b">Charges are on the folio for <strong>${escapeHtml(
          bookingForBanner.guest.fullName ?? bookingForBanner.guest.phoneE164
        )}</strong> · booking <code style="background:rgba(0,0,0,.06);padding:2px 6px;border-radius:4px">${escapeHtml(bookingForBanner.id)}</code>. <a class="inline-link" href="/admin/bookings/${encodeURIComponent(
          bookingForBanner.id
        )}">Open booking &amp; F&amp;B</a> to verify lines.</p>`
      : chargeSuccessFlag && bookingIdParam
        ? `<p class="badge ok" role="status" style="margin:0;padding:0;background:transparent;font-size:15px;font-weight:600;color:#064e3b">Charges posted. <a class="inline-link" href="/admin/bookings/${encodeURIComponent(bookingIdParam)}">Open booking</a></p>`
        : "";
  const bookingStatusBadge =
    bookingForBanner &&
    (bookingForBanner.status === BookingStatus.CONFIRMED
      ? `<span class="badge ok">${escapeHtml(bookingForBanner.status)}</span>`
      : bookingForBanner.status === BookingStatus.CANCELLED || bookingForBanner.status === BookingStatus.NO_SHOW
        ? `<span class="badge alert">${escapeHtml(bookingForBanner.status)}</span>`
        : `<span class="badge pending">${escapeHtml(bookingForBanner.status)}</span>`);
  const guestRecapLabel = bookingForBanner
    ? escapeHtml(bookingForBanner.guest.fullName ?? bookingForBanner.guest.phoneE164)
    : "";
  const bookingContextPanel = bookingForBanner
    ? `<section class="fb-pos-card fb-pos-context-loaded" aria-label="Guest folio context">
      <div class="fb-pos-context-head">
        <div>
          <p class="fb-pos-h3">Active folio</p>
          <h3 class="fb-pos-title">Guest &amp; booking</h3>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <span class="muted" style="font-size:11px;font-weight:600;text-transform:uppercase">Status</span>
          ${bookingStatusBadge ?? `<span class="badge pending">${escapeHtml(String(bookingForBanner.status))}</span>`}
        </div>
      </div>
      <dl class="fb-pos-dl">
        <div><dt>Booking ID</dt><dd><code style="background:rgba(0,0,0,.06);padding:2px 8px;border-radius:6px;font-size:14px">${escapeHtml(bookingForBanner.id)}</code></dd></div>
        <div><dt>Booking ref</dt><dd>${bookingForBanner.referenceCode ? `<strong>${escapeHtml(bookingForBanner.referenceCode)}</strong>` : `<span class="muted">—</span>`}</dd></div>
        <div><dt>Guest</dt><dd>${escapeHtml(bookingForBanner.guest.fullName ?? bookingForBanner.guest.phoneE164)}</dd></div>
        <div><dt>Room / unit</dt><dd>${escapeHtml(bookingForBanner.roomUnit?.name ?? "Not assigned")}</dd></div>
        <div><dt>Check-in</dt><dd>${escapeHtml(formatDate(bookingForBanner.checkIn))}</dd></div>
        <div><dt>Check-out</dt><dd>${escapeHtml(formatDate(bookingForBanner.checkOut))}</dd></div>
      </dl>
      <p class="fb-pos-footnote">Review selections below, then post. Charges attach to this booking&apos;s folio and appear on the invoice PDF with room charges.</p>
    </section>`
    : "";
  const bookingGatePanel = bookingForBanner
    ? ""
    : bookingIdParam
      ? `<section class="fb-pos-card fb-pos-context-missing" role="alert" aria-label="No booking loaded">
      <p class="fb-pos-h3" style="color:#991b1b">Folio not linked</p>
      <p style="margin:0 0 8px;font-weight:700;color:#7f1d1d">No booking found for ID <code>${escapeHtml(bookingIdParam)}</code>.</p>
      <p class="muted" style="margin:0;font-size:14px">Copy a valid ID from <a class="inline-link" href="/admin/bookings" target="_blank" rel="noopener">Bookings</a> and click <strong>Load booking</strong>, or open this page from a booking detail link.</p>
    </section>`
      : `<section class="fb-pos-card fb-pos-context-idle" aria-label="Link a folio">
      <p class="fb-pos-h3" style="color:#92400e">No folio loaded</p>
      <p style="margin:0 0 8px;font-weight:700;color:#78350f">Use <strong>Find a staying guest</strong> above, or paste a booking ID and click <strong>Load booking</strong>.</p>
      <p class="muted" style="margin:0;font-size:14px">Open from <a class="inline-link" href="/admin/bookings">Bookings</a> or deep-link <code>/admin/fb/menu?bookingId=…</code>. Menu catalog is below.</p>
    </section>`;

  const opsDay = parseDateInput(req.query.ops_date, new Date());
  const roomUnitFilter = typeof req.query.room_unit_id === "string" ? req.query.room_unit_id.trim() : "";
  const explicitGuestQ = typeof req.query.guest_q === "string" ? req.query.guest_q.trim() : "";
  const explicitRefQ = typeof req.query.ref_q === "string" ? req.query.ref_q.trim() : "";
  const legacyQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const reportStartDay = startOfDay(parseDateInput(req.query.report_start, new Date()));
  const reportEndDay = startOfDay(parseDateInput(req.query.report_end, new Date()));
  const reportRangeEndExclusive = addDays(reportEndDay, 1);

  const fullInHouseList = await listInHouseBookingsForHotelDay(hotel.id, opsDay);

  const roomUnitsForPicker = new Map<string, string>();
  for (const b of fullInHouseList) {
    if (b.roomUnit) roomUnitsForPicker.set(b.roomUnit.id, b.roomUnit.name);
  }
  const roomOptionsHtml = [
    `<option value="">All rooms</option>`,
    ...Array.from(roomUnitsForPicker.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(
        ([id, name]) =>
          `<option value="${escapeHtml(id)}" ${roomUnitFilter === id ? "selected" : ""}>${escapeHtml(name)}</option>`
      )
  ].join("");

  let inHouseList = fullInHouseList;
  if (roomUnitFilter) {
    inHouseList = inHouseList.filter((b) => b.roomUnit?.id === roomUnitFilter);
  }
  if (explicitGuestQ) {
    const ql = explicitGuestQ.toLowerCase();
    inHouseList = inHouseList.filter((b) => {
      const name = (b.guest.fullName ?? "").toLowerCase();
      const phone = (b.guest.phoneE164 ?? "").toLowerCase();
      return name.includes(ql) || phone.includes(ql);
    });
  }
  if (explicitRefQ) {
    const rl = explicitRefQ.toLowerCase();
    inHouseList = inHouseList.filter((b) => {
      const ref = (b.referenceCode ?? "").toLowerCase();
      return ref.includes(rl) || b.id.toLowerCase().includes(rl);
    });
  }
  if (!explicitGuestQ && !explicitRefQ && legacyQ) {
    const ql = legacyQ.toLowerCase();
    inHouseList = inHouseList.filter((b) => {
      const name = (b.guest.fullName ?? "").toLowerCase();
      const room = (b.roomUnit?.name ?? "").toLowerCase();
      const ref = (b.referenceCode ?? "").toLowerCase();
      const phone = (b.guest.phoneE164 ?? "").toLowerCase();
      return (
        name.includes(ql) ||
        room.includes(ql) ||
        ref.includes(ql) ||
        b.id.toLowerCase().includes(ql) ||
        phone.includes(ql)
      );
    });
  }

  const opsDateValPre = formatDateForInput(opsDay);
  const reportStartValPre = formatDateForInput(reportStartDay);
  const reportEndValPre = formatDateForInput(reportEndDay);

  if (!bookingIdParam && roomUnitFilter && inHouseList.length === 1) {
    const p = new URLSearchParams();
    p.set("bookingId", inHouseList[0].id);
    p.set("ops_date", opsDateValPre);
    p.set("room_unit_id", roomUnitFilter);
    p.set("report_start", reportStartValPre);
    p.set("report_end", reportEndValPre);
    if (explicitGuestQ) p.set("guest_q", explicitGuestQ);
    if (explicitRefQ) p.set("ref_q", explicitRefQ);
    if (legacyQ && !explicitGuestQ && !explicitRefQ) p.set("q", legacyQ);
    res.redirect(`/admin/fb/menu?${p.toString()}`);
    return;
  }

  const summaryOps = await getFbOperationsSummary(hotel.id, reportStartDay, reportRangeEndExclusive);
  const snapshotDay = await getFbOperationsSummary(
    hotel.id,
    startOfDay(opsDay),
    addDays(startOfDay(opsDay), 1)
  );
  const recentFbExpenses = await prisma.fbOperationalExpense.findMany({
    where: { hotelId: hotel.id },
    orderBy: { expenseDate: "desc" },
    take: 25,
    include: { createdBy: { select: { fullName: true } } }
  });

  const directOk = req.query.directOk === "1";
  const directErrStr = typeof req.query.directErr === "string" ? req.query.directErr.slice(0, 500) : "";
  const expenseSavedFlag = req.query.expenseSaved === "1";
  const expenseErrStr = typeof req.query.expenseErr === "string" ? req.query.expenseErr.slice(0, 400) : "";

  const opsDateVal = opsDateValPre;
  const reportStartVal = reportStartValPre;
  const reportEndVal = reportEndValPre;
  const inHouseOptionsHtml = inHouseList
    .map((b) => {
      const base = `${b.roomUnit?.name ?? "—"} · ${b.guest.fullName ?? b.guest.phoneE164}${b.referenceCode ? " · " + b.referenceCode : ""}`;
      const label = `${escapeHtml(base)} · …${escapeHtml(b.id.slice(-6))}`;
      return `<option value="${escapeHtml(b.id)}" ${bookingIdParam === b.id ? "selected" : ""}>${label}</option>`;
    })
    .join("");
  const expenseTableRows = recentFbExpenses
    .map(
      (e) =>
        `<tr><td>${escapeHtml(formatDate(e.expenseDate))}</td><td>${escapeHtml(e.category)}</td><td>${e.amount.toFixed(2)}</td><td>${escapeHtml(e.outlet ?? "—")}</td><td>${escapeHtml(e.paymentMethod ?? "—")}</td><td>${escapeHtml((e.referenceNote ?? "").slice(0, 120))}</td><td>${e.createdBy ? escapeHtml(e.createdBy.fullName) : "—"}</td></tr>`
    )
    .join("");
  const payMixRows =
    summaryOps.walkInPaymentsByMethod.length > 0
      ? summaryOps.walkInPaymentsByMethod
          .map(
            (p) =>
              `<tr><td>${escapeHtml(p.method)}</td><td style="text-align:right">${p.amount.toFixed(2)} ${escapeHtml(hotel.currency)}</td></tr>`
          )
          .join("")
      : `<tr><td colspan="2" class="muted">No walk-in POS payments in this range</td></tr>`;

  const snapshotMasterHtml = `<section id="fb-master-snapshot" class="fb-master-snapshot fb-pos-card" style="margin-bottom:16px;border:1px solid #6ee7b7;background:linear-gradient(135deg,#ecfdf5 0%,#f0fdf4 100%);scroll-margin-top:72px">
  <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px">
    <h2 style="margin:0;font-size:1.15rem">Stay-date snapshot</h2>
    <span class="muted" style="font-size:13px;font-weight:700">${escapeHtml(formatDateForInput(opsDay))}</span>
  </div>
  <p class="muted" style="margin:0 0 12px;font-size:12px;line-height:1.45">One-day F&amp;B picture for the same <strong>Stay date</strong> used in guest lookup. Change stay date in the lookup section to shift this snapshot.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px">
    <article class="stat" style="margin:0;padding:10px 12px"><h3 style="font-size:11px">Guest menu orders</h3><p style="margin:0;font-size:1rem;font-weight:700">${snapshotDay.fbOrderFolioTotal.toFixed(2)} ${escapeHtml(hotel.currency)}</p></article>
    <article class="stat" style="margin:0;padding:10px 12px"><h3 style="font-size:11px">In-house folio F&amp;B</h3><p style="margin:0;font-size:1rem;font-weight:700">${snapshotDay.folioGuestFnChargesNet.toFixed(2)} ${escapeHtml(hotel.currency)}</p></article>
    <article class="stat" style="margin:0;padding:10px 12px"><h3 style="font-size:11px">Direct (walk-in) F&amp;B</h3><p style="margin:0;font-size:1rem;font-weight:700">${snapshotDay.directFnChargesNet.toFixed(2)} ${escapeHtml(hotel.currency)}</p></article>
    <article class="stat" style="margin:0;padding:10px 12px"><h3 style="font-size:11px">Walk-in payments</h3><p style="margin:0;font-size:1rem;font-weight:700">${snapshotDay.walkInPaymentTotal.toFixed(2)} ${escapeHtml(hotel.currency)}</p></article>
    <article class="stat" style="margin:0;padding:10px 12px"><h3 style="font-size:11px">F&amp;B expenses logged</h3><p style="margin:0;font-size:1rem;font-weight:700">${snapshotDay.expenseTotal.toFixed(2)} ${escapeHtml(hotel.currency)}</p></article>
  </div>
</section>`;

  const outletMasterStripHtml = `<section id="fb-master-outlet" class="fb-master-outlet-strip fb-pos-card" style="margin-bottom:18px;border:1px solid #7dd3fc;background:#f0f9ff;scroll-margin-top:72px">
  <h2 style="margin:0 0 6px;font-size:1.1rem">Outlet · KOT &amp; tickets</h2>
  <p class="muted" style="margin:0 0 12px;font-size:13px">Restaurant and café kitchen flow — move tickets by status, notify service. Same outlets as menu items below.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
    <a class="btn-link primary" style="display:block;text-align:center;padding:12px 14px;border-radius:10px;font-weight:700" href="/admin/outlet-dashboard">Outlet board (kanban)</a>
    <a class="btn-link" style="display:block;text-align:center;padding:12px 14px;border-radius:10px;border:1px solid #94a3b8;background:#fff;font-weight:600" href="/admin/outlet-orders">All outlet tickets</a>
    <a class="btn-link" style="display:block;text-align:center;padding:12px 14px;border-radius:10px;border:1px solid #94a3b8;background:#fff;font-weight:600" href="/admin/restaurant-ops">Restaurant ops guide</a>
  </div>
</section>`;

  const items = await prisma.menuItem.findMany({
    where: { hotelId: hotel.id },
    orderBy: [{ outletType: "asc" }, { sortOrder: "asc" }, { name: "asc" }]
  });
  const rows = items
    .map((m) => {
      const inactive = !m.isActive;
      const dis = inactive ? " disabled" : "";
      return `<tr class="fb-charge-row" data-fb-active="${m.isActive ? "1" : "0"}" data-fb-price="${String(m.unitPrice)}">
      <td style="text-align:center"><input type="checkbox" class="fb-charge-cb" form="fb-charge-folio" name="charge_${escapeHtml(m.id)}" value="1"${dis} /></td>
      <td style="text-align:center"><input type="number" class="fb-charge-qty" form="fb-charge-folio" name="qty_${escapeHtml(m.id)}" min="1" max="99" value="1" style="width:52px;padding:4px;border:1px solid #d8dee6;border-radius:8px"${dis} /></td>
      <td class="fb-item-outlet">${escapeHtml(m.outletType === "COFFEE_SHOP" ? "Coffee shop" : "Restaurant")}</td>
      <td class="fb-item-name">${escapeHtml(m.name)}</td>
      <td>${formatMoney(m.unitPrice, hotel.currency)}</td>
      <td>${m.isActive ? '<span class="badge ok">Active</span>' : '<span class="badge pending">Off</span>'}</td>
      <td>
        <form method="post" action="/admin/fb/menu/${encodeURIComponent(m.id)}/toggle" style="display:inline"><button type="submit" class="btn-link" style="padding:4px 8px">${m.isActive ? "Disable" : "Enable"}</button></form>
      </td>
    </tr>`;
    })
    .join("");
  const cashierSaleRows = items
    .map((m) => {
      const inactive = !m.isActive;
      const dis = inactive ? " disabled" : "";
      const ot = m.outletType === FbOutletType.COFFEE_SHOP ? "COFFEE_SHOP" : "RESTAURANT";
      return `<tr class="fb-cashier-row" data-cashier-outlet="${ot}" data-fb-active="${m.isActive ? "1" : "0"}" data-fb-price="${String(m.unitPrice)}">
      <td style="text-align:center"><input type="checkbox" class="fb-cashier-cb" form="fb-direct-sale" name="direct_charge_${escapeHtml(m.id)}" value="1"${dis} /></td>
      <td style="text-align:center"><input type="number" class="fb-cashier-qty" form="fb-direct-sale" name="direct_qty_${escapeHtml(m.id)}" min="1" max="99" value="1" style="width:52px;padding:6px;border:1px solid #d8dee6;border-radius:8px"${dis} /></td>
      <td class="fb-cashier-name">${escapeHtml(m.name)}</td>
      <td class="num">${formatMoney(m.unitPrice, hotel.currency)}</td>
      <td>${m.isActive ? '<span class="badge ok">On</span>' : '<span class="badge pending">Off</span>'}</td>
    </tr>`;
    })
    .join("");
  const fbQuickCashierSectionHtml = `<div id="fb-direct" style="height:0;margin:0;padding:0;overflow:hidden" aria-hidden="true"></div>
<section id="fb-cashier-sale" class="fb-pos-shell fb-cashier-shell" style="margin-bottom:22px;scroll-margin-top:88px;border-radius:14px">
  <header class="fb-pos-shell-head">
    <h2 style="margin:0 0 4px;font-size:1.35rem">Direct sale — walk-in / non-staying</h2>
    <p class="muted" style="margin:0;font-size:13px">Quick POS for <strong>restaurant</strong> or <strong>café</strong> with no room booking. Records <strong>F&amp;B charges + payment</strong> on the ledger (outlet + method for shift-close and daily F&amp;B reporting).</p>
  </header>
  <form id="fb-direct-sale" method="post" action="/admin/fb/menu/direct-sale">
    <div class="fb-cashier-outlet" role="radiogroup" aria-label="Cashier outlet">
      <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b;width:100%">1. Outlet</span>
      <label style="display:flex;align-items:center;gap:8px;padding:10px 16px;border:2px solid #0f766e;border-radius:10px;background:#ecfdf5;cursor:pointer;margin:0">
        <input type="radio" name="cashier_outlet" value="RESTAURANT" checked /> Restaurant
      </label>
      <label style="display:flex;align-items:center;gap:8px;padding:10px 16px;border:2px solid #cbd5e1;border-radius:10px;background:#fff;cursor:pointer;margin:0">
        <input type="radio" name="cashier_outlet" value="COFFEE_SHOP" /> Coffee shop / Café
      </label>
    </div>
    <p class="muted" style="margin:0 0 8px;font-size:12px">2. Tick items and set qty · 3. Payment · 4. Confirm</p>
    <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:12px;background:#fff">
      <table class="fb-pos-table">
        <thead><tr><th style="width:44px">✓</th><th class="num" style="width:56px">Qty</th><th>Item</th><th class="num">Unit</th><th style="width:64px">Menu</th></tr></thead>
        <tbody>${cashierSaleRows || '<tr><td colspan="5" class="muted">No menu items — add under Menu catalog.</td></tr>'}</tbody>
      </table>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:14px">
      <label>Payment method<br/>
        <select name="payment_method" required style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;min-width:200px;font-weight:600">
          <option value="CASH">Cash</option>
          <option value="CARD">Card / credit</option>
          <option value="MOBILE">Mobile transfer</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="OTHER">Other</option>
        </select>
      </label>
      <label style="flex:1;min-width:220px">Note / receipt ref<br/><input type="text" name="notes" maxlength="500" placeholder="Optional" style="width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px" /></label>
    </div>
    <div class="fb-cashier-footer">
      <p id="fb-cashier-total" style="margin:0;font-size:1.15rem;font-weight:800;color:#134e4a">Total: <span id="fb-cashier-total-num">0.00 ${escapeHtml(hotel.currency)}</span></p>
      <button type="submit" style="padding:14px 28px;border:0;border-radius:10px;background:#0f766e;color:#fff;font-weight:800;font-size:17px;cursor:pointer;box-shadow:0 2px 10px rgba(15,118,110,.25)">Confirm sale</button>
    </div>
  </form>
  <script>
    (function () {
      var cur = "${escapeHtml(hotel.currency)}";
      function activeOutlet() {
        var r = document.querySelector('input[name="cashier_outlet"]:checked');
        return r ? r.value : "RESTAURANT";
      }
      function applyOutletFilter() {
        var o = activeOutlet();
        document.querySelectorAll("tr.fb-cashier-row").forEach(function (tr) {
          var rowO = tr.getAttribute("data-cashier-outlet");
          var show = rowO === o;
          tr.style.display = show ? "" : "none";
          if (!show) {
            var cb = tr.querySelector(".fb-cashier-cb");
            var qEl = tr.querySelector(".fb-cashier-qty");
            if (cb) cb.checked = false;
            if (qEl) qEl.value = 1;
          }
        });
        document.querySelectorAll(".fb-cashier-outlet label").forEach(function (lab) {
          var inp = lab.querySelector('input[type="radio"]');
          if (!inp) return;
          lab.style.borderColor = inp.checked ? "#0f766e" : "#cbd5e1";
          lab.style.background = inp.checked ? "#ecfdf5" : "#fff";
        });
        recalcCashier();
      }
      function recalcCashier() {
        var sum = 0;
        document.querySelectorAll("tr.fb-cashier-row").forEach(function (tr) {
          if (tr.style.display === "none") return;
          if (tr.getAttribute("data-fb-active") !== "1") return;
          var cb = tr.querySelector(".fb-cashier-cb");
          var qEl = tr.querySelector(".fb-cashier-qty");
          if (!cb || !cb.checked || cb.disabled) return;
          var qty = parseInt(qEl && qEl.value, 10);
          if (!isFinite(qty) || qty < 1) qty = 1;
          var price = parseFloat(tr.getAttribute("data-fb-price") || "0");
          sum += Math.round(price * qty * 100) / 100;
        });
        var el = document.getElementById("fb-cashier-total-num");
        if (el) el.textContent = sum.toFixed(2) + " " + cur;
      }
      document.querySelectorAll('input[name="cashier_outlet"]').forEach(function (el) {
        el.addEventListener("change", applyOutletFilter);
      });
      document.querySelectorAll(".fb-cashier-cb, .fb-cashier-qty").forEach(function (el) {
        el.addEventListener("change", recalcCashier);
        el.addEventListener("input", recalcCashier);
      });
      var form = document.getElementById("fb-direct-sale");
      if (form) {
        form.addEventListener("submit", function (e) {
          var ok = false;
          document.querySelectorAll("tr.fb-cashier-row").forEach(function (tr) {
            if (tr.style.display === "none") return;
            var cb = tr.querySelector(".fb-cashier-cb");
            if (cb && cb.checked && !cb.disabled) ok = true;
          });
          if (!ok) {
            e.preventDefault();
            alert("Select at least one active item for this outlet.");
          }
        });
      }
      applyOutletFilter();
    })();
  </script>
</section>`;
  const content = `
<style>
.fb-master-page { max-width:1180px;margin:0 auto; }
.fb-master-nav a { font-size:13px;font-weight:700;color:#0f766e;text-decoration:none;padding:6px 10px;border-radius:8px; }
.fb-master-nav a:hover { background:#e0f2f1; }
.fb-master-nav-sticky { position:sticky;top:0;z-index:20;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);padding:10px 4px 12px;margin:0 -4px 14px;border-bottom:1px solid #e2e8f0;box-shadow:0 1px 0 rgba(15,23,42,.04); }
.fb-pos-title { margin:0;font-size:1.2rem;font-weight:800;color:#064e3b;letter-spacing:-0.02em; }
.fb-pos-h3 { margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b; }
.fb-pos-card { border-radius:12px;padding:16px 18px;margin-bottom:14px; }
.fb-pos-context-loaded { background:#ecfdf5;border:1px solid #6ee7b7;border-left:4px solid #059669; }
.fb-pos-context-idle { background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #d97706; }
.fb-pos-context-missing { background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #dc2626; }
.fb-pos-context-head { display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;flex-wrap:wrap; }
.fb-pos-dl { display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px 24px;margin:0; }
.fb-pos-dl div { margin:0; }
.fb-pos-dl dt { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#047857;margin:0 0 4px; }
.fb-pos-dl dd { margin:0;font-size:15px;font-weight:600;color:#0f172a;line-height:1.35; }
.fb-pos-footnote { margin:14px 0 0;font-size:12px;color:#047857;line-height:1.45;border-top:1px solid rgba(5,150,105,.25);padding-top:12px; }
.fb-pos-shell { margin-bottom:20px;border:1px solid #e2e8f0;border-radius:14px;padding:16px 18px 20px;background:#f1f5f9; }
.fb-pos-shell-head { margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid #cbd5e1; }
.fb-pos-shell-head h2 { margin:0 0 6px;font-size:1.35rem; }
.fb-pos-panel { background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:14px; }
.fb-pos-panel-title { margin:0 0 12px;font-size:1rem;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:10px;flex-wrap:wrap; }
.fb-pos-panel-tag { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;background:#f1f5f9;padding:4px 8px;border-radius:6px; }
.fb-pos-ticket-row { display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:8px; }
.fb-pos-checkout { background:#fff;border:2px solid #0f766e;border-radius:12px;padding:14px 16px;margin-bottom:14px; }
.fb-pos-checkout-title { margin:0 0 10px;font-size:1rem;font-weight:800;color:#0f172a; }
.fb-pos-table { width:100%;border-collapse:collapse;font-size:13px; }
.fb-pos-table th { text-align:left;padding:8px 10px;border-bottom:2px solid #e2e8f0;background:#f8fafc;font-weight:700;color:#334155; }
.fb-pos-table th.num { text-align:right; }
.fb-pos-table td { padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top; }
.fb-pos-table td.num { text-align:right;font-variant-numeric:tabular-nums; }
.fb-pos-table tfoot td { border-bottom:none;padding-top:12px;font-weight:700; }
.fb-pos-tfoot-note td { font-weight:400 !important;font-size:12px;color:#64748b;font-style:italic;padding-top:6px !important; }
.fb-pos-total-row td { font-size:17px;padding-top:14px !important;border-top:2px solid #e2e8f0;color:#0f172a; }
#fb-charge-root .fb-pos-post-bar { position:sticky;bottom:0;z-index:30;display:flex;flex-wrap:wrap;align-items:stretch;justify-content:space-between;gap:16px;padding:18px 20px;padding-bottom:max(18px,calc(12px + env(safe-area-inset-bottom,0)));margin-top:16px;background:linear-gradient(135deg,#0f766e 0%,#0d9488 100%);border-radius:12px;color:#fff;box-shadow:0 4px 14px rgba(15,118,110,.25); }
.fb-pos-post-copy { flex:1;min-width:220px; }
.fb-pos-recap { margin:0 0 4px;font-size:16px;font-weight:700;line-height:1.4; }
.fb-pos-recap-sub { margin:0;font-size:13px;opacity:.92;line-height:1.4; }
.fb-pos-post-actions { display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:10px; }
.fb-pos-post-btn { padding:16px 28px;border:0;border-radius:10px;background:#fff;color:#0f766e;font-weight:800;font-size:17px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12);white-space:nowrap; }
.fb-pos-post-btn:hover { filter:brightness(1.03); }
.fb-pos-post-btn:disabled { opacity:.55;cursor:not-allowed; }
#fb-submit-error { display:none;margin:0 0 12px;padding:10px 14px;border-radius:8px;background:#fee2e2;color:#7f1d1d;font-weight:600;font-size:14px; }
.fb-cashier-shell { border:2px solid #14b8a6 !important;background:linear-gradient(180deg,#ecfdf5 0,#fff 56px) !important; }
.fb-cashier-outlet { display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px; }
.fb-cashier-outlet label:has(input:checked) { border-color:#0f766e !important;background:#ecfdf5 !important; }
#fb-cashier-sale .fb-cashier-footer { position:sticky;bottom:0;z-index:20;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;padding:16px 18px;padding-bottom:max(16px,calc(10px + env(safe-area-inset-bottom,0)));margin-top:8px;border-radius:12px;background:#f0fdfa;border:1px solid #5eead4;box-shadow:0 -6px 20px rgba(15,23,42,.06); }
</style>
<div class="fb-master-page">
<h1 style="margin:0 0 6px;font-size:1.55rem;letter-spacing:-0.02em">F&amp;B master — restaurant &amp; café</h1>
<p class="muted" style="margin:0 0 12px;line-height:1.5">${escapeHtml(hotel.displayName)} · Single control page for <strong>in-house folio posting</strong>, <strong>walk-in / direct POS</strong>, <strong>outlet KOT tickets</strong>, <strong>operating expenses</strong>, and <strong>sales reporting</strong> (PMS-style F&amp;B ops).</p>
<nav class="fb-master-nav fb-master-nav-sticky" aria-label="F&amp;B sections">
  <a href="#fb-master-snapshot">Snapshot</a>
  <a href="#fb-master-outlet">Outlet / KOT</a>
  <a href="#fb-cashier-sale">Direct sale</a>
  <a href="#fb-lookup">Guest lookup</a>
  <a href="#fb-inhouse">Folio charge</a>
  <a href="#fb-expenses">Expenses</a>
  <a href="#fb-sales-summary">Sales report</a>
  <a href="#fb-catalog">Menu admin</a>
</nav>
${snapshotMasterHtml}
${outletMasterStripHtml}
${fbQuickCashierSectionHtml}
${saved}
${mergedBanner}
${chargeSuccessFlag && chargeSuccessBanner ? `<div class="fb-pos-card" style="background:#ecfdf5;border:2px solid #34d399;margin-bottom:16px;padding:16px 18px;border-radius:12px" role="status"><strong style="display:block;margin-bottom:8px;color:#065f46;font-size:12px;text-transform:uppercase;letter-spacing:.06em">Success — folio updated</strong>${chargeSuccessBanner}</div>` : ""}
${outletWarnFb && chargeSuccessFlag ? `<div class="fb-pos-card" style="background:#fffbeb;border:2px solid #f59e0b;margin-bottom:16px;padding:14px 16px;border-radius:12px" role="alert"><strong style="display:block;margin-bottom:6px;color:#92400e;font-size:12px;text-transform:uppercase;letter-spacing:.06em">Outlet WhatsApp notice</strong><p style="margin:0;font-size:14px;color:#78350f;font-weight:600">${escapeHtml(outletWarnFb)}</p></div>` : ""}
${chargeErr ? `<p class="badge alert" style="padding:12px 14px;font-size:14px;margin-bottom:14px" role="alert"><strong>Post failed.</strong> ${escapeHtml(chargeErr)}</p>` : ""}
${directOk ? `<p class="badge ok" style="padding:12px 14px;margin-bottom:12px">Walk-in sale posted to ledger (F&amp;B lines + payment).</p>` : ""}
${directErrStr ? `<p class="badge alert" style="padding:12px 14px;margin-bottom:12px">${escapeHtml(directErrStr)}</p>` : ""}
${expenseSavedFlag ? `<p class="badge ok" style="padding:12px 14px;margin-bottom:12px">Operational expense saved.</p>` : ""}
${expenseErrStr ? `<p class="badge alert" style="padding:12px 14px;margin-bottom:12px">${escapeHtml(expenseErrStr)}</p>` : ""}
<section id="fb-lookup" class="fb-pos-card" style="background:#f0f9ff;border:1px solid #7dd3fc;margin-bottom:16px;scroll-margin-top:72px">
  <h2 style="margin:0 0 10px;font-size:1.1rem">In-house guest lookup</h2>
  <p class="muted" style="margin:0 0 12px;font-size:13px"><strong>1)</strong> Stay date · <strong>2)</strong> Room / unit (or leave “All rooms”) · <strong>3)</strong> Filter by name, phone, or reference · <strong>4)</strong> Choose guest in the list to load folio — <em>no need to paste booking ID first</em>. Booking ID remains available as a fallback under Folio charge.</p>
  <form id="fb-guest-filters" method="get" action="/admin/fb/menu" style="margin-bottom:14px">
    <input type="hidden" name="report_start" value="${escapeHtml(reportStartVal)}" />
    <input type="hidden" name="report_end" value="${escapeHtml(reportEndVal)}" />
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;align-items:end">
      <label style="font-weight:600">Stay date<br/>
        <input type="date" name="ops_date" value="${escapeHtml(opsDateVal)}" required style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px" />
      </label>
      <label style="font-weight:600">Room / unit <span class="muted" style="font-weight:400">(first)</span><br/>
        <select name="room_unit_id" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px" onchange="document.getElementById('fb-guest-filters').submit();">
          ${roomOptionsHtml}
        </select>
      </label>
      <label>Guest name / phone<br/><input type="search" name="guest_q" value="${escapeHtml(explicitGuestQ)}" placeholder="Filter by guest" autocomplete="off" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px" /></label>
      <label>Booking reference / ID<br/><input type="search" name="ref_q" value="${escapeHtml(explicitRefQ)}" placeholder="WA-… or id prefix" autocomplete="off" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px" /></label>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px">
      <button type="submit" class="btn-link primary" style="padding:10px 18px;border:0;border-radius:8px;background:#0ea5e9;color:#fff;font-weight:700">Apply name &amp; ref filters</button>
      <a class="muted" style="font-size:13px" href="/admin/fb/menu?ops_date=${encodeURIComponent(opsDateVal)}&amp;report_start=${encodeURIComponent(reportStartVal)}&amp;report_end=${encodeURIComponent(reportEndVal)}">Clear searches</a>
      <span class="muted" style="font-size:12px">Showing <strong>${inHouseList.length}</strong> match(es) · <strong>${fullInHouseList.length}</strong> in-house tonight</span>
    </div>
  </form>
  <label style="font-weight:700;font-size:14px;display:block">Load folio (charge target)</label>
  <select id="fb-booking-picker" style="display:block;margin-top:6px;max-width:100%;padding:10px;border:2px solid #0f766e;border-radius:8px;font-size:14px;font-weight:600;background:#fff">
    <option value="">Choose guest to load booking &amp; folio…</option>
    ${inHouseOptionsHtml || `<option value="" disabled>(No matches — adjust filters above)</option>`}
  </select>
  <p class="muted" style="margin:10px 0 0;font-size:12px">Selecting a room with exactly one guest opens the folio automatically. Options show booking id suffix to avoid mix-ups. Fallback: paste booking ID under <strong>Folio charge → Step 1</strong>.</p>
  <script>
    (function () {
      var sel = document.getElementById("fb-booking-picker");
      if (!sel) return;
      sel.addEventListener("change", function () {
        var v = this.value;
        if (!v) return;
        var p = new URLSearchParams();
        p.set("bookingId", v);
        p.set("ops_date", "${escapeHtml(opsDateVal)}");
        p.set("report_start", "${escapeHtml(reportStartVal)}");
        p.set("report_end", "${escapeHtml(reportEndVal)}");
        var ru = "${escapeHtml(roomUnitFilter)}";
        if (ru) p.set("room_unit_id", ru);
        var gq = "${escapeHtml(explicitGuestQ)}";
        if (gq) p.set("guest_q", gq);
        var rq = "${escapeHtml(explicitRefQ)}";
        if (rq) p.set("ref_q", rq);
        var lq = "${escapeHtml(legacyQ)}";
        if (lq && !gq && !rq) p.set("q", lq);
        window.location.href = "/admin/fb/menu?" + p.toString();
      });
    })();
  </script>
</section>
<section id="fb-inhouse" style="scroll-margin-top:72px">
<section id="fb-charge-root" class="fb-pos-shell" data-currency="${escapeHtml(hotel.currency)}" data-booking-valid="${bookingForBanner ? "1" : "0"}" data-loaded-booking-id="${bookingForBanner ? escapeHtml(bookingForBanner.id) : ""}" data-guest-recap="${guestRecapLabel}">
  <header class="fb-pos-shell-head">
    <h2 style="margin:0 0 4px;font-size:1.25rem">In-house guest folio charge</h2>
    <p class="muted" style="margin:0;font-size:13px">Post menu lines to the staying guest&apos;s folio (room service or dining). Use <strong>Guest lookup</strong> above to load the booking, then select items and post.</p>
  </header>
  ${bookingContextPanel}
  ${bookingGatePanel}
  <section class="fb-pos-panel" aria-label="Link booking and ticket options">
    <h3 class="fb-pos-panel-title"><span class="fb-pos-panel-tag">Step 1</span> Link folio &amp; ticket</h3>
    <form id="fb-charge-folio" method="post" action="/admin/fb/menu/charge-folio">
      <div class="fb-pos-ticket-row">
        <label>Booking ID <span style="color:#b91c1c">*</span> <span class="muted" style="font-weight:400">(fallback)</span><br/>
          <input type="text" id="fb-booking-id-input" name="bookingId" value="${escapeHtml(bookingIdParam)}" required placeholder="Filled from guest picker, or paste ID" style="padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;min-width:280px;font-size:15px" autocomplete="off" />
        </label>
        <button type="button" id="fb-load-booking-btn" style="padding:10px 16px;border:1px solid #0f766e;border-radius:8px;background:#fff;color:#0f766e;font-weight:700;cursor:pointer">Load booking</button>
        <a class="btn-link" href="/admin/bookings" target="_blank" rel="noopener noreferrer" style="align-self:center">Bookings list</a>
      </div>
      <div class="fb-pos-ticket-row">
        <label>Service<br/>
          <select name="serviceMode" style="padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;min-width:160px">
            <option value="ROOM_SERVICE">Room service</option>
            <option value="DINING_IN">Dining in</option>
          </select>
        </label>
        <label style="min-width:220px;flex:1">Notes (kitchen / bar)<br/>
          <input type="text" name="notes" maxlength="500" placeholder="Optional" style="width:100%;max-width:420px;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px" />
        </label>
      </div>
    </form>
    <p class="muted" style="margin:10px 0 0;font-size:12px">Only <strong>active</strong> items can be charged. Mixed restaurant + coffee creates <strong>one folio ticket per outlet</strong> (same invoice total).</p>
  </section>
  <section class="fb-pos-panel" aria-label="Menu selection">
    <h3 class="fb-pos-panel-title"><span class="fb-pos-panel-tag">Step 2</span> Select items</h3>
    <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:10px">
      <table class="fb-pos-table">
        <thead><tr><th>Add</th><th class="num">Qty</th><th>Outlet</th><th>Item</th><th class="num">Unit price</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7">No items.</td></tr>'}</tbody>
      </table>
    </div>
  </section>
  <section class="fb-pos-checkout" aria-label="Checkout summary">
    <h3 class="fb-pos-checkout-title"><span class="fb-pos-panel-tag" style="background:#ecfdf5;color:#047857">Step 3</span> Checkout summary</h3>
    <p id="fb-folio-preview-empty" class="muted" style="margin:0 0 12px;font-size:14px">No lines selected. Tick items in the table above to build the folio charge.</p>
    <div id="fb-folio-preview-body" style="display:none">
      <div style="overflow-x:auto">
        <table class="fb-pos-table">
          <thead>
            <tr>
              <th>Outlet</th>
              <th>Item</th>
              <th class="num">Qty</th>
              <th class="num">Unit</th>
              <th class="num">Line total</th>
            </tr>
          </thead>
          <tbody id="fb-folio-preview-tbody"></tbody>
          <tfoot>
            <tr>
              <td colspan="4" class="num" style="font-weight:700;color:#334155">Subtotal</td>
              <td class="num" id="fb-checkout-subtotal">0.00 ${escapeHtml(hotel.currency)}</td>
            </tr>
            <tr class="fb-pos-tfoot-note">
              <td colspan="5">Tax / service charge is not itemized on F&amp;B in this system — totals are menu unit price × quantity.</td>
            </tr>
            <tr class="fb-pos-total-row">
              <td colspan="4" class="num">Total to post to folio</td>
              <td class="num" id="fb-checkout-total"><span id="fb-folio-grand-total">0.00 ${escapeHtml(hotel.currency)}</span></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p id="fb-folio-outlet-notes" class="muted" style="margin:10px 0 0;font-size:12px"></p>
    </div>
  </section>
  <p id="fb-submit-error" role="alert"></p>
  <section class="fb-pos-post-bar" aria-label="Post charges">
    <div class="fb-pos-post-copy">
      <p id="fb-post-recap" class="fb-pos-recap">Link a booking to enable posting.</p>
      <p id="fb-post-recap-sub" class="fb-pos-recap-sub">The button posts your checkout total to the loaded guest folio.</p>
    </div>
    <div class="fb-pos-post-actions">
      <button type="submit" form="fb-charge-folio" id="fb-post-folio-btn" class="fb-pos-post-btn">Post charges to folio</button>
    </div>
  </section>
  <script>
    (function () {
      var root = document.getElementById("fb-charge-root");
      var form = document.getElementById("fb-charge-folio");
      var btn = document.getElementById("fb-load-booking-btn");
      var input = document.getElementById("fb-booking-id-input");
      var errEl = document.getElementById("fb-submit-error");
      var cur = root ? root.getAttribute("data-currency") || "OMR" : "OMR";
      function fmt(n) {
        var x = Number(n);
        if (!isFinite(x)) x = 0;
        return x.toFixed(2) + " " + cur;
      }
      function showErr(msg) {
        if (!errEl) return;
        errEl.textContent = msg;
        errEl.style.display = msg ? "block" : "none";
      }
      function recalcPreview() {
        var tbody = document.getElementById("fb-folio-preview-tbody");
        var empty = document.getElementById("fb-folio-preview-empty");
        var body = document.getElementById("fb-folio-preview-body");
        var grandEl = document.getElementById("fb-folio-grand-total");
        var subEl = document.getElementById("fb-checkout-subtotal");
        var outletNote = document.getElementById("fb-folio-outlet-notes");
        var postBtn = document.getElementById("fb-post-folio-btn");
        var recap = document.getElementById("fb-post-recap");
        var recapSub = document.getElementById("fb-post-recap-sub");
        if (!tbody || !empty || !body || !grandEl) return;
        var valid = root && root.getAttribute("data-booking-valid") === "1";
        var loadedId = root ? (root.getAttribute("data-loaded-booking-id") || "").trim() : "";
        var guest = root ? (root.getAttribute("data-guest-recap") || "").trim() : "";
        tbody.innerHTML = "";
        var grand = 0;
        var lineCount = 0;
        var outlets = {};
        document.querySelectorAll("tr.fb-charge-row").forEach(function (tr) {
          if (tr.getAttribute("data-fb-active") !== "1") return;
          var cb = tr.querySelector(".fb-charge-cb");
          var qEl = tr.querySelector(".fb-charge-qty");
          if (!cb || !cb.checked || cb.disabled) return;
          var qty = parseInt(qEl && qEl.value, 10);
          if (!isFinite(qty) || qty < 1) qty = 1;
          if (qty > 99) qty = 99;
          var price = parseFloat(tr.getAttribute("data-fb-price") || "0");
          var nameEl = tr.querySelector(".fb-item-name");
          var outEl = tr.querySelector(".fb-item-outlet");
          var name = nameEl ? nameEl.textContent.trim() : "";
          var outlet = outEl ? outEl.textContent.trim() : "";
          var line = Math.round(price * qty * 100) / 100;
          grand += line;
          lineCount += 1;
          outlets[outlet] = true;
          var trp = document.createElement("tr");
          function cell(text, alignRight, bold) {
            var td = document.createElement("td");
            td.className = alignRight ? "num" : "";
            td.style.padding = "8px 10px";
            td.style.borderBottom = "1px solid #f1f5f9";
            td.style.verticalAlign = "top";
            if (alignRight) td.style.textAlign = "right";
            if (bold) td.style.fontWeight = "600";
            td.textContent = text;
            return td;
          }
          trp.appendChild(cell(outlet, false, false));
          trp.appendChild(cell(name, false, false));
          trp.appendChild(cell(String(qty), true, false));
          trp.appendChild(cell(fmt(price), true, false));
          trp.appendChild(cell(fmt(line), true, true));
          tbody.appendChild(trp);
        });
        var subText = fmt(grand);
        if (lineCount === 0) {
          empty.style.display = "block";
          body.style.display = "none";
          grandEl.textContent = "0.00 " + cur;
          if (subEl) subEl.textContent = "0.00 " + cur;
          if (outletNote) outletNote.textContent = "";
          if (postBtn) postBtn.disabled = true;
          if (recap) {
            recap.textContent = valid
              ? "Folio linked" + (guest ? " for " + guest : "") + (loadedId ? " · booking " + loadedId : "") + ". Select menu lines to charge."
              : "No folio linked — paste a booking ID and click Load booking.";
          }
          if (recapSub) {
            recapSub.textContent = valid
              ? "Checkout summary will show line totals and the amount posted to this folio."
              : "Posting stays disabled until a valid booking is loaded.";
          }
          return;
        }
        empty.style.display = "none";
        body.style.display = "block";
        grandEl.textContent = subText;
        if (subEl) subEl.textContent = subText;
        if (postBtn) postBtn.disabled = !valid;
        var ok = Object.keys(outlets);
        if (outletNote) {
          outletNote.textContent = ok.length > 1
            ? "Posting creates " + ok.length + " folio tickets (one per outlet). Invoice total matches the total below."
            : "Posting creates one folio ticket (" + ok[0] + ").";
        }
        if (recap) {
          recap.textContent =
            "Post " +
            subText +
            " to " +
            (guest || "guest") +
            " · booking " +
            loadedId +
            " (" +
            lineCount +
            " line" +
            (lineCount === 1 ? "" : "s") +
            ").";
        }
        if (recapSub) {
          recapSub.textContent =
            "Subtotal and total are the same (no separate tax line). Confirm above, then post.";
        }
      }
      document.querySelectorAll(".fb-charge-cb, .fb-charge-qty").forEach(function (el) {
        el.addEventListener("change", recalcPreview);
        el.addEventListener("input", recalcPreview);
      });
      recalcPreview();
      if (btn && input) {
        btn.addEventListener("click", function () {
          var id = (input.value || "").trim();
          if (!id) {
            input.focus();
            return;
          }
          window.location.href = "/admin/fb/menu?bookingId=" + encodeURIComponent(id);
        });
      }
      if (form && root && input) {
        form.addEventListener("submit", function (e) {
          showErr("");
          var valid = root.getAttribute("data-booking-valid") === "1";
          var loadedId = (root.getAttribute("data-loaded-booking-id") || "").trim();
          var typed = (input.value || "").trim();
          if (!valid || !loadedId) {
            e.preventDefault();
            showErr("Load a valid booking first: paste the booking ID and click \\"Load booking\\" so the folio target is confirmed.");
            input.focus();
            return;
          }
          if (typed !== loadedId) {
            e.preventDefault();
            showErr("Booking ID changed since load. Click \\"Load booking\\" again to confirm the folio, or restore ID " + loadedId + ".");
            return;
          }
          var hasLine = false;
          document.querySelectorAll("tr.fb-charge-row").forEach(function (tr) {
            if (tr.getAttribute("data-fb-active") !== "1") return;
            var cb = tr.querySelector(".fb-charge-cb");
            if (cb && cb.checked && !cb.disabled) hasLine = true;
          });
          if (!hasLine) {
            e.preventDefault();
            showErr("Select at least one active menu item with a quantity.");
          }
        });
      }
    })();
  </script>
</section>
</section>
<section id="fb-expenses" class="fb-pos-card" style="margin-bottom:18px;border:1px solid #e9d5ff;background:#faf5ff;scroll-margin-top:72px">
  <h2 style="margin:0 0 8px;font-size:1.1rem">F&amp;B expenses &amp; purchases</h2>
  <p class="muted" style="margin:0 0 12px;font-size:13px">Groceries, beverages, supplies — internal cost tracking (not guest folio).</p>
  <form method="post" action="/admin/fb/menu/expense" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px">
    <label>Date<br/><input type="date" name="expense_date" required value="${escapeHtml(opsDateVal)}" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px" /></label>
    <label>Amount (${escapeHtml(hotel.currency)})<br/><input type="number" name="amount" min="0.01" step="0.01" required style="padding:8px;border:1px solid #cbd5e1;border-radius:8px;width:120px" /></label>
    <label>Category<br/>
      <select name="category" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px">
        <option value="GROCERY">Grocery</option>
        <option value="BEVERAGE">Beverage</option>
        <option value="SUPPLIES">Supplies / consumables</option>
        <option value="KITCHEN">Kitchen</option>
        <option value="CAFE">Café</option>
        <option value="OTHER">Other</option>
      </select>
    </label>
    <label>Outlet<br/>
      <select name="outlet" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px">
        <option value="">—</option>
        <option value="RESTAURANT">Restaurant</option>
        <option value="CAFE">Café</option>
        <option value="BOTH">Both</option>
      </select>
    </label>
    <label>Pay method<br/><input type="text" name="payment_method" placeholder="e.g. Cash" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px;width:120px" /></label>
    <label style="flex:1;min-width:200px">Reference / note<br/><input type="text" name="reference_note" maxlength="500" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px" /></label>
    <button type="submit" style="padding:10px 16px;border:0;border-radius:8px;background:#7c3aed;color:#fff;font-weight:700">Save expense</button>
  </form>
  <div style="overflow-x:auto">
    <table class="fb-pos-table" style="font-size:12px">
      <thead><tr><th>Date</th><th>Category</th><th class="num">Amount</th><th>Outlet</th><th>Pay</th><th>Note</th><th>By</th></tr></thead>
      <tbody>${expenseTableRows.length ? expenseTableRows : '<tr><td colspan="7" class="muted">No expenses logged yet.</td></tr>'}</tbody>
    </table>
  </div>
</section>
<section id="fb-sales-summary" class="fb-pos-card" style="margin-bottom:18px;scroll-margin-top:72px">
  <h2 style="margin:0 0 8px;font-size:1.1rem">Sales summary &amp; reporting</h2>
  <form method="get" action="/admin/fb/menu" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px">
    <input type="hidden" name="ops_date" value="${escapeHtml(opsDateVal)}" />
    <input type="hidden" name="guest_q" value="${escapeHtml(explicitGuestQ)}" />
    <input type="hidden" name="ref_q" value="${escapeHtml(explicitRefQ)}" />
    <input type="hidden" name="room_unit_id" value="${escapeHtml(roomUnitFilter)}" />
    <input type="hidden" name="q" value="${escapeHtml(legacyQ)}" />
    <input type="hidden" name="bookingId" value="${escapeHtml(bookingIdParam)}" />
    <label>From<br/><input type="date" name="report_start" value="${escapeHtml(reportStartVal)}" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px" /></label>
    <label>To<br/><input type="date" name="report_end" value="${escapeHtml(reportEndVal)}" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px" /></label>
    <button type="submit" class="btn-link primary" style="padding:10px 16px;border:0;border-radius:8px;background:#334155;color:#fff;font-weight:700">Refresh</button>
  </form>
  <p class="muted" style="font-size:12px;margin:0 0 10px">Range: ${escapeHtml(reportStartVal)} → ${escapeHtml(reportEndVal)} (inclusive).</p>
  <div class="grid-4" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:12px">
    <article class="stat"><h3>Guest menu orders</h3><p>${summaryOps.fbOrderFolioTotal.toFixed(2)} ${escapeHtml(hotel.currency)}</p><p class="muted" style="font-size:11px;margin:0">${summaryOps.fbOrderFolioCount} FbOrder(s)</p></article>
    <article class="stat"><h3>Guest folio F&amp;B</h3><p>${summaryOps.folioGuestFnChargesNet.toFixed(2)} ${escapeHtml(hotel.currency)}</p><p class="muted" style="font-size:11px;margin:0">${summaryOps.folioGuestFnChargeLineCount} charge line(s) to in-house folios</p></article>
    <article class="stat"><h3>Direct F&amp;B (no booking)</h3><p>${summaryOps.directFnChargesNet.toFixed(2)} ${escapeHtml(hotel.currency)}</p><p class="muted" style="font-size:11px;margin:0">${summaryOps.directFnChargeLineCount} line(s) · Rest ${summaryOps.directFnRestaurantNet.toFixed(2)} · Café ${summaryOps.directFnCafeNet.toFixed(2)}${summaryOps.directFnOtherNet > 0.005 ? ` · Other ${summaryOps.directFnOtherNet.toFixed(2)}` : ""}<br/>Quick cashier: ${summaryOps.walkInCashierFnNet.toFixed(2)}</p></article>
    <article class="stat"><h3>Walk-in POS payments</h3><p>${summaryOps.walkInPaymentTotal.toFixed(2)} ${escapeHtml(hotel.currency)}</p><p class="muted" style="font-size:11px;margin:0">Matches direct café/restaurant cashier takes</p></article>
    <article class="stat"><h3>Activity sales</h3><p>${summaryOps.activityChargesNet.toFixed(2)} ${escapeHtml(hotel.currency)}</p><p class="muted" style="font-size:11px;margin:0">Folio ${summaryOps.activityFolioLinkedNet.toFixed(2)} · Direct ${summaryOps.activityDirectNet.toFixed(2)}</p></article>
    <article class="stat"><h3>F&amp;B expenses</h3><p>${summaryOps.expenseTotal.toFixed(2)} ${escapeHtml(hotel.currency)}</p><p class="muted" style="font-size:11px;margin:0">Recorded purchases</p></article>
  </div>
  <h3 style="font-size:14px;margin:12px 0 6px">Walk-in payment mix</h3>
  <table class="fb-pos-table" style="max-width:420px">
    <thead><tr><th>Method (normalized)</th><th class="num">Amount</th></tr></thead>
    <tbody>${payMixRows}</tbody>
  </table>
  <p class="muted" style="font-size:11px;margin-top:10px">Guest menu orders = posted <code>FbOrder</code> totals. Guest folio F&amp;B = ledger charges linked to a stay. Direct F&amp;B = charges with no booking (walk-ins / quick cashier). Walk-in payments use the same method buckets as shift-close. Activity = <code>ACTIVITY_CHARGE</code> lines in the date range.</p>
</section>
<section id="fb-catalog" style="margin-bottom:16px;border:1px solid #e2e8f0;border-radius:12px;padding:14px;scroll-margin-top:72px">
  <h3 style="margin-top:0">Menu administration — add item</h3>
  <form method="post" action="/admin/fb/menu/add" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
    <label>Outlet
      <select name="outletType" required style="padding:8px;border:1px solid #d8dee6;border-radius:8px">
        <option value="RESTAURANT">Restaurant</option>
        <option value="COFFEE_SHOP">Coffee shop</option>
      </select>
    </label>
    <label>Name <input type="text" name="name" required placeholder="e.g. Club sandwich" style="padding:8px;border:1px solid #d8dee6;border-radius:8px;min-width:180px" /></label>
    <label>Price (${escapeHtml(hotel.currency)}) <input type="number" name="unitPrice" min="0" step="0.01" required style="padding:8px;border:1px solid #d8dee6;border-radius:8px;width:100px" /></label>
    <label>Sort <input type="number" name="sortOrder" value="0" style="padding:8px;border:1px solid #d8dee6;border-radius:8px;width:72px" /></label>
    <button type="submit" style="padding:9px 14px;border:0;border-radius:8px;background:#128c7e;color:#fff;font-weight:700">Add</button>
  </form>
</section>
<section style="margin-bottom:12px">
  <form method="post" action="/admin/fb/menu/append-resort-menu" style="display:inline">
    <button type="submit" class="btn-link" style="padding:8px 12px;border:1px solid #d8dee6;border-radius:8px;background:#fff">Add missing items from 2026 resort pack</button>
  </form>
  <span class="muted" style="font-size:12px;margin-left:8px">Safe to run more than once — skips duplicates by name + outlet.</span>
</section>
<p class="muted"><a class="inline-link" href="/admin/bookings">Back to bookings</a></p>
</div>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/fb/menu/charge-folio", requireFbOperationsEdit(), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/fb/menu");
    return;
  }
  const bookingId = String(req.body.bookingId ?? "").trim();
  const serviceRaw = String(req.body.serviceMode ?? "").toUpperCase();
  const serviceMode = serviceRaw === "DINING_IN" ? FbServiceMode.DINING_IN : FbServiceMode.ROOM_SERVICE;
  const notes = String(req.body.notes ?? "").trim().slice(0, 500);

  const redirectBack = (msg: string) => {
    res.redirect(`/admin/fb/menu?chargeError=${encodeURIComponent(msg)}&bookingId=${encodeURIComponent(bookingId)}`);
  };

  if (!bookingId) {
    redirectBack("Booking ID is required.");
    return;
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    select: { id: true, guestId: true }
  });
  if (!booking) {
    redirectBack("Booking not found for this hotel.");
    return;
  }

  const menuItems = await prisma.menuItem.findMany({
    where: { hotelId: hotel.id, isActive: true },
    select: { id: true }
  });
  const lines: { menuItemId: string; qty: number }[] = [];
  for (const m of menuItems) {
    const flag = req.body[`charge_${m.id}`];
    if (flag !== "1" && flag !== "on") continue;
    const qty = clamp(parseIntegerInput(req.body[`qty_${m.id}`], 1), 1, 99);
    lines.push({ menuItemId: m.id, qty });
  }

  if (lines.length === 0) {
    redirectBack("Select at least one active menu item.");
    return;
  }

  try {
    const outletWarnings = await createFbOrdersFromMenuLines({
      hotelId: hotel.id,
      bookingId: booking.id,
      guestId: booking.guestId,
      serviceMode,
      notes: notes || null,
      lines
    });
    await logAudit({
      hotelId: hotel.id,
      action: "FB_ORDER_POSTED_TO_FOLIO",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { from: "fb_menu_page", outletNotifyWarnings: outletWarnings }
    });
    const warnQ =
      outletWarnings.length > 0 ? `&outletWarn=${encodeURIComponent(outletWarnings.join(" "))}` : "";
    res.redirect(`/admin/fb/menu?bookingId=${encodeURIComponent(bookingId)}&chargeSuccess=1${warnQ}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not post F&B charges.";
    redirectBack(msg);
  }
});

adminRouter.post("/fb/menu/append-resort-menu", requireFbOperationsEdit(), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/fb/menu");
    return;
  }
  const n = await appendMissingFbMenuItems(hotel.id);
  await logAudit({
    hotelId: hotel.id,
    action: "FB_MENU_APPEND_PACK",
    entityType: "Hotel",
    entityId: hotel.id,
    metadata: { added: n }
  });
  res.redirect(`/admin/fb/menu?merged=${encodeURIComponent(String(n))}&saved=1`);
});

adminRouter.post("/fb/menu/add", requireFbOperationsEdit(), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/fb/menu");
    return;
  }
  const outletRaw = String(req.body.outletType ?? "").toUpperCase();
  const outletType = outletRaw === "COFFEE_SHOP" ? FbOutletType.COFFEE_SHOP : FbOutletType.RESTAURANT;
  const name = String(req.body.name ?? "").trim();
  const unitPrice = Math.max(0, parseNumberInput(req.body.unitPrice, 0));
  const sortOrder = parseIntegerInput(req.body.sortOrder, 0);
  if (!name) {
    res.redirect("/admin/fb/menu");
    return;
  }
  await prisma.menuItem.create({
    data: { hotelId: hotel.id, outletType, name, unitPrice, sortOrder, isActive: true }
  });
  await logAudit({ hotelId: hotel.id, action: "FB_MENU_ITEM_ADDED", entityType: "MenuItem", metadata: { name, outletType, unitPrice } });
  res.redirect("/admin/fb/menu?saved=1");
});

adminRouter.post("/fb/menu/:itemId/toggle", requireFbOperationsEdit(), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/fb/menu");
    return;
  }
  const item = await prisma.menuItem.findFirst({ where: { id: String(req.params.itemId ?? ""), hotelId: hotel.id } });
  if (item) {
    await prisma.menuItem.update({ where: { id: item.id }, data: { isActive: !item.isActive } });
  }
  res.redirect("/admin/fb/menu?saved=1");
});

adminRouter.post("/fb/menu/direct-sale", requireFbOperationsEdit(), async (req, res) => {
  const session = getSession(req);
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, currency: true }
  });
  if (!hotel || !session) {
    res.redirect("/admin/fb/menu?directErr=" + encodeURIComponent("Session or hotel missing."));
    return;
  }
  const paymentMethod = String(req.body.payment_method ?? "CASH");
  const notes = String(req.body.notes ?? "").trim();
  const outletRaw = String(req.body.cashier_outlet ?? "RESTAURANT").toUpperCase();
  const outletScope = outletRaw === "COFFEE_SHOP" ? FbOutletType.COFFEE_SHOP : FbOutletType.RESTAURANT;
  const menuItems = await prisma.menuItem.findMany({
    where: { hotelId: hotel.id, isActive: true },
    select: { id: true }
  });
  const lines: { menuItemId: string; qty: number }[] = [];
  for (const m of menuItems) {
    const fl = req.body[`direct_charge_${m.id}`];
    if (fl !== "1" && fl !== "on") continue;
    const qty = clamp(parseIntegerInput(req.body[`direct_qty_${m.id}`], 1), 1, 99);
    lines.push({ menuItemId: m.id, qty });
  }
  try {
    await recordWalkInDirectSale({
      hotelId: hotel.id,
      currency: hotel.currency,
      staffId: session.staffId,
      paymentMethodRaw: paymentMethod,
      notes: notes || null,
      lines,
      outletScope
    });
    await logAudit({
      hotelId: hotel.id,
      action: "FB_WALK_IN_DIRECT_SALE",
      entityType: "Hotel",
      entityId: hotel.id,
      metadata: { lineCount: lines.length }
    });
    res.redirect("/admin/fb/menu?directOk=1");
  } catch (e) {
    res.redirect(
      "/admin/fb/menu?directErr=" + encodeURIComponent(e instanceof Error ? e.message : "Could not post walk-in sale.")
    );
  }
});

adminRouter.post("/fb/menu/expense", requireFbOperationsEdit(), async (req, res) => {
  const session = getSession(req);
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel || !session) {
    res.redirect("/admin/fb/menu?expenseErr=" + encodeURIComponent("Session or hotel missing."));
    return;
  }
  const amount = parseFloat(String(req.body.amount ?? ""));
  const category = String(req.body.category ?? "OTHER").trim().slice(0, 48) || "OTHER";
  const outlet = String(req.body.outlet ?? "").trim().slice(0, 32) || null;
  const paymentMethod = String(req.body.payment_method ?? "").trim().slice(0, 48) || null;
  const referenceNote = String(req.body.reference_note ?? "").trim().slice(0, 500) || null;
  const expenseDate = startOfDay(parseDateInput(req.body.expense_date, new Date()));
  if (!Number.isFinite(amount) || amount <= 0) {
    res.redirect("/admin/fb/menu?expenseErr=" + encodeURIComponent("Enter a valid amount."));
    return;
  }
  await prisma.fbOperationalExpense.create({
    data: {
      hotelId: hotel.id,
      expenseDate,
      amount,
      category,
      outlet,
      paymentMethod,
      referenceNote,
      createdByUserId: session.staffId
    }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "FB_OPERATIONAL_EXPENSE",
    entityType: "Hotel",
    entityId: hotel.id,
    metadata: { amount, category }
  });
  res.redirect("/admin/fb/menu?expenseSaved=1");
});

adminRouter.get("/bookings/:id/fb-order", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true, displayName: true, currency: true } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { guest: true }
  });
  if (!booking) {
    res.status(404).type("html").send(renderLayout("<h2>Booking</h2><p>Not found.</p>", true));
    return;
  }
  await ensureDefaultFbMenu(hotel.id);
  const menuItems = await prisma.menuItem.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: [{ outletType: "asc" }, { sortOrder: "asc" }, { name: "asc" }]
  });
  const restOpts = menuItems
    .filter((m) => m.outletType === "RESTAURANT")
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${formatMoney(m.unitPrice, hotel.currency)})</option>`)
    .join("");
  const coffeeOpts = menuItems
    .filter((m) => m.outletType === "COFFEE_SHOP")
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${formatMoney(m.unitPrice, hotel.currency)})</option>`)
    .join("");
  const lineRows = Array.from({ length: 8 }, (_, i) => {
    const n = String(i);
    return `<tr>
      <td style="padding:6px"><select name="line_${n}_menuItemId" style="width:100%;padding:6px;border:1px solid #d8dee6;border-radius:8px"><option value="">—</option><optgroup label="Restaurant">${restOpts}</optgroup><optgroup label="Coffee shop">${coffeeOpts}</optgroup></select></td>
      <td style="padding:6px"><input type="number" name="line_${n}_qty" min="1" max="99" value="1" style="width:64px;padding:6px;border:1px solid #d8dee6;border-radius:8px" /></td>
    </tr>`;
  }).join("");
  const err = typeof req.query.error === "string" ? `<p class="badge alert">${escapeHtml(req.query.error.slice(0, 400))}</p>` : "";
  const content = `
<h2>Post F&amp;B charge to folio</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — Booking <strong>${escapeHtml(booking.id)}</strong> · Guest ${escapeHtml(booking.guest.fullName ?? booking.guest.phoneE164)}</p>
${err}
<p class="muted">Charges post to this guest&apos;s booking folio and appear on the invoice PDF (accommodation + F&amp;B total).</p>
<form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/fb-order" style="max-width:720px">
  <input type="hidden" name="bookingId" value="${escapeHtml(booking.id)}" />
  <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px">
    <label>Service
      <select name="serviceMode" required style="padding:8px;border:1px solid #d8dee6;border-radius:8px">
        <option value="ROOM_SERVICE">Room service</option>
        <option value="DINING_IN">Dining in</option>
      </select>
    </label>
  </div>
  <p class="muted" style="margin:0 0 8px;font-size:13px">Outlet is determined from each menu line (restaurant vs coffee shop). Mixed orders create separate tickets per outlet.</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
    <thead><tr><th style="text-align:left">Menu item</th><th>Qty</th></tr></thead>
    <tbody>${lineRows}</tbody>
  </table>
  <label>Notes (kitchen / bar)
    <textarea name="notes" rows="2" style="width:100%;padding:8px;border:1px solid #d8dee6;border-radius:8px"></textarea>
  </label>
  <div class="actions" style="margin-top:12px">
    <button type="submit" style="padding:10px 16px;border:0;border-radius:10px;background:#128c7e;color:#fff;font-weight:700">Post to folio</button>
    <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">Cancel</a>
    <a class="btn-link" href="/admin/fb/menu?bookingId=${encodeURIComponent(booking.id)}">Edit menu prices</a>
  </div>
</form>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/bookings/:id/fb-order", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, hotelId: hotel.id }, select: { id: true, guestId: true } });
  if (!booking) {
    res.redirect("/admin/bookings");
    return;
  }
  const serviceRaw = String(req.body.serviceMode ?? "").toUpperCase();
  const serviceMode = serviceRaw === "DINING_IN" ? FbServiceMode.DINING_IN : FbServiceMode.ROOM_SERVICE;
  const notes = String(req.body.notes ?? "").trim().slice(0, 500);

  const linePairs: { menuItemId: string; qty: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const mid = String(req.body[`line_${i}_menuItemId`] ?? "").trim();
    const qty = clamp(parseIntegerInput(req.body[`line_${i}_qty`], 1), 1, 99);
    if (mid) linePairs.push({ menuItemId: mid, qty });
  }

  const redirectErr = (msg: string) => {
    res.redirect(`/admin/bookings/${encodeURIComponent(bookingId)}/fb-order?error=${encodeURIComponent(msg)}`);
  };

  if (linePairs.length === 0) {
    redirectErr("Add at least one menu line with quantity.");
    return;
  }

  try {
    const outletWarnings = await createFbOrdersFromMenuLines({
      hotelId: hotel.id,
      bookingId: booking.id,
      guestId: booking.guestId,
      serviceMode,
      notes: notes || null,
      lines: linePairs
    });
    await logAudit({
      hotelId: hotel.id,
      action: "FB_ORDER_POSTED_TO_FOLIO",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { serviceMode, outletNotifyWarnings: outletWarnings }
    });
    const warnQ =
      outletWarnings.length > 0 ? `&outletWarn=${encodeURIComponent(outletWarnings.join(" "))}` : "";
    res.redirect(`/admin/bookings/${encodeURIComponent(bookingId)}?fbPosted=1${warnQ}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not post F&B charge.";
    redirectErr(msg);
  }
});

function formatOutletOrderTicketOutletKey(key: string): string {
  switch (key) {
    case "COFFEE_SHOP":
      return "Coffee shop";
    case "RESTAURANT":
      return "Restaurant";
    case "CAFE":
      return "Café";
    case "ROOM_SERVICE":
      return "Room service";
    case "ACTIVITY":
      return "Activity";
    default:
      return key;
  }
}

function outletTicketWhatsappBadgeHtml(t: {
  whatsappNotifyOk: boolean | null;
  whatsappNotifyDetail: string | null;
  whatsappNotifyAt: Date | null;
}): string {
  const when = t.whatsappNotifyAt ? formatDateTime(t.whatsappNotifyAt) : "";
  if (t.whatsappNotifyOk === true) {
    return `<span class="outlet-wa outlet-wa-ok" title="Sent ${escapeHtml(when)}">WhatsApp ✓</span>`;
  }
  if (t.whatsappNotifyOk === false) {
    const d = (t.whatsappNotifyDetail || "Failed or skipped").slice(0, 160);
    return `<span class="outlet-wa outlet-wa-fail" title="${escapeHtml(d)}">WhatsApp ✗</span>`;
  }
  return `<span class="outlet-wa outlet-wa-unk" title="No notify attempt recorded yet">WhatsApp —</span>`;
}

adminRouter.get("/restaurant-ops", requirePermissionAny([{ module: "OUTLET", action: "VIEW" }, { module: "ROOMS", action: "VIEW" }]), async (_req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { displayName: true } });
  const title = hotel?.displayName ?? "Hotel";
  const content = `
<h2>Restaurant &amp; outlet operations</h2>
<p class="muted">${escapeHtml(title)} — Use this checklist with dedicated <strong>OUTLET</strong> permissions (Users page) for cashier / KOT / service staff.</p>
<section style="margin-top:16px;line-height:1.55">
  <h3>Best-practice flow</h3>
  <ol style="margin:0;padding-left:20px">
    <li><strong>KOT / kitchen tickets</strong> — Open <a href="/admin/outlet-dashboard">Outlet board</a> (kanban). Move tickets NEW → PREPARING → READY → DELIVERED. This is your single source of truth for meal execution.</li>
    <li><strong>Orders &amp; billing</strong> — In-stay charges post to the guest folio (<a href="/admin/bookings">Bookings</a> → booking → folio). Walk-ins and direct sales use the F&amp;B menu and cashier paths already in <a href="/admin/fb/menu">Restaurant &amp; Café</a>.</li>
    <li><strong>Payments</strong> — Record payments against the folio or shift close (<a href="/admin/shift-close">Shift close</a>) so cash and card reconcile per shift.</li>
    <li><strong>Handover</strong> — At shift end, ensure open KOT items are either delivered or explicitly cancelled; note variances in the shift report.</li>
  </ol>
  <h3 style="margin-top:18px">Permissions</h3>
  <p class="muted" style="margin:0">Grant <code>OUTLET</code> (View / Edit) for board operators; keep <code>BILLING</code> narrow for finance-only users. Managers typically retain full modules.</p>
  <p style="margin-top:14px"><a class="btn-link primary" href="/admin/outlet-dashboard">Open outlet board</a> · <a class="btn-link" href="/admin/fb/menu">F&amp;B menu</a> · <a class="btn-link" href="/admin/outlet-orders">Table view</a></p>
</section>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/housekeeping", requirePermissionAny([{ module: "HOUSEKEEPING", action: "VIEW" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Housekeeping</h2><p>No hotel data.</p>", true));
    return;
  }
  const session = getSession(req);
  const staffId = session?.staffId ?? "";
  const claimViewRaw = typeof req.query.claimView === "string" ? req.query.claimView.trim().toLowerCase() : "all";
  const claimView: "all" | "unclaimed" | "mine" | "others" = ["all", "unclaimed", "mine", "others"].includes(claimViewRaw)
    ? (claimViewRaw as "all" | "unclaimed" | "mine" | "others")
    : "all";
  const shiftRaw = typeof req.query.shift === "string" ? req.query.shift.trim().toUpperCase() : "ALL";
  const shiftFilter: "ALL" | HousekeepingShiftCode =
    shiftRaw === "MORNING" || shiftRaw === "EVENING" || shiftRaw === "NIGHT" ? shiftRaw : "ALL";
  const priorityRaw = typeof req.query.priority === "string" ? req.query.priority.trim().toUpperCase() : "ALL";
  const priorityFilter: "ALL" | HousekeepingPriorityCode =
    priorityRaw === "CRITICAL" || priorityRaw === "HIGH" || priorityRaw === "MEDIUM" || priorityRaw === "NORMAL" ? priorityRaw : "ALL";
  const exceptionRaw = typeof req.query.exception === "string" ? req.query.exception.trim().toLowerCase() : "";
  const exceptionFilter: "none" | "stalled" | "duesoon" =
    exceptionRaw === "stalled" ? "stalled" : exceptionRaw === "duesoon" || exceptionRaw === "due-soon" ? "duesoon" : "none";
  const statsDate = parseDateInput(req.query.statsDate, startOfDay(new Date()));
  const statsDayStart = startOfDay(statsDate);
  const statsDayEnd = endOfDay(statsDate);
  const defaultPerfTo = endOfDay(new Date());
  const defaultPerfFrom = startOfDay(addDays(new Date(), -30));
  let perfTo = endOfDay(parseDateInput(req.query.perfTo, defaultPerfTo));
  let perfFrom = startOfDay(parseDateInput(req.query.perfFrom, defaultPerfFrom));
  if (perfFrom.getTime() > perfTo.getTime()) {
    perfFrom = startOfDay(addDays(perfTo, -30));
  }

  const activePropertyIdForPerf = await resolveActivePropertyIdForHotel(req, hotel.id);
  const perfPropertyId =
    activePropertyIdForPerf && activePropertyIdForPerf !== allPropertiesKey ? activePropertyIdForPerf : null;
  const staffPerformance = await getHousekeepingStaffPerformance(prisma, {
    hotelId: hotel.id,
    propertyId: perfPropertyId,
    from: perfFrom,
    to: perfTo
  });

  const openTasks = await prisma.housekeepingTask.findMany({
    where: { hotelId: hotel.id, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: 200,
    include: {
      roomUnit: { select: { name: true, roomType: { select: { name: true } } } },
      assignedTo: { select: { fullName: true, email: true } },
      manualAssignedBy: { select: { fullName: true } },
      booking: { select: { id: true, referenceCode: true, checkIn: true, checkOut: true, guest: { select: { isVip: true } } } }
    }
  });

  const roomIds = Array.from(new Set(openTasks.map((t) => t.roomUnitId)));
  const upcomingByRoom = new Map<string, { checkIn: Date; isVip: boolean }>();
  const todayStart = startOfDay(new Date());
  if (roomIds.length > 0) {
    const arrivals = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        roomUnitId: { in: roomIds },
        status: BookingStatus.CONFIRMED,
        checkIn: { gte: startOfDay(new Date()) }
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: { roomUnitId: true, checkIn: true, guest: { select: { isVip: true } } }
    });
    for (const b of arrivals) {
      if (!b.roomUnitId) continue;
      if (!upcomingByRoom.has(b.roomUnitId)) {
        upcomingByRoom.set(b.roomUnitId, { checkIn: b.checkIn, isVip: b.guest.isVip });
      }
    }
  }

  const cleanerWorkloads = await loadHousekeepingCleanerWorkloads(hotel.id);
  const nextAutoCleaner = await pickCleanerForAutoAssign(prisma, hotel.id);
  const suggestedCleanerName = nextAutoCleaner?.fullName;

  const openTaskDecorated = openTasks.map((t) => {
    const shift = parseHousekeepingShift(t.notes) ?? deriveHousekeepingShift(t.startedAt ?? t.createdAt);
    const arrivalHint = t.booking?.checkIn ? { checkIn: t.booking.checkIn, isVip: t.booking.guest?.isVip === true } : upcomingByRoom.get(t.roomUnitId);
    const hasArrivalToday = Boolean(
      arrivalHint && startOfDay(arrivalHint.checkIn).getTime() === todayStart.getTime()
    );
    const ev = evaluateHousekeepingTaskPriority({
      bookingCheckIn: arrivalHint?.checkIn,
      bookingGuestVip: arrivalHint?.isVip === true,
      taskSource: t.source,
      linkedBookingCheckOut: t.booking?.checkOut ?? null,
      hasArrivalToday
    });
    const elapsed = t.startedAt ? housekeepingDurationMinutes(t.startedAt, new Date()) : null;
    return {
      ...t,
      hkShift: shift,
      hkPriority: ev.level,
      hkReason: ev.reason,
      nextArrivalAt: arrivalHint?.checkIn ?? null,
      elapsedMinutes: elapsed
    };
  });

  const recentDone = await prisma.housekeepingTask.findMany({
    where: { hotelId: hotel.id, status: HousekeepingTaskStatus.COMPLETED },
    orderBy: { completedAt: "desc" },
    take: 25,
    include: {
      roomUnit: { select: { name: true, roomType: { select: { name: true } } } },
      assignedTo: { select: { fullName: true } },
      completedBy: { select: { fullName: true, email: true } }
    }
  });

  let alertsHtml = "";
  if (staffId && staffId !== "STAFF-SUPERADMIN") {
    const alerts = await prisma.notification.findMany({
      where: {
        hotelId: hotel.id,
        hotelUserId: staffId,
        readAt: null,
        type: { startsWith: "HK_" }
      },
      orderBy: { createdAt: "desc" },
      take: 40
    });
    if (alerts.length) {
      alertsHtml = `<section style="margin-bottom:18px"><h3>Your housekeeping alerts</h3><ul style="margin:0;padding-left:18px">`;
      for (const n of alerts) {
        alertsHtml += `<li><strong>${escapeHtml(n.title ?? n.type)}</strong> — ${escapeHtml(n.body)} <span class="muted" style="font-size:12px">${formatDateTime(n.createdAt)}</span></li>`;
      }
      alertsHtml += `</ul><form method="post" action="/admin/housekeeping/notifications/read" style="margin-top:8px"><button type="submit" class="btn-link">Mark alerts read</button></form></section>`;
    }
  }

  const canAct =
    session &&
    (hasPermission(session.permissions, "HOUSEKEEPING", "EDIT") || hasPermission(session.permissions, "ROOMS", "EDIT"));
  const canManageAssignments =
    session &&
    (hasPermission(session.permissions, "HOUSEKEEPING", "MANAGE") || hasPermission(session.permissions, "ROOMS", "MANAGE"));

  const filteredOpenTasks = openTaskDecorated.filter((t) => {
    if (!staffId || staffId === "STAFF-SUPERADMIN") {
      if (claimView === "mine" || claimView === "others") return false;
    } else {
      if (claimView === "unclaimed" && t.assignedToUserId) return false;
      if (claimView === "mine" && t.assignedToUserId !== staffId) return false;
      if (claimView === "others" && !(t.assignedToUserId && t.assignedToUserId !== staffId)) return false;
    }
    if (shiftFilter !== "ALL" && t.hkShift !== shiftFilter) return false;
    if (priorityFilter !== "ALL" && t.hkPriority !== priorityFilter) return false;
    if (exceptionFilter === "stalled") {
      if (t.status !== HousekeepingTaskStatus.IN_PROGRESS || !t.startedAt) return false;
      if ((housekeepingDurationMinutes(t.startedAt, new Date()) ?? 0) < HK_SUPERVISOR_STALLED_MINUTES) return false;
    }
    if (exceptionFilter === "duesoon") {
      const nowExc = new Date();
      if (t.assignedToUserId) return false;
      if (!t.nextArrivalAt) return false;
      const arrT = t.nextArrivalAt.getTime();
      const nowT = nowExc.getTime();
      if (arrT <= nowT) return false;
      if (arrT > nowT + HK_SUPERVISOR_DUE_SOON_MS) return false;
    }
    return true;
  });

  const sortedOpenTasks = [...filteredOpenTasks].sort((a, b) => {
    const pr = housekeepingPriorityRank(a.hkPriority) - housekeepingPriorityRank(b.hkPriority);
    if (pr !== 0) return pr;
    const at = a.nextArrivalAt ? a.nextArrivalAt.getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.nextArrivalAt ? b.nextArrivalAt.getTime() : Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const rowHtml = (t: (typeof sortedOpenTasks)[0]) => {
    const rowCleanerOptions = cleanerWorkloads
      .map(
        (w) =>
          `<option value="${escapeHtml(w.id)}" ${t.assignedToUserId === w.id ? "selected" : ""}>${escapeHtml(w.name)}</option>`
      )
      .join("");
    const roomLabel = `${t.roomUnit.name} (${t.roomUnit.roomType.name})`;
    const assigneeName = t.assignedTo ? escapeHtml(t.assignedTo.fullName) : "Unassigned";
    const modeLine = `<div class="muted" style="font-size:11px;margin-top:4px">${escapeHtml(formatHousekeepingAssignmentMode(t.assignmentMode, Boolean(t.assignedToUserId)))}</div>`;
    const adminLine =
      t.manualAssignedBy && t.assignmentMode === HousekeepingAssignmentMode.MANUAL
        ? `<div class="muted" style="font-size:11px;margin-top:2px">Set by ${escapeHtml(t.manualAssignedBy.fullName)}</div>`
        : "";
    const suggestLine =
      !t.assignedToUserId && suggestedCleanerName
        ? `<div class="muted" style="font-size:11px;margin-top:4px">Next auto-assign: ${escapeHtml(suggestedCleanerName)}</div>`
        : "";
    const assignee =
      t.assignedToUserId && staffId && t.assignedToUserId === staffId
        ? `<span class="badge ok">You — ${assigneeName}</span>`
        : t.assignedTo
          ? `<span class="badge pending">${assigneeName}</span>`
          : '<span class="muted">Unassigned</span>';
    const ref = t.booking?.referenceCode ? escapeHtml(t.booking.referenceCode) : "—";
    const claimTime = t.claimedAt ?? t.startedAt;
    const claimedAt =
      claimTime && t.assignmentMode === HousekeepingAssignmentMode.SELF_CLAIMED
        ? `<div class="muted" style="font-size:11px;margin-top:4px">Self-claimed ${escapeHtml(formatDateTime(claimTime))}</div>`
        : t.startedAt
          ? `<div class="muted" style="font-size:11px;margin-top:4px">Started ${escapeHtml(formatDateTime(t.startedAt))}</div>`
          : "";
    const claimBtn =
      canAct && t.status === HousekeepingTaskStatus.PENDING && !t.assignedToUserId
        ? `<form method="post" action="/admin/housekeeping/task/${encodeURIComponent(t.id)}/claim" style="display:inline-flex;gap:6px;align-items:center;margin:0">
            <select name="shift" style="padding:4px 6px;border:1px solid #d8dee6;border-radius:8px">
              <option value="MORNING" ${t.hkShift === "MORNING" ? "selected" : ""}>Morning</option>
              <option value="EVENING" ${t.hkShift === "EVENING" ? "selected" : ""}>Evening</option>
              <option value="NIGHT" ${t.hkShift === "NIGHT" ? "selected" : ""}>Night</option>
            </select>
            <button type="submit" style="padding:4px 10px;border-radius:8px;border:1px solid #d8dee6;background:#fff;cursor:pointer">Claim task</button>
          </form>`
        : "";
    const startBtn =
      canAct &&
      t.status === HousekeepingTaskStatus.PENDING &&
      staffId &&
      t.assignedToUserId === staffId &&
      !t.startedAt
        ? `<form method="post" action="/admin/housekeeping/task/${encodeURIComponent(t.id)}/start" style="display:inline-flex;gap:6px;align-items:center;margin:0 0 0 6px">
            <select name="shift" style="padding:4px 6px;border:1px solid #d8dee6;border-radius:8px">
              <option value="MORNING" ${t.hkShift === "MORNING" ? "selected" : ""}>Morning</option>
              <option value="EVENING" ${t.hkShift === "EVENING" ? "selected" : ""}>Evening</option>
              <option value="NIGHT" ${t.hkShift === "NIGHT" ? "selected" : ""}>Night</option>
            </select>
            <button type="submit" style="padding:4px 10px;border-radius:8px;border:0;background:#0b6e6e;color:#fff;cursor:pointer;font-weight:600">Start cleaning</button>
          </form>`
        : "";
    const doneBtn =
      canAct && (t.status === HousekeepingTaskStatus.PENDING || t.status === HousekeepingTaskStatus.IN_PROGRESS)
        ? `<form method="post" action="/admin/housekeeping/task/${encodeURIComponent(t.id)}/complete" style="display:inline;margin:0 0 0 6px"><input type="hidden" name="targetStatus" value="AVAILABLE" /><button type="submit" style="padding:4px 10px;border-radius:8px;border:0;background:#128c7e;color:#fff;cursor:pointer;font-weight:600">Mark clean (available)</button></form>`
        : "";
    const maintenanceBtn =
      canAct && (t.status === HousekeepingTaskStatus.PENDING || t.status === HousekeepingTaskStatus.IN_PROGRESS)
        ? `<form method="post" action="/admin/housekeeping/task/${encodeURIComponent(t.id)}/complete" style="display:inline;margin:0 0 0 6px"><input type="hidden" name="targetStatus" value="MAINTENANCE" /><button type="submit" style="padding:4px 10px;border-radius:8px;border:0;background:#6b21a8;color:#fff;cursor:pointer;font-weight:600">Mark maintenance</button></form>`
        : "";
    const reassignSelect =
      canManageAssignments && cleanerWorkloads.length
        ? `<form method="post" action="/admin/housekeeping/task/${encodeURIComponent(t.id)}/reassign" style="display:inline;margin:0 0 0 6px">
            <select name="assigneeId" required style="padding:4px 6px;border:1px solid #d8dee6;border-radius:8px;max-width:200px">${rowCleanerOptions}</select>
            <select name="shift" style="padding:4px 6px;border:1px solid #d8dee6;border-radius:8px">
              <option value="MORNING" ${t.hkShift === "MORNING" ? "selected" : ""}>Morning</option>
              <option value="EVENING" ${t.hkShift === "EVENING" ? "selected" : ""}>Evening</option>
              <option value="NIGHT" ${t.hkShift === "NIGHT" ? "selected" : ""}>Night</option>
            </select>
            <button type="submit" style="padding:4px 10px;border-radius:8px;border:1px solid #d8dee6;background:#fff;cursor:pointer">${t.assignedToUserId ? "Reassign" : "Assign cleaner"}</button>
          </form>`
        : "";
    const priorityBadgeColor = t.hkPriority === "CRITICAL" ? "#b91c1c" : t.hkPriority === "HIGH" ? "#dc2626" : t.hkPriority === "MEDIUM" ? "#ca8a04" : "#475569";
    return `<tr>
      <td>${escapeHtml(roomLabel)}</td>
      <td>${escapeHtml(t.status)}</td>
      <td>${escapeHtml(t.source)}</td>
      <td>${assignee}${modeLine}${adminLine}${suggestLine}${claimedAt}<div style="margin-top:4px;font-size:11px;color:#475569">Elapsed: ${escapeHtml(formatDurationMinutes(t.elapsedMinutes))}</div></td>
      <td><span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:${priorityBadgeColor};color:#fff">${t.hkPriority}</span><div class="muted" style="font-size:10px;margin-top:4px;line-height:1.35">${escapeHtml(t.hkReason)}</div></td>
      <td><span class="badge pending">${t.hkShift}</span></td>
      <td>${ref}</td>
      <td style="white-space:nowrap">${claimBtn}${startBtn}${doneBtn}${maintenanceBtn}${reassignSelect}</td>
    </tr>`;
  };

  const doneRows = recentDone
    .map((t) => {
      const roomLabel = `${t.roomUnit.name} (${t.roomUnit.roomType.name})`;
      const by = t.completedBy ? escapeHtml(t.completedBy.fullName) : "—";
      const when = t.completedAt ? formatDateTime(t.completedAt) : "—";
      const shift = parseHousekeepingShift(t.notes) ?? deriveHousekeepingShift(t.completedAt ?? t.createdAt);
      const mins = housekeepingDurationMinutes(t.startedAt, t.completedAt);
      return `<tr><td>${escapeHtml(roomLabel)}</td><td>${by}</td><td>${escapeHtml(shift)}</td><td>${escapeHtml(formatDurationMinutes(mins))}</td><td>${when}</td></tr>`;
    })
    .join("");

  const completedForStats = await prisma.housekeepingTask.findMany({
    where: {
      hotelId: hotel.id,
      status: HousekeepingTaskStatus.COMPLETED,
      completedAt: { gte: statsDayStart, lte: statsDayEnd }
    },
    include: {
      completedBy: { select: { fullName: true, email: true } }
    }
  });
  const cleanerStats = new Map<string, { cleaner: string; cleaned: number; totalMins: number; withDuration: number; shifts: Record<HousekeepingShiftCode, number> }>();
  for (const t of completedForStats) {
    const key = t.completedByUserId ?? "unknown";
    const cleaner = t.completedBy?.fullName ?? "Unassigned/Unknown";
    if (!cleanerStats.has(key)) {
      cleanerStats.set(key, {
        cleaner,
        cleaned: 0,
        totalMins: 0,
        withDuration: 0,
        shifts: { MORNING: 0, EVENING: 0, NIGHT: 0 }
      });
    }
    const row = cleanerStats.get(key)!;
    row.cleaned += 1;
    const mins = housekeepingDurationMinutes(t.startedAt, t.completedAt);
    if (mins !== null) {
      row.totalMins += mins;
      row.withDuration += 1;
    }
    const shift = parseHousekeepingShift(t.notes) ?? deriveHousekeepingShift(t.completedAt ?? t.createdAt);
    row.shifts[shift] += 1;
  }
  const cleanerStatsRows = Array.from(cleanerStats.values())
    .sort((a, b) => b.cleaned - a.cleaned)
    .map((s) => {
      const avg = s.withDuration > 0 ? Math.round(s.totalMins / s.withDuration) : null;
      return `<tr><td>${escapeHtml(s.cleaner)}</td><td>${s.cleaned}</td><td>${escapeHtml(formatDurationMinutes(avg))}</td><td>${s.shifts.MORNING}/${s.shifts.EVENING}/${s.shifts.NIGHT}</td></tr>`;
    })
    .join("");
  const completedDurations = completedForStats.map((t) => housekeepingDurationMinutes(t.startedAt, t.completedAt)).filter((x): x is number => x !== null);
  const completedAvg = completedDurations.length ? Math.round(completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length) : null;
  const inProgressCount = openTaskDecorated.filter((t) => t.status === HousekeepingTaskStatus.IN_PROGRESS).length;
  const unclaimedCritical = openTaskDecorated.filter(
    (t) => !t.assignedToUserId && t.hkPriority === "CRITICAL"
  ).length;
  const unclaimedHigh = openTaskDecorated.filter((t) => !t.assignedToUserId && t.hkPriority === "HIGH").length;
  const byPriorityCounts = {
    CRITICAL: openTaskDecorated.filter((t) => t.hkPriority === "CRITICAL").length,
    HIGH: openTaskDecorated.filter((t) => t.hkPriority === "HIGH").length,
    MEDIUM: openTaskDecorated.filter((t) => t.hkPriority === "MEDIUM").length,
    NORMAL: openTaskDecorated.filter((t) => t.hkPriority === "NORMAL").length
  };
  const hkDashQuery = {
    claimView,
    shift: shiftFilter,
    priority: priorityFilter,
    exception: exceptionFilter,
    statsDate: formatDateForInput(statsDate),
    perfFrom: formatDateForInput(perfFrom),
    perfTo: formatDateForInput(perfTo)
  };
  const nowSupervisor = new Date();
  const stalledCleaningCount = openTaskDecorated.filter(
    (t) =>
      t.status === HousekeepingTaskStatus.IN_PROGRESS &&
      t.startedAt &&
      (housekeepingDurationMinutes(t.startedAt, nowSupervisor) ?? 0) >= HK_SUPERVISOR_STALLED_MINUTES
  ).length;
  const dueSoonUnclaimedCount = openTaskDecorated.filter((t) => {
    if (t.assignedToUserId) return false;
    if (!t.nextArrivalAt) return false;
    const arrT = t.nextArrivalAt.getTime();
    const nowT = nowSupervisor.getTime();
    if (arrT <= nowT) return false;
    if (arrT > nowT + HK_SUPERVISOR_DUE_SOON_MS) return false;
    return true;
  }).length;
  const workloadRows = cleanerWorkloads
    .slice(0, 12)
    .map((w) => `<tr><td>${escapeHtml(w.name)}</td><td>${w.active}</td></tr>`)
    .join("");

  const staffPerformanceRows = staffPerformance
    .map((r) => {
      const sec = r.secondaryLabel
        ? ` <span class="muted" style="font-size:11px">(${escapeHtml(r.secondaryLabel)})</span>`
        : "";
      const avg =
        r.averageCompletionMinutes != null ? escapeHtml(formatDurationMinutes(r.averageCompletionMinutes)) : "—";
      const rate =
        r.completionRate != null && r.assignedCount > 0
          ? `${Math.round(Math.min(1, r.completionRate) * 100)}%`
          : "—";
      const kpiCell = r.kpiScore != null ? String(r.kpiScore) : "—";
      const speedCell = r.speedScore != null ? String(r.speedScore) : "—";
      const relCell = r.reliabilityScore != null ? `${r.reliabilityScore}%` : "—";
      const wlCell = r.workloadBalanceScore != null ? String(r.workloadBalanceScore) : "—";
      const topRow =
        r.rank <= 3
          ? ' style="background:#f6faf9"'
          : "";
      return `<tr${topRow}>
      <td style="font-weight:600">${r.rank}</td>
      <td>${escapeHtml(r.displayName)}${sec}</td>
      <td>${kpiCell}</td>
      <td title="Relative speed score (lower avg clean time scores higher within this table)">${speedCell}</td>
      <td>${relCell}</td>
      <td title="Relative contribution score (completed in period + active queue)">${wlCell}</td>
      <td>${r.activeWorkload}</td>
      <td>${r.assignedCount}</td>
      <td>${r.claimedCount}</td>
      <td>${r.selfClaimedCount}</td>
      <td>${r.manualAssignedCount}</td>
      <td>${r.inProgressCount}</td>
      <td>${r.completedCount}</td>
      <td>${rate}</td>
      <td>${avg}</td>
    </tr>`;
    })
    .join("");

  const content = `
<h2>Housekeeping</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — Tasks are created when a room is set to <strong>CLEANING</strong> (checkout or room board). Assign cleaners, then mark <strong>clean</strong> to set the room to <strong>AVAILABLE</strong>. Actions are logged with staff identity.</p>
<p class="muted" style="font-size:13px">Grant <strong>HOUSEKEEPING</strong> (View/Edit) in <a href="/admin/users">Users</a> for housekeeping-only accounts. Front desk typically uses <strong>ROOMS</strong> Edit.</p>
${alertsHtml}
<section style="margin-bottom:14px">
  <form method="get" action="/admin/housekeeping" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input type="hidden" name="statsDate" value="${formatDateForInput(statsDate)}" />
    <input type="hidden" name="perfFrom" value="${formatDateForInput(perfFrom)}" />
    <input type="hidden" name="perfTo" value="${formatDateForInput(perfTo)}" />
    <span class="muted" style="font-size:12px">Task view</span>
    <select name="claimView" onchange="this.form.submit()" style="padding:8px;border:1px solid #d8dee6;border-radius:8px">
      <option value="all" ${claimView === "all" ? "selected" : ""}>All open rooms</option>
      <option value="unclaimed" ${claimView === "unclaimed" ? "selected" : ""}>Unclaimed only</option>
      <option value="mine" ${claimView === "mine" ? "selected" : ""}>My claimed rooms</option>
      <option value="others" ${claimView === "others" ? "selected" : ""}>Claimed by others</option>
    </select>
    <select name="shift" onchange="this.form.submit()" style="padding:8px;border:1px solid #d8dee6;border-radius:8px">
      <option value="ALL" ${shiftFilter === "ALL" ? "selected" : ""}>All shifts</option>
      <option value="MORNING" ${shiftFilter === "MORNING" ? "selected" : ""}>Morning</option>
      <option value="EVENING" ${shiftFilter === "EVENING" ? "selected" : ""}>Evening</option>
      <option value="NIGHT" ${shiftFilter === "NIGHT" ? "selected" : ""}>Night</option>
    </select>
    <select name="priority" onchange="this.form.submit()" style="padding:8px;border:1px solid #d8dee6;border-radius:8px">
      <option value="ALL" ${priorityFilter === "ALL" ? "selected" : ""}>All priorities</option>
      <option value="CRITICAL" ${priorityFilter === "CRITICAL" ? "selected" : ""}>Critical</option>
      <option value="HIGH" ${priorityFilter === "HIGH" ? "selected" : ""}>High</option>
      <option value="MEDIUM" ${priorityFilter === "MEDIUM" ? "selected" : ""}>Medium</option>
      <option value="NORMAL" ${priorityFilter === "NORMAL" ? "selected" : ""}>Normal</option>
    </select>
    <select name="exception" onchange="this.form.submit()" style="padding:8px;border:1px solid #d8dee6;border-radius:8px" title="Supervisor exception views">
      <option value="" ${exceptionFilter === "none" ? "selected" : ""}>No exception filter</option>
      <option value="stalled" ${exceptionFilter === "stalled" ? "selected" : ""}>Stalled cleans (≥${HK_SUPERVISOR_STALLED_MINUTES} min)</option>
      <option value="duesoon" ${exceptionFilter === "duesoon" ? "selected" : ""}>Arrival due soon (unclaimed, 4h)</option>
    </select>
    <span class="muted" style="font-size:12px">${filteredOpenTasks.length} task(s)</span>
  </form>
</section>
<section style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px">
  <article class="stat"><h3>Open tasks</h3><p>${openTaskDecorated.length}</p></article>
  <article class="stat"><h3>In progress</h3><p>${inProgressCount}</p></article>
  <article class="stat"><h3>Unclaimed critical</h3><p>${unclaimedCritical}</p></article>
  <article class="stat"><h3>Unclaimed high</h3><p>${unclaimedHigh}</p></article>
  <article class="stat"><h3>Completed (${formatDateForInput(statsDate)})</h3><p>${completedForStats.length}</p></article>
  <article class="stat"><h3>Avg clean time</h3><p>${escapeHtml(formatDurationMinutes(completedAvg))}</p></article>
</section>
<section style="margin-bottom:14px;border:1px solid #fecdd3;background:#fffafb;border-radius:12px;padding:12px">
  <h3 style="margin:0 0 6px;font-size:15px">Supervisor exceptions</h3>
  <p class="muted" style="margin:0 0 10px;font-size:12px">Risk-focused shortcuts: urgent unclaimed work, in-progress cleans past <strong>${HK_SUPERVISOR_STALLED_MINUTES} minutes</strong>, and unclaimed rooms with a guest arrival in the next <strong>4 hours</strong>.</p>
  <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.55">
    <li><strong>${unclaimedCritical}</strong> critical + <strong>${unclaimedHigh}</strong> high still unclaimed —
      <a href="${escapeHtml(housekeepingDashboardHref(hkDashQuery, { claimView: "unclaimed", priority: "CRITICAL", exception: "none" }))}">Critical queue</a>,
      <a href="${escapeHtml(housekeepingDashboardHref(hkDashQuery, { claimView: "unclaimed", priority: "HIGH", exception: "none" }))}">High queue</a>,
      <a href="${escapeHtml(housekeepingDashboardHref(hkDashQuery, { claimView: "unclaimed", priority: "ALL", exception: "none" }))}">All unclaimed</a>
    </li>
    <li><strong>${stalledCleaningCount}</strong> in progress over ${HK_SUPERVISOR_STALLED_MINUTES} min —
      <a href="${escapeHtml(housekeepingDashboardHref(hkDashQuery, { claimView: "all", priority: "ALL", exception: "stalled" }))}">View stalled</a>
    </li>
    <li><strong>${dueSoonUnclaimedCount}</strong> unclaimed with next arrival within 4h —
      <a href="${escapeHtml(housekeepingDashboardHref(hkDashQuery, { claimView: "all", priority: "ALL", exception: "duesoon" }))}">View due soon</a>
    </li>
  </ul>
</section>
<section style="margin-bottom:16px">
  <p class="muted" style="margin:0">Priority queue: Critical ${byPriorityCounts.CRITICAL} · High ${byPriorityCounts.HIGH} · Medium ${byPriorityCounts.MEDIUM} · Normal ${byPriorityCounts.NORMAL}. Open list is sorted by urgency, then next arrival.</p>
</section>
<section style="margin-bottom:18px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
  <div style="border:1px solid #d8dee6;border-radius:12px;padding:12px;background:#fff">
    <h3 style="margin:0 0 8px;font-size:15px">Cleaner workload (active queue)</h3>
    <p class="muted" style="font-size:12px;margin:0 0 8px">HOUSEKEEPING-role users only. Counts PENDING + IN_PROGRESS assigned to each cleaner (fair rotation for auto-assign).</p>
    <div style="overflow:auto;max-height:220px">
      <table class="data-table" style="min-width:200px;font-size:13px">
        <thead><tr><th>Cleaner</th><th>Active</th></tr></thead>
        <tbody>${workloadRows || '<tr><td colspan="2" class="muted">No housekeeping-role users.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</section>
<section style="margin-bottom:18px">
  <h3 style="margin:0 0 8px;font-size:15px">Staff performance</h3>
  <p class="muted" style="font-size:12px;margin:0 0 10px">${escapeHtml(formatDateForInput(perfFrom))} – ${escapeHtml(formatDateForInput(perfTo))} · Period metrics from tasks; <strong>Active</strong> / <strong>In progress</strong> are current queue. Respects active property scope when set.</p>
  <form method="get" action="/admin/housekeeping" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
    <input type="hidden" name="claimView" value="${claimView}" />
    <input type="hidden" name="shift" value="${shiftFilter}" />
    <input type="hidden" name="priority" value="${priorityFilter}" />
    <input type="hidden" name="statsDate" value="${formatDateForInput(statsDate)}" />
    ${exceptionFilter !== "none" ? `<input type="hidden" name="exception" value="${exceptionFilter === "stalled" ? "stalled" : "duesoon"}" />` : ""}
    <label class="muted" style="font-size:12px">From</label>
    <input type="date" name="perfFrom" value="${formatDateForInput(perfFrom)}" style="padding:8px;border:1px solid #d8dee6;border-radius:8px" />
    <label class="muted" style="font-size:12px">To</label>
    <input type="date" name="perfTo" value="${formatDateForInput(perfTo)}" style="padding:8px;border:1px solid #d8dee6;border-radius:8px" />
    <button type="submit" style="padding:8px 12px;border:1px solid #d8dee6;border-radius:8px;background:#fff;cursor:pointer;font-weight:600">Apply range</button>
  </form>
  <div style="overflow:auto">
  <table class="data-table" style="min-width:1120px;font-size:13px">
    <thead><tr>
      <th>Rank</th>
      <th>Staff</th>
      <th>KPI score</th>
      <th>Speed</th>
      <th>Reliability</th>
      <th>Workload</th>
      <th>Active</th>
      <th>Assigned</th>
      <th>Claimed</th>
      <th>Self-claimed</th>
      <th>Manual</th>
      <th>In progress</th>
      <th>Completed</th>
      <th>Completion rate</th>
      <th>Avg clean</th>
    </tr></thead>
    <tbody>${staffPerformanceRows || '<tr><td colspan="15" class="muted">No housekeeping staff or no rows in range.</td></tr>'}</tbody>
  </table>
  </div>
  <p class="muted" style="font-size:12px;margin:10px 0 0">KPI score is an internal operational indicator based on completion reliability, speed, and workload contribution.</p>
</section>
<section>
  <h3>Open tasks</h3>
  <div style="overflow:auto">
  <table class="data-table" style="min-width:720px">
    <thead><tr><th>Room</th><th>Status</th><th>Source</th><th>Assigned</th><th>Priority</th><th>Shift</th><th>Booking ref</th><th></th></tr></thead>
    <tbody>${sortedOpenTasks.length ? sortedOpenTasks.map(rowHtml).join("") : '<tr><td colspan="8" class="muted">No open housekeeping tasks in this view.</td></tr>'}</tbody>
  </table>
  </div>
</section>
<section style="margin-top:22px">
  <h3>Recently completed</h3>
  <div style="overflow:auto">
  <table class="data-table" style="min-width:520px">
    <thead><tr><th>Room</th><th>Completed by</th><th>Shift</th><th>Duration</th><th>When</th></tr></thead>
    <tbody>${doneRows || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}</tbody>
  </table>
  </div>
</section>
<section style="margin-top:22px">
  <h3>Productivity by cleaner (${formatDateForInput(statsDate)})</h3>
  <form method="get" action="/admin/housekeeping" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
    <input type="hidden" name="claimView" value="${claimView}" />
    <input type="hidden" name="shift" value="${shiftFilter}" />
    <input type="hidden" name="priority" value="${priorityFilter}" />
    <input type="hidden" name="perfFrom" value="${formatDateForInput(perfFrom)}" />
    <input type="hidden" name="perfTo" value="${formatDateForInput(perfTo)}" />
    ${exceptionFilter !== "none" ? `<input type="hidden" name="exception" value="${exceptionFilter === "stalled" ? "stalled" : "duesoon"}" />` : ""}
    <label class="muted" style="font-size:12px">Stats date</label>
    <input type="date" name="statsDate" value="${formatDateForInput(statsDate)}" onchange="this.form.submit()" style="padding:8px;border:1px solid #d8dee6;border-radius:8px" />
  </form>
  <div style="overflow:auto">
  <table class="data-table" style="min-width:580px">
    <thead><tr><th>Cleaner</th><th>Rooms cleaned</th><th>Avg cleaning time</th><th>Shift split (M/E/N)</th></tr></thead>
    <tbody>${cleanerStatsRows || '<tr><td colspan="4" class="muted">No completed tasks for selected date.</td></tr>'}</tbody>
  </table>
  </div>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/housekeeping/notifications/read", requirePermissionAny([{ module: "HOUSEKEEPING", action: "VIEW" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  if (!hotel || !session || session.staffId === "STAFF-SUPERADMIN") {
    res.redirect("/admin/housekeeping");
    return;
  }
  await prisma.notification.updateMany({
    where: {
      hotelId: hotel.id,
      hotelUserId: session.staffId,
      readAt: null,
      type: { startsWith: "HK_" }
    },
    data: { readAt: new Date(), status: NotificationStatus.READ }
  });
  res.redirect("/admin/housekeeping");
});

adminRouter.post("/housekeeping/task/:taskId/claim", requirePermissionAny([{ module: "HOUSEKEEPING", action: "EDIT" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  const taskId = String(req.params.taskId ?? "");
  const shift = parseHousekeepingShiftInput(req.body.shift);
  if (!hotel || !session || session.staffId === "STAFF-SUPERADMIN") {
    res.redirect("/admin/housekeeping");
    return;
  }
  const task = await prisma.housekeepingTask.findFirst({
    where: { id: taskId, hotelId: hotel.id, status: HousekeepingTaskStatus.PENDING }
  });
  if (!task) {
    res.redirect("/admin/housekeeping");
    return;
  }
  const now = new Date();
  const claim = await prisma.housekeepingTask.updateMany({
    where: {
      id: task.id,
      hotelId: hotel.id,
      status: HousekeepingTaskStatus.PENDING,
      assignedToUserId: null
    },
    data: {
      status: HousekeepingTaskStatus.IN_PROGRESS,
      assignedToUserId: session.staffId,
      startedAt: now,
      assignmentMode: HousekeepingAssignmentMode.SELF_CLAIMED,
      claimedAt: now,
      manualAssignedByUserId: null
    }
  });
  if (claim.count === 0) {
    await logAudit({
      hotelId: hotel.id,
      action: "HOUSEKEEPING_TASK_CLAIM_BLOCKED",
      entityType: "HousekeepingTask",
      entityId: task.id,
      metadata: { roomUnitId: task.roomUnitId, blockedForUserId: session.staffId }
    });
    res.redirect("/admin/housekeeping?claimView=unclaimed");
    return;
  }
  await prisma.roomUnit.update({
    where: { id: task.roomUnitId },
    data: { notes: writeManualRoomStatusToNotes((await prisma.roomUnit.findUnique({ where: { id: task.roomUnitId }, select: { notes: true } }))?.notes, "CLEANING") }
  });
  const refreshed = await prisma.housekeepingTask.findUnique({ where: { id: task.id }, select: { notes: true } });
  await prisma.housekeepingTask.update({
    where: { id: task.id },
    data: { notes: writeHousekeepingShift(refreshed?.notes, shift) }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "HOUSEKEEPING_TASK_CLAIMED",
    entityType: "HousekeepingTask",
    entityId: task.id,
    metadata: { roomUnitId: task.roomUnitId, assignedToUserId: session.staffId, shift }
  });
  await createNotification({
    hotelId: hotel.id,
    userId: session.staffId,
    title: "Housekeeping task claimed",
    body: "You claimed a room cleaning task.",
    category: "housekeeping",
    severity: "high",
    link: "/admin/housekeeping",
    sourceType: "HOUSEKEEPING_TASK_CLAIMED",
    sourceId: task.id,
    requiresAttention: true
  }).catch(() => undefined);
  res.redirect("/admin/housekeeping");
});

adminRouter.post("/housekeeping/task/:taskId/start", requirePermissionAny([{ module: "HOUSEKEEPING", action: "EDIT" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  const taskId = String(req.params.taskId ?? "");
  const shift = parseHousekeepingShiftInput(req.body.shift);
  if (!hotel || !session || session.staffId === "STAFF-SUPERADMIN") {
    res.redirect("/admin/housekeeping");
    return;
  }
  const task = await prisma.housekeepingTask.findFirst({
    where: {
      id: taskId,
      hotelId: hotel.id,
      status: HousekeepingTaskStatus.PENDING,
      assignedToUserId: session.staffId,
      startedAt: null
    }
  });
  if (!task) {
    res.redirect("/admin/housekeeping");
    return;
  }
  const upd = await prisma.housekeepingTask.updateMany({
    where: {
      id: task.id,
      hotelId: hotel.id,
      status: HousekeepingTaskStatus.PENDING,
      assignedToUserId: session.staffId,
      startedAt: null
    },
    data: { status: HousekeepingTaskStatus.IN_PROGRESS, startedAt: new Date() }
  });
  if (upd.count === 0) {
    res.redirect("/admin/housekeeping");
    return;
  }
  await prisma.roomUnit.update({
    where: { id: task.roomUnitId },
    data: {
      notes: writeManualRoomStatusToNotes((await prisma.roomUnit.findUnique({ where: { id: task.roomUnitId }, select: { notes: true } }))?.notes, "CLEANING")
    }
  });
  const refreshed = await prisma.housekeepingTask.findUnique({ where: { id: task.id }, select: { notes: true } });
  await prisma.housekeepingTask.update({
    where: { id: task.id },
    data: { notes: writeHousekeepingShift(refreshed?.notes, shift) }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "HOUSEKEEPING_TASK_STARTED",
    entityType: "HousekeepingTask",
    entityId: task.id,
    metadata: { roomUnitId: task.roomUnitId, startedByUserId: session.staffId, shift, portal: "housekeeping-dashboard" }
  });
  res.redirect("/admin/housekeeping");
});

adminRouter.post("/housekeeping/task/:taskId/reassign", requirePermissionAny([{ module: "HOUSEKEEPING", action: "MANAGE" }, { module: "ROOMS", action: "MANAGE" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  const taskId = String(req.params.taskId ?? "");
  const assigneeId = String((req.body as { assigneeId?: unknown }).assigneeId ?? "").trim();
  const assigneeEmail = String((req.body as { assigneeEmail?: unknown }).assigneeEmail ?? "").trim().toLowerCase();
  const shift = parseHousekeepingShiftInput(req.body.shift);
  if (!hotel || !session) {
    res.redirect("/admin/housekeeping");
    return;
  }
  const task = await prisma.housekeepingTask.findFirst({
    where: { id: taskId, hotelId: hotel.id, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
    select: { id: true, roomUnitId: true, assignedToUserId: true }
  });
  if (!task) {
    res.redirect("/admin/housekeeping");
    return;
  }
  let assignee =
    assigneeId.length > 0
      ? await prisma.hotelUser.findFirst({
          where: { id: assigneeId, hotelId: hotel.id, isActive: true, role: UserRole.HOUSEKEEPING },
          select: { id: true, fullName: true, email: true }
        })
      : null;
  if (!assignee && assigneeEmail) {
    assignee = await prisma.hotelUser.findFirst({
      where: { hotelId: hotel.id, email: assigneeEmail, isActive: true, role: UserRole.HOUSEKEEPING },
      select: { id: true, fullName: true, email: true }
    });
  }
  if (!assignee) {
    res.redirect("/admin/housekeeping");
    return;
  }
  await prisma.housekeepingTask.update({
    where: { id: task.id },
    data: {
      assignedToUserId: assignee.id,
      status: HousekeepingTaskStatus.IN_PROGRESS,
      startedAt: task.assignedToUserId ? undefined : new Date(),
      assignmentMode: HousekeepingAssignmentMode.MANUAL,
      manualAssignedByUserId: hotelUserIdForPrismaFk(session.staffId),
      claimedAt: null,
      notes: writeHousekeepingShift((await prisma.housekeepingTask.findUnique({ where: { id: task.id }, select: { notes: true } }))?.notes, shift)
    }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "HOUSEKEEPING_TASK_REASSIGNED",
    entityType: "HousekeepingTask",
    entityId: task.id,
    metadata: {
      roomUnitId: task.roomUnitId,
      assignedToUserId: assignee.id,
      assignedToEmail: assignee.email,
      reassignedByUserId: session.staffId,
      assignmentMode: "MANUAL",
      shift
    }
  });
  await createNotification({
    hotelId: hotel.id,
    userId: assignee.id,
    title: "Task reassigned to you",
    body: `${assignee.fullName}, a housekeeping task has been assigned/reassigned to you.`,
    category: "housekeeping",
    severity: "high",
    link: "/admin/housekeeping",
    sourceType: "HOUSEKEEPING_TASK_REASSIGNED",
    sourceId: task.id,
    requiresAttention: true
  }).catch(() => undefined);
  res.redirect("/admin/housekeeping");
});

adminRouter.post("/housekeeping/task/:taskId/complete", requirePermissionAny([{ module: "HOUSEKEEPING", action: "EDIT" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  const session = getSession(req);
  const taskId = String(req.params.taskId ?? "");
  const targetStatusRaw = String(req.body.targetStatus ?? "AVAILABLE").trim().toUpperCase();
  const targetStatus: RoomBoardStatus = targetStatusRaw === "MAINTENANCE" ? "MAINTENANCE" : "AVAILABLE";
  if (!hotel || !session) {
    res.redirect("/admin/housekeeping");
    return;
  }
  const task = await prisma.housekeepingTask.findFirst({
    where: {
      id: taskId,
      hotelId: hotel.id,
      status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
    },
    include: { roomUnit: { select: { notes: true } } }
  });
  if (!task) {
    res.redirect("/admin/housekeeping");
    return;
  }
  if (task.assignedToUserId && session.staffId !== task.assignedToUserId) {
    const canOverride =
      hasPermission(session.permissions, "HOUSEKEEPING", "MANAGE") ||
      hasPermission(session.permissions, "ROOMS", "MANAGE");
    if (!canOverride) {
      res.redirect("/admin/housekeeping");
      return;
    }
  }
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.roomUnit.findUnique({ where: { id: task.roomUnitId }, select: { notes: true } });
    await tx.roomUnit.update({
      where: { id: task.roomUnitId },
      data: { notes: writeManualRoomStatusToNotes(fresh?.notes, targetStatus) }
    });
    await tx.housekeepingTask.update({
      where: { id: task.id },
      data: {
        status: HousekeepingTaskStatus.COMPLETED,
        completedAt: new Date(),
        completedByUserId: session.staffId !== "STAFF-SUPERADMIN" ? session.staffId : null
      }
    });
  });
  const completed = await prisma.housekeepingTask.findUnique({
    where: { id: task.id },
    select: { startedAt: true, completedAt: true, notes: true }
  });
  const shift = parseHousekeepingShift(completed?.notes ?? task.notes) ?? deriveHousekeepingShift(new Date());
  const durationMins = housekeepingDurationMinutes(completed?.startedAt, completed?.completedAt);
  await logAudit({
    hotelId: hotel.id,
    action: "HOUSEKEEPING_TASK_COMPLETED",
    entityType: "HousekeepingTask",
    entityId: task.id,
    bookingId: task.bookingId ?? undefined,
    metadata: { roomUnitId: task.roomUnitId, completedByUserId: session.staffId, targetStatus, shift, durationMinutes: durationMins }
  });
  res.redirect("/admin/housekeeping");
});

adminRouter.get("/outlet-dashboard", requirePermissionAny([{ module: "OUTLET", action: "VIEW" }, { module: "ROOMS", action: "VIEW" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Outlet board</h2><p>No hotel data.</p>", true));
    return;
  }
  let dateFrom = String(req.query.dateFrom ?? "").trim();
  let dateTo = String(req.query.dateTo ?? "").trim();
  if (!dateFrom && !dateTo) {
    const today = startOfDay(new Date());
    dateTo = formatDateForInput(today);
    dateFrom = formatDateForInput(addDays(today, -7));
  }
  const outletQ = String(req.query.outlet ?? "all").trim();
  const serviceQ = String(req.query.service ?? "all").trim();
  const where: Prisma.OutletOrderTicketWhereInput = { hotelId: hotel.id };
  if (outletQ && outletQ !== "all") where.outletKey = outletQ;
  if (serviceQ === "ROOM_SERVICE") where.serviceMode = FbServiceMode.ROOM_SERVICE;
  else if (serviceQ === "DINING_IN") where.serviceMode = FbServiceMode.DINING_IN;
  else if (serviceQ === "folio_desk") where.source = OutletTicketSource.FOLIO_CHARGE;

  const createdFilter: Prisma.DateTimeFilter = {};
  if (dateFrom) createdFilter.gte = startOfDay(parseDateInput(dateFrom, startOfDay(new Date())));
  if (dateTo) createdFilter.lte = endOfDay(parseDateInput(dateTo, startOfDay(new Date())));
  if (Object.keys(createdFilter).length > 0) where.createdAt = createdFilter;

  const tickets = await prisma.outletOrderTicket.findMany({
    where,
    include: {
      booking: { include: { guest: true, roomUnit: { include: { roomType: true } } } },
      fbOrder: { include: { lines: { orderBy: { id: "asc" } } } },
      folioTransaction: true
    },
    orderBy: { createdAt: "desc" },
    take: 400
  });

  const statusOrder: OutletTicketStatus[] = [
    OutletTicketStatus.NEW,
    OutletTicketStatus.ACKNOWLEDGED,
    OutletTicketStatus.PREPARING,
    OutletTicketStatus.READY,
    OutletTicketStatus.DELIVERED,
    OutletTicketStatus.CANCELLED
  ];
  const byStatus = new Map<OutletTicketStatus, typeof tickets>();
  for (const s of statusOrder) byStatus.set(s, []);
  for (const t of tickets) {
    const bucket = byStatus.get(t.ticketStatus);
    if (bucket) bucket.push(t);
  }

  const renderCard = (t: (typeof tickets)[number]): string => {
    const ref = displayBookingReference(t.booking);
    const guest = t.booking.guest.fullName?.trim() || t.booking.guest.phoneE164 || "—";
    const unit =
      t.booking.roomUnit?.name && t.booking.roomUnit.roomType?.name
        ? `${t.booking.roomUnit.name} (${t.booking.roomUnit.roomType.name})`
        : t.booking.roomUnit?.name || "—";
    let items = "—";
    if (t.fbOrder?.lines?.length) {
      items = t.fbOrder.lines
        .map((l) => `${l.quantity}× ${l.itemNameSnap} (${formatMoney(l.lineTotal, hotel.currency)})`)
        .join(" · ");
    } else if (t.folioTransaction) {
      const ft = t.folioTransaction;
      items = `${ft.quantity}× ${ft.itemName} (${formatMoney(ft.netAmount, ft.currency || hotel.currency)})`;
    }
    const modeLabel =
      t.serviceMode === FbServiceMode.ROOM_SERVICE
        ? "Room service"
        : t.serviceMode === FbServiceMode.DINING_IN
          ? "Dining in"
          : t.source === OutletTicketSource.FOLIO_CHARGE
            ? "Desk folio"
            : "—";
    const isNew = t.ticketStatus === OutletTicketStatus.NEW;
    const statusOptions = (Object.values(OutletTicketStatus) as string[])
      .map(
        (s) =>
          `<option value="${escapeHtml(s)}"${t.ticketStatus === s ? " selected" : ""}>${escapeHtml(s)}</option>`
      )
      .join("");
    return `<article class="outlet-board-card${isNew ? " outlet-board-card--new" : ""}">
      <div class="outlet-board-card-head">
        <strong>${escapeHtml(formatOutletOrderTicketOutletKey(t.outletKey))}</strong>
        ${outletTicketWhatsappBadgeHtml(t)}
      </div>
      <p class="outlet-board-card-ref"><code>${escapeHtml(ref)}</code> · <a class="inline-link" href="/admin/bookings/${encodeURIComponent(t.bookingId)}">Booking</a></p>
      <p class="outlet-board-card-meta"><strong>${escapeHtml(guest)}</strong><br/><span class="muted">${escapeHtml(unit)}</span></p>
      <p class="outlet-board-card-items">${escapeHtml(items)}</p>
      ${t.notes ? `<p class="outlet-board-card-notes"><em>${escapeHtml(t.notes)}</em></p>` : ""}
      <p class="outlet-board-card-foot muted">${escapeHtml(modeLabel)} · ${formatDateTime(t.createdAt)}</p>
      <form method="post" action="/admin/outlet-orders/${encodeURIComponent(t.id)}/status" class="outlet-board-card-form">
        <input type="hidden" name="redirectTo" value="dashboard" />
        <input type="hidden" name="outlet" value="${escapeHtml(outletQ)}" />
        <input type="hidden" name="statusFilter" value="all" />
        <input type="hidden" name="service" value="${escapeHtml(serviceQ)}" />
        <input type="hidden" name="dateFrom" value="${escapeHtml(dateFrom)}" />
        <input type="hidden" name="dateTo" value="${escapeHtml(dateTo)}" />
        <label class="outlet-board-card-status-label"><span class="muted">Move to</span>
          <select name="ticketStatus">${statusOptions}</select>
        </label>
        <button type="submit" class="outlet-board-save">Update</button>
      </form>
    </article>`;
  };

  const columnsHtml = statusOrder
    .map((st) => {
      const list = byStatus.get(st) ?? [];
      const cards = list.map((t) => renderCard(t)).join("") || `<p class="muted outlet-board-empty">None</p>`;
      return `<section class="outlet-board-col" data-status="${escapeHtml(st)}">
        <header class="outlet-board-col-head">
          <h3>${escapeHtml(st)}</h3>
          <span class="outlet-board-count">${list.length}</span>
        </header>
        <div class="outlet-board-col-body">${cards}</div>
      </section>`;
    })
    .join("");

  const outletFilterHtml = [
    ["all", "All outlets"],
    ["RESTAURANT", "Restaurant"],
    ["COFFEE_SHOP", "Coffee shop"],
    ["CAFE", "Café (folio)"],
    ["ROOM_SERVICE", "Room service"],
    ["ACTIVITY", "Activity"]
  ]
    .map(
      ([v, lab]) =>
        `<option value="${escapeHtml(v)}"${outletQ === v ? " selected" : ""}>${escapeHtml(lab)}</option>`
    )
    .join("");

  const serviceFilterHtml = [
    ["all", "All service types"],
    ["ROOM_SERVICE", "Room service"],
    ["DINING_IN", "Dining in"],
    ["folio_desk", "Desk folio only"]
  ]
    .map(
      ([v, lab]) =>
        `<option value="${escapeHtml(v)}"${serviceQ === v ? " selected" : ""}>${escapeHtml(lab)}</option>`
    )
    .join("");

  const updatedBanner = req.query.updated ? '<p class="badge ok">Ticket updated.</p>' : "";
  const errBanner =
    req.query.err || req.query.missing
      ? `<p class="badge alert" role="alert">Could not update ticket.</p>`
      : "";

  const content = `
<style>
.outlet-board-wrap { margin-bottom: 20px; }
.outlet-board-filters { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; margin-bottom:16px; padding:14px 16px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; }
.outlet-board-filters label { font-size:13px; color:#475569; }
.outlet-board-filters input[type="date"] { padding:8px; border:1px solid #cbd5e1; border-radius:8px; }
.outlet-board-grid { display:flex; gap:12px; align-items:flex-start; overflow-x:auto; padding-bottom:8px; scroll-snap-type:x mandatory; }
.outlet-board-col { flex:0 0 min(280px, 92vw); scroll-snap-align:start; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; min-height:120px; display:flex; flex-direction:column; }
.outlet-board-col-head { display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid #e2e8f0; background:#f1f5f9; border-radius:12px 12px 0 0; position:sticky; top:0; z-index:1; }
.outlet-board-col-head h3 { margin:0; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:#334155; }
.outlet-board-count { font-size:12px; font-weight:800; background:#e2e8f0; color:#475569; padding:2px 8px; border-radius:999px; }
.outlet-board-col-body { padding:10px; display:flex; flex-direction:column; gap:10px; flex:1; max-height:70vh; overflow-y:auto; }
.outlet-board-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:10px 12px; font-size:13px; box-shadow:0 1px 2px rgba(15,23,42,.06); }
.outlet-board-card--new { border-left:4px solid #059669; box-shadow:0 4px 14px rgba(5,150,105,.15); }
.outlet-board-card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:6px; }
.outlet-wa { font-size:11px; font-weight:700; padding:2px 6px; border-radius:6px; white-space:nowrap; }
.outlet-wa-ok { background:#d1fae5; color:#065f46; }
.outlet-wa-fail { background:#fee2e2; color:#991b1b; }
.outlet-wa-unk { background:#f1f5f9; color:#64748b; }
.outlet-board-card-ref { margin:0 0 6px; font-size:12px; }
.outlet-board-card-meta { margin:0 0 6px; line-height:1.4; }
.outlet-board-card-items { margin:0 0 6px; font-weight:600; color:#0f172a; line-height:1.35; }
.outlet-board-card-notes { margin:0 0 6px; font-size:12px; color:#334155; }
.outlet-board-card-foot { margin:0 0 8px; font-size:11px; }
.outlet-board-card-form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; border-top:1px solid #f1f5f9; padding-top:8px; margin:0; }
.outlet-board-card-status-label { display:flex; flex-direction:column; gap:4px; font-size:11px; margin:0; flex:1; min-width:120px; }
.outlet-board-card-status-label select { padding:6px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px; width:100%; }
.outlet-board-save { padding:6px 12px; border:0; border-radius:8px; background:#128c7e; color:#fff; font-weight:700; font-size:12px; cursor:pointer; }
.outlet-board-empty { margin:0; font-size:13px; padding:8px 0; }
</style>
<div class="outlet-board-wrap">
<h2>Outlet board</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — Incoming orders by status. <strong>New</strong> tickets are highlighted. Internal tickets are the source of truth; WhatsApp is auxiliary.</p>
${updatedBanner}
${errBanner}
<p class="muted" style="font-size:13px"><a class="inline-link" href="/admin/outlet-orders">Table view</a> · <a class="inline-link" href="/admin/fb/menu">F&amp;B menu</a></p>
<form method="get" action="/admin/outlet-dashboard" class="outlet-board-filters">
  <label>Outlet
    <select name="outlet" style="padding:8px;border:1px solid #d8dee6;border-radius:8px">${outletFilterHtml}</select>
  </label>
  <label>Service
    <select name="service" style="padding:8px;border:1px solid #d8dee6;border-radius:8px">${serviceFilterHtml}</select>
  </label>
  <label>From
    <input type="date" name="dateFrom" value="${escapeHtml(dateFrom)}" />
  </label>
  <label>To
    <input type="date" name="dateTo" value="${escapeHtml(dateTo)}" />
  </label>
  <button type="submit" class="btn-link primary" style="padding:9px 14px;border-radius:8px">Apply</button>
</form>
<div class="outlet-board-grid">${columnsHtml}</div>
</div>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/outlet-orders", requirePermissionAny([{ module: "OUTLET", action: "VIEW" }, { module: "ROOMS", action: "VIEW" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, currency: true }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Outlet orders</h2><p>No hotel data.</p>", true));
    return;
  }
  const outletQ = String(req.query.outlet ?? "all").trim();
  const statusQ = String(req.query.status ?? "all").trim();
  const where: Prisma.OutletOrderTicketWhereInput = { hotelId: hotel.id };
  if (outletQ && outletQ !== "all") where.outletKey = outletQ;
  if (statusQ && statusQ !== "all" && (Object.values(OutletTicketStatus) as string[]).includes(statusQ)) {
    where.ticketStatus = statusQ as OutletTicketStatus;
  }
  const tickets = await prisma.outletOrderTicket.findMany({
    where,
    include: {
      booking: { include: { guest: true, roomUnit: { include: { roomType: true } } } },
      fbOrder: { include: { lines: { orderBy: { id: "asc" } } } },
      folioTransaction: true
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });

  const outletFilterHtml = [
    ["all", "All outlets"],
    ["RESTAURANT", "Restaurant"],
    ["COFFEE_SHOP", "Coffee shop"],
    ["CAFE", "Café (folio)"],
    ["ROOM_SERVICE", "Room service"],
    ["ACTIVITY", "Activity"]
  ]
    .map(
      ([v, lab]) =>
        `<option value="${escapeHtml(v)}"${outletQ === v ? " selected" : ""}>${escapeHtml(lab)}</option>`
    )
    .join("");

  const statusFilterHtml = (["all", ...Object.values(OutletTicketStatus)] as const)
    .map((v) => {
      const lab = v === "all" ? "All statuses" : v;
      return `<option value="${escapeHtml(v)}"${statusQ === v ? " selected" : ""}>${escapeHtml(lab)}</option>`;
    })
    .join("");

  const updatedBanner = req.query.updated ? '<p class="badge ok">Ticket status updated.</p>' : "";
  const errBanner =
    req.query.err || req.query.missing
      ? `<p class="badge alert" role="alert">Could not update ticket (invalid status or not found).</p>`
      : "";

  const rows = tickets
    .map((t) => {
      const ref = displayBookingReference(t.booking);
      const guest = t.booking.guest.fullName?.trim() || t.booking.guest.phoneE164 || "—";
      const unit =
        t.booking.roomUnit?.name && t.booking.roomUnit.roomType?.name
          ? `${t.booking.roomUnit.name} (${t.booking.roomUnit.roomType.name})`
          : t.booking.roomUnit?.name || "—";
      let itemsHtml = "—";
      if (t.fbOrder?.lines?.length) {
        itemsHtml = t.fbOrder.lines
          .map((l) => `${l.quantity}× ${escapeHtml(l.itemNameSnap)} (${formatMoney(l.lineTotal, hotel.currency)})`)
          .join("<br/>");
      } else if (t.folioTransaction) {
        const ft = t.folioTransaction;
        itemsHtml = `${ft.quantity}× ${escapeHtml(ft.itemName)} (${formatMoney(ft.netAmount, ft.currency || hotel.currency)})`;
      }
      const srcLabel = t.source === "FB_MENU" ? "Menu / POS" : "Folio";
      const modeLabel =
        t.serviceMode === "ROOM_SERVICE"
          ? "Room service"
          : t.serviceMode === "DINING_IN"
            ? "Dining in"
            : "—";
      const statusOptions = (Object.values(OutletTicketStatus) as string[])
        .map(
          (s) =>
            `<option value="${escapeHtml(s)}"${t.ticketStatus === s ? " selected" : ""}>${escapeHtml(s)}</option>`
        )
        .join("");
      return `<tr>
        <td style="white-space:nowrap;font-size:12px"><code title="${escapeHtml(t.id)}">${escapeHtml(t.id.slice(0, 10))}…</code></td>
        <td><strong>${escapeHtml(formatOutletOrderTicketOutletKey(t.outletKey))}</strong><br/><span class="muted" style="font-size:12px">${escapeHtml(srcLabel)}</span></td>
        <td><code>${escapeHtml(ref)}</code><br/><a class="inline-link" style="font-size:12px" href="/admin/bookings/${encodeURIComponent(t.bookingId)}">Open booking</a></td>
        <td>${escapeHtml(guest)}</td>
        <td>${escapeHtml(unit)}</td>
        <td style="font-size:13px;line-height:1.45">${itemsHtml}</td>
        <td style="max-width:140px;font-size:12px">${t.notes ? escapeHtml(t.notes) : "—"}</td>
        <td class="muted" style="font-size:12px">${escapeHtml(modeLabel)}</td>
        <td style="white-space:nowrap;font-size:12px">${formatDateTime(t.createdAt)}</td>
        <td>
          <form method="post" action="/admin/outlet-orders/${encodeURIComponent(t.id)}/status" style="margin:0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <input type="hidden" name="outlet" value="${escapeHtml(outletQ)}" />
            <input type="hidden" name="statusFilter" value="${escapeHtml(statusQ)}" />
            <input type="hidden" name="service" value="all" />
            <input type="hidden" name="dateFrom" value="" />
            <input type="hidden" name="dateTo" value="" />
            <select name="ticketStatus" style="padding:6px 8px;border-radius:8px;border:1px solid #cbd5e1;font-size:12px;max-width:130px">${statusOptions}</select>
            <button type="submit" style="padding:6px 10px;border:0;border-radius:8px;background:#128c7e;color:#fff;font-weight:700;font-size:12px;cursor:pointer">Save</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const content = `
<h2>Outlet order tickets</h2>
<p class="muted">${escapeHtml(hotel.displayName)} — Internal kitchen / café / room-service queue. One ticket per posting action (menu batch per outlet, or folio charge line). WhatsApp alerts are separate; tickets stay even if WhatsApp fails.</p>
<p class="muted" style="font-size:13px"><a class="inline-link primary" href="/admin/outlet-dashboard">Outlet board</a> (kanban by status)</p>
${updatedBanner}
${errBanner}
<form method="get" action="/admin/outlet-orders" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px">
  <label>Outlet
    <select name="outlet" style="padding:8px;border:1px solid #d8dee6;border-radius:8px">${outletFilterHtml}</select>
  </label>
  <label>Status
    <select name="status" style="padding:8px;border:1px solid #d8dee6;border-radius:8px">${statusFilterHtml}</select>
  </label>
  <button type="submit" class="btn-link primary" style="padding:9px 14px;border-radius:8px">Apply filters</button>
  <a class="btn-link" href="/admin/fb/menu">F&amp;B menu</a>
</form>
<div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:12px;background:#fff">
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead>
      <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0">
        <th style="text-align:left;padding:10px">ID</th>
        <th style="text-align:left;padding:10px">Outlet</th>
        <th style="text-align:left;padding:10px">Booking ref</th>
        <th style="text-align:left;padding:10px">Guest</th>
        <th style="text-align:left;padding:10px">Room / unit</th>
        <th style="text-align:left;padding:10px">Items</th>
        <th style="text-align:left;padding:10px">Notes</th>
        <th style="text-align:left;padding:10px">Service</th>
        <th style="text-align:left;padding:10px">Created</th>
        <th style="text-align:left;padding:10px">Status</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="10" style="padding:16px" class="muted">No tickets match these filters.</td></tr>'}</tbody>
  </table>
</div>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/outlet-orders/:ticketId/status", requirePermissionAny([{ module: "OUTLET", action: "EDIT" }, { module: "ROOMS", action: "EDIT" }]), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/outlet-dashboard");
    return;
  }
  const ticketId = String(req.params.ticketId ?? "");
  const nextRaw = String(req.body.ticketStatus ?? "").trim();
  const outletQ = String(req.body.outlet ?? "all").trim();
  const statusFilter = String(req.body.statusFilter ?? "all").trim();
  const redirectTo = String(req.body.redirectTo ?? "").trim();
  const dateFrom = String(req.body.dateFrom ?? "").trim();
  const dateTo = String(req.body.dateTo ?? "").trim();
  const serviceQ = String(req.body.service ?? "all").trim();
  const q = new URLSearchParams();
  q.set("outlet", outletQ);
  q.set("status", statusFilter);
  q.set("service", serviceQ);
  q.set("dateFrom", dateFrom);
  q.set("dateTo", dateTo);
  if (!(Object.values(OutletTicketStatus) as string[]).includes(nextRaw)) {
    q.set("err", "1");
    res.redirect(
      redirectTo === "dashboard" ? `/admin/outlet-dashboard?${q.toString()}` : `/admin/outlet-orders?${q.toString()}`
    );
    return;
  }
  const nextStatus = nextRaw as OutletTicketStatus;
  const ticket = await prisma.outletOrderTicket.findFirst({
    where: { id: ticketId, hotelId: hotel.id }
  });
  if (!ticket) {
    q.set("missing", "1");
    res.redirect(
      redirectTo === "dashboard" ? `/admin/outlet-dashboard?${q.toString()}` : `/admin/outlet-orders?${q.toString()}`
    );
    return;
  }
  await prisma.outletOrderTicket.update({
    where: { id: ticket.id },
    data: { ticketStatus: nextStatus }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "OUTLET_ORDER_TICKET_STATUS",
    entityType: "OutletOrderTicket",
    entityId: ticket.id,
    metadata: { from: ticket.ticketStatus, to: nextStatus }
  });
  q.set("updated", "1");
  res.redirect(
    redirectTo === "dashboard" ? `/admin/outlet-dashboard?${q.toString()}` : `/admin/outlet-orders?${q.toString()}`
  );
});

adminRouter.get("/bookings/:id/invoice-print", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    select: { id: true, displayName: true, city: true, country: true }
  });
  if (!hotel) {
    res.status(404).send("Hotel not found");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { guest: true, roomType: true, property: true }
  });
  if (!booking) {
    res.status(404).send("Booking not found");
    return;
  }
  const selectedUnitCode = await getBookingUnitCode(booking.id);
  const fbFolio = await getFbFolioForBooking(booking.id);
  const grandTotal = Number((booking.totalAmount + fbFolio.subtotal).toFixed(2));
  const invoiceNumber = `INV-${booking.id}`;
  const filename = `${booking.id}-invoice.pdf`;
  const invoicePdf = await buildBookingInvoicePdf({
    documentKind: "invoice",
    invoiceNumber,
    issuedAt: new Date(),
    hotelName: hotel.displayName,
    hotelCity: hotel.city,
    hotelCountry: hotel.country,
    guestName: booking.guest.fullName ?? "Guest",
    guestPhone: booking.guest.phoneE164,
    bookingId: booking.id,
    bookingStatus: booking.status,
    paymentStatus: booking.paymentStatus,
    roomType: booking.roomType.name,
    selectedUnit: selectedUnitCode,
    propertyName: booking.property.name,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: booking.nights,
    adults: booking.adults,
    children: booking.children,
    totalAmount: booking.totalAmount,
    currency: booking.currency,
    fbLines: fbFolio.lines,
    fbSubtotal: fbFolio.subtotal,
    grandTotal
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.send(invoicePdf);
});

adminRouter.get("/bookings/:id", requirePermission("BOOKINGS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Booking</h2><p>No hotel data found.</p>", true));
    return;
  }

  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: {
      guest: { include: { segmentTags: { orderBy: { tag: "asc" } } } },
      roomType: true,
      property: true,
      conversation: true,
      paymentIntents: { orderBy: { createdAt: "desc" } }
    }
  });

  if (!booking) {
    res.status(404).type("html").send(renderLayout(`<h2>Booking ${escapeHtml(bookingId)}</h2><p>Booking not found.</p>`, true));
    return;
  }

  const updatedNotice = req.query.updated ? '<p class="badge ok">Booking updated.</p>' : "";
  const outletWarnBooking =
    typeof req.query.outletWarn === "string" && req.query.outletWarn.trim().length > 0
      ? req.query.outletWarn.trim().slice(0, 800)
      : "";
  const fbPostedNotice = req.query.fbPosted
    ? `<p class="badge ok">Restaurant / coffee charge posted to this guest&apos;s folio.</p>${
        outletWarnBooking
          ? `<p class="badge alert" role="alert" style="margin-top:8px"><strong>Outlet WhatsApp:</strong> ${escapeHtml(outletWarnBooking)}</p>`
          : ""
      }`
    : "";
  const paymentLinkNotice = req.query.paymentLinkSent ? '<p class="badge ok">Payment link sent to guest via WhatsApp.</p>' : "";
  const invoiceSentNotice = req.query.invoiceSent ? '<p class="badge ok">Invoice PDF sent to guest.</p>' : "";
  const quotationSentNotice = req.query.quotationSent ? '<p class="badge ok">Quotation PDF sent to guest.</p>' : "";
  const receiptSentNotice = req.query.receiptSent ? '<p class="badge ok">Receipt PDF sent to guest.</p>' : "";
  const invoiceErrorNotice =
    typeof req.query.invoiceError === "string" ? `<p class="badge alert">${escapeHtml(req.query.invoiceError)}</p>` : "";
  const roomChangedNotice = req.query.roomChanged
    ? '<p class="badge ok">Room assignment updated. Folio lines, housekeeping tasks, and the room board now follow the new unit where applicable.</p>'
    : "";
  const linkedAddedNotice = req.query.linkedAdded
    ? '<p class="badge ok">Linked room booking created under the same group.</p>'
    : "";
  const roomChangeErrBanner =
    typeof req.query.roomChangeError === "string" && req.query.roomChangeError.trim().length > 0
      ? `<p class="badge alert" role="alert">${escapeHtml(req.query.roomChangeError.trim().slice(0, 500))}</p>`
      : "";
  const canChangeRoom =
    booking.status === BookingStatus.CONFIRMED || booking.status === BookingStatus.PENDING;
  const canAddLinkedRoom =
    booking.status !== BookingStatus.CANCELLED && booking.status !== BookingStatus.NO_SHOW;
  const [selectedUnitCode, latestInvoiceDispatch, fbFolio, fbOrders] = await Promise.all([
    getBookingUnitCode(booking.id),
    getLatestInvoiceDispatch(booking.id),
    getFbFolioForBooking(booking.id),
    prisma.fbOrder.findMany({
      where: { bookingId: booking.id, status: FbOrderStatus.POSTED },
      orderBy: { createdAt: "desc" },
      include: { lines: true }
    })
  ]);
  const folioGrandTotal = Number((booking.totalAmount + fbFolio.subtotal).toFixed(2));
  const noUnitWarning = selectedUnitCode
    ? ""
    : '<p class="badge alert">No room unit assigned yet. Booking can still proceed with auto-assignment on confirmation.</p>';
  const paymentChangedSinceLastInvoice = Boolean(
    latestInvoiceDispatch.paymentStatusAtSend && latestInvoiceDispatch.paymentStatusAtSend !== booking.paymentStatus
  );
  const invoiceStatusNote = latestInvoiceDispatch.sentAt
    ? `Last sent ${formatDateTime(latestInvoiceDispatch.sentAt)}${latestInvoiceDispatch.paymentStatusAtSend ? ` (payment status at send: ${latestInvoiceDispatch.paymentStatusAtSend})` : ""}.`
    : "Invoice not sent yet.";
  const canSendInvoice = booking.status === BookingStatus.CONFIRMED;
  const canSendQuotation = booking.status !== BookingStatus.CANCELLED;
  const canSendReceipt = booking.status === BookingStatus.CONFIRMED;
  const paymentRows = booking.paymentIntents
    .map(
      (payment) => `<tr>
      <td>${escapeHtml(payment.id)}</td>
      <td>${formatMoney(payment.amount, payment.currency)}</td>
      <td>${escapeHtml(payment.kind)}</td>
      <td><span class="badge ${getBadgeClass(payment.status)}">${escapeHtml(payment.status)}</span></td>
      <td>${payment.paymentLinkSentAt ? formatDateTime(payment.paymentLinkSentAt) : '<span class="muted">—</span>'}</td>
      <td>${formatDateTime(payment.createdAt)}</td>
      </tr>`
    )
    .join("");

  const fbOrderRows = fbOrders
    .map(
      (o) =>
        `<tr>
      <td>${formatDateTime(o.createdAt)}</td>
      <td>${escapeHtml(o.outletType === FbOutletType.COFFEE_SHOP ? "Coffee shop" : "Restaurant")}</td>
      <td>${escapeHtml(o.serviceMode === FbServiceMode.ROOM_SERVICE ? "Room service" : "Dining in")}</td>
      <td>${escapeHtml(o.lines.map((l) => `${l.quantity}× ${l.itemNameSnap}`).join(", "))}</td>
      <td>${formatMoney(o.totalAmount, booking.currency)}</td>
    </tr>`
    )
    .join("");

  let groupSectionHtml = "";
  if (booking.bookingGroupId) {
    const members = await prisma.booking.findMany({
      where: { hotelId: hotel.id, bookingGroupId: booking.bookingGroupId },
      orderBy: { createdAt: "asc" },
      include: { roomType: true, roomUnit: { select: { name: true } }, paymentIntents: true }
    });
    let groupRollupOutstanding = 0;
    const rows: string[] = [];
    for (const m of members) {
      const unitCode = m.roomUnit?.name ?? (await getBookingUnitCode(m.id));
      const succ = m.paymentIntents
        .filter((p) => p.status === PaymentStatus.SUCCEEDED)
        .reduce((sum, p) => sum + p.amount, 0);
      const summary = await getFolioSummary({
        hotelId: hotel.id,
        bookingId: m.id,
        bookingTotalAmount: m.totalAmount,
        currency: m.currency,
        paymentIntentsSucceededTotal: succ
      });
      groupRollupOutstanding += summary.outstandingBalance;
      const primaryLabel = m.isPrimaryPayer ? ' <span class="badge ok" style="font-size:11px">Primary payer</span>' : "";
      rows.push(`<tr>
      <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(m.id)}">${escapeHtml(displayBookingReference(m))}</a>${primaryLabel}</td>
      <td>${escapeHtml(m.roomType.name)}</td>
      <td>${unitCode ? escapeHtml(unitCode) : '<span class="muted">—</span>'}</td>
      <td>${formatDate(m.checkIn)} → ${formatDate(m.checkOut)}</td>
      <td><span class="badge ${getBadgeClass(m.status)}">${escapeHtml(m.status)}</span></td>
      <td style="text-align:right">${formatMoney(summary.outstandingBalance, m.currency)}</td>
      </tr>`);
    }
    groupSectionHtml = `
<section style="margin:18px 0">
  <h3>Linked rooms (same booking group)</h3>
  <p class="muted" style="margin-top:0">One guest account; each row is its own stay and folio. Combined outstanding is for front-desk visibility only.</p>
  <table>
    <thead><tr><th>Booking</th><th>Room type</th><th>Unit</th><th>Stay</th><th>Status</th><th style="text-align:right">Outstanding</th></tr></thead>
    <tbody>${rows.join("") || "<tr><td colspan=\"6\">No rows</td></tr>"}</tbody>
    <tfoot><tr><th colspan="5" style="text-align:right">Combined outstanding</th><th style="text-align:right">${formatMoney(
      groupRollupOutstanding,
      booking.currency
    )}</th></tr></tfoot>
  </table>
</section>`;
  }

  const conversationLink = booking.conversationId
    ? `<a class="inline-link" href="/admin/conversations/${encodeURIComponent(booking.conversationId)}">Open linked conversation</a>`
    : '<span class="muted">No conversation linked.</span>';

  const content = `
<h2>Booking ${escapeHtml(booking.id)}</h2>
<p class="muted">Full booking history and actions for front desk operations.</p>
${updatedNotice}
${fbPostedNotice}
${paymentLinkNotice}
${invoiceSentNotice}
${quotationSentNotice}
${receiptSentNotice}
${invoiceErrorNotice}
${roomChangedNotice}
${linkedAddedNotice}
${roomChangeErrBanner}
${noUnitWarning}
${groupSectionHtml}
<div class="actions">
  <a class="btn-link" href="/admin/bookings">Back to reports</a>
  <a class="btn-link" href="/admin/calendar?start=${formatDate(booking.checkIn)}&days=14">Open calendar around stay</a>
  <a class="btn-link primary" href="/admin/inventory?start=${formatDate(booking.checkIn)}&days=7">Adjust inventory around check-in</a>
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/select-unit">Select room unit</a>
  ${
    canChangeRoom
      ? `<a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/change-room">Change room</a>`
      : ""
  }
  ${
    canAddLinkedRoom
      ? `<a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/add-linked-room">Add linked room</a>`
      : ""
  }
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/confirm">Confirmation summary</a>
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/fb-order">Post F&amp;B charge (restaurant / coffee)</a>
  <a class="btn-link" href="/admin/fb/menu?bookingId=${encodeURIComponent(booking.id)}">F&amp;B menu &amp; prices</a>
</div>
<div class="grid-2">
  <section>
    <h3>Booking Summary</h3>
    <table>
      <tbody>
        <tr><th>Guest</th><td>${escapeHtml(booking.guest.fullName ?? "-")} (${escapeHtml(booking.guest.phoneE164)}) <a class="inline-link" style="font-size:12px;margin-left:6px" href="/admin/guests/${encodeURIComponent(booking.guest.id)}">Profile</a></td></tr>
        <tr><th>VIP &amp; segments</th><td style="line-height:1.7">${formatGuestVipAndTagsHtml({
          guestId: booking.guest.id,
          isVip: booking.guest.isVip,
          vipNote: booking.guest.vipNote,
          tags: booking.guest.segmentTags
        })}</td></tr>
        <tr><th>Phone Number</th><td>${escapeHtml(booking.guest.phoneE164)}</td></tr>
        <tr><th>Property</th><td>${escapeHtml(booking.property.name)}</td></tr>
        <tr><th>Room type</th><td>${escapeHtml(booking.roomType.name)}</td></tr>
        <tr><th>Selected unit</th><td>${selectedUnitCode ? escapeHtml(selectedUnitCode) : '<span class="badge pending">Not selected</span>'}</td></tr>
        <tr><th>Stay</th><td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)} (${booking.nights} nights)</td></tr>
        <tr><th>Guests</th><td>${booking.adults}</td></tr>
        <tr><th>Accommodation total</th><td>${formatMoney(booking.totalAmount, booking.currency)}</td></tr>
        <tr><th>F&amp;B (posted to folio)</th><td>${
          fbFolio.subtotal > 0 ? formatMoney(fbFolio.subtotal, booking.currency) : '<span class="muted">—</span>'
        }</td></tr>
        <tr><th>Folio total (invoice)</th><td><strong>${formatMoney(folioGrandTotal, booking.currency)}</strong> <span class="muted">accommodation + F&amp;B</span></td></tr>
        <tr><th>Source</th><td><span class="badge ${booking.conversationId ? "ok" : "pending"}">${escapeHtml(
    booking.conversationId ? "WhatsApp" : booking.source
  )}</span></td></tr>
        <tr><th>Status</th><td><span class="badge ${getBadgeClass(booking.status)}">${escapeHtml(booking.status)}</span></td></tr>
        <tr><th>Payment</th><td><span class="badge ${getBadgeClass(booking.paymentStatus)}">${escapeHtml(booking.paymentStatus)}</span></td></tr>
        <tr><th>Conversation</th><td>${conversationLink}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Actions</h3>
    <form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/status" style="display:grid; gap:8px; margin-bottom:12px">
      <label>Booking status
        <select name="status" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
          <option value="PENDING" ${booking.status === "PENDING" ? "selected" : ""}>Pending</option>
          <option value="CONFIRMED" ${booking.status === "CONFIRMED" ? "selected" : ""}>Confirmed</option>
          <option value="CANCELLED" ${booking.status === "CANCELLED" ? "selected" : ""}>Cancelled</option>
          <option value="NO_SHOW" ${booking.status === "NO_SHOW" ? "selected" : ""}>No Show</option>
        </select>
      </label>
      <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#25d366; color:#083d2d; font-weight:700">Update Booking Status</button>
    </form>
    <form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/payment" style="display:grid; gap:8px">
      <label>Payment status
        <select name="paymentStatus" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
          <option value="PENDING" ${booking.paymentStatus === "PENDING" ? "selected" : ""}>Pending</option>
          <option value="REQUIRES_ACTION" ${booking.paymentStatus === "REQUIRES_ACTION" ? "selected" : ""}>Requires action</option>
          <option value="LPO" ${booking.paymentStatus === "LPO" ? "selected" : ""}>LPO (company purchase order)</option>
          <option value="FRIENDS_TRANSFER" ${booking.paymentStatus === "FRIENDS_TRANSFER" ? "selected" : ""}>Friends / bank transfer (manual)</option>
          <option value="SUCCEEDED" ${booking.paymentStatus === "SUCCEEDED" ? "selected" : ""}>Succeeded</option>
          <option value="FAILED" ${booking.paymentStatus === "FAILED" ? "selected" : ""}>Failed</option>
          <option value="REFUNDED" ${booking.paymentStatus === "REFUNDED" ? "selected" : ""}>Refunded</option>
        </select>
      </label>
      <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Update Payment Status</button>
    </form>
    <p class="muted" style="margin:0;font-size:12px">Follow-up lists: export <a class="inline-link" href="/admin/bookings/export?paymentStatus=LPO">LPO</a> or <a class="inline-link" href="/admin/bookings/export?paymentStatus=FRIENDS_TRANSFER">friends transfer</a> bookings from the <a class="inline-link" href="/admin/bookings">booking report</a>.</p>
    <div style="display:grid; gap:10px; margin-top:12px">
      <p class="muted" style="margin:0"><strong>${escapeHtml(hotel.displayName)}</strong> — send PDFs to the guest on WhatsApp (hotel-led wording; not a duplicate booking confirmation).</p>
      <form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/send-invoice" style="display:grid; gap:6px">
        <p class="muted" style="margin:0">${escapeHtml(invoiceStatusNote)}</p>
        ${
          paymentChangedSinceLastInvoice
            ? '<p class="badge alert" style="margin:0; width:fit-content">Payment status changed since last invoice. Resend recommended.</p>'
            : ""
        }
        <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#128c7e; color:#fff; font-weight:700" ${
          canSendInvoice ? "" : "disabled"
        }>${latestInvoiceDispatch.sentAt ? "Resend invoice (folio)" : "Send invoice (folio)"}</button>
        ${canSendInvoice ? "" : '<p class="muted" style="margin:0">Invoice is available after the booking is confirmed.</p>'}
      </form>
      <form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/send-quotation" style="display:grid; gap:6px">
        <p class="muted" style="margin:0;font-size:12px">Quotation — proposed charges for planning (clearly not a booking confirmation).</p>
        <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#0f766e; color:#fff; font-weight:700" ${
          canSendQuotation ? "" : "disabled"
        }>Send quotation PDF</button>
      </form>
      <form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/send-receipt" style="display:grid; gap:6px">
        <p class="muted" style="margin:0;font-size:12px">Receipt — payment acknowledgement / folio snapshot.</p>
        <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#115e59; color:#fff; font-weight:700" ${
          canSendReceipt ? "" : "disabled"
        }>Send receipt PDF</button>
      </form>
    </div>
  </section>
</div>
<section style="margin-top:14px">
  <h3>Food &amp; beverage (folio)</h3>
  <p class="muted">Posted from the menu; included on the guest invoice PDF with accommodation.</p>
  <table>
    <thead><tr><th>Posted</th><th>Outlet</th><th>Service</th><th>Items</th><th>Total</th></tr></thead>
    <tbody>${fbOrderRows || '<tr><td colspan="5">No F&amp;B charges on this folio yet.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin-top:14px">
  <h3>Payment Intent History</h3>
  <table>
    <thead><tr><th>ID</th><th>Amount</th><th>Kind</th><th>Status</th><th>Link sent (WhatsApp)</th><th>Created</th></tr></thead>
    <tbody>${paymentRows || '<tr><td colspan="6">No payment intents for this booking yet.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/reports-center/guest-broadcast", requirePermission("REPORTS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel) {
    res.redirect("/admin/reports-center");
    return;
  }
  const message = String(req.body.message ?? "").trim();
  const phonesCsv = String(req.body.phonesCsv ?? "");
  const start = String(req.body.start ?? "");
  const end = String(req.body.end ?? "");
  const guestStart = String(req.body.guestStart ?? "");
  const guestEnd = String(req.body.guestEnd ?? "");
  const unitId = String(req.body.unitId ?? "");
  const onlyMissingSignature = String(req.body.onlyMissingSignature ?? "0") === "1" ? "1" : "0";
  const onlyMissingIdCopy = String(req.body.onlyMissingIdCopy ?? "0") === "1" ? "1" : "0";
  const onlyMissingTransactionNumber = String(req.body.onlyMissingTransactionNumber ?? "0") === "1" ? "1" : "0";
  const showIncompleteHandoverOnly = String(req.body.showIncompleteHandoverOnly ?? "0") === "1" ? "1" : "0";
  if (!message) {
    res.redirect(
      `/admin/reports-center?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&guestStart=${encodeURIComponent(guestStart)}&guestEnd=${encodeURIComponent(guestEnd)}&unitId=${encodeURIComponent(unitId)}&onlyMissingSignature=${encodeURIComponent(onlyMissingSignature)}&onlyMissingIdCopy=${encodeURIComponent(onlyMissingIdCopy)}&onlyMissingTransactionNumber=${encodeURIComponent(onlyMissingTransactionNumber)}&showIncompleteHandoverOnly=${encodeURIComponent(showIncompleteHandoverOnly)}`
    );
    return;
  }
  const phones = Array.from(new Set(phonesCsv.split(",").map((p) => p.trim()).filter((p) => p.length > 5)));
  const config = loadPartnerSetupConfig(hotel.id);
  for (const phone of phones) {
    await sendWhatsAppText({
      to: phone.replace(/\D/g, ""),
      body: message,
      phoneNumberId: config.whatsappPhoneNumberId || undefined
    });
  }
  await logAudit({
    hotelId: hotel.id,
    action: "REPORTS_GUEST_BROADCAST_SENT",
    entityType: "Report",
    metadata: {
      recipients: phones.length,
      start,
      end,
      guestStart,
      guestEnd,
      unitId,
      onlyMissingSignature,
      onlyMissingIdCopy,
      onlyMissingTransactionNumber,
      showIncompleteHandoverOnly
    }
  });
  res.redirect(
    `/admin/reports-center?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&guestStart=${encodeURIComponent(guestStart)}&guestEnd=${encodeURIComponent(guestEnd)}&unitId=${encodeURIComponent(unitId)}&onlyMissingSignature=${encodeURIComponent(onlyMissingSignature)}&onlyMissingIdCopy=${encodeURIComponent(onlyMissingIdCopy)}&onlyMissingTransactionNumber=${encodeURIComponent(onlyMissingTransactionNumber)}&showIncompleteHandoverOnly=${encodeURIComponent(showIncompleteHandoverOnly)}&broadcastSent=1`
  );
});

adminRouter.get("/bookings/:id/select-unit", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Select Unit</h2><p>No hotel data found.</p>", true));
    return;
  }

  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { guest: true, roomType: true }
  });
  if (!booking) {
    res.status(404).type("html").send(renderLayout("<h2>Select Unit</h2><p>Booking not found.</p>", true));
    return;
  }

  const selectUnitError =
    typeof req.query.error === "string" && req.query.error.trim().length > 0
      ? `<p class="badge alert" role="alert">${escapeHtml(req.query.error.trim().slice(0, 500))}</p>`
      : "";

  const [selectedUnitCode, minInventory, bookedUnits, allUnits] = await Promise.all([
    getBookingUnitCode(booking.id),
    getMinInventoryForStay({
      hotelId: hotel.id,
      roomTypeId: booking.roomTypeId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      fallback: booking.roomType.totalInventory
    }),
    getBookedUnitsForStay({
      hotelId: hotel.id,
      roomTypeId: booking.roomTypeId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      excludeBookingId: booking.id
    }),
    prisma.roomUnit.findMany({
      where: { hotelId: hotel.id, roomTypeId: booking.roomTypeId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, notes: true }
    })
  ]);

  const availableUnits = allUnits
    .filter((unit) => !isRoomUnitBlockedForGuestAssignment(unit.notes))
    .map((unit) => unit.name)
    .filter((name) => !bookedUnits.has(name) || name === selectedUnitCode);

  const unitOptions = availableUnits
    .map((unitCode) => `<option value="${escapeHtml(unitCode)}" ${unitCode === selectedUnitCode ? "selected" : ""}>${escapeHtml(unitCode)}</option>`)
    .join("");

  const content = `
<h2>Select Room Unit</h2>
<p class="muted">Assign one specific unit to this booking before final confirmation.</p>
${selectUnitError}
${renderBookingWizard(2, { bookingId: booking.id, conversationId: booking.conversationId ?? undefined })}
<div class="actions">
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">Back to booking</a>
  <a class="btn-link primary" href="/admin/bookings/${encodeURIComponent(booking.id)}/confirm">Go to confirmation summary</a>
</div>
<table>
  <tbody>
    <tr><th>Booking</th><td>${escapeHtml(booking.id)}</td></tr>
    <tr><th>Guest</th><td>${escapeHtml(booking.guest.fullName ?? booking.guest.phoneE164)}</td></tr>
    <tr><th>Room Type</th><td>${escapeHtml(booking.roomType.name)}</td></tr>
    <tr><th>Stay</th><td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}</td></tr>
    <tr><th>Minimum inventory in stay</th><td>${minInventory}</td></tr>
  </tbody>
</table>
<form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/select-unit" style="max-width:420px; margin-top:12px; display:grid; gap:8px">
  <label>Unit code
    <select name="unitCode" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">
      ${unitOptions || '<option value="">No units available</option>'}
    </select>
  </label>
  <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#25d366; color:#083d2d; font-weight:700" ${
    availableUnits.length ? "" : "disabled"
  }>Save Unit Selection</button>
</form>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/bookings/:id/select-unit", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const unitCode = String(req.body.unitCode ?? "").trim();
  if (!unitCode) {
    res.redirect(`/admin/bookings/${encodeURIComponent(bookingId)}/select-unit`);
    return;
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { conversation: true, guest: true, roomType: true }
  });
  if (!booking) {
    res.redirect("/admin/bookings");
    return;
  }

  const unit = await prisma.roomUnit.findFirst({
    where: { hotelId: hotel.id, roomTypeId: booking.roomTypeId, name: unitCode, isActive: true },
    select: { id: true, name: true }
  });
  if (!unit) {
    res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}/select-unit`);
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await assertRoomUnitAvailableForBookingStayTx(tx, {
        hotelId: hotel.id,
        roomUnitId: unit.id,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        excludeBookingId: booking.id
      });
      await tx.booking.update({
        where: { id: booking.id },
        data: { roomUnitId: unit.id }
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not assign this unit.";
    res.redirect(
      `/admin/bookings/${encodeURIComponent(booking.id)}/select-unit?error=${encodeURIComponent(msg)}`
    );
    return;
  }

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_UNIT_SELECTED",
    entityType: "Booking",
    entityId: booking.id,
    metadata: { unitCode: unit.name, checkIn: formatDate(booking.checkIn), checkOut: formatDate(booking.checkOut) }
  });

  if (booking.conversationId) {
    const config = loadPartnerSetupConfig(hotel.id);
    const quoteMessage = buildTemplateMessage(
      config.instantQuoteTemplate,
      {
        hotel_name: hotel.displayName,
        guest_name: booking.guest.fullName || "Guest",
        room_type: booking.roomType.name || "Selected room",
        nightly_rate: booking.totalAmount && booking.nights ? (booking.totalAmount / booking.nights).toFixed(2) : "",
        nights: booking.nights,
        check_in: formatDate(booking.checkIn),
        check_out: formatDate(booking.checkOut),
        booking_id: booking.id
      },
      `Room unit ${unit.name} selected for booking ${booking.id}.`
    );
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: booking.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: `${quoteMessage}\nUnit: ${unit.name}.`,
        aiIntent: "UNIT_SELECTED"
      }
    });
    await prisma.conversation.update({
      where: { id: booking.conversationId },
      data: { state: ConversationState.QUOTED, lastMessageAt: new Date() }
    });
  }

  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}/confirm`);
});

adminRouter.get("/bookings/:id/change-room", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Change room</h2><p>No hotel data found.</p>", true));
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { guest: true, roomType: true }
  });
  if (!booking) {
    res.status(404).type("html").send(renderLayout("<h2>Change room</h2><p>Booking not found.</p>", true));
    return;
  }
  if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.NO_SHOW) {
    res.redirect(
      `/admin/bookings/${encodeURIComponent(booking.id)}?roomChangeError=${encodeURIComponent(
        "Cancelled or no-show bookings cannot change room."
      )}`
    );
    return;
  }

  const errQ = typeof req.query.error === "string" ? req.query.error.trim() : "";
  const errorBanner = errQ ? `<p class="badge alert" role="alert">${escapeHtml(errQ.slice(0, 500))}</p>` : "";

  const [selectedUnitCode, bookedUnits, allUnits] = await Promise.all([
    getBookingUnitCode(booking.id),
    getBookedUnitsForStay({
      hotelId: hotel.id,
      roomTypeId: booking.roomTypeId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      excludeBookingId: booking.id
    }),
    prisma.roomUnit.findMany({
      where: { hotelId: hotel.id, roomTypeId: booking.roomTypeId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, notes: true }
    })
  ]);

  const eligible = allUnits.filter((u) => {
    if (isRoomUnitBlockedForGuestAssignment(u.notes)) return false;
    const taken = bookedUnits.has(u.name) && u.name !== selectedUnitCode;
    return !taken;
  });

  const optionsHtml = eligible
    .map(
      (u) =>
        `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}${
          u.id === booking.roomUnitId ? " (current)" : ""
        }</option>`
    )
    .join("");

  const content = `
<h2>Change room</h2>
<p class="muted">Move this stay to another physical room of the same category. Availability is checked for the full stay (${escapeHtml(
    formatDate(booking.checkIn)
  )} → ${escapeHtml(formatDate(booking.checkOut))}).</p>
${errorBanner}
<div class="actions">
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">Back to booking</a>
  <a class="btn-link" href="/admin/room-board?date=${formatDateForInput(startOfDay(booking.checkIn))}">Room board</a>
</div>
<table>
  <tbody>
    <tr><th>Booking</th><td>${escapeHtml(displayBookingReference(booking))} <code>${escapeHtml(booking.id)}</code></td></tr>
    <tr><th>Guest</th><td>${escapeHtml(booking.guest.fullName ?? booking.guest.phoneE164)}</td></tr>
    <tr><th>Room type</th><td>${escapeHtml(booking.roomType.name)}</td></tr>
    <tr><th>Current unit</th><td>${selectedUnitCode ? escapeHtml(selectedUnitCode) : '<span class="muted">Not assigned</span>'}</td></tr>
  </tbody>
</table>
<form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/change-room" style="max-width:520px; margin-top:16px; display:grid; gap:10px">
  <label>Target room
    <select name="targetRoomUnitId" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="">Select a room</option>
      ${optionsHtml || '<option value="" disabled>No eligible units</option>'}
    </select>
  </label>
  <label>Reason (optional)
    <textarea name="reason" maxlength="500" rows="2" placeholder="e.g. Guest request, maintenance in original room" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px"></textarea>
  </label>
  <label style="display:flex; gap:8px; align-items:flex-start; font-weight:600">
    <input type="checkbox" name="confirmed" value="1" required style="margin-top:4px" />
    <span>I confirm this room change. Availability is validated again when you save.</span>
  </label>
  <button type="submit" style="padding:10px 14px; border:0; border-radius:8px; background:#128c7e; color:#fff; font-weight:700" ${
    eligible.length ? "" : "disabled"
  }>Apply change</button>
</form>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/bookings/:id/change-room", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  if (req.body.confirmed !== "1") {
    res.redirect(
      `/admin/bookings/${encodeURIComponent(bookingId)}/change-room?error=${encodeURIComponent(
        "Confirm the room change before saving."
      )}`
    );
    return;
  }
  const targetRoomUnitId = String(req.body.targetRoomUnitId ?? "").trim();
  const reason = String(req.body.reason ?? "").trim().slice(0, 500);
  if (!targetRoomUnitId) {
    res.redirect(
      `/admin/bookings/${encodeURIComponent(bookingId)}/change-room?error=${encodeURIComponent("Select a target room.")}`
    );
    return;
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    select: { id: true, status: true }
  });
  if (!booking) {
    res.redirect("/admin/bookings");
    return;
  }
  if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.NO_SHOW) {
    res.redirect(
      `/admin/bookings/${encodeURIComponent(bookingId)}?roomChangeError=${encodeURIComponent(
        "Cancelled or no-show bookings cannot change room."
      )}`
    );
    return;
  }

  let meta: Awaited<ReturnType<typeof reassignBookingRoomUnitTx>>;
  try {
    meta = await prisma.$transaction(async (tx) =>
      reassignBookingRoomUnitTx(tx, { hotelId: hotel.id, bookingId: booking.id, targetRoomUnitId })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Room change failed.";
    res.redirect(`/admin/bookings/${encodeURIComponent(bookingId)}/change-room?error=${encodeURIComponent(msg)}`);
    return;
  }

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_ROOM_REASSIGNED",
    entityType: "Booking",
    entityId: booking.id,
    bookingId: booking.id,
    metadata: {
      fromRoomUnitId: meta.fromRoomUnitId,
      toRoomUnitId: meta.toRoomUnitId,
      fromRoomUnitName: meta.fromRoomUnitName,
      toRoomUnitName: meta.toRoomUnitName,
      reason: reason || undefined
    }
  });

  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}?roomChanged=1`);
});

adminRouter.get("/bookings/:id/add-linked-room", requirePermission("BOOKINGS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Add linked room</h2><p>No hotel data found.</p>", true));
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { guest: true, roomType: true }
  });
  if (!booking) {
    res.status(404).type("html").send(renderLayout("<h2>Add linked room</h2><p>Booking not found.</p>", true));
    return;
  }
  if (booking.status === BookingStatus.CANCELLED) {
    res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}`);
    return;
  }

  const errQ = typeof req.query.error === "string" ? req.query.error.trim() : "";
  const errorBanner = errQ ? `<p class="badge alert" role="alert">${escapeHtml(errQ.slice(0, 500))}</p>` : "";

  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, baseNightlyRate: true }
  });
  const roomOptions = roomTypes
    .map(
      (rt) =>
        `<option value="${escapeHtml(rt.id)}">${escapeHtml(rt.name)} (${formatMoney(rt.baseNightlyRate, hotel.currency)}/night)</option>`
    )
    .join("");

  const content = `
<h2>Add linked room</h2>
<p class="muted">Create another confirmed stay for <strong>${escapeHtml(
    booking.guest.fullName ?? booking.guest.phoneE164
  )}</strong> under the same booking group (one payer / family). Each room keeps its own folio; totals are shown together on the primary booking.</p>
${errorBanner}
<div class="actions">
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">Back to booking</a>
</div>
<form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/add-linked-room" style="max-width:640px; display:grid; gap:10px; margin-top:12px">
  <label>Room type
    <select name="roomTypeId" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${roomOptions}</select>
  </label>
  <div class="grid-2">
    <label>Check-in
      <input type="date" name="checkIn" value="${formatDateForInput(startOfDay(booking.checkIn))}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
    <label>Check-out
      <input type="date" name="checkOut" value="${formatDateForInput(startOfDay(booking.checkOut))}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
  </div>
  <div class="grid-2">
    <label>Adults
      <input type="number" name="adults" value="${booking.adults}" min="1" max="8" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
    <label>Children
      <input type="number" name="children" value="${booking.children}" min="0" max="6" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
  </div>
  <p class="muted" style="margin:0;font-size:13px">Room rent is calculated from the room type rack rate × nights (same as a quick desk booking). Assign the physical unit on the next screen if auto-assign cannot pick one.</p>
  <button type="submit" style="padding:10px 14px; border:0; border-radius:8px; background:#128c7e; color:#fff; font-weight:700">Create linked booking</button>
</form>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/bookings/:id/add-linked-room", requirePermission("BOOKINGS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const primaryId = String(req.params.id ?? "");
  const roomTypeId = String(req.body.roomTypeId ?? "").trim();
  const checkIn = startOfDay(parseDateInput(req.body.checkIn, startOfDay(new Date())));
  const checkOut = startOfDay(parseDateInput(req.body.checkOut, addDays(checkIn, 1)));
  const adults = clamp(parseIntegerInput(req.body.adults, 2), 1, 8);
  const children = clamp(parseIntegerInput(req.body.children, 0), 0, 6);

  const fail = (msg: string) => {
    res.redirect(`/admin/bookings/${encodeURIComponent(primaryId)}/add-linked-room?error=${encodeURIComponent(msg)}`);
  };

  if (checkOut.getTime() <= checkIn.getTime()) {
    fail("Check-out must be after check-in.");
    return;
  }

  const primary = await prisma.booking.findFirst({
    where: { id: primaryId, hotelId: hotel.id },
    include: { guest: true }
  });
  if (!primary) {
    res.redirect("/admin/bookings");
    return;
  }
  if (primary.status === BookingStatus.CANCELLED) {
    fail("Cannot add rooms to a cancelled booking.");
    return;
  }

  const roomType = await prisma.roomType.findFirst({
    where: { id: roomTypeId, hotelId: hotel.id, isActive: true }
  });
  if (!roomType) {
    fail("Select a valid room type.");
    return;
  }

  const occ = manualCheckInFitsRoomType(roomType, adults, children);
  if (!occ.ok) {
    fail(occ.message);
    return;
  }

  const nights = nightsBetweenCheckInOut(checkIn, checkOut);
  const totalAmount = Number((roomType.baseNightlyRate * nights).toFixed(2));
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    fail("Total amount must be greater than zero.");
    return;
  }

  const newBookingId = buildBookingId();
  let assignedUnitId: string | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      let groupId = primary.bookingGroupId;
      if (!groupId) {
        const g = await tx.bookingGroup.create({
          data: { hotelId: hotel.id, label: primary.referenceCode ?? primary.id.slice(0, 8) }
        });
        groupId = g.id;
        await tx.booking.update({
          where: { id: primary.id },
          data: { bookingGroupId: groupId, isPrimaryPayer: true }
        });
      } else {
        const hasPrimary = await tx.booking.findFirst({
          where: { bookingGroupId: groupId, isPrimaryPayer: true },
          select: { id: true }
        });
        if (!hasPrimary) {
          await tx.booking.update({
            where: { id: primary.id },
            data: { isPrimaryPayer: true }
          });
        }
      }

      await assertInventoryCanReserveTx(tx, {
        hotelId: hotel.id,
        roomTypeId: roomType.id,
        checkIn,
        checkOut,
        rooms: 1
      });

      const referenceCode = await allocateBookingReferenceCode(tx, {
        hotelId: hotel.id,
        source: ChannelProvider.DIRECT,
        refDate: new Date()
      });

      await tx.booking.create({
        data: {
          id: newBookingId,
          hotelId: hotel.id,
          propertyId: roomType.propertyId,
          roomTypeId: roomType.id,
          guestId: primary.guestId,
          conversationId: primary.conversationId,
          checkIn,
          checkOut,
          nights,
          adults,
          children,
          totalAmount,
          currency: hotel.currency,
          status: BookingStatus.CONFIRMED,
          paymentStatus: primary.paymentStatus,
          source: ChannelProvider.DIRECT,
          referenceCode,
          bookingGroupId: groupId!,
          isPrimaryPayer: false,
          mealPlan: primary.mealPlan ?? undefined
        }
      });

      await recordBookingStatusChange(tx, {
        hotelId: hotel.id,
        bookingId: newBookingId,
        fromStatus: null,
        toStatus: BookingStatus.CONFIRMED,
        source: "BOOKING_GROUP_ADD_ROOM"
      });

      await reserveInventoryForBooking({
        tx,
        hotelId: hotel.id,
        roomTypeId: roomType.id,
        propertyId: roomType.propertyId,
        checkIn,
        checkOut,
        rooms: 1
      });

      assignedUnitId = await autoAssignRoomUnitForBookingTx({
        tx,
        hotelId: hotel.id,
        roomTypeId: roomType.id,
        checkIn,
        checkOut,
        excludeBookingId: newBookingId
      });
      if (assignedUnitId) {
        await tx.booking.update({
          where: { id: newBookingId },
          data: { roomUnitId: assignedUnitId }
        });
      }

      await ensureActiveFolio(tx, {
        hotelId: hotel.id,
        bookingId: newBookingId,
        guestId: primary.guestId,
        roomUnitId: assignedUnitId ?? undefined,
        currency: hotel.currency,
        staffId: null
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not create linked booking.";
    fail(msg);
    return;
  }

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_GROUP_ROOM_ADDED",
    entityType: "Booking",
    entityId: newBookingId,
    bookingId: newBookingId,
    metadata: {
      primaryBookingId: primary.id,
      roomTypeId,
      checkIn: formatDateForInput(checkIn),
      checkOut: formatDateForInput(checkOut),
      nights,
      totalAmount
    }
  });

  await refreshGuestSegmentTagsForGuest(primary.guestId).catch(() => undefined);

  res.redirect(
    assignedUnitId
      ? `/admin/bookings/${encodeURIComponent(newBookingId)}?linkedAdded=1`
      : `/admin/bookings/${encodeURIComponent(newBookingId)}/select-unit?fromGroup=1`
  );
});

adminRouter.get("/bookings/:id/confirm", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Confirm Booking</h2><p>No hotel data found.</p>", true));
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { guest: true, roomType: true, property: true }
  });
  if (!booking) {
    res.status(404).type("html").send(renderLayout("<h2>Confirm Booking</h2><p>Booking not found.</p>", true));
    return;
  }
  const selectedUnitCode = await getBookingUnitCode(booking.id);
  const activeUnitCount = await prisma.roomUnit.count({
    where: { hotelId: hotel.id, roomTypeId: booking.roomTypeId, isActive: true }
  });
  const policyText =
    "Cancellation policy: Free cancellation up to 48 hours before check-in. Late cancellation or no-show may incur one-night charge.";
  const unitWarning = selectedUnitCode
    ? ""
    : '<p class="badge alert">No room unit is currently assigned. Confirming will try auto-assignment; booking still proceeds if no unit is available.</p>';
  const inventoryWarning =
    activeUnitCount < booking.roomType.totalInventory
      ? `<p class="badge alert">Active units (${activeUnitCount}) are fewer than inventory (${booking.roomType.totalInventory}).</p>`
      : "";
  const content = `
<h2>Booking Confirmation Summary</h2>
<p class="muted">Review guest details, selected unit and pricing before final confirmation.</p>
${renderBookingWizard(3, { bookingId: booking.id, conversationId: booking.conversationId ?? undefined })}
${unitWarning}
${inventoryWarning}
<div class="actions">
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">Back to booking</a>
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/select-unit">Change unit selection</a>
</div>
<table>
  <tbody>
    <tr><th>Booking ID</th><td>${escapeHtml(booking.id)}</td></tr>
    <tr><th>Guest</th><td>${escapeHtml(booking.guest.fullName ?? "-")} (${escapeHtml(booking.guest.phoneE164)})</td></tr>
    <tr><th>Room Type</th><td>${escapeHtml(booking.roomType.name)}</td></tr>
    <tr><th>Room Unit</th><td>${selectedUnitCode ? escapeHtml(selectedUnitCode) : '<span class="badge pending">Select unit first</span>'}</td></tr>
    <tr><th>Stay Dates</th><td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)} (${booking.nights} nights)</td></tr>
    <tr><th>Occupancy</th><td>${booking.adults} adults, ${booking.children} children</td></tr>
    <tr><th>Total Amount</th><td>${formatMoney(booking.totalAmount, booking.currency)}</td></tr>
    <tr><th>Policy</th><td>${escapeHtml(policyText)}</td></tr>
  </tbody>
</table>
<form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/confirm" style="max-width:420px; margin-top:12px">
  <button type="submit" style="width:100%; padding:10px 14px; border:0; border-radius:10px; background:#128c7e; color:#fff; font-weight:700">Confirm Booking</button>
</form>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/bookings/:id/confirm", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { conversation: true, guest: true, roomType: true }
  });
  if (!booking) {
    res.redirect("/admin/bookings");
    return;
  }
  let selectedUnitCode = await getBookingUnitCode(booking.id);
  if (!selectedUnitCode) {
    const assignedUnitId = await autoAssignRoomUnitForBookingTx({
      tx: prisma,
      hotelId: hotel.id,
      roomTypeId: booking.roomTypeId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      excludeBookingId: booking.id
    });
    if (assignedUnitId) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { roomUnitId: assignedUnitId }
      });
      const assignedUnit = await prisma.roomUnit.findUnique({ where: { id: assignedUnitId }, select: { name: true } });
      selectedUnitCode = assignedUnit?.name ?? null;
      if (selectedUnitCode) {
        await logAudit({
          hotelId: hotel.id,
          action: "BOOKING_UNIT_AUTO_ASSIGNED",
          entityType: "Booking",
          entityId: booking.id,
          bookingId: booking.id,
          metadata: { unitCode: selectedUnitCode, checkIn: formatDate(booking.checkIn), checkOut: formatDate(booking.checkOut) }
        });
      }
    }
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: { status: BookingStatus.CONFIRMED }
  });

  const confirmSession = getSession(req);
  await recordBookingStatusChange(prisma, {
    hotelId: hotel.id,
    bookingId: booking.id,
    fromStatus: booking.status,
    toStatus: BookingStatus.CONFIRMED,
    source: "ADMIN",
    actorUserId: confirmSession?.staffId ?? null
  });

  const confirmed = await prisma.booking.findFirst({
    where: { id: booking.id, hotelId: hotel.id },
    select: { guestId: true, roomUnitId: true, currency: true }
  });
  if (confirmed) {
    await ensureActiveFolio(prisma, {
      hotelId: hotel.id,
      bookingId: booking.id,
      guestId: confirmed.guestId,
      roomUnitId: confirmed.roomUnitId,
      currency: confirmed.currency,
      staffId: confirmSession?.staffId ?? null
    });
  }

  await reserveInventoryForBooking({
    tx: prisma,
    hotelId: hotel.id,
    roomTypeId: booking.roomTypeId,
    propertyId: booking.propertyId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    rooms: 1
  });

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_CONFIRMED_WITH_UNIT",
    entityType: "Booking",
    entityId: booking.id,
    bookingId: booking.id,
    metadata: { unitCode: selectedUnitCode, checkIn: formatDate(booking.checkIn), checkOut: formatDate(booking.checkOut) }
  });

  if (booking.conversationId) {
    const config = loadPartnerSetupConfig(hotel.id);
    const confirmationMessage = buildTemplateMessage(
      config.instantConfirmationTemplate,
      {
        hotel_name: hotel.displayName,
        guest_name: booking.guest.fullName || "Guest",
        room_type: booking.roomType.name || "Selected room",
        check_in: formatDate(booking.checkIn),
        check_out: formatDate(booking.checkOut),
        booking_id: booking.id
      },
      selectedUnitCode
        ? `Booking ${booking.id} confirmed. Unit ${selectedUnitCode} reserved for ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}.`
        : `Booking ${booking.id} confirmed for ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}. Unit assignment is pending.`
    );
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: booking.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: selectedUnitCode ? `${confirmationMessage} Unit: ${selectedUnitCode}.` : `${confirmationMessage} Unit assignment pending.`,
        aiIntent: "BOOKING_CONFIRMED"
      }
    });
    await prisma.conversation.update({
      where: { id: booking.conversationId },
      data: { state: ConversationState.CONFIRMED, lastMessageAt: new Date() }
    });
  }

  const paymentLink = await sendBookingPaymentLinkAfterConfirmation({
    hotelId: hotel.id,
    bookingId: booking.id
  });

  const query = new URLSearchParams({ updated: "1" });
  if (paymentLink.sent) query.set("paymentLinkSent", "1");
  if (paymentLink.error) query.set("invoiceError", paymentLink.error);
  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/send-invoice", requirePermission("BILLING", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }

  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, hotelId: hotel.id }, select: { id: true } });
  if (!booking) {
    res.redirect("/admin/bookings");
    return;
  }

  const result = await sendInvoicePdfForBooking({
    hotelId: hotel.id,
    bookingId: booking.id,
    trigger: "MANUAL_SEND_OR_RESEND",
    force: true,
    documentKind: "invoice"
  });

  const query = new URLSearchParams();
  if (result.sent) query.set("invoiceSent", "1");
  if (result.error) query.set("invoiceError", result.error);
  if (!result.sent && !result.error) query.set("invoiceError", "Invoice not sent. Booking may not be confirmed.");
  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/send-quotation", requirePermission("BILLING", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, hotelId: hotel.id }, select: { id: true } });
  if (!booking) {
    res.redirect("/admin/bookings");
    return;
  }
  const result = await sendInvoicePdfForBooking({
    hotelId: hotel.id,
    bookingId: booking.id,
    trigger: "MANUAL_SEND_QUOTATION",
    force: true,
    documentKind: "quotation"
  });
  const query = new URLSearchParams();
  if (result.sent) query.set("quotationSent", "1");
  if (result.error) query.set("invoiceError", result.error);
  if (!result.sent && !result.error) query.set("invoiceError", "Quotation not sent (booking may be cancelled).");
  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/send-receipt", requirePermission("BILLING", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }
  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, hotelId: hotel.id }, select: { id: true } });
  if (!booking) {
    res.redirect("/admin/bookings");
    return;
  }
  const result = await sendInvoicePdfForBooking({
    hotelId: hotel.id,
    bookingId: booking.id,
    trigger: "MANUAL_SEND_RECEIPT",
    force: true,
    documentKind: "receipt"
  });
  const query = new URLSearchParams();
  if (result.sent) query.set("receiptSent", "1");
  if (result.error) query.set("invoiceError", result.error);
  if (!result.sent && !result.error) query.set("invoiceError", "Receipt not sent. Booking may not be confirmed.");
  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/status", requirePermission("BOOKINGS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }

  const bookingId = String(req.params.id ?? "");
  const existingBooking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    select: { id: true, status: true }
  });
  if (!existingBooking) {
    res.redirect("/admin/bookings");
    return;
  }
  const rawStatus = String(req.body.status ?? "");
  const nextStatus: BookingStatus | null = [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW].includes(
    rawStatus as BookingStatus
  )
    ? (rawStatus as BookingStatus)
    : null;

  if (nextStatus) {
    await prisma.booking.updateMany({
      where: { id: bookingId, hotelId: hotel.id },
      data: { status: nextStatus }
    });
    const statusSession = getSession(req);
    await recordBookingStatusChange(prisma, {
      hotelId: hotel.id,
      bookingId,
      fromStatus: existingBooking.status,
      toStatus: nextStatus,
      source: "ADMIN",
      actorUserId: statusSession?.staffId ?? null
    });
    await logAudit({
      hotelId: hotel.id,
      action: "BOOKING_STATUS_UPDATED",
      entityType: "Booking",
      entityId: bookingId,
      bookingId,
      metadata: { status: nextStatus }
    });
  }
  const becameConfirmed = nextStatus === BookingStatus.CONFIRMED && existingBooking.status !== BookingStatus.CONFIRMED;
  let autoInvoiceResult: { sent: boolean; skipped: boolean; error?: string } | null = null;
  if (becameConfirmed) {
    const confirmedBooking = await prisma.booking.findFirst({
      where: { id: bookingId, hotelId: hotel.id },
      select: {
        roomTypeId: true,
        propertyId: true,
        checkIn: true,
        checkOut: true,
        roomUnitId: true,
        guestId: true,
        currency: true
      }
    });
    if (confirmedBooking) {
      if (!confirmedBooking.roomUnitId) {
        const assignedUnitId = await autoAssignRoomUnitForBookingTx({
          tx: prisma,
          hotelId: hotel.id,
          roomTypeId: confirmedBooking.roomTypeId,
          checkIn: confirmedBooking.checkIn,
          checkOut: confirmedBooking.checkOut,
          excludeBookingId: bookingId
        });
        if (assignedUnitId) {
          await prisma.booking.update({
            where: { id: bookingId },
            data: { roomUnitId: assignedUnitId }
          });
        }
      }
      await reserveInventoryForBooking({
        tx: prisma,
        hotelId: hotel.id,
        roomTypeId: confirmedBooking.roomTypeId,
        propertyId: confirmedBooking.propertyId,
        checkIn: confirmedBooking.checkIn,
        checkOut: confirmedBooking.checkOut,
        rooms: 1
      });
      const b2 = await prisma.booking.findFirst({
        where: { id: bookingId, hotelId: hotel.id },
        select: { guestId: true, roomUnitId: true, currency: true }
      });
      if (b2) {
        const sess = getSession(req);
        await ensureActiveFolio(prisma, {
          hotelId: hotel.id,
          bookingId,
          guestId: b2.guestId,
          roomUnitId: b2.roomUnitId,
          currency: b2.currency,
          staffId: sess?.staffId ?? null
        });
      }
    }
    autoInvoiceResult = await sendInvoicePdfForBooking({
      hotelId: hotel.id,
      bookingId,
      trigger: "BOOKING_STATUS_TO_CONFIRMED",
      force: false
    });
  }
  const guestForSeg = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    select: { guestId: true }
  });
  if (guestForSeg) {
    await refreshGuestSegmentTagsForGuest(guestForSeg.guestId).catch(() => undefined);
  }
  const query = new URLSearchParams({ updated: "1" });
  if (autoInvoiceResult?.sent) query.set("invoiceSent", "1");
  if (autoInvoiceResult?.error) query.set("invoiceError", autoInvoiceResult.error);
  res.redirect(`/admin/bookings/${encodeURIComponent(bookingId)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/payment", requirePermission("BILLING", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }

  const bookingId = String(req.params.id ?? "");
  const rawStatus = String(req.body.paymentStatus ?? "");
  const allowed: PaymentStatus[] = [
    PaymentStatus.PENDING,
    PaymentStatus.REQUIRES_ACTION,
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.REFUNDED,
    PaymentStatus.LPO,
    PaymentStatus.FRIENDS_TRANSFER
  ];
  const nextPaymentStatus: PaymentStatus | null = allowed.includes(rawStatus as PaymentStatus)
    ? (rawStatus as PaymentStatus)
    : null;

  let invoiceSent = false;
  let invoiceError: string | undefined;
  if (nextPaymentStatus) {
    await prisma.booking.updateMany({
      where: { id: bookingId, hotelId: hotel.id },
      data: { paymentStatus: nextPaymentStatus }
    });
    await logAudit({
      hotelId: hotel.id,
      action: "BOOKING_PAYMENT_UPDATED",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentStatus: nextPaymentStatus }
    });
    if (nextPaymentStatus === PaymentStatus.SUCCEEDED) {
      const invoiceResult = await sendInvoicePdfForBooking({
        hotelId: hotel.id,
        bookingId,
        trigger: "PAYMENT_STATUS_TO_SUCCEEDED",
        force: true
      });
      invoiceSent = invoiceResult.sent;
      invoiceError = invoiceResult.error;
    }
  }
  const query = new URLSearchParams({ updated: "1" });
  if (invoiceSent) query.set("invoiceSent", "1");
  if (invoiceError) query.set("invoiceError", invoiceError.slice(0, 500));
  res.redirect(`/admin/bookings/${encodeURIComponent(bookingId)}?${query.toString()}`);
});

adminRouter.get("/calendar", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Calendar</h2><p>No hotel data found.</p>", true));
    return;
  }

  const today = startOfDay(new Date());
  const requestedStart = parseDateInput(req.query.start, today);
  const view = typeof req.query.view === "string" && ["daily", "weekly", "monthly"].includes(req.query.view)
    ? (req.query.view as "daily" | "weekly" | "monthly")
    : "weekly";
  let start = requestedStart;
  let days: number;
  if (view === "daily") {
    days = 1;
  } else if (view === "monthly") {
    start = new Date(requestedStart.getFullYear(), requestedStart.getMonth(), 1);
    days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  } else {
    days = 7;
  }
  const dates = enumerateDates(start, days);
  const endExclusive = addDays(start, days);
  const roomTypeIds = hotel.roomTypes.map((room) => room.id);

  const inventories = await prisma.inventory.findMany({
    where: { hotelId: hotel.id, roomTypeId: { in: roomTypeIds }, date: { gte: start, lt: endExclusive } }
  });
  const inventoryMap = new Map<string, (typeof inventories)[number]>();
  for (const row of inventories) {
    inventoryMap.set(`${row.roomTypeId}_${formatDateForInput(row.date)}`, row);
  }

  const bookings = await prisma.booking.findMany({
    where: {
      hotelId: hotel.id,
      roomTypeId: { in: roomTypeIds },
      status: { in: ["PENDING", "CONFIRMED"] },
      checkIn: { lt: endExclusive },
      checkOut: { gt: start }
    },
    include: { guest: true, roomType: true },
    orderBy: { checkIn: "asc" }
  });

  const bookingCountMap = new Map<string, number>();
  for (const booking of bookings) {
    for (const date of dates) {
      if (date >= booking.checkIn && date < booking.checkOut) {
        const key = `${booking.roomTypeId}_${formatDateForInput(date)}`;
        bookingCountMap.set(key, (bookingCountMap.get(key) ?? 0) + 1);
      }
    }
  }

  const occupancyByDate = dates.map((date) => {
    const keyDate = formatDateForInput(date);
    let totalRooms = 0;
    let usedRooms = 0;
    for (const room of hotel.roomTypes) {
      const key = `${room.id}_${keyDate}`;
      const inv = inventoryMap.get(key);
      const total = inv?.total ?? room.totalInventory;
      const booked = bookingCountMap.get(key) ?? 0;
      totalRooms += total;
      usedRooms += Math.min(booked, total);
    }
    const ratio = totalRooms ? usedRooms / totalRooms : 0;
    return {
      date: keyDate,
      ratio,
      percent: (ratio * 100).toFixed(0)
    };
  });

  const header = dates.map((date) => `<th>${formatDateForInput(date)}</th>`).join("");
  const rows = hotel.roomTypes
    .map((room) => {
      const cells = dates
        .map((date) => {
          const key = `${room.id}_${formatDateForInput(date)}`;
          const inv = inventoryMap.get(key);
          const booked = bookingCountMap.get(key) ?? 0;
          const total = inv?.total ?? room.totalInventory;
          const reserved = inv?.reserved ?? 0;
          const closedOut = inv?.closedOut ?? false;
          const available = closedOut ? 0 : Math.max(total - Math.max(reserved, booked), 0);
          const cls = closedOut ? "alert" : available <= 1 ? "pending" : "ok";
          const label = closedOut ? "Closed" : `A:${available} B:${booked}`;
          return `<td><span class="badge ${cls}">${label}</span></td>`;
        })
        .join("");
      return `<tr><th>${escapeHtml(room.name)}</th>${cells}</tr>`;
    })
    .join("");

  const timelineRows = bookings
    .map((booking) => {
      const cells = dates
        .map((date) => {
          const inStay = date >= booking.checkIn && date < booking.checkOut;
          const edgeStart = formatDateForInput(date) === formatDateForInput(booking.checkIn);
          const edgeEnd = formatDateForInput(addDays(date, 1)) === formatDateForInput(booking.checkOut);
          if (!inStay) return '<td style="background:#fff"></td>';
          const bg = booking.status === "CONFIRMED" ? "#128c7e" : "#7dd3fc";
          const radiusLeft = edgeStart ? "8px" : "0";
          const radiusRight = edgeEnd ? "8px" : "0";
          return `<td style="padding:4px"><div title="${escapeHtml(booking.id)}" style="height:14px; background:${bg}; border-radius:${radiusLeft} ${radiusRight} ${radiusRight} ${radiusLeft}"></div></td>`;
        })
        .join("");
      return `<tr>
        <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">${escapeHtml(booking.id.slice(0, 10))}</a></td>
        <td>${escapeHtml(booking.guest.fullName ?? booking.guest.phoneE164)}</td>
        <td>${escapeHtml(booking.roomType.name)}</td>
        ${cells}
      </tr>`;
    })
    .join("");

  const content = `
<h2>Room Calendar</h2>
<p class="muted">Date-by-date room view showing availability and booked rooms.</p>
<div style="margin:10px 0 12px">
  <h3 style="margin-bottom:6px">Occupancy Heatmap</h3>
  <div style="display:grid; grid-template-columns: repeat(${dates.length}, minmax(0, 1fr)); gap:6px">
    ${occupancyByDate
      .map((item) => {
        const alpha = Math.max(0.1, Math.min(0.95, item.ratio));
        return `<div title="${item.date}: ${item.percent}% occupied" style="height:34px; border-radius:8px; border:1px solid #d8dee6; background: rgba(11,110,110,${alpha}); color:#fff; font-size:11px; display:flex; align-items:center; justify-content:center">${item.percent}%</div>`;
      })
      .join("")}
  </div>
</div>
<form method="get" action="/admin/calendar" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Start <input type="date" name="start" value="${formatDateForInput(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>View
    <select name="view" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="daily" ${view === "daily" ? "selected" : ""}>Daily</option>
      <option value="weekly" ${view === "weekly" ? "selected" : ""}>Weekly</option>
      <option value="monthly" ${view === "monthly" ? "selected" : ""}>Monthly</option>
    </select>
  </label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Show</button>
</form>
<table>
  <thead><tr><th>Room Type</th>${header}</tr></thead>
  <tbody>${rows || '<tr><td colspan="8">No room types found.</td></tr>'}</tbody>
</table>
<section style="margin-top:14px">
  <h3>Booking Timeline</h3>
  <p class="muted">Bars show booking stay span across the selected ${view} range.</p>
  <table>
    <thead><tr><th>Booking</th><th>Guest</th><th>Room</th>${header}</tr></thead>
    <tbody>${timelineRows || `<tr><td colspan="${dates.length + 3}">No bookings in this range.</td></tr>`}</tbody>
  </table>
</section>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get(
  "/conversations/live/activity",
  requirePermissionJson("CONVERSATIONS", "VIEW"),
  async (req, res) => {
    const hotel = await prisma.hotel.findUnique({
      where: { slug: "al-ashkhara-beach-resort" },
      select: { id: true }
    });
    if (!hotel) {
      res.status(404).json({ ok: false, error: "hotel_not_found" });
      return;
    }
    const sinceParam = typeof req.query.since === "string" ? req.query.since : "";
    let since = new Date(Date.now() - 60_000);
    if (sinceParam.trim()) {
      const parsed = new Date(sinceParam);
      if (!Number.isNaN(parsed.getTime())) since = parsed;
    }

    const [newConvs, inboundMessages] = await Promise.all([
      prisma.conversation.findMany({
        where: { hotelId: hotel.id, createdAt: { gt: since } },
        include: {
          guest: true,
          bookings: { take: 1, select: { id: true } },
          messages: { orderBy: { createdAt: "asc" }, take: 1 }
        },
        orderBy: { createdAt: "asc" }
      }),
      prisma.message.findMany({
        where: {
          hotelId: hotel.id,
          direction: MessageDirection.INBOUND,
          createdAt: { gt: since }
        },
        include: {
          conversation: {
            include: { guest: true, bookings: { take: 1, select: { id: true } } }
          }
        },
        orderBy: { createdAt: "asc" }
      })
    ]);

    const firstMsgIds = new Set<string>();
    for (const c of newConvs) {
      const m0 = c.messages[0];
      if (m0?.id) firstMsgIds.add(m0.id);
    }

    type ActivityEvent = {
      type: "conversation_started" | "guest_message";
      conversationId: string;
      sortKey: string;
      title: string;
      preview: string;
      category: "booking" | "inquiry";
    };
    const events: ActivityEvent[] = [];

    for (const c of newConvs) {
      const hasBooking = c.bookings.length > 0;
      const category = classifyConversationActivity(c.state, hasBooking);
      const guestLabel = c.guest.fullName ?? c.guest.phoneE164;
      const preview = (c.messages[0]?.body ?? "").slice(0, 140);
      const title =
        category === "booking" ? `New chat: ${guestLabel} (booking)` : `New guest chat: ${guestLabel}`;
      events.push({
        type: "conversation_started",
        conversationId: c.id,
        sortKey: c.createdAt.toISOString(),
        title,
        preview,
        category
      });
    }

    for (const m of inboundMessages) {
      if (firstMsgIds.has(m.id)) continue;
      const conv = m.conversation;
      const hasBooking = conv.bookings.length > 0;
      const category = classifyConversationActivity(conv.state, hasBooking);
      const guestLabel = conv.guest.fullName ?? conv.guest.phoneE164;
      const preview = m.body.slice(0, 140);
      const bookingRef = conv.bookings[0]?.id;
      let title: string;
      if (m.aiIntent === "PRE_ARRIVAL_GUEST_REPLY" || m.aiIntent === "GUEST_JOURNEY_REPLY") {
        title = `Guest journey reply · ${guestLabel}${bookingRef ? ` · ${bookingRef.slice(0, 10)}` : ""}`;
      } else {
        title = category === "booking" ? `Booking message (${guestLabel})` : `Guest message (${guestLabel})`;
      }
      const journeyIntent = m.aiIntent === "PRE_ARRIVAL_GUEST_REPLY" || m.aiIntent === "GUEST_JOURNEY_REPLY";
      events.push({
        type: "guest_message",
        conversationId: m.conversationId,
        sortKey: m.createdAt.toISOString(),
        title,
        preview,
        category: category === "booking" || journeyIntent ? "booking" : category
      });
    }

    events.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      events: events.map((e) => ({
        type: e.type,
        conversationId: e.conversationId,
        title: e.title,
        preview: e.preview,
        category: e.category
      }))
    });
  }
);

adminRouter.get(
  "/conversations/live/:conversationId/messages",
  requirePermissionJson("CONVERSATIONS", "VIEW"),
  async (req, res) => {
    const hotel = await prisma.hotel.findUnique({
      where: { slug: "al-ashkhara-beach-resort" },
      select: { id: true }
    });
    if (!hotel) {
      res.status(404).json({ ok: false, error: "hotel_not_found" });
      return;
    }
    const conversationId = String(req.params.conversationId ?? "");
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, hotelId: hotel.id },
      select: { id: true }
    });
    if (!conversation) {
      res.status(404).json({ ok: false, error: "not_found" });
      return;
    }
    const sinceRaw = typeof req.query.since === "string" ? req.query.since.trim() : "";
    if (!sinceRaw) {
      res.json({ ok: true, messages: [] });
      return;
    }
    const sinceDate = new Date(sinceRaw);
    if (Number.isNaN(sinceDate.getTime())) {
      res.json({ ok: true, messages: [] });
      return;
    }
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        hotelId: hotel.id,
        createdAt: { gt: sinceDate }
      },
      orderBy: { createdAt: "asc" }
    });
    res.json({ ok: true, messages });
  }
);

adminRouter.get("/conversations", requirePermission("CONVERSATIONS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: platformHotelSlug } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Conversations</h2><p>No hotel data found.</p>", true));
    return;
  }

  const activePropertyId = await resolveActivePropertyIdForHotel(req, hotel.id);
  const now = startOfDay(new Date());
  const defaultStart = addDays(now, -30);
  const defaultEnd = now;
  const start = parseDateInput(req.query.start, defaultStart);
  const end = parseDateInput(req.query.end, defaultEnd);
  const endExclusive = addDays(end, 1);

  const state = typeof req.query.state === "string" ? req.query.state : "ALL";
  const allowedStates: ConversationState[] = [
    ConversationState.NEW,
    ConversationState.QUALIFYING,
    ConversationState.QUOTED,
    ConversationState.PAYMENT_PENDING,
    ConversationState.CONFIRMED,
    ConversationState.CLOSED
  ];
  const selectedState: ConversationState | null = allowedStates.includes(state as ConversationState)
    ? (state as ConversationState)
    : null;

  const conversations = await prisma.conversation.findMany({
    where: {
      hotelId: hotel.id,
      ...(isScopedPropertyId(activePropertyId) ? { propertyId: activePropertyId } : {}),
      createdAt: { gte: start, lt: endExclusive },
      ...(selectedState ? { state: selectedState } : {})
    },
    include: {
      guest: true,
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1
      },
      bookings: {
        orderBy: { createdAt: "desc" },
        take: 1
      }
    },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }]
  });

  const rows = conversations
    .map((conversation) => {
      const latestMessage = conversation.messages[0];
      const latestBooking = conversation.bookings[0];
      const agentBadge = (conversation as { agentHandoffAt?: Date | null }).agentHandoffAt
        ? ' <span class="badge alert" title="Guest requested human agent">Agent handoff</span>'
        : "";
      return `<tr>
      <td><a class="inline-link" href="/admin/conversations/${encodeURIComponent(conversation.id)}">${escapeHtml(
        conversation.guest.fullName ?? conversation.guest.phoneE164
      )}</a></td>
      <td>${escapeHtml(conversation.guest.phoneE164)}</td>
      <td>${latestMessage ? escapeHtml(latestMessage.body.slice(0, 90)) : "-"}</td>
      <td><span class="badge ${getConversationBadgeClass(conversation.state)}">${escapeHtml(conversation.state)}</span>${agentBadge}</td>
      <td>${latestBooking ? `<a class="inline-link" href="/admin/bookings/${encodeURIComponent(latestBooking.id)}">${escapeHtml(latestBooking.id)}</a>` : "-"}</td>
      <td>${formatDateTime(conversation.lastMessageAt ?? conversation.createdAt)}</td>
      <td><a class="inline-link" href="/admin/conversations/${encodeURIComponent(conversation.id)}">Open details</a></td>
      </tr>`;
    })
    .join("");

  const content = `
<h2 data-admin-conversations-index="1">Conversations</h2>
<p class="muted">Guest WhatsApp conversations with full history and action controls. Results are filtered by the selected date range (conversation created date). <strong>New messages poll every 8 seconds</strong> while you are logged in; the list refreshes when activity arrives.</p>
<form method="get" action="/admin/conversations" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>From <input type="date" name="start" value="${formatDateForInput(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>To <input type="date" name="end" value="${formatDateForInput(end)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>State
    <select name="state" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="ALL" ${state === "ALL" ? "selected" : ""}>All</option>
      <option value="NEW" ${state === "NEW" ? "selected" : ""}>New</option>
      <option value="QUALIFYING" ${state === "QUALIFYING" ? "selected" : ""}>Qualifying</option>
      <option value="QUOTED" ${state === "QUOTED" ? "selected" : ""}>Quoted</option>
      <option value="PAYMENT_PENDING" ${state === "PAYMENT_PENDING" ? "selected" : ""}>Payment pending</option>
      <option value="CONFIRMED" ${state === "CONFIRMED" ? "selected" : ""}>Confirmed</option>
      <option value="CLOSED" ${state === "CLOSED" ? "selected" : ""}>Closed</option>
    </select>
  </label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
</form>
<p class="muted" style="margin-bottom:10px">Showing <strong>${conversations.length}</strong> conversation(s) in range ${formatDateForInput(start)} – ${formatDateForInput(end)}.</p>
<table>
  <thead><tr><th>Guest</th><th>Phone</th><th>Latest Message</th><th>State</th><th>Linked Booking</th><th>Last Activity</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No conversations in this date range.</td></tr>'}</tbody>
</table>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/conversations/:id", requirePermission("CONVERSATIONS", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Conversation</h2><p>No hotel data found.</p>", true));
    return;
  }

  const conversationId = String(req.params.id ?? "");
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, hotelId: hotel.id },
    include: {
      guest: { include: { segmentTags: { orderBy: { tag: "asc" } } } },
      property: true,
      messages: { orderBy: { createdAt: "asc" } },
      bookings: { orderBy: { createdAt: "desc" }, include: { roomType: true } }
    }
  });

  if (!conversation) {
    res
      .status(404)
      .type("html")
      .send(renderLayout(`<h2>Conversation ${escapeHtml(conversationId)}</h2><p>Conversation not found.</p>`, true));
    return;
  }

  const agentHandoffAt = (conversation as { agentHandoffAt?: Date | null }).agentHandoffAt;
  const handledByHuman = Boolean(agentHandoffAt);
  const handlerLabel = handledByHuman ? "Human receptionist" : "AI";
  const handlerBadgeClass = handledByHuman ? "badge alert" : "badge ok";

  const updatedNotice = req.query.updated ? '<p class="badge ok">Conversation updated.</p>' : "";
  const replyError = req.query.replyError ? `<p class="badge alert">${escapeHtml(decodeURIComponent(String(req.query.replyError)))}</p>` : "";

  const messageTimeline = conversation.messages
    .map(
      (message) => {
        const isInbound = message.direction === MessageDirection.INBOUND;
        const senderLabel = isInbound ? "Guest" : (message.aiIntent === "MANUAL_REPLY" ? "Staff" : "AI");
        return `<article class="bubble ${isInbound ? "inbound" : "outbound"}">
      <div class="bubble-head">
        <span><strong>${escapeHtml(senderLabel)}</strong></span>
        <span>${formatDateTime(message.createdAt)}</span>
      </div>
      <p class="bubble-body">${escapeHtml(message.body)}</p>
      ${message.aiIntent && message.aiIntent !== "MANUAL_REPLY" ? `<p class="bubble-meta">Intent: ${escapeHtml(message.aiIntent)}</p>` : ""}
      </article>`;
      }
    )
    .join("");

  const linkedBookingRows = conversation.bookings
    .map(
      (booking) => `<tr>
      <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">${escapeHtml(booking.id)}</a></td>
      <td>${escapeHtml(booking.roomType.name)}</td>
      <td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}</td>
      <td><span class="badge ${getBadgeClass(booking.status)}">${escapeHtml(booking.status)}</span></td>
      </tr>`
    )
    .join("");

  const lastMsgAt =
    conversation.messages.length > 0
      ? conversation.messages[conversation.messages.length - 1].createdAt.toISOString()
      : new Date(conversation.createdAt.getTime() - 1).toISOString();

  const content = `
<h2>Conversation</h2>
<p class="muted" style="margin-top:0">Thread updates automatically every <strong>8 seconds</strong> while this page is open.</p>
${updatedNotice}
${replyError}
<div class="actions" style="margin-bottom:12px">
  <a class="btn-link" href="/admin/conversations">Back to conversations</a>
  <a class="btn-link" href="/admin/bookings">Open booking report</a>
  <a class="btn-link" href="/admin/inventory">Check room availability</a>
  <a class="btn-link" href="/admin/conversations/${encodeURIComponent(conversation.id)}/create-booking">Start structured booking flow</a>
</div>

<div class="chat-layout" style="display:grid; grid-template-columns:1fr 280px; gap:16px; align-items:start; max-width:1200px;">
  <div class="chat-main" data-chat-conversation-id="${escapeHtml(conversation.id)}" data-chat-last-msg-at="${escapeHtml(lastMsgAt)}" style="background:var(--card); border:1px solid var(--border); border-radius:12px; overflow:hidden; display:flex; flex-direction:column; min-height:420px;">
    <div class="chat-header" style="padding:12px 16px; border-bottom:1px solid var(--border); background:#f8fafc; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
      <div style="flex:1; min-width:200px">
        <div>
          <strong style="font-size:15px;">${escapeHtml(conversation.guest.fullName ?? "Guest")}</strong>
          <span class="muted" style="font-size:13px; margin-left:8px;">${escapeHtml(conversation.guest.phoneE164)}</span>
        </div>
        <div style="margin-top:8px; font-size:12px; line-height:1.55">${formatGuestVipAndTagsHtml({
          guestId: conversation.guest.id,
          isVip: conversation.guest.isVip,
          vipNote: conversation.guest.vipNote,
          tags: conversation.guest.segmentTags,
          showProfileLink: true
        })}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="badge ${getConversationBadgeClass(conversation.state)}" style="margin:0;">${escapeHtml(conversation.state)}</span>
        <span class="${handlerBadgeClass}" title="${handledByHuman ? "Guest requested human; staff is handling" : "Chatbot is handling"}">Handled by: ${escapeHtml(handlerLabel)}</span>
      </div>
    </div>
    <div class="chat-messages" style="flex:1; overflow-y:auto; padding:16px; min-height:240px; max-height:50vh;">
      <div class="timeline" style="display:flex; flex-direction:column; gap:10px;">${messageTimeline || '<p class="muted">No messages yet.</p>'}</div>
    </div>
    <div class="chat-reply" style="padding:12px 16px; border-top:1px solid var(--border); background:#f8fafc;">
      <form method="post" action="/admin/conversations/${encodeURIComponent(conversation.id)}/reply" style="display:flex; gap:10px; align-items:flex-end;">
        <textarea name="replyBody" required rows="2" style="flex:1; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font-family:inherit; font-size:14px; resize:vertical; min-height:44px;" placeholder="Type a message… e.g. What time will you arrive? Your booking is confirmed."></textarea>
        <button type="submit" style="padding:10px 18px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700; cursor:pointer; white-space:nowrap;">Send</button>
      </form>
      <p class="muted" style="font-size:12px; margin:8px 0 0;">Replies are sent to the guest via WhatsApp.</p>
    </div>
  </div>
  <aside class="chat-sidebar" style="display:flex; flex-direction:column; gap:12px;">
    <section style="background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px;">
      <h3 style="margin:0 0 10px; font-size:14px;">Guest & State</h3>
      <table style="min-width:0; margin:0;">
        <tbody>
          <tr><th style="width:30%;">Guest</th><td>${escapeHtml(conversation.guest.fullName ?? "-")}</td></tr>
          <tr><th>Phone</th><td>${escapeHtml(conversation.guest.phoneE164)}</td></tr>
          <tr><th>Property</th><td>${escapeHtml(conversation.property?.name ?? "Not assigned")}</td></tr>
          <tr><th>Last activity</th><td>${formatDateTime(conversation.lastMessageAt ?? conversation.updatedAt)}</td></tr>
        </tbody>
      </table>
    </section>
    <section style="background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px;">
      <h3 style="margin:0 0 10px; font-size:14px;">Conversation mode</h3>
      <p style="margin:0 0 10px; font-size:13px;"><span class="${handlerBadgeClass}">Handled by: ${escapeHtml(handlerLabel)}</span></p>
      ${handledByHuman ? `
      <form method="post" action="/admin/conversations/${encodeURIComponent(conversation.id)}/end-agent-handoff">
        <button type="submit" style="width:100%; padding:9px 12px; border:0; border-radius:8px; background:#6b7280; color:#fff; font-weight:700;">Return to AI Mode</button>
      </form>
      <p class="muted" style="font-size:12px; margin:8px 0 0;">Chatbot will respond to the guest again.</p>
      ` : `
      <form method="post" action="/admin/conversations/${encodeURIComponent(conversation.id)}/switch-to-receptionist">
        <button type="submit" style="width:100%; padding:9px 12px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700;">Switch to Receptionist Mode</button>
      </form>
      <p class="muted" style="font-size:12px; margin:8px 0 0;">Chatbot will stop; staff handles replies.</p>
      `}
    </section>
    <section style="background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px;">
      <h3 style="margin:0 0 10px; font-size:14px;">State</h3>
      <form method="post" action="/admin/conversations/${encodeURIComponent(conversation.id)}/state" style="display:grid; gap:8px;">
        <select name="state" style="padding:8px; border:1px solid var(--border); border-radius:8px;">
          <option value="NEW" ${conversation.state === "NEW" ? "selected" : ""}>New</option>
          <option value="QUALIFYING" ${conversation.state === "QUALIFYING" ? "selected" : ""}>Qualifying</option>
          <option value="QUOTED" ${conversation.state === "QUOTED" ? "selected" : ""}>Quoted</option>
          <option value="PAYMENT_PENDING" ${conversation.state === "PAYMENT_PENDING" ? "selected" : ""}>Payment pending</option>
          <option value="CONFIRMED" ${conversation.state === "CONFIRMED" ? "selected" : ""}>Confirmed</option>
          <option value="CLOSED" ${conversation.state === "CLOSED" ? "selected" : ""}>Closed</option>
        </select>
        <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#25d366; color:#083d2d; font-weight:700;">Update</button>
      </form>
    </section>
    <section style="background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px;">
      <h3 style="margin:0 0 10px; font-size:14px;">Linked Bookings</h3>
      <table style="min-width:0; margin:0; font-size:12px;">
        <thead><tr><th>Booking</th><th>Room</th><th>Stay</th><th>Status</th></tr></thead>
        <tbody>${linkedBookingRows || '<tr><td colspan="4">None</td></tr>'}</tbody>
      </table>
    </section>
  </aside>
</div>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/conversations/:id/switch-to-receptionist", requirePermission("CONVERSATIONS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/conversations");
    return;
  }
  const conversationId = String(req.params.id ?? "");
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, hotelId: hotel.id },
    include: { guest: true }
  });
  if (!conversation) {
    res.redirect("/admin/conversations");
    return;
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { agentHandoffAt: new Date() } as import("@prisma/client").Prisma.ConversationUpdateInput
  });
  const session = await prisma.conversationSession.findUnique({
    where: { hotelId_guestId: { hotelId: conversation.hotelId, guestId: conversation.guestId } }
  });
  if (session?.metadataJson) {
    try {
      const meta = JSON.parse(session.metadataJson) as Record<string, unknown>;
      meta.conversationMode = "AGENT_MODE";
      await prisma.conversationSession.update({
        where: { hotelId_guestId: { hotelId: conversation.hotelId, guestId: conversation.guestId } },
        data: { metadataJson: JSON.stringify(meta) }
      });
    } catch {
      // ignore parse error
    }
  }
  const handoffBody = guestReceptionistHandoffMessage(hotel.displayName);
  const toPhone = normalizePhoneForWhatsApp(conversation.guest.phoneE164);
  const partner = loadPartnerSetupConfig(hotel.id);
  if (toPhone) {
    try {
      await sendWhatsAppText({
        to: toPhone,
        body: handoffBody,
        phoneNumberId: partner.whatsappPhoneNumberId || undefined
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: handoffBody,
          aiIntent: "STAFF_HANDOFF_NOTICE"
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    } catch {
      // guest still sees handoff in UI; WhatsApp send is best-effort
    }
  }
  await logAudit({
    hotelId: hotel.id,
    action: "CONVERSATION_SWITCHED_TO_RECEPTIONIST",
    entityType: "Conversation",
    entityId: conversation.id,
    metadata: {}
  });
  res.redirect(`/admin/conversations/${encodeURIComponent(conversation.id)}?updated=1`);
});

adminRouter.post("/conversations/:id/end-agent-handoff", requirePermission("CONVERSATIONS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/conversations");
    return;
  }
  const conversationId = String(req.params.id ?? "");
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, hotelId: hotel.id },
    include: { guest: true }
  });
  if (!conversation) {
    res.redirect("/admin/conversations");
    return;
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { agentHandoffAt: null } as import("@prisma/client").Prisma.ConversationUpdateInput
  });
  const session = await prisma.conversationSession.findUnique({
    where: { hotelId_guestId: { hotelId: conversation.hotelId, guestId: conversation.guestId } }
  });
  if (session?.metadataJson) {
    try {
      const meta = JSON.parse(session.metadataJson) as Record<string, unknown>;
      meta.conversationMode = "IDLE";
      await prisma.conversationSession.update({
        where: { hotelId_guestId: { hotelId: conversation.hotelId, guestId: conversation.guestId } },
        data: { metadataJson: JSON.stringify(meta) }
      });
    } catch {
      // ignore parse error
    }
  }
  const resumeBody = guestChatbotResumeMessage(hotel.displayName);
  const toPhone = normalizePhoneForWhatsApp(conversation.guest.phoneE164);
  const partner = loadPartnerSetupConfig(hotel.id);
  if (toPhone) {
    try {
      await sendWhatsAppText({
        to: toPhone,
        body: resumeBody,
        phoneNumberId: partner.whatsappPhoneNumberId || undefined
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: resumeBody,
          aiIntent: "STAFF_CHATBOT_RESUME"
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    } catch {
      // best-effort guest notice
    }
  }
  res.redirect(`/admin/conversations/${encodeURIComponent(conversation.id)}?updated=1`);
});

adminRouter.post("/conversations/:id/state", requirePermission("CONVERSATIONS", "EDIT"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/conversations");
    return;
  }

  const conversationId = String(req.params.id ?? "");
  const rawState = String(req.body.state ?? "");
  const allowed: ConversationState[] = [
    ConversationState.NEW,
    ConversationState.QUALIFYING,
    ConversationState.QUOTED,
    ConversationState.PAYMENT_PENDING,
    ConversationState.CONFIRMED,
    ConversationState.CLOSED
  ];
  const nextState: ConversationState | null = allowed.includes(rawState as ConversationState)
    ? (rawState as ConversationState)
    : null;

  if (nextState) {
    await prisma.conversation.updateMany({
      where: { id: conversationId, hotelId: hotel.id },
      data: { state: nextState }
    });
    await logAudit({
      hotelId: hotel.id,
      action: "CONVERSATION_STATE_UPDATED",
      entityType: "Conversation",
      entityId: conversationId,
      metadata: { state: nextState }
    });
  }

  res.redirect(`/admin/conversations/${encodeURIComponent(conversationId)}?updated=1`);
});

adminRouter.post("/conversations/:id/reply", requirePermission("CONVERSATIONS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/conversations");
    return;
  }

  const conversationId = String(req.params.id ?? "");
  const replyBody = String(req.body.replyBody ?? "").trim();
  if (!replyBody) {
    res.redirect(`/admin/conversations/${encodeURIComponent(conversationId)}`);
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, hotelId: hotel.id },
    include: { guest: true }
  });
  if (!conversation) {
    res.redirect("/admin/conversations");
    return;
  }

  const config = loadPartnerSetupConfig(hotel.id);
  const phoneNumberId = config.whatsappPhoneNumberId || undefined;
  const toPhone = String(conversation.guest.phoneE164).replace(/\D/g, "");

  try {
    await sendWhatsAppText({
      to: toPhone,
      body: replyBody,
      phoneNumberId,
      conversationId: conversation.id
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.redirect(
      `/admin/conversations/${encodeURIComponent(conversationId)}?replyError=${encodeURIComponent(message.slice(0, 200))}`
    );
    return;
  }

  await prisma.message.create({
    data: {
      hotelId: hotel.id,
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      body: replyBody,
      aiIntent: "MANUAL_REPLY"
    }
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() }
  });
  await logAudit({
    hotelId: hotel.id,
    action: "CONVERSATION_REPLY_SENT",
    entityType: "Conversation",
    entityId: conversation.id,
    metadata: { bodyPreview: replyBody.slice(0, 120) }
  });

  res.redirect(`/admin/conversations/${encodeURIComponent(conversationId)}?updated=1`);
});

adminRouter.get("/conversations/:id/create-booking", requirePermission("BOOKINGS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/conversations");
    return;
  }
  const conversationId = String(req.params.id ?? "");
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, hotelId: hotel.id },
    include: { guest: true }
  });
  if (!conversation) {
    res.redirect("/admin/conversations");
    return;
  }
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: hotel.id, isActive: true },
    orderBy: { baseNightlyRate: "asc" }
  });

  const defaultCheckIn = formatDate(addDays(startOfDay(new Date()), 1));
  const defaultCheckOut = formatDate(addDays(startOfDay(new Date()), 3));
  const roomOptions = roomTypes
    .map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)} (${formatMoney(room.baseNightlyRate, hotel.currency)})</option>`)
    .join("");

  const content = `
<h2>Create Booking from Conversation</h2>
<p class="muted">Capture guest details and stay preferences before selecting a room unit.</p>
${renderBookingWizard(1, { conversationId: conversation.id })}
<div class="actions">
  <a class="btn-link" href="/admin/conversations/${encodeURIComponent(conversation.id)}">Back to conversation</a>
  <a class="btn-link" href="/admin/bookings">Open booking report</a>
</div>
<form method="post" action="/admin/conversations/${encodeURIComponent(conversation.id)}/create-booking" style="max-width:640px; display:grid; gap:8px">
  <label>Guest full name
    <input type="text" name="guestFullName" value="${escapeHtml(conversation.guest.fullName ?? "")}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
  </label>
  <label>Guest phone
    <input type="text" value="${escapeHtml(conversation.guest.phoneE164)}" disabled style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px; background:#f8fafc" />
  </label>
  <label>Room type
    <select name="roomTypeId" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">
      ${roomOptions}
    </select>
  </label>
  <div class="grid-2">
    <label>Check-in
      <input type="date" name="checkIn" value="${defaultCheckIn}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
    <label>Check-out
      <input type="date" name="checkOut" value="${defaultCheckOut}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
  </div>
  <div class="grid-2">
    <label>Adults
      <input type="number" name="adults" value="2" min="1" max="8" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
    <label>Children
      <input type="number" name="children" value="0" min="0" max="6" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
  </div>
  <button type="submit" style="padding:10px 14px; border:0; border-radius:10px; background:#128c7e; color:#fff; font-weight:700">Create Draft Booking</button>
</form>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/conversations/:id/create-booking", requirePermission("BOOKINGS", "CREATE"), async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/conversations");
    return;
  }

  const conversationId = String(req.params.id ?? "");
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, hotelId: hotel.id },
    include: { guest: true }
  });
  if (!conversation) {
    res.redirect("/admin/conversations");
    return;
  }

  const guestFullName = String(req.body.guestFullName ?? "").trim();
  const roomTypeId = String(req.body.roomTypeId ?? "");
  const checkIn = parseDateInput(req.body.checkIn, addDays(startOfDay(new Date()), 1));
  const checkOut = parseDateInput(req.body.checkOut, addDays(checkIn, 2));
  const adults = clamp(parseIntegerInput(req.body.adults, 2), 1, 8);
  const children = clamp(parseIntegerInput(req.body.children, 0), 0, 6);

  const roomType = await prisma.roomType.findFirst({
    where: { id: roomTypeId, hotelId: hotel.id, isActive: true }
  });
  if (!roomType) {
    res.redirect(`/admin/conversations/${encodeURIComponent(conversationId)}/create-booking`);
    return;
  }
  const nights = Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / (24 * 60 * 60 * 1000)));
  const normalizedCheckOut = addDays(checkIn, nights);
  const totalAmount = Number((roomType.baseNightlyRate * nights).toFixed(2));
  const bookingId = buildBookingId();

  if (guestFullName) {
    await prisma.guest.update({
      where: { id: conversation.guestId },
      data: { fullName: guestFullName }
    });
  }

  const booking = await prisma.$transaction(async (tx) => {
    const referenceCode = await allocateBookingReferenceCode(tx, {
      hotelId: hotel.id,
      source: ChannelProvider.WHATSAPP,
      refDate: new Date()
    });
    return tx.booking.create({
      data: {
        id: bookingId,
        hotelId: hotel.id,
        propertyId: roomType.propertyId,
        roomTypeId: roomType.id,
        guestId: conversation.guestId,
        conversationId: conversation.id,
        checkIn,
        checkOut: normalizedCheckOut,
        nights,
        adults,
        children,
        totalAmount,
        currency: hotel.currency,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
        source: ChannelProvider.WHATSAPP,
        referenceCode
      }
    });
  });

  await recordBookingStatusChange(prisma, {
    hotelId: hotel.id,
    bookingId: booking.id,
    fromStatus: null,
    toStatus: BookingStatus.PENDING,
    source: "CONVERSATION_WIZARD"
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      state: ConversationState.QUALIFYING
    }
  });

  await prisma.message.create({
    data: {
      hotelId: hotel.id,
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      body: buildTemplateMessage(
        loadPartnerSetupConfig(hotel.id).instantWelcomeTemplate,
        {
          hotel_name: hotel.displayName,
          guest_name: guestFullName || conversation.guest.fullName || "Guest",
          check_in: formatDate(checkIn),
          check_out: formatDate(normalizedCheckOut),
          booking_id: booking.id
        },
        `Front desk captured guest details and created draft booking ${booking.id}. Next step: select room unit and confirm.`
      ),
      aiIntent: "BOOKING_CREATED"
    }
  });

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_CREATED_FROM_CONVERSATION",
    entityType: "Booking",
    entityId: booking.id,
    bookingId: booking.id,
    metadata: {
      conversationId: conversation.id,
      guestId: conversation.guestId,
      roomTypeId: roomType.id,
      guestFullName: guestFullName || conversation.guest.fullName || "",
      checkIn: formatDate(checkIn),
      checkOut: formatDate(normalizedCheckOut),
      adults,
      children,
      totalAmount,
      currency: hotel.currency
    }
  });

  await refreshGuestSegmentTagsForGuest(conversation.guestId).catch(() => undefined);

  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}/select-unit`);
});

adminRouter.get("/subscription", requirePermission("BILLING", "VIEW"), async (_req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    include: {
      subscriptions: {
        where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        orderBy: { createdAt: "desc" },
        include: { plan: true },
        take: 1
      },
      properties: true,
      roomTypes: true,
      conversations: {
        where: {
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          }
        }
      },
      invoices: { orderBy: { createdAt: "desc" }, take: 10 },
      paymentIntents: { orderBy: { createdAt: "desc" }, take: 10 }
    }
  });

  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Subscription</h2><p>No hotel data found.</p>", true));
    return;
  }

  const sub = hotel.subscriptions[0];
  const subscriptionStart = sub?.currentPeriodStart ?? sub?.startedAt ?? sub?.createdAt;

  const paymentHistoryRows = hotel.paymentIntents
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.id.slice(0, 12))}</td>
        <td>${formatDateTime(p.createdAt)}</td>
        <td>${p.amount} ${escapeHtml(p.currency)}</td>
        <td>${escapeHtml(p.kind)}</td>
        <td><span class="badge ${p.status === "SUCCEEDED" ? "ok" : "pending"}">${escapeHtml(p.status)}</span></td>
      </tr>`
    )
    .join("");

  const statementRows = hotel.invoices
    .map(
      (inv) => `<tr>
        <td><a class="inline-link" href="/admin/billing">${escapeHtml(inv.id.slice(0, 12))}</a></td>
        <td>${formatDate(inv.createdAt)}</td>
        <td>${inv.amountTotal} ${escapeHtml(inv.currency)}</td>
        <td><span class="badge ${inv.status === "PAID" ? "ok" : "pending"}">${escapeHtml(inv.status)}</span></td>
        <td>${inv.paidAt ? formatDate(inv.paidAt) : "—"}</td>
      </tr>`
    )
    .join("");

  const content = `
<h2>Subscription</h2>
<p class="muted">Live subscription status for ${escapeHtml(hotel.displayName)}.</p>
<div class="actions">
  <a class="btn-link primary" href="/admin/billing">Open Billing</a>
  <a class="btn-link" href="/admin/bookings?start=${reportStartDefault}&end=${reportEndDefault}">Open Monthly Report</a>
  <a class="btn-link" href="/admin/integrations">Open Integrations</a>
</div>
<div class="grid-2">
  <section>
    <h3>Current Plan</h3>
    <table>
      <tbody>
        <tr><th>Plan type</th><td>${escapeHtml(sub?.plan.name ?? "No active plan")}${sub?.plan.code ? ` (${escapeHtml(sub.plan.code)})` : ""}</td></tr>
        <tr><th>Price</th><td>${sub ? `${sub.plan.monthlyPrice} ${escapeHtml(hotel.currency)} / month` : "-"}</td></tr>
        <tr><th>Status</th><td><span class="badge ${sub?.status === "ACTIVE" ? "ok" : "pending"}">${escapeHtml(sub?.status ?? "NONE")}</span></td></tr>
        <tr><th>Subscription start date</th><td>${subscriptionStart ? formatDate(subscriptionStart) : "—"}</td></tr>
        <tr><th>Renewal date</th><td>${formatDate(sub?.currentPeriodEnd)}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Current Usage</h3>
    <table>
      <tbody>
        <tr><th>Properties</th><td><a class="inline-link" href="/admin/integrations">${hotel.properties.length} / ${sub?.plan.maxProperties ?? "-"}</a></td></tr>
        <tr><th>Room types</th><td><a class="inline-link" href="/admin/rooms">${hotel.roomTypes.length} / ${sub?.plan.maxRoomTypes ?? "-"}</a></td></tr>
        <tr><th>WhatsApp conversations (month)</th><td><a class="inline-link" href="/admin/conversations">${hotel.conversations.length} / ${sub?.plan.maxMonthlyConversations ?? "-"}</a></td></tr>
        <tr><th>Channel manager access</th><td>${sub?.plan.supportsChannelManager ? "Enabled" : "Not enabled"}</td></tr>
      </tbody>
    </table>
  </section>
</div>
<section style="margin-top: 14px">
  <h3>Payment history</h3>
  <table>
    <thead><tr><th>ID</th><th>Date</th><th>Amount</th><th>Kind</th><th>Status</th></tr></thead>
    <tbody>${paymentHistoryRows || '<tr><td colspan="5">No payment history yet.</td></tr>'}</tbody>
  </table>
  <p><a class="btn-link" href="/admin/billing">View all payments</a></p>
</section>
<section style="margin-top: 14px">
  <h3>Billing statements</h3>
  <table>
    <thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th><th>Paid</th></tr></thead>
    <tbody>${statementRows || '<tr><td colspan="5">No billing statements yet.</td></tr>'}</tbody>
  </table>
  <p><a class="btn-link" href="/admin/billing">View all billing statements</a></p>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/billing", requirePermission("BILLING", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" }
  });

  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Billing</h2><p>No hotel data found.</p>", true));
    return;
  }

  const defaultEnd = new Date();
  const defaultStart = addDays(defaultEnd, -30);
  const start = parseDateInput(req.query.start, defaultStart);
  const endRaw = parseDateInput(req.query.end, defaultEnd);
  const end = endOfDay(endRaw);

  const [invoices, paymentIntents] = await Promise.all([
    prisma.invoice.findMany({
      where: { hotelId: hotel.id, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" },
      include: { subscription: { select: { id: true } } }
    }),
    prisma.paymentIntent.findMany({
      where: { hotelId: hotel.id, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" }
    })
  ]);

  const exportQuery = new URLSearchParams({
    start: formatDateForInput(start),
    end: formatDateForInput(endRaw)
  }).toString();

  const subscriptionInvoiceRows = invoices
    .map(
      (invoice) => `<tr>
      <td><a class="inline-link" href="/admin/bookings">${escapeHtml(invoice.id)}</a></td>
      <td>${formatDate(invoice.createdAt)}</td>
      <td>${invoice.amountTotal} ${escapeHtml(invoice.currency)}</td>
      <td><span class="badge ${invoice.status === "PAID" ? "ok" : "pending"}">${escapeHtml(invoice.status)}</span></td>
      <td>${invoice.subscriptionId ? '<span class="badge ok">Subscription</span>' : "—"}</td>
      <td>${invoice.paidAt ? formatDate(invoice.paidAt) : "—"}</td>
      </tr>`
    )
    .join("");

  const paymentHistoryRows = paymentIntents
    .map(
      (payment) => `<tr>
      <td>${escapeHtml(payment.id.slice(0, 12))}</td>
      <td>${formatDateTime(payment.createdAt)}</td>
      <td>${payment.amount} ${escapeHtml(payment.currency)}</td>
      <td>${escapeHtml(payment.kind)}</td>
      <td><span class="badge ${payment.status === "SUCCEEDED" ? "ok" : "pending"}">${escapeHtml(payment.status)}</span></td>
      </tr>`
    )
    .join("");

  const content = `
<h2>Billing</h2>
<p class="muted">Live billing records for ${escapeHtml(hotel.displayName)}.</p>
<div class="actions">
  <a class="btn-link primary" href="/admin/bookings">Open Booking Financials</a>
  <a class="btn-link" href="/admin/subscription">View Plan & Limits</a>
  <a class="btn-link" href="/admin/reports">Open Report Filters</a>
  <a class="btn-link" href="/admin/billing/export?${escapeHtml(exportQuery)}" download="billing-export.csv">Export to CSV</a>
</div>
<form method="get" action="/admin/billing" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:14px">
  <label>From <input type="date" name="start" value="${formatDateForInput(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>To <input type="date" name="end" value="${formatDateForInput(endRaw)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <button type="submit" style="padding:8px 14px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Apply</button>
</form>
<div class="grid-2">
  <section>
    <h3>Payment Settings</h3>
    <table>
      <tbody>
        <tr><th>Provider</th><td>Stripe abstraction</td></tr>
        <tr><th>Default currency</th><td>${escapeHtml(hotel.currency)}</td></tr>
        <tr><th>Payout account</th><td><span class="badge pending">Not connected</span></td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Date range</h3>
    <p>${formatDateForInput(start)} – ${formatDateForInput(endRaw)}</p>
  </section>
</div>
<section style="margin-top: 14px">
  <h3>Subscription invoices</h3>
  <table>
    <thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th><th>Type</th><th>Paid</th></tr></thead>
    <tbody>${subscriptionInvoiceRows || '<tr><td colspan="6">No invoices in this range.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin-top: 14px">
  <h3>Payment history</h3>
  <table>
    <thead><tr><th>ID</th><th>Date</th><th>Amount</th><th>Kind</th><th>Status</th></tr></thead>
    <tbody>${paymentHistoryRows || '<tr><td colspan="5">No payments in this range.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/billing/export", requirePermission("BILLING", "VIEW"), async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" }
  });

  if (!hotel) {
    res.status(404).type("text/plain").send("Hotel not found");
    return;
  }

  const defaultEnd = new Date();
  const defaultStart = addDays(defaultEnd, -30);
  const start = parseDateInput(req.query.start, defaultStart);
  const endRaw = parseDateInput(req.query.end, defaultEnd);
  const end = endOfDay(endRaw);

  const [invoices, paymentIntents] = await Promise.all([
    prisma.invoice.findMany({
      where: { hotelId: hotel.id, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" },
      include: { subscription: { select: { id: true } } }
    }),
    prisma.paymentIntent.findMany({
      where: { hotelId: hotel.id, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" }
    })
  ]);

  function csvCell(value: string): string {
    const escaped = value.replaceAll('"', '""');
    return `"${escaped}"`;
  }

  const header =
    "Type,Id,Date,Amount,Currency,Status,Kind,Subscription,Paid At\n";
  const invoiceLines = invoices
    .map(
      (inv) =>
        [
          "Invoice",
          inv.id,
          formatDate(inv.createdAt),
          inv.amountTotal,
          inv.currency,
          inv.status,
          "",
          inv.subscriptionId ? "Yes" : "",
          inv.paidAt ? formatDate(inv.paidAt) : ""
        ]
          .map(String)
          .map(csvCell)
          .join(",") + "\n"
    )
    .join("");
  const paymentLines = paymentIntents
    .map(
      (p) =>
        [
          "Payment",
          p.id,
          formatDateTime(p.createdAt),
          p.amount,
          p.currency,
          p.status,
          p.kind,
          "",
          ""
        ]
          .map(String)
          .map(csvCell)
          .join(",") + "\n"
    )
    .join("");

  res
    .type("text/csv")
    .setHeader(
      "Content-Disposition",
      `attachment; filename="billing-${formatDateForInput(start)}-${formatDateForInput(endRaw)}.csv"`
    )
    .send(header + invoiceLines + paymentLines);
});

adminRouter.get("/integrations", requireAuth, async (_req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    include: {
      integrations: {
        include: { mappings: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { provider: "asc" }
      }
    }
  });

  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Integrations</h2><p>No hotel data found.</p>", true));
    return;
  }

  const rows = hotel.integrations
    .map((integration) => {
      const lastJob = integration.syncJobs[0];
      const statusClass = integration.status === "connected" ? "ok" : "pending";
      return `<tr>
      <td>${escapeHtml(integration.provider)}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(integration.status)}</span></td>
      <td>${integration.mappings.length} mapped</td>
      <td>${formatDate(integration.lastSyncedAt)}</td>
      <td>${lastJob ? escapeHtml(lastJob.status) : "-"}</td>
      </tr>`;
    })
    .join("");

  const bookingCom = hotel.integrations.find((integration) => integration.provider === "BOOKING_COM");
  const bookingComReady = Boolean(bookingCom);
  const bookingComJobs = bookingCom
    ? bookingCom.syncJobs
        .filter((job) => job.action.startsWith("BOOKING_COM_"))
        .slice(0, 8)
        .map(
          (job) => `<tr>
            <td>${escapeHtml(job.action)}</td>
            <td><span class="badge ${job.status === "SUCCESS" ? "ok" : job.status === "FAILED" ? "alert" : "pending"}">${escapeHtml(
              job.status
            )}</span></td>
            <td>${formatDateTime(job.createdAt)}</td>
          </tr>`
        )
        .join("")
    : "";

  const content = `
<h2>Integrations</h2>
<p class="muted">Live OTA/channel-manager integration status.</p>
<div class="actions">
  <a class="btn-link primary" href="/admin/calendar">Open Availability Calendar</a>
  <a class="btn-link" href="/admin/inventory">Open Inventory Matrix</a>
  <a class="btn-link" href="/admin/rooms">Open Room Mapping Sources</a>
</div>
<table>
  <thead>
    <tr><th>Provider</th><th>Connection</th><th>Room Mapping</th><th>Last Sync</th><th>Latest Sync Job</th></tr>
  </thead>
  <tbody>${rows || '<tr><td colspan="5">No integration connections yet.</td></tr>'}</tbody>
</table>
<section style="margin-top:14px">
  <h3>Booking.com Channel Manager Readiness</h3>
  <p class="muted">Architecture prep only. No external Booking.com API calls are performed yet.</p>
  <table>
    <tbody>
      <tr><th>Connection record</th><td>${bookingComReady ? '<span class="badge ok">Prepared</span>' : '<span class="badge pending">Missing</span>'}</td></tr>
      <tr><th>Sync domains supported</th><td>Room availability, Rates, Inventory, Bookings</td></tr>
      <tr><th>Sync mode</th><td>Incremental / Full</td></tr>
    </tbody>
  </table>
  ${
    bookingComReady
      ? `<form method="post" action="/admin/integrations/booking-com/prepare-sync" style="display:grid; gap:8px; margin-top:10px">
  <div style="display:flex; gap:12px; flex-wrap:wrap">
    <label><input type="checkbox" name="domains" value="availability" checked /> Availability</label>
    <label><input type="checkbox" name="domains" value="rates" checked /> Rates</label>
    <label><input type="checkbox" name="domains" value="inventory" checked /> Inventory</label>
    <label><input type="checkbox" name="domains" value="bookings" checked /> Bookings</label>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
    <label>Mode
      <select name="mode" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
        <option value="incremental">Incremental</option>
        <option value="full">Full</option>
      </select>
    </label>
    <label>From <input type="date" name="from" value="${formatDateForInput(startOfDay(new Date()))}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    <label>To <input type="date" name="to" value="${formatDateForInput(addDays(startOfDay(new Date()), 30))}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
    <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#0b6e6e; color:#fff; font-weight:700">Prepare sync jobs</button>
  </div>
</form>`
      : "<p class=\"muted\" style=\"margin-top:10px\">Seed or create a BOOKING_COM integration connection first.</p>"
  }
  <h4 style="margin-top:12px">Prepared Booking.com jobs</h4>
  <table>
    <thead><tr><th>Action</th><th>Status</th><th>Created</th></tr></thead>
    <tbody>${bookingComJobs || '<tr><td colspan="3">No Booking.com prep jobs yet.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/integrations/booking-com/prepare-sync", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { integrations: true }
  });
  if (!hotel) {
    res.redirect("/admin/integrations");
    return;
  }

  const integration = hotel.integrations.find((i) => i.provider === "BOOKING_COM");
  if (!integration) {
    res.redirect("/admin/integrations");
    return;
  }

  const modeRaw = String(req.body.mode ?? "incremental").toLowerCase();
  const mode: BookingComSyncMode = modeRaw === "full" ? "full" : "incremental";
  const from = formatDateForInput(parseDateInput(req.body.from, startOfDay(new Date())));
  const to = formatDateForInput(parseDateInput(req.body.to, addDays(startOfDay(new Date()), 30)));

  const rawDomains = req.body.domains;
  const selectedRaw = Array.isArray(rawDomains) ? rawDomains : rawDomains ? [rawDomains] : [];
  const selectedDomains = selectedRaw
    .map((v) => String(v))
    .filter((v): v is BookingComSyncDomain => bookingComDomains.includes(v as BookingComSyncDomain));
  const domains = selectedDomains.length ? selectedDomains : bookingComDomains;

  const plan = buildBookingComSyncPlan({
    mode,
    window: { from, to },
    domains
  });

  await prisma.$transaction(
    plan.map((item) =>
      prisma.syncJob.create({
        data: {
          integrationConnectionId: integration.id,
          action: item.action,
          status: "QUEUED"
        }
      })
    )
  );
  await prisma.integrationConnection.update({
    where: { id: integration.id },
    data: { lastSyncedAt: new Date() }
  });

  res.redirect("/admin/integrations");
});

adminRouter.get("/setup", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: platformHotelSlug },
    include: { properties: { orderBy: { createdAt: "asc" } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Setup</h2><p>No hotel data found.</p>", true));
    return;
  }

  const activePropertyId = await resolveActivePropertyIdForHotel(req, hotel.id);
  const property = hotel.properties.find((p) => p.id === activePropertyId) ?? hotel.properties[0] ?? null;
  const config = loadPartnerSetupConfig(hotel.id);
  const updatedNotice = req.query.updated ? '<p class="badge ok">Setup updated.</p>' : "";
  const sentNotice = req.query.sent ? '<p class="badge ok">Test template sent to WhatsApp successfully.</p>' : "";
  const sendError = typeof req.query.sendError === "string" ? req.query.sendError : "";
  const errorNotice = sendError ? `<p class="badge alert">${escapeHtml(sendError)}</p>` : "";
  const content = `
<h2>Partner Setup</h2>
<p class="muted">Complete your hotel profile and customize AI instant-message replies used in guest conversations.</p>
${updatedNotice}
${sentNotice}
${errorNotice}
<div class="actions">
  <a class="btn-link primary" href="/admin/conversations">Test messages in Conversations</a>
  <a class="btn-link" href="/admin/integrations">Review channels</a>
  <a class="btn-link" href="/admin/subscription">Plan & usage</a>
</div>
<form method="post" action="/admin/setup" style="display:grid; gap:12px">
  <div class="grid-2">
    <section>
      <h3>Hotel Profile</h3>
      <label>Display name
        <input type="text" name="displayName" value="${escapeHtml(hotel.displayName)}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Legal name
        <input type="text" name="legalName" value="${escapeHtml(hotel.legalName)}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <div class="grid-2">
        <label>City
          <input type="text" name="city" value="${escapeHtml(hotel.city ?? "")}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
        </label>
        <label>Country
          <input type="text" name="country" value="${escapeHtml(hotel.country)}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
        </label>
      </div>
      <div class="grid-2">
        <label>Timezone
          <input type="text" name="timezone" value="${escapeHtml(hotel.timezone)}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
        </label>
        <label>Currency
          <input type="text" name="currency" value="${escapeHtml(hotel.currency)}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
        </label>
      </div>
      <label>WhatsApp phone
        <input type="text" name="whatsappPhone" value="${escapeHtml(hotel.whatsappPhone ?? "")}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>WhatsApp Phone Number ID (Cloud API)
        <input type="text" name="whatsappPhoneNumberId" value="${escapeHtml(config.whatsappPhoneNumberId)}" placeholder="Phone number ID from Meta → WhatsApp → API setup" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <h4 style="margin:16px 0 8px">Outlet order alerts (WhatsApp)</h4>
      <p class="muted" style="font-size:13px;margin:0 0 8px">Digits only (include country code). <strong>Restaurant / café:</strong> one grouped WhatsApp per outlet per posting (dining in or room service without a dedicated RS number below). <strong>Room service number:</strong> if set, <em>room service</em> menu posts send <strong>one combined</strong> message here (all items). Folio charges still use restaurant / café / room-service / activity numbers by line type.</p>
      <label>Restaurant / kitchen
        <input type="text" name="outletRestaurantWhatsAppE164" value="${escapeHtml(config.outletRestaurantWhatsAppE164)}" placeholder="e.g. 968XXXXXXXXX" autocomplete="off" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Coffee shop / café
        <input type="text" name="outletCoffeeShopWhatsAppE164" value="${escapeHtml(config.outletCoffeeShopWhatsAppE164)}" placeholder="e.g. 968XXXXXXXXX" autocomplete="off" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Room service prep (optional; folio room-service charges)
        <input type="text" name="outletRoomServiceWhatsAppE164" value="${escapeHtml(config.outletRoomServiceWhatsAppE164)}" placeholder="Leave blank to use restaurant number" autocomplete="off" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Activity desk (optional)
        <input type="text" name="outletActivityWhatsAppE164" value="${escapeHtml(config.outletActivityWhatsAppE164)}" placeholder="e.g. 968XXXXXXXXX" autocomplete="off" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Hotel description
        <textarea name="hotelDescription" rows="4" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.hotelDescription
        )}</textarea>
      </label>
      <label>Amenities summary
        <textarea name="amenitiesSummary" rows="3" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.amenitiesSummary
        )}</textarea>
      </label>
      <label>Google review link (optional)
        <input type="url" name="googleReviewLink" value="${escapeHtml(
          config.googleReviewLink ?? ""
        )}" placeholder="https://g.page/r/..." style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label style="display:flex; align-items:center; gap:8px">
        <input type="checkbox" name="feedbackNotificationsEnabled" value="1" ${
          config.feedbackNotificationsEnabled ? "checked" : ""
        } />
        Enable instant low-rating notifications
      </label>
    </section>
    <section>
      <h3>Property Details</h3>
      <input type="hidden" name="propertyId" value="${property ? escapeHtml(property.id) : ""}" />
      <label>Property name
        <input type="text" name="propertyName" value="${escapeHtml(property?.name ?? hotel.displayName)}" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Address
        <input type="text" name="addressLine1" value="${escapeHtml(property?.addressLine1 ?? "")}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <div class="grid-2">
        <label>Check-in time
          <input type="text" name="checkInTime" value="${escapeHtml(property?.checkInTime ?? "14:00")}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
        </label>
        <label>Check-out time
          <input type="text" name="checkOutTime" value="${escapeHtml(property?.checkOutTime ?? "12:00")}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
        </label>
      </div>
      <label>Property city
        <input type="text" name="propertyCity" value="${escapeHtml(property?.city ?? hotel.city ?? "")}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <p class="muted">This profile data powers how your hotel appears in AI replies and booking summaries.</p>
    </section>
  </div>
  <section>
    <h3>Instant Message AI Customization</h3>
    <label style="display:flex; align-items:center; gap:8px">
      <input type="checkbox" name="aiEnabled" value="1" ${config.aiEnabled ? "checked" : ""} />
      Enable instant AI replies for common guest requests
    </label>
    <label>AI tone
      <select name="aiTone" style="width:100%; max-width:260px; padding:8px; border:1px solid #d8dee6; border-radius:8px">
        <option value="friendly" ${config.aiTone === "friendly" ? "selected" : ""}>Friendly</option>
        <option value="premium" ${config.aiTone === "premium" ? "selected" : ""}>Premium</option>
        <option value="concise" ${config.aiTone === "concise" ? "selected" : ""}>Concise</option>
      </select>
    </label>
    <div class="grid-2">
      <label>Welcome template
        <textarea name="instantWelcomeTemplate" rows="3" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.instantWelcomeTemplate
        )}</textarea>
      </label>
      <label>Quote template
        <textarea name="instantQuoteTemplate" rows="3" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.instantQuoteTemplate
        )}</textarea>
      </label>
    </div>
    <div class="grid-2">
      <label>Unavailable template
        <textarea name="instantUnavailableTemplate" rows="3" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.instantUnavailableTemplate
        )}</textarea>
      </label>
      <label>Confirmation template
        <textarea name="instantConfirmationTemplate" rows="3" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.instantConfirmationTemplate
        )}</textarea>
      </label>
    </div>
    <label>AI knowledge base upload (TXT/JSON)
      <input id="aiKnowledgeFile" type="file" accept=".txt,.json,text/plain,application/json" style="display:block; margin-top:6px" />
    </label>
    <label>AI knowledge base text
      <textarea id="aiKnowledgeBase" name="aiKnowledgeBase" rows="6" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
        config.aiKnowledgeBase
      )}</textarea>
    </label>
    <div class="grid-2">
      <label>Knowledge base (English)
        <textarea name="aiKnowledgeBaseEn" rows="5" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.aiKnowledgeBaseEn
        )}</textarea>
      </label>
      <label>Knowledge base (Arabic)
        <textarea name="aiKnowledgeBaseAr" rows="5" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.aiKnowledgeBaseAr
        )}</textarea>
      </label>
    </div>
    <div class="grid-2">
      <label>Knowledge base (Spanish)
        <textarea name="aiKnowledgeBaseEs" rows="5" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.aiKnowledgeBaseEs
        )}</textarea>
      </label>
      <label>Knowledge base (French)
        <textarea name="aiKnowledgeBaseFr" rows="5" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px">${escapeHtml(
          config.aiKnowledgeBaseFr
        )}</textarea>
      </label>
    </div>
    <p class="muted">Supported placeholders: {{hotel_name}}, {{guest_name}}, {{room_type}}, {{nightly_rate}}, {{nights}}, {{check_in}}, {{check_out}}, {{booking_id}}</p>
    <p class="muted">Smart chatbot knowledge base format: JSON array like [{"question":"Do you have WiFi?","answer":"Yes, high-speed WiFi is available."}] or one line per item using "question | answer". Use language-specific fields below for best matching quality.</p>
  </section>
  <button type="submit" style="max-width:280px; padding:10px 14px; border:0; border-radius:10px; background:#128c7e; color:#fff; font-weight:700">Save Setup</button>
</form>
<section style="margin-top:14px">
  <h3>Send Test Template</h3>
  <p class="muted">Send one preview message to a real WhatsApp number using your saved templates.</p>
  <form method="post" action="/admin/setup/send-test" style="max-width:560px; display:grid; gap:8px">
    <label>Destination phone (international format)
      <input type="text" name="toPhone" placeholder="9689XXXXXXXX" required style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
    </label>
    <label>Template to test
      <select name="templateType" style="width:100%; max-width:320px; padding:8px; border:1px solid #d8dee6; border-radius:8px">
        <option value="welcome">Welcome</option>
        <option value="quote">Quote</option>
        <option value="unavailable">Unavailable</option>
        <option value="confirmation">Confirmation</option>
      </select>
    </label>
    <div class="grid-2">
      <label>Guest name
        <input type="text" name="guestName" value="Test Guest" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Room type
        <input type="text" name="roomType" value="Suite" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
    </div>
    <div class="grid-2">
      <label>Check-in
        <input type="date" name="checkIn" value="${formatDate(addDays(startOfDay(new Date()), 3))}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Check-out
        <input type="date" name="checkOut" value="${formatDate(addDays(startOfDay(new Date()), 5))}" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
    </div>
    <div class="grid-2">
      <label>Nightly rate (text)
        <input type="text" name="nightlyRate" value="40.00 OMR" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Nights
        <input type="number" name="nights" value="2" min="1" max="30" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
    </div>
    <div class="grid-2">
      <label>Booking ID
        <input type="text" name="bookingId" value="TEST-BOOKING-001" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
      <label>Alternative room
        <input type="text" name="alternativeRoom" value="Standard Executive" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
      </label>
    </div>
    <button type="submit" style="max-width:260px; padding:10px 14px; border:0; border-radius:10px; background:#075e54; color:#fff; font-weight:700">Send Test Message</button>
  </form>
</section>
<script>
  (function () {
    const fileInput = document.getElementById("aiKnowledgeFile");
    const target = document.getElementById("aiKnowledgeBase");
    if (!fileInput || !target) return;
    fileInput.addEventListener("change", function (event) {
      const files = event.target && event.target.files;
      if (!files || !files[0]) return;
      const reader = new FileReader();
      reader.onload = function () {
        if (typeof reader.result === "string") target.value = reader.result;
      };
      reader.readAsText(files[0]);
    });
  })();
</script>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/setup", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: platformHotelSlug },
    include: { properties: { orderBy: { createdAt: "asc" } } }
  });
  if (!hotel) {
    res.redirect("/admin/dashboard");
    return;
  }

  const displayName = String(req.body.displayName ?? "").trim() || hotel.displayName;
  const legalName = String(req.body.legalName ?? "").trim() || hotel.legalName;
  const city = String(req.body.city ?? "").trim() || null;
  const country = String(req.body.country ?? "").trim() || hotel.country;
  const timezone = String(req.body.timezone ?? "").trim() || hotel.timezone;
  const currency = String(req.body.currency ?? "").trim() || hotel.currency;
  const whatsappPhone = String(req.body.whatsappPhone ?? "").trim() || null;

  const propertyName = String(req.body.propertyName ?? "").trim() || displayName;
  const propertyCity = String(req.body.propertyCity ?? "").trim() || city;
  const addressLine1 = String(req.body.addressLine1 ?? "").trim() || null;
  const checkInTime = String(req.body.checkInTime ?? "").trim() || null;
  const checkOutTime = String(req.body.checkOutTime ?? "").trim() || null;
  const propertyId = String(req.body.propertyId ?? "").trim();

  await prisma.$transaction(async (tx) => {
    await tx.hotel.update({
      where: { id: hotel.id },
      data: { displayName, legalName, city, country, timezone, currency, whatsappPhone }
    });
    if (propertyId) {
      await tx.property.updateMany({
        where: { id: propertyId, hotelId: hotel.id },
        data: { name: propertyName, city: propertyCity, addressLine1, checkInTime, checkOutTime }
      });
    } else {
      await tx.property.create({
        data: {
          hotelId: hotel.id,
          name: propertyName,
          city: propertyCity,
          addressLine1,
          checkInTime,
          checkOutTime
        }
      });
    }
  });

  const existingConfig = loadPartnerSetupConfig(hotel.id);
  const nextConfig: PartnerSetupConfig = {
    hotelDescription: String(req.body.hotelDescription ?? "").trim(),
    amenitiesSummary: String(req.body.amenitiesSummary ?? "").trim(),
    whatsappPhoneNumberId: String(req.body.whatsappPhoneNumberId ?? "").trim(),
    outletRestaurantWhatsAppE164: String(req.body.outletRestaurantWhatsAppE164 ?? "").trim(),
    outletCoffeeShopWhatsAppE164: String(req.body.outletCoffeeShopWhatsAppE164 ?? "").trim(),
    outletRoomServiceWhatsAppE164: String(req.body.outletRoomServiceWhatsAppE164 ?? "").trim(),
    outletActivityWhatsAppE164: String(req.body.outletActivityWhatsAppE164 ?? "").trim(),
    googleReviewLink: String(req.body.googleReviewLink ?? "").trim(),
    feedbackNotificationsEnabled: req.body.feedbackNotificationsEnabled === "1",
    aiEnabled: req.body.aiEnabled === "1",
    aiTone:
      req.body.aiTone === "premium" || req.body.aiTone === "concise"
        ? (req.body.aiTone as "premium" | "concise")
        : "friendly",
    instantWelcomeTemplate: String(req.body.instantWelcomeTemplate ?? "").trim(),
    instantQuoteTemplate: String(req.body.instantQuoteTemplate ?? "").trim(),
    instantUnavailableTemplate: String(req.body.instantUnavailableTemplate ?? "").trim(),
    instantConfirmationTemplate: String(req.body.instantConfirmationTemplate ?? "").trim(),
    aiKnowledgeBase: String(req.body.aiKnowledgeBase ?? "").trim(),
    aiKnowledgeBaseEn: String(req.body.aiKnowledgeBaseEn ?? "").trim(),
    aiKnowledgeBaseAr: String(req.body.aiKnowledgeBaseAr ?? "").trim(),
    aiKnowledgeBaseEs: String(req.body.aiKnowledgeBaseEs ?? "").trim(),
    aiKnowledgeBaseFr: String(req.body.aiKnowledgeBaseFr ?? "").trim(),
    optimizationSettings: existingConfig.optimizationSettings
  };
  savePartnerSetupConfig(nextConfig, hotel.id);

  await logAudit({
    hotelId: hotel.id,
    action: "HOTEL_PARTNER_SETUP_UPDATED",
    entityType: "Hotel",
    entityId: hotel.id,
    metadata: {
      displayName,
      city,
      aiEnabled: nextConfig.aiEnabled,
      aiTone: nextConfig.aiTone,
      templatesCustomized: Boolean(
        nextConfig.instantWelcomeTemplate ||
          nextConfig.instantQuoteTemplate ||
          nextConfig.instantUnavailableTemplate ||
          nextConfig.instantConfirmationTemplate
      )
    }
  });

  res.redirect("/admin/setup?updated=1");
});

adminRouter.post("/setup/send-test", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: platformHotelSlug },
    include: { properties: { orderBy: { createdAt: "asc" } } }
  });
  if (!hotel) {
    res.redirect("/admin/dashboard");
    return;
  }

  const toPhoneRaw = String(req.body.toPhone ?? "").trim();
  const toPhone = normalizePhoneForWhatsApp(toPhoneRaw);
  const templateType = String(req.body.templateType ?? "welcome");
  if (!toPhone || toPhone.length < 8) {
    res.redirect("/admin/setup?sendError=Please+provide+a+valid+international+phone+number");
    return;
  }

  const config = loadPartnerSetupConfig(hotel.id);
  const activePropertyId = await resolveActivePropertyIdForHotel(req, hotel.id);
  const property = hotel.properties.find((p) => p.id === activePropertyId) ?? hotel.properties[0];
  const guestName = String(req.body.guestName ?? "").trim() || "Test Guest";
  const roomType = String(req.body.roomType ?? "").trim() || "Suite";
  const checkIn = formatDate(parseDateInput(req.body.checkIn, addDays(startOfDay(new Date()), 3)));
  const checkOut = formatDate(parseDateInput(req.body.checkOut, addDays(startOfDay(new Date()), 5)));
  const nightlyRate = String(req.body.nightlyRate ?? "").trim() || "40.00 OMR";
  const nights = clamp(parseIntegerInput(req.body.nights, 2), 1, 30);
  const bookingId = String(req.body.bookingId ?? "").trim() || "TEST-BOOKING-001";
  const alternativeRoom = String(req.body.alternativeRoom ?? "").trim() || "Standard Executive";
  const sampleValues = {
    hotel_name: hotel.displayName,
    guest_name: guestName,
    room_type: roomType,
    nightly_rate: nightlyRate,
    nights,
    check_in: checkIn,
    check_out: checkOut,
    booking_id: bookingId,
    alternative_room: alternativeRoom
  };

  let template = config.instantWelcomeTemplate;
  if (templateType === "quote") template = config.instantQuoteTemplate;
  if (templateType === "unavailable") template = config.instantUnavailableTemplate;
  if (templateType === "confirmation") template = config.instantConfirmationTemplate;
  const fallbackByType: Record<string, string> = {
    welcome: `Welcome to ${hotel.displayName}. Share your dates and guest count for an instant quote.`,
    quote: `Sample quote: ${roomType} at ${nightlyRate} per night for ${nights} nights.`,
    unavailable: `Sorry, ${roomType} is limited for the selected dates. We can offer ${alternativeRoom} instead.`,
    confirmation: `Great news ${guestName}. Booking ${bookingId} is confirmed from ${sampleValues.check_in} to ${sampleValues.check_out}.`
  };
  const body = buildTemplateMessage(template, sampleValues, fallbackByType[templateType] ?? fallbackByType.welcome);

  try {
    await sendWhatsAppText({ to: toPhone, body, phoneNumberId: config.whatsappPhoneNumberId || undefined });
    await logAudit({
      hotelId: hotel.id,
      action: "SETUP_TEST_TEMPLATE_SENT",
      entityType: "Hotel",
      entityId: hotel.id,
      metadata: { toPhone, templateType, propertyName: property?.name ?? null, guestName, roomType, checkIn, checkOut, bookingId }
    });
    res.redirect("/admin/setup?sent=1");
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 140) : "Unable to send WhatsApp test message";
    res.redirect(`/admin/setup?sendError=${encodeURIComponent(message)}`);
    return;
  }
});
