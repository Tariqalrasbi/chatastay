/**
 * Smart handover sheet data layer.
 *
 * Aggregates everything an outgoing receptionist must hand to the next shift in
 * one snapshot:
 *   - Arrivals expected today that have NOT yet been checked in
 *   - Departures with an outstanding folio balance
 *   - VIP guests currently in-house
 *   - Open guest complaints (low ratings without a manager follow-up close)
 *   - Dirty / maintenance rooms (manual room-board status)
 *   - Pending housekeeping tasks
 *   - Failed WhatsApp / notification messages in the last 24 hours
 *   - Open restaurant / room-service tickets
 *
 * This module is intentionally Prisma-aware but UI-agnostic. The HTML render
 * lives in `src/routes/admin.ts` so we keep this module easy to test.
 */

import {
  PrismaClient,
  BookingStatus,
  HousekeepingTaskStatus,
  NotificationStatus,
  OutletTicketStatus,
  GuestFeedbackStatus,
  PaymentStatus,
  FolioTransactionType
} from "@prisma/client";

import { parseManualRoomStatusFromNotes } from "./roomBoardNotes";

export interface PendingArrivalRow {
  bookingId: string;
  guestName: string;
  guestPhone: string;
  roomTypeName: string;
  unitName: string | null;
  checkInExpected: Date;
  adults: number;
  children: number;
  isVip: boolean;
}

export interface UnpaidDepartureRow {
  bookingId: string;
  guestName: string;
  guestPhone: string;
  unitName: string | null;
  checkOutExpected: Date;
  outstandingAmount: number;
  currency: string;
  isVip: boolean;
}

export interface CheckedOutTodayRow {
  bookingId: string;
  guestName: string;
  guestPhone: string;
  unitName: string | null;
  checkedOutAt: Date;
  staffLabel: string | null;
  paymentStatus: PaymentStatus;
  balanceStatus: "settled" | "outstanding" | "refund_due";
  balanceAmount: number;
  currency: string;
}

export interface RefundDueRow {
  bookingId: string;
  guestName: string;
  guestPhone: string;
  unitName: string | null;
  amount: number;
  currency: string;
  checkOut: Date;
}

export interface VipInHouseRow {
  bookingId: string;
  guestName: string;
  guestPhone: string;
  unitName: string | null;
  checkOut: Date;
  notes: string | null;
}

export interface OpenComplaintRow {
  feedbackId: string;
  bookingId: string;
  guestName: string;
  rating: number;
  category: string | null;
  comment: string | null;
  createdAt: Date;
  followUpRequested: boolean;
}

export interface RoomNeedingAttentionRow {
  unitId: string;
  unitName: string;
  roomTypeName: string | null;
  status: "DIRTY" | "MAINTENANCE";
  notes: string | null;
}

export interface PendingHousekeepingRow {
  taskId: string;
  unitName: string | null;
  status: HousekeepingTaskStatus;
  source: string;
  assignedTo: string | null;
  createdAt: Date;
}

export interface FailedMessageRow {
  kind: "notification" | "campaign";
  reference: string;
  recipient: string;
  type: string;
  detail: string;
  createdAt: Date;
}

export interface OpenRestaurantTicketRow {
  ticketId: string;
  outletKey: string;
  status: OutletTicketStatus;
  unitName: string | null;
  guestName: string;
  notes: string | null;
  createdAt: Date;
}

export interface SmartHandoverSnapshot {
  asOf: Date;
  pendingArrivals: PendingArrivalRow[];
  unpaidDepartures: UnpaidDepartureRow[];
  checkedOutToday: CheckedOutTodayRow[];
  refundDue: RefundDueRow[];
  vipInHouse: VipInHouseRow[];
  openComplaints: OpenComplaintRow[];
  roomsNeedingAttention: RoomNeedingAttentionRow[];
  pendingHousekeeping: PendingHousekeepingRow[];
  failedMessages: FailedMessageRow[];
  openRestaurantTickets: OpenRestaurantTicketRow[];
  totals: {
    pendingArrivals: number;
    unpaidDepartures: number;
    checkedOutToday: number;
    refundDue: number;
    vipInHouse: number;
    openComplaints: number;
    dirtyRooms: number;
    maintenanceRooms: number;
    pendingHousekeeping: number;
    failedMessages: number;
    openRestaurantTickets: number;
  };
}

const HANDOVER_TAKE = 50;
const COMPLAINT_LOOKBACK_DAYS = 14;

export async function loadSmartHandoverSnapshot(
  prisma: PrismaClient,
  hotelId: string,
  hotelCurrency: string,
  dayStart: Date,
  asOf: Date = new Date()
): Promise<SmartHandoverSnapshot> {
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const last24h = new Date(asOf.getTime() - 24 * 3600 * 1000);
  const complaintWindowStart = new Date(asOf.getTime() - COMPLAINT_LOOKBACK_DAYS * 24 * 3600 * 1000);

  const [
    expectedArrivals,
    expectedDepartures,
    checkedOutBookings,
    checkoutAuditRows,
    inHouseVip,
    feedbackRows,
    units,
    pendingHkTasks,
    failedNotifications,
    failedCampaigns,
    openTickets
  ] = await Promise.all([
    prisma.booking.findMany({
      where: {
        hotelId,
        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
        checkIn: { gte: dayStart, lt: dayEnd }
      },
      include: {
        guest: { select: { fullName: true, phoneE164: true, isVip: true } },
        roomType: { select: { name: true } },
        roomUnit: { select: { name: true } }
      },
      orderBy: { checkIn: "asc" },
      take: HANDOVER_TAKE
    }),
    prisma.booking.findMany({
      where: {
        hotelId,
        status: BookingStatus.CHECKED_IN,
        checkOut: { gte: new Date(dayStart.getTime() - 24 * 3600 * 1000), lt: new Date(dayEnd.getTime() + 24 * 3600 * 1000) }
      },
      select: {
        id: true,
        checkOut: true,
        totalAmount: true,
        currency: true,
        paymentStatus: true,
        guest: { select: { fullName: true, phoneE164: true, isVip: true } },
        roomUnit: { select: { name: true } }
      },
      take: HANDOVER_TAKE
    }),
    prisma.booking.findMany({
      where: {
        hotelId,
        status: BookingStatus.CHECKED_IN,
        checkOut: { gte: dayStart, lt: dayEnd }
      },
      select: {
        id: true,
        checkOut: true,
        totalAmount: true,
        currency: true,
        paymentStatus: true,
        guest: { select: { fullName: true, phoneE164: true } },
        roomUnit: { select: { name: true } }
      },
      orderBy: { checkOut: "desc" },
      take: HANDOVER_TAKE
    }),
    prisma.auditLog.findMany({
      where: {
        hotelId,
        entityType: "Booking",
        action: { in: ["MANUAL_FRONT_DESK_CHECK_OUT", "MANUAL_FRONT_DESK_CHECK_OUT_OUTSTANDING"] },
        createdAt: { gte: dayStart, lt: dayEnd }
      },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, createdAt: true, actorEmail: true, actorUserId: true }
    }),
    prisma.booking.findMany({
      where: {
        hotelId,
        status: BookingStatus.CHECKED_IN,
        guest: { isVip: true }
      },
      select: {
        id: true,
        checkOut: true,
        guest: { select: { fullName: true, phoneE164: true, vipNote: true } },
        roomUnit: { select: { name: true } }
      },
      orderBy: { checkOut: "asc" },
      take: HANDOVER_TAKE
    }),
    prisma.guestFeedback.findMany({
      where: {
        hotelId,
        createdAt: { gte: complaintWindowStart },
        OR: [
          { rating: { lte: 2 }, managerFollowUpClosedAt: null },
          { managerFollowUpRequestedAt: { not: null }, managerFollowUpClosedAt: null }
        ]
      },
      orderBy: { createdAt: "desc" },
      take: HANDOVER_TAKE
    }),
    prisma.roomUnit.findMany({
      where: { hotelId, isActive: true },
      select: {
        id: true,
        name: true,
        notes: true,
        roomType: { select: { name: true } }
      }
    }),
    prisma.housekeepingTask.findMany({
      where: {
        hotelId,
        status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
      },
      include: {
        roomUnit: { select: { name: true } },
        assignedTo: { select: { fullName: true, email: true } }
      },
      orderBy: { createdAt: "asc" },
      take: HANDOVER_TAKE
    }),
    prisma.notification.findMany({
      where: {
        hotelId,
        status: NotificationStatus.FAILED,
        createdAt: { gte: last24h }
      },
      include: {
        guest: { select: { fullName: true, phoneE164: true } }
      },
      orderBy: { createdAt: "desc" },
      take: HANDOVER_TAKE
    }),
    prisma.marketingCampaignRecipient.findMany({
      where: {
        campaign: { hotelId },
        outcome: { in: ["FAILED", "ERROR"] },
        createdAt: { gte: last24h }
      },
      include: {
        campaign: { select: { name: true } },
        guest: { select: { fullName: true, phoneE164: true } }
      },
      orderBy: { createdAt: "desc" },
      take: HANDOVER_TAKE
    }),
    prisma.outletOrderTicket.findMany({
      where: {
        hotelId,
        ticketStatus: {
          in: [OutletTicketStatus.NEW, OutletTicketStatus.ACKNOWLEDGED, OutletTicketStatus.PREPARING]
        }
      },
      include: {
        booking: {
          select: {
            roomUnit: { select: { name: true } },
            guest: { select: { fullName: true, phoneE164: true } }
          }
        }
      },
      orderBy: { createdAt: "asc" },
      take: HANDOVER_TAKE
    })
  ]);

  const pendingArrivals: PendingArrivalRow[] = expectedArrivals.map((b) => ({
    bookingId: b.id,
    guestName: b.guest?.fullName?.trim() || b.guest?.phoneE164 || "—",
    guestPhone: b.guest?.phoneE164 ?? "",
    roomTypeName: b.roomType?.name ?? "",
    unitName: b.roomUnit?.name ?? null,
    checkInExpected: b.checkIn,
    adults: b.adults ?? 0,
    children: b.children ?? 0,
    isVip: Boolean(b.guest?.isVip)
  }));

  const departureBookingIds = Array.from(new Set([...expectedDepartures.map((d) => d.id), ...checkedOutBookings.map((d) => d.id)]));
  const folioCharges = departureBookingIds.length
    ? await prisma.folioTransaction.groupBy({
        by: ["bookingId"],
        where: {
          hotelId,
          bookingId: { in: departureBookingIds },
          isVoided: false,
          transactionType: {
            in: [
              FolioTransactionType.FNB_CHARGE,
              FolioTransactionType.ACTIVITY_CHARGE,
              FolioTransactionType.OTHER_SERVICE_CHARGE
            ]
          }
        },
        _sum: { grossAmount: true }
      })
    : [];
  const folioPayments = departureBookingIds.length
    ? await prisma.folioTransaction.groupBy({
        by: ["bookingId"],
        where: {
          hotelId,
          bookingId: { in: departureBookingIds },
          isVoided: false,
          transactionType: {
            in: [FolioTransactionType.PAYMENT, FolioTransactionType.REFUND, FolioTransactionType.DISCOUNT]
          }
        },
        _sum: { grossAmount: true }
      })
    : [];
  const paymentIntentSums = departureBookingIds.length
    ? await prisma.paymentIntent.groupBy({
        by: ["bookingId"],
        where: {
          hotelId,
          bookingId: { in: departureBookingIds },
          status: PaymentStatus.SUCCEEDED
        },
        _sum: { amount: true }
      })
    : [];

  const chargeByBooking = new Map<string, number>();
  for (const row of folioCharges) {
    if (row.bookingId) chargeByBooking.set(row.bookingId, row._sum.grossAmount ?? 0);
  }
  const paidByBooking = new Map<string, number>();
  for (const row of folioPayments) {
    if (row.bookingId) paidByBooking.set(row.bookingId, row._sum.grossAmount ?? 0);
  }
  for (const row of paymentIntentSums) {
    if (!row.bookingId) continue;
    paidByBooking.set(row.bookingId, (paidByBooking.get(row.bookingId) ?? 0) + (row._sum.amount ?? 0));
  }

  const unpaidDepartures: UnpaidDepartureRow[] = expectedDepartures
    .map((d) => {
      const charges = chargeByBooking.get(d.id) ?? 0;
      const paid = paidByBooking.get(d.id) ?? 0;
      const totalDue = Math.max(d.totalAmount, charges);
      const outstanding = Math.max(0, Math.round((totalDue - paid) * 100) / 100);
      return {
        bookingId: d.id,
        guestName: d.guest?.fullName?.trim() || d.guest?.phoneE164 || "—",
        guestPhone: d.guest?.phoneE164 ?? "",
        unitName: d.roomUnit?.name ?? null,
        checkOutExpected: d.checkOut,
        outstandingAmount: outstanding,
        currency: d.currency || hotelCurrency,
        isVip: Boolean(d.guest?.isVip)
      };
    })
    .filter((row) => row.outstandingAmount > 0.005);

  const checkoutAuditByBooking = new Map<string, { createdAt: Date; staffLabel: string | null }>();
  for (const row of checkoutAuditRows) {
    if (!row.entityId || checkoutAuditByBooking.has(row.entityId)) continue;
    checkoutAuditByBooking.set(row.entityId, {
      createdAt: row.createdAt,
      staffLabel: row.actorEmail || row.actorUserId || null
    });
  }

  const checkedOutToday: CheckedOutTodayRow[] = checkedOutBookings.map((b) => {
    const charges = chargeByBooking.get(b.id) ?? 0;
    const paid = paidByBooking.get(b.id) ?? 0;
    const totalDue = Math.max(b.totalAmount, charges);
    const signedBalance = Math.round((totalDue - paid) * 100) / 100;
    const audit = checkoutAuditByBooking.get(b.id);
    return {
      bookingId: b.id,
      guestName: b.guest?.fullName?.trim() || b.guest?.phoneE164 || "—",
      guestPhone: b.guest?.phoneE164 ?? "",
      unitName: b.roomUnit?.name ?? null,
      checkedOutAt: audit?.createdAt ?? b.checkOut,
      staffLabel: audit?.staffLabel ?? null,
      paymentStatus: b.paymentStatus,
      balanceStatus: signedBalance < -0.005 ? "refund_due" : signedBalance > 0.005 ? "outstanding" : "settled",
      balanceAmount: Math.abs(signedBalance),
      currency: b.currency || hotelCurrency
    };
  });

  const refundDue: RefundDueRow[] = checkedOutBookings
    .map((b) => {
      const charges = chargeByBooking.get(b.id) ?? 0;
      const paid = paidByBooking.get(b.id) ?? 0;
      const totalDue = Math.max(b.totalAmount, charges);
      const signedBalance = Math.round((totalDue - paid) * 100) / 100;
      if (signedBalance >= -0.005) return null;
      return {
        bookingId: b.id,
        guestName: b.guest?.fullName?.trim() || b.guest?.phoneE164 || "—",
        guestPhone: b.guest?.phoneE164 ?? "",
        unitName: b.roomUnit?.name ?? null,
        amount: Math.abs(signedBalance),
        currency: b.currency || hotelCurrency,
        checkOut: b.checkOut
      } as RefundDueRow;
    })
    .filter((row): row is RefundDueRow => row !== null);

  const vipInHouse: VipInHouseRow[] = inHouseVip.map((b) => ({
    bookingId: b.id,
    guestName: b.guest?.fullName?.trim() || b.guest?.phoneE164 || "—",
    guestPhone: b.guest?.phoneE164 ?? "",
    unitName: b.roomUnit?.name ?? null,
    checkOut: b.checkOut,
    notes: b.guest?.vipNote ?? null
  }));

  const openComplaints: OpenComplaintRow[] = feedbackRows.map((f) => ({
    feedbackId: f.id,
    bookingId: f.bookingId,
    guestName: f.guestName ?? "Guest",
    rating: f.rating,
    category: f.category ?? null,
    comment: f.comment ?? null,
    createdAt: f.createdAt,
    followUpRequested: Boolean(f.managerFollowUpRequestedAt)
  }));

  const roomsNeedingAttention: RoomNeedingAttentionRow[] = units
    .map((u) => {
      const status = parseManualRoomStatusFromNotes(u.notes);
      if (status !== "CLEANING" && status !== "MAINTENANCE") return null;
      return {
        unitId: u.id,
        unitName: u.name,
        roomTypeName: u.roomType?.name ?? null,
        status: status === "CLEANING" ? "DIRTY" : "MAINTENANCE",
        notes: u.notes
      } as RoomNeedingAttentionRow;
    })
    .filter((row): row is RoomNeedingAttentionRow => row !== null);

  const dirtyRooms = roomsNeedingAttention.filter((r) => r.status === "DIRTY").length;
  const maintenanceRooms = roomsNeedingAttention.filter((r) => r.status === "MAINTENANCE").length;

  const pendingHousekeeping: PendingHousekeepingRow[] = pendingHkTasks.map((t) => ({
    taskId: t.id,
    unitName: t.roomUnit?.name ?? null,
    status: t.status,
    source: String(t.source),
    assignedTo: t.assignedTo?.fullName ?? t.assignedTo?.email ?? null,
    createdAt: t.createdAt
  }));

  const failedMessages: FailedMessageRow[] = [
    ...failedNotifications.map<FailedMessageRow>((n) => ({
      kind: "notification",
      reference: n.id,
      recipient: n.guest?.fullName ?? n.guest?.phoneE164 ?? "—",
      type: n.type ?? "WhatsApp",
      detail: n.title ?? n.body?.slice(0, 80) ?? "",
      createdAt: n.createdAt
    })),
    ...failedCampaigns.map<FailedMessageRow>((r) => ({
      kind: "campaign",
      reference: r.id,
      recipient: r.guest?.fullName ?? r.guest?.phoneE164 ?? "—",
      type: r.campaign?.name ?? "Campaign",
      detail: r.errorDetail ?? r.outcome ?? "Send failed",
      createdAt: r.createdAt
    }))
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const openRestaurantTickets: OpenRestaurantTicketRow[] = openTickets.map((t) => ({
    ticketId: t.id,
    outletKey: t.outletKey,
    status: t.ticketStatus,
    unitName: t.booking?.roomUnit?.name ?? null,
    guestName: t.booking?.guest?.fullName ?? t.booking?.guest?.phoneE164 ?? "Guest",
    notes: t.notes ?? null,
    createdAt: t.createdAt
  }));

  return {
    asOf,
    pendingArrivals,
    unpaidDepartures,
    checkedOutToday,
    refundDue,
    vipInHouse,
    openComplaints,
    roomsNeedingAttention,
    pendingHousekeeping,
    failedMessages,
    openRestaurantTickets,
    totals: {
      pendingArrivals: pendingArrivals.length,
      unpaidDepartures: unpaidDepartures.length,
      checkedOutToday: checkedOutToday.length,
      refundDue: refundDue.length,
      vipInHouse: vipInHouse.length,
      openComplaints: openComplaints.length,
      dirtyRooms,
      maintenanceRooms,
      pendingHousekeeping: pendingHousekeeping.length,
      failedMessages: failedMessages.length,
      openRestaurantTickets: openRestaurantTickets.length
    }
  };
}
