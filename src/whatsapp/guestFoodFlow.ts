import { FbServiceMode } from "@prisma/client";
import { prisma } from "../db";
import { hotelTimezoneOrUtc, readWallClockInZone } from "../core/guestMessagingSchedule";
import { isBookingCalendarActiveOnDate, isGuestEffectivelyCheckedIn } from "../core/guestStayPresence";
import type { FbCartDraftState, FbCartLine, FbCartPurpose } from "./foodTypes";
import { buildResolvedMenuItemMap, findCategoryById, getAbrCategories, menuItemKey } from "./menuCatalog";
import { isWithinRestaurantWindows, validateMealServiceTime } from "./restaurantHours";

export type { FbCartDraftState, FbCartLine } from "./foodTypes";

export type FoodFlowOutbound =
  | { kind: "text"; body: string }
  | {
      kind: "list";
      body: string;
      buttonText: string;
      sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
    }
  | { kind: "buttons"; body: string; buttons: Array<{ id: string; title: string }> };

export type FoodFlowAdvanceResult = {
  draft: FbCartDraftState | null;
  outbound: FoodFlowOutbound[];
  prebookFinished?: { lines: { menuItemId: string; qty: number }[]; serviceMode: FbServiceMode; timeNote: string };
  stayFinished?: { bookingId: string; lines: { menuItemId: string; qty: number }[]; serviceMode: FbServiceMode; timeNote: string };
  viewFinished?: boolean;
};

function isBack(t: string): boolean {
  const x = t.trim().toLowerCase();
  return x === "back" || x === "*back*";
}

/**
 * Confirmed stay overlapping "today" on the hotel calendar (inclusive check-in through check-out date).
 */
export async function findGuestActiveStayBooking(hotelId: string, guestId: string, hotelTimezone?: string | null) {
  const tz = hotelTimezoneOrUtc(hotelTimezone);
  const asOf = new Date();
  const rows = await prisma.booking.findMany({
    where: { hotelId, guestId, status: { in: ["CONFIRMED", "CHECKED_IN"] } },
    include: { roomUnit: { select: { id: true, name: true, notes: true } } },
    orderBy: { checkIn: "desc" },
    take: 24
  });
  for (const b of rows) {
    if (!isBookingCalendarActiveOnDate(b.checkIn, b.checkOut, tz, asOf)) continue;
    return b;
  }
  return null;
}

/** In-house guest: active stay + (welcome sent or room board OCCUPIED). */
export async function findGuestInHouseForServices(hotelId: string, guestId: string, hotelTimezone?: string | null) {
  const tz = hotelTimezoneOrUtc(hotelTimezone);
  const asOf = new Date();
  const rows = await prisma.booking.findMany({
    where: { hotelId, guestId, status: { in: ["CONFIRMED", "CHECKED_IN"] } },
    include: { roomUnit: { select: { id: true, name: true, notes: true } } },
    orderBy: { checkIn: "desc" },
    take: 24
  });
  for (const b of rows) {
    if (!isBookingCalendarActiveOnDate(b.checkIn, b.checkOut, tz, asOf)) continue;
    if (!isGuestEffectivelyCheckedIn({ ...b, status: b.status })) continue;
    return b;
  }
  return null;
}

/** WhatsApp meal-plan picker: prominent header + list (reuse everywhere booking asks for meal plan). */
export function buildMealPlanSelectionOutbounds(lang: "en" | "ar"): FoodFlowOutbound[] {
  const ar = lang === "ar";
  const header: FoodFlowOutbound = {
    kind: "text",
    body: ar
      ? "🍽 *باقة الوجبات*\nاختر واحدة من القائمة التالية (اضغط *اختيار الباقة*)."
      : "🍽 *Meal plan*\nChoose one option below (tap *Choose plan*)."
  };
  const list: FoodFlowOutbound = {
    kind: "list",
    body: ar ? "اختر خطة الوجبات الآن:" : "Choose your meal plan:",
    buttonText: ar ? "اختيار الباقة" : "Choose plan",
    sections: [
      {
        title: ar ? "باقات الوجبات" : "Meal packages",
        rows: [
          { id: "mp_none", title: ar ? "غرفة فقط" : "Room only", description: ar ? "بدون وجبات" : "Room rate only" },
          { id: "mp_bf", title: ar ? "إفطار" : "Breakfast", description: ar ? "فطور يومي" : "Daily breakfast" },
          { id: "mp_half", title: ar ? "نصف إقامة" : "Half board", description: ar ? "فطور + عشاء" : "Breakfast + dinner" },
          { id: "mp_full", title: ar ? "إقامة كاملة" : "Full board", description: ar ? "جميع الوجبات" : "All main meals" }
        ]
      }
    ]
  };
  return [header, list];
}

export function isStayFoodIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 140) return false;
  if (/\?/.test(t) && !/\b(order|menu|room service|dining)\b/i.test(t)) return false;
  return (
    /\b(menu|food|drinks?|order food|room service|dinner|lunch|breakfast|coffee|restaurant|hungry)\b/i.test(t) ||
    t === "browse_menu" ||
    t === "order_food"
  );
}

const PREFIX_CAT = "fb_cat_";
const PREFIX_ITEM = "fb_item_";

export function initialFbOrderList(purpose: FbCartPurpose): FoodFlowOutbound {
  return buildCategoryList(purpose);
}

function buildCategoryList(purpose: FbCartPurpose): FoodFlowOutbound {
  const categoryRows = getAbrCategories().map((c) => ({
    id: `${PREFIX_CAT}${c.id}`,
    title: c.label.slice(0, 24),
    description: `${c.items.length} items`.slice(0, 72)
  }));
  const rows = purpose === "meal_plan_view" || purpose === "browse_only" ? categoryRows.slice(0, 9) : categoryRows.slice(0, 10);
  if (purpose === "meal_plan_view") {
    rows.push({ id: "fb_view_done", title: "Back to meal plans", description: "Return" });
  } else if (purpose === "browse_only") {
    rows.push({ id: "fb_view_done", title: "Close menu", description: "Return to main services" });
  }
  const body =
    purpose === "meal_plan_view"
      ? "Browse our menu by category. When finished, tap *Back to meal plans*."
      : purpose === "browse_only"
        ? "Browse the restaurant and cafe menu by category. Tap *Close menu* when finished."
      : "Pick a category:";
  return {
    kind: "list",
    body,
    buttonText: purpose === "meal_plan_view" || purpose === "browse_only" ? "Menu" : "Categories",
    sections: [{ title: "ABR menu", rows }]
  };
}

function buildItemList(
  categoryId: string,
  resolved: Map<string, { id: string; unitPrice: number; name: string }>,
  currency: string
): FoodFlowOutbound | null {
  const cat = findCategoryById(categoryId);
  if (!cat) return null;
  const rows: Array<{ id: string; title: string; description?: string }> = [];
  for (const ref of cat.items) {
    const key = menuItemKey(ref.outletType, ref.name);
    const hit = resolved.get(key);
    if (!hit) continue;
    rows.push({
      id: `${PREFIX_ITEM}${hit.id}`,
      title: hit.name.slice(0, 24),
      description: `${hit.unitPrice.toFixed(2)} ${currency}`.slice(0, 72)
    });
  }
  if (rows.length === 0) {
    return {
      kind: "text",
      body: `No priced items are loaded for *${cat.label}* yet. Try another category or contact reception.`
    };
  }
  return {
    kind: "list",
    body: `*${cat.label}* — tap an item:`,
    buttonText: "Items",
    sections: [{ title: cat.label.slice(0, 24), rows: rows.slice(0, 10) }]
  };
}

function parseQty(text: string): number | null {
  const m = text.trim().match(/^([1-9]\d?)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 99 ? n : null;
}

function parseService(text: string): FbServiceMode | null {
  const t = text.trim();
  if (t.includes("fb_svc_rs")) return "ROOM_SERVICE";
  if (t.includes("fb_svc_di")) return "DINING_IN";
  return null;
}

function parseTimeNote(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (t.includes("fb_time_asap") || t === "asap" || t === "now") return "ASAP";
  const listHm = text.match(/fb_tm_(\d{2})(\d{2})/i);
  if (listHm) {
    const h = parseInt(listHm[1], 10);
    const m = parseInt(listHm[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(t)) return t;
  return null;
}

function formatHmFromMinutes(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const mm = minutesFromMidnight % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** WhatsApp list: tap quantity beside the dish (×1…×10); 11+ still via typed number. */
function buildQuantityPickerList(params: { itemName: string; currency: string; unitPrice: number }): FoodFlowOutbound {
  const rows: Array<{ id: string; title: string; description?: string }> = [];
  for (let n = 1; n <= 10; n++) {
    const lineTotal = (params.unitPrice * n).toFixed(2);
    rows.push({
      id: `fb_qty_${n}`,
      title: `×${n}`.slice(0, 24),
      description: `${params.itemName} · ${lineTotal} ${params.currency}`.slice(0, 72)
    });
  }
  return {
    kind: "list",
    body: `How many *${params.itemName}*? Tap a quantity in the list (same step as the dish). For *11 or more*, reply with a number only.`,
    buttonText: "Quantity",
    sections: [{ title: "Portions", rows }]
  };
}

/** Scrollable time slots (15 min) + ASAP; optional last row to type HH:MM. */
function buildTimePickerList(params: { hotelTimezone: string; now: Date; serviceMode: FbServiceMode }): FoodFlowOutbound {
  const tz = params.hotelTimezone;
  const { minOfDay } = readWallClockInZone(params.now, tz);
  let cur = Math.ceil(minOfDay / 15) * 15;
  if (cur <= minOfDay) cur += 15;

  const rows: Array<{ id: string; title: string; description?: string }> = [
    { id: "fb_time_asap", title: "ASAP / Now", description: "As soon as possible" }
  ];

  const maxSlots = 8;
  let added = 0;
  while (added < maxSlots && cur < 24 * 60) {
    if (params.serviceMode === "ROOM_SERVICE" || isWithinRestaurantWindows(cur)) {
      const hm = formatHmFromMinutes(cur);
      rows.push({
        id: `fb_tm_${hm.replace(":", "")}`,
        title: hm,
        description: params.serviceMode === "DINING_IN" ? "Restaurant (hotel time)" : "Hotel local time"
      });
      added += 1;
    }
    cur += 15;
  }

  if (rows.length < 10) {
    rows.push({
      id: "fb_time_custom",
      title: "Other time…",
      description: "Reply next message as HH:MM"
    });
  }

  const body =
    params.serviceMode === "DINING_IN"
      ? "When should we serve? *Restaurant dining*: lunch *12:00–15:00*, dinner *18:30–22:00* (hotel time). Scroll the list and tap a time."
      : "When should we prepare or deliver? Scroll the list and tap a time (hotel local).";

  return {
    kind: "list",
    body,
    buttonText: "Pick time",
    sections: [{ title: "Time", rows: rows.slice(0, 10) }]
  };
}

function parseQtyReply(raw: string): number | null {
  const t = raw.trim();
  const m = t.match(/fb_qty_(\d{1,2})/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 10) return n;
  }
  return parseQty(t);
}

function cartSummaryLines(cart: FbCartLine[], currency: string): string {
  return cart
    .map((l) => `• ${l.name} ×${l.qty} — ${(l.unitPrice * l.qty).toFixed(2)} ${currency}`)
    .join("\n");
}

function cartSubtotal(cart: FbCartLine[]): number {
  return cart.reduce((s, l) => s + l.unitPrice * l.qty, 0);
}

function mergeCartLinesByMenuItemId(cart: FbCartLine[]): FbCartLine[] {
  const m = new Map<string, FbCartLine>();
  for (const l of cart) {
    const cur = m.get(l.menuItemId);
    if (cur) m.set(l.menuItemId, { ...cur, qty: Math.min(99, cur.qty + l.qty) });
    else m.set(l.menuItemId, { ...l });
  }
  return [...m.values()];
}

function cartSummaryWithSubtotal(cart: FbCartLine[], currency: string): string {
  const lines = cartSummaryLines(cart, currency);
  const sub = cartSubtotal(cart);
  return `${lines}\n\n*Subtotal:* ${sub.toFixed(2)} ${currency}`;
}

export async function advanceFbCartDraft(params: {
  hotelId: string;
  currency: string;
  text: string;
  draft: FbCartDraftState;
  /** Hotel IANA timezone for dining-hour checks (e.g. Asia/Muscat). */
  hotelTimezone?: string;
  now?: Date;
}): Promise<FoodFlowAdvanceResult> {
  const { hotelId, currency, text } = params;
  const hotelTz = params.hotelTimezone ?? "Asia/Muscat";
  const nowClock = params.now ?? new Date();
  const resolved = await buildResolvedMenuItemMap(hotelId);
  let draft: FbCartDraftState = {
    ...params.draft,
    cart: params.draft.cart.map((c) => ({ ...c }))
  };
  const raw = text.trim();

  // --- browse-only (meal plan "View menu" or standalone guest menu stream) ---
  if (draft.purpose === "meal_plan_view" || draft.purpose === "browse_only") {
    if (raw === "fb_view_done" || raw.includes("fb_view_done")) {
      return { draft: null, outbound: [], viewFinished: true };
    }
    if (isBack(raw)) {
      if (draft.step === "item") {
        draft = { ...draft, step: "category", categoryId: undefined };
        return { draft, outbound: [buildCategoryList(draft.purpose === "browse_only" ? "browse_only" : "meal_plan_view")] };
      }
      return { draft: null, outbound: [], viewFinished: true };
    }
    if (draft.step === "category" && raw.startsWith(PREFIX_CAT)) {
      const id = raw.slice(PREFIX_CAT.length);
      const list = buildItemList(id, resolved, currency);
      if (!list) return { draft, outbound: [{ kind: "text", body: "Unknown category." }] };
      if (list.kind === "text") return { draft, outbound: [list] };
      draft = { ...draft, step: "item", categoryId: id };
      return { draft, outbound: [list] };
    }
    if (draft.step === "item" && raw.startsWith(PREFIX_ITEM)) {
      const menuItemId = raw.slice(PREFIX_ITEM.length);
      const row = await prisma.menuItem.findFirst({
        where: { id: menuItemId, hotelId },
        select: { name: true, unitPrice: true }
      });
      if (!row) return { draft, outbound: [{ kind: "text", body: "Item not found." }] };
      const browsePurpose = draft.purpose === "browse_only" ? "browse_only" : "meal_plan_view";
      return {
        draft: { ...draft, step: "category", categoryId: undefined },
        outbound: [
          { kind: "text", body: `*${row.name}* — ${row.unitPrice.toFixed(2)} ${currency}` },
          buildCategoryList(browsePurpose)
        ]
      };
    }
    return { draft, outbound: [buildCategoryList(draft.purpose === "browse_only" ? "browse_only" : "meal_plan_view")] };
  }

  if (draft.purpose === "stay" && draft.stayBookingId) {
    const stayBooking = await prisma.booking.findUnique({
      where: { id: draft.stayBookingId },
      select: { mealPlan: true }
    });
    const mp = String(stayBooking?.mealPlan ?? "NONE").toUpperCase();
    if (mp === "HALF_BOARD" || mp === "FULL_BOARD") {
      const blocksCustom =
        raw.startsWith(PREFIX_CAT) || raw.startsWith(PREFIX_ITEM) || raw.includes("fb_add_yes");
      if (blocksCustom) {
        return {
          draft: null,
          outbound: [
            {
              kind: "text",
              body: "Your board plan is fixed. Please book meal times with reception or use the in-stay *Book meal time* flow. À la carte cart ordering is only for extras confirmed as chargeable."
            }
          ]
        };
      }
    }
  }

  // --- back navigation (order flows) ---
  if (isBack(raw)) {
    if (draft.step === "confirm") {
      draft = { ...draft, step: "time", timeNote: undefined };
      return {
        draft,
        outbound: [
          buildTimePickerList({
            hotelTimezone: hotelTz,
            now: nowClock,
            serviceMode: draft.serviceMode ?? "ROOM_SERVICE"
          })
        ]
      };
    }
    if (draft.step === "time") {
      draft = { ...draft, step: "service", timeNote: undefined };
      return {
        draft,
        outbound: [
          {
            kind: "buttons",
            body: "How should we serve this order?",
            buttons: [
              { id: "fb_svc_rs", title: "Room service" },
              { id: "fb_svc_di", title: "Dining" }
            ]
          }
        ]
      };
    }
    if (draft.step === "service") {
      draft = { ...draft, step: "add_more", serviceMode: undefined };
      return {
        draft,
        outbound: [
          {
            kind: "buttons",
            body: `Your items:\n${cartSummaryWithSubtotal(draft.cart, currency)}\n\nAdd another line item?`,
            buttons: [
              { id: "fb_add_yes", title: "Add item" },
              { id: "fb_add_no", title: "Continue" }
            ]
          }
        ]
      };
    }
    if (draft.step === "qty") {
      draft = { ...draft, step: "item", pendingMenuItemId: undefined, pendingName: undefined, pendingUnitPrice: undefined };
      if (draft.categoryId) {
        const list = buildItemList(draft.categoryId, resolved, currency);
        if (list && list.kind !== "text") return { draft, outbound: [list] };
      }
      draft = { ...draft, step: "category", categoryId: undefined };
      return { draft, outbound: [buildCategoryList(draft.purpose)] };
    }
    if (draft.step === "item") {
      draft = { ...draft, step: "category", categoryId: undefined };
      return { draft, outbound: [buildCategoryList(draft.purpose)] };
    }
    if (draft.step === "add_more") {
      if (draft.cart.length > 0) {
        const last = draft.cart[draft.cart.length - 1];
        draft = {
          ...draft,
          step: "qty",
          cart: draft.cart.slice(0, -1),
          pendingMenuItemId: last.menuItemId,
          pendingName: last.name,
          pendingUnitPrice: last.unitPrice
        };
        return {
          draft,
          outbound: [
            buildQuantityPickerList({
              itemName: last.name,
              currency,
              unitPrice: last.unitPrice
            })
          ]
        };
      }
      draft = { ...draft, step: "category" };
      return { draft, outbound: [buildCategoryList(draft.purpose)] };
    }
  }

  if (draft.step === "category") {
    if (!raw.startsWith(PREFIX_CAT)) {
      return { draft, outbound: [buildCategoryList(draft.purpose)] };
    }
    const id = raw.slice(PREFIX_CAT.length);
    const list = buildItemList(id, resolved, currency);
    if (!list) return { draft, outbound: [{ kind: "text", body: "Unknown category." }] };
    if (list.kind === "text") return { draft, outbound: [list] };
    draft = { ...draft, step: "item", categoryId: id };
    return { draft, outbound: [list] };
  }

  if (draft.step === "item") {
    if (!raw.startsWith(PREFIX_ITEM)) {
      return { draft, outbound: [{ kind: "text", body: "Please choose an item from the list above." }] };
    }
    const menuItemId = raw.slice(PREFIX_ITEM.length);
    const row = await prisma.menuItem.findFirst({
      where: { id: menuItemId, hotelId },
      select: { name: true, unitPrice: true }
    });
    if (!row) return { draft, outbound: [{ kind: "text", body: "Item not found." }] };
    draft = {
      ...draft,
      step: "qty",
      pendingMenuItemId: menuItemId,
      pendingName: row.name,
      pendingUnitPrice: row.unitPrice
    };
    return {
      draft,
      outbound: [
        buildQuantityPickerList({
          itemName: row.name,
          currency,
          unitPrice: row.unitPrice
        })
      ]
    };
  }

  if (draft.step === "qty") {
    const q = parseQtyReply(raw);
    if (q === null) {
      if (!draft.pendingMenuItemId || draft.pendingUnitPrice === undefined || !draft.pendingName) {
        return { draft: null, outbound: [{ kind: "text", body: "Session expired." }] };
      }
      return {
        draft,
        outbound: [
          {
            kind: "text",
            body: "Tap a quantity in the list above (×1–×10), or reply with a whole number from *11* to *99*."
          },
          buildQuantityPickerList({
            itemName: draft.pendingName,
            currency,
            unitPrice: draft.pendingUnitPrice
          })
        ]
      };
    }
    if (!draft.pendingMenuItemId || draft.pendingUnitPrice === undefined || !draft.pendingName) {
      return { draft: null, outbound: [{ kind: "text", body: "Session expired." }] };
    }
    const line: FbCartLine = {
      menuItemId: draft.pendingMenuItemId,
      name: draft.pendingName,
      unitPrice: draft.pendingUnitPrice,
      qty: q
    };
    const nextCart = mergeCartLinesByMenuItemId([...draft.cart, line]);
    draft = {
      ...draft,
      step: "add_more",
      cart: nextCart,
      pendingMenuItemId: undefined,
      pendingName: undefined,
      pendingUnitPrice: undefined,
      categoryId: undefined
    };
    return {
      draft,
      outbound: [
        {
          kind: "buttons",
          body: `Cart:\n${cartSummaryWithSubtotal(nextCart, currency)}\n\nAdd another item?`,
          buttons: [
            { id: "fb_add_yes", title: "Add item" },
            { id: "fb_add_no", title: "Continue" }
          ]
        }
      ]
    };
  }

  if (draft.step === "add_more") {
    if (raw.includes("fb_add_yes")) {
      draft = { ...draft, step: "category" };
      return { draft, outbound: [buildCategoryList(draft.purpose)] };
    }
    if (raw.includes("fb_add_no")) {
      if (draft.cart.length === 0) {
        return { draft: null, outbound: [{ kind: "text", body: "Cart is empty." }] };
      }
      draft = { ...draft, step: "service" };
      return {
        draft,
        outbound: [
          {
            kind: "buttons",
            body: "How should this order be served?",
            buttons: [
              { id: "fb_svc_rs", title: "Room service" },
              { id: "fb_svc_di", title: "Dining" }
            ]
          }
        ]
      };
    }
    return {
      draft,
      outbound: [
        {
          kind: "buttons",
          body: "Tap *Add item* or *Continue*.",
          buttons: [
            { id: "fb_add_yes", title: "Add item" },
            { id: "fb_add_no", title: "Continue" }
          ]
        }
      ]
    };
  }

  if (draft.step === "service") {
    const svc = parseService(raw);
    if (!svc) {
      return {
        draft,
        outbound: [
          {
            kind: "buttons",
            body: "Tap *Room service* or *Dining*.",
            buttons: [
              { id: "fb_svc_rs", title: "Room service" },
              { id: "fb_svc_di", title: "Dining" }
            ]
          }
        ]
      };
    }
    draft = { ...draft, step: "time", serviceMode: svc };
    return {
      draft,
      outbound: [
        buildTimePickerList({
          hotelTimezone: hotelTz,
          now: nowClock,
          serviceMode: svc
        })
      ]
    };
  }

  if (draft.step === "time") {
    if (raw.includes("fb_time_custom")) {
      const diningHint =
        draft.serviceMode === "DINING_IN"
          ? " Restaurant dining: *12:00–15:00* or *18:30–22:00* (hotel local time)."
          : "";
      return {
        draft,
        outbound: [
          {
            kind: "text",
            body: "Type the time as *HH:MM* (24h), e.g. *13:00* or *20:00*." + diningHint
          }
        ]
      };
    }
    let note = parseTimeNote(raw);
    if (note === null && raw.length > 2 && !raw.includes("fb_")) {
      note = raw.trim();
    }
    if (note === null) {
      return {
        draft,
        outbound: [
          {
            kind: "text",
            body: "Scroll the list below and tap a time, or tap *Other time…* to type *HH:MM*."
          },
          buildTimePickerList({
            hotelTimezone: hotelTz,
            now: nowClock,
            serviceMode: draft.serviceMode ?? "ROOM_SERVICE"
          })
        ]
      };
    }
    const sm = draft.serviceMode ?? "ROOM_SERVICE";
    const validated = validateMealServiceTime({
      serviceMode: sm,
      timeNote: note,
      now: nowClock,
      hotelTimezone: hotelTz
    });
    if (!validated.ok) {
      return {
        draft,
        outbound: [
          { kind: "text", body: validated.message },
          buildTimePickerList({
            hotelTimezone: hotelTz,
            now: nowClock,
            serviceMode: sm
          })
        ]
      };
    }

    draft = { ...draft, step: "confirm", timeNote: note };
    const grand = cartSubtotal(draft.cart);
    const svcLabel = sm === "ROOM_SERVICE" ? "Room service" : "Restaurant dining";
    const timeLabel = note === "ASAP" ? "ASAP / now" : note;
    const summaryText = [
      "*Review your order*",
      cartSummaryWithSubtotal(draft.cart, currency),
      "",
      `*FINAL TOTAL:* ${grand.toFixed(2)} ${currency}`,
      `*Service:* ${svcLabel}`,
      `*Requested time:* ${timeLabel}`,
      "",
      "Tap *Confirm order* to send to the hotel, or *Cancel*."
    ].join("\n");
    return {
      draft,
      outbound: [
        { kind: "text", body: summaryText },
        {
          kind: "buttons",
          body: "Ready to confirm?",
          buttons: [
            { id: "fb_order_confirm", title: "Confirm order" },
            { id: "fb_order_cancel", title: "Cancel" }
          ]
        }
      ]
    };
  }

  if (draft.step === "confirm") {
    const sm = draft.serviceMode ?? "ROOM_SERVICE";
    const note = draft.timeNote ?? "ASAP";
    const lines = draft.cart.map((c) => ({ menuItemId: c.menuItemId, qty: c.qty }));

    if (raw.includes("fb_order_cancel") || /^(cancel|stop|no)\b/i.test(raw.trim())) {
      return { draft: null, outbound: [{ kind: "text", body: "Order cancelled. Reply *menu* anytime." }] };
    }

    if (!raw.includes("fb_order_confirm") && !/^(yes|confirm|ok|proceed)\b/i.test(raw.trim())) {
      const grand = cartSubtotal(draft.cart);
      const summaryText = [
        "*Review your order*",
        cartSummaryWithSubtotal(draft.cart, currency),
        "",
        `*FINAL TOTAL:* ${grand.toFixed(2)} ${currency}`,
        `Service: ${sm === "ROOM_SERVICE" ? "Room service" : "Restaurant dining"}`,
        `Time: ${note === "ASAP" ? "ASAP" : note}`
      ].join("\n");
      return {
        draft,
        outbound: [
          { kind: "text", body: summaryText },
          {
            kind: "buttons",
            body: "Tap *Confirm order* to submit.",
            buttons: [
              { id: "fb_order_confirm", title: "Confirm order" },
              { id: "fb_order_cancel", title: "Cancel" }
            ]
          }
        ]
      };
    }

    if (draft.purpose === "booking_prebook") {
      return {
        draft: null,
        outbound: [],
        prebookFinished: { lines, serviceMode: sm, timeNote: note }
      };
    }
    if (draft.purpose === "stay" && draft.stayBookingId) {
      const grand = cartSubtotal(draft.cart);
      return {
        draft: null,
        outbound: [
          {
            kind: "text",
            body: `Order confirmed — *FINAL TOTAL ${grand.toFixed(2)} ${currency}*. The kitchen has your request and it is on your folio.`
          }
        ],
        stayFinished: { bookingId: draft.stayBookingId, lines, serviceMode: sm, timeNote: note }
      };
    }
    return { draft: null, outbound: [{ kind: "text", body: "Missing stay booking context." }] };
  }

  return { draft, outbound: [{ kind: "text", body: "Unexpected state." }] };
}
