import { BookingStatus, ChannelProvider, FbOrderStatus, FolioTransactionType, MessageDirection } from "@prisma/client";
import { prisma } from "../db";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type ManagementKpiResult = {
  rangeLabel: string;
  rangeStart: string;
  rangeEndInclusive: string;
  operationalDayNote: string;
  /** Room inventory (active units). */
  totalRoomUnits: number;
  inactiveRoomUnits: number;
  /** Nights × inventory-style capacity (see reports center). */
  totalRoomNightsCapacity: number;
  bookedRoomNightsInPeriod: number;
  occupancyRatePct: number;
  adr: number;
  revpar: number;
  roomRevenue: number;
  fbRevenue: number;
  folioExtraRevenue: number;
  /** F&amp;B charges posted to in-house guest folios (ledger), same date window. */
  folioFnbGuestChargesNet: number;
  /** Walk-in / direct F&amp;B ledger lines (no booking), e.g. cashier POS. */
  folioFnbDirectChargesNet: number;
  folioActivityChargesNet: number;
  folioOtherServiceChargesNet: number;
  /** Adjustments + discounts (net; may be negative). */
  folioAdjustmentsAndDiscountsNet: number;
  totalRevenueApprox: number;
  bookingsTotal: number;
  bookingsConfirmed: number;
  bookingsPending: number;
  bookingsCancelled: number;
  bookingsNoShow: number;
  bookingSources: { label: string; count: number }[];
  paymentFolioBuckets: { label: string; amount: number; count: number }[];
  /** Desk payments linked to a stay vs walk-in (no booking), same period. */
  folioPaymentsGuestBooking: { amount: number; count: number };
  folioPaymentsWalkIn: { amount: number; count: number };
  bookingPaymentStatusMix: { label: string; count: number }[];
  arrivalsOnSnapshot: number;
  departuresOnSnapshot: number;
  stayoversOnSnapshot: number;
  conversationsTotal: number;
  conversationsWithBooking: number;
  conversationsHumanHandoff: number;
  messagesInbound: number;
  messagesOutbound: number;
  campaignsInPeriod: number;
  campaignAudienceReached: number;
  campaignSentOk: number;
  campaignSentFailed: number;
};

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function classifyBookingSource(b: {
  source: ChannelProvider;
  conversationId: string | null;
}): string {
  if (b.conversationId) return "WhatsApp (linked)";
  switch (b.source) {
    case ChannelProvider.WHATSAPP:
      return "WhatsApp";
    case ChannelProvider.PHONE:
      return "Phone";
    case ChannelProvider.CORPORATE:
      return "Corporate";
    case ChannelProvider.REFERRAL:
      return "Referral";
    case ChannelProvider.BOOKING_COM:
    case ChannelProvider.AIRBNB:
    case ChannelProvider.EXPEDIA:
      return "OTA";
    case ChannelProvider.DIRECT:
      return "Walk-in / direct desk";
    default:
      return String(b.source);
  }
}

function bucketFolioPaymentMethod(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return "Unspecified";
  if (s.includes("CASH")) return "Cash";
  if (s.includes("CARD") || s.includes("STRIPE") || s.includes("VISA") || s.includes("MASTER")) return "Card / digital";
  if (s.includes("BANK") || s.includes("TRANSFER") || s.includes("WIRE")) return "Bank transfer";
  if (s.includes("MOBILE") || s.includes("OMAN") || s.includes("WALLET")) return "Mobile / wallet";
  return raw!.trim().slice(0, 32);
}

/**
 * Operational snapshot day: calendar "today" if it falls in the selected range, else first day of range (historical view).
 */
function resolveOperationalDay(rangeStart: Date, rangeEndExclusive: Date): Date {
  const today = startOfDay(new Date());
  if (today.getTime() >= rangeStart.getTime() && today.getTime() < rangeEndExclusive.getTime()) {
    return today;
  }
  return startOfDay(rangeStart);
}

export async function loadManagementKpis(params: {
  hotelId: string;
  currency: string;
  rangeStart: Date;
  rangeEndExclusive: Date;
  roomTypes: Array<{ id: string; totalInventory: number }>;
  /**
   * When true (single-day range in hotel local TZ), arrivals/departures/stayovers use `rangeStart`→`rangeEndExclusive`
   * instead of server-local “today” — required for per-hotel daily digests.
   */
  operationalSnapshotUsesRange?: boolean;
}): Promise<ManagementKpiResult> {
  const { hotelId, rangeStart, rangeEndExclusive } = params;
  const opDay = params.operationalSnapshotUsesRange ? rangeStart : resolveOperationalDay(rangeStart, rangeEndExclusive);
  const opNext = params.operationalSnapshotUsesRange ? rangeEndExclusive : addDays(opDay, 1);

  const daysInRange = Math.max(
    1,
    Math.round((rangeEndExclusive.getTime() - rangeStart.getTime()) / (24 * 3600 * 1000))
  );

  const totalRoomUnits = await prisma.roomUnit.count({
    where: { hotelId, isActive: true }
  });
  const inactiveRoomUnits = await prisma.roomUnit.count({
    where: { hotelId, isActive: false }
  });

  const inventoryRooms = params.roomTypes.reduce((s, rt) => s + rt.totalInventory, 0);
  const totalRoomNightsCapacity = inventoryRooms * daysInRange;

  const bookingsInRange = await prisma.booking.findMany({
    where: {
      hotelId,
      checkIn: { gte: rangeStart, lt: rangeEndExclusive }
    },
    select: {
      id: true,
      status: true,
      source: true,
      conversationId: true,
      totalAmount: true,
      nights: true,
      paymentStatus: true,
      checkIn: true,
      checkOut: true
    }
  });

  const bookingsTotal = bookingsInRange.length;
  let confirmed = 0;
  let pending = 0;
  let cancelled = 0;
  let noShow = 0;
  let roomRevenue = 0;
  let bookedRoomNights = 0;
  const sourceMap = new Map<string, number>();
  const payStatMap = new Map<string, number>();

  for (const b of bookingsInRange) {
    if (b.status === BookingStatus.CONFIRMED) {
      confirmed++;
      roomRevenue += b.totalAmount;
      bookedRoomNights += Math.max(1, b.nights);
    } else if (b.status === BookingStatus.PENDING) pending++;
    else if (b.status === BookingStatus.CANCELLED) cancelled++;
    else if (b.status === BookingStatus.NO_SHOW) noShow++;

    const src = classifyBookingSource(b);
    sourceMap.set(src, (sourceMap.get(src) ?? 0) + 1);
    payStatMap.set(b.paymentStatus, (payStatMap.get(b.paymentStatus) ?? 0) + 1);
  }

  const occupancyRatePct = totalRoomNightsCapacity > 0 ? (bookedRoomNights / totalRoomNightsCapacity) * 100 : 0;
  const adr = bookedRoomNights > 0 ? roomRevenue / bookedRoomNights : 0;
  const revpar = totalRoomNightsCapacity > 0 ? roomRevenue / totalRoomNightsCapacity : 0;

  const [
    fbAgg,
    folioChargeAgg,
    aggFnbGuest,
    aggFnbDirect,
    aggActivity,
    aggOtherSvc,
    aggAdjDisc
  ] = await Promise.all([
    prisma.fbOrder.aggregate({
      where: {
        hotelId,
        status: FbOrderStatus.POSTED,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _sum: { totalAmount: true }
    }),
    prisma.folioTransaction.aggregate({
      where: {
        hotelId,
        isVoided: false,
        transactionType: { notIn: [FolioTransactionType.PAYMENT, FolioTransactionType.REFUND] },
        chargeDate: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _sum: { netAmount: true }
    }),
    prisma.folioTransaction.aggregate({
      where: {
        hotelId,
        isVoided: false,
        transactionType: FolioTransactionType.FNB_CHARGE,
        bookingId: { not: null },
        chargeDate: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _sum: { netAmount: true }
    }),
    prisma.folioTransaction.aggregate({
      where: {
        hotelId,
        isVoided: false,
        transactionType: FolioTransactionType.FNB_CHARGE,
        bookingId: null,
        chargeDate: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _sum: { netAmount: true }
    }),
    prisma.folioTransaction.aggregate({
      where: {
        hotelId,
        isVoided: false,
        transactionType: FolioTransactionType.ACTIVITY_CHARGE,
        chargeDate: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _sum: { netAmount: true }
    }),
    prisma.folioTransaction.aggregate({
      where: {
        hotelId,
        isVoided: false,
        transactionType: FolioTransactionType.OTHER_SERVICE_CHARGE,
        chargeDate: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _sum: { netAmount: true }
    }),
    prisma.folioTransaction.aggregate({
      where: {
        hotelId,
        isVoided: false,
        transactionType: { in: [FolioTransactionType.ADJUSTMENT, FolioTransactionType.DISCOUNT] },
        chargeDate: { gte: rangeStart, lt: rangeEndExclusive }
      },
      _sum: { netAmount: true }
    })
  ]);

  const fbRevenue = fbAgg._sum.totalAmount ?? 0;
  const folioExtraRevenue = round2(folioChargeAgg._sum.netAmount ?? 0);
  const folioFnbGuestChargesNet = round2(aggFnbGuest._sum.netAmount ?? 0);
  const folioFnbDirectChargesNet = round2(aggFnbDirect._sum.netAmount ?? 0);
  const folioActivityChargesNet = round2(aggActivity._sum.netAmount ?? 0);
  const folioOtherServiceChargesNet = round2(aggOtherSvc._sum.netAmount ?? 0);
  const folioAdjustmentsAndDiscountsNet = round2(aggAdjDisc._sum.netAmount ?? 0);

  const totalRevenueApprox = round2(roomRevenue + fbRevenue + folioExtraRevenue);

  const folioPayments = await prisma.folioTransaction.findMany({
    where: {
      hotelId,
      isVoided: false,
      transactionType: FolioTransactionType.PAYMENT,
      chargeDate: { gte: rangeStart, lt: rangeEndExclusive }
    },
    select: { grossAmount: true, folioPaymentMethod: true, bookingId: true }
  });

  let folioPayGuestAmt = 0;
  let folioPayWalkAmt = 0;
  let folioPayGuestCnt = 0;
  let folioPayWalkCnt = 0;
  const payBuckets = new Map<string, { amount: number; count: number }>();
  for (const p of folioPayments) {
    if (p.bookingId) {
      folioPayGuestAmt += p.grossAmount;
      folioPayGuestCnt += 1;
    } else {
      folioPayWalkAmt += p.grossAmount;
      folioPayWalkCnt += 1;
    }
    const key = bucketFolioPaymentMethod(p.folioPaymentMethod);
    const cur = payBuckets.get(key) ?? { amount: 0, count: 0 };
    cur.amount += p.grossAmount;
    cur.count += 1;
    payBuckets.set(key, cur);
  }

  const paymentFolioBuckets = Array.from(payBuckets.entries())
    .map(([label, v]) => ({ label, amount: round2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount);

  const bookingPaymentStatusMix = Array.from(payStatMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const bookingSources = Array.from(sourceMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const [arrivalsOnSnapshot, departuresOnSnapshot, stayoversOnSnapshot] = await Promise.all([
    prisma.booking.count({
      where: {
        hotelId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
        checkIn: { gte: opDay, lt: opNext }
      }
    }),
    prisma.booking.count({
      where: {
        hotelId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
        checkOut: { gte: opDay, lt: opNext }
      }
    }),
    prisma.booking.count({
      where: {
        hotelId,
        status: BookingStatus.CONFIRMED,
        checkIn: { lt: opNext },
        checkOut: { gt: opDay },
        NOT: {
          OR: [
            { checkIn: { gte: opDay, lt: opNext } },
            { checkOut: { gte: opDay, lt: opNext } }
          ]
        }
      }
    })
  ]);

  const [conversationsTotal, conversationsWithBooking, conversationsHumanHandoff] = await Promise.all([
    prisma.conversation.count({
      where: { hotelId, createdAt: { gte: rangeStart, lt: rangeEndExclusive } }
    }),
    prisma.conversation.count({
      where: {
        hotelId,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive },
        bookings: { some: {} }
      }
    }),
    prisma.conversation.count({
      where: {
        hotelId,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive },
        agentHandoffAt: { not: null }
      }
    })
  ]);

  const [messagesInbound, messagesOutbound] = await Promise.all([
    prisma.message.count({
      where: {
        hotelId,
        direction: MessageDirection.INBOUND,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive }
      }
    }),
    prisma.message.count({
      where: {
        hotelId,
        direction: MessageDirection.OUTBOUND,
        createdAt: { gte: rangeStart, lt: rangeEndExclusive }
      }
    })
  ]);

  const campaignAgg = await prisma.marketingCampaign.aggregate({
    where: { hotelId, createdAt: { gte: rangeStart, lt: rangeEndExclusive } },
    _count: { id: true },
    _sum: {
      audienceCount: true,
      sentOkCount: true,
      sentFailedCount: true
    }
  });

  const opNote = params.operationalSnapshotUsesRange
    ? "Operational row uses the selected civil day window (hotel timezone when used for daily digest)."
    : opDay.getTime() === startOfDay(new Date()).getTime()
      ? "Operational row uses today (arrivals / departures / stayovers)."
      : `Operational row uses ${formatYmd(opDay)} (selected range is in the past or future).`;

  return {
    rangeLabel: `${formatYmd(rangeStart)} → ${formatYmd(addDays(rangeEndExclusive, -1))}`,
    rangeStart: formatYmd(rangeStart),
    rangeEndInclusive: formatYmd(addDays(rangeEndExclusive, -1)),
    operationalDayNote: opNote,
    totalRoomUnits,
    inactiveRoomUnits,
    totalRoomNightsCapacity,
    bookedRoomNightsInPeriod: bookedRoomNights,
    occupancyRatePct,
    adr,
    revpar,
    roomRevenue,
    fbRevenue,
    folioExtraRevenue,
    folioFnbGuestChargesNet,
    folioFnbDirectChargesNet,
    folioActivityChargesNet,
    folioOtherServiceChargesNet,
    folioAdjustmentsAndDiscountsNet,
    totalRevenueApprox,
    bookingsTotal,
    bookingsConfirmed: confirmed,
    bookingsPending: pending,
    bookingsCancelled: cancelled,
    bookingsNoShow: noShow,
    bookingSources,
    paymentFolioBuckets,
    folioPaymentsGuestBooking: {
      amount: round2(folioPayGuestAmt),
      count: folioPayGuestCnt
    },
    folioPaymentsWalkIn: {
      amount: round2(folioPayWalkAmt),
      count: folioPayWalkCnt
    },
    bookingPaymentStatusMix,
    arrivalsOnSnapshot,
    departuresOnSnapshot,
    stayoversOnSnapshot,
    conversationsTotal,
    conversationsWithBooking,
    conversationsHumanHandoff,
    messagesInbound,
    messagesOutbound,
    campaignsInPeriod: campaignAgg._count.id,
    campaignAudienceReached: campaignAgg._sum.audienceCount ?? 0,
    campaignSentOk: campaignAgg._sum.sentOkCount ?? 0,
    campaignSentFailed: campaignAgg._sum.sentFailedCount ?? 0
  };
}

export function parseKpiPreset(
  preset: string | undefined,
  customStart: Date | undefined,
  customEnd: Date | undefined
): { rangeStart: Date; rangeEndExclusive: Date; presetLabel: string } {
  const now = new Date();
  const today = startOfDay(now);

  if (preset === "custom" && customStart && customEnd) {
    const rs = startOfDay(customStart);
    const re = startOfDay(customEnd);
    return { rangeStart: rs, rangeEndExclusive: addDays(re, 1), presetLabel: "Custom" };
  }

  if (preset === "week") {
    const day = today.getDay();
    const mondayOffset = (day + 6) % 7;
    const weekStart = addDays(today, -mondayOffset);
    return { rangeStart: weekStart, rangeEndExclusive: addDays(weekStart, 7), presetLabel: "This week" };
  }

  if (preset === "month") {
    const ms = new Date(today.getFullYear(), today.getMonth(), 1);
    const me = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return { rangeStart: ms, rangeEndExclusive: me, presetLabel: "This month" };
  }

  // today (default)
  return { rangeStart: today, rangeEndExclusive: addDays(today, 1), presetLabel: "Today" };
}
