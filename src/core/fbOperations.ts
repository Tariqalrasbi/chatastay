import {
  BookingStatus,
  FbOutletType,
  FolioLedgerKind,
  FolioOutletCategory,
  FolioPostingTarget,
  FolioRevenueCategory,
  FolioTransactionType,
  FolioTxnPaymentStatus,
  FolioTxnSourceType
} from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma } from "../db";
import { optionalHotelUserId } from "./folioService";
import { bucketFolioPaymentMethod } from "./shiftCloseReport";
import { formatYmdInHotelZone, hotelTimezoneOrUtc, wallClockLocalToUtc } from "./guestMessagingSchedule";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mapMenuOutletToFolioCategory(t: FbOutletType): FolioOutletCategory {
  return t === FbOutletType.COFFEE_SHOP ? FolioOutletCategory.CAFE : FolioOutletCategory.RESTAURANT;
}

function mapMenuOutletToSource(t: FbOutletType): FolioTxnSourceType {
  return t === FbOutletType.COFFEE_SHOP ? FolioTxnSourceType.POS_CAFE : FolioTxnSourceType.POS_RESTAURANT;
}

export type InHouseBookingRow = {
  id: string;
  referenceCode: string | null;
  guest: { fullName: string | null; phoneE164: string };
  roomUnit: { id: string; name: string } | null;
};

/** Confirmed stays overlapping the given local calendar day (hotel-agnostic day boundary; matches room-board style). */
export async function listInHouseBookingsForHotelDay(hotelId: string, day: Date): Promise<InHouseBookingRow[]> {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const rows = await prisma.booking.findMany({
    where: {
      hotelId,
      status: BookingStatus.CONFIRMED,
      checkIn: { lt: dayEnd },
      checkOut: { gt: dayStart }
    },
    select: {
      id: true,
      referenceCode: true,
      guest: { select: { fullName: true, phoneE164: true } },
      roomUnit: { select: { id: true, name: true } }
    },
    orderBy: [{ checkIn: "desc" }, { id: "asc" }]
  });
  return rows;
}

export type FbOperationsSummary = {
  fbOrderFolioTotal: number;
  fbOrderFolioCount: number;
  /** In-house F&B ledger lines (booking-linked), distinct from FbOrder totals. */
  folioGuestFnChargesNet: number;
  folioGuestFnChargeLineCount: number;
  directFnChargesNet: number;
  directFnChargeLineCount: number;
  /** Direct F&B without booking — restaurant. */
  directFnRestaurantNet: number;
  /** Direct F&B without booking — café. */
  directFnCafeNet: number;
  /** Direct F&B without booking — other classification. */
  directFnOtherNet: number;
  /** Subtotal from quick cashier panel only (POS_WALK_IN_CASHIER marker). */
  walkInCashierFnNet: number;
  /** Activity charges in range (ledger). */
  activityChargesNet: number;
  activityFolioLinkedNet: number;
  activityDirectNet: number;
  walkInPaymentTotal: number;
  walkInPaymentsByMethod: { method: string; amount: number }[];
  expenseTotal: number;
};

function classifyDirectFnOutlet(row: {
  revenueCategory: FolioRevenueCategory | null;
  outletCategory: FolioOutletCategory;
}): "RESTAURANT" | "CAFE" | "OTHER" {
  const rc = row.revenueCategory;
  const oc = row.outletCategory;
  if (rc === FolioRevenueCategory.CAFE || oc === FolioOutletCategory.CAFE) return "CAFE";
  if (rc === FolioRevenueCategory.RESTAURANT || oc === FolioOutletCategory.RESTAURANT) return "RESTAURANT";
  return "OTHER";
}

export async function getFbOperationsSummary(
  hotelId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date
): Promise<FbOperationsSummary> {
  const orders = await prisma.fbOrder.aggregate({
    where: {
      hotelId,
      createdAt: { gte: rangeStartInclusive, lt: rangeEndExclusive }
    },
    _sum: { totalAmount: true },
    _count: true
  });

  const [folioGuestFnAgg, directFnRows, activityRows] = await Promise.all([
    prisma.folioTransaction.aggregate({
      where: {
        hotelId,
        isVoided: false,
        transactionType: FolioTransactionType.FNB_CHARGE,
        bookingId: { not: null },
        chargeDate: { gte: rangeStartInclusive, lt: rangeEndExclusive }
      },
      _sum: { netAmount: true },
      _count: true
    }),
    prisma.folioTransaction.findMany({
      where: {
        hotelId,
        isVoided: false,
        transactionType: FolioTransactionType.FNB_CHARGE,
        bookingId: null,
        chargeDate: { gte: rangeStartInclusive, lt: rangeEndExclusive }
      },
      select: {
        netAmount: true,
        revenueCategory: true,
        outletCategory: true,
        internalNote: true
      }
    }),
    prisma.folioTransaction.findMany({
      where: {
        hotelId,
        isVoided: false,
        transactionType: FolioTransactionType.ACTIVITY_CHARGE,
        chargeDate: { gte: rangeStartInclusive, lt: rangeEndExclusive }
      },
      select: { netAmount: true, bookingId: true }
    })
  ]);

  let directFnChargesNet = 0;
  let directFnRestaurantNet = 0;
  let directFnCafeNet = 0;
  let directFnOtherNet = 0;
  let walkInCashierFnNet = 0;
  for (const row of directFnRows) {
    const n = round2(row.netAmount);
    directFnChargesNet = round2(directFnChargesNet + n);
    if (row.internalNote === "POS_WALK_IN_CASHIER") {
      walkInCashierFnNet = round2(walkInCashierFnNet + n);
    }
    const bucket = classifyDirectFnOutlet(row);
    if (bucket === "CAFE") directFnCafeNet = round2(directFnCafeNet + n);
    else if (bucket === "RESTAURANT") directFnRestaurantNet = round2(directFnRestaurantNet + n);
    else directFnOtherNet = round2(directFnOtherNet + n);
  }

  let activityChargesNet = 0;
  let activityFolioLinkedNet = 0;
  let activityDirectNet = 0;
  for (const row of activityRows) {
    const n = round2(row.netAmount);
    activityChargesNet = round2(activityChargesNet + n);
    if (row.bookingId) activityFolioLinkedNet = round2(activityFolioLinkedNet + n);
    else activityDirectNet = round2(activityDirectNet + n);
  }

  const walkPayments = await prisma.folioTransaction.findMany({
    where: {
      hotelId,
      isVoided: false,
      transactionType: FolioTransactionType.PAYMENT,
      bookingId: null,
      chargeDate: { gte: rangeStartInclusive, lt: rangeEndExclusive },
      sourceType: { in: [FolioTxnSourceType.POS_RESTAURANT, FolioTxnSourceType.POS_CAFE] }
    },
    select: { grossAmount: true, folioPaymentMethod: true }
  });

  const byMethod = new Map<string, number>();
  let walkInPaymentTotal = 0;
  for (const p of walkPayments) {
    const m = bucketFolioPaymentMethod(p.folioPaymentMethod);
    const g = round2(p.grossAmount);
    walkInPaymentTotal = round2(walkInPaymentTotal + g);
    byMethod.set(m, round2((byMethod.get(m) ?? 0) + g));
  }
  const walkInPaymentsByMethod = Array.from(byMethod.entries())
    .map(([method, amount]) => ({ method, amount }))
    .sort((a, b) => b.amount - a.amount);

  const exp = await prisma.fbOperationalExpense.aggregate({
    where: {
      hotelId,
      expenseDate: { gte: rangeStartInclusive, lt: rangeEndExclusive }
    },
    _sum: { amount: true }
  });

  return {
    fbOrderFolioTotal: round2(orders._sum.totalAmount ?? 0),
    fbOrderFolioCount: orders._count,
    folioGuestFnChargesNet: round2(folioGuestFnAgg._sum.netAmount ?? 0),
    folioGuestFnChargeLineCount: folioGuestFnAgg._count,
    directFnChargesNet,
    directFnChargeLineCount: directFnRows.length,
    directFnRestaurantNet,
    directFnCafeNet,
    directFnOtherNet,
    walkInCashierFnNet,
    activityChargesNet,
    activityFolioLinkedNet,
    activityDirectNet,
    walkInPaymentTotal,
    walkInPaymentsByMethod,
    expenseTotal: round2(exp._sum.amount ?? 0)
  };
}

/**
 * Walk-in / non-staying sale: posts folio ledger lines without a booking (FNB charges + matching payment for shift / method reporting).
 */
export async function recordWalkInDirectSale(params: {
  hotelId: string;
  currency: string;
  staffId: string;
  paymentMethodRaw: string;
  notes: string | null;
  lines: { menuItemId: string; qty: number }[];
  /** When set (cashier panel), every line must match this outlet — prevents mixed-outlet posts. */
  outletScope?: FbOutletType | null;
}): Promise<{
  saleId: string;
  paymentId: string;
  total: number;
  paymentMethod: string;
  lineCount: number;
}> {
  const filtered = params.lines.filter((l) => l.qty >= 1);
  if (filtered.length === 0) throw new Error("Select at least one menu item.");

  const ids = [...new Set(filtered.map((l) => l.menuItemId))];
  const items = await prisma.menuItem.findMany({
    where: { id: { in: ids }, hotelId: params.hotelId, isActive: true }
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  type LineRow = {
    item: (typeof items)[0];
    qty: number;
    lineTotal: number;
  };
  const resolved: LineRow[] = [];
  for (const l of filtered) {
    const item = byId.get(l.menuItemId);
    if (!item) continue;
    const qty = Math.min(99, Math.max(1, Math.floor(l.qty)));
    const lineTotal = round2(item.unitPrice * qty);
    resolved.push({ item, qty, lineTotal });
  }
  if (resolved.length === 0) throw new Error("No valid menu items.");

  if (params.outletScope) {
    for (const r of resolved) {
      if (r.item.outletType !== params.outletScope) {
        throw new Error("Items must match the selected outlet (restaurant or café).");
      }
    }
  }

  let totalFn = 0;
  for (const r of resolved) totalFn = round2(totalFn + r.lineTotal);

  const method = params.paymentMethodRaw.trim().slice(0, 48) || "CASH";
  const notes = params.notes?.trim().slice(0, 500) || null;
  const payUpper = method.toUpperCase();
  const sourceForPayment =
    resolved.some((r) => r.item.outletType === FbOutletType.RESTAURANT) || resolved.length === 0
      ? FolioTxnSourceType.POS_RESTAURANT
      : FolioTxnSourceType.POS_CAFE;

  const candidateCreatedBy = optionalHotelUserId(params.staffId);
  const validCreator = candidateCreatedBy
    ? await prisma.hotelUser.findFirst({
        where: { id: candidateCreatedBy, hotelId: params.hotelId },
        select: { id: true }
      })
    : null;
  const walkInCreatedBy = validCreator?.id;
  const saleId = `POS-${randomUUID()}`;
  let paymentId = "";

  await prisma.$transaction(async (tx) => {
    const chargeIds: string[] = [];
    for (const r of resolved) {
      const oc = mapMenuOutletToFolioCategory(r.item.outletType);
      const lk = FolioLedgerKind.FNB_CHARGE;
      const rc = mapOutletCategoryToRevenue(oc);
      const st = mapMenuOutletToSource(r.item.outletType);
      const gross = r.lineTotal;
      const net = gross;
      const row = await tx.folioTransaction.create({
        data: {
          hotelId: params.hotelId,
          folioId: null,
          bookingId: null,
          guestId: null,
          transactionType: FolioTransactionType.FNB_CHARGE,
          ledgerKind: lk,
          revenueCategory: rc,
          sourceType: st,
          outletCategory: oc,
          menuItemId: r.item.id,
          itemName: r.item.name,
          description: notes ?? undefined,
          quantity: r.qty,
          unitPrice: r.item.unitPrice,
          grossAmount: gross,
          discountAmount: 0,
          taxAmount: 0,
          netAmount: net,
          currency: params.currency,
          postingTarget: FolioPostingTarget.BOOKING_ACCOUNT,
          folioPaymentStatus: FolioTxnPaymentStatus.UNPAID,
          chargeDate: new Date(),
          postedAt: new Date(),
          notes: "Quick cashier / walk-in (charge)",
          internalNote: "POS_WALK_IN_CASHIER",
          externalSourceId: saleId,
          externalSourcePayload: JSON.stringify({ source: "FB_DIRECT_SALE", saleId }),
          ...(walkInCreatedBy ? { createdByUserId: walkInCreatedBy } : {}),
          isVoided: false
        }
      });
      chargeIds.push(row.id);
    }

    const payment = await tx.folioTransaction.create({
      data: {
        hotelId: params.hotelId,
        folioId: null,
        bookingId: null,
        guestId: null,
        transactionType: FolioTransactionType.PAYMENT,
        ledgerKind: FolioLedgerKind.PAYMENT,
        revenueCategory: FolioRevenueCategory.OTHER,
        sourceType: sourceForPayment,
        outletCategory: FolioOutletCategory.OTHER,
        itemName: `Walk-in payment (${payUpper})`,
        quantity: 1,
        unitPrice: totalFn,
        grossAmount: totalFn,
        discountAmount: 0,
        taxAmount: 0,
        netAmount: totalFn,
        currency: params.currency,
        postingTarget: FolioPostingTarget.BOOKING_ACCOUNT,
        folioPaymentStatus: FolioTxnPaymentStatus.PAID,
        folioPaymentMethod: method,
        chargeDate: new Date(),
        postedAt: new Date(),
        notes: notes ?? `Walk-in direct sale; lines: ${chargeIds.length}`,
        internalNote: "POS_WALK_IN_CASHIER_PAY",
        externalSourceId: saleId,
        externalSourcePayload: JSON.stringify({ source: "FB_DIRECT_SALE", saleId, chargeIds }),
        ...(walkInCreatedBy ? { createdByUserId: walkInCreatedBy } : {}),
        isVoided: false
      }
    });
    paymentId = payment.id;
  });

  return { saleId, paymentId, total: totalFn, paymentMethod: method, lineCount: resolved.length };
}

function mapOutletCategoryToRevenue(o: FolioOutletCategory): FolioRevenueCategory {
  switch (o) {
    case FolioOutletCategory.RESTAURANT:
      return FolioRevenueCategory.RESTAURANT;
    case FolioOutletCategory.CAFE:
      return FolioRevenueCategory.CAFE;
    case FolioOutletCategory.ROOM_SERVICE:
      return FolioRevenueCategory.ROOM_SERVICE;
    case FolioOutletCategory.ACTIVITY:
      return FolioRevenueCategory.ACTIVITY;
    default:
      return FolioRevenueCategory.OTHER;
  }
}

// ---------------------------------------------------------------------------
// Daily breakfast / buffet preparation summary
// ---------------------------------------------------------------------------
//
// Drives the "Today's Breakfast / Buffet Count" card on the chef's restaurant
// landing page. Categorises every in-house booking for the hotel's local
// "today" by meal-plan/board-type. Room-Only bookings are excluded by default
// and only counted if breakfast was added later (folio FNB charge with a
// breakfast SKU or name) — matches the WhatsApp in-stay flow, the front-desk
// manual folio charge path, and outlet ticket → folio path.

export type BuffetCategory = "BREAKFAST" | "HALF_BOARD" | "FULL_BOARD" | "ADDED";

export type BuffetCountRow = {
  category: BuffetCategory;
  bookings: number;
  adults: number;
  children: number;
  total: number;
};

export type BreakfastBuffetCount = {
  /** YYYY-MM-DD in the hotel's local timezone. */
  asOfYmd: string;
  rows: BuffetCountRow[];
  totals: { bookings: number; adults: number; children: number; total: number };
};

const BREAKFAST_SKU_CODES = new Set(["REST-BFAST", "RESTBFAST", "BFAST", "BREAKFAST"]);
const BREAKFAST_NAME_PATTERN = /breakfast/i;

type CandidateBooking = {
  id: string;
  mealPlan: string | null;
  adults: number;
  children: number;
  checkIn: Date;
  checkOut: Date;
  status: BookingStatus;
};

/**
 * Decide which buffet bucket a booking belongs to (or `null` for none).
 * Pure function — extracted so unit tests can exercise every branch without
 * touching the database.
 */
export function categorizeBookingForBuffet(
  booking: { mealPlan: string | null | undefined },
  hasAddedBreakfastToday: boolean
): BuffetCategory | null {
  const plan = String(booking.mealPlan ?? "NONE").toUpperCase();
  if (plan === "BREAKFAST") return "BREAKFAST";
  if (plan === "HALF_BOARD") return "HALF_BOARD";
  if (plan === "FULL_BOARD") return "FULL_BOARD";
  if (hasAddedBreakfastToday) return "ADDED";
  return null;
}

function isBreakfastFolioLine(line: { itemCode: string | null; itemName: string; description: string | null }): boolean {
  const code = (line.itemCode ?? "").trim().toUpperCase();
  if (code && BREAKFAST_SKU_CODES.has(code)) return true;
  if (BREAKFAST_NAME_PATTERN.test(line.itemName ?? "")) return true;
  if (line.description && BREAKFAST_NAME_PATTERN.test(line.description)) return true;
  return false;
}

function emptyBuffetRow(category: BuffetCategory): BuffetCountRow {
  return { category, bookings: 0, adults: 0, children: 0, total: 0 };
}

/**
 * Aggregate today's breakfast/buffet expectation for the hotel.
 *
 * Eligible booking statuses: CONFIRMED + CHECKED_IN (PENDING / CANCELLED /
 * NO_SHOW are excluded — matches the chef's "people actually staying with us"
 * mental model). The hotel-TZ calendar overlap is inclusive of the checkout
 * date so a guest leaving today still gets breakfast.
 */
export async function getBreakfastBuffetCountForToday(
  hotelId: string,
  hotelTimezone: string | null | undefined,
  asOf: Date = new Date()
): Promise<BreakfastBuffetCount> {
  const tz = hotelTimezoneOrUtc(hotelTimezone);
  const ymd = formatYmdInHotelZone(asOf, tz);
  const dayStartUtc = wallClockLocalToUtc(ymd, "00:00", tz);
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 3600 * 1000);

  // Wider DB filter on the date columns prunes the result set without forcing
  // us to compute hotel-TZ ymds inside the query. The post-filter below is the
  // authoritative overlap check.
  const candidatesRaw = await prisma.booking.findMany({
    where: {
      hotelId,
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
      checkIn: { lt: new Date(dayEndUtc.getTime() + 36 * 3600 * 1000) },
      checkOut: { gt: new Date(dayStartUtc.getTime() - 36 * 3600 * 1000) }
    },
    select: {
      id: true,
      mealPlan: true,
      adults: true,
      children: true,
      checkIn: true,
      checkOut: true,
      status: true
    }
  });

  const eligible: CandidateBooking[] = candidatesRaw.filter((b) => {
    const cin = formatYmdInHotelZone(b.checkIn, tz);
    const cout = formatYmdInHotelZone(b.checkOut, tz);
    return ymd >= cin && ymd <= cout;
  });

  // Only Room-Only / unset-meal-plan bookings need the folio lookup.
  const noPlanIds: string[] = eligible
    .filter((b) => {
      const plan = String(b.mealPlan ?? "NONE").toUpperCase();
      return plan !== "BREAKFAST" && plan !== "HALF_BOARD" && plan !== "FULL_BOARD";
    })
    .map((b) => b.id);

  const addedBreakfastBookingIds = new Set<string>();
  if (noPlanIds.length > 0) {
    const charges = await prisma.folioTransaction.findMany({
      where: {
        hotelId,
        bookingId: { in: noPlanIds },
        transactionType: FolioTransactionType.FNB_CHARGE,
        isVoided: false,
        chargeDate: { gte: dayStartUtc, lt: dayEndUtc }
      },
      select: { bookingId: true, itemCode: true, itemName: true, description: true }
    });
    for (const c of charges) {
      if (!c.bookingId) continue;
      if (isBreakfastFolioLine(c)) addedBreakfastBookingIds.add(c.bookingId);
    }
  }

  const acc: Record<BuffetCategory, BuffetCountRow> = {
    BREAKFAST: emptyBuffetRow("BREAKFAST"),
    HALF_BOARD: emptyBuffetRow("HALF_BOARD"),
    FULL_BOARD: emptyBuffetRow("FULL_BOARD"),
    ADDED: emptyBuffetRow("ADDED")
  };

  for (const b of eligible) {
    const adults = Math.max(0, Math.floor(b.adults ?? 0));
    const children = Math.max(0, Math.floor(b.children ?? 0));
    const bucket = categorizeBookingForBuffet(b, addedBreakfastBookingIds.has(b.id));
    if (!bucket) continue;
    const row = acc[bucket];
    row.bookings += 1;
    row.adults += adults;
    row.children += children;
    row.total += adults + children;
  }

  const rows: BuffetCountRow[] = [acc.BREAKFAST, acc.HALF_BOARD, acc.FULL_BOARD, acc.ADDED];
  const totals = rows.reduce(
    (s, r) => ({
      bookings: s.bookings + r.bookings,
      adults: s.adults + r.adults,
      children: s.children + r.children,
      total: s.total + r.total
    }),
    { bookings: 0, adults: 0, children: 0, total: 0 }
  );

  return { asOfYmd: ymd, rows, totals };
}
