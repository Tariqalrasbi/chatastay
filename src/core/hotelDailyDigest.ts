import {
  BookingStatus,
  ConversationState,
  PaymentKind,
  PaymentStatus,
  UserRole
} from "@prisma/client";
import { prisma } from "../db";
import { loadManagementKpis } from "./managementKpiDashboard";
import { loadPlatformAlerts, type PlatformAlertsResult } from "./ownerPlatformAlerts";
import { sendOwnerDigestEmail, isOwnerDigestSmtpConfigured } from "./ownerDigestMail";
import { wallClockLocalToUtc, formatYmdInHotelZone } from "../jobs/preArrivalReminderJob";

export type HotelDigestRunResult = {
  ok: boolean;
  hotelId: string;
  digestKey: string;
  status: string;
  message?: string;
};

function addDaysToYmd(ymd: string, delta: number): string {
  const [y, M, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const x = new Date(Date.UTC(y, M - 1, d + delta));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getBaseUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "") || "http://localhost:3000";
}

/**
 * Builds and optionally emails the hotel-scoped daily digest (single property, no portfolio data).
 */
export async function runHotelDailyDigest(opts: {
  hotelId: string;
  manual?: boolean;
  force?: boolean;
  /** When the scheduler already computed platform alerts for all hotels, pass it to avoid N× full scans. */
  preloadedAlerts?: PlatformAlertsResult;
}): Promise<HotelDigestRunResult> {
  const manual = Boolean(opts.manual);
  const force = Boolean(opts.force);
  const hotelId = opts.hotelId;

  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    include: {
      roomTypes: { where: { isActive: true }, select: { id: true, totalInventory: true } }
    }
  });
  if (!hotel) {
    return { ok: false, hotelId, digestKey: "", status: "FAILED", message: "Hotel not found." };
  }

  const tz = (hotel.timezone ?? "Asia/Muscat").trim() || "Asia/Muscat";
  const now = new Date();
  const digestKey = formatYmdInHotelZone(now, tz);
  const rangeStart = wallClockLocalToUtc(digestKey, "00:00", tz);
  const rangeEndExclusive = wallClockLocalToUtc(addDaysToYmd(digestKey, 1), "00:00", tz);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEndExclusive.getTime())) {
    return { ok: false, hotelId, digestKey, status: "FAILED", message: "Invalid hotel timezone window." };
  }

  const existing = await prisma.hotelDailyDigestLog.findUnique({
    where: { hotelId_digestKey: { hotelId, digestKey } }
  });
  if (existing?.status === "SENT" && !force) {
    return {
      ok: false,
      hotelId,
      digestKey,
      status: "SKIPPED",
      message: "Digest already sent for this day (use force on manual send to resend)."
    };
  }
  if (existing?.status === "FAILED" && !manual && !force) {
    return {
      ok: false,
      hotelId,
      digestKey,
      status: "SKIPPED",
      message: "Previous send failed; use manual send on Daily digest page to retry."
    };
  }
  if (existing?.status === "SKIPPED_NO_SMTP" && !manual && !force) {
    return {
      ok: false,
      hotelId,
      digestKey,
      status: "SKIPPED",
      message: "Digest already recorded for today (SMTP was off)."
    };
  }

  const recipients = await prisma.hotelUser.findMany({
    where: {
      hotelId,
      isActive: true,
      role: { in: [UserRole.OWNER, UserRole.MANAGER] }
    },
    select: { email: true, fullName: true }
  });
  const toList = recipients.map((u) => (u.email ?? "").trim()).filter(Boolean);
  const fallbackTo = (process.env.ADMIN_EMAIL ?? "").trim();
  const emailTo = toList.length ? toList.join(", ") : fallbackTo;
  if (!emailTo) {
    return {
      ok: false,
      hotelId,
      digestKey,
      status: "FAILED",
      message: "No OWNER/MANAGER emails and ADMIN_EMAIL is empty."
    };
  }

  const alertPack = opts.preloadedAlerts ?? (await loadPlatformAlerts());

  const [kpi, openThreads, failedGuestToday, unassignedToday] = await Promise.all([
    loadManagementKpis({
      hotelId,
      currency: hotel.currency,
      rangeStart,
      rangeEndExclusive,
      roomTypes: hotel.roomTypes.map((rt) => ({ id: rt.id, totalInventory: rt.totalInventory })),
      operationalSnapshotUsesRange: true
    }),
    prisma.conversation.count({
      where: { hotelId, state: { not: ConversationState.CLOSED } }
    }),
    prisma.paymentIntent.count({
      where: {
        hotelId,
        kind: PaymentKind.BOOKING,
        status: PaymentStatus.FAILED,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive }
      }
    }),
    prisma.booking.count({
      where: {
        hotelId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
        roomUnitId: null,
        checkIn: { lt: rangeEndExclusive },
        checkOut: { gt: rangeStart }
      }
    })
  ]);

  const hotelAlerts = alertPack.alerts.filter((a) => a.hotelId === hotelId);
  const topAlerts = [...hotelAlerts].sort((a, b) => {
    const r = (a.severity === "critical" ? 0 : a.severity === "warning" ? 1 : 2) -
      (b.severity === "critical" ? 0 : b.severity === "warning" ? 1 : 2);
    return r !== 0 ? r : a.title.localeCompare(b.title);
  }).slice(0, 8);

  const payLines = kpi.paymentFolioBuckets.map((b) => `  ${b.label}: ${formatMoney(b.amount, hotel.currency)} (${b.count} txns)`).join("\n");

  const summaryJson = JSON.stringify({
    digestKey,
    timezone: tz,
    bookingsTotal: kpi.bookingsTotal,
    arrivals: kpi.arrivalsOnSnapshot,
    departures: kpi.departuresOnSnapshot,
    stayovers: kpi.stayoversOnSnapshot,
    roomRevenue: kpi.roomRevenue,
    fbRevenue: kpi.fbRevenue,
    totalRevenueApprox: kpi.totalRevenueApprox,
    openThreads,
    failedGuestPayments: failedGuestToday,
    alertCount: hotelAlerts.length
  });

  const baseUrl = getBaseUrl();
  const adminHome = `${baseUrl}/admin/profile`;

  const text = [
    `${hotel.displayName} — Daily operations digest (${digestKey} · ${tz})`,
    "",
    "Bookings & stays (digest day)",
    `  Check-ins with arrival today: ${kpi.arrivalsOnSnapshot}`,
    `  Departures (checkout today): ${kpi.departuresOnSnapshot}`,
    `  Stayovers (in-house, not arr/dep today): ${kpi.stayoversOnSnapshot}`,
    `  Bookings with check-in in period: ${kpi.bookingsTotal} (${kpi.bookingsConfirmed} confirmed, ${kpi.bookingsPending} pending, ${kpi.bookingsCancelled} cancelled, ${kpi.bookingsNoShow} no-show)`,
    "",
    "Room inventory",
    `  Active room units: ${kpi.totalRoomUnits} · Inactive / off-sale units: ${kpi.inactiveRoomUnits}`,
    `  Occupancy (range, capacity-style): ${kpi.occupancyRatePct.toFixed(1)}%`,
    unassignedToday > 0
      ? `  Attention: ${unassignedToday} in-house booking(s) without a physical unit assigned.`
      : "  Room-unit assignment: no overlapping stays missing a unit.",
    "",
    "Revenue (approx., same period)",
    `  Room revenue (confirmed): ${formatMoney(kpi.roomRevenue, hotel.currency)}`,
    `  F&B posted: ${formatMoney(kpi.fbRevenue, hotel.currency)}`,
    `  Total (room + F&B + folio charges in range): ${formatMoney(kpi.totalRevenueApprox, hotel.currency)}`,
    "",
    "Folio payments by method (period)",
    payLines || "  (none)",
    "",
    "Guest messaging",
    `  New conversations (started today): ${kpi.conversationsTotal}`,
    `  Open conversations (not closed): ${openThreads}`,
    `  With human handoff in period: ${kpi.conversationsHumanHandoff}`,
    `  Messages in / out: ${kpi.messagesInbound} / ${kpi.messagesOutbound}`,
    "",
    "Issues for this property",
    failedGuestToday > 0 ? `  Failed guest payments (today): ${failedGuestToday}` : "  Failed guest payments (today): 0",
    hotelAlerts.length
      ? `  Open alerts: ${hotelAlerts.length} (see top items below)`
      : "  Open alerts: none from the platform alert rules.",
    "",
    ...(topAlerts.length
      ? ["Top alerts:", ...topAlerts.map((a) => `  [${a.severity}] ${a.title}`)]
      : []),
    "",
    `Admin: ${adminHome}`
  ].join("\n");

  const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI,Inter,Arial,sans-serif;color:#0f172a">
<p style="font-size:16px;font-weight:700">${escapeHtml(hotel.displayName)} — Daily digest</p>
<p style="color:#64748b;font-size:13px">${escapeHtml(digestKey)} · ${escapeHtml(tz)}</p>
<h3 style="font-size:14px">Arrivals / departures / stayovers</h3>
<ul style="font-size:14px"><li>Arrivals today: <strong>${kpi.arrivalsOnSnapshot}</strong></li><li>Departures today: <strong>${kpi.departuresOnSnapshot}</strong></li><li>Stayovers: <strong>${kpi.stayoversOnSnapshot}</strong></li><li>Bookings (check-in in period): <strong>${kpi.bookingsTotal}</strong> (conf ${kpi.bookingsConfirmed}, canc ${kpi.bookingsCancelled})</li></ul>
<h3 style="font-size:14px">Rooms</h3>
<p style="font-size:14px">Active units: <strong>${kpi.totalRoomUnits}</strong> · Inactive: <strong>${kpi.inactiveRoomUnits}</strong> · Occupancy: <strong>${kpi.occupancyRatePct.toFixed(1)}%</strong></p>
${unassignedToday > 0 ? `<p style="color:#b45309;font-size:14px"><strong>Attention:</strong> ${unassignedToday} booking(s) overlapping today without a room unit.</p>` : ""}
<h3 style="font-size:14px">Revenue</h3>
<p style="font-size:14px">Room: ${escapeHtml(formatMoney(kpi.roomRevenue, hotel.currency))} · F&amp;B: ${escapeHtml(formatMoney(kpi.fbRevenue, hotel.currency))} · Total approx: ${escapeHtml(formatMoney(kpi.totalRevenueApprox, hotel.currency))}</p>
<h3 style="font-size:14px">Folio payments</h3>
<ul style="font-size:14px">${kpi.paymentFolioBuckets.map((b) => `<li>${escapeHtml(b.label)}: ${escapeHtml(formatMoney(b.amount, hotel.currency))} (${b.count})</li>`).join("") || "<li>No folio payments in period.</li>"}</ul>
<h3 style="font-size:14px">Messaging</h3>
<p style="font-size:14px">New conversations: ${kpi.conversationsTotal} · Open threads: ${openThreads} · Handoffs: ${kpi.conversationsHumanHandoff} · Msg in/out: ${kpi.messagesInbound}/${kpi.messagesOutbound}</p>
<h3 style="font-size:14px">Alerts &amp; payments</h3>
<p style="font-size:14px">Failed guest payments (today): <strong>${failedGuestToday}</strong> · Property alerts: <strong>${hotelAlerts.length}</strong></p>
${topAlerts.length ? `<ul style="font-size:14px">${topAlerts.map((a) => `<li><strong>${escapeHtml(a.severity)}</strong> — ${escapeHtml(a.title)}</li>`).join("")}</ul>` : ""}
<p style="margin-top:18px;font-size:14px"><a href="${escapeHtml(adminHome)}" style="color:#075e54;font-weight:700">Open hotel admin</a></p>
</body></html>`;

  const subject = `${hotel.displayName} — Daily digest ${digestKey}`;

  if (!isOwnerDigestSmtpConfigured()) {
    await prisma.hotelDailyDigestLog.upsert({
      where: { hotelId_digestKey: { hotelId, digestKey } },
      create: {
        hotelId,
        digestKey,
        status: "SKIPPED_NO_SMTP",
        recipientsCsv: emailTo,
        subject,
        errorMessage: "SMTP not configured.",
        summaryJson,
        sentAt: null
      },
      update: {
        status: "SKIPPED_NO_SMTP",
        recipientsCsv: emailTo,
        subject,
        errorMessage: "SMTP not configured.",
        summaryJson,
        sentAt: null
      }
    });
    console.warn(`[hotel-digest] ${hotel.slug} ${digestKey} SKIPPED_NO_SMTP — ${summaryJson.slice(0, 120)}…`);
    return {
      ok: true,
      hotelId,
      digestKey,
      status: "SKIPPED_NO_SMTP",
      message: "Recorded; configure SMTP to email."
    };
  }

  try {
    await sendOwnerDigestEmail({ to: emailTo, subject, text, html });
    await prisma.hotelDailyDigestLog.upsert({
      where: { hotelId_digestKey: { hotelId, digestKey } },
      create: {
        hotelId,
        digestKey,
        status: "SENT",
        recipientsCsv: emailTo,
        subject,
        errorMessage: null,
        summaryJson,
        sentAt: new Date()
      },
      update: {
        status: "SENT",
        recipientsCsv: emailTo,
        subject,
        errorMessage: null,
        summaryJson,
        sentAt: new Date()
      }
    });
    return { ok: true, hotelId, digestKey, status: "SENT", message: `Sent to ${emailTo}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.hotelDailyDigestLog.upsert({
      where: { hotelId_digestKey: { hotelId, digestKey } },
      create: {
        hotelId,
        digestKey,
        status: "FAILED",
        recipientsCsv: emailTo,
        subject,
        errorMessage: msg,
        summaryJson,
        sentAt: null
      },
      update: {
        status: "FAILED",
        recipientsCsv: emailTo,
        subject,
        errorMessage: msg,
        summaryJson,
        sentAt: null
      }
    });
    return { ok: false, hotelId, digestKey, status: "FAILED", message: msg };
  }
}
