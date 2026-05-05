import { FbOrderStatus, FbOutletType, FbServiceMode } from "@prisma/client";
import { prisma } from "../db";
import { createOutletTicketForFbOrder } from "./outletTickets";
import { notifyFbOrdersAfterCreate, type FbOrderLineSnap } from "./outletOrderNotify";

export type FbInvoiceLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

function outletLabel(t: string): string {
  return t === "COFFEE_SHOP" ? "Coffee shop" : "Restaurant";
}

function modeLabel(t: string): string {
  return t === "ROOM_SERVICE" ? "Room service" : "Dining in";
}

/** Posted F&B orders for a booking (folio charges). */
export async function getFbFolioForBooking(bookingId: string): Promise<{
  lines: FbInvoiceLine[];
  subtotal: number;
}> {
  const orders = await prisma.fbOrder.findMany({
    where: { bookingId, status: FbOrderStatus.POSTED },
    include: { lines: true },
    orderBy: { createdAt: "asc" }
  });
  const lines: FbInvoiceLine[] = [];
  let subtotal = 0;
  for (const order of orders) {
    const prefix = `${outletLabel(order.outletType)} · ${modeLabel(order.serviceMode)}`;
    for (const ln of order.lines) {
      lines.push({
        description: `${prefix} — ${ln.itemNameSnap}`,
        quantity: ln.quantity,
        unitPrice: ln.unitPrice,
        lineTotal: ln.lineTotal
      });
      subtotal += ln.lineTotal;
    }
  }
  return { lines, subtotal: Number(subtotal.toFixed(2)) };
}

export async function sumFbSubtotalForBooking(bookingId: string): Promise<number> {
  const { subtotal } = await getFbFolioForBooking(bookingId);
  return subtotal;
}

/**
 * Creates one posted F&amp;B order per outlet (restaurant vs coffee shop) so mixed selections still validate.
 * Sends one grouped WhatsApp per outlet and returns human-readable warnings if notify fails or is unconfigured.
 */
export async function createFbOrdersFromMenuLines(params: {
  hotelId: string;
  bookingId: string;
  guestId: string;
  serviceMode: FbServiceMode;
  notes: string | null;
  lines: { menuItemId: string; qty: number }[];
}): Promise<string[]> {
  const filtered = params.lines.filter((l) => l.qty >= 1);
  if (filtered.length === 0) throw new Error("No items selected.");

  const ids = [...new Set(filtered.map((l) => l.menuItemId))];
  const items = await prisma.menuItem.findMany({
    where: { id: { in: ids }, hotelId: params.hotelId, isActive: true }
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  const groups = new Map<
    FbOutletType,
    { menuItemId: string; itemNameSnap: string; quantity: number; unitPrice: number; lineTotal: number }[]
  >();

  for (const l of filtered) {
    const item = byId.get(l.menuItemId);
    if (!item) continue;
    const qty = Math.min(99, Math.max(1, Math.floor(l.qty)));
    const outletType = item.outletType;
    const arr = groups.get(outletType) ?? [];
    const idx = arr.findIndex((row) => row.menuItemId === item.id);
    if (idx >= 0) {
      const prev = arr[idx]!;
      const newQty = Math.min(99, prev.quantity + qty);
      arr[idx] = {
        ...prev,
        quantity: newQty,
        lineTotal: Number((prev.unitPrice * newQty).toFixed(2))
      };
    } else {
      const lineTotal = Number((item.unitPrice * qty).toFixed(2));
      arr.push({
        menuItemId: item.id,
        itemNameSnap: item.name,
        quantity: qty,
        unitPrice: item.unitPrice,
        lineTotal
      });
    }
    groups.set(outletType, arr);
  }

  if (groups.size === 0) throw new Error("No valid menu items.");

  const fbOrderIdByOutlet = new Map<FbOutletType, string>();
  const allFbOrderIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const [outletType, lineCreates] of groups) {
      if (lineCreates.length === 0) continue;
      const total = lineCreates.reduce((s, x) => s + x.lineTotal, 0);
      const order = await tx.fbOrder.create({
        data: {
          hotelId: params.hotelId,
          bookingId: params.bookingId,
          guestId: params.guestId,
          outletType,
          serviceMode: params.serviceMode,
          status: FbOrderStatus.POSTED,
          totalAmount: Number(total.toFixed(2)),
          notes: params.notes,
          lines: { create: lineCreates }
        }
      });
      fbOrderIdByOutlet.set(outletType, order.id);
      allFbOrderIds.push(order.id);
      await createOutletTicketForFbOrder(tx, {
        hotelId: params.hotelId,
        bookingId: params.bookingId,
        guestId: params.guestId,
        fbOrderId: order.id,
        outletType,
        serviceMode: params.serviceMode,
        notes: params.notes
      });
    }
  });

  const notifyGroups = new Map<FbOutletType, FbOrderLineSnap[]>();
  for (const [outletType, lineCreates] of groups) {
    notifyGroups.set(
      outletType,
      lineCreates.map((row) => ({
        itemNameSnap: row.itemNameSnap,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        lineTotal: row.lineTotal
      }))
    );
  }

  return notifyFbOrdersAfterCreate({
    hotelId: params.hotelId,
    bookingId: params.bookingId,
    serviceMode: params.serviceMode,
    notes: params.notes,
    groups: notifyGroups,
    chargeTime: new Date(),
    fbOrderIdByOutlet,
    allFbOrderIds
  });
}
