import { PaymentKind, PaymentStatus } from "@prisma/client";
import { prisma } from "../db";
import { loadOwnerPortfolioKpis } from "./ownerPortfolioKpi";
import { loadPlatformAlerts, type PlatformAlert } from "./ownerPlatformAlerts";
import { sendOwnerDigestEmail, isOwnerDigestSmtpConfigured } from "./ownerDigestMail";
import { wallClockLocalToUtc, formatYmdInHotelZone } from "./guestMessagingSchedule";

export type OwnerDigestRunResult = {
  ok: boolean;
  digestKey: string;
  status: string;
  message?: string;
};

function addDaysToYmd(ymd: string, delta: number): string {
  const [y, M, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const x = new Date(Date.UTC(y, M - 1, d + delta));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

function getDigestTimeZone(): string {
  return (process.env.OWNER_DIGEST_TZ ?? "Asia/Muscat").trim() || "Asia/Muscat";
}

function getBaseUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "") || "http://localhost:3000";
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

type DigestSummaryJson = {
  digestKey: string;
  timeZone: string;
  hotelsTotal: number;
  hotelsActive: number;
  bookingsToday: number;
  portfolioBookingsConfirmed: number;
  roomRevenueByCurrency: { currency: string; amount: number }[];
  conversationsToday: number;
  subscriptionsActiveOrTrial: number;
  failedSubPaymentsToday: number;
  failedGuestPaymentsToday: number;
  criticalOpen: number;
  warningOpen: number;
  infoOpen: number;
  newAlertCount: number;
};

function pickTopAlerts(alerts: PlatformAlert[], limit: number): PlatformAlert[] {
  const crit = alerts.filter((a) => a.severity === "critical");
  const warn = alerts.filter((a) => a.severity === "warning");
  const rest = alerts.filter((a) => a.severity === "info");
  return [...crit, ...warn, ...rest].slice(0, limit);
}

/**
 * Runs the daily owner digest: KPIs for “today” in OWNER_DIGEST_TZ, platform alerts, failed payments.
 * Idempotent per digestKey (one successful send per calendar day unless force).
 */
export async function runOwnerDailyDigest(opts: {
  manual?: boolean;
  force?: boolean;
}): Promise<OwnerDigestRunResult> {
  const manual = Boolean(opts.manual);
  const force = Boolean(opts.force);
  const tz = getDigestTimeZone();
  const now = new Date();
  const digestKey = formatYmdInHotelZone(now, tz);
  const rangeStart = wallClockLocalToUtc(digestKey, "00:00", tz);
  const rangeEndExclusive = wallClockLocalToUtc(addDaysToYmd(digestKey, 1), "00:00", tz);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEndExclusive.getTime())) {
    return { ok: false, digestKey, status: "FAILED", message: "Invalid digest date range for timezone." };
  }

  const existing = await prisma.ownerDailyDigestLog.findUnique({ where: { digestKey } });
  if (existing?.status === "SENT" && !force) {
    return { ok: false, digestKey, status: "SKIPPED", message: "Digest already sent for this day (use force to resend)." };
  }
  if (existing?.status === "FAILED" && !manual && !force) {
    return { ok: false, digestKey, status: "SKIPPED", message: "Previous send failed; use manual send from /owner/digest to retry." };
  }
  if (existing?.status === "SKIPPED_NO_SMTP" && !manual && !force) {
    return {
      ok: false,
      digestKey,
      status: "SKIPPED",
      message: "Digest already recorded for today (SMTP was off). Manual send can retry after SMTP is configured."
    };
  }

  const [kpi, alertPack, failedToday, prevSent] = await Promise.all([
    loadOwnerPortfolioKpis({
      rangeStart,
      rangeEndExclusive,
      presetLabel: "Today"
    }),
    loadPlatformAlerts(),
    prisma.paymentIntent.groupBy({
      by: ["kind"],
      where: {
        status: PaymentStatus.FAILED,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _count: { id: true }
    }),
    prisma.ownerDailyDigestLog.findFirst({
      where: { status: "SENT", sentAt: { not: null } },
      orderBy: { sentAt: "desc" }
    })
  ]);

  let failedSub = 0;
  let failedGuest = 0;
  for (const row of failedToday) {
    if (row.kind === PaymentKind.SUBSCRIPTION) failedSub += row._count.id;
    else if (row.kind === PaymentKind.BOOKING) failedGuest += row._count.id;
  }

  const alerts = alertPack.alerts;
  const prevIds = new Set<string>();
  if (prevSent?.alertIdsJson) {
    try {
      const parsed = JSON.parse(prevSent.alertIdsJson) as string[];
      if (Array.isArray(parsed)) for (const id of parsed) prevIds.add(id);
    } catch {
      /* ignore */
    }
  }
  const currentIds = alerts.map((a) => a.id);
  const newAlertCount = currentIds.filter((id) => !prevIds.has(id)).length;

  const criticalOpen = alerts.filter((a) => a.severity === "critical").length;
  const warningOpen = alerts.filter((a) => a.severity === "warning").length;
  const infoOpen = alerts.filter((a) => a.severity === "info").length;

  const summary: DigestSummaryJson = {
    digestKey,
    timeZone: tz,
    hotelsTotal: kpi.hotelsTotal,
    hotelsActive: kpi.hotelsActive,
    bookingsToday: kpi.portfolioBookingsTotal,
    portfolioBookingsConfirmed: kpi.portfolioBookingsConfirmed,
    roomRevenueByCurrency: kpi.portfolioRoomRevenueByCurrency,
    conversationsToday: kpi.portfolioConversations,
    subscriptionsActiveOrTrial: kpi.subscriptionsActiveOrTrial,
    failedSubPaymentsToday: failedSub,
    failedGuestPaymentsToday: failedGuest,
    criticalOpen,
    warningOpen,
    infoOpen,
    newAlertCount
  };

  const baseUrl = getBaseUrl();
  const top = pickTopAlerts(alerts, 8);
  const roomRevLine = kpi.portfolioRoomRevenueByCurrency.length
    ? kpi.portfolioRoomRevenueByCurrency.map((x) => formatMoney(x.amount, x.currency)).join(" · ")
    : "—";

  const textLines: string[] = [
    `ChatEstate — Owner daily digest (${digestKey} · ${tz})`,
    "",
    "Key KPIs (today in digest timezone)",
    `  Hotels: ${kpi.hotelsTotal} total · ${kpi.hotelsActive} active`,
    `  Bookings (check-in today): ${kpi.portfolioBookingsTotal} (${kpi.portfolioBookingsConfirmed} confirmed)`,
    `  Room revenue (confirmed, check-in today): ${roomRevLine}`,
    `  New conversations (today): ${kpi.portfolioConversations}`,
    `  Active subscriptions (ACTIVE/TRIALING): ${kpi.subscriptionsActiveOrTrial}`,
    "",
    "Failed payments (today)",
    `  Subscription: ${failedSub} · Guest booking: ${failedGuest}`,
    "",
    "Alerts",
    `  New since last successful digest: ${newAlertCount}`,
    `  Open now — Critical: ${criticalOpen} · Warning: ${warningOpen} · Info: ${infoOpen}`,
    ""
  ];
  if (top.length) {
    textLines.push("Top items:");
    for (const a of top) {
      textLines.push(`  [${a.severity.toUpperCase()}] ${a.hotelName}: ${a.title}${a.value ? ` (${a.value})` : ""}`);
    }
  } else {
    textLines.push("No open platform alerts.");
  }
  textLines.push(
    "",
    `Open dashboard: ${baseUrl}/owner/dashboard`,
    `Open alerts: ${baseUrl}/owner/alerts`
  );

  const subject = `ChatEstate owner digest — ${digestKey}`;
  const htmlTopRows = top
    .map(
      (a) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb"><span style="font-weight:700">${escapeHtml(
          a.severity
        )}</span></td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(
          a.hotelName
        )}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(a.title)} ${
          a.value ? `<span style="color:#64748b">(${escapeHtml(String(a.value))})</span>` : ""
        }</td></tr>`
    )
    .join("");

  const html = `<!DOCTYPE html><html><body style="font-family:Segoe UI,Inter,Arial,sans-serif;color:#0f172a;line-height:1.45">
<p style="font-size:16px;font-weight:700">Owner daily digest</p>
<p style="color:#64748b;font-size:13px">${escapeHtml(digestKey)} · ${escapeHtml(tz)}</p>
<h3 style="margin:18px 0 8px;font-size:14px">Key KPIs (today)</h3>
<ul style="margin:0;padding-left:18px;font-size:14px">
<li>Hotels: <strong>${kpi.hotelsTotal}</strong> total · <strong>${kpi.hotelsActive}</strong> active</li>
<li>Bookings (check-in today): <strong>${kpi.portfolioBookingsTotal}</strong> (${kpi.portfolioBookingsConfirmed} confirmed)</li>
<li>Room revenue: ${escapeHtml(roomRevLine)}</li>
<li>New conversations: <strong>${kpi.portfolioConversations}</strong></li>
<li>Active subscriptions: <strong>${kpi.subscriptionsActiveOrTrial}</strong></li>
</ul>
<h3 style="margin:18px 0 8px;font-size:14px">Failed payments (today)</h3>
<p style="font-size:14px">Subscription: <strong>${failedSub}</strong> · Guest: <strong>${failedGuest}</strong></p>
<h3 style="margin:18px 0 8px;font-size:14px">Alerts</h3>
<p style="font-size:14px">New since last digest: <strong>${newAlertCount}</strong> · Open: Critical <strong>${criticalOpen}</strong> · Warning <strong>${warningOpen}</strong> · Info <strong>${infoOpen}</strong></p>
${
  top.length
    ? `<table style="border-collapse:collapse;width:100%;max-width:640px;font-size:13px">${htmlTopRows}</table>`
    : "<p style=\"font-size:14px\">No open platform alerts.</p>"
}
<p style="margin-top:20px;font-size:14px">
<a href="${escapeHtml(baseUrl)}/owner/dashboard" style="color:#0b6e6e;font-weight:700">Dashboard</a>
 · <a href="${escapeHtml(baseUrl)}/owner/alerts" style="color:#0b6e6e;font-weight:700">Alerts</a>
</p>
</body></html>`;

  const text = textLines.join("\n");
  const recipient = (process.env.OWNER_EMAIL ?? "owner@chatastay.local").trim();

  if (!isOwnerDigestSmtpConfigured()) {
    await prisma.ownerDailyDigestLog.upsert({
      where: { digestKey },
      create: {
        digestKey,
        status: "SKIPPED_NO_SMTP",
        recipient,
        subject,
        errorMessage: "SMTP not configured; digest recorded only.",
        alertIdsJson: JSON.stringify(currentIds),
        newAlertCount,
        summaryJson: JSON.stringify(summary),
        sentAt: null
      },
      update: {
        status: "SKIPPED_NO_SMTP",
        recipient,
        subject,
        errorMessage: "SMTP not configured; digest recorded only.",
        alertIdsJson: JSON.stringify(currentIds),
        newAlertCount,
        summaryJson: JSON.stringify(summary),
        sentAt: null
      }
    });
    console.warn(
      "[owner-digest] SMTP not configured. Summary for",
      digestKey,
      "| alerts:",
      alerts.length,
      "| new:",
      newAlertCount
    );
    console.warn(text);
    return {
      ok: true,
      digestKey,
      status: "SKIPPED_NO_SMTP",
      message: "Recorded digest; email not sent (configure SMTP_HOST, SMTP_USER, SMTP_PASS)."
    };
  }

  try {
    await sendOwnerDigestEmail({ to: recipient, subject, text, html });
    await prisma.ownerDailyDigestLog.upsert({
      where: { digestKey },
      create: {
        digestKey,
        status: "SENT",
        recipient,
        subject,
        errorMessage: null,
        alertIdsJson: JSON.stringify(currentIds),
        newAlertCount,
        summaryJson: JSON.stringify(summary),
        sentAt: new Date()
      },
      update: {
        status: "SENT",
        recipient,
        subject,
        errorMessage: null,
        alertIdsJson: JSON.stringify(currentIds),
        newAlertCount,
        summaryJson: JSON.stringify(summary),
        sentAt: new Date()
      }
    });
    return { ok: true, digestKey, status: "SENT", message: `Sent to ${recipient}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.ownerDailyDigestLog.upsert({
      where: { digestKey },
      create: {
        digestKey,
        status: "FAILED",
        recipient,
        subject,
        errorMessage: msg,
        alertIdsJson: JSON.stringify(currentIds),
        newAlertCount,
        summaryJson: JSON.stringify(summary),
        sentAt: null
      },
      update: {
        status: "FAILED",
        recipient,
        subject,
        errorMessage: msg,
        alertIdsJson: JSON.stringify(currentIds),
        newAlertCount,
        summaryJson: JSON.stringify(summary),
        sentAt: null
      }
    });
    console.error("[owner-digest] send failed:", msg);
    return { ok: false, digestKey, status: "FAILED", message: msg };
  }
}
