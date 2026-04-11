import {
  BookingStatus,
  ConversationState,
  InvoiceStatus,
  PaymentKind,
  PaymentStatus,
  SubscriptionStatus,
  SyncStatus
} from "@prisma/client";
import { prisma } from "../db";

/** Owner alerts center — lightweight exception list (not full observability). */
export type PlatformAlertSeverity = "critical" | "warning" | "info";

export type PlatformAlertCategory =
  | "billing"
  | "activity"
  | "messaging"
  | "inventory"
  | "financial"
  | "system";

export type PlatformAlert = {
  id: string;
  severity: PlatformAlertSeverity;
  category: PlatformAlertCategory;
  typeKey: string;
  hotelId: string;
  hotelName: string;
  slug: string;
  title: string;
  detail: string;
  value?: string;
  href: string;
};

export type PlatformAlertsResult = {
  alerts: PlatformAlert[];
  counts: { critical: number; warning: number; info: number; total: number };
};

const NO_MSG_DAYS = 14;
const NO_BOOKING_DAYS = 30;
const MIN_HOTEL_AGE_DAYS = 21;
const OPEN_CONV_BACKLOG_WARN = 35;
const LAST_INBOUND_QUEUE_WARN = 18;
const HANDOFF_STALE_HOURS = 20;
const FAILED_PAYMENT_LOOKBACK_DAYS = 45;
const STALE_OPEN_CONV_HOURS = 36;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function subDays(d: Date, n: number): Date {
  return addDays(d, -n);
}

function hoursAgo(d: Date, h: number): Date {
  return new Date(d.getTime() - h * 60 * 60 * 1000);
}

function severityRank(s: PlatformAlertSeverity): number {
  return s === "critical" ? 0 : s === "warning" ? 1 : 2;
}

function hotelHref(hotelId: string, path = ""): string {
  return `/owner/hotels/${encodeURIComponent(hotelId)}${path}`;
}

/**
 * Loads cross-hotel platform alerts. Thresholds are conservative to limit noise.
 */
export async function loadPlatformAlerts(): Promise<PlatformAlertsResult> {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = addDays(todayStart, 1);
  const msgCutoff = subDays(now, NO_MSG_DAYS);
  const bookingCutoff = subDays(now, NO_BOOKING_DAYS);
  const minHotelCreated = subDays(now, MIN_HOTEL_AGE_DAYS);
  const handoffStaleBefore = hoursAgo(now, HANDOFF_STALE_HOURS);
  const staleOpenConvBefore = hoursAgo(now, STALE_OPEN_CONV_HOURS);
  const failedSince = subDays(now, FAILED_PAYMENT_LOOKBACK_DAYS);

  const alerts: PlatformAlert[] = [];

  const hotels = await prisma.hotel.findMany({
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      displayName: true,
      slug: true,
      isActive: true,
      createdAt: true
    }
  });
  const hotelMap = new Map(hotels.map((h) => [h.id, h]));

  const [msgMax, bookingMax, subs, openOverdueInvoices] = await Promise.all([
    prisma.message.groupBy({
      by: ["hotelId"],
      _max: { createdAt: true }
    }),
    prisma.booking.groupBy({
      by: ["hotelId"],
      _max: { createdAt: true }
    }),
    prisma.subscription.findMany({
      include: {
        hotel: { select: { id: true, displayName: true, slug: true, isActive: true } },
        plan: { select: { name: true } }
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.invoice.findMany({
      where: {
        status: InvoiceStatus.OPEN,
        dueAt: { lt: now }
      },
      select: {
        id: true,
        hotelId: true,
        amountTotal: true,
        currency: true,
        dueAt: true,
        hotel: { select: { displayName: true, slug: true } }
      }
    })
  ]);

  const lastMsg = new Map(msgMax.map((r) => [r.hotelId, r._max.createdAt]));
  const lastBook = new Map(bookingMax.map((r) => [r.hotelId, r._max.createdAt]));

  const latestSubByHotel = new Map<string, (typeof subs)[0]>();
  for (const s of subs) {
    if (!latestSubByHotel.has(s.hotelId)) latestSubByHotel.set(s.hotelId, s);
  }

  for (const s of latestSubByHotel.values()) {
    const h = s.hotel;
    if (s.status === SubscriptionStatus.PAST_DUE) {
      alerts.push({
        id: `${h.id}:sub_past_due:${s.id}`,
        severity: "critical",
        category: "billing",
        typeKey: "subscription_past_due",
        hotelId: h.id,
        hotelName: h.displayName,
        slug: h.slug,
        title: "Subscription past due",
        detail: `Plan “${s.plan.name}” is past due; billing needs attention.`,
        value: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString().slice(0, 10) : undefined,
        href: hotelHref(h.id)
      });
    }
    if (s.status === SubscriptionStatus.TRIALING && s.currentPeriodEnd) {
      const end = s.currentPeriodEnd;
      if (end > now && end <= addDays(now, 7)) {
        alerts.push({
          id: `${h.id}:trial_end:${s.id}`,
          severity: "warning",
          category: "billing",
          typeKey: "trial_ending",
          hotelId: h.id,
          hotelName: h.displayName,
          slug: h.slug,
          title: "Trial ending soon",
          detail: `Trial period ends ${end.toISOString().slice(0, 10)}.`,
          href: hotelHref(h.id)
        });
      }
    }
  }

  for (const h of hotels) {
    if (!h.isActive) continue;
    const sub = latestSubByHotel.get(h.id);
    if (sub?.status === SubscriptionStatus.CANCELED) {
      alerts.push({
        id: `${h.id}:sub_cancelled_active_hotel`,
        severity: "info",
        category: "billing",
        typeKey: "subscription_cancelled_hotel_active",
        hotelId: h.id,
        hotelName: h.displayName,
        slug: h.slug,
        title: "Cancelled subscription on active property",
        detail: "Hotel is marked active but the latest subscription record is cancelled — confirm billing state.",
        href: hotelHref(h.id)
      });
    }
  }

  const invByHotel = new Map<string, typeof openOverdueInvoices>();
  for (const inv of openOverdueInvoices) {
    const list = invByHotel.get(inv.hotelId) ?? [];
    list.push(inv);
    invByHotel.set(inv.hotelId, list);
  }
  for (const [hid, list] of invByHotel) {
    const h = hotelMap.get(hid);
    if (!h) continue;
    const sum = list.reduce((s, i) => s + i.amountTotal, 0);
    const cur = list[0]?.currency ?? "OMR";
    alerts.push({
      id: `${hid}:overdue_invoices`,
      severity: "warning",
      category: "billing",
      typeKey: "invoice_overdue",
      hotelId: hid,
      hotelName: h.displayName,
      slug: h.slug,
      title: "Overdue open invoice(s)",
      detail: `${list.length} invoice(s) past due date; follow up collections.`,
      value: `${sum.toFixed(2)} ${cur}`,
      href: hotelHref(hid)
    });
  }

  for (const h of hotels) {
    if (!h.isActive || h.createdAt > minHotelCreated) continue;
    const lm = lastMsg.get(h.id);
    const lb = lastBook.get(h.id);
    const quietMsg = !lm || lm < msgCutoff;
    const quietBook = !lb || lb < bookingCutoff;
    if (quietMsg && quietBook) {
      alerts.push({
        id: `${h.id}:low_activity`,
        severity: "warning",
        category: "activity",
        typeKey: "low_engagement",
        hotelId: h.id,
        hotelName: h.displayName,
        slug: h.slug,
        title: "Very low recent activity",
        detail: `No guest messages in ${NO_MSG_DAYS}+ days and no new bookings in ${NO_BOOKING_DAYS}+ days (property is active).`,
        href: hotelHref(h.id)
      });
    } else if (quietMsg && !quietBook) {
      alerts.push({
        id: `${h.id}:quiet_messaging`,
        severity: "info",
        category: "activity",
        typeKey: "no_recent_conversations",
        hotelId: h.id,
        hotelName: h.displayName,
        slug: h.slug,
        title: "No recent guest messaging",
        detail: `No messages recorded in ${NO_MSG_DAYS}+ days; bookings may still occur from other channels.`,
        href: hotelHref(h.id)
      });
    }
  }

  const [openBacklog, staleHandoffs, staleOpenThreads] = await Promise.all([
    prisma.conversation.groupBy({
      by: ["hotelId"],
      where: { state: { not: ConversationState.CLOSED } },
      _count: { id: true }
    }),
    prisma.conversation.groupBy({
      by: ["hotelId"],
      where: {
        agentHandoffAt: { not: null },
        state: { not: ConversationState.CLOSED },
        updatedAt: { lt: handoffStaleBefore }
      },
      _count: { id: true }
    }),
    prisma.conversation.groupBy({
      by: ["hotelId"],
      where: {
        state: { in: [ConversationState.NEW, ConversationState.QUALIFYING, ConversationState.QUOTED] },
        updatedAt: { lt: staleOpenConvBefore }
      },
      _count: { id: true }
    })
  ]);

  for (const row of openBacklog) {
    if (row._count.id >= OPEN_CONV_BACKLOG_WARN) {
      const h = hotelMap.get(row.hotelId);
      if (!h) continue;
      alerts.push({
        id: `${row.hotelId}:open_conv_backlog`,
        severity: "warning",
        category: "messaging",
        typeKey: "open_conversation_backlog",
        hotelId: row.hotelId,
        hotelName: h.displayName,
        slug: h.slug,
        title: "Large open conversation backlog",
        detail: `${row._count.id} conversations are not closed — review inbox workload.`,
        value: String(row._count.id),
        href: hotelHref(row.hotelId)
      });
    }
  }

  for (const row of staleHandoffs) {
    if (row._count.id < 1) continue;
    const h = hotelMap.get(row.hotelId);
    if (!h) continue;
    alerts.push({
      id: `${row.hotelId}:stale_handoff`,
      severity: "critical",
      category: "messaging",
      typeKey: "handoff_stale",
      hotelId: row.hotelId,
      hotelName: h.displayName,
      slug: h.slug,
      title: "Human handoff queue stale",
      detail: `${row._count.id} handoff thread(s) not updated in ${HANDOFF_STALE_HOURS}+ hours — guest may be waiting.`,
      value: String(row._count.id),
      href: hotelHref(row.hotelId)
    });
  }

  for (const row of staleOpenThreads) {
    if (row._count.id < 1) continue;
    const h = hotelMap.get(row.hotelId);
    if (!h) continue;
    alerts.push({
      id: `${row.hotelId}:stale_sales_thread`,
      severity: "warning",
      category: "messaging",
      typeKey: "stale_open_thread",
      hotelId: row.hotelId,
      hotelName: h.displayName,
      slug: h.slug,
      title: "Sales threads idle too long",
      detail: `${row._count.id} open thread(s) (new/qualifying/quoted) with no activity in ${STALE_OPEN_CONV_HOURS}+ hours.`,
      value: String(row._count.id),
      href: hotelHref(row.hotelId)
    });
  }

  try {
    const inboundLast = await prisma.$queryRaw<Array<{ hotelId: string; cnt: bigint }>>`
      WITH lm AS (
        SELECT "conversationId", direction,
          ROW_NUMBER() OVER (PARTITION BY "conversationId" ORDER BY "createdAt" DESC) AS rn
        FROM Message
      )
      SELECT c."hotelId" AS hotelId, COUNT(*) AS cnt
      FROM Conversation c
      INNER JOIN lm ON lm."conversationId" = c.id AND lm.rn = 1
      WHERE lm.direction = 'INBOUND' AND c.state != 'CLOSED'
      GROUP BY c."hotelId"
    `;
    for (const row of inboundLast) {
      const n = Number(row.cnt);
      if (n < LAST_INBOUND_QUEUE_WARN) continue;
      const h = hotelMap.get(row.hotelId);
      if (!h) continue;
      alerts.push({
        id: `${row.hotelId}:inbound_queue`,
        severity: "warning",
        category: "messaging",
        typeKey: "last_message_inbound_queue",
        hotelId: row.hotelId,
        hotelName: h.displayName,
        slug: h.slug,
        title: "Many threads awaiting staff reply",
        detail:
          `${n} open conversation(s) whose last message is inbound — possible inbox backlog (approximation).`,
        value: String(n),
        href: hotelHref(row.hotelId)
      });
    }
  } catch {
    /* older SQLite without window functions — skip this alert */
  }

  const roomTypes = await prisma.roomType.findMany({
    where: { isActive: true },
    select: {
      id: true,
      hotelId: true,
      name: true,
      totalInventory: true,
      hotel: { select: { displayName: true, slug: true } },
      roomUnits: { where: { isActive: true }, select: { id: true } }
    }
  });
  for (const rt of roomTypes) {
    const activeUnits = rt.roomUnits.length;
    if (activeUnits < rt.totalInventory) {
      alerts.push({
        id: `${rt.hotelId}:room_units_short:${rt.id}`,
        severity: "warning",
        category: "inventory",
        typeKey: "room_units_below_inventory",
        hotelId: rt.hotelId,
        hotelName: rt.hotel.displayName,
        slug: rt.hotel.slug,
        title: "Room units below configured inventory",
        detail: `Type “${rt.name}”: ${activeUnits} active unit(s) vs ${rt.totalInventory} configured slots — board may be short.`,
        value: `${activeUnits}/${rt.totalInventory}`,
        href: hotelHref(rt.hotelId, "/room-capacity")
      });
    }
  }

  const unassignedToday = await prisma.booking.groupBy({
    by: ["hotelId"],
    where: {
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
      roomUnitId: null,
      checkIn: { lt: todayEnd },
      checkOut: { gt: todayStart }
    },
    _count: { id: true }
  });
  for (const row of unassignedToday) {
    if (row._count.id < 1) continue;
    const h = hotelMap.get(row.hotelId);
    if (!h) continue;
    alerts.push({
      id: `${row.hotelId}:booking_no_unit_today`,
      severity: "warning",
      category: "inventory",
      typeKey: "inhouse_booking_no_unit",
      hotelId: row.hotelId,
      hotelName: h.displayName,
      slug: h.slug,
      title: "In-house bookings without room unit",
      detail: `${row._count.id} booking(s) today overlapping tonight with no physical unit — assign on room board.`,
      value: String(row._count.id),
      href: hotelHref(row.hotelId, "/extranet")
    });
  }

  const failedIntentAgg = await prisma.paymentIntent.groupBy({
    by: ["hotelId", "kind"],
    where: {
      status: PaymentStatus.FAILED,
      createdAt: { gte: failedSince }
    },
    _count: { id: true }
  });
  for (const row of failedIntentAgg) {
    const h = hotelMap.get(row.hotelId);
    if (!h) continue;
    const kindLabel = row.kind === PaymentKind.SUBSCRIPTION ? "Subscription" : "Guest booking";
    const sev = row.kind === PaymentKind.SUBSCRIPTION ? "critical" : "warning";
    alerts.push({
      id: `${row.hotelId}:failed_pi:${row.kind}`,
      severity: sev,
      category: "financial",
      typeKey: row.kind === PaymentKind.SUBSCRIPTION ? "failed_subscription_payment" : "failed_guest_payment",
      hotelId: row.hotelId,
      hotelName: h.displayName,
      slug: h.slug,
      title: `${kindLabel} payment failed`,
      detail: `${row._count.id} failed payment intent(s) in the last ${FAILED_PAYMENT_LOOKBACK_DAYS} days.`,
      value: String(row._count.id),
      href: hotelHref(row.hotelId)
    });
  }

  const pendingRisk = await prisma.paymentIntent.groupBy({
    by: ["hotelId"],
    where: {
      status: { in: [PaymentStatus.PENDING, PaymentStatus.REQUIRES_ACTION] },
      createdAt: { lt: subDays(now, 7) }
    },
    _count: { id: true }
  });
  for (const row of pendingRisk) {
    if (row._count.id < 1) continue;
    const h = hotelMap.get(row.hotelId);
    if (!h) continue;
    alerts.push({
      id: `${row.hotelId}:stale_pending_payments`,
      severity: "info",
      category: "financial",
      typeKey: "stale_pending_payment_intents",
      hotelId: row.hotelId,
      hotelName: h.displayName,
      slug: h.slug,
      title: "Stale pending payment intents",
      detail: `${row._count.id} intent(s) still pending or requiring action after 7+ days.`,
      value: String(row._count.id),
      href: hotelHref(row.hotelId)
    });
  }

  const failedSyncAgg = await prisma.syncJob.groupBy({
    by: ["integrationConnectionId"],
    where: { status: SyncStatus.FAILED, createdAt: { gte: subDays(now, 7) } },
    _count: { id: true }
  });
  const intIds = failedSyncAgg.map((r) => r.integrationConnectionId);
  if (intIds.length) {
    const connections = await prisma.integrationConnection.findMany({
      where: { id: { in: intIds } },
      select: {
        id: true,
        hotelId: true,
        provider: true,
        hotel: { select: { displayName: true, slug: true } }
      }
    });
    const connMap = new Map(connections.map((c) => [c.id, c]));
    for (const row of failedSyncAgg) {
      const c = connMap.get(row.integrationConnectionId);
      if (!c) continue;
      alerts.push({
        id: `${c.hotelId}:sync_fail:${c.id}`,
        severity: "warning",
        category: "system",
        typeKey: "channel_sync_failed",
        hotelId: c.hotelId,
        hotelName: c.hotel.displayName,
        slug: c.hotel.slug,
        title: "Channel sync failures",
        detail: `${row._count.id} failed sync job(s) in the last 7 days (${c.provider}).`,
        value: String(row._count.id),
        href: hotelHref(c.hotelId)
      });
    }
  }

  alerts.sort((a, b) => {
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    return a.hotelName.localeCompare(b.hotelName);
  });

  const counts = {
    critical: alerts.filter((a) => a.severity === "critical").length,
    warning: alerts.filter((a) => a.severity === "warning").length,
    info: alerts.filter((a) => a.severity === "info").length,
    total: alerts.length
  };

  return { alerts, counts };
}

export function filterPlatformAlerts(
  result: PlatformAlertsResult,
  filters: { severity?: PlatformAlertSeverity | "all"; category?: PlatformAlertCategory | "all"; q?: string }
): PlatformAlert[] {
  let list = result.alerts;
  if (filters.severity && filters.severity !== "all") {
    list = list.filter((a) => a.severity === filters.severity);
  }
  if (filters.category && filters.category !== "all") {
    list = list.filter((a) => a.category === filters.category);
  }
  const q = filters.q?.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (a) =>
        a.hotelName.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.detail.toLowerCase().includes(q) ||
        a.typeKey.includes(q)
    );
  }
  return list;
}
