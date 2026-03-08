import { Router, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BookingStatus, ConversationState, MessageDirection, PaymentStatus } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig, savePartnerSetupConfig, applyPartnerTemplate, type PartnerSetupConfig } from "../core/partnerSetup";
import { buildBookingInvoicePdf } from "../core/invoicePdf";
import { sendWhatsAppDocument, sendWhatsAppText } from "../whatsapp/send";

export const adminRouter = Router();

const viewsDir = path.join(process.cwd(), "src", "views");
const sessionCookieName = "chatastay_admin_session";
const activeSessions = new Set<string>();
const hotelName = "Al Ashkhara Beach Resort";
const hotelSign = "Seafront Hospitality, Oman";
const reportStartDefault = "2026-03-01";
const reportEndDefault = "2026-03-31";
const tourOperatorDiscount = 0.15;
const seasonalBaseRates: Record<string, { high: number; low: number }> = {
  STD_SUPERIOR: { high: 30, low: 25 },
  STD_EXEC: { high: 35, low: 30 },
  SUITE: { high: 40, low: 35 },
  APARTMENT: { high: 50, low: 40 }
};

function readView(name: string): string {
  return fs.readFileSync(path.join(viewsDir, name), "utf8");
}

function renderLayout(content: string, authenticated: boolean): string {
  const layout = readView("layout.html");
  const navHtml = authenticated
    ? [
        '<a href="/admin/dashboard">Dashboard</a>',
        '<a href="/admin/rooms">Rooms</a>',
        '<a href="/admin/inventory">Inventory</a>',
        '<a href="/admin/bookings">Bookings</a>',
        '<a href="/admin/calendar">Calendar</a>',
        '<a href="/admin/conversations">Conversations</a>',
        '<a href="/admin/subscription">Subscription</a>',
        '<a href="/admin/billing">Billing</a>',
        '<a href="/admin/integrations">Integrations</a>',
        '<a href="/admin/setup">Setup</a>',
        '<a href="/admin/ai-analytics">AI Analytics</a>',
        '<a href="/admin/booking-funnel">Booking Funnel</a>',
        '<a href="/admin/routing-health">Routing Health</a>',
        '<a href="/guest">Guest Portal</a>',
        '<form method="post" action="/admin/logout"><button type="submit">Logout</button></form>'
      ].join("")
    : '<a href="/admin/login">Login</a>';
  const langSwitcherHtml = '<a href="?lang=en" data-lang-link="en">EN</a><a href="?lang=ar" data-lang-link="ar">AR</a>';

  return layout
    .replaceAll("{{lang}}", "en")
    .replaceAll("{{dir}}", "ltr")
    .replaceAll("{{adminTitle}}", "ChatAstay Admin")
    .replace("{{brandTagline}}", "WhatsApp-first booking ops")
    .replace("{{langSwitcher}}", langSwitcherHtml)
    .replace("{{hotelName}}", hotelName)
    .replace("{{hotelSign}}", hotelSign)
    .replace("{{navLinks}}", navHtml)
    .replace("{{content}}", content);
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

function formatDate(input: Date | null | undefined): string {
  if (!input) return "-";
  return input.toISOString().slice(0, 10);
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

function addDays(input: Date, days: number): Date {
  const date = new Date(input);
  date.setDate(date.getDate() + days);
  return date;
}

function parseDateInput(raw: unknown, fallback: Date): Date {
  if (typeof raw !== "string" || !raw) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return startOfDay(parsed);
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

function parseAuditMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildUnitCode(roomTypeCode: string, unitNo: number): string {
  return `${roomTypeCode}-${String(unitNo).padStart(2, "0")}`;
}

async function getBookingUnitCode(bookingId: string): Promise<string | null> {
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
}): Promise<{ sent: boolean; skipped: boolean; error?: string }> {
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
    return { sent: false, skipped: false, error: "Booking or hotel not found for invoice send." };
  }
  if (booking.status !== BookingStatus.CONFIRMED) {
    return { sent: false, skipped: true };
  }

  const lastDispatch = await getLatestInvoiceDispatch(booking.id);
  if (!params.force && lastDispatch.sentAt && lastDispatch.paymentStatusAtSend === booking.paymentStatus) {
    return { sent: false, skipped: true };
  }

  const selectedUnitCode = await getBookingUnitCode(booking.id);
  const invoiceNumber = `INV-${booking.id}`;
  const filename = `${booking.id}-invoice-${formatDate(new Date())}.pdf`;
  const invoicePdf = await buildBookingInvoicePdf({
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
    currency: booking.currency
  });

  const toPhone = normalizePhoneForWhatsApp(booking.guest.phoneE164);
  if (!toPhone) {
    return { sent: false, skipped: false, error: "Guest phone number is missing or invalid." };
  }

  try {
    await sendWhatsAppDocument({
      to: toPhone,
      filename,
      body: invoicePdf,
      caption: `Invoice ${invoiceNumber} for booking ${booking.id}. Payment status: ${booking.paymentStatus}.`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : "Failed to send invoice PDF";
    return { sent: false, skipped: false, error: message };
  }

  if (booking.conversationId) {
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: booking.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: `Invoice PDF ${invoiceNumber} sent to guest. Payment status at send: ${booking.paymentStatus}.`,
        aiIntent: "INVOICE_SENT"
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

async function getMinInventoryForStay(params: { hotelId: string; roomTypeId: string; checkIn: Date; checkOut: Date; fallback: number }): Promise<number> {
  const inventoryRows = await prisma.inventory.findMany({
    where: {
      hotelId: params.hotelId,
      roomTypeId: params.roomTypeId,
      date: { gte: params.checkIn, lt: params.checkOut }
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
    select: { id: true }
  });
  if (!overlappingBookings.length) return new Set<string>();

  const bookingIds = overlappingBookings.map((booking) => booking.id);
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
  return new Set<string>(Array.from(selectedByBooking.values()));
}

function buildBookingId(): string {
  return `WS-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
}

async function logAudit(params: {
  hotelId: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      hotelId: params.hotelId,
      actorEmail: process.env.ADMIN_EMAIL ?? "admin@chatastay.local",
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : undefined
    }
  });
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

function isAuthenticated(req: Request): boolean {
  const token = getSessionToken(req);
  return Boolean(token && activeSessions.has(token));
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.redirect("/admin/login");
    return;
  }
  next();
}

adminRouter.get("/", (req, res) => {
  if (!isAuthenticated(req)) {
    res.redirect("/admin/login");
    return;
  }
  res.redirect("/admin/dashboard");
});

adminRouter.get("/login", (req, res) => {
  if (isAuthenticated(req)) {
    res.redirect("/admin/dashboard");
    return;
  }
  res.type("html").send(renderPage("login.html", false));
});

adminRouter.post("/login", (req, res) => {
  const email = String(req.body.email ?? "");
  const password = String(req.body.password ?? "");

  const adminEmail = process.env.ADMIN_EMAIL ?? "admin@chatastay.local";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "admin123";

  if (email !== adminEmail || password !== adminPassword) {
    res.status(401).type("html").send(renderPage("login.html", false));
    return;
  }

  const token = crypto.randomUUID();
  activeSessions.add(token);
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`
  );
  res.redirect("/admin/dashboard");
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

adminRouter.get("/dashboard", requireAuth, (_req, res) => {
  res.type("html").send(renderPage("dashboard.html", true));
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

adminRouter.get("/rooms", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Rooms</h2><p>No hotel data found.</p>", true));
    return;
  }

  const season = req.query.season === "high" ? "high" : "low";
  const info = req.query.saved ? '<p class="badge ok">Room settings saved.</p>' : "";
  const offerInfo = req.query.offer ? '<p class="badge ok">Offer scheme applied.</p>' : "";
  const seasonInfo = req.query.seasonApplied
    ? `<p class="badge ok">${season === "high" ? "High" : "Low"} season rates applied.</p>`
    : "";
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
          <input type="number" min="0" name="totalInventory" value="${room.totalInventory}" style="width:90px; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
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

  const content = `
<h2>Rooms & Pricing</h2>
<p class="muted">Edit room availability, nightly pricing, and quickly apply offer schemes.</p>
${info}${offerInfo}${seasonInfo}
<div class="actions">
  <a class="btn-link primary" href="/admin/inventory">Open Inventory by Date</a>
  <a class="btn-link" href="/admin/calendar">Open Calendar View</a>
  <a class="btn-link" href="/admin/bookings">See Booking Report</a>
</div>
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
    <select name="offerCode" style="padding:9px; border:1px solid #d8dee6; border-radius:8px">
      <option value="TOUR_OPERATOR_15">Tour Operator (15% off)</option>
      <option value="WEEKDAY_SAVER">Weekday Saver (10% off)</option>
      <option value="FLASH_24H">Flash 24h Offer (20% off)</option>
    </select>
    <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
  </form>
</section>
<table>
  <thead>
    <tr><th>Room Type</th><th>Capacity</th><th>High (${escapeHtml(hotel.currency)})</th><th>Low (${escapeHtml(
      hotel.currency
    )})</th><th>Base/Edit Rate</th><th>Tour Operator (${escapeHtml(hotel.currency)})</th><th>Inventory</th><th>Status</th><th>Action</th></tr>
  </thead>
  <tbody>${roomRows || '<tr><td colspan="9">No room types found.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/rooms/update/:roomTypeId", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/rooms");
    return;
  }
  const roomTypeId = String(req.params.roomTypeId ?? "");
  const baseNightlyRate = Math.max(0, parseNumberInput(req.body.baseNightlyRate, 0));
  const totalInventory = Math.max(0, parseIntegerInput(req.body.totalInventory, 0));
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

adminRouter.post("/rooms/season", requireAuth, async (req, res) => {
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

adminRouter.post("/rooms/offers", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/rooms");
    return;
  }

  const offerCode = String(req.body.offerCode ?? "");
  const targetRoomId = String(req.body.targetRoomId ?? "ALL");
  const discountMap: Record<string, number> = {
    TOUR_OPERATOR_15: tourOperatorDiscount,
    WEEKDAY_SAVER: 0.1,
    FLASH_24H: 0.2
  };
  const discount = discountMap[offerCode];
  if (!discount) {
    res.redirect("/admin/rooms");
    return;
  }

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
      discount,
      affectedRoomTypeIds: roomTypes.map((room) => room.id)
    }
  });

  res.redirect("/admin/rooms?offer=1");
});

adminRouter.get("/inventory", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Inventory</h2><p>No hotel data found.</p>", true));
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
    inventoryMap.set(`${row.roomTypeId}_${formatDate(row.date)}`, row);
  }

  const info = req.query.saved ? '<p class="badge ok">Inventory updated.</p>' : "";
  const rows = hotel.roomTypes
    .map((room) => {
      const cells = dates
        .map((date) => {
          const dateKey = formatDate(date);
          const inv = inventoryMap.get(`${room.id}_${dateKey}`);
          const total = inv?.total ?? room.totalInventory;
          const reserved = inv?.reserved ?? 0;
          const closedOut = inv?.closedOut ?? false;
          return `<td>
          <form method="post" action="/admin/inventory/update" style="display:grid; gap:6px">
            <input type="hidden" name="roomTypeId" value="${escapeHtml(room.id)}" />
            <input type="hidden" name="date" value="${dateKey}" />
            <input type="hidden" name="start" value="${formatDate(start)}" />
            <input type="hidden" name="days" value="${days}" />
            <label style="font-size:12px; color:#5f6b7a">Total <input type="number" min="0" name="total" value="${total}" style="width:100%; padding:6px; border:1px solid #d8dee6; border-radius:7px" /></label>
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
<h2>Inventory Control</h2>
<p class="muted">Adjust room availability by date, including reserved count and close-out dates.</p>
${info}
<div class="actions">
  <a class="btn-link primary" href="/admin/calendar?start=${formatDate(start)}&days=${days}">Open Calendar for Range</a>
  <a class="btn-link" href="/admin/rooms">Edit Room Rates</a>
  <a class="btn-link" href="/admin/bookings?start=${formatDate(start)}&end=${formatDate(addDays(start, days - 1))}">Open Report for Range</a>
</div>
<form method="get" action="/admin/inventory" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Start <input type="date" name="start" value="${formatDate(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>Days <input type="number" min="3" max="21" name="days" value="${days}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px; width:90px" /></label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Filter</button>
</form>
<table>
  <thead><tr><th>Room Type</th>${header}</tr></thead>
  <tbody>${rows || '<tr><td colspan="8">No room types found.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/inventory/update", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/inventory");
    return;
  }

  const roomTypeId = String(req.body.roomTypeId ?? "");
  const date = parseDateInput(req.body.date, startOfDay(new Date()));
  const total = Math.max(0, parseIntegerInput(req.body.total, 0));
  const reserved = clamp(parseIntegerInput(req.body.reserved, 0), 0, total);
  const closedOut = req.body.closedOut === "on";

  const roomType = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId: hotel.id } });
  if (!roomType) {
    res.redirect("/admin/inventory");
    return;
  }

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

  const start = encodeURIComponent(String(req.body.start ?? formatDate(startOfDay(new Date()))));
  const days = encodeURIComponent(String(req.body.days ?? "7"));
  res.redirect(`/admin/inventory?start=${start}&days=${days}&saved=1`);
});

adminRouter.get("/bookings", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Bookings</h2><p>No hotel data found.</p>", true));
    return;
  }

  const now = startOfDay(new Date());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = parseDateInput(req.query.start, monthStart);
  const end = parseDateInput(req.query.end, now);
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

  const bookings = await prisma.booking.findMany({
    where: {
      hotelId: hotel.id,
      checkIn: { gte: start, lt: endExclusive },
      ...(selectedStatus ? { status: selectedStatus } : {})
    },
    include: { roomType: true, guest: true },
    orderBy: { checkIn: "asc" }
  });

  const conversationsCount = await prisma.conversation.count({
    where: { hotelId: hotel.id, createdAt: { gte: start, lt: endExclusive } }
  });

  const revenue = bookings.reduce((sum, booking) => sum + booking.totalAmount, 0);
  const confirmed = bookings.filter((booking) => booking.status === "CONFIRMED").length;
  const pending = bookings.filter((booking) => booking.status === "PENDING").length;
  const cancelled = bookings.filter((booking) => booking.status === "CANCELLED").length;

  const rows = bookings
    .map(
      (booking) => `<tr>
      <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">${escapeHtml(booking.id)}</a></td>
      <td><a class="inline-link" href="/admin/conversations">${escapeHtml(booking.guest.fullName ?? booking.guest.phoneE164)}</a></td>
      <td>${escapeHtml(booking.roomType.name)}</td>
      <td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}</td>
      <td>${formatMoney(booking.totalAmount, hotel.currency)}</td>
      <td><span class="badge ${getBadgeClass(booking.status)}">${escapeHtml(booking.status)}</span></td>
      <td><a class="inline-link" href="/admin/bookings/${encodeURIComponent(booking.id)}">Open details</a></td>
      </tr>`
    )
    .join("");

  const content = `
<h2>Reports & Bookings</h2>
<p class="muted">Filter performance by date range, booking status, and track revenue trends.</p>
<div class="actions">
  <a class="btn-link primary" href="/admin/calendar?start=${formatDate(start)}&days=14">Open Room Calendar</a>
  <a class="btn-link" href="/admin/inventory?start=${formatDate(start)}&days=7">Adjust Availability</a>
  <a class="btn-link" href="/admin/billing">Open Billing Details</a>
</div>
<form method="get" action="/admin/bookings" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>From <input type="date" name="start" value="${formatDate(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>To <input type="date" name="end" value="${formatDate(end)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>Status
    <select name="status" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
      <option value="ALL" ${status === "ALL" ? "selected" : ""}>All</option>
      <option value="PENDING" ${status === "PENDING" ? "selected" : ""}>Pending</option>
      <option value="CONFIRMED" ${status === "CONFIRMED" ? "selected" : ""}>Confirmed</option>
      <option value="CANCELLED" ${status === "CANCELLED" ? "selected" : ""}>Cancelled</option>
      <option value="NO_SHOW" ${status === "NO_SHOW" ? "selected" : ""}>No Show</option>
    </select>
  </label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Apply</button>
</form>
<div class="grid-4">
  <article class="stat"><h3>Total bookings</h3><p><a class="stat-link" href="/admin/bookings?start=${formatDate(start)}&end=${formatDate(end)}&status=ALL">${bookings.length}</a></p></article>
  <article class="stat"><h3>Confirmed</h3><p><a class="stat-link" href="/admin/bookings?start=${formatDate(start)}&end=${formatDate(end)}&status=CONFIRMED">${confirmed}</a></p></article>
  <article class="stat"><h3>Pending / Cancelled</h3><p><a class="stat-link" href="/admin/bookings?start=${formatDate(start)}&end=${formatDate(end)}&status=PENDING">${pending}</a> / <a class="stat-link" href="/admin/bookings?start=${formatDate(start)}&end=${formatDate(end)}&status=CANCELLED">${cancelled}</a></p></article>
  <article class="stat"><h3>Revenue</h3><p><a class="stat-link" href="/admin/billing">${formatMoney(revenue, hotel.currency)}</a></p></article>
</div>
<p class="muted" style="margin-top:10px">Conversations in range: <strong><a class="inline-link" href="/admin/conversations">${conversationsCount}</a></strong></p>
<table>
  <thead><tr><th>Booking ID</th><th>Guest</th><th>Room</th><th>Stay Dates</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No bookings in selected range.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/reports", requireAuth, (_req, res) => {
  res.redirect("/admin/bookings");
});

adminRouter.get("/bookings/:id", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Booking</h2><p>No hotel data found.</p>", true));
    return;
  }

  const bookingId = String(req.params.id ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: {
      guest: true,
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
  const invoiceSentNotice = req.query.invoiceSent ? '<p class="badge ok">Invoice PDF sent to guest.</p>' : "";
  const invoiceErrorNotice =
    typeof req.query.invoiceError === "string" ? `<p class="badge alert">${escapeHtml(req.query.invoiceError)}</p>` : "";
  const [selectedUnitCode, latestInvoiceDispatch] = await Promise.all([getBookingUnitCode(booking.id), getLatestInvoiceDispatch(booking.id)]);
  const paymentChangedSinceLastInvoice = Boolean(
    latestInvoiceDispatch.paymentStatusAtSend && latestInvoiceDispatch.paymentStatusAtSend !== booking.paymentStatus
  );
  const invoiceStatusNote = latestInvoiceDispatch.sentAt
    ? `Last sent ${formatDateTime(latestInvoiceDispatch.sentAt)}${latestInvoiceDispatch.paymentStatusAtSend ? ` (payment status at send: ${latestInvoiceDispatch.paymentStatusAtSend})` : ""}.`
    : "Invoice not sent yet.";
  const canSendInvoice = booking.status === BookingStatus.CONFIRMED;
  const paymentRows = booking.paymentIntents
    .map(
      (payment) => `<tr>
      <td>${escapeHtml(payment.id)}</td>
      <td>${formatMoney(payment.amount, payment.currency)}</td>
      <td>${escapeHtml(payment.kind)}</td>
      <td><span class="badge ${getBadgeClass(payment.status)}">${escapeHtml(payment.status)}</span></td>
      <td>${formatDateTime(payment.createdAt)}</td>
      </tr>`
    )
    .join("");

  const conversationLink = booking.conversationId
    ? `<a class="inline-link" href="/admin/conversations/${encodeURIComponent(booking.conversationId)}">Open linked conversation</a>`
    : '<span class="muted">No conversation linked.</span>';

  const content = `
<h2>Booking ${escapeHtml(booking.id)}</h2>
<p class="muted">Full booking history and actions for front desk operations.</p>
${updatedNotice}
${invoiceSentNotice}
${invoiceErrorNotice}
<div class="actions">
  <a class="btn-link" href="/admin/bookings">Back to reports</a>
  <a class="btn-link" href="/admin/calendar?start=${formatDate(booking.checkIn)}&days=14">Open calendar around stay</a>
  <a class="btn-link primary" href="/admin/inventory?start=${formatDate(booking.checkIn)}&days=7">Adjust inventory around check-in</a>
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/select-unit">Select room unit</a>
  <a class="btn-link" href="/admin/bookings/${encodeURIComponent(booking.id)}/confirm">Confirmation summary</a>
</div>
<div class="grid-2">
  <section>
    <h3>Booking Summary</h3>
    <table>
      <tbody>
        <tr><th>Guest</th><td>${escapeHtml(booking.guest.fullName ?? "-")} (${escapeHtml(booking.guest.phoneE164)})</td></tr>
        <tr><th>Property</th><td>${escapeHtml(booking.property.name)}</td></tr>
        <tr><th>Room type</th><td>${escapeHtml(booking.roomType.name)}</td></tr>
        <tr><th>Selected unit</th><td>${selectedUnitCode ? escapeHtml(selectedUnitCode) : '<span class="badge pending">Not selected</span>'}</td></tr>
        <tr><th>Stay</th><td>${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)} (${booking.nights} nights)</td></tr>
        <tr><th>Total</th><td>${formatMoney(booking.totalAmount, booking.currency)}</td></tr>
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
          <option value="SUCCEEDED" ${booking.paymentStatus === "SUCCEEDED" ? "selected" : ""}>Succeeded</option>
          <option value="FAILED" ${booking.paymentStatus === "FAILED" ? "selected" : ""}>Failed</option>
          <option value="REFUNDED" ${booking.paymentStatus === "REFUNDED" ? "selected" : ""}>Refunded</option>
        </select>
      </label>
      <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Update Payment Status</button>
    </form>
    <form method="post" action="/admin/bookings/${encodeURIComponent(booking.id)}/send-invoice" style="display:grid; gap:8px; margin-top:12px">
      <p class="muted" style="margin:0">${escapeHtml(invoiceStatusNote)}</p>
      ${
        paymentChangedSinceLastInvoice
          ? '<p class="badge alert" style="margin:0; width:fit-content">Payment status changed since last invoice. Resend recommended.</p>'
          : ""
      }
      <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#128c7e; color:#fff; font-weight:700" ${
        canSendInvoice ? "" : "disabled"
      }>${latestInvoiceDispatch.sentAt ? "Resend Invoice PDF to Guest" : "Send Invoice PDF to Guest"}</button>
      ${canSendInvoice ? "" : '<p class="muted" style="margin:0">Invoice can be sent after booking is confirmed.</p>'}
    </form>
  </section>
</div>
<section style="margin-top:14px">
  <h3>Payment Intent History</h3>
  <table>
    <thead><tr><th>ID</th><th>Amount</th><th>Kind</th><th>Status</th><th>Created</th></tr></thead>
    <tbody>${paymentRows || '<tr><td colspan="5">No payment intents for this booking yet.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/bookings/:id/select-unit", requireAuth, async (req, res) => {
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

  const [selectedUnitCode, minInventory, bookedUnits] = await Promise.all([
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
    })
  ]);

  const availableUnits: string[] = [];
  for (let unitNo = 1; unitNo <= Math.max(minInventory, 0); unitNo += 1) {
    const code = buildUnitCode(booking.roomType.code, unitNo);
    if (!bookedUnits.has(code) || code === selectedUnitCode) {
      availableUnits.push(code);
    }
  }

  const unitOptions = availableUnits
    .map((unitCode) => `<option value="${escapeHtml(unitCode)}" ${unitCode === selectedUnitCode ? "selected" : ""}>${escapeHtml(unitCode)}</option>`)
    .join("");

  const content = `
<h2>Select Room Unit</h2>
<p class="muted">Assign one specific unit to this booking before final confirmation.</p>
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

adminRouter.post("/bookings/:id/select-unit", requireAuth, async (req, res) => {
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

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_UNIT_SELECTED",
    entityType: "Booking",
    entityId: booking.id,
    metadata: { unitCode, checkIn: formatDate(booking.checkIn), checkOut: formatDate(booking.checkOut) }
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
      `Room unit ${unitCode} selected for booking ${booking.id}.`
    );
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: booking.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: `${quoteMessage}\nUnit: ${unitCode}.`,
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

adminRouter.get("/bookings/:id/confirm", requireAuth, async (req, res) => {
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
  const policyText =
    "Cancellation policy: Free cancellation up to 48 hours before check-in. Late cancellation or no-show may incur one-night charge.";
  const canConfirm = Boolean(selectedUnitCode);
  const content = `
<h2>Booking Confirmation Summary</h2>
<p class="muted">Review guest details, selected unit and pricing before final confirmation.</p>
${renderBookingWizard(3, { bookingId: booking.id, conversationId: booking.conversationId ?? undefined })}
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
  <button type="submit" style="width:100%; padding:10px 14px; border:0; border-radius:10px; background:#128c7e; color:#fff; font-weight:700" ${
    canConfirm ? "" : "disabled"
  }>Confirm Booking</button>
</form>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/bookings/:id/confirm", requireAuth, async (req, res) => {
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
  const selectedUnitCode = await getBookingUnitCode(booking.id);
  if (!selectedUnitCode) {
    res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}/select-unit`);
    return;
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: { status: BookingStatus.CONFIRMED }
  });

  await logAudit({
    hotelId: hotel.id,
    action: "BOOKING_CONFIRMED_WITH_UNIT",
    entityType: "Booking",
    entityId: booking.id,
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
      `Booking ${booking.id} confirmed. Unit ${selectedUnitCode} reserved for ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}.`
    );
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: booking.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: `${confirmationMessage} Unit: ${selectedUnitCode}.`,
        aiIntent: "BOOKING_CONFIRMED"
      }
    });
    await prisma.conversation.update({
      where: { id: booking.conversationId },
      data: { state: ConversationState.CONFIRMED, lastMessageAt: new Date() }
    });
  }

  const autoInvoice = await sendInvoicePdfForBooking({
    hotelId: hotel.id,
    bookingId: booking.id,
    trigger: "BOOKING_CONFIRMED_ACTION",
    force: false
  });

  const query = new URLSearchParams({ updated: "1" });
  if (autoInvoice.sent) query.set("invoiceSent", "1");
  if (autoInvoice.error) query.set("invoiceError", autoInvoice.error);
  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/send-invoice", requireAuth, async (req, res) => {
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
    force: true
  });

  const query = new URLSearchParams();
  if (result.sent) query.set("invoiceSent", "1");
  if (result.error) query.set("invoiceError", result.error);
  if (!result.sent && !result.error) query.set("invoiceError", "Invoice not sent. Booking may not be confirmed.");
  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/status", requireAuth, async (req, res) => {
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
    await logAudit({
      hotelId: hotel.id,
      action: "BOOKING_STATUS_UPDATED",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { status: nextStatus }
    });
  }
  const becameConfirmed = nextStatus === BookingStatus.CONFIRMED && existingBooking.status !== BookingStatus.CONFIRMED;
  let autoInvoiceResult: { sent: boolean; skipped: boolean; error?: string } | null = null;
  if (becameConfirmed) {
    autoInvoiceResult = await sendInvoicePdfForBooking({
      hotelId: hotel.id,
      bookingId,
      trigger: "BOOKING_STATUS_TO_CONFIRMED",
      force: false
    });
  }
  const query = new URLSearchParams({ updated: "1" });
  if (autoInvoiceResult?.sent) query.set("invoiceSent", "1");
  if (autoInvoiceResult?.error) query.set("invoiceError", autoInvoiceResult.error);
  res.redirect(`/admin/bookings/${encodeURIComponent(bookingId)}?${query.toString()}`);
});

adminRouter.post("/bookings/:id/payment", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.redirect("/admin/bookings");
    return;
  }

  const bookingId = String(req.params.id ?? "");
  const rawStatus = String(req.body.paymentStatus ?? "");
  const allowed: PaymentStatus[] = [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.REFUNDED];
  const nextPaymentStatus: PaymentStatus | null = allowed.includes(rawStatus as PaymentStatus)
    ? (rawStatus as PaymentStatus)
    : null;

  let invoiceSent = false;
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
    const invoiceResult = await sendInvoicePdfForBooking({
      hotelId: hotel.id,
      bookingId,
      trigger: "PAYMENT_STATUS_UPDATED",
      force: true
    });
    invoiceSent = invoiceResult.sent;
  }
  const query = new URLSearchParams({ updated: "1" });
  if (invoiceSent) query.set("invoiceSent", "1");
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

  const start = parseDateInput(req.query.start, startOfDay(new Date()));
  const days = clamp(parseIntegerInput(req.query.days, 14), 7, 21);
  const dates = enumerateDates(start, days);
  const endExclusive = addDays(start, days);
  const roomTypeIds = hotel.roomTypes.map((room) => room.id);

  const inventories = await prisma.inventory.findMany({
    where: { hotelId: hotel.id, roomTypeId: { in: roomTypeIds }, date: { gte: start, lt: endExclusive } }
  });
  const inventoryMap = new Map<string, (typeof inventories)[number]>();
  for (const row of inventories) {
    inventoryMap.set(`${row.roomTypeId}_${formatDate(row.date)}`, row);
  }

  const bookings = await prisma.booking.findMany({
    where: {
      hotelId: hotel.id,
      roomTypeId: { in: roomTypeIds },
      status: { in: ["PENDING", "CONFIRMED"] },
      checkIn: { lt: endExclusive },
      checkOut: { gt: start }
    }
  });

  const bookingCountMap = new Map<string, number>();
  for (const booking of bookings) {
    for (const date of dates) {
      if (date >= booking.checkIn && date < booking.checkOut) {
        const key = `${booking.roomTypeId}_${formatDate(date)}`;
        bookingCountMap.set(key, (bookingCountMap.get(key) ?? 0) + 1);
      }
    }
  }

  const occupancyByDate = dates.map((date) => {
    const keyDate = formatDate(date);
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

  const header = dates.map((date) => `<th>${formatDate(date)}</th>`).join("");
  const rows = hotel.roomTypes
    .map((room) => {
      const cells = dates
        .map((date) => {
          const key = `${room.id}_${formatDate(date)}`;
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
<div class="actions">
  <a class="btn-link primary" href="/admin/inventory?start=${formatDate(start)}&days=${days}">Edit Inventory for This Range</a>
  <a class="btn-link" href="/admin/bookings?start=${formatDate(start)}&end=${formatDate(addDays(start, days - 1))}">View Booking Report for Range</a>
  <a class="btn-link" href="/admin/rooms">Update Room Pricing</a>
</div>
<form method="get" action="/admin/calendar" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
  <label>Start <input type="date" name="start" value="${formatDate(start)}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px" /></label>
  <label>Days <input type="number" min="7" max="21" name="days" value="${days}" style="padding:8px; border:1px solid #d8dee6; border-radius:8px; width:90px" /></label>
  <button type="submit" style="padding:9px 13px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Show</button>
</form>
<table>
  <thead><tr><th>Room Type</th>${header}</tr></thead>
  <tbody>${rows || '<tr><td colspan="8">No room types found.</td></tr>'}</tbody>
</table>`;
  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/conversations", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Conversations</h2><p>No hotel data found.</p>", true));
    return;
  }

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
      return `<tr>
      <td><a class="inline-link" href="/admin/conversations/${encodeURIComponent(conversation.id)}">${escapeHtml(
        conversation.guest.fullName ?? conversation.guest.phoneE164
      )}</a></td>
      <td>${escapeHtml(conversation.guest.phoneE164)}</td>
      <td>${latestMessage ? escapeHtml(latestMessage.body.slice(0, 90)) : "-"}</td>
      <td><span class="badge ${getConversationBadgeClass(conversation.state)}">${escapeHtml(conversation.state)}</span></td>
      <td>${latestBooking ? `<a class="inline-link" href="/admin/bookings/${encodeURIComponent(latestBooking.id)}">${escapeHtml(latestBooking.id)}</a>` : "-"}</td>
      <td>${formatDateTime(conversation.lastMessageAt ?? conversation.createdAt)}</td>
      <td><a class="inline-link" href="/admin/conversations/${encodeURIComponent(conversation.id)}">Open details</a></td>
      </tr>`;
    })
    .join("");

  const content = `
<h2>Conversations</h2>
<p class="muted">Guest WhatsApp conversations with full history and action controls.</p>
<div class="actions">
  <a class="btn-link primary" href="/admin/bookings">Open booking report</a>
  <a class="btn-link" href="/admin/inventory">Check inventory</a>
  <a class="btn-link" href="/admin/calendar">Open room calendar</a>
</div>
<form method="get" action="/admin/conversations" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
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
<table>
  <thead><tr><th>Guest</th><th>Phone</th><th>Latest Message</th><th>State</th><th>Linked Booking</th><th>Last Activity</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No conversations yet.</td></tr>'}</tbody>
</table>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/conversations/:id", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Conversation</h2><p>No hotel data found.</p>", true));
    return;
  }

  const conversationId = String(req.params.id ?? "");
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, hotelId: hotel.id },
    include: {
      guest: true,
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

  const updatedNotice = req.query.updated ? '<p class="badge ok">Conversation updated.</p>' : "";
  const messageTimeline = conversation.messages
    .map(
      (message) => `<article class="bubble ${message.direction === MessageDirection.INBOUND ? "inbound" : "outbound"}">
      <div class="bubble-head">
        <span><strong>${escapeHtml(message.direction)}</strong></span>
        <span>${formatDateTime(message.createdAt)}</span>
      </div>
      <p class="bubble-body">${escapeHtml(message.body)}</p>
      <p class="bubble-meta">Intent: ${escapeHtml(message.aiIntent ?? "-")}</p>
      </article>`
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

  const content = `
<h2>Conversation Detail</h2>
<p class="muted">Complete message history and front-desk actions for one guest thread.</p>
${updatedNotice}
<div class="actions">
  <a class="btn-link" href="/admin/conversations">Back to conversations</a>
  <a class="btn-link" href="/admin/bookings">Open booking report</a>
  <a class="btn-link primary" href="/admin/inventory">Check room availability</a>
  <a class="btn-link" href="/admin/conversations/${encodeURIComponent(
    conversation.id
  )}/create-booking">Start structured booking flow</a>
</div>
<div class="grid-2">
  <section>
    <h3>Guest & State</h3>
    <table>
      <tbody>
        <tr><th>Guest</th><td>${escapeHtml(conversation.guest.fullName ?? "-")}</td></tr>
        <tr><th>Phone</th><td>${escapeHtml(conversation.guest.phoneE164)}</td></tr>
        <tr><th>Current state</th><td><span class="badge ${getConversationBadgeClass(conversation.state)}">${escapeHtml(conversation.state)}</span></td></tr>
        <tr><th>Property</th><td>${escapeHtml(conversation.property?.name ?? "Not assigned")}</td></tr>
        <tr><th>Last activity</th><td>${formatDateTime(conversation.lastMessageAt ?? conversation.updatedAt)}</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h3>Actions</h3>
    <form method="post" action="/admin/conversations/${encodeURIComponent(conversation.id)}/state" style="display:grid; gap:8px; margin-bottom:12px">
      <label>Conversation state
        <select name="state" style="padding:8px; border:1px solid #d8dee6; border-radius:8px">
          <option value="NEW" ${conversation.state === "NEW" ? "selected" : ""}>New</option>
          <option value="QUALIFYING" ${conversation.state === "QUALIFYING" ? "selected" : ""}>Qualifying</option>
          <option value="QUOTED" ${conversation.state === "QUOTED" ? "selected" : ""}>Quoted</option>
          <option value="PAYMENT_PENDING" ${conversation.state === "PAYMENT_PENDING" ? "selected" : ""}>Payment pending</option>
          <option value="CONFIRMED" ${conversation.state === "CONFIRMED" ? "selected" : ""}>Confirmed</option>
          <option value="CLOSED" ${conversation.state === "CLOSED" ? "selected" : ""}>Closed</option>
        </select>
      </label>
      <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#25d366; color:#083d2d; font-weight:700">Update State</button>
    </form>
    <form method="post" action="/admin/conversations/${encodeURIComponent(conversation.id)}/reply" style="display:grid; gap:8px">
      <label>Quick reply text
        <textarea name="replyBody" rows="4" required style="width:100%; padding:9px; border:1px solid #d8dee6; border-radius:8px" placeholder="Type manual reply to log in history"></textarea>
      </label>
      <button type="submit" style="padding:9px 12px; border:0; border-radius:8px; background:#075e54; color:#fff; font-weight:700">Log Outbound Reply</button>
    </form>
  </section>
</div>
<section style="margin-top:14px">
  <h3>Message History</h3>
  <div class="timeline">${messageTimeline || '<p class="muted">No messages yet.</p>'}</div>
</section>
<section style="margin-top:14px">
  <h3>Linked Bookings</h3>
  <table>
    <thead><tr><th>Booking</th><th>Room</th><th>Stay</th><th>Status</th></tr></thead>
    <tbody>${linkedBookingRows || '<tr><td colspan="4">No linked bookings yet.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.post("/conversations/:id/state", requireAuth, async (req, res) => {
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

adminRouter.post("/conversations/:id/reply", requireAuth, async (req, res) => {
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

  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, hotelId: hotel.id } });
  if (!conversation) {
    res.redirect("/admin/conversations");
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
    action: "CONVERSATION_REPLY_LOGGED",
    entityType: "Conversation",
    entityId: conversation.id,
    metadata: { bodyPreview: replyBody.slice(0, 120) }
  });

  res.redirect(`/admin/conversations/${encodeURIComponent(conversationId)}?updated=1`);
});

adminRouter.get("/conversations/:id/create-booking", requireAuth, async (req, res) => {
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

adminRouter.post("/conversations/:id/create-booking", requireAuth, async (req, res) => {
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

  const booking = await prisma.booking.create({
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
      paymentStatus: PaymentStatus.PENDING
    }
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

  res.redirect(`/admin/bookings/${encodeURIComponent(booking.id)}/select-unit`);
});

adminRouter.get("/subscription", requireAuth, async (_req, res) => {
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
      }
    }
  });

  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Subscription</h2><p>No hotel data found.</p>", true));
    return;
  }

  const sub = hotel.subscriptions[0];
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
        <tr><th>Plan</th><td>${escapeHtml(sub?.plan.name ?? "No active plan")}</td></tr>
        <tr><th>Price</th><td>${sub ? `${sub.plan.monthlyPrice} ${escapeHtml(hotel.currency)} / month` : "-"}</td></tr>
        <tr><th>Status</th><td><span class="badge ${sub?.status === "ACTIVE" ? "ok" : "pending"}">${escapeHtml(sub?.status ?? "NONE")}</span></td></tr>
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
</div>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/billing", requireAuth, async (_req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    include: {
      invoices: { orderBy: { createdAt: "desc" }, take: 8 },
      paymentIntents: { orderBy: { createdAt: "desc" }, take: 8 }
    }
  });

  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Billing</h2><p>No hotel data found.</p>", true));
    return;
  }

  const invoiceRows = hotel.invoices
    .map(
      (invoice) => `<tr>
      <td><a class="inline-link" href="/admin/bookings">${escapeHtml(invoice.id)}</a></td>
      <td>${invoice.amountTotal} ${escapeHtml(invoice.currency)}</td>
      <td><span class="badge ${invoice.status === "PAID" ? "ok" : "pending"}">${escapeHtml(invoice.status)}</span></td>
      </tr>`
    )
    .join("");

  const paymentRows = hotel.paymentIntents
    .map(
      (payment) => `<tr>
      <td><a class="inline-link" href="/admin/bookings">${escapeHtml(payment.id.slice(0, 10).toUpperCase())}</a></td>
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
</div>
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
    <h3>Latest Invoices</h3>
    <table>
      <thead><tr><th>Invoice</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>${invoiceRows || '<tr><td colspan="3">No invoices yet.</td></tr>'}</tbody>
    </table>
  </section>
</div>
<section style="margin-top: 14px">
  <h3>Payment Intents</h3>
  <table>
    <thead><tr><th>ID</th><th>Amount</th><th>Kind</th><th>Status</th></tr></thead>
    <tbody>${paymentRows || '<tr><td colspan="4">No payment intents yet.</td></tr>'}</tbody>
  </table>
</section>`;

  res.type("html").send(renderLayout(content, true));
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
</table>`;

  res.type("html").send(renderLayout(content, true));
});

adminRouter.get("/setup", requireAuth, async (req, res) => {
  const hotel = await prisma.hotel.findFirst({
    where: { slug: "al-ashkhara-beach-resort" },
    include: { properties: { orderBy: { createdAt: "asc" }, take: 1 } }
  });
  if (!hotel) {
    res.type("html").send(renderLayout("<h2>Setup</h2><p>No hotel data found.</p>", true));
    return;
  }

  const property = hotel.properties[0] ?? null;
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
        <input type="text" name="whatsappPhoneNumberId" value="${escapeHtml(config.whatsappPhoneNumberId)}" placeholder="e.g. 1002161622980212" style="width:100%; padding:8px; border:1px solid #d8dee6; border-radius:8px" />
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
    where: { slug: "al-ashkhara-beach-resort" },
    include: { properties: { orderBy: { createdAt: "asc" }, take: 1 } }
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

  const nextConfig: PartnerSetupConfig = {
    hotelDescription: String(req.body.hotelDescription ?? "").trim(),
    amenitiesSummary: String(req.body.amenitiesSummary ?? "").trim(),
    whatsappPhoneNumberId: String(req.body.whatsappPhoneNumberId ?? "").trim(),
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
    aiKnowledgeBaseFr: String(req.body.aiKnowledgeBaseFr ?? "").trim()
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
    where: { slug: "al-ashkhara-beach-resort" },
    include: { properties: { orderBy: { createdAt: "asc" }, take: 1 } }
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
  const property = hotel.properties[0];
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
