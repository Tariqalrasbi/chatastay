import {
  FbOutletType,
  FbServiceMode,
  FolioOutletCategory,
  FolioTransactionType
} from "@prisma/client";
import { prisma } from "../db";
import { displayBookingReference } from "./bookingReference";
import { markOutletTicketsWhatsappNotify } from "./outletTickets";
import { loadPartnerSetupConfig, type PartnerSetupConfig } from "./partnerSetup";
import { trySendWhatsAppText } from "../whatsapp/send";

export type FbOrderLineSnap = {
  itemNameSnap: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

function digitsOnly(input: string): string {
  return input.replace(/\D/g, "");
}

function fmtMoney(n: number, currency: string): string {
  return `${n.toFixed(2)} ${currency}`;
}

function fbOutletLabel(t: FbOutletType): string {
  return t === "COFFEE_SHOP" ? "Coffee shop / Café" : "Restaurant / Kitchen";
}

function serviceModeLabel(m: FbServiceMode): string {
  return m === "ROOM_SERVICE" ? "Room service" : "Dining in";
}

function folioCategoryLabel(c: FolioOutletCategory): string {
  switch (c) {
    case "RESTAURANT":
      return "Restaurant";
    case "CAFE":
      return "Café";
    case "ROOM_SERVICE":
      return "Room service";
    case "ACTIVITY":
      return "Activity";
    default:
      return "Other";
  }
}

type OutletKind = "RESTAURANT" | "COFFEE_SHOP" | "ROOM_SERVICE" | "ACTIVITY";

function resolveOutletPhone(cfg: PartnerSetupConfig, kind: OutletKind): string {
  const raw =
    kind === "RESTAURANT"
      ? cfg.outletRestaurantWhatsAppE164
      : kind === "COFFEE_SHOP"
        ? cfg.outletCoffeeShopWhatsAppE164
        : kind === "ROOM_SERVICE"
          ? cfg.outletRoomServiceWhatsAppE164 || cfg.outletRestaurantWhatsAppE164
          : cfg.outletActivityWhatsAppE164;
  return digitsOnly(raw ?? "");
}

/** Dedicated room-service line only (no fallback). Used to decide single combined RS ticket vs per-outlet. */
function resolveRoomServiceDedicatedPhone(cfg: PartnerSetupConfig): string {
  return digitsOnly(cfg.outletRoomServiceWhatsAppE164 ?? "");
}

function fbOutletToKind(t: FbOutletType): OutletKind {
  return t === "COFFEE_SHOP" ? "COFFEE_SHOP" : "RESTAURANT";
}

async function auditOutletNotify(params: {
  hotelId: string;
  bookingId: string | null;
  action: "OUTLET_WHATSAPP_SENT" | "OUTLET_WHATSAPP_FAILED" | "OUTLET_WHATSAPP_SKIPPED";
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        hotelId: params.hotelId,
        actorEmail: "outlet-notify@system",
        action: params.action,
        entityType: "OutletNotify",
        entityId: params.bookingId ?? undefined,
        bookingId: params.bookingId ?? undefined,
        metadataJson: JSON.stringify(params.metadata)
      }
    });
  } catch (e) {
    console.error("[outletOrderNotify] audit log failed", e);
  }
}

function buildFbOrderBody(params: {
  hotelName: string;
  outletTitle: string;
  bookingRef: string;
  guestName: string;
  roomUnit: string;
  serviceMode: FbServiceMode;
  notes: string | null;
  lines: FbOrderLineSnap[];
  currency: string;
  chargeTime: Date;
}): string {
  const timeStr = params.chargeTime.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const lineBlock = params.lines
    .map(
      (l) =>
        `• ${l.quantity}× ${l.itemNameSnap} @ ${fmtMoney(l.unitPrice, params.currency)} → ${fmtMoney(l.lineTotal, params.currency)}`
    )
    .join("\n");
  const total = params.lines.reduce((s, l) => s + l.lineTotal, 0);
  const notesLine = params.notes?.trim() ? params.notes.trim() : "—";
  return [
    `NEW ORDER — ${params.outletTitle}`,
    params.hotelName,
    `Ref: ${params.bookingRef} | Guest: ${params.guestName}`,
    `Room/Unit: ${params.roomUnit}`,
    `Service: ${serviceModeLabel(params.serviceMode)}`,
    `Posted: ${timeStr}`,
    "",
    lineBlock,
    "",
    `Total: ${fmtMoney(total, params.currency)}`,
    `Notes: ${notesLine}`
  ].join("\n");
}

/**
 * After F&amp;B menu orders are committed: one WhatsApp per outlet batch (grouped posting).
 * Room service + dedicated RS WhatsApp in Partner Setup → one combined message to that number (all outlets on one ticket).
 */
export async function notifyFbOrdersAfterCreate(params: {
  hotelId: string;
  bookingId: string;
  serviceMode: FbServiceMode;
  notes: string | null;
  groups: Map<FbOutletType, FbOrderLineSnap[]>;
  chargeTime: Date;
  /** Set when menu orders were just created — updates ticket WhatsApp fields. */
  fbOrderIdByOutlet?: Map<FbOutletType, string>;
  allFbOrderIds?: string[];
}): Promise<string[]> {
  try {
    return await notifyFbOrdersAfterCreateInner(params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[outletOrderNotify] notifyFbOrdersAfterCreate", e);
    return [`Outlet notification error (order saved): ${msg.slice(0, 280)}`];
  }
}

async function notifyFbOrdersAfterCreateInner(params: {
  hotelId: string;
  bookingId: string;
  serviceMode: FbServiceMode;
  notes: string | null;
  groups: Map<FbOutletType, FbOrderLineSnap[]>;
  chargeTime: Date;
  fbOrderIdByOutlet?: Map<FbOutletType, string>;
  allFbOrderIds?: string[];
}): Promise<string[]> {
  const warnings: string[] = [];
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, hotelId: params.hotelId },
    include: {
      guest: true,
      roomUnit: { include: { roomType: true } },
      hotel: { select: { displayName: true } }
    }
  });
  if (!booking) {
    warnings.push("Outlet WhatsApp skipped: booking not found after order save.");
    return warnings;
  }

  const cfg = loadPartnerSetupConfig(params.hotelId);
  const bookingRef = displayBookingReference(booking);
  const guestName = booking.guest.fullName?.trim() || booking.guest.phoneE164 || "Guest";
  const roomUnit =
    booking.roomUnit?.name?.trim() && booking.roomUnit.roomType?.name
      ? `${booking.roomUnit.name} (${booking.roomUnit.roomType.name})`
      : booking.roomUnit?.name?.trim() || "—";
  const currency = booking.currency;

  /** Combined room-service ticket: one WhatsApp when RS number is set and mode is room service. */
  if (params.serviceMode === FbServiceMode.ROOM_SERVICE) {
    const rsDedicated = resolveRoomServiceDedicatedPhone(cfg);
    const combined: FbOrderLineSnap[] = [];
    for (const [outletType, lines] of params.groups) {
      for (const l of lines) {
        combined.push({
          ...l,
          itemNameSnap: `${fbOutletLabel(outletType)} — ${l.itemNameSnap}`
        });
      }
    }
    if (rsDedicated && combined.length > 0) {
      const body = buildFbOrderBody({
        hotelName: booking.hotel.displayName,
        outletTitle: "Room service (all outlets)",
        bookingRef,
        guestName,
        roomUnit,
        serviceMode: params.serviceMode,
        notes: params.notes,
        lines: combined,
        currency,
        chargeTime: params.chargeTime
      });
      const send = await trySendWhatsAppText({
        to: rsDedicated,
        body,
        phoneNumberId: cfg.whatsappPhoneNumberId || undefined,
        conversationId: booking.conversationId ?? undefined
      });
      if (!send.ok) {
        await auditOutletNotify({
          hotelId: params.hotelId,
          bookingId: params.bookingId,
          action: "OUTLET_WHATSAPP_FAILED",
          metadata: {
            mode: "room_service_combined",
            error: send.errorMessage,
            bookingRef,
            lineCount: combined.length
          }
        });
        warnings.push(`Room service (combined) WhatsApp failed: ${send.errorMessage}`);
        if (params.allFbOrderIds?.length) {
          await markOutletTicketsWhatsappNotify(prisma, {
            hotelId: params.hotelId,
            fbOrderIds: params.allFbOrderIds,
            ok: false,
            detail: send.errorMessage
          });
        }
      } else {
        await auditOutletNotify({
          hotelId: params.hotelId,
          bookingId: params.bookingId,
          action: "OUTLET_WHATSAPP_SENT",
          metadata: {
            mode: "room_service_combined",
            bookingRef,
            lineCount: combined.length,
            toSuffix: rsDedicated.slice(-4)
          }
        });
        if (params.allFbOrderIds?.length) {
          await markOutletTicketsWhatsappNotify(prisma, {
            hotelId: params.hotelId,
            fbOrderIds: params.allFbOrderIds,
            ok: true,
            detail: null
          });
        }
      }
      return warnings;
    }
  }

  for (const [outletType, lines] of params.groups) {
    if (!lines.length) continue;
    const kind = fbOutletToKind(outletType);
    const to = resolveOutletPhone(cfg, kind);
    const outletTitle = fbOutletLabel(outletType);

    if (!to) {
      await auditOutletNotify({
        hotelId: params.hotelId,
        bookingId: params.bookingId,
        action: "OUTLET_WHATSAPP_SKIPPED",
        metadata: { reason: "no_destination", outlet: outletType, bookingRef }
      });
      warnings.push(
        `${outletTitle}: no WhatsApp number in Partner Setup → outlet notifications. Staff were not messaged.`
      );
      const oid = params.fbOrderIdByOutlet?.get(outletType);
      if (oid) {
        await markOutletTicketsWhatsappNotify(prisma, {
          hotelId: params.hotelId,
          fbOrderIds: [oid],
          ok: false,
          detail: "No WhatsApp number in Partner Setup (outlet notifications)."
        });
      }
      continue;
    }

    const body = buildFbOrderBody({
      hotelName: booking.hotel.displayName,
      outletTitle,
      bookingRef,
      guestName,
      roomUnit,
      serviceMode: params.serviceMode,
      notes: params.notes,
      lines,
      currency,
      chargeTime: params.chargeTime
    });

    const send = await trySendWhatsAppText({
      to,
      body,
      phoneNumberId: cfg.whatsappPhoneNumberId || undefined,
      conversationId: booking.conversationId ?? undefined
    });

    if (!send.ok) {
      await auditOutletNotify({
        hotelId: params.hotelId,
        bookingId: params.bookingId,
        action: "OUTLET_WHATSAPP_FAILED",
        metadata: { outlet: outletType, toSuffix: to.slice(-4), error: send.errorMessage, bookingRef }
      });
      warnings.push(`${outletTitle} WhatsApp failed: ${send.errorMessage}`);
      const oid = params.fbOrderIdByOutlet?.get(outletType);
      if (oid) {
        await markOutletTicketsWhatsappNotify(prisma, {
          hotelId: params.hotelId,
          fbOrderIds: [oid],
          ok: false,
          detail: send.errorMessage
        });
      }
    } else {
      await auditOutletNotify({
        hotelId: params.hotelId,
        bookingId: params.bookingId,
        action: "OUTLET_WHATSAPP_SENT",
        metadata: { outlet: outletType, toSuffix: to.slice(-4), bookingRef, lineCount: lines.length }
      });
      const oid = params.fbOrderIdByOutlet?.get(outletType);
      if (oid) {
        await markOutletTicketsWhatsappNotify(prisma, {
          hotelId: params.hotelId,
          fbOrderIds: [oid],
          ok: true,
          detail: null
        });
      }
    }
  }

  return warnings;
}

function mapFolioToOutletKind(
  transactionType: FolioTransactionType,
  outletCategory: FolioOutletCategory
): OutletKind | null {
  if (transactionType === FolioTransactionType.FNB_CHARGE) {
    if (outletCategory === "CAFE") return "COFFEE_SHOP";
    if (outletCategory === "RESTAURANT") return "RESTAURANT";
    return null;
  }
  if (transactionType === FolioTransactionType.ACTIVITY_CHARGE && outletCategory === "ACTIVITY") {
    return "ACTIVITY";
  }
  if (
    transactionType === FolioTransactionType.OTHER_SERVICE_CHARGE &&
    outletCategory === "ROOM_SERVICE"
  ) {
    return "ROOM_SERVICE";
  }
  return null;
}

function buildFolioChargeBody(params: {
  hotelName: string;
  outletLabel: string;
  bookingRef: string;
  guestName: string;
  roomUnit: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  currency: string;
  notes: string | null;
  chargeTime: Date;
}): string {
  const timeStr = params.chargeTime.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const notesLine = params.notes?.trim() ? params.notes.trim() : "—";
  return [
    `FOLIO CHARGE — ${params.outletLabel}`,
    params.hotelName,
    `Ref: ${params.bookingRef} | Guest: ${params.guestName}`,
    `Room/Unit: ${params.roomUnit}`,
    `Posted: ${timeStr}`,
    "",
    `${params.quantity}× ${params.itemName}`,
    `@ ${fmtMoney(params.unitPrice, params.currency)} → ${fmtMoney(params.lineTotal, params.currency)}`,
    `Notes: ${notesLine}`
  ].join("\n");
}

/**
 * Single folio line posted from room-unit ledger (F&amp;B / room service / activity).
 */
export async function notifyOutletForFolioCharge(params: {
  hotelId: string;
  bookingId: string;
  transactionType: FolioTransactionType;
  outletCategory: FolioOutletCategory;
  itemName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  currency: string;
  notes: string | null;
  chargeTime: Date;
  /** When set, WhatsApp outcome is stored on the matching outlet ticket row. */
  folioTransactionId?: string | null;
}): Promise<string | null> {
  const kind = mapFolioToOutletKind(params.transactionType, params.outletCategory);
  if (!kind) return null;

  try {
    return await notifyOutletForFolioChargeInner(params, kind);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[outletOrderNotify] notifyOutletForFolioCharge", e);
    return `Outlet notification error (charge saved): ${msg.slice(0, 280)}`;
  }
}

async function notifyOutletForFolioChargeInner(
  params: {
    hotelId: string;
    bookingId: string;
    transactionType: FolioTransactionType;
    outletCategory: FolioOutletCategory;
    itemName: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    currency: string;
    notes: string | null;
    chargeTime: Date;
    folioTransactionId?: string | null;
  },
  kind: OutletKind
): Promise<string | null> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, hotelId: params.hotelId },
    include: {
      guest: true,
      roomUnit: { include: { roomType: true } },
      hotel: { select: { displayName: true } }
    }
  });
  if (!booking) return "Outlet WhatsApp skipped: booking not found.";

  const cfg = loadPartnerSetupConfig(params.hotelId);
  const to = resolveOutletPhone(cfg, kind);
  const outletLabel = folioCategoryLabel(params.outletCategory);

  if (!to) {
    await auditOutletNotify({
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      action: "OUTLET_WHATSAPP_SKIPPED",
      metadata: { reason: "no_destination", folioKind: kind, bookingRef: displayBookingReference(booking) }
    });
    if (params.folioTransactionId) {
      await markOutletTicketsWhatsappNotify(prisma, {
        hotelId: params.hotelId,
        folioTransactionId: params.folioTransactionId,
        ok: false,
        detail: "No outlet WhatsApp number in Partner Setup."
      });
    }
    return `${outletLabel}: no outlet WhatsApp in Partner Setup — staff not notified.`;
  }

  const bookingRef = displayBookingReference(booking);
  const guestName = booking.guest.fullName?.trim() || booking.guest.phoneE164 || "Guest";
  const roomUnit =
    booking.roomUnit?.name?.trim() && booking.roomUnit.roomType?.name
      ? `${booking.roomUnit.name} (${booking.roomUnit.roomType.name})`
      : booking.roomUnit?.name?.trim() || "—";

  const body = buildFolioChargeBody({
    hotelName: booking.hotel.displayName,
    outletLabel,
    bookingRef,
    guestName,
    roomUnit,
    itemName: params.itemName,
    quantity: params.quantity,
    unitPrice: params.unitPrice,
    lineTotal: params.lineTotal,
    currency: params.currency,
    notes: params.notes,
    chargeTime: params.chargeTime
  });

  const send = await trySendWhatsAppText({
    to,
    body,
    phoneNumberId: cfg.whatsappPhoneNumberId || undefined,
    conversationId: booking.conversationId ?? undefined
  });

  if (!send.ok) {
    await auditOutletNotify({
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      action: "OUTLET_WHATSAPP_FAILED",
      metadata: { folioKind: kind, error: send.errorMessage, bookingRef }
    });
    if (params.folioTransactionId) {
      await markOutletTicketsWhatsappNotify(prisma, {
        hotelId: params.hotelId,
        folioTransactionId: params.folioTransactionId,
        ok: false,
        detail: send.errorMessage
      });
    }
    return `${outletLabel} WhatsApp failed: ${send.errorMessage}`;
  }

  await auditOutletNotify({
    hotelId: params.hotelId,
    bookingId: params.bookingId,
    action: "OUTLET_WHATSAPP_SENT",
    metadata: { folioKind: kind, bookingRef, item: params.itemName }
  });
  if (params.folioTransactionId) {
    await markOutletTicketsWhatsappNotify(prisma, {
      hotelId: params.hotelId,
      folioTransactionId: params.folioTransactionId,
      ok: true,
      detail: null
    });
  }
  return null;
}
