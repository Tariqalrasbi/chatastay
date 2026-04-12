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
import { prisma } from "../db";

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
  directFnChargesNet: number;
  directFnChargeLineCount: number;
  walkInPaymentTotal: number;
  walkInPaymentsByMethod: { method: string; amount: number }[];
  expenseTotal: number;
};

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

  const directCharges = await prisma.folioTransaction.aggregate({
    where: {
      hotelId,
      isVoided: false,
      transactionType: FolioTransactionType.FNB_CHARGE,
      bookingId: null,
      chargeDate: { gte: rangeStartInclusive, lt: rangeEndExclusive }
    },
    _sum: { netAmount: true },
    _count: true
  });

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
    const m = (p.folioPaymentMethod ?? "Unspecified").trim().slice(0, 48) || "Unspecified";
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
    directFnChargesNet: round2(directCharges._sum.netAmount ?? 0),
    directFnChargeLineCount: directCharges._count,
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
}): Promise<void> {
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
          createdByUserId: params.staffId,
          isVoided: false
        }
      });
      chargeIds.push(row.id);
    }

    await tx.folioTransaction.create({
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
        createdByUserId: params.staffId,
        isVoided: false
      }
    });
  });
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
