import { ChannelProvider, ConversationState as DbConversationState, FbServiceMode, MessageDirection, Prisma, UserRole } from "@prisma/client";
import { parseGuestMessage, validateParsedBookingInput } from "../core/parse";
import { findAvailableRoomType, findAvailableRoomTypes } from "../core/availability";
import { roomTypeAllowsOccupancy } from "../core/roomOccupancy";
import { createConfirmedBookingAtomic } from "../core/bookingService";
import { computeMealPlanSurchargeForStay, type MealPlanCode } from "../core/frontDeskPricing";
import { createFbOrdersFromMenuLines } from "../core/fbFolio";
import { mergeGuestProfileFromBooking } from "../core/guestProfile";
import { nextState, type ConversationEvent, type ConversationState } from "../core/stateMachine";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import {
  type BookingStep,
  type ConversationMode,
  loadConversationSession,
  saveConversationSession,
  upsertBookingDraft
} from "../core/sessionStore";
import type { PendingPrebookOrder, WhatsAppMealPlanCode } from "./foodTypes";
import {
  advanceFbCartDraft,
  findGuestActiveStayBooking,
  initialFbOrderList,
  isStayFoodIntent,
  type FoodFlowOutbound
} from "./guestFoodFlow";
import { prisma } from "../db";
import { createRoleRoutedNotification } from "../core/notifications";
import { logWhatsAppMessage } from "./messageLogger";
import {
  answerFromKnowledge,
  buildKnowledgeFallbackMessage,
  getLocationAndHotelInfoForSubmenu,
  getOffersForBookingSubmenu,
  getRoomTypesForBookingSubmenu
} from "./knowledgeBase";
import { sendWhatsAppButtons, sendWhatsAppList, sendWhatsAppText } from "./send";
import { guestReceptionistHandoffMessage } from "./guestNotifications";
import { handleGuestJourneyInboundReply, type GuestJourneyOperationalReply } from "./preArrivalGuestReplyNotify";
import {
  buildCheckInListSections,
  buildCheckOutListSections,
  fallbackCheckInTextBody,
  fallbackCheckOutTextBody,
  parseCheckInDigitReply,
  parseCheckInListId,
  parseCheckOutDigitReply,
  parseCheckOutListId
} from "./bookingDateLists";

type InboundMessageInput = {
  from: string;
  messageId: string;
  text: string;
  inboundPhoneNumberId?: string;
};

type TurnResult = {
  nextState: ConversationState;
  responseBody: string;
  conversationState: DbConversationState;
  updateSession: Record<string, unknown>;
  responseButtons?: Array<{ id: string; title: string }>;
  responseList?: { buttonText: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string }> }> };
};

function bookingStartPrompt(): string {
  return [
    "Great, I can help with your booking.",
    "Please share check-in, check-out, and guest count.",
    "Examples:",
    "- 2026-04-10 to 2026-04-12 for 2 guests",
    "- 2 guests from 10 April to 12 April"
  ].join("\n");
}

function missingBookingDetailsPrompt(parsed: ReturnType<typeof parseGuestMessage>): string {
  const missingDates = !parsed.checkIn || !parsed.checkOut;
  const missingGuests = parsed.guestCount === undefined;
  if (missingDates && missingGuests) {
    return "Please share your check-in, check-out, and guest count. Example: 2026-04-10 to 2026-04-12 for 2 guests.";
  }
  if (missingDates) {
    return "Please share your check-in and check-out dates.";
  }
  return "How many guests will stay?";
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGreeting(text: string): boolean {
  const n = normalizeText(text);
  return /^(hi|hello|hey|start|السلام عليكم|مرحبا|اهلا|أهلا)$/.test(n);
}

const GLOBAL_RESET_NORMALIZED = [
  "hi",
  "hello",
  "hey",
  "start",
  "menu",
  "main menu",
  "options",
  "help",
  "home",
  "back to menu",
  "القائمة",
  "مساعدة",
  "خيارات"
];

/** Global menu/reset messages that always escape temporary flows (e.g. My booking lookup, awaiting guest name). */
function isGlobalResetMessage(text: string): boolean {
  const n = normalizeText(text);
  if (GLOBAL_RESET_NORMALIZED.includes(n)) return true;
  if (isGreeting(text)) return true;
  // Do NOT treat main-menu button payloads (Book / Questions / Reception) as reset — they are routed below
  // to BOOKING_MODE, QUESTION_MODE, and AGENT_MODE. Including them here re-sent the welcome menu on every tap.
  return false;
}

function isBackOneStepText(text: string): boolean {
  const n = normalizeText(text);
  return /^(back|previous|prev|go back|return|رجوع|السابق)$/.test(n);
}

function isBookingIntent(text: string): boolean {
  const n = normalizeText(text);
  return /\b(book|booking|reserve|reservation|i want to book|book now|confirm booking|حجز|اريد الحجز|أريد الحجز)\b/.test(n);
}

function isConfirmationKeyword(text: string): boolean {
  return /^(yes|y|confirm|confirm_booking|book|ok|okay|proceed|sure|no|n|cancel|edit|change)$/i.test(text.trim());
}

const CONVERSATION_MODES: ConversationMode[] = ["IDLE", "BOOKING_MODE", "QUESTION_MODE", "AGENT_MODE"];

function getConversationMode(raw: string | undefined): ConversationMode {
  return CONVERSATION_MODES.includes(raw as ConversationMode) ? (raw as ConversationMode) : "IDLE";
}

/** Effective UI language: ar or en. Defaults to en when not set. */
function effectiveLang(lang: string | undefined): "ar" | "en" {
  return lang === "ar" ? "ar" : "en";
}

function getMainMenuBody(hotelName: string, lang: "ar" | "en"): string {
  if (lang === "ar") {
    return `أهلاً بك في ${hotelName}.\nيرجى اختيار خيار:\n• حجز إقامة\n• طرح سؤال\n• التحدث مع موظف الاستقبال`;
  }
  return `Welcome to ${hotelName}.\nPlease choose an option:\n• Book a stay\n• Ask a question\n• Chat with a receptionist`;
}

function buildMainMenuMessage(hotelName: string, lang: "ar" | "en"): string {
  if (lang === "ar") {
    return [
      `أهلاً بك في ${hotelName}.`,
      "يرجى اختيار خيار:",
      "• حجز إقامة",
      "• طرح سؤال",
      "• التحدث مع موظف الاستقبال"
    ].join("\n");
  }
  return [
    `Welcome to ${hotelName}.`,
    "Please choose an option:",
    "• Book a stay",
    "• Ask a question",
    "• Chat with a receptionist"
  ].join("\n");
}

const MENU_BUTTONS: Array<{ id: string; title: string }> = [
  { id: "book_a_stay", title: "Book" },
  { id: "ask_question", title: "Questions" },
  { id: "talk_to_agent", title: "Reception" }
];

/** When guest has an active stay, main menu is a list (4 rows) so we can add Food & drinks without exceeding reply-button limits. */
const MAIN_MENU_LIST_CTA = "Menu";

async function sendMainMenuForGuest(params: {
  hotel: { id: string; displayName: string; phoneNumberId?: string };
  guestId: string;
  to: string;
  conversationId: string;
  menuBody: string;
  fallbackBody: string;
}): Promise<{ recordedBody: string }> {
  const stay = await findGuestActiveStayBooking(params.hotel.id, params.guestId);
  if (stay) {
    try {
      await sendWhatsAppList({
        to: params.to,
        body: params.menuBody,
        buttonText: MAIN_MENU_LIST_CTA,
        sections: [
          {
            title: "Choose",
            rows: [
              { id: "book_a_stay", title: "Book", description: "New reservation" },
              { id: "order_food_stay", title: "Order food / drinks", description: "Restaurant / room service" },
              { id: "ask_question", title: "Questions", description: "Hotel information" },
              { id: "talk_to_agent", title: "Reception", description: "Speak with staff" }
            ]
          }
        ],
        phoneNumberId: params.hotel.phoneNumberId,
        conversationId: params.conversationId
      });
      return { recordedBody: params.menuBody };
    } catch (err) {
      console.error("WhatsApp main menu list send failed:", err instanceof Error ? err.message : String(err));
      try {
        await sendWhatsAppButtons({
          to: params.to,
          body: params.menuBody,
          buttons: MENU_BUTTONS,
          phoneNumberId: params.hotel.phoneNumberId,
          conversationId: params.conversationId
        });
        return { recordedBody: params.menuBody };
      } catch {
        await sendWhatsAppText({
          to: params.to,
          body: params.fallbackBody,
          phoneNumberId: params.hotel.phoneNumberId,
          conversationId: params.conversationId
        });
        return { recordedBody: params.fallbackBody };
      }
    }
  }
  try {
    await sendWhatsAppButtons({
      to: params.to,
      body: params.menuBody,
      buttons: MENU_BUTTONS,
      phoneNumberId: params.hotel.phoneNumberId,
      conversationId: params.conversationId
    });
    return { recordedBody: params.menuBody };
  } catch (err) {
    console.error("WhatsApp main menu buttons send failed:", err instanceof Error ? err.message : String(err));
    await sendWhatsAppText({
      to: params.to,
      body: params.fallbackBody,
      phoneNumberId: params.hotel.phoneNumberId,
      conversationId: params.conversationId
    });
    return { recordedBody: params.fallbackBody };
  }
}

const LANGUAGE_SELECT_PROMPT = "Please choose your language:";
const LANGUAGE_SELECT_FALLBACK = "Please choose your language:\n• العربية\n• English";
const LANGUAGE_BUTTONS: Array<{ id: string; title: string }> = [
  { id: "lang_ar", title: "العربية" },
  { id: "lang_en", title: "English" }
];

const BOOKING_MODE_ENTRY =
  "I'll help you book a stay. You can ask about room types or check availability. To get started, share your preferred dates and number of guests—e.g. 10–12 April for 2 guests.";
const BOOKING_SUBMENU_BODY = "What would you like to do?";
const BOOKING_SUBMENU_LIST = {
  buttonText: "Choose an option",
  sections: [
    {
      title: "Booking options",
      rows: [
        { id: "check_availability", title: "Check availability" },
        { id: "view_room_types", title: "View room types" },
        { id: "view_offers", title: "View offers" },
        { id: "view_location_info", title: "View location and hotel information" }
      ]
    }
  ]
};

const BOOKING_NAV_HINT = "\n\nTip: reply *back* for the previous step, or *menu* for the main menu.";
const QUESTION_MODE_ENTRY =
  "You can ask me anything about the hotel: rooms, amenities, check-in times, policies, location, and more. What would you like to know?\n\nReply *menu* anytime to return to the main menu.";

function normalizeMenuButtonInput(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "").trim().normalize("NFC");
}

function isMenuChoiceBookStay(text: string): boolean {
  const t = normalizeMenuButtonInput(text).toLowerCase();
  return t === "book_a_stay" || t === "book a stay" || t === "book";
}
function isMenuChoiceAskQuestion(text: string): boolean {
  const t = normalizeMenuButtonInput(text).toLowerCase();
  return t === "ask_question" || t === "ask a question" || t === "ask the chatbot" || t === "ask" || t === "questions";
}
function isMenuChoiceTalkToAgent(text: string): boolean {
  const t = normalizeMenuButtonInput(text).toLowerCase();
  return t === "talk_to_agent" || t === "talk to an agent" || t === "chat with a receptionist" || t === "agent" || t === "reception";
}

/** Normalize button/title text from WhatsApp (NFC, strip invisible) so language taps match reliably. */
function normalizeLanguageButtonText(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "").trim().normalize("NFC");
}

function isLanguageChoice(text: string): "ar" | "en" | null {
  const nfc = normalizeLanguageButtonText(text);
  const t = nfc.toLowerCase();
  if (t === "lang_ar" || t === "arabic" || t === "ar" || nfc === "العربية") return "ar";
  if (t === "lang_en" || t === "english" || t === "en") return "en";
  return null;
}

function needsLanguageSelection(lang: string | undefined): boolean {
  return !lang || lang === "";
}
type BookingSubMenuChoice = "check_availability" | "view_room_types" | "view_offers" | "view_location_info";
function getBookingSubMenuChoice(text: string): BookingSubMenuChoice | undefined {
  const t = text.trim().toLowerCase();
  if (t === "check_availability" || t === "check availability") return "check_availability";
  if (t === "view_room_types" || t === "view room types") return "view_room_types";
  if (t === "view_offers" || t === "view offers") return "view_offers";
  if (t === "view_location_info" || t === "view location and hotel information" || t === "view location") return "view_location_info";
  return undefined;
}

function isBookingSummaryReturnText(text: string): boolean {
  const t = normalizeText(text);
  return (
    t === "summary" ||
    t === "booking summary" ||
    t === "final confirmation" ||
    t === "return to summary" ||
    t === "resume booking" ||
    t === "confirm"
  );
}

/** Parse a non-negative integer from message (e.g. "2", "0", "3 adults") for structured booking steps. */
function parseStepNumber(text: string, max: number, allowZero = false): number | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\d{1,2}$/) || trimmed.match(/(\d{1,2})/);
  if (!match) return null;
  const n = parseInt(match[1] ?? match[0], 10);
  const min = allowZero ? 0 : 1;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

async function getEligibleRoomTypesForBookingFlow(
  hotelId: string,
  adults: number,
  children: number
): Promise<Array<{ id: string; name: string; capacity: number; baseNightlyRate: number; propertyId: string }>> {
  const total = adults + children;
  if (total < 1) return [];
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId, isActive: true, capacity: { gte: total } },
    orderBy: [{ baseNightlyRate: "asc" }]
  });
  return roomTypes
    .filter((rt) => roomTypeAllowsOccupancy(rt.code, adults, children).ok)
    .map((rt) => ({
      id: rt.id,
      name: rt.name,
      capacity: rt.capacity,
      baseNightlyRate: rt.baseNightlyRate,
      propertyId: rt.propertyId
    }));
}

async function getLargestRoomTypesForFallback(hotelId: string, limit: number) {
  return prisma.roomType.findMany({
    where: { hotelId, isActive: true },
    orderBy: { capacity: "desc" },
    take: limit,
    select: { name: true, capacity: true }
  });
}

async function sendCapacityRoomTypePickList(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
  currency: string;
  adults: number;
  children: number;
  types: Array<{ id: string; name: string; capacity: number; baseNightlyRate: number }>;
}): Promise<void> {
  const total = params.adults + params.children;
  const listBody = `Based on your group (${params.adults} adult(s), ${params.children} child(ren), ${total} guests), here are room types that can accommodate you:`;
  const rows = params.types.slice(0, 10).map((rt) => ({
    id: rt.id,
    title: `${rt.name} · ${rt.capacity}g`.slice(0, 24),
    description: `Max ${rt.capacity} guests · from ${rt.baseNightlyRate.toFixed(0)} ${params.currency}/night`.slice(0, 72)
  }));
  try {
    await sendWhatsAppList({
      to: params.to,
      body: listBody,
      buttonText: "Choose room",
      sections: [{ title: "Room types", rows }],
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch (err) {
    console.error("WhatsApp capacity room list send failed:", err instanceof Error ? err.message : String(err));
    await sendWhatsAppText({
      to: params.to,
      body:
        listBody +
        "\n\n" +
        params.types.map((rt) => `• ${rt.name} (max ${rt.capacity} guests) — from ${rt.baseNightlyRate.toFixed(0)} ${params.currency}/night`).join("\n"),
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
  await prisma.message.create({
    data: {
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      direction: MessageDirection.OUTBOUND,
      body: listBody,
      aiIntent: "BOOKING_STEP_CAPACITY_ROOM_LIST",
      aiConfidence: 0.95
    }
  });
}

async function sendBookingCheckInPrompt(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
}): Promise<void> {
  const body =
    "Choose your *check-in* date:\n\nOpen the list below and tap a date, or choose *Other date* to type YYYY-MM-DD.";
  try {
    await sendWhatsAppList({
      to: params.to,
      body,
      buttonText: "Pick check-in",
      sections: buildCheckInListSections(),
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch (err) {
    console.error("Check-in list send failed:", err instanceof Error ? err.message : String(err));
    await sendWhatsAppText({
      to: params.to,
      body: `${body}\n\n${fallbackCheckInTextBody()}`,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
  await prisma.message.create({
    data: {
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      direction: MessageDirection.OUTBOUND,
      body,
      aiIntent: "BOOKING_STEP_CHECKIN_LIST",
      aiConfidence: 0.95
    }
  });
}

async function sendBookingCheckOutPrompt(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
  checkInIso: string;
}): Promise<void> {
  const body =
    "Choose your *check-out* date (must be after check-in):\n\nOpen the list below, or *Other date* to type YYYY-MM-DD.";
  try {
    await sendWhatsAppList({
      to: params.to,
      body,
      buttonText: "Pick check-out",
      sections: buildCheckOutListSections(params.checkInIso),
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch (err) {
    console.error("Check-out list send failed:", err instanceof Error ? err.message : String(err));
    await sendWhatsAppText({
      to: params.to,
      body: `${body}\n\n${fallbackCheckOutTextBody(params.checkInIso)}`,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
  await prisma.message.create({
    data: {
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      direction: MessageDirection.OUTBOUND,
      body,
      aiIntent: "BOOKING_STEP_CHECKOUT_LIST",
      aiConfidence: 0.95
    }
  });
}

function isMenuChoiceMyBooking(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "my_booking" || t === "my booking";
}

const QUOTE_BUTTONS: Array<{ id: string; title: string }> = [
  { id: "confirm", title: "Confirm" },
  { id: "change_details", title: "Change details" },
  { id: "cancel", title: "Cancel" }
];

async function estimatePrebookOrderTotal(
  hotelId: string,
  lines: Array<{ menuItemId: string; qty: number }>
): Promise<number> {
  if (lines.length === 0) return 0;
  const items = await prisma.menuItem.findMany({
    where: { hotelId, id: { in: [...new Set(lines.map((l) => l.menuItemId))] } },
    select: { id: true, unitPrice: true }
  });
  const byId = new Map(items.map((i) => [i.id, i.unitPrice]));
  let t = 0;
  for (const l of lines) {
    const p = byId.get(l.menuItemId);
    if (p !== undefined) t += p * l.qty;
  }
  return Number(t.toFixed(2));
}

function whatsAppMealPlanToPricingCode(code: WhatsAppMealPlanCode | null | undefined): MealPlanCode {
  if (code === "HALF_BOARD") return "HALF_BOARD";
  if (code === "FULL_BOARD") return "FULL_BOARD";
  return "NONE";
}

async function sendFoodFlowOutbounds(params: {
  to: string;
  phoneNumberId?: string;
  conversationId: string;
  hotelId: string;
  outbounds: FoodFlowOutbound[];
}): Promise<void> {
  for (const o of params.outbounds) {
    if (o.kind === "text") {
      if (!o.body.trim()) continue;
      await sendWhatsAppText({
        to: params.to,
        body: o.body,
        phoneNumberId: params.phoneNumberId,
        conversationId: params.conversationId
      });
    } else if (o.kind === "list") {
      try {
        await sendWhatsAppList({
          to: params.to,
          body: o.body,
          buttonText: o.buttonText,
          sections: o.sections,
          phoneNumberId: params.phoneNumberId,
          conversationId: params.conversationId
        });
      } catch (err) {
        console.error("Food flow list send failed:", err instanceof Error ? err.message : String(err));
        await sendWhatsAppText({
          to: params.to,
          body: o.body,
          phoneNumberId: params.phoneNumberId,
          conversationId: params.conversationId
        });
      }
    } else if (o.kind === "buttons") {
      try {
        await sendWhatsAppButtons({
          to: params.to,
          body: o.body,
          buttons: o.buttons,
          phoneNumberId: params.phoneNumberId,
          conversationId: params.conversationId
        });
      } catch (err) {
        await sendWhatsAppText({
          to: params.to,
          body: o.body,
          phoneNumberId: params.phoneNumberId,
          conversationId: params.conversationId
        });
      }
    }
    await prisma.message.create({
      data: {
        hotelId: params.hotelId,
        conversationId: params.conversationId,
        direction: MessageDirection.OUTBOUND,
        body: o.kind === "text" ? o.body : o.body.slice(0, 400),
        aiIntent: "FOOD_FLOW",
        aiConfidence: 0.95
      }
    });
  }
}

const GUEST_COUNT_LIST = {
  buttonText: "Choose guests",
  sections: [
    {
      title: "Guests",
      rows: [
        { id: "1_guest", title: "1 guest" },
        { id: "2_guests", title: "2 guests" },
        { id: "3_guests", title: "3 guests" },
        { id: "4+_guests", title: "4+ guests" }
      ]
    }
  ]
};

function isActiveBookingState(state: ConversationState): boolean {
  return state === "collecting_dates" || state === "quoted" || state === "awaiting_confirmation";
}

const MY_BOOKING_PROMPT =
  "Reply with your booking ID (e.g. WB-xxxxx) or the phone number you used when booking.";
const MY_BOOKING_NOT_FOUND =
  "No booking found for that ID or phone number. Please check and try again, or send your booking ID (e.g. WB-xxxxx) or the phone number you used when booking.";

function formatBookingSummary(booking: {
  id: string;
  guest: { fullName: string | null; phoneE164: string };
  roomType: { name: string };
  checkIn: Date;
  checkOut: Date;
  nights: number;
  adults: number;
  totalAmount: number;
  currency: string;
  status: string;
  paymentStatus: string;
}): string {
  const checkInStr = new Date(booking.checkIn).toISOString().slice(0, 10);
  const checkOutStr = new Date(booking.checkOut).toISOString().slice(0, 10);
  return [
    "Here is your booking:",
    `Booking ID: ${booking.id}`,
    `Guest: ${booking.guest.fullName ?? booking.guest.phoneE164}`,
    `Room: ${booking.roomType.name}`,
    `Check-in: ${checkInStr}`,
    `Check-out: ${checkOutStr}`,
    `Guests: ${booking.adults}`,
    `Nights: ${booking.nights}`,
    `Total: ${Number(booking.totalAmount).toFixed(2)} ${booking.currency}`,
    `Status: ${booking.status}`,
    `Payment: ${booking.paymentStatus}`
  ].join("\n");
}

type BookingWithGuestAndRoom = Awaited<
  ReturnType<
    typeof prisma.booking.findFirst<{ include: { guest: true; roomType: true } }>
  >
>;

type BookingLookupResult =
  | { kind: "single"; booking: NonNullable<BookingWithGuestAndRoom> }
  | { kind: "multiple"; bookings: Awaited<ReturnType<typeof prisma.booking.findMany<{ include: { guest: true; roomType: true } }>>> }
  | { kind: "none" };

async function lookupBookings(
  hotelId: string,
  input: string
): Promise<BookingLookupResult> {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "none" };
  const byId = await prisma.booking.findFirst({
    where: { id: trimmed, hotelId },
    include: { guest: true, roomType: true }
  });
  if (byId) return { kind: "single", booking: byId };
  const phoneDigits = trimmed.replace(/\D/g, "");
  if (phoneDigits.length < 8) return { kind: "none" };
  const guestByPhone = await prisma.guest.findFirst({
    where: { hotelId, phoneE164: phoneDigits }
  });
  if (!guestByPhone) return { kind: "none" };
  const list = await prisma.booking.findMany({
    where: { hotelId, guestId: guestByPhone.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    include: { guest: true, roomType: true }
  });
  if (list.length === 0) return { kind: "none" };
  if (list.length === 1) return { kind: "single", booking: list[0] };
  return { kind: "multiple", bookings: list };
}

function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}

function normalizeSessionState(raw: string | undefined): ConversationState {
  if (raw === "collecting_dates") return "collecting_dates";
  if (raw === "quoted") return "quoted";
  if (raw === "awaiting_confirmation") return "awaiting_confirmation";
  if (raw === "confirmed") return "confirmed";
  if (raw === "cancelled") return "cancelled";
  return "new";
}

function toDbConversationState(state: ConversationState): DbConversationState {
  if (state === "awaiting_confirmation") return DbConversationState.QUOTED;
  if (state === "quoted") return DbConversationState.QUOTED;
  if (state === "confirmed") return DbConversationState.CONFIRMED;
  if (state === "cancelled") return DbConversationState.CLOSED;
  return DbConversationState.QUALIFYING;
}

function inferEvent(state: ConversationState, text: string, parsed: ReturnType<typeof parseGuestMessage>): ConversationEvent {
  const normalized = text.trim().toLowerCase();
  if (state === "awaiting_confirmation") {
    if (/^(yes|y|confirm|confirm_booking|book|ok|okay|proceed|sure)$/i.test(normalized)) {
      return "guest_confirmed";
    }
    if (/^(no|n|cancel|edit|change|change_details)$/i.test(normalized)) {
      return "guest_cancelled";
    }
  }
  if (state === "collecting_dates" && parsed.checkIn && parsed.checkOut) {
    return "dates_collected";
  }
  if (state === "quoted") return "quote_sent";
  return "message_received";
}

async function resolveHotel(
  inboundPhoneNumberId?: string
): Promise<{ id: string; displayName: string; currency: string; timezone: string; phoneNumberId?: string }> {
  const hotels = await prisma.hotel.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, displayName: true, currency: true, timezone: true }
  });
  if (!hotels.length) {
    throw new Error("No hotels configured");
  }
  if (inboundPhoneNumberId) {
    for (const hotel of hotels) {
      const config = loadPartnerSetupConfig(hotel.id);
      if (config.whatsappPhoneNumberId && config.whatsappPhoneNumberId === inboundPhoneNumberId) {
        return {
          id: hotel.id,
          displayName: hotel.displayName,
          currency: hotel.currency,
          timezone: hotel.timezone,
          phoneNumberId: config.whatsappPhoneNumberId
        };
      }
    }
  }
  const fallback = hotels[0];
  const fallbackConfig = loadPartnerSetupConfig(fallback.id);
  // If partner JSON still has an old WABA phone ID but the webhook came from a new number, reply using Meta's inbound ID (always valid for this token).
  const outboundPhoneNumberId =
    inboundPhoneNumberId ||
    fallbackConfig.whatsappPhoneNumberId ||
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    undefined;
  return {
    id: fallback.id,
    displayName: fallback.displayName,
    currency: fallback.currency,
    timezone: fallback.timezone,
    phoneNumberId: outboundPhoneNumberId
  };
}

async function buildTurnResult(params: {
  state: ConversationState;
  event: ConversationEvent;
  text: string;
  hotelId: string;
  hotelName: string;
  currency: string;
  guestId: string;
  conversationId: string;
  sessionData: Record<string, unknown>;
}): Promise<TurnResult> {
  const next = nextState(params.state, params.event);
  const parsed = parseGuestMessage(params.text);
  const sessionCheckIn = typeof params.sessionData.checkIn === "string" ? new Date(params.sessionData.checkIn) : undefined;
  const sessionCheckOut = typeof params.sessionData.checkOut === "string" ? new Date(params.sessionData.checkOut) : undefined;
  const sessionGuests = typeof params.sessionData.guestCount === "number" ? params.sessionData.guestCount : 2;
  const sessionRooms = typeof params.sessionData.roomCount === "number" ? params.sessionData.roomCount : 1;

  if (params.state === "new" && next === "collecting_dates") {
    return {
      nextState: next,
      conversationState: DbConversationState.NEW,
      responseBody: bookingStartPrompt(),
      updateSession: { awaitingGuestName: false }
    };
  }

  if (params.state === "collecting_dates" && params.event === "dates_collected") {
    const validation = validateParsedBookingInput(parsed);
    if (!validation.ok && validation.message) {
      return {
        nextState: "collecting_dates",
        conversationState: DbConversationState.QUALIFYING,
        responseBody: parsed.checkIn || parsed.checkOut || parsed.guestCount !== undefined ? missingBookingDetailsPrompt(parsed) : validation.message,
        updateSession: {}
      };
    }
    const checkIn = parsed.checkIn!;
    const checkOut = parsed.checkOut!;
    const guestCount = parsed.guestCount ?? sessionGuests;
    const roomCount = parsed.roomCount ?? sessionRooms;
    const sessionAdults = typeof params.sessionData.adultCount === "number" ? params.sessionData.adultCount : undefined;
    const sessionChildren = typeof params.sessionData.childCount === "number" ? params.sessionData.childCount : undefined;
    const offer = await findAvailableRoomType({
      hotelId: params.hotelId,
      checkIn,
      checkOut,
      guests: guestCount,
      rooms: roomCount,
      ...(sessionAdults !== undefined && sessionChildren !== undefined ? { adults: sessionAdults, children: sessionChildren } : {})
    });
    if (!offer) {
      return {
        nextState: "collecting_dates",
        conversationState: DbConversationState.QUALIFYING,
        responseBody: "Those dates are unavailable. Please send another date range.",
        updateSession: {}
      };
    }

    const awaiting = nextState("quoted", "quote_sent");
    return {
      nextState: awaiting,
      conversationState: DbConversationState.QUOTED,
      responseBody: [
        "Here is your quote:",
        `Room type: ${offer.roomTypeName}`,
        `Check-in: ${checkIn.toISOString().slice(0, 10)}`,
        `Check-out: ${checkOut.toISOString().slice(0, 10)}`,
        `Guests: ${guestCount}`,
        `Nights: ${offer.nights}`,
        `Total price: ${offer.total.toFixed(2)} ${params.currency}`,
        "",
        "Tap a button below or reply YES to confirm, EDIT to change, NO to cancel."
      ].join("\n"),
      responseButtons: QUOTE_BUTTONS,
      updateSession: {
        awaitingGuestName: false,
        checkIn: checkIn.toISOString().slice(0, 10),
        checkOut: checkOut.toISOString().slice(0, 10),
        guestCount,
        roomCount,
        suggestedRoomTypeId: offer.roomTypeId,
        suggestedRoomTypeName: offer.roomTypeName,
        suggestedPropertyId: offer.propertyId,
        nights: offer.nights,
        totalAmount: offer.total
      }
    };
  }

  if (params.state === "quoted" && params.event === "quote_sent") {
    const saidYes = /^(yes|y|confirm|confirm_booking|book|ok|okay|proceed|sure)$/i.test(params.text.trim());
    if (saidYes) {
      return {
        nextState: "awaiting_confirmation",
        conversationState: DbConversationState.QUOTED,
        responseBody: "Great! Please share the guest name for the reservation.",
        updateSession: { awaitingGuestName: true }
      };
    }
  }

  if (params.state === "awaiting_confirmation" && params.event === "guest_confirmed") {
    return {
      nextState: "awaiting_confirmation",
      conversationState: DbConversationState.QUOTED,
      responseBody: "Great! Please share the guest name for the reservation.",
      updateSession: { awaitingGuestName: true }
    };
  }

  if (params.state === "awaiting_confirmation" && params.event === "guest_cancelled") {
    const normalized = normalizeText(params.text);
    if (normalized === "cancel") {
      return {
        nextState: "cancelled",
        conversationState: DbConversationState.CLOSED,
        responseBody: "Booking cancelled. If you want, I can start a new booking anytime.",
        updateSession: { awaitingGuestName: false }
      };
    }
    return {
      nextState: "collecting_dates",
      conversationState: DbConversationState.QUALIFYING,
      responseBody: "Sure. What would you like to change: dates, guests, or rooms?",
      updateSession: { awaitingGuestName: false }
    };
  }

  if (next === "collecting_dates") {
    const validation = validateParsedBookingInput(parsed);
    const hasDates = Boolean(parsed.checkIn && parsed.checkOut) || Boolean(sessionCheckIn && sessionCheckOut);
    const onlyGuestsMissing =
      !validation.ok &&
      validation.missing?.length === 1 &&
      validation.missing[0] === "guests" &&
      hasDates;
    return {
      nextState: next,
      conversationState: DbConversationState.QUALIFYING,
      responseBody: validation.ok ? bookingStartPrompt() : missingBookingDetailsPrompt(parsed),
      responseList: onlyGuestsMissing ? GUEST_COUNT_LIST : undefined,
      updateSession: { awaitingGuestName: false }
    };
  }

  if (next === "awaiting_confirmation") {
    return {
      nextState: next,
      conversationState: DbConversationState.QUOTED,
      responseBody: "Please reply YES to confirm your booking or NO to cancel.",
      updateSession: { awaitingGuestName: false }
    };
  }

  return {
    nextState: next,
    conversationState: toDbConversationState(next),
    responseBody: "How can I help with your booking today?",
    updateSession: { awaitingGuestName: false }
  };
}

export async function handleIncomingWhatsAppMessage(input: InboundMessageInput): Promise<void> {
  const hotel = await resolveHotel(input.inboundPhoneNumberId);
  const normalizedPhone = normalizePhone(input.from);
  const guest = await prisma.guest.upsert({
    where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: normalizedPhone } },
    update: {},
    create: { hotelId: hotel.id, phoneE164: normalizedPhone }
  });

  const conversation =
    (await prisma.conversation.findFirst({
      where: {
        hotelId: hotel.id,
        guestId: guest.id,
        state: {
          in: [
            DbConversationState.NEW,
            DbConversationState.QUALIFYING,
            DbConversationState.QUOTED,
            DbConversationState.PAYMENT_PENDING,
            DbConversationState.CONFIRMED
          ]
        }
      },
      orderBy: { updatedAt: "desc" }
    })) ??
    (await prisma.conversation.create({
      data: { hotelId: hotel.id, guestId: guest.id, state: DbConversationState.NEW, lastMessageAt: new Date() }
    }));

  let inboundMessageId: string | undefined;
  try {
    const createdInbound = await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        providerMessageId: input.messageId,
        direction: MessageDirection.INBOUND,
        body: input.text
      },
      select: { id: true }
    });
    inboundMessageId = createdInbound.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return;
    }
    throw err;
  }
  let guestJourneyOperationalReply: GuestJourneyOperationalReply | undefined;
  if (inboundMessageId) {
    try {
      guestJourneyOperationalReply = await handleGuestJourneyInboundReply({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        prismaMessageId: inboundMessageId,
        messageBody: input.text,
        providerMessageId: input.messageId
      });
    } catch (e) {
      console.error("guest journey reply notify:", e instanceof Error ? e.message : String(e));
    }
  }
  await createRoleRoutedNotification({
    hotelId: hotel.id,
    roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
    title: "New guest message",
    body: `${guest.fullName ?? guest.phoneE164} sent a new message.`,
    category: "messages",
    severity: "normal",
    link: `/admin/conversations/${encodeURIComponent(conversation.id)}`,
    sourceType: "CONVERSATION_MESSAGE_INBOUND",
    sourceId: conversation.id,
    requiresAttention: true
  }).catch(() => undefined);
  await logWhatsAppMessage({
    conversationId: conversation.id,
    phoneNumber: normalizedPhone,
    direction: "incoming",
    messageText: input.text
  });

  const persisted = await loadConversationSession({
    hotelId: hotel.id,
    guestId: guest.id,
    phoneE164: normalizedPhone,
    conversationId: conversation.id,
    defaultLanguage: "en"
  });

  const currentState = normalizeSessionState(persisted.stage);
  const conversationMode = getConversationMode(persisted.conversationMode);
  const normalizedInputText = normalizeText(input.text);
  const hasOperationalBookingContext =
    Boolean(persisted.bookingStep) ||
    isActiveBookingState(currentState) ||
    currentState === "confirmed" ||
    conversation.state === DbConversationState.CONFIRMED ||
    Boolean(persisted.checkIn && persisted.checkOut) ||
    Boolean(persisted.suggestedRoomTypeId || persisted.suggestedRoomTypeName || persisted.totalAmount);

  if (conversationMode === "AGENT_MODE") {
    return;
  }

  if (guestJourneyOperationalReply?.matched && guestJourneyOperationalReply.category) {
    let replyBody = "Thank you, we have noted your update and our team will coordinate with you if needed.";
    if (guestJourneyOperationalReply.category === "arrival_time_update") {
      const etaPart = guestJourneyOperationalReply.parsedEta
        ? ` around ${guestJourneyOperationalReply.parsedEta}`
        : " with your expected arrival time";
      replyBody = `Thank you, we have noted your arrival${etaPart}. We look forward to welcoming you. If you need parking, luggage assistance, or anything else before arrival, just reply here.`;
    } else if (guestJourneyOperationalReply.category === "late_arrival") {
      replyBody =
        "Thank you for letting us know. We have noted your late arrival. If your arrival time changes further or you need any assistance before reaching the resort, please reply here and our team will assist.";
    } else if (guestJourneyOperationalReply.category === "on_the_way") {
      replyBody =
        "Thank you, we have noted that you are on the way. We look forward to welcoming you. If you need parking or luggage assistance on arrival, please reply here.";
    } else if (guestJourneyOperationalReply.category === "arrival_support_request") {
      replyBody =
        "Thank you. We have noted your request and our team will coordinate with you. If you would like, you can also share your expected arrival time here.";
    } else if (guestJourneyOperationalReply.category === "early_checkin_request") {
      replyBody =
        "Thank you for your request. Early check-in is subject to availability. Our team will do their best to accommodate and will confirm closer to your arrival.";
    } else if (guestJourneyOperationalReply.category === "late_checkout_request") {
      replyBody =
        "Thank you for your request. Late check-out is subject to availability. We will do our best to accommodate and confirm it closer to your departure.";
    } else if (guestJourneyOperationalReply.category === "special_request") {
      replyBody = "Thank you for your request. We have noted it and our team will coordinate accordingly.";
    } else if (guestJourneyOperationalReply.category === "payment_issue") {
      replyBody =
        "Thank you for informing us. It seems there may have been an issue with the payment. Our team will review this and assist you shortly. If needed, we will guide you on the next step.";
    } else if (guestJourneyOperationalReply.category === "booking_modification") {
      replyBody =
        "Thank you for your request. We have noted your booking modification and our team will review availability and get back to you shortly.";
    } else if (guestJourneyOperationalReply.category === "cancellation_request") {
      replyBody =
        "Thank you for your request. We have received your cancellation request and will process it according to the booking policy. Our team will confirm shortly.";
    } else if (guestJourneyOperationalReply.category === "refund_request") {
      replyBody =
        "Thank you for your message. We have noted your refund request. Our team will review it based on the booking policy and update you shortly.";
    } else if (guestJourneyOperationalReply.category === "complaint") {
      replyBody =
        "We are very sorry to hear this. Thank you for bringing it to our attention. Our team will address this as soon as possible.";
    } else if (guestJourneyOperationalReply.category === "dissatisfaction") {
      replyBody =
        "We truly appreciate your feedback and are sorry your experience did not meet expectations. Our team will review this and assist you.";
    } else if (guestJourneyOperationalReply.category === "escalation") {
      replyBody =
        "We sincerely apologize for the inconvenience. Your concern is important to us and has been escalated to our team for immediate attention.";
    }
    await sendWhatsAppText({
      to: normalizedPhone,
      body: replyBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: replyBody,
        aiIntent: `GUEST_${guestJourneyOperationalReply.category.toUpperCase()}`,
        aiConfidence: 0.97
      }
    });
    if (guestJourneyOperationalReply.requiresStaffFollowUp) {
      const cat = guestJourneyOperationalReply.category;
      const followBody =
        cat === "late_arrival"
          ? `${guest.fullName ?? guest.phoneE164} reported a late arrival.`
          : cat === "arrival_support_request"
            ? `${guest.fullName ?? guest.phoneE164} requested arrival assistance.`
            : cat === "early_checkin_request"
              ? `${guest.fullName ?? guest.phoneE164} requested early check-in.`
              : cat === "late_checkout_request"
                ? `${guest.fullName ?? guest.phoneE164} requested late check-out.`
                : cat === "special_request"
                  ? `${guest.fullName ?? guest.phoneE164} sent a special request.`
                  : cat === "payment_issue"
                    ? `${guest.fullName ?? guest.phoneE164} reported a payment issue.`
                    : cat === "booking_modification"
                      ? `${guest.fullName ?? guest.phoneE164} requested a booking modification.`
                      : cat === "cancellation_request"
                        ? `${guest.fullName ?? guest.phoneE164} requested cancellation.`
                        : cat === "refund_request"
                          ? `${guest.fullName ?? guest.phoneE164} requested a refund.`
                          : cat === "complaint"
                            ? `${guest.fullName ?? guest.phoneE164} submitted a complaint.`
                            : cat === "dissatisfaction"
                              ? `${guest.fullName ?? guest.phoneE164} expressed dissatisfaction.`
                              : cat === "escalation"
                                ? `${guest.fullName ?? guest.phoneE164} escalated a concern.`
                                : `${guest.fullName ?? guest.phoneE164} needs operational follow-up.`;
      await createRoleRoutedNotification({
        hotelId: hotel.id,
        roles: guestJourneyOperationalReply.staffFollowUpRoles ?? [
          UserRole.FRONTDESK,
          UserRole.MANAGER,
          UserRole.STAFF
        ],
        title: "Guest operational request needs follow-up",
        body: followBody,
        category: "messages",
        severity: cat === "escalation" || cat === "complaint" ? "critical" : "high",
        link: `/admin/conversations/${encodeURIComponent(conversation.id)}`,
        sourceType: "CONVERSATION_MESSAGE_INBOUND",
        sourceId: conversation.id,
        requiresAttention: true
      }).catch(() => undefined);
    }
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  const orderFoodStayTap = normalizeMenuButtonInput(input.text).toLowerCase() === "order_food_stay";
  if (
    !persisted.fbCartDraft &&
    (conversationMode === "IDLE" || conversationMode === "QUESTION_MODE") &&
    (isStayFoodIntent(input.text) || orderFoodStayTap) &&
    !isGlobalResetMessage(input.text)
  ) {
    const stay = await findGuestActiveStayBooking(hotel.id, guest.id);
    if (stay) {
      const initDraft = { purpose: "stay" as const, step: "category" as const, cart: [], stayBookingId: stay.id };
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: persisted.stage || "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: conversationMode === "QUESTION_MODE" ? "QUESTION_MODE" : "IDLE",
          awaitingGuestName: false,
          awaitingBookingLookup: persisted.awaitingBookingLookup,
          myBookingCandidateIds: persisted.myBookingCandidateIds,
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount,
          fbCartDraft: initDraft
        }
      });
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: [initialFbOrderList("stay")]
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    await sendWhatsAppText({
      to: normalizedPhone,
      body: "We couldn’t find an active stay linked to this WhatsApp number. If you’re on property, please contact reception — or tap *Book* to plan a visit.",
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: "No active stay for food ordering.",
        aiIntent: "STAY_FOOD_NO_BOOKING",
        aiConfidence: 0.85
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (persisted.fbCartDraft) {
    const adv = await advanceFbCartDraft({
      hotelId: hotel.id,
      currency: hotel.currency,
      text: input.text,
      draft: persisted.fbCartDraft,
      hotelTimezone: hotel.timezone,
      now: new Date()
    });

    if (adv.stayFinished) {
      try {
        const notes = `[WhatsApp] Requested: ${adv.stayFinished.timeNote}`;
        await createFbOrdersFromMenuLines({
          hotelId: hotel.id,
          bookingId: adv.stayFinished.bookingId,
          guestId: guest.id,
          serviceMode: adv.stayFinished.serviceMode,
          notes,
          lines: adv.stayFinished.lines
        });
      } catch (err) {
        console.error("Stay F&B order post failed:", err instanceof Error ? err.message : String(err));
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "We couldn’t place the kitchen order just now. Please contact reception or try again shortly.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
    }

    let nextPrebook: PendingPrebookOrder | null | undefined = persisted.pendingPrebookOrder;
    let nextBookingStep = persisted.bookingStep;
    let nextStage = persisted.stage;
    let nextFlowReturn = persisted.bookingFlowReturn;
    if (adv.prebookFinished) {
      const est = await estimatePrebookOrderTotal(hotel.id, adv.prebookFinished.lines);
      nextPrebook = {
        lines: adv.prebookFinished.lines,
        serviceMode: adv.prebookFinished.serviceMode,
        timeNote: adv.prebookFinished.timeNote,
        estimatedTotal: est
      };
      nextBookingStep = undefined;
      nextStage = "quoted";
    }

    if (adv.viewFinished && persisted.bookingFlowReturn === "meal_plan") {
      nextFlowReturn = null;
      nextBookingStep = "meal_plan";
    }

    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: nextStage ?? persisted.stage,
        lastActivityAt: new Date().toISOString(),
        conversationMode: persisted.conversationMode || "BOOKING_MODE",
        awaitingGuestName: persisted.awaitingGuestName,
        awaitingBookingLookup: persisted.awaitingBookingLookup,
        myBookingCandidateIds: persisted.myBookingCandidateIds,
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        checkInOptions: persisted.checkInOptions,
        checkOutOptions: persisted.checkOutOptions,
        manualCheckInDate: persisted.manualCheckInDate,
        manualCheckOutDate: persisted.manualCheckOutDate,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        capacityPickRoomTypes: persisted.capacityPickRoomTypes,
        adultCount: persisted.adultCount,
        childCount: persisted.childCount,
        bookingRoomOffers: persisted.bookingRoomOffers,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nightlyRate: persisted.nightlyRate,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount,
        bookingStep: nextBookingStep,
        bookingMealPlanCode: persisted.bookingMealPlanCode,
        fbCartDraft: adv.draft ?? null,
        pendingPrebookOrder: nextPrebook ?? persisted.pendingPrebookOrder,
        bookingFlowReturn: nextFlowReturn
      }
    });

    if (adv.outbound.length && !adv.prebookFinished) {
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: adv.outbound
      });
    }

    if (adv.prebookFinished && nextPrebook !== undefined && nextPrebook !== null) {
      const adults = persisted.adultCount ?? persisted.guestCount ?? 2;
      const children = persisted.childCount ?? 0;
      const nights = persisted.nights ?? 1;
      const mp = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
      const mealPart = computeMealPlanSurchargeForStay({
        mealPlan: mp,
        adults,
        children,
        nights
      });
      const roomTotal = persisted.totalAmount ?? 0;
      const stayTotal = Number((roomTotal + mealPart).toFixed(2));
      const quoteBody = [
        "Here is your quote:",
        `Room type: ${persisted.suggestedRoomTypeName ?? "—"}`,
        `Check-in: ${persisted.checkIn}`,
        `Check-out: ${persisted.checkOut}`,
        `Guests: ${persisted.guestCount} (${adults} adults, ${children} children)`,
        `Nights: ${nights}`,
        `Room total: ${roomTotal.toFixed(2)} ${hotel.currency}`,
        mealPart > 0 ? `Meal plan: +${mealPart.toFixed(2)} ${hotel.currency} (${mp})` : `Meal plan: None`,
        nextPrebook.estimatedTotal > 0
          ? `Pre-booked F&B (posted to folio): ~${nextPrebook.estimatedTotal.toFixed(2)} ${hotel.currency}`
          : null,
        `Total stay (room + meal plan): ${stayTotal.toFixed(2)} ${hotel.currency}`,
        "",
        "Tap a button below or reply YES to confirm, EDIT to change, NO to cancel."
      ]
        .filter((x): x is string => typeof x === "string")
        .join("\n");
      try {
        await sendWhatsAppButtons({
          to: normalizedPhone,
          body: quoteBody,
          buttons: QUOTE_BUTTONS,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch (err) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: quoteBody,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: quoteBody,
          aiIntent: "BOOKING_QUOTED_WITH_MEALS",
          aiConfidence: 0.97
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: "quoted",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          awaitingGuestName: false,
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          adultCount: persisted.adultCount,
          childCount: persisted.childCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount,
          bookingMealPlanCode: persisted.bookingMealPlanCode,
          pendingPrebookOrder: nextPrebook,
          bookingStep: undefined,
          fbCartDraft: null,
          bookingFlowReturn: null
        }
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { state: DbConversationState.QUOTED, lastMessageAt: new Date() }
      });
      return;
    }

    if (adv.viewFinished && persisted.bookingFlowReturn === "meal_plan") {
      const mealList: FoodFlowOutbound = {
        kind: "list",
        body: "Choose your meal package for the stay:",
        buttonText: "Meal plan",
        sections: [
          {
            title: "Meal plan",
            rows: [
              { id: "mp_none", title: "No meal plan", description: "Room only" },
              { id: "mp_half", title: "Half board", description: "Breakfast + dinner" },
              { id: "mp_full", title: "Full board", description: "All main meals" },
              { id: "mp_view", title: "View menu", description: "Browse categories" }
            ]
          }
        ]
      };
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: [mealList]
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (needsLanguageSelection(persisted.language) && hasOperationalBookingContext) {
    // Keep guests in the active booking/service thread; avoid re-onboarding prompts mid-journey.
    persisted.language = "en";
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: "en",
        stage: persisted.stage || "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: persisted.conversationMode || "BOOKING_MODE",
        awaitingGuestName: persisted.awaitingGuestName,
        awaitingBookingLookup: persisted.awaitingBookingLookup,
        myBookingCandidateIds: persisted.myBookingCandidateIds,
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        checkInOptions: persisted.checkInOptions,
        checkOutOptions: persisted.checkOutOptions,
        manualCheckInDate: persisted.manualCheckInDate,
        manualCheckOutDate: persisted.manualCheckOutDate,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        capacityPickRoomTypes: persisted.capacityPickRoomTypes,
        adultCount: persisted.adultCount,
        childCount: persisted.childCount,
        bookingRoomOffers: persisted.bookingRoomOffers,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nightlyRate: persisted.nightlyRate,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount,
        bookingStep: persisted.bookingStep,
        bookingMealPlanCode: persisted.bookingMealPlanCode,
        fbCartDraft: persisted.fbCartDraft,
        pendingPrebookOrder: persisted.pendingPrebookOrder,
        bookingFlowReturn: persisted.bookingFlowReturn
      }
    });
    persisted.language = "en";
  }

  if (needsLanguageSelection(persisted.language)) {
    const chosenLang = isLanguageChoice(input.text);
    if (chosenLang === "ar" || chosenLang === "en") {
      const lang = chosenLang;
      persisted.language = lang;
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: lang,
          stage: "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "IDLE",
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: [],
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      const menuBody = getMainMenuBody(hotel.displayName, lang);
      const fallbackBody = buildMainMenuMessage(hotel.displayName, lang);
      const { recordedBody: outboundRecordedBody } = await sendMainMenuForGuest({
        hotel,
        guestId: guest.id,
        to: normalizedPhone,
        conversationId: conversation.id,
        menuBody,
        fallbackBody
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: outboundRecordedBody,
          aiIntent: "LANGUAGE_SELECTED_MAIN_MENU",
          aiConfidence: 0.98
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    try {
      await sendWhatsAppButtons({
        to: normalizedPhone,
        body: LANGUAGE_SELECT_PROMPT,
        buttons: LANGUAGE_BUTTONS,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    } catch (err) {
      console.error("WhatsApp language buttons send failed:", err instanceof Error ? err.message : String(err));
      await sendWhatsAppText({
        to: normalizedPhone,
        body: LANGUAGE_SELECT_FALLBACK,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    }
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: LANGUAGE_SELECT_PROMPT,
        aiIntent: "LANGUAGE_SELECT",
        aiConfidence: 0.98
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: "",
        stage: "IDLE",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "IDLE",
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (isGlobalResetMessage(input.text)) {
    persisted.awaitingBookingLookup = false;
    persisted.myBookingCandidateIds = [];
    persisted.awaitingGuestName = false;
    persisted.bookingStep = undefined;
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language ?? "",
        stage: "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "IDLE",
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [],
        bookingStep: undefined,
        phoneNumberId: persisted.phoneNumberId ?? hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        checkInOptions: persisted.checkInOptions,
        checkOutOptions: persisted.checkOutOptions,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        guestName: persisted.guestName,
        nightlyRate: persisted.nightlyRate,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount,
        bookingMealPlanCode: undefined,
        pendingPrebookOrder: null,
        fbCartDraft: null,
        bookingFlowReturn: null
      }
    });
    if (needsLanguageSelection(persisted.language)) {
      try {
        await sendWhatsAppButtons({
          to: normalizedPhone,
          body: LANGUAGE_SELECT_PROMPT,
          buttons: LANGUAGE_BUTTONS,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch (err) {
        console.error("WhatsApp language buttons send failed (global reset):", err instanceof Error ? err.message : String(err));
        await sendWhatsAppText({
          to: normalizedPhone,
          body: LANGUAGE_SELECT_FALLBACK,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: LANGUAGE_SELECT_PROMPT,
          aiIntent: "LANGUAGE_SELECT",
          aiConfidence: 0.98
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    const lang = effectiveLang(persisted.language);
    const menuBody = getMainMenuBody(hotel.displayName, lang);
    const fallbackBody = buildMainMenuMessage(hotel.displayName, lang);
    const { recordedBody: resetMenuRecorded } = await sendMainMenuForGuest({
      hotel,
      guestId: guest.id,
      to: normalizedPhone,
      conversationId: conversation.id,
      menuBody,
      fallbackBody
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: resetMenuRecorded,
        aiIntent: "GLOBAL_RESET_MAIN_MENU",
        aiConfidence: 0.98
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (isMenuChoiceTalkToAgent(input.text)) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { agentHandoffAt: new Date(), lastMessageAt: new Date() }
    });
    const handoffBody = guestReceptionistHandoffMessage(hotel.displayName);
    await sendWhatsAppText({
      to: normalizedPhone,
      body: handoffBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: handoffBody,
        aiIntent: "AGENT_HANDOFF",
        aiConfidence: 0.98
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "AGENT_MODE",
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (isMenuChoiceBookStay(input.text)) {
    if (persisted.bookingStep) {
      const lang = effectiveLang(persisted.language);
      const body =
        lang === "ar"
          ? "أنت في منتصف خطوات الحجز. تابع بإجابة السؤال الحالي، أو اكتب *قائمة* أو *menu* للعودة للقائمة الرئيسية وبدء حجز جديد."
          : "You're already in the booking flow. Reply with what this step asks for, or type *menu* to return to the main menu and start over.";
      await sendWhatsAppText({
        to: normalizedPhone,
        body,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body,
          aiIntent: "BOOKING_STEP_IGNORE_DUPLICATE_BOOK_TAP",
          aiConfidence: 0.95
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    try {
      await sendWhatsAppList({
        to: normalizedPhone,
        body: BOOKING_SUBMENU_BODY,
        buttonText: BOOKING_SUBMENU_LIST.buttonText,
        sections: BOOKING_SUBMENU_LIST.sections,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    } catch (err) {
      console.error("WhatsApp booking sub-menu list send failed, using text fallback:", err instanceof Error ? err.message : String(err));
      const fallbackBody = [
        BOOKING_SUBMENU_BODY,
        "1) Check availability",
        "2) View room types",
        "3) View offers",
        "4) View location and hotel information"
      ].join("\n");
      await sendWhatsAppText({
        to: normalizedPhone,
        body: fallbackBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    }
    const sentBody = BOOKING_SUBMENU_BODY;
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: sentBody,
        aiIntent: "MENU_BOOKING_SUBMENU",
        aiConfidence: 0.95
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "BOOKING_MODE",
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (conversationMode === "BOOKING_MODE" && getBookingSubMenuChoice(input.text)) {
    const choice = getBookingSubMenuChoice(input.text)!;
    if (choice === "check_availability") {
      const stepBody = "How many adults will be staying? (Reply with a number, e.g. 2)" + BOOKING_NAV_HINT;
      await sendWhatsAppText({
        to: normalizedPhone,
        body: stepBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: stepBody,
          aiIntent: "BOOKING_STEP_ADULTS",
          aiConfidence: 0.95
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          bookingStep: "adults",
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: [],
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    } else if (choice === "view_room_types") {
      const body = getRoomTypesForBookingSubmenu();
      await sendWhatsAppText({
        to: normalizedPhone,
        body,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body,
          aiIntent: "BOOKING_SUBMENU_ROOM_TYPES",
          aiConfidence: 0.95
        }
      });
      try {
        await sendWhatsAppList({
          to: normalizedPhone,
          body: BOOKING_SUBMENU_BODY,
          buttonText: BOOKING_SUBMENU_LIST.buttonText,
          sections: BOOKING_SUBMENU_LIST.sections,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Reply with: Check availability, View room types, View offers, or View location and hotel information.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
    } else if (choice === "view_offers") {
      const body = getOffersForBookingSubmenu();
      await sendWhatsAppText({
        to: normalizedPhone,
        body,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body,
          aiIntent: "BOOKING_SUBMENU_OFFERS",
          aiConfidence: 0.95
        }
      });
      try {
        await sendWhatsAppList({
          to: normalizedPhone,
          body: BOOKING_SUBMENU_BODY,
          buttonText: BOOKING_SUBMENU_LIST.buttonText,
          sections: BOOKING_SUBMENU_LIST.sections,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Reply with: Check availability, View room types, View offers, or View location and hotel information.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
    } else {
      const body = getLocationAndHotelInfoForSubmenu();
      await sendWhatsAppText({
        to: normalizedPhone,
        body,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body,
          aiIntent: "BOOKING_SUBMENU_LOCATION",
          aiConfidence: 0.95
        }
      });
      try {
        await sendWhatsAppList({
          to: normalizedPhone,
          body: BOOKING_SUBMENU_BODY,
          buttonText: BOOKING_SUBMENU_LIST.buttonText,
          sections: BOOKING_SUBMENU_LIST.sections,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Reply with: Check availability, View room types, View offers, or View location and hotel information.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
    }
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "BOOKING_MODE",
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (conversationMode === "BOOKING_MODE" && !persisted.bookingStep && isBackOneStepText(input.text)) {
    try {
      await sendWhatsAppList({
        to: normalizedPhone,
        body: BOOKING_SUBMENU_BODY,
        buttonText: BOOKING_SUBMENU_LIST.buttonText,
        sections: BOOKING_SUBMENU_LIST.sections,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    } catch {
      await sendWhatsAppText({
        to: normalizedPhone,
        body: "What would you like to do?\n1) Check availability\n2) View room types\n3) View offers\n4) View location and hotel information",
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    }
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: BOOKING_SUBMENU_BODY,
        aiIntent: "BOOKING_BACK_TO_SUBMENU_NO_STEP",
        aiConfidence: 0.95
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (
    conversationMode === "BOOKING_MODE" &&
    isBookingSummaryReturnText(input.text) &&
    (currentState === "quoted" || currentState === "awaiting_confirmation")
  ) {
    const hasSummaryPayload =
      Boolean(persisted.checkIn && persisted.checkOut) &&
      Boolean((persisted.suggestedRoomTypeName && persisted.suggestedRoomTypeName.trim()) || persisted.suggestedRoomTypeId) &&
      typeof persisted.guestCount === "number" &&
      persisted.guestCount > 0 &&
      typeof persisted.totalAmount === "number" &&
      Number.isFinite(persisted.totalAmount);
    if (!hasSummaryPayload && persisted.bookingStep) {
      const nearestStepByCurrent: Record<BookingStep, BookingStep> = {
        adults: "adults",
        children: "children",
        capacity_room_pick: "capacity_room_pick",
        rooms: "rooms",
        checkin: "checkin",
        checkout: "checkout",
        room_choice: "room_choice",
        meal_plan: "room_choice",
        meal_prebook_prompt: "meal_plan"
      };
      const nearest = nearestStepByCurrent[persisted.bookingStep as BookingStep] ?? "adults";
      const fallbackByStep: Record<BookingStep, string> = {
        adults: "How many adults will be staying? (Reply with a number, e.g. 2)",
        children: "How many children will be staying? (Reply with a number, e.g. 0 or 2)",
        capacity_room_pick: "Please choose a room type from the list above (open the list and tap a row).",
        rooms: "How many rooms do you need? (Reply with a number, e.g. 1 or 2)",
        checkin: "Please choose your check-in date from the list above, or type it as YYYY-MM-DD.",
        checkout: "Please choose your check-out date from the list above, or type it as YYYY-MM-DD.",
        room_choice: "Please select one of the room options from the list above, or reply with the room name.",
        meal_plan: "Please choose your meal package from the list above.",
        meal_prebook_prompt: "Please tap *Yes, browse menu* or *No, continue* from the list above."
      };
      const friendlyBody =
        "I can take you back to final confirmation once the booking details are complete. Let's continue from the nearest step.\n\n" +
        fallbackByStep[nearest];
      await sendWhatsAppText({
        to: normalizedPhone,
        body: friendlyBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: friendlyBody,
          aiIntent: "BOOKING_RETURN_TO_SUMMARY_INCOMPLETE",
          aiConfidence: 0.93
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: persisted.stage || "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          bookingStep: nearest,
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: persisted.myBookingCandidateIds,
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          checkInOptions: persisted.checkInOptions,
          checkOutOptions: persisted.checkOutOptions,
          manualCheckInDate: persisted.manualCheckInDate,
          manualCheckOutDate: persisted.manualCheckOutDate,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          capacityPickRoomTypes: persisted.capacityPickRoomTypes,
          adultCount: persisted.adultCount,
          childCount: persisted.childCount,
          bookingRoomOffers: persisted.bookingRoomOffers,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nightlyRate: persisted.nightlyRate,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount,
          bookingMealPlanCode: persisted.bookingMealPlanCode,
          fbCartDraft: persisted.fbCartDraft,
          pendingPrebookOrder: persisted.pendingPrebookOrder,
          bookingFlowReturn: persisted.bookingFlowReturn
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (!hasSummaryPayload) {
      // Keep existing behavior for non-step contexts when quote payload is not ready.
      await sendWhatsAppText({
        to: normalizedPhone,
        body: "I don't have a complete booking summary yet. Please continue with the booking details first.",
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (persisted.bookingStep) {
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: persisted.stage || "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          bookingStep: undefined,
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: persisted.myBookingCandidateIds,
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          checkInOptions: persisted.checkInOptions,
          checkOutOptions: persisted.checkOutOptions,
          manualCheckInDate: persisted.manualCheckInDate,
          manualCheckOutDate: persisted.manualCheckOutDate,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          capacityPickRoomTypes: persisted.capacityPickRoomTypes,
          adultCount: persisted.adultCount,
          childCount: persisted.childCount,
          bookingRoomOffers: persisted.bookingRoomOffers,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nightlyRate: persisted.nightlyRate,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount,
          bookingMealPlanCode: persisted.bookingMealPlanCode,
          fbCartDraft: persisted.fbCartDraft,
          pendingPrebookOrder: persisted.pendingPrebookOrder,
          bookingFlowReturn: persisted.bookingFlowReturn
        }
      });
    }
    const adults = persisted.adultCount ?? persisted.guestCount ?? 2;
    const children = persisted.childCount ?? 0;
    const nights = persisted.nights ?? 1;
    const roomTotal = persisted.totalAmount ?? 0;
    const mp = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
    const mealPart = computeMealPlanSurchargeForStay({ mealPlan: mp, adults, children, nights });
    const stayTotal = Number((roomTotal + mealPart).toFixed(2));
    const quoteBody = [
      "Here is your quote:",
      `Room type: ${persisted.suggestedRoomTypeName ?? "—"}`,
      `Check-in: ${persisted.checkIn}`,
      `Check-out: ${persisted.checkOut}`,
      `Guests: ${persisted.guestCount ?? adults + children} (${adults} adults, ${children} children)`,
      `Nights: ${nights}`,
      `Room total: ${roomTotal.toFixed(2)} ${hotel.currency}`,
      mealPart > 0 ? `Meal plan: +${mealPart.toFixed(2)} ${hotel.currency} (${mp})` : "Meal plan: None",
      `Total stay (room + meal plan): ${stayTotal.toFixed(2)} ${hotel.currency}`,
      "",
      "Tap a button below or reply YES to confirm, EDIT to change, NO to cancel."
    ].join("\n");
    try {
      await sendWhatsAppButtons({
        to: normalizedPhone,
        body: quoteBody,
        buttons: QUOTE_BUTTONS,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    } catch {
      await sendWhatsAppText({
        to: normalizedPhone,
        body: quoteBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    }
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: quoteBody,
        aiIntent: "BOOKING_RETURN_TO_SUMMARY",
        aiConfidence: 0.95
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (conversationMode === "BOOKING_MODE" && persisted.bookingStep) {
    const step = persisted.bookingStep as BookingStep;
    const baseState = {
      language: persisted.language || "en",
      lastActivityAt: new Date().toISOString(),
      conversationMode: "BOOKING_MODE" as const,
      awaitingGuestName: false,
      awaitingBookingLookup: false,
      myBookingCandidateIds: [] as string[],
      phoneNumberId: hotel.phoneNumberId,
      checkIn: persisted.checkIn,
      checkOut: persisted.checkOut,
      guestCount: persisted.guestCount,
      roomCount: persisted.roomCount,
      capacityPickRoomTypes: persisted.capacityPickRoomTypes,
      suggestedRoomTypeId: persisted.suggestedRoomTypeId,
      suggestedRoomTypeName: persisted.suggestedRoomTypeName,
      suggestedPropertyId: persisted.suggestedPropertyId,
      nights: persisted.nights,
      totalAmount: persisted.totalAmount
    };

    function previousBookingStep(s: BookingStep): BookingStep | "submenu" {
      switch (s) {
        case "adults":
          return "submenu";
        case "children":
          return "adults";
        case "capacity_room_pick":
          return "children";
        case "rooms":
          return "children";
        case "checkin":
          return "capacity_room_pick";
        case "checkout":
          return "checkin";
        case "room_choice":
          return "checkout";
        case "meal_plan":
          return "room_choice";
        case "meal_prebook_prompt":
          return "meal_plan";
        default:
          return "submenu";
      }
    }

    if (isBackOneStepText(input.text)) {
      const prev = previousBookingStep(step);
      if (prev === "submenu") {
        try {
          await sendWhatsAppList({
            to: normalizedPhone,
            body: BOOKING_SUBMENU_BODY,
            buttonText: BOOKING_SUBMENU_LIST.buttonText,
            sections: BOOKING_SUBMENU_LIST.sections,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        } catch (err) {
          console.error("WhatsApp booking sub-menu list send failed (back):", err instanceof Error ? err.message : String(err));
          await sendWhatsAppText({
            to: normalizedPhone,
            body: [
              BOOKING_SUBMENU_BODY,
              "1) Check availability",
              "2) View room types",
              "3) View offers",
              "4) View location and hotel information"
            ].join("\n"),
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        }
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: BOOKING_SUBMENU_BODY,
            aiIntent: "BOOKING_BACK_TO_SUBMENU",
            aiConfidence: 0.95
          }
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: undefined,
            adultCount: undefined,
            childCount: undefined,
            capacityPickRoomTypes: undefined
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }

      let backBody = "";
      if (prev === "adults") {
        backBody = "How many adults will be staying? (Reply with a number, e.g. 2)" + BOOKING_NAV_HINT;
      } else if (prev === "children") {
        backBody = "How many children will be staying? (Reply with a number, e.g. 0 or 2)";
      } else if (prev === "rooms") {
        backBody = "How many rooms do you need? (Reply with a number, e.g. 1 or 2)";
      }

      if (prev === "room_choice") {
        const offers = persisted.bookingRoomOffers ?? [];
        if (offers.length === 0) {
          await sendWhatsAppText({
            to: normalizedPhone,
            body: "Reply *menu* to restart booking, or continue from the main menu.",
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
          await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
          return;
        }
        const listBody = `We have ${offers.length} room option(s) for your dates. Please choose one:`;
        const sections = [
          {
            title: "Room options",
            rows: offers.slice(0, 10).map((o) => ({
              id: o.roomTypeId,
              title: `${o.roomTypeName} – ${o.total.toFixed(2)} ${hotel.currency}`.slice(0, 24)
            }))
          }
        ];
        try {
          await sendWhatsAppList({
            to: normalizedPhone,
            body: listBody,
            buttonText: "Choose room",
            sections,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        } catch (err) {
          console.error("WhatsApp room list send failed (back):", err instanceof Error ? err.message : String(err));
          await sendWhatsAppText({
            to: normalizedPhone,
            body: listBody + "\n\n" + offers.map((o) => `• ${o.roomTypeName}: ${o.total.toFixed(2)} ${hotel.currency}`).join("\n"),
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        }
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "room_choice",
            adultCount: persisted.adultCount,
            childCount: persisted.childCount,
            guestCount: persisted.guestCount,
            roomCount: persisted.roomCount,
            checkIn: persisted.checkIn,
            checkOut: persisted.checkOut,
            bookingRoomOffers: offers,
            bookingMealPlanCode: null,
            pendingPrebookOrder: null,
            fbCartDraft: null,
            bookingFlowReturn: null
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }

      if (prev === "meal_plan") {
        const mealOutbound: FoodFlowOutbound = {
          kind: "list",
          body: "Choose your meal package for this stay (you can browse our restaurant menu):",
          buttonText: "Meal plan",
          sections: [
            {
              title: "Packages",
              rows: [
                { id: "mp_none", title: "No meal plan", description: "Room only" },
                { id: "mp_half", title: "Half board", description: "Breakfast + dinner" },
                { id: "mp_full", title: "Full board", description: "All main meals" },
                { id: "mp_view", title: "View menu", description: "Browse categories" }
              ]
            }
          ]
        };
        await sendFoodFlowOutbounds({
          hotelId: hotel.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id,
          outbounds: [mealOutbound]
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "meal_plan",
            bookingRoomOffers: persisted.bookingRoomOffers,
            bookingMealPlanCode: null,
            pendingPrebookOrder: null,
            fbCartDraft: null,
            bookingFlowReturn: null
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }

      const commonBack = {
        language: persisted.language || "en",
        stage: "new" as const,
        lastActivityAt: new Date().toISOString(),
        conversationMode: "BOOKING_MODE" as const,
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [] as string[],
        phoneNumberId: hotel.phoneNumberId,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      };

      if (prev === "capacity_room_pick") {
        const adults = persisted.adultCount ?? 1;
        const children = persisted.childCount ?? 0;
        const eligible = await getEligibleRoomTypesForBookingFlow(hotel.id, adults, children);
        const mapped = eligible.map((t) => ({
          roomTypeId: t.id,
          name: t.name,
          capacity: t.capacity,
          baseNightlyRate: t.baseNightlyRate,
          propertyId: t.propertyId
        }));
        if (eligible.length === 0) {
          const largest = await getLargestRoomTypesForFallback(hotel.id, 3);
          const hint =
            largest.length > 0
              ? "\n\nLargest room types here:\n" + largest.map((r) => `• ${r.name} (up to ${r.capacity} guests)`).join("\n")
              : "";
          await sendWhatsAppText({
            to: normalizedPhone,
            body: `No single room fits ${adults + children} guests.${hint}\n\nWe can arrange multiple rooms — reply *menu* to contact reception, or *back* to change guest numbers.`,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
          await prisma.message.create({
            data: {
              hotelId: hotel.id,
              conversationId: conversation.id,
              direction: MessageDirection.OUTBOUND,
              body: `No single room fits ${adults + children} guests.`,
              aiIntent: "BOOKING_STEP_BACK_CAPACITY_NONE",
              aiConfidence: 0.9
            }
          });
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...commonBack,
              bookingStep: "children",
              adultCount: adults,
              childCount: undefined,
              guestCount: adults,
              roomCount: undefined,
              checkIn: undefined,
              checkOut: undefined,
              capacityPickRoomTypes: undefined,
              suggestedRoomTypeId: undefined,
              suggestedRoomTypeName: undefined,
              suggestedPropertyId: undefined,
              bookingRoomOffers: undefined,
              manualCheckInDate: false,
              manualCheckOutDate: false
            }
          });
          await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
          return;
        }
        await sendCapacityRoomTypePickList({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          currency: hotel.currency,
          adults,
          children,
          types: eligible
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...commonBack,
            bookingStep: "capacity_room_pick",
            adultCount: adults,
            childCount: children,
            guestCount: adults + children,
            roomCount: undefined,
            checkIn: undefined,
            checkOut: undefined,
            capacityPickRoomTypes: mapped,
            suggestedRoomTypeId: undefined,
            suggestedRoomTypeName: undefined,
            suggestedPropertyId: undefined,
            bookingRoomOffers: undefined,
            manualCheckInDate: false,
            manualCheckOutDate: false
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }

      if (prev === "checkin") {
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...commonBack,
            bookingStep: "checkin",
            adultCount: persisted.adultCount,
            childCount: persisted.childCount,
            guestCount: persisted.guestCount,
            roomCount: persisted.roomCount,
            checkIn: undefined,
            checkOut: undefined,
            capacityPickRoomTypes: persisted.capacityPickRoomTypes,
            bookingRoomOffers: undefined,
            manualCheckInDate: false,
            manualCheckOutDate: false
          }
        });
        await sendBookingCheckInPrompt({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (prev === "checkout") {
        if (!persisted.checkIn) {
          await sendWhatsAppText({
            to: normalizedPhone,
            body: "Reply *menu* to start again.",
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
          await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
          return;
        }
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...commonBack,
            bookingStep: "checkout",
            adultCount: persisted.adultCount,
            childCount: persisted.childCount,
            guestCount: persisted.guestCount,
            roomCount: persisted.roomCount,
            checkIn: persisted.checkIn,
            checkOut: undefined,
            capacityPickRoomTypes: persisted.capacityPickRoomTypes,
            bookingRoomOffers: undefined,
            manualCheckOutDate: false
          }
        });
        await sendBookingCheckOutPrompt({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          checkInIso: persisted.checkIn
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }

      if (backBody) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: backBody,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: backBody,
            aiIntent: "BOOKING_STEP_BACK",
            aiConfidence: 0.95
          }
        });
        if (prev === "adults") {
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...commonBack,
              bookingStep: "adults",
              checkIn: undefined,
              checkOut: undefined,
              guestCount: undefined,
              roomCount: undefined,
              adultCount: undefined,
              childCount: undefined,
              bookingRoomOffers: undefined
            }
          });
        } else if (prev === "children") {
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...commonBack,
              bookingStep: "children",
              adultCount: persisted.adultCount,
              childCount: undefined,
              guestCount: persisted.adultCount,
              roomCount: undefined,
              checkIn: undefined,
              checkOut: undefined,
              capacityPickRoomTypes: undefined,
              bookingRoomOffers: undefined
            }
          });
        } else if (prev === "rooms") {
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...commonBack,
              bookingStep: "rooms",
              adultCount: persisted.adultCount,
              childCount: persisted.childCount,
              guestCount: (persisted.adultCount ?? 1) + (persisted.childCount ?? 0),
              roomCount: undefined,
              checkIn: undefined,
              checkOut: undefined,
              bookingRoomOffers: undefined
            }
          });
        }
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
    }

    if (step === "adults") {
      const num = parseStepNumber(input.text, 20);
      if (num === null) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Please reply with the number of adults (e.g. 1, 2, or 3).",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "Please reply with the number of adults (e.g. 1, 2, or 3).",
            aiIntent: "BOOKING_STEP_ADULTS_INVALID",
            aiConfidence: 0.9
          }
        });
      } else {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "How many children will be staying? (Reply with a number, e.g. 0 or 2)",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "How many children will be staying? (Reply with a number, e.g. 0 or 2)",
            aiIntent: "BOOKING_STEP_CHILDREN",
            aiConfidence: 0.95
          }
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "children",
            adultCount: num,
            childCount: persisted.childCount
          }
        });
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "children") {
      const num = parseStepNumber(input.text, 20, true);
      if (num === null) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Please reply with the number of children (e.g. 0, 1, or 2).",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "Please reply with the number of children (e.g. 0, 1, or 2).",
            aiIntent: "BOOKING_STEP_CHILDREN_INVALID",
            aiConfidence: 0.9
          }
        });
      } else {
        const adults = persisted.adultCount ?? 1;
        const totalGuests = adults + num;
        const eligible = await getEligibleRoomTypesForBookingFlow(hotel.id, adults, num);
        const mapped = eligible.map((t) => ({
          roomTypeId: t.id,
          name: t.name,
          capacity: t.capacity,
          baseNightlyRate: t.baseNightlyRate,
          propertyId: t.propertyId
        }));
        if (eligible.length === 0) {
          const largest = await getLargestRoomTypesForFallback(hotel.id, 3);
          const hint =
            largest.length > 0
              ? "\n\nOur largest options:\n" + largest.map((r) => `• ${r.name} (up to ${r.capacity} guests)`).join("\n")
              : "";
          const noFitBody = `No single room fits your group of ${totalGuests} guest(s).${hint}\n\nWe can arrange *multiple rooms* — reply *menu* to contact reception, or *back* to change guest numbers.`;
          await sendWhatsAppText({
            to: normalizedPhone,
            body: noFitBody,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
          await prisma.message.create({
            data: {
              hotelId: hotel.id,
              conversationId: conversation.id,
              direction: MessageDirection.OUTBOUND,
              body: noFitBody,
              aiIntent: "BOOKING_STEP_NO_CAPACITY_ROOM",
              aiConfidence: 0.95
            }
          });
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...baseState,
              stage: "new",
              bookingStep: "children",
              adultCount: adults,
              childCount: num,
              guestCount: totalGuests,
              roomCount: undefined,
              capacityPickRoomTypes: undefined
            }
          });
        } else {
          await sendCapacityRoomTypePickList({
            hotelId: hotel.id,
            conversationId: conversation.id,
            to: normalizedPhone,
            phoneNumberId: hotel.phoneNumberId,
            currency: hotel.currency,
            adults,
            children: num,
            types: eligible
          });
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...baseState,
              stage: "new",
              bookingStep: "capacity_room_pick",
              adultCount: adults,
              childCount: num,
              guestCount: totalGuests,
              roomCount: 1,
              capacityPickRoomTypes: mapped
            }
          });
        }
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "capacity_room_pick") {
      const chosenId = input.text.trim();
      const adults = persisted.adultCount ?? 1;
      const children = persisted.childCount ?? 0;
      const totalGuests = adults + children;
      const allowedIds = new Set((persisted.capacityPickRoomTypes ?? []).map((x) => x.roomTypeId));
      let resolved =
        allowedIds.has(chosenId) ? (persisted.capacityPickRoomTypes ?? []).find((x) => x.roomTypeId === chosenId) : undefined;
      if (!resolved) {
        const rt = await prisma.roomType.findFirst({
          where: { id: chosenId, hotelId: hotel.id, isActive: true, capacity: { gte: totalGuests } }
        });
        if (rt && roomTypeAllowsOccupancy(rt.code, adults, children).ok) {
          resolved = {
            roomTypeId: rt.id,
            name: rt.name,
            capacity: rt.capacity,
            baseNightlyRate: rt.baseNightlyRate,
            propertyId: rt.propertyId
          };
        }
      }
      if (!resolved) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Please choose a room type from the list above (open the list and tap a row).",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "Please choose a room type from the list above (open the list and tap a row).",
            aiIntent: "BOOKING_STEP_CAPACITY_ROOM_INVALID",
            aiConfidence: 0.9
          }
        });
      } else {
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "checkin",
            adultCount: adults,
            childCount: children,
            guestCount: totalGuests,
            roomCount: 1,
            suggestedRoomTypeId: resolved.roomTypeId,
            suggestedRoomTypeName: resolved.name,
            suggestedPropertyId: resolved.propertyId,
            capacityPickRoomTypes: persisted.capacityPickRoomTypes,
            manualCheckInDate: false,
            manualCheckOutDate: false
          }
        });
        await sendBookingCheckInPrompt({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId
        });
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "rooms") {
      const num = parseStepNumber(input.text, 10);
      if (num === null) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Please reply with the number of rooms (e.g. 1 or 2).",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "Please reply with the number of rooms (e.g. 1 or 2).",
            aiIntent: "BOOKING_STEP_ROOMS_INVALID",
            aiConfidence: 0.9
          }
        });
      } else {
        const adults = persisted.adultCount ?? 1;
        const children = persisted.childCount ?? 0;
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "checkin",
            adultCount: adults,
            childCount: children,
            guestCount: adults + children,
            roomCount: num,
            manualCheckInDate: false,
            manualCheckOutDate: false
          }
        });
        await sendBookingCheckInPrompt({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId
        });
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "checkin") {
      const rawTrim = input.text.trim();
      const todayCutoff = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

      const listPick = parseCheckInListId(rawTrim);
      if (listPick === "other") {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Please type your check-in date as YYYY-MM-DD (e.g. 2026-05-15). Use today or a future date.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "Please type your check-in date as YYYY-MM-DD (e.g. 2026-05-15). Use today or a future date.",
            aiIntent: "BOOKING_STEP_CHECKIN_MANUAL",
            aiConfidence: 0.95
          }
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "checkin",
            adultCount: persisted.adultCount ?? 1,
            childCount: persisted.childCount ?? 0,
            guestCount: persisted.guestCount ?? 1,
            roomCount: persisted.roomCount ?? 1,
            manualCheckInDate: true
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }

      let isoCandidate: string | null = null;
      if (listPick && "iso" in listPick) {
        isoCandidate = listPick.iso;
      }
      const digitIso = parseCheckInDigitReply(rawTrim);
      if (digitIso) {
        isoCandidate = digitIso;
      }
      if (!isoCandidate && persisted.manualCheckInDate && /^\d{4}-\d{2}-\d{2}$/.test(rawTrim)) {
        isoCandidate = rawTrim;
      }
      if (!isoCandidate) {
        const parsed = parseGuestMessage(input.text);
        const dateStr = parsed.checkIn
          ? parsed.checkIn.toISOString().slice(0, 10)
          : /^\d{4}-\d{2}-\d{2}$/.test(rawTrim)
            ? rawTrim
            : null;
        if (dateStr) {
          isoCandidate = dateStr;
        }
        if (!isoCandidate && parsed.checkIn) {
          const d = parsed.checkIn;
          if (d >= todayCutoff) {
            isoCandidate = d.toISOString().slice(0, 10);
          }
        }
      }

      let checkInDate: Date | null = null;
      if (isoCandidate) {
        const d = new Date(isoCandidate + "T12:00:00Z");
        if (Number.isFinite(d.getTime()) && d >= todayCutoff) {
          checkInDate = d;
        }
      }

      if (!checkInDate) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body:
            "That check-in date isn't valid. Pick a date from the list, tap *Other date* and type YYYY-MM-DD, or use today or a future date (YYYY-MM-DD).",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body:
              "That check-in date isn't valid. Pick a date from the list, tap *Other date* and type YYYY-MM-DD, or use today or a future date (YYYY-MM-DD).",
            aiIntent: "BOOKING_STEP_CHECKIN_INVALID",
            aiConfidence: 0.9
          }
        });
      } else {
        const checkInIso = checkInDate.toISOString().slice(0, 10);
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "checkout",
            adultCount: persisted.adultCount ?? 1,
            childCount: persisted.childCount ?? 0,
            guestCount: persisted.guestCount ?? 1,
            roomCount: persisted.roomCount ?? 1,
            checkIn: checkInIso,
            manualCheckInDate: false,
            manualCheckOutDate: false
          }
        });
        await sendBookingCheckOutPrompt({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          checkInIso
        });
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "checkout") {
      const rawTrim = input.text.trim();
      const checkInStr = persisted.checkIn;
      if (!checkInStr) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "We couldn't find your check-in date. Reply *menu* to start again.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "We couldn't find your check-in date. Reply *menu* to start again.",
            aiIntent: "BOOKING_STEP_CHECKOUT_ERROR",
            aiConfidence: 0.9
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      const checkInDate = new Date(checkInStr + "T12:00:00Z");

      const listPick = parseCheckOutListId(rawTrim);
      if (listPick === "other") {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Please type your check-out date as YYYY-MM-DD. It must be the day *after* your check-in.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "Please type your check-out date as YYYY-MM-DD. It must be the day *after* your check-in.",
            aiIntent: "BOOKING_STEP_CHECKOUT_MANUAL",
            aiConfidence: 0.95
          }
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "checkout",
            adultCount: persisted.adultCount,
            childCount: persisted.childCount,
            guestCount: persisted.guestCount ?? 1,
            roomCount: persisted.roomCount ?? 1,
            checkIn: checkInStr,
            manualCheckOutDate: true
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }

      let isoCandidate: string | null = null;
      if (listPick && "iso" in listPick) {
        isoCandidate = listPick.iso;
      }
      const digitIso = parseCheckOutDigitReply(checkInStr, rawTrim);
      if (digitIso) {
        isoCandidate = digitIso;
      }
      if (!isoCandidate && persisted.manualCheckOutDate && /^\d{4}-\d{2}-\d{2}$/.test(rawTrim)) {
        isoCandidate = rawTrim;
      }
      if (!isoCandidate) {
        const parsed = parseGuestMessage(input.text);
        const dateStr = parsed.checkOut
          ? parsed.checkOut.toISOString().slice(0, 10)
          : parsed.checkIn
            ? undefined
            : /^\d{4}-\d{2}-\d{2}$/.test(rawTrim)
              ? rawTrim
              : null;
        if (dateStr) {
          isoCandidate = dateStr;
        }
        if (!isoCandidate && parsed.checkOut) {
          isoCandidate = parsed.checkOut.toISOString().slice(0, 10);
        }
      }

      let checkOutDate: Date | null = null;
      if (isoCandidate) {
        const d = new Date(isoCandidate + "T12:00:00Z");
        if (Number.isFinite(d.getTime())) {
          checkOutDate = d;
        }
      }

      if (!checkOutDate || checkOutDate <= checkInDate) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body:
            "Check-out must be a day *after* check-in. Pick a date from the list, tap *Other date*, or type YYYY-MM-DD (e.g. 2026-04-20).",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body:
              "Check-out must be a day *after* check-in. Pick a date from the list, tap *Other date*, or type YYYY-MM-DD (e.g. 2026-04-20).",
            aiIntent: "BOOKING_STEP_CHECKOUT_INVALID",
            aiConfidence: 0.9
          }
        });
      } else {
        const guests = persisted.guestCount ?? 1;
        const rooms = persisted.roomCount ?? 1;
        const offers = await findAvailableRoomTypes({
          hotelId: hotel.id,
          checkIn: checkInDate,
          checkOut: checkOutDate,
          guests,
          rooms,
          ...(typeof persisted.adultCount === "number" && typeof persisted.childCount === "number"
            ? { adults: persisted.adultCount, children: persisted.childCount }
            : {})
        });
        if (offers.length === 0) {
          await sendWhatsAppText({
            to: normalizedPhone,
            body: "Sorry, no rooms are available for these dates. Please try different dates.",
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
          await prisma.message.create({
            data: {
              hotelId: hotel.id,
              conversationId: conversation.id,
              direction: MessageDirection.OUTBOUND,
              body: "Sorry, no rooms are available for these dates. Please try different dates.",
              aiIntent: "BOOKING_STEP_NO_AVAILABILITY",
              aiConfidence: 0.95
            }
          });
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...baseState,
              stage: "new",
              bookingStep: "checkout",
              adultCount: persisted.adultCount,
              childCount: persisted.childCount,
              guestCount: guests,
              roomCount: rooms,
              checkIn: persisted.checkIn,
              checkOut: undefined,
              manualCheckOutDate: false
            }
          });
        } else {
          const listBody = `We have ${offers.length} room option(s) for your dates. Please choose one:`;
          const sections = [
            {
              title: "Room options",
              rows: offers.slice(0, 10).map((o) => ({
                id: o.roomTypeId,
                title: `${o.roomTypeName} – ${o.total.toFixed(2)} ${hotel.currency}`.slice(0, 24)
              }))
            }
          ];
          try {
            await sendWhatsAppList({
              to: normalizedPhone,
              body: listBody,
              buttonText: "Choose room",
              sections,
              phoneNumberId: hotel.phoneNumberId,
              conversationId: conversation.id
            });
          } catch (err) {
            console.error("WhatsApp room list send failed:", err instanceof Error ? err.message : String(err));
            await sendWhatsAppText({
              to: normalizedPhone,
              body: listBody + "\n\n" + offers.map((o) => `• ${o.roomTypeName}: ${o.total.toFixed(2)} ${hotel.currency}`).join("\n"),
              phoneNumberId: hotel.phoneNumberId,
              conversationId: conversation.id
            });
          }
          await prisma.message.create({
            data: {
              hotelId: hotel.id,
              conversationId: conversation.id,
              direction: MessageDirection.OUTBOUND,
              body: listBody,
              aiIntent: "BOOKING_STEP_ROOM_CHOICE",
              aiConfidence: 0.95
            }
          });
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...baseState,
              stage: "new",
              bookingStep: "room_choice",
              adultCount: persisted.adultCount,
              childCount: persisted.childCount,
              guestCount: guests,
              roomCount: rooms,
              checkIn: persisted.checkIn,
              checkOut: checkOutDate.toISOString().slice(0, 10),
              manualCheckOutDate: false,
              bookingRoomOffers: offers.map((o) => ({
                roomTypeId: o.roomTypeId,
                roomTypeName: o.roomTypeName,
                propertyId: o.propertyId,
                total: o.total,
                nights: o.nights
              }))
            }
          });
        }
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "meal_plan") {
      const t = input.text.trim();
      const mealOutbound: FoodFlowOutbound = {
        kind: "list",
        body: "Choose your meal package:",
        buttonText: "Meal plan",
        sections: [
          {
            title: "Packages",
            rows: [
              { id: "mp_none", title: "No meal plan", description: "Room only" },
              { id: "mp_half", title: "Half board", description: "Breakfast + dinner" },
              { id: "mp_full", title: "Full board", description: "All main meals" },
              { id: "mp_view", title: "View menu", description: "Browse categories" }
            ]
          }
        ]
      };
      if (t.includes("mp_view")) {
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "meal_plan",
            bookingFlowReturn: "meal_plan",
            fbCartDraft: { purpose: "meal_plan_view", step: "category", cart: [] },
            bookingRoomOffers: persisted.bookingRoomOffers,
            suggestedRoomTypeId: persisted.suggestedRoomTypeId,
            suggestedRoomTypeName: persisted.suggestedRoomTypeName,
            suggestedPropertyId: persisted.suggestedPropertyId,
            nights: persisted.nights,
            totalAmount: persisted.totalAmount
          }
        });
        await sendFoodFlowOutbounds({
          hotelId: hotel.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id,
          outbounds: [initialFbOrderList("meal_plan_view")]
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      let code: WhatsAppMealPlanCode = "NONE";
      if (t.includes("mp_half")) code = "HALF_BOARD";
      else if (t.includes("mp_full")) code = "FULL_BOARD";
      else if (t.includes("mp_none")) code = "NONE";
      else {
        await sendFoodFlowOutbounds({
          hotelId: hotel.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id,
          outbounds: [mealOutbound]
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      const preBody: FoodFlowOutbound = {
        kind: "list",
        body: "Would you like to pre-book any meals or drinks before you arrive? (Charged to your room folio.)",
        buttonText: "Pre-book",
        sections: [
          {
            title: "Pre-book",
            rows: [
              { id: "pre_yes", title: "Yes, browse menu", description: "Build an order" },
              { id: "pre_no", title: "No, continue", description: "Skip to quote" }
            ]
          }
        ]
      };
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: [preBody]
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          ...baseState,
          stage: "new",
          bookingStep: "meal_prebook_prompt",
          bookingMealPlanCode: code,
          bookingRoomOffers: persisted.bookingRoomOffers,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "meal_prebook_prompt") {
      const t = input.text.trim();
      if (t.includes("pre_yes")) {
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: undefined,
            fbCartDraft: { purpose: "booking_prebook", step: "category", cart: [] },
            bookingMealPlanCode: persisted.bookingMealPlanCode,
            bookingRoomOffers: persisted.bookingRoomOffers,
            suggestedRoomTypeId: persisted.suggestedRoomTypeId,
            suggestedRoomTypeName: persisted.suggestedRoomTypeName,
            suggestedPropertyId: persisted.suggestedPropertyId,
            nights: persisted.nights,
            totalAmount: persisted.totalAmount
          }
        });
        await sendFoodFlowOutbounds({
          hotelId: hotel.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id,
          outbounds: [initialFbOrderList("booking_prebook")]
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (t.includes("pre_no")) {
        const adults = persisted.adultCount ?? persisted.guestCount ?? 2;
        const children = persisted.childCount ?? 0;
        const nights = persisted.nights ?? 1;
        const mp = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
        const mealPart = computeMealPlanSurchargeForStay({ mealPlan: mp, adults, children, nights });
        const roomTotal = persisted.totalAmount ?? 0;
        const stayTotal = Number((roomTotal + mealPart).toFixed(2));
        const quoteBody = [
          "Here is your quote:",
          `Room type: ${persisted.suggestedRoomTypeName ?? "—"}`,
          `Check-in: ${persisted.checkIn}`,
          `Check-out: ${persisted.checkOut}`,
          `Guests: ${persisted.guestCount} (${adults} adults, ${children} children)`,
          `Nights: ${nights}`,
          `Room total: ${roomTotal.toFixed(2)} ${hotel.currency}`,
          mealPart > 0 ? `Meal plan: +${mealPart.toFixed(2)} ${hotel.currency} (${mp})` : `Meal plan: None`,
          `Total stay (room + meal plan): ${stayTotal.toFixed(2)} ${hotel.currency}`,
          "",
          "Tap a button below or reply YES to confirm, EDIT to change, NO to cancel."
        ]
          .filter((x): x is string => typeof x === "string")
          .join("\n");
        try {
          await sendWhatsAppButtons({
            to: normalizedPhone,
            body: quoteBody,
            buttons: QUOTE_BUTTONS,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        } catch (err) {
          await sendWhatsAppText({
            to: normalizedPhone,
            body: quoteBody,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        }
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: quoteBody,
            aiIntent: "BOOKING_QUOTED_MEALS",
            aiConfidence: 0.97
          }
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "quoted",
            bookingStep: undefined,
            bookingRoomOffers: undefined,
            adultCount: persisted.adultCount,
            childCount: persisted.childCount,
            guestCount: persisted.guestCount ?? 1,
            roomCount: persisted.roomCount ?? 1,
            checkIn: persisted.checkIn,
            checkOut: persisted.checkOut,
            suggestedRoomTypeId: persisted.suggestedRoomTypeId,
            suggestedRoomTypeName: persisted.suggestedRoomTypeName,
            suggestedPropertyId: persisted.suggestedPropertyId,
            nights: persisted.nights,
            totalAmount: persisted.totalAmount,
            bookingMealPlanCode: persisted.bookingMealPlanCode,
            pendingPrebookOrder: null
          }
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { state: DbConversationState.QUOTED, lastMessageAt: new Date() }
        });
        return;
      }
      await sendWhatsAppText({
        to: normalizedPhone,
        body: "Please tap *Yes, browse menu* or *No, continue* from the list above.",
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "room_choice") {
      const chosenId = input.text.trim();
      const offers = persisted.bookingRoomOffers ?? [];
      const offer = offers.find((o) => o.roomTypeId === chosenId || o.roomTypeName.toLowerCase().includes(chosenId.toLowerCase()));
      if (!offer) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Please select one of the room options from the list above, or reply with the room name.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: "Please select one of the room options from the list above, or reply with the room name.",
            aiIntent: "BOOKING_STEP_ROOM_CHOICE_INVALID",
            aiConfidence: 0.9
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      const mealOutbound: FoodFlowOutbound = {
        kind: "list",
        body: "Choose your meal package for this stay (you can browse our restaurant menu):",
        buttonText: "Meal plan",
        sections: [
          {
            title: "Packages",
            rows: [
              { id: "mp_none", title: "No meal plan", description: "Room only" },
              { id: "mp_half", title: "Half board", description: "Breakfast + dinner" },
              { id: "mp_full", title: "Full board", description: "All main meals" },
              { id: "mp_view", title: "View menu", description: "Browse categories" }
            ]
          }
        ]
      };
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: [mealOutbound]
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          ...baseState,
          stage: "new",
          bookingStep: "meal_plan",
          bookingRoomOffers: offers,
          adultCount: persisted.adultCount,
          childCount: persisted.childCount,
          guestCount: persisted.guestCount ?? 1,
          roomCount: persisted.roomCount ?? 1,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          suggestedRoomTypeId: offer.roomTypeId,
          suggestedRoomTypeName: offer.roomTypeName,
          suggestedPropertyId: offer.propertyId,
          nights: offer.nights,
          totalAmount: offer.total,
          bookingMealPlanCode: null,
          pendingPrebookOrder: null
        }
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { state: DbConversationState.QUALIFYING, lastMessageAt: new Date() }
      });
      return;
    }
  }

  if (isMenuChoiceAskQuestion(input.text)) {
    await sendWhatsAppText({
      to: normalizedPhone,
      body: QUESTION_MODE_ENTRY,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: QUESTION_MODE_ENTRY,
        aiIntent: "MENU_QUESTION_MODE",
        aiConfidence: 0.95
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: persisted.stage || "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "QUESTION_MODE",
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (conversationMode === "QUESTION_MODE") {
    const knowledgeReply = answerFromKnowledge(input.text);
    const responseBody = knowledgeReply.found ? knowledgeReply.answer! : buildKnowledgeFallbackMessage();
    await sendWhatsAppText({
      to: normalizedPhone,
      body: responseBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: responseBody,
        aiIntent: knowledgeReply.intent ?? "FAQ_FALLBACK",
        aiConfidence: knowledgeReply.found ? 0.92 : 0.45
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: persisted.stage || "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "QUESTION_MODE",
        awaitingGuestName: false,
        awaitingBookingLookup: persisted.awaitingBookingLookup,
        myBookingCandidateIds: persisted.myBookingCandidateIds,
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (conversationMode === "IDLE" && isMenuChoiceMyBooking(input.text)) {
    await sendWhatsAppText({
      to: normalizedPhone,
      body: MY_BOOKING_PROMPT,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: MY_BOOKING_PROMPT,
        aiIntent: "MENU_MY_BOOKING",
        aiConfidence: 0.95
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: persisted.stage || "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "IDLE",
        awaitingGuestName: false,
        awaitingBookingLookup: true,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (persisted.awaitingGuestName && currentState === "awaiting_confirmation") {
    const providedName = input.text.trim().replace(/\s+/g, " ");
    if (providedName.length < 2 || isConfirmationKeyword(providedName)) {
      const retryBody = "Please share the full guest name for the reservation.";
      await sendWhatsAppText({
        to: normalizedPhone,
        body: retryBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: retryBody,
          aiIntent: "ASK_GUEST_NAME_RETRY",
          aiConfidence: 0.95
        }
      });
      return;
    }

    await mergeGuestProfileFromBooking({
      guestId: guest.id,
      fullName: providedName,
      localeHint: persisted.language || "en"
    });

    const checkIn = persisted.checkIn ? new Date(persisted.checkIn) : undefined;
    const checkOut = persisted.checkOut ? new Date(persisted.checkOut) : undefined;
    const guests = persisted.guestCount ?? 2;
    const rooms = persisted.roomCount ?? 1;
    let adultsForBooking: number;
    let childrenForBooking: number;
    if (typeof persisted.adultCount === "number" && typeof persisted.childCount === "number") {
      adultsForBooking = Math.max(1, persisted.adultCount);
      childrenForBooking = Math.max(0, persisted.childCount);
    } else {
      adultsForBooking = Math.max(1, guests);
      childrenForBooking = 0;
    }
    if (!checkIn || !checkOut) {
      const missingDatesBody = "I still need your check-in and check-out dates before confirming.";
      await sendWhatsAppText({
        to: normalizedPhone,
        body: missingDatesBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: missingDatesBody,
          aiIntent: "MISSING_DATES_FOR_CONFIRMATION",
          aiConfidence: 0.9
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: "collecting_dates",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          awaitingGuestName: false,
          phoneNumberId: hotel.phoneNumberId,
          guestName: providedName,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          checkInOptions: persisted.checkInOptions,
          checkOutOptions: persisted.checkOutOptions,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nightlyRate: persisted.nightlyRate,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      return;
    }

    const booking = await createConfirmedBookingAtomic({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      checkIn,
      checkOut,
      guests,
      rooms,
      currency: hotel.currency,
      adults: adultsForBooking,
      children: childrenForBooking,
      source: ChannelProvider.WHATSAPP
    });

    const mpCode = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
    const mealPart = computeMealPlanSurchargeForStay({
      mealPlan: mpCode,
      adults: adultsForBooking,
      children: childrenForBooking,
      nights: booking.nights
    });
    const roomTotal = booking.totalAmount;
    const combinedStayTotal = Number((roomTotal + mealPart).toFixed(2));
    await prisma.booking.update({
      where: { id: booking.bookingId },
      data: {
        mealPlan: mpCode === "NONE" ? null : mpCode,
        totalAmount: combinedStayTotal
      }
    });

    let prebookSummaryLine: string | null = null;
    if (persisted.pendingPrebookOrder && persisted.pendingPrebookOrder.lines.length > 0) {
      const po = persisted.pendingPrebookOrder;
      const notes = `[WhatsApp pre-book] Requested: ${po.timeNote} · ${
        po.serviceMode === FbServiceMode.ROOM_SERVICE ? "Room service" : "Dining"
      }`;
      try {
        await createFbOrdersFromMenuLines({
          hotelId: hotel.id,
          bookingId: booking.bookingId,
          guestId: guest.id,
          serviceMode: po.serviceMode,
          notes,
          lines: po.lines.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty }))
        });
        prebookSummaryLine = `Pre-booked F&B (folio): ~${po.estimatedTotal.toFixed(2)} ${hotel.currency}`;
      } catch (err) {
        console.error("Pre-book F&B on confirm failed:", err instanceof Error ? err.message : String(err));
        prebookSummaryLine =
          "Pre-booked F&B could not be posted automatically — please contact reception with your order.";
      }
    }

    const confirmationBody = [
      "Booking confirmed successfully.",
      `Guest: ${providedName}`,
      `Room: ${booking.roomTypeName}`,
      `Check-in: ${checkIn.toISOString().slice(0, 10)}`,
      `Check-out: ${checkOut.toISOString().slice(0, 10)}`,
      `Guests: ${guests}`,
      `Nights: ${booking.nights}`,
      mealPart > 0
        ? `Meal plan: ${mpCode} (+${mealPart.toFixed(2)} ${hotel.currency})`
        : "Meal plan: none",
      prebookSummaryLine,
      `Room + meal plan total: ${combinedStayTotal.toFixed(2)} ${hotel.currency}`,
      `Booking ID: ${booking.bookingId}`
    ]
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .join("\n");

    await sendWhatsAppText({
      to: normalizedPhone,
      body: confirmationBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: confirmationBody,
        aiIntent: "BOOKING_CONFIRMED_WITH_GUEST_NAME",
        aiConfidence: 0.98
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: "confirmed",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "BOOKING_MODE",
        awaitingGuestName: false,
        phoneNumberId: hotel.phoneNumberId,
        guestName: providedName,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        checkInOptions: persisted.checkInOptions,
        checkOutOptions: persisted.checkOutOptions,
        guestCount: guests,
        roomCount: rooms,
        suggestedRoomTypeId: booking.roomTypeId,
        suggestedRoomTypeName: booking.roomTypeName,
        suggestedPropertyId: booking.propertyId,
        nights: booking.nights,
        totalAmount: combinedStayTotal,
        bookingMealPlanCode: undefined,
        pendingPrebookOrder: null,
        fbCartDraft: null,
        bookingFlowReturn: null,
        bookingStep: undefined
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { state: DbConversationState.CONFIRMED, lastMessageAt: new Date() }
    });
    return;
  }

  if (persisted.awaitingGuestName && currentState !== "awaiting_confirmation") {
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: currentState,
        lastActivityAt: new Date().toISOString(),
        conversationMode: "BOOKING_MODE",
        awaitingGuestName: false,
        phoneNumberId: hotel.phoneNumberId,
        guestName: persisted.guestName,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        checkInOptions: persisted.checkInOptions,
        checkOutOptions: persisted.checkOutOptions,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nightlyRate: persisted.nightlyRate,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
  }

  if (persisted.awaitingBookingLookup) {
    if (isGlobalResetMessage(input.text)) {
      persisted.awaitingBookingLookup = false;
      persisted.myBookingCandidateIds = [];
      persisted.awaitingGuestName = false;
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language ?? "",
          stage: "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "IDLE",
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: [],
          phoneNumberId: persisted.phoneNumberId ?? hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          checkInOptions: persisted.checkInOptions,
          checkOutOptions: persisted.checkOutOptions,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          guestName: persisted.guestName,
          nightlyRate: persisted.nightlyRate,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      if (needsLanguageSelection(persisted.language)) {
        try {
          await sendWhatsAppButtons({
            to: normalizedPhone,
            body: LANGUAGE_SELECT_PROMPT,
            buttons: LANGUAGE_BUTTONS,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        } catch (err) {
          console.error("WhatsApp language buttons send failed (reset from My booking):", err instanceof Error ? err.message : String(err));
          await sendWhatsAppText({
            to: normalizedPhone,
            body: LANGUAGE_SELECT_FALLBACK,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        }
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: LANGUAGE_SELECT_PROMPT,
            aiIntent: "LANGUAGE_SELECT",
            aiConfidence: 0.98
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      const menuBody = getMainMenuBody(hotel.displayName, effectiveLang(persisted.language));
      const fallbackBody = buildMainMenuMessage(hotel.displayName, effectiveLang(persisted.language));
      const { recordedBody: myBookingMenuRecorded } = await sendMainMenuForGuest({
        hotel,
        guestId: guest.id,
        to: normalizedPhone,
        conversationId: conversation.id,
        menuBody,
        fallbackBody
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: myBookingMenuRecorded,
          aiIntent: "GLOBAL_RESET_FROM_MY_BOOKING",
          aiConfidence: 0.98
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    const candidateIds = persisted.myBookingCandidateIds ?? [];
    let bookingToShow: Parameters<typeof formatBookingSummary>[0] | null = null;
    if (candidateIds.length > 0) {
      const raw = input.text.trim();
      const byIndex = /^[1-9]\d*$/.test(raw) ? parseInt(raw, 10) - 1 : -1;
      const idMatch = candidateIds.includes(raw) ? raw : undefined;
      const resolvedId = idMatch ?? (byIndex >= 0 && byIndex < candidateIds.length ? candidateIds[byIndex] : null);
      if (resolvedId) {
        const b = await prisma.booking.findFirst({
          where: { id: resolvedId, hotelId: hotel.id },
          include: { guest: true, roomType: true }
        });
        if (b) bookingToShow = b;
      }
    } else {
      const result = await lookupBookings(hotel.id, input.text);
      if (result.kind === "single" && result.booking) bookingToShow = result.booking;
      if (result.kind === "multiple" && result.bookings.length > 0) {
        const listBody = "Which booking would you like to see?";
        const sections = [
          {
            title: "Your bookings",
            rows: result.bookings.slice(0, 10).map((b) => {
              const cin = new Date(b.checkIn).toISOString().slice(0, 10);
              const cout = new Date(b.checkOut).toISOString().slice(0, 10);
              return { id: b.id, title: `${b.id} • ${cin}–${cout}`.slice(0, 24) };
            })
          }
        ];
        try {
          await sendWhatsAppList({
            to: normalizedPhone,
            body: listBody,
            buttonText: "Choose booking",
            sections,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        } catch (err) {
          console.error("WhatsApp my-booking list send failed, using text fallback:", err instanceof Error ? err.message : String(err));
          const fallbackLines = result.bookings.map((b, i) => {
            const cin = new Date(b.checkIn).toISOString().slice(0, 10);
            const cout = new Date(b.checkOut).toISOString().slice(0, 10);
            return `${i + 1}) ${b.id} (${cin} to ${cout})`;
          });
          await sendWhatsAppText({
            to: normalizedPhone,
            body: [listBody, "", "Reply with the number:", ...fallbackLines].join("\n"),
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
        }
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: listBody,
            aiIntent: "MY_BOOKING_LIST",
            aiConfidence: 0.95
          }
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            language: persisted.language || "en",
            stage: persisted.stage || "new",
            lastActivityAt: new Date().toISOString(),
            conversationMode: conversationMode,
            awaitingGuestName: false,
            awaitingBookingLookup: true,
            myBookingCandidateIds: result.bookings.map((b) => b.id),
            phoneNumberId: hotel.phoneNumberId,
            checkIn: persisted.checkIn,
            checkOut: persisted.checkOut,
            guestCount: persisted.guestCount,
            roomCount: persisted.roomCount,
            suggestedRoomTypeId: persisted.suggestedRoomTypeId,
            suggestedRoomTypeName: persisted.suggestedRoomTypeName,
            suggestedPropertyId: persisted.suggestedPropertyId,
            nights: persisted.nights,
            totalAmount: persisted.totalAmount
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (result.kind === "none") {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: MY_BOOKING_NOT_FOUND,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: MY_BOOKING_NOT_FOUND,
            aiIntent: "MY_BOOKING_NOT_FOUND",
            aiConfidence: 0.9
          }
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            language: persisted.language || "en",
            stage: persisted.stage || "new",
            lastActivityAt: new Date().toISOString(),
            conversationMode: conversationMode,
            awaitingGuestName: false,
            awaitingBookingLookup: true,
            myBookingCandidateIds: [],
            phoneNumberId: hotel.phoneNumberId,
            checkIn: persisted.checkIn,
            checkOut: persisted.checkOut,
            guestCount: persisted.guestCount,
            roomCount: persisted.roomCount,
            suggestedRoomTypeId: persisted.suggestedRoomTypeId,
            suggestedRoomTypeName: persisted.suggestedRoomTypeName,
            suggestedPropertyId: persisted.suggestedPropertyId,
            nights: persisted.nights,
            totalAmount: persisted.totalAmount
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
    }
    if (bookingToShow) {
      const summary = formatBookingSummary({
        id: bookingToShow.id,
        guest: bookingToShow.guest,
        roomType: bookingToShow.roomType,
        checkIn: bookingToShow.checkIn,
        checkOut: bookingToShow.checkOut,
        nights: bookingToShow.nights,
        adults: bookingToShow.adults,
        totalAmount: bookingToShow.totalAmount,
        currency: bookingToShow.currency,
        status: bookingToShow.status,
        paymentStatus: bookingToShow.paymentStatus
      });
      await sendWhatsAppText({
        to: normalizedPhone,
        body: summary,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: summary,
          aiIntent: "MY_BOOKING_SUMMARY",
          aiConfidence: 0.98
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: persisted.stage || "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: conversationMode,
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: [],
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (candidateIds.length > 0) {
      await sendWhatsAppText({
        to: normalizedPhone,
        body: "Please reply with the number (1, 2, 3...) or the booking ID to see details.",
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: "Please reply with the number (1, 2, 3...) or the booking ID to see details.",
          aiIntent: "MY_BOOKING_CHOOSE",
          aiConfidence: 0.9
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: persisted.language || "en",
          stage: persisted.stage || "new",
          lastActivityAt: new Date().toISOString(),
          conversationMode: conversationMode,
          awaitingGuestName: false,
          awaitingBookingLookup: true,
          myBookingCandidateIds: candidateIds,
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    await sendWhatsAppText({
      to: normalizedPhone,
      body: MY_BOOKING_NOT_FOUND,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: MY_BOOKING_NOT_FOUND,
        aiIntent: "MY_BOOKING_NOT_FOUND",
        aiConfidence: 0.9
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: persisted.stage || "new",
        lastActivityAt: new Date().toISOString(),
        awaitingGuestName: false,
        awaitingBookingLookup: true,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (isGreeting(normalizedInputText) || normalizedInputText === "menu") {
    if (needsLanguageSelection(persisted.language)) {
      try {
        await sendWhatsAppButtons({
          to: normalizedPhone,
          body: LANGUAGE_SELECT_PROMPT,
          buttons: LANGUAGE_BUTTONS,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch (err) {
        console.error("WhatsApp language buttons send failed (greeting/menu):", err instanceof Error ? err.message : String(err));
        await sendWhatsAppText({
          to: normalizedPhone,
          body: LANGUAGE_SELECT_FALLBACK,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: LANGUAGE_SELECT_PROMPT,
          aiIntent: "LANGUAGE_SELECT",
          aiConfidence: 0.98
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: "",
          stage: "IDLE",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "IDLE",
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: [],
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    const menuBody = getMainMenuBody(hotel.displayName, effectiveLang(persisted.language));
    const fallbackBody = buildMainMenuMessage(hotel.displayName, effectiveLang(persisted.language));
    const { recordedBody: greetingMenuRecorded } = await sendMainMenuForGuest({
      hotel,
      guestId: guest.id,
      to: normalizedPhone,
      conversationId: conversation.id,
      menuBody,
      fallbackBody
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: greetingMenuRecorded,
        aiIntent: "GREETING_MENU",
        aiConfidence: 0.98
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language ?? "",
        stage: "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "IDLE",
        awaitingGuestName: false,
        awaitingBookingLookup: false,
        myBookingCandidateIds: [],
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        checkInOptions: persisted.checkInOptions,
        checkOutOptions: persisted.checkOutOptions,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nightlyRate: persisted.nightlyRate,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { state: DbConversationState.NEW, lastMessageAt: new Date() }
    });
    return;
  }

  const knowledgeReply = answerFromKnowledge(input.text);
  /** While choosing dates/guests/room, phrases like "I want to book" should continue the flow, not open FAQ. */
  const skipKnowledgeForBookingIntent =
    isBookingIntent(normalizedInputText) &&
    (conversationMode === "IDLE" || conversationMode === "BOOKING_MODE");
  if (knowledgeReply.isKnowledgeQuery && !skipKnowledgeForBookingIntent) {
    const responseBody = knowledgeReply.found ? knowledgeReply.answer! : buildKnowledgeFallbackMessage();
    await sendWhatsAppText({
      to: normalizedPhone,
      body: responseBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: responseBody,
        aiIntent: knowledgeReply.intent ?? "FAQ_FALLBACK",
        aiConfidence: knowledgeReply.found ? 0.92 : 0.45
      }
    });
    const updatedState = {
      language: persisted.language || "en",
      stage: persisted.stage || "new",
      lastActivityAt: new Date().toISOString(),
      conversationMode: conversationMode,
      awaitingGuestName: persisted.awaitingGuestName,
      phoneNumberId: hotel.phoneNumberId,
      checkIn: persisted.checkIn,
      checkOut: persisted.checkOut,
      guestCount: persisted.guestCount,
      roomCount: persisted.roomCount,
      suggestedRoomTypeId: persisted.suggestedRoomTypeId,
      suggestedRoomTypeName: persisted.suggestedRoomTypeName,
      suggestedPropertyId: persisted.suggestedPropertyId,
      nights: persisted.nights,
      totalAmount: persisted.totalAmount
    };
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: updatedState
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() }
    });
    return;
  }

  if (conversationMode !== "BOOKING_MODE" && !isBookingIntent(normalizedInputText) && !isActiveBookingState(currentState)) {
    if (needsLanguageSelection(persisted.language)) {
      try {
        await sendWhatsAppButtons({
          to: normalizedPhone,
          body: LANGUAGE_SELECT_PROMPT,
          buttons: LANGUAGE_BUTTONS,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch (err) {
        console.error("WhatsApp language buttons send failed (menu fallback):", err instanceof Error ? err.message : String(err));
        await sendWhatsAppText({
          to: normalizedPhone,
          body: LANGUAGE_SELECT_FALLBACK,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: LANGUAGE_SELECT_PROMPT,
          aiIntent: "LANGUAGE_SELECT",
          aiConfidence: 0.98
        }
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: "",
          stage: "IDLE",
          lastActivityAt: new Date().toISOString(),
          conversationMode: "IDLE",
          awaitingGuestName: false,
          awaitingBookingLookup: false,
          myBookingCandidateIds: [],
          phoneNumberId: hotel.phoneNumberId,
          checkIn: persisted.checkIn,
          checkOut: persisted.checkOut,
          guestCount: persisted.guestCount,
          roomCount: persisted.roomCount,
          suggestedRoomTypeId: persisted.suggestedRoomTypeId,
          suggestedRoomTypeName: persisted.suggestedRoomTypeName,
          suggestedPropertyId: persisted.suggestedPropertyId,
          nights: persisted.nights,
          totalAmount: persisted.totalAmount
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    const menuBody = getMainMenuBody(hotel.displayName, effectiveLang(persisted.language));
    const fallbackBody = buildMainMenuMessage(hotel.displayName, effectiveLang(persisted.language));
    const { recordedBody: fallbackMenuRecorded } = await sendMainMenuForGuest({
      hotel,
      guestId: guest.id,
      to: normalizedPhone,
      conversationId: conversation.id,
      menuBody,
      fallbackBody
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: fallbackMenuRecorded,
        aiIntent: "MENU_FALLBACK",
        aiConfidence: 0.7
      }
    });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language ?? "",
        stage: currentState,
        lastActivityAt: new Date().toISOString(),
        conversationMode: "IDLE",
        awaitingGuestName: persisted.awaitingGuestName,
        phoneNumberId: hotel.phoneNumberId,
        checkIn: persisted.checkIn,
        checkOut: persisted.checkOut,
        checkInOptions: persisted.checkInOptions,
        checkOutOptions: persisted.checkOutOptions,
        guestCount: persisted.guestCount,
        roomCount: persisted.roomCount,
        suggestedRoomTypeId: persisted.suggestedRoomTypeId,
        suggestedRoomTypeName: persisted.suggestedRoomTypeName,
        suggestedPropertyId: persisted.suggestedPropertyId,
        nightlyRate: persisted.nightlyRate,
        nights: persisted.nights,
        totalAmount: persisted.totalAmount
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() }
    });
    return;
  }

  let textForParse = input.text;
  if (
    currentState === "collecting_dates" &&
    persisted.checkIn &&
    persisted.checkOut &&
    /^(1_guest|2_guests|3_guests|4\+_guests)$/.test(input.text.trim())
  ) {
    const guestMap: Record<string, string> = {
      "1_guest": "1 guest",
      "2_guests": "2 guests",
      "3_guests": "3 guests",
      "4+_guests": "4 guests"
    };
    textForParse = guestMap[input.text.trim()] ?? input.text;
  }
  const parsed = parseGuestMessage(textForParse);
  const event = inferEvent(currentState, input.text, parsed);
  const turn = await buildTurnResult({
    state: currentState,
    event,
    text: textForParse,
    hotelId: hotel.id,
    hotelName: hotel.displayName,
    currency: hotel.currency,
    guestId: guest.id,
    conversationId: conversation.id,
    sessionData: {
      checkIn: persisted.checkIn,
      checkOut: persisted.checkOut,
      guestCount: persisted.guestCount,
      roomCount: persisted.roomCount,
      adultCount: persisted.adultCount,
      childCount: persisted.childCount
    }
  });

  if (turn.responseButtons?.length) {
    try {
      await sendWhatsAppButtons({
        to: normalizedPhone,
        body: turn.responseBody,
        buttons: turn.responseButtons,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    } catch (err) {
      console.error("WhatsApp quote/state buttons send failed, using text fallback:", err instanceof Error ? err.message : String(err));
      await sendWhatsAppText({
        to: normalizedPhone,
        body: turn.responseBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    }
  } else if (turn.responseList) {
    try {
      await sendWhatsAppList({
        to: normalizedPhone,
        body: turn.responseBody,
        buttonText: turn.responseList.buttonText,
        sections: turn.responseList.sections,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    } catch (err) {
      console.error("WhatsApp guest-count list send failed, using text fallback:", err instanceof Error ? err.message : String(err));
      await sendWhatsAppText({
        to: normalizedPhone,
        body: turn.responseBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
    }
  } else {
    await sendWhatsAppText({
      to: normalizedPhone,
      body: turn.responseBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
  }

  await prisma.message.create({
    data: {
      hotelId: hotel.id,
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      body: turn.responseBody,
      aiIntent: `STATE_${turn.nextState.toUpperCase()}`,
      aiConfidence: 0.9
    }
  });

  const nextSessionState = {
    language: persisted.language || "en",
    stage: turn.nextState,
    lastActivityAt: new Date().toISOString(),
    conversationMode: "BOOKING_MODE" as const,
    awaitingGuestName:
      typeof turn.updateSession.awaitingGuestName === "boolean" ? turn.updateSession.awaitingGuestName : persisted.awaitingGuestName,
    awaitingBookingLookup: persisted.awaitingBookingLookup,
    myBookingCandidateIds: persisted.myBookingCandidateIds,
    phoneNumberId: hotel.phoneNumberId,
    guestName: persisted.guestName,
    checkIn: typeof turn.updateSession.checkIn === "string" ? turn.updateSession.checkIn : persisted.checkIn,
    checkOut: typeof turn.updateSession.checkOut === "string" ? turn.updateSession.checkOut : persisted.checkOut,
    checkInOptions: persisted.checkInOptions,
    checkOutOptions: persisted.checkOutOptions,
    manualCheckInDate: persisted.manualCheckInDate,
    manualCheckOutDate: persisted.manualCheckOutDate,
    guestCount: typeof turn.updateSession.guestCount === "number" ? turn.updateSession.guestCount : persisted.guestCount,
    roomCount: typeof turn.updateSession.roomCount === "number" ? turn.updateSession.roomCount : persisted.roomCount,
    adultCount: persisted.adultCount,
    childCount: persisted.childCount,
    bookingStep: persisted.bookingStep,
    capacityPickRoomTypes: persisted.capacityPickRoomTypes,
    bookingRoomOffers: persisted.bookingRoomOffers,
    suggestedRoomTypeId:
      typeof turn.updateSession.suggestedRoomTypeId === "string" ? turn.updateSession.suggestedRoomTypeId : persisted.suggestedRoomTypeId,
    suggestedRoomTypeName:
      typeof turn.updateSession.suggestedRoomTypeName === "string" ? turn.updateSession.suggestedRoomTypeName : persisted.suggestedRoomTypeName,
    suggestedPropertyId:
      typeof turn.updateSession.suggestedPropertyId === "string" ? turn.updateSession.suggestedPropertyId : persisted.suggestedPropertyId,
    nightlyRate: persisted.nightlyRate,
    nights: typeof turn.updateSession.nights === "number" ? turn.updateSession.nights : persisted.nights,
    totalAmount: typeof turn.updateSession.totalAmount === "number" ? turn.updateSession.totalAmount : persisted.totalAmount
  };

  await saveConversationSession({
    hotelId: hotel.id,
    guestId: guest.id,
    conversationId: conversation.id,
    phoneE164: normalizedPhone,
    state: nextSessionState
  });

  await upsertBookingDraft({
    hotelId: hotel.id,
    guestId: guest.id,
    conversationId: conversation.id,
    currency: hotel.currency,
    state: nextSessionState
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { state: turn.conversationState, lastMessageAt: new Date() }
  });
}

