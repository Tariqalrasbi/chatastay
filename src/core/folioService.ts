/**
 * Guest folio / ledger services — single source of truth is FolioTransaction (+ optional PaymentAllocation).
 * Booking.totalAmount remains accommodation header until optional room_charge lines are posted to folio.
 */
import type { Prisma } from "@prisma/client";
import {
  FolioLedgerKind,
  FolioOutletCategory,
  FolioPostingTarget,
  FolioRevenueCategory,
  FolioStatus,
  FolioTransactionType,
  FolioTxnPaymentStatus,
  FolioTxnSourceType
} from "@prisma/client";
import { prisma } from "../db";
import { getFbFolioForBooking } from "./fbFolio";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type DbClient = Prisma.TransactionClient | typeof prisma;

export type FolioSummaryDto = {
  currency: string;
  folioId: string | null;
  roomChargesTotal: number;
  fbMenuSubtotal: number;
  fnbTotal: number;
  activitiesTotal: number;
  extrasTotal: number;
  discountsTotal: number;
  taxTotal: number;
  folioChargesNet: number;
  totalCharges: number;
  totalPayments: number;
  refundsTotal: number;
  paidBalance: number;
  unpaidBalance: number;
  outstandingBalance: number;
};

function isTxnActive(t: { voidedAt: Date | null; isVoided: boolean }): boolean {
  return !t.voidedAt && !t.isVoided;
}

export function mapTransactionTypeToLedgerKind(tt: FolioTransactionType): FolioLedgerKind {
  switch (tt) {
    case FolioTransactionType.FNB_CHARGE:
      return FolioLedgerKind.FNB_CHARGE;
    case FolioTransactionType.ACTIVITY_CHARGE:
      return FolioLedgerKind.ACTIVITY_CHARGE;
    case FolioTransactionType.OTHER_SERVICE_CHARGE:
      return FolioLedgerKind.SERVICE_CHARGE;
    case FolioTransactionType.PAYMENT:
      return FolioLedgerKind.PAYMENT;
    case FolioTransactionType.ADJUSTMENT:
      return FolioLedgerKind.ADJUSTMENT;
    case FolioTransactionType.REFUND:
      return FolioLedgerKind.REFUND;
    case FolioTransactionType.DISCOUNT:
      return FolioLedgerKind.DISCOUNT;
    default:
      return FolioLedgerKind.SERVICE_CHARGE;
  }
}

export function mapOutletCategoryToRevenueCategory(o: FolioOutletCategory): FolioRevenueCategory {
  switch (o) {
    case FolioOutletCategory.RESTAURANT:
      return FolioRevenueCategory.RESTAURANT;
    case FolioOutletCategory.CAFE:
      return FolioRevenueCategory.CAFE;
    case FolioOutletCategory.ACTIVITY:
      return FolioRevenueCategory.ACTIVITY;
    case FolioOutletCategory.ROOM_SERVICE:
      return FolioRevenueCategory.ROOM_SERVICE;
    case FolioOutletCategory.OTHER:
    default:
      return FolioRevenueCategory.OTHER;
  }
}

/** Ensures the default MAIN folio exists for a booking (OPEN). Idempotent. */
export async function ensureActiveFolio(
  db: DbClient,
  params: {
    hotelId: string;
    bookingId: string;
    guestId: string;
    roomUnitId?: string | null;
    currency: string;
    staffId?: string | null;
  }
): Promise<{ folioId: string; created: boolean }> {
  const existing = await db.folio.findFirst({
    where: {
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      folioCode: "MAIN",
      folioStatus: FolioStatus.OPEN
    },
    select: { id: true }
  });
  if (existing) {
    return { folioId: existing.id, created: false };
  }

  const folio = await db.folio.create({
    data: {
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      guestId: params.guestId,
      roomUnitId: params.roomUnitId ?? undefined,
      folioCode: "MAIN",
      folioStatus: FolioStatus.OPEN,
      currency: params.currency,
      createdByUserId: params.staffId ?? undefined
    }
  });
  return { folioId: folio.id, created: true };
}

export type PostChargeInput = {
  hotelId: string;
  bookingId: string;
  guestId: string;
  roomUnitId?: string | null;
  roomTypeId?: string | null;
  currency: string;
  staffId: string;
  outletCategory: FolioOutletCategory;
  transactionType: FolioTransactionType;
  menuItemId?: string | null;
  itemCode?: string | null;
  itemName: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  taxAmount?: number;
  postingTarget: FolioPostingTarget;
  folioPaymentStatus: FolioTxnPaymentStatus;
  folioPaymentMethod?: string | null;
  referenceNumber?: string | null;
  chargeDate: Date;
  serviceDate?: Date | null;
  notes?: string | null;
  staffNote?: string | null;
  internalNote?: string | null;
  sourceType?: FolioTxnSourceType;
  outletId?: string | null;
  outletMenuItemId?: string | null;
};

export async function postChargeToFolio(db: DbClient, input: PostChargeInput) {
  const { folioId } = await ensureActiveFolio(db, {
    hotelId: input.hotelId,
    bookingId: input.bookingId,
    guestId: input.guestId,
    roomUnitId: input.roomUnitId,
    currency: input.currency,
    staffId: input.staffId
  });

  const qty = Math.min(999, Math.max(1, Math.floor(input.quantity)));
  const disc = round2(Math.max(0, input.discountAmount ?? 0));
  const tax = round2(Math.max(0, input.taxAmount ?? 0));
  const gross = round2(qty * input.unitPrice);
  const net = round2(gross - disc + tax);

  const ledgerKind = mapTransactionTypeToLedgerKind(input.transactionType);
  const revenueCategory = mapOutletCategoryToRevenueCategory(input.outletCategory);

  return db.folioTransaction.create({
    data: {
      hotelId: input.hotelId,
      folioId,
      bookingId: input.bookingId,
      guestId: input.guestId,
      roomUnitId: input.roomUnitId ?? undefined,
      roomTypeId: input.roomTypeId ?? undefined,
      transactionType: input.transactionType,
      ledgerKind,
      revenueCategory,
      sourceType: input.sourceType ?? FolioTxnSourceType.ADMIN_PANEL,
      outletCategory: input.outletCategory,
      outletId: input.outletId ?? undefined,
      outletMenuItemId: input.outletMenuItemId ?? undefined,
      menuItemId: input.menuItemId ?? undefined,
      itemCode: input.itemCode ?? undefined,
      itemName: input.itemName,
      description: input.description ?? undefined,
      quantity: qty,
      unitPrice: input.unitPrice,
      grossAmount: gross,
      discountAmount: disc,
      taxAmount: tax,
      netAmount: net,
      currency: input.currency,
      postingTarget: input.postingTarget,
      folioPaymentStatus: input.folioPaymentStatus,
      folioPaymentMethod: input.folioPaymentMethod ?? undefined,
      referenceNumber: input.referenceNumber ?? undefined,
      chargeDate: input.chargeDate,
      serviceDate: input.serviceDate ?? undefined,
      postedAt: new Date(),
      notes: input.notes ?? undefined,
      staffNote: input.staffNote ?? undefined,
      internalNote: input.internalNote ?? undefined,
      createdByUserId: input.staffId,
      isVoided: false
    }
  });
}

export type PostPaymentInput = {
  hotelId: string;
  bookingId: string;
  guestId: string;
  roomUnitId?: string | null;
  roomTypeId?: string | null;
  currency: string;
  /** Front-desk user; omit for automated provider-settled payments (e.g. Stripe webhook). */
  staffId?: string | null;
  amount: number;
  folioPaymentMethod: string;
  postingTarget: FolioPostingTarget;
  chargeDate: Date;
  referenceNumber?: string | null;
  notes?: string | null;
  sourceType?: FolioTxnSourceType;
  /** When true, creates PaymentAllocation rows against oldest unpaid charge lines (FIFO). */
  allocateFifo?: boolean;
};

export async function postPaymentToFolio(db: DbClient, input: PostPaymentInput) {
  const { folioId } = await ensureActiveFolio(db, {
    hotelId: input.hotelId,
    bookingId: input.bookingId,
    guestId: input.guestId,
    roomUnitId: input.roomUnitId,
    currency: input.currency,
    staffId: input.staffId ?? undefined
  });

  const gross = round2(input.amount);
  const payment = await db.folioTransaction.create({
    data: {
      hotelId: input.hotelId,
      folioId,
      bookingId: input.bookingId,
      guestId: input.guestId,
      roomUnitId: input.roomUnitId ?? undefined,
      roomTypeId: input.roomTypeId ?? undefined,
      transactionType: FolioTransactionType.PAYMENT,
      ledgerKind: FolioLedgerKind.PAYMENT,
      revenueCategory: FolioRevenueCategory.OTHER,
      sourceType: input.sourceType ?? FolioTxnSourceType.ADMIN_PANEL,
      outletCategory: FolioOutletCategory.OTHER,
      itemName: "Guest payment (folio)",
      quantity: 1,
      unitPrice: gross,
      grossAmount: gross,
      taxAmount: 0,
      netAmount: gross,
      discountAmount: 0,
      currency: input.currency,
      postingTarget: input.postingTarget,
      folioPaymentStatus: FolioTxnPaymentStatus.PAID,
      folioPaymentMethod: input.folioPaymentMethod.slice(0, 48),
      referenceNumber: input.referenceNumber ?? undefined,
      chargeDate: input.chargeDate,
      postedAt: new Date(),
      notes: input.notes ?? undefined,
      createdByUserId: input.staffId ?? undefined,
      isVoided: false
    }
  });

  if (input.allocateFifo && gross > 0) {
    const unpaidCharges = await db.folioTransaction.findMany({
      where: {
        hotelId: input.hotelId,
        bookingId: input.bookingId,
        voidedAt: null,
        isVoided: false,
        folioPaymentStatus: FolioTxnPaymentStatus.UNPAID,
        transactionType: { notIn: [FolioTransactionType.PAYMENT, FolioTransactionType.REFUND] }
      },
      orderBy: { chargeDate: "asc" }
    });

    let remaining = gross;
    for (const line of unpaidCharges) {
      if (remaining <= 0) break;
      const due = round2(line.netAmount);
      if (due <= 0) continue;
      const apply = round2(Math.min(remaining, due));
      if (apply <= 0) continue;
      await db.paymentAllocation.create({
        data: {
          hotelId: input.hotelId,
          folioId,
          paymentTransactionId: payment.id,
          appliedToTransactionId: line.id,
          amountApplied: apply
        }
      });
      remaining = round2(remaining - apply);
    }
  }

  return payment;
}

export type PostRefundInput = {
  hotelId: string;
  bookingId: string;
  guestId: string;
  roomUnitId?: string | null;
  roomTypeId?: string | null;
  currency: string;
  staffId: string;
  amount: number;
  parentTransactionId: string;
  folioPaymentMethod?: string;
  chargeDate: Date;
  referenceNumber?: string | null;
  notes?: string | null;
};

/** Reverses value via a new line (never edits the original payment/charge). */
export async function postRefundToFolio(db: DbClient, input: PostRefundInput) {
  const parent = await db.folioTransaction.findFirst({
    where: { id: input.parentTransactionId, hotelId: input.hotelId, bookingId: input.bookingId }
  });
  if (!parent) throw new Error("Parent transaction not found for this booking.");
  if (parent.voidedAt || parent.isVoided) throw new Error("Cannot refund a voided line.");

  const { folioId } = await ensureActiveFolio(db, {
    hotelId: input.hotelId,
    bookingId: input.bookingId,
    guestId: input.guestId,
    roomUnitId: input.roomUnitId,
    currency: input.currency,
    staffId: input.staffId
  });

  const gross = round2(input.amount);
  return db.folioTransaction.create({
    data: {
      hotelId: input.hotelId,
      folioId,
      bookingId: input.bookingId,
      guestId: input.guestId,
      roomUnitId: input.roomUnitId ?? undefined,
      roomTypeId: input.roomTypeId ?? undefined,
      transactionType: FolioTransactionType.REFUND,
      ledgerKind: FolioLedgerKind.REFUND,
      revenueCategory: FolioRevenueCategory.OTHER,
      sourceType: FolioTxnSourceType.ADMIN_PANEL,
      outletCategory: FolioOutletCategory.OTHER,
      itemName: "Refund (linked)",
      description: input.notes ?? `Refund against ${parent.id}`,
      quantity: 1,
      unitPrice: gross,
      grossAmount: gross,
      taxAmount: 0,
      netAmount: gross,
      discountAmount: 0,
      currency: input.currency,
      postingTarget: parent.postingTarget,
      folioPaymentStatus: FolioTxnPaymentStatus.REFUNDED,
      folioPaymentMethod: (input.folioPaymentMethod ?? parent.folioPaymentMethod ?? "CASH").slice(0, 48),
      referenceNumber: input.referenceNumber ?? undefined,
      chargeDate: input.chargeDate,
      postedAt: new Date(),
      parentTransactionId: parent.id,
      createdByUserId: input.staffId,
      isVoided: false
    }
  });
}

export async function voidFolioTransaction(
  db: DbClient,
  params: {
    hotelId: string;
    bookingId: string;
    transactionId: string;
    staffId: string;
    reason: string;
  }
) {
  const txn = await db.folioTransaction.findFirst({
    where: { id: params.transactionId, hotelId: params.hotelId, bookingId: params.bookingId }
  });
  if (!txn) throw new Error("Transaction not found.");
  if (txn.voidedAt || txn.isVoided) throw new Error("Already voided.");

  await db.folioTransaction.update({
    where: { id: params.transactionId },
    data: {
      voidedAt: new Date(),
      voidedByUserId: params.staffId,
      voidReason: params.reason.slice(0, 500),
      folioPaymentStatus: FolioTxnPaymentStatus.VOIDED,
      isVoided: true,
      updatedByUserId: params.staffId
    }
  });
}

export async function listFolioTransactions(params: {
  hotelId: string;
  bookingId?: string;
  folioId?: string;
  includeVoided?: boolean;
  take?: number;
  skip?: number;
}) {
  const where: Prisma.FolioTransactionWhereInput = { hotelId: params.hotelId };
  if (params.bookingId) where.bookingId = params.bookingId;
  if (params.folioId) where.folioId = params.folioId;
  if (!params.includeVoided) {
    where.voidedAt = null;
    where.isVoided = false;
  }

  return prisma.folioTransaction.findMany({
    where,
    orderBy: { chargeDate: "desc" },
    take: params.take ?? 200,
    skip: params.skip ?? 0,
    include: {
      createdBy: { select: { fullName: true, email: true } },
      voidedBy: { select: { fullName: true, email: true } }
    }
  });
}

/**
 * Financial summary for UI/reporting.
 *
 * Sources of truth (no duplicate “folio total” stored on Booking):
 * - Room: `bookingTotalAmount` = Booking.totalAmount (stay header until optional ROOM_CHARGE lines exist).
 * - F&B (WhatsApp/menu flow): `getFbFolioForBooking` = posted FbOrder lines, not FolioTransaction.
 * - Extras / desk payments / refunds: FolioTransaction only (voided excluded).
 * - Card/Stripe prepayments: `paymentIntentsSucceededTotal` from PaymentIntent, not folio payments.
 *
 * FolioTransaction rollups below are computed only from transaction rows (+ void flags), not from booking fields.
 */
export async function getFolioSummary(params: {
  hotelId: string;
  bookingId: string;
  bookingTotalAmount: number;
  currency: string;
  paymentIntentsSucceededTotal: number;
}): Promise<FolioSummaryDto> {
  const folio = await prisma.folio.findFirst({
    where: { hotelId: params.hotelId, bookingId: params.bookingId, folioCode: "MAIN" },
    select: { id: true }
  });

  const fb = await getFbFolioForBooking(params.bookingId);
  const txns = await prisma.folioTransaction.findMany({
    where: { hotelId: params.hotelId, bookingId: params.bookingId }
  });

  let fnbTotal = 0;
  let activitiesTotal = 0;
  let extrasTotal = 0;
  let discountsTotal = 0;
  let taxTotal = 0;
  let folioChargesNet = 0;
  let totalPayments = 0;
  let refundsTotal = 0;

  for (const t of txns) {
    if (!isTxnActive(t)) continue;

    taxTotal = round2(taxTotal + t.taxAmount);

    if (t.transactionType === FolioTransactionType.PAYMENT) {
      totalPayments = round2(totalPayments + t.grossAmount);
      continue;
    }
    if (t.transactionType === FolioTransactionType.REFUND) {
      refundsTotal = round2(refundsTotal + t.grossAmount);
      continue;
    }

    const net = round2(t.netAmount);
    const lk = t.ledgerKind ?? mapTransactionTypeToLedgerKind(t.transactionType);
    const rc = t.revenueCategory ?? mapOutletCategoryToRevenueCategory(t.outletCategory);

    if (t.transactionType === FolioTransactionType.DISCOUNT || lk === FolioLedgerKind.DISCOUNT) {
      discountsTotal = round2(discountsTotal + Math.abs(net));
      folioChargesNet = round2(folioChargesNet + net);
      continue;
    }
    if (t.transactionType === FolioTransactionType.ADJUSTMENT || lk === FolioLedgerKind.ADJUSTMENT) {
      if (net < 0) discountsTotal = round2(discountsTotal + Math.abs(net));
      folioChargesNet = round2(folioChargesNet + net);
      continue;
    }

    folioChargesNet = round2(folioChargesNet + net);

    if (lk === FolioLedgerKind.FNB_CHARGE || rc === FolioRevenueCategory.RESTAURANT || rc === FolioRevenueCategory.CAFE) {
      fnbTotal = round2(fnbTotal + net);
    } else if (lk === FolioLedgerKind.ACTIVITY_CHARGE || rc === FolioRevenueCategory.ACTIVITY) {
      activitiesTotal = round2(activitiesTotal + net);
    } else {
      extrasTotal = round2(extrasTotal + net);
    }
  }

  const roomChargesTotal = round2(params.bookingTotalAmount);
  const fbMenuSubtotal = round2(fb.subtotal);
  const totalCharges = round2(roomChargesTotal + fbMenuSubtotal + folioChargesNet);
  const netCollected = round2(totalPayments - refundsTotal);
  const paidBooking = round2(params.paymentIntentsSucceededTotal);
  const paidBalance = round2(paidBooking + netCollected);
  const outstandingBalance = Math.max(0, round2(totalCharges - paidBalance));
  const unpaidBalance = outstandingBalance;

  return {
    currency: params.currency,
    folioId: folio?.id ?? null,
    roomChargesTotal,
    fbMenuSubtotal,
    fnbTotal: round2(fnbTotal),
    activitiesTotal: round2(activitiesTotal),
    extrasTotal: round2(extrasTotal),
    discountsTotal: round2(discountsTotal),
    taxTotal: round2(taxTotal),
    folioChargesNet: round2(folioChargesNet),
    totalCharges,
    totalPayments: round2(totalPayments),
    refundsTotal: round2(refundsTotal),
    paidBalance,
    unpaidBalance,
    outstandingBalance
  };
}

/** Load folio header + booking context for API responses. */
export async function getFolioByBookingId(hotelId: string, bookingId: string) {
  return prisma.folio.findFirst({
    where: { hotelId, bookingId, folioCode: "MAIN" },
    include: {
      booking: { select: { id: true, status: true, totalAmount: true, currency: true, checkIn: true, checkOut: true } },
      guest: { select: { id: true, fullName: true, phoneE164: true } },
      roomUnit: { select: { id: true, name: true } }
    }
  });
}

