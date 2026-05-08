import type { Prisma } from "@prisma/client";
import {
  FbOutletType,
  FbServiceMode,
  FolioOutletCategory,
  FolioTransactionType,
  OutletTicketSource,
  OutletTicketStatus,
  UserRole
} from "@prisma/client";
import { prisma } from "../db";
import { createRoleRoutedNotification, type NotificationSeverity } from "./notifications";

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

/**
 * Fire an in-app notification for restaurant / café / room-service / activity staff when a
 * new outlet ticket lands on the operational board. Reuses {@link createRoleRoutedNotification}
 * (no new persistence path) so the existing bell + Today » Alert center surface light up
 * automatically. Safe to fail silently — outlet ticket creation must never be blocked by a
 * notification-delivery hiccup.
 */
function outletTicketLabel(outletKey: string): string {
  switch (outletKey) {
    case "RESTAURANT":
      return "Restaurant";
    case "CAFE":
    case "COFFEE_SHOP":
      return "Café";
    case "ROOM_SERVICE":
      return "Room service";
    case "ACTIVITY":
      return "Activity";
    default:
      return outletKey.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export async function notifyOutletTicketCreated(params: {
  hotelId: string;
  bookingId: string;
  ticketId?: string;
  outletKey: string;
  serviceMode?: FbServiceMode | null;
  notes?: string | null;
  guestLabel?: string | null;
  roomLabel?: string | null;
}): Promise<void> {
  const outletLabel = outletTicketLabel(params.outletKey);
  const isRoomService =
    params.outletKey === "ROOM_SERVICE" ||
    params.serviceMode === FbServiceMode.ROOM_SERVICE;
  const channelHint = params.serviceMode === FbServiceMode.DINING_IN ? "dining in" : isRoomService ? "room service" : "outlet";
  const title = `New ${outletLabel} order · ${channelHint}`;
  const subjectBits: string[] = [];
  if (params.roomLabel) subjectBits.push(`Room ${params.roomLabel}`);
  if (params.guestLabel) subjectBits.push(params.guestLabel);
  const subjectLine = subjectBits.length ? subjectBits.join(" · ") : "Guest order";
  const trimmedNotes = (params.notes ?? "").trim().slice(0, 220);
  const body = trimmedNotes ? `${subjectLine} — ${trimmedNotes}` : `${subjectLine} — open the outlet board to acknowledge.`;
  const severity: NotificationSeverity = isRoomService ? "high" : "normal";
  await createRoleRoutedNotification({
    hotelId: params.hotelId,
    roles: [UserRole.MANAGER, UserRole.OWNER, "RESTAURANT" as UserRole],
    title,
    body,
    category: "restaurant",
    severity,
    link: "/admin/outlet-orders",
    sourceType: "OUTLET_TICKET_CREATED",
    sourceId: params.ticketId ?? params.bookingId,
    requiresAttention: true,
    audience: ["restaurant", "owner"]
  }).catch(() => undefined);
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
