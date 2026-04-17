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

/** Trimmed non-empty id for optional FK columns (never write "" or whitespace-only). */
function nonEmptyRelationId(id?: string | null): string | undefined {
  if (id == null) return undefined;
  const t = String(id).trim();
  return t.length > 0 ? t : undefined;
}

/** Non-empty string user id for optional HotelUser FKs; omit field when absent (avoids Prisma/SQLite FK issues). */
export function optionalHotelUserId(staffId?: string | null): string | undefined {
  return nonEmptyRelationId(staffId);
}

const KNOWN_FOLIO_PAY_METHODS = new Set([
  "CASH",
  "CARD",
  "MBANKING",
  "TRANSFER",
  "CREDIT",
  "LPO",
  "CHEQUE",
  "CHECK",
  "STRIPE",
  "STRIPE_CHECKOUT",
  "OTHER"
]);

/** Normalizes payment amount for a folio PAYMENT line: finite, > 0, 2 dp. */
export function normalizePaymentAmountForPost(raw: number): number {
  const n = round2(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Payment amount must be a finite number greater than zero.");
  }
  return n;
}

/**
 * Safer payment method label: trim, max length, prefer known hotel desk codes (uppercase).
 * Unknown labels are kept for legacy/custom POS strings (still capped).
 */
export function sanitizeFolioPaymentMethod(raw: string): string {
  const t = String(raw ?? "").trim().slice(0, 48);
  if (!t) return "CASH";
  const upper = t.toUpperCase();
  if (KNOWN_FOLIO_PAY_METHODS.has(upper)) return upper;
  return t;
}

function truncateOptional(s: string | null | undefined, max: number): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

async function assertBookingGuestMatchesFolio(
  db: DbClient,
  hotelId: string,
  bookingId: string,
  guestId: string
): Promise<void> {
  const b = await db.booking.findFirst({
    where: { id: bookingId, hotelId },
    select: { guestId: true }
  });
  if (!b) throw new Error("Booking not found for this folio operation.");
  if (b.guestId !== guestId) throw new Error("Guest does not match this booking.");
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

  const createdBy = optionalHotelUserId(params.staffId);
  const roomUnitFk = nonEmptyRelationId(params.roomUnitId);
  const folio = await db.folio.create({
    data: {
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      guestId: params.guestId,
      ...(roomUnitFk ? { roomUnitId: roomUnitFk } : {}),
      folioCode: "MAIN",
      folioStatus: FolioStatus.OPEN,
      currency: params.currency,
      ...(createdBy ? { createdByUserId: createdBy } : {})
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
  await assertBookingGuestMatchesFolio(db, input.hotelId, input.bookingId, input.guestId);
  const roomUnitIdFk = nonEmptyRelationId(input.roomUnitId);
  const roomTypeIdFk = nonEmptyRelationId(input.roomTypeId);
  const outletIdFk = nonEmptyRelationId(input.outletId);
  const outletMenuItemIdFk = nonEmptyRelationId(input.outletMenuItemId);
  const menuItemIdFk = nonEmptyRelationId(input.menuItemId);
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
  const chargeCreatedBy = optionalHotelUserId(input.staffId);

  return db.folioTransaction.create({
    data: {
      hotelId: input.hotelId,
      folioId,
      bookingId: input.bookingId,
      guestId: input.guestId,
      ...(roomUnitIdFk ? { roomUnitId: roomUnitIdFk } : {}),
      ...(roomTypeIdFk ? { roomTypeId: roomTypeIdFk } : {}),
      transactionType: input.transactionType,
      ledgerKind,
      revenueCategory,
      sourceType: input.sourceType ?? FolioTxnSourceType.ADMIN_PANEL,
      outletCategory: input.outletCategory,
      ...(outletIdFk ? { outletId: outletIdFk } : {}),
      ...(outletMenuItemIdFk ? { outletMenuItemId: outletMenuItemIdFk } : {}),
      ...(menuItemIdFk ? { menuItemId: menuItemIdFk } : {}),
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
      ...(chargeCreatedBy ? { createdByUserId: chargeCreatedBy } : {}),
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
  /** Staff-only audit line (optional). */
  internalNote?: string | null;
  sourceType?: FolioTxnSourceType;
  /** When true, creates PaymentAllocation rows against oldest unpaid charge lines (FIFO). */
  allocateFifo?: boolean;
};

export async function postPaymentToFolio(db: DbClient, input: PostPaymentInput) {
  await assertBookingGuestMatchesFolio(db, input.hotelId, input.bookingId, input.guestId);
  const roomUnitIdFk = nonEmptyRelationId(input.roomUnitId);
  const roomTypeIdFk = nonEmptyRelationId(input.roomTypeId);
  const { folioId } = await ensureActiveFolio(db, {
    hotelId: input.hotelId,
    bookingId: input.bookingId,
    guestId: input.guestId,
    roomUnitId: input.roomUnitId,
    currency: input.currency,
    staffId: input.staffId
  });

  const gross = normalizePaymentAmountForPost(round2(input.amount));
  const method = sanitizeFolioPaymentMethod(input.folioPaymentMethod);
  const ref = truncateOptional(input.referenceNumber, 120);
  const notes = truncateOptional(input.notes, 2000);
  const internalNote = truncateOptional(input.internalNote, 500);

  const paymentCreatedBy = optionalHotelUserId(input.staffId);
  const payment = await db.folioTransaction.create({
    data: {
      hotelId: input.hotelId,
      folioId,
      bookingId: input.bookingId,
      guestId: input.guestId,
      ...(roomUnitIdFk ? { roomUnitId: roomUnitIdFk } : {}),
      ...(roomTypeIdFk ? { roomTypeId: roomTypeIdFk } : {}),
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
      folioPaymentMethod: method,
      ...(ref ? { referenceNumber: ref } : {}),
      chargeDate: input.chargeDate,
      postedAt: new Date(),
      ...(notes ? { notes } : {}),
      ...(internalNote ? { internalNote } : {}),
      ...(paymentCreatedBy ? { createdByUserId: paymentCreatedBy } : {}),
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
  await assertBookingGuestMatchesFolio(db, input.hotelId, input.bookingId, input.guestId);
  const parent = await db.folioTransaction.findFirst({
    where: { id: input.parentTransactionId, hotelId: input.hotelId, bookingId: input.bookingId }
  });
  if (!parent) throw new Error("Parent transaction not found for this booking.");
  if (parent.voidedAt || parent.isVoided) throw new Error("Cannot refund a voided line.");

  const refundAmt = normalizePaymentAmountForPost(round2(input.amount));

  const priorRefunds = await db.folioTransaction.aggregate({
    where: {
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      parentTransactionId: parent.id,
      transactionType: FolioTransactionType.REFUND,
      voidedAt: null,
      isVoided: false
    },
    _sum: { grossAmount: true }
  });
  const alreadyRefunded = round2(priorRefunds._sum.grossAmount ?? 0);
  const refundableCap = round2(parent.grossAmount);
  if (round2(alreadyRefunded + refundAmt) > refundableCap) {
    throw new Error("Refund amount exceeds the remaining refundable amount for this line.");
  }

  const roomUnitIdFk = nonEmptyRelationId(input.roomUnitId);
  const roomTypeIdFk = nonEmptyRelationId(input.roomTypeId);
  const { folioId } = await ensureActiveFolio(db, {
    hotelId: input.hotelId,
    bookingId: input.bookingId,
    guestId: input.guestId,
    roomUnitId: input.roomUnitId,
    currency: input.currency,
    staffId: input.staffId
  });

  const refundCreatedBy = optionalHotelUserId(input.staffId);
  const ref = truncateOptional(input.referenceNumber, 120);
  const noteLine = truncateOptional(input.notes, 2000);
  return db.folioTransaction.create({
    data: {
      hotelId: input.hotelId,
      folioId,
      bookingId: input.bookingId,
      guestId: input.guestId,
      ...(roomUnitIdFk ? { roomUnitId: roomUnitIdFk } : {}),
      ...(roomTypeIdFk ? { roomTypeId: roomTypeIdFk } : {}),
      transactionType: FolioTransactionType.REFUND,
      ledgerKind: FolioLedgerKind.REFUND,
      revenueCategory: FolioRevenueCategory.OTHER,
      sourceType: FolioTxnSourceType.ADMIN_PANEL,
      outletCategory: FolioOutletCategory.OTHER,
      itemName: "Refund (linked)",
      description: noteLine ?? `Refund against ${parent.id}`,
      quantity: 1,
      unitPrice: refundAmt,
      grossAmount: refundAmt,
      taxAmount: 0,
      netAmount: refundAmt,
      discountAmount: 0,
      currency: input.currency,
      postingTarget: parent.postingTarget,
      folioPaymentStatus: FolioTxnPaymentStatus.REFUNDED,
      folioPaymentMethod: sanitizeFolioPaymentMethod(input.folioPaymentMethod ?? parent.folioPaymentMethod ?? "CASH"),
      ...(ref ? { referenceNumber: ref } : {}),
      chargeDate: input.chargeDate,
      postedAt: new Date(),
      parentTransactionId: parent.id,
      ...(refundCreatedBy ? { createdByUserId: refundCreatedBy } : {}),
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

  const voidActor = optionalHotelUserId(params.staffId);
  if (!voidActor) throw new Error("A valid staff user is required to void a folio line.");

  await db.folioTransaction.update({
    where: { id: params.transactionId },
    data: {
      voidedAt: new Date(),
      voidedByUserId: voidActor,
      voidReason: params.reason.trim().slice(0, 500),
      folioPaymentStatus: FolioTxnPaymentStatus.VOIDED,
      isVoided: true,
      updatedByUserId: voidActor
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
      voidedBy: { select: { fullName: true, email: true } },
      parentTransaction: { select: { id: true, transactionType: true, itemName: true } }
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

