import {
  BookingStatus,
  FbOrderStatus,
  InvoiceStatus,
  SubscriptionStatus
} from "@prisma/client";
import { prisma } from "../db";

export type OwnerHotelKpiRow = {
  hotelId: string;
  accountNumber: number | null;
  displayName: string;
  slug: string;
  isActive: boolean;
  currency: string;
  subscriptionStatus: string | null;
  planName: string | null;
  currentPeriodEnd: Date | null;
  bookingsTotal: number;
  bookingsConfirmed: number;
  bookingsCancelled: number;
  bookingsNoShow: number;
  bookingsPending: number;
  roomRevenue: number;
  fbRevenue: number;
  conversations: number;
  campaigns: number;
  campaignSentOk: number;
  openInvoiceTotal: number;
  openInvoiceCount: number;
};

export type OwnerPortfolioKpiResult = {
  presetLabel: string;
  rangeStart: string;
  rangeEndInclusive: string;
  hotelsTotal: number;
  hotelsActive: number;
  hotelsInactive: number;
  subscriptionsByStatus: { status: string; count: number }[];
  subscriptionsActiveOrTrial: number;
  subscriptionsCancelled: number;
  subscriptionsExpiring14d: number;
  portfolioBookingsTotal: number;
  portfolioBookingsConfirmed: number;
  portfolioRoomRevenueByCurrency: { currency: string; amount: number }[];
  portfolioFbRevenueByCurrency: { currency: string; amount: number }[];
  portfolioConversations: number;
  portfolioCampaigns: number;
  portfolioCampaignSentOk: number;
  portfolioCampaignAudience: number;
  openInvoicesAttention: number;
  pastDueSubscriptions: number;
  inactiveHotels: number;
  bookingSourceSummary: { label: string; count: number }[];
  hotelRows: OwnerHotelKpiRow[];
  attentionNotes: string[];
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export async function loadOwnerPortfolioKpis(params: {
  rangeStart: Date;
  rangeEndExclusive: Date;
  presetLabel: string;
}): Promise<OwnerPortfolioKpiResult> {
  const { rangeStart, rangeEndExclusive, presetLabel } = params;
  const now = new Date();
  const expiringBefore = addDays(now, 14);

  const hotels = await prisma.hotel.findMany({
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      accountNumber: true,
      displayName: true,
      slug: true,
      isActive: true,
      currency: true,
      subscriptions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          currentPeriodEnd: true,
          plan: { select: { name: true } }
        }
      }
    }
  });

  const hotelsTotal = hotels.length;
  const hotelsActive = hotels.filter((h) => h.isActive).length;
  const hotelsInactive = hotelsTotal - hotelsActive;
  const inactiveHotels = hotelsInactive;

  const subStatusAgg = await prisma.subscription.groupBy({
    by: ["status"],
    _count: { id: true }
  });
  const subscriptionsByStatus = subStatusAgg
    .map((r) => ({ status: r.status, count: r._count.id }))
    .sort((a, b) => b.count - a.count);

  const subscriptionsActiveOrTrial = await prisma.subscription.count({
    where: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } }
  });
  const subscriptionsCancelled = await prisma.subscription.count({
    where: { status: SubscriptionStatus.CANCELED }
  });

  const subscriptionsExpiring14d = await prisma.subscription.count({
    where: {
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
      currentPeriodEnd: { lte: expiringBefore, gte: now }
    }
  });

  const pastDueSubscriptions = await prisma.subscription.count({
    where: { status: SubscriptionStatus.PAST_DUE }
  });

  const bookingWhere = {
    checkIn: { gte: rangeStart, lt: rangeEndExclusive }
  };

  const [statusGroups, revenueByHotel, fbByHotel, convByHotel, campByHotel, bookingsForSource] =
    await Promise.all([
      prisma.booking.groupBy({
        by: ["hotelId", "status"],
        where: bookingWhere,
        _count: { id: true }
      }),
      prisma.booking.groupBy({
        by: ["hotelId"],
        where: {
          ...bookingWhere,
          status: BookingStatus.CONFIRMED
        },
        _sum: { totalAmount: true }
      }),
      prisma.fbOrder.groupBy({
        by: ["hotelId"],
        where: {
          status: FbOrderStatus.POSTED,
          createdAt: { gte: rangeStart, lt: rangeEndExclusive }
        },
        _sum: { totalAmount: true }
      }),
      prisma.conversation.groupBy({
        by: ["hotelId"],
        where: { createdAt: { gte: rangeStart, lt: rangeEndExclusive } },
        _count: { id: true }
      }),
      prisma.marketingCampaign.groupBy({
        by: ["hotelId"],
        where: { createdAt: { gte: rangeStart, lt: rangeEndExclusive } },
        _count: { id: true },
        _sum: { audienceCount: true, sentOkCount: true }
      }),
      prisma.booking.findMany({
        where: bookingWhere,
        select: {
          hotelId: true,
          source: true,
          conversationId: true
        }
      })
    ]);

  const revMap = new Map(revenueByHotel.map((r) => [r.hotelId, r._sum.totalAmount ?? 0]));
  const fbMap = new Map(fbByHotel.map((r) => [r.hotelId, r._sum.totalAmount ?? 0]));
  const convMap = new Map(convByHotel.map((r) => [r.hotelId, r._count.id]));
  const campMap = new Map(
    campByHotel.map((r) => [
      r.hotelId,
      {
        n: r._count.id,
        sent: r._sum.sentOkCount ?? 0,
        aud: r._sum.audienceCount ?? 0
      }
    ])
  );

  const countsByHotel = new Map<
    string,
    { confirmed: number; cancelled: number; noShow: number; pending: number; total: number }
  >();
  for (const h of hotels) {
    countsByHotel.set(h.id, { confirmed: 0, cancelled: 0, noShow: 0, pending: 0, total: 0 });
  }
  for (const row of statusGroups) {
    const cur = countsByHotel.get(row.hotelId) ?? {
      confirmed: 0,
      cancelled: 0,
      noShow: 0,
      pending: 0,
      total: 0
    };
    const c = row._count.id;
    cur.total += c;
    if (row.status === BookingStatus.CONFIRMED) cur.confirmed += c;
    else if (row.status === BookingStatus.CANCELLED) cur.cancelled += c;
    else if (row.status === BookingStatus.NO_SHOW) cur.noShow += c;
    else if (row.status === BookingStatus.PENDING) cur.pending += c;
    countsByHotel.set(row.hotelId, cur);
  }

  const openInv = await prisma.invoice.groupBy({
    by: ["hotelId"],
    where: { status: { in: [InvoiceStatus.OPEN] } },
    _sum: { amountTotal: true },
    _count: { id: true }
  });
  const openMap = new Map(
    openInv.map((r) => [r.hotelId, { sum: r._sum.amountTotal ?? 0, n: r._count.id }])
  );

  const roomRevByCur = new Map<string, number>();
  const fbRevByCur = new Map<string, number>();
  for (const h of hotels) {
    const rr = revMap.get(h.id) ?? 0;
    const fr = fbMap.get(h.id) ?? 0;
    if (rr) roomRevByCur.set(h.currency, (roomRevByCur.get(h.currency) ?? 0) + rr);
    if (fr) fbRevByCur.set(h.currency, (fbRevByCur.get(h.currency) ?? 0) + fr);
  }

  const portfolioRoomRevenueByCurrency = Array.from(roomRevByCur.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  const portfolioFbRevenueByCurrency = Array.from(fbRevByCur.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  let portfolioBookingsTotal = 0;
  let portfolioBookingsConfirmed = 0;
  let portfolioConversations = 0;
  let portfolioCampaigns = 0;
  let portfolioCampaignSentOk = 0;
  let portfolioCampaignAudience = 0;
  for (const h of hotels) {
    const ct = countsByHotel.get(h.id);
    if (ct) {
      portfolioBookingsTotal += ct.total;
      portfolioBookingsConfirmed += ct.confirmed;
    }
    portfolioConversations += convMap.get(h.id) ?? 0;
    const cm = campMap.get(h.id);
    if (cm) {
      portfolioCampaigns += cm.n;
      portfolioCampaignSentOk += cm.sent;
      portfolioCampaignAudience += cm.aud;
    }
  }

  const openInvoicesAttention = await prisma.invoice.count({
    where: {
      status: { in: [InvoiceStatus.OPEN] },
      OR: [{ dueAt: { lt: now } }, { dueAt: null }]
    }
  });

  // Booking source labels (cross-portfolio)
  const srcMap = new Map<string, number>();
  for (const b of bookingsForSource) {
    let label: string;
    if (b.conversationId) label = "WhatsApp (linked)";
    else {
      switch (b.source) {
        case "WHATSAPP":
          label = "WhatsApp";
          break;
        case "PHONE":
          label = "Phone";
          break;
        case "CORPORATE":
          label = "Corporate";
          break;
        case "REFERRAL":
          label = "Referral";
          break;
        case "BOOKING_COM":
        case "AIRBNB":
        case "EXPEDIA":
          label = "OTA";
          break;
        case "DIRECT":
          label = "Walk-in / direct";
          break;
        default:
          label = String(b.source);
      }
    }
    srcMap.set(label, (srcMap.get(label) ?? 0) + 1);
  }
  const bookingSourceSummary = Array.from(srcMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const hotelRows: OwnerHotelKpiRow[] = hotels.map((h) => {
    const ct = countsByHotel.get(h.id)!;
    const sub = h.subscriptions[0];
    const oi = openMap.get(h.id);
    const cm = campMap.get(h.id);
    return {
      hotelId: h.id,
      accountNumber: h.accountNumber,
      displayName: h.displayName,
      slug: h.slug,
      isActive: h.isActive,
      currency: h.currency,
      subscriptionStatus: sub?.status ?? null,
      planName: sub?.plan?.name ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      bookingsTotal: ct.total,
      bookingsConfirmed: ct.confirmed,
      bookingsCancelled: ct.cancelled,
      bookingsNoShow: ct.noShow,
      bookingsPending: ct.pending,
      roomRevenue: revMap.get(h.id) ?? 0,
      fbRevenue: fbMap.get(h.id) ?? 0,
      conversations: convMap.get(h.id) ?? 0,
      campaigns: cm?.n ?? 0,
      campaignSentOk: cm?.sent ?? 0,
      openInvoiceTotal: oi?.sum ?? 0,
      openInvoiceCount: oi?.n ?? 0
    };
  });

  const attentionNotes: string[] = [];
  if (inactiveHotels > 0) attentionNotes.push(`${inactiveHotels} hotel(s) are marked inactive (suspended).`);
  if (pastDueSubscriptions > 0) attentionNotes.push(`${pastDueSubscriptions} subscription(s) are past due.`);
  if (subscriptionsExpiring14d > 0) {
    attentionNotes.push(`${subscriptionsExpiring14d} subscription(s) renew or end within 14 days.`);
  }
  if (openInvoicesAttention > 0) {
    attentionNotes.push(`${openInvoicesAttention} open invoice(s) may need follow-up (includes undated due dates).`);
  }

  return {
    presetLabel,
    rangeStart: ymd(rangeStart),
    rangeEndInclusive: ymd(addDays(rangeEndExclusive, -1)),
    hotelsTotal,
    hotelsActive,
    hotelsInactive,
    subscriptionsByStatus,
    subscriptionsActiveOrTrial,
    subscriptionsCancelled,
    subscriptionsExpiring14d,
    portfolioBookingsTotal,
    portfolioBookingsConfirmed,
    portfolioRoomRevenueByCurrency,
    portfolioFbRevenueByCurrency,
    portfolioConversations,
    portfolioCampaigns,
    portfolioCampaignSentOk,
    portfolioCampaignAudience,
    openInvoicesAttention,
    pastDueSubscriptions,
    inactiveHotels,
    bookingSourceSummary,
    hotelRows,
    attentionNotes
  };
}
