import type { Prisma } from "@prisma/client";
import {
  FbOutletType,
  FbServiceMode,
  FolioOutletCategory,
  FolioTransactionType,
  OutletTicketSource,
  OutletTicketStatus
} from "@prisma/client";
import { prisma } from "../db";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Same routing as outlet WhatsApp: only F&B / room service / activity folio lines get an internal ticket.
 */
export function folioChargeQualifiesForOutletTicket(
  transactionType: FolioTransactionType,
  outletCategory: FolioOutletCategory
): boolean {
  if (transactionType === FolioTransactionType.FNB_CHARGE) {
    return outletCategory === "CAFE" || outletCategory === "RESTAURANT";
  }
  if (transactionType === FolioTransactionType.ACTIVITY_CHARGE && outletCategory === "ACTIVITY") {
    return true;
  }
  if (
    transactionType === FolioTransactionType.OTHER_SERVICE_CHARGE &&
    outletCategory === "ROOM_SERVICE"
  ) {
    return true;
  }
  return false;
}

export function folioOutletKeyForTicket(outletCategory: FolioOutletCategory): string {
  return outletCategory;
}

export async function createOutletTicketForFbOrder(
  db: Db,
  params: {
    hotelId: string;
    bookingId: string;
    guestId: string;
    fbOrderId: string;
    outletType: FbOutletType;
    serviceMode: FbServiceMode;
    notes: string | null;
  }
): Promise<void> {
  await db.outletOrderTicket.create({
    data: {
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      guestId: params.guestId,
      source: OutletTicketSource.FB_MENU,
      fbOrderId: params.fbOrderId,
      outletKey: params.outletType,
      serviceMode: params.serviceMode,
      notes: params.notes,
      ticketStatus: OutletTicketStatus.NEW
    }
  });
}

export async function createOutletTicketForFolioCharge(
  db: Db,
  params: {
    hotelId: string;
    bookingId: string;
    guestId: string;
    folioTransactionId: string;
    outletCategory: FolioOutletCategory;
    notes: string | null;
  }
): Promise<void> {
  await db.outletOrderTicket.create({
    data: {
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      guestId: params.guestId,
      source: OutletTicketSource.FOLIO_CHARGE,
      folioTransactionId: params.folioTransactionId,
      outletKey: folioOutletKeyForTicket(params.outletCategory),
      serviceMode: null,
      notes: params.notes,
      ticketStatus: OutletTicketStatus.NEW
    }
  });
}

export async function cancelOutletTicketForFolioTransaction(
  db: Db,
  params: { hotelId: string; folioTransactionId: string }
): Promise<void> {
  await db.outletOrderTicket.updateMany({
    where: {
      hotelId: params.hotelId,
      folioTransactionId: params.folioTransactionId,
      ticketStatus: { not: OutletTicketStatus.CANCELLED }
    },
    data: { ticketStatus: OutletTicketStatus.CANCELLED }
  });
}

/** Record WhatsApp notify outcome on the matching ticket(s) for dashboard display. */
export async function markOutletTicketsWhatsappNotify(
  db: Db,
  params: {
    hotelId: string;
    fbOrderIds?: string[];
    folioTransactionId?: string | null;
    ok: boolean;
    detail: string | null;
  }
): Promise<void> {
  const now = new Date();
  const detail = params.detail ? params.detail.slice(0, 500) : null;
  const data = {
    whatsappNotifyAt: now,
    whatsappNotifyOk: params.ok,
    whatsappNotifyDetail: detail
  };
  if (params.folioTransactionId) {
    await db.outletOrderTicket.updateMany({
      where: { hotelId: params.hotelId, folioTransactionId: params.folioTransactionId },
      data
    });
    return;
  }
  if (params.fbOrderIds && params.fbOrderIds.length > 0) {
    await db.outletOrderTicket.updateMany({
      where: { hotelId: params.hotelId, fbOrderId: { in: params.fbOrderIds } },
      data
    });
  }
}
