import {
  BookingStatus,
  ChannelProvider,
  ConversationState as DbConversationState,
  FbServiceMode,
  GuestFeedbackCategory,
  GuestFeedbackStatus,
  HousekeepingTaskSource,
  HousekeepingTaskStatus,
  MessageDirection,
  Prisma,
  UserRole
} from "@prisma/client";
import { parseGuestMessage, validateParsedBookingInput } from "../core/parse";
import { findAvailableRoomType, findAvailableRoomTypes } from "../core/availability";
import { roomTypeAllowsOccupancy } from "../core/roomOccupancy";
import { createConfirmedBookingAtomic } from "../core/bookingService";
import { BookingPaymentLinkUnavailableError, createBookingPaymentLink } from "../core/bookingPayments";
import {
  computeMealPlanSurchargeForStay,
  formatMealPlanSurchargeExplanation,
  type MealPlanCode
} from "../core/frontDeskPricing";
import { createFbOrdersFromMenuLines } from "../core/fbFolio";
import { mergeGuestProfileFromBooking } from "../core/guestProfile";
import type { LightGuestMemory } from "../core/lightGuestMemory";
import {
  loadGuestMemoryContext,
  mergeLightGuestMemorySpendingTouch,
  recordWelcomeBackMenuShown,
  shouldShowWelcomeBackLine
} from "../core/lightGuestMemory";
import { nextState, type ConversationEvent, type ConversationState } from "../core/stateMachine";
import { hotelTimezoneOrUtc } from "../core/guestMessagingSchedule";
import {
  bikeRentalWindowMinutes,
  housekeepingRequestWindowMinutes,
  isWithinWindow,
  nextWindowStartMessage
} from "../core/serviceOperatingHours";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { trackDecisionEventSafe } from "../core/decisionAnalytics";
import {
  type BookingStep,
  type ConversationMode,
  type PersistentSessionState,
  createCalendarSessionLink,
  loadConversationSession,
  saveConversationSession,
  upsertBookingDraft
} from "../core/sessionStore";
import type { PendingPrebookOrder, WhatsAppMealPlanCode } from "./foodTypes";
import { sendInStayServiceMenuForActiveConversation } from "../core/inStayWelcome";
import {
  advanceFbCartDraft,
  buildMealPlanSelectionOutbounds,
  findGuestActiveStayBooking,
  findGuestInHouseForServices,
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
  getOffersForBookingSubmenu
} from "./knowledgeBase";
import { sendWhatsAppButtons, sendWhatsAppCtaUrl, sendWhatsAppList, sendWhatsAppText, trySendWhatsAppFlow } from "./send";
import { guestReceptionistHandoffMessage } from "./guestNotifications";
import { handleGuestJourneyInboundReply, type GuestJourneyOperationalReply } from "./preArrivalGuestReplyNotify";
import { buildGuestJourneyOrchestratedReply } from "./guestMessageOrchestration";
import { dispatchGuestJourneyIntentActions } from "./guestActionDispatcher";
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

function bookingStartPrompt(opts?: { memory: LightGuestMemory; confirmedStayCount: number }): string {
  const base = [
    "Great, I can help with your booking.",
    "Please share check-in, check-out, and guest count.",
    "Examples:",
    "- 2026-04-10 to 2026-04-12 for 2 guests",
    "- 2 guests from 10 April to 12 April"
  ];
  if (opts && opts.confirmedStayCount >= 1) {
    const room = opts.memory.preferredRoomTypeName?.trim();
    if (room && room.length > 2) {
      base.splice(
        1,
        0,
        `Welcome back — when you have dates, we can look for availability similar to ${room} if you would like that again.`
      );
    } else {
      base.splice(1, 0, "Welcome back — we are happy to help with another stay.");
    }
  }
  return base.join("\n");
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
  "main",
  "main menu",
  "reset",
  "options",
  "help",
  "home",
  "back to menu",
  "القائمة",
  "الرئيسية",
  "ابدأ",
  "إبدأ",
  "ابدا",
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
    return `أهلاً بك في ${hotelName}.\nاختر الخدمة المطلوبة:`;
  }
  return `Welcome to ${hotelName}.\nChoose what you need:`;
}

function buildMainMenuMessage(hotelName: string, lang: "ar" | "en"): string {
  if (lang === "ar") {
    return [
      `أهلاً بك في ${hotelName}.`,
      "اختر الخدمة المطلوبة:",
      "1) حجز إقامة",
      "2) معلومات الفندق والموقع",
      "3) تصفح قائمة المطعم",
      "4) طلب طعام للنزلاء داخل الفندق",
      "5) تغيير اللغة",
      "6) التحدث مع الاستقبال"
    ].join("\n");
  }
  return [
    `Welcome to ${hotelName}.`,
    "Choose what you need:",
    "1) Book a stay",
    "2) Hotel info & location",
    "3) Browse restaurant menu",
    "4) Order food in-house",
    "5) Change language",
    "6) Chat with reception"
  ].join("\n");
}

/** Optional welcome-back line for returning guests (throttled in stored memory). */
function personalizeMainMenuBodies(
  hotelName: string,
  lang: "ar" | "en",
  ctx?: { memory: LightGuestMemory; confirmedStayCount: number }
): { menuBody: string; fallbackBody: string; stampedWelcomeBack: boolean } {
  const menuBody = getMainMenuBody(hotelName, lang);
  const fallbackBody = buildMainMenuMessage(hotelName, lang);
  if (!ctx || ctx.confirmedStayCount < 1 || !shouldShowWelcomeBackLine(ctx.memory)) {
    return { menuBody, fallbackBody, stampedWelcomeBack: false };
  }
  const prefix =
    lang === "ar"
      ? "أهلاً بك من جديد — يسعدنا تواصلك معنا مجدداً.\n\n"
      : "Welcome back — we're glad you're in touch with us again.\n\n";
  return { menuBody: prefix + menuBody, fallbackBody: prefix + fallbackBody, stampedWelcomeBack: true };
}

const MENU_BUTTONS: Array<{ id: string; title: string }> = [
  { id: "book_a_stay", title: "Book" },
  { id: "hotel_info", title: "Info" },
  { id: "talk_to_agent", title: "Reception" }
];

/** When guest has an active stay, main menu is a list (4 rows) so we can add Food & drinks without exceeding reply-button limits. */
const MAIN_MENU_LIST_CTA = "Menu";

async function sendMainMenuForGuest(params: {
  hotel: { id: string; displayName: string; phoneNumberId?: string; timezone?: string | null };
  guestId: string;
  to: string;
  conversationId: string;
  menuBody: string;
  fallbackBody: string;
}): Promise<{ recordedBody: string }> {
  const stay = await findGuestActiveStayBooking(params.hotel.id, params.guestId, params.hotel.timezone);
  const isArabic = /[\u0600-\u06FF]/.test(params.menuBody);
  const rows = isArabic
    ? [
        { id: "book_a_stay", title: "حجز إقامة", description: "التواريخ، الغرف، الوجبات، الدفع" },
        { id: "hotel_info", title: "معلومات الفندق", description: "الموقع، إنستغرام، التواصل" },
        { id: "browse_menu", title: "تصفح القائمة", description: "المطعم والمقهى" },
        stay
          ? { id: "order_food_stay", title: "طلب طعام", description: "خدمة الغرف / أمر مطبخ KOT" }
          : { id: "ask_question", title: "اسأل سؤال", description: "الغرف، السياسات، المرافق" },
        { id: "change_language", title: "اللغة", description: "العربية / English" },
        { id: "talk_to_agent", title: "الاستقبال", description: "التحدث مع موظف" }
      ]
    : [
        { id: "book_a_stay", title: "Book a stay", description: "Dates, rooms, meals, payment" },
        { id: "hotel_info", title: "Hotel info", description: "Location, Instagram, contacts" },
        { id: "browse_menu", title: "Browse menu", description: "Restaurant / cafe items" },
        stay
          ? { id: "order_food_stay", title: "Order food", description: "Room service / restaurant KOT" }
          : { id: "ask_question", title: "Ask question", description: "Rooms, policy, amenities" },
        { id: "change_language", title: "Language", description: "Arabic / English" },
        { id: "talk_to_agent", title: "Reception", description: "Speak with staff" }
      ];
  try {
    await sendWhatsAppList({
      to: params.to,
      body: params.menuBody,
      buttonText: isArabic ? "الخدمات" : MAIN_MENU_LIST_CTA,
      sections: [
        {
          title: isArabic ? "خدمات الضيف" : "Guest services",
          rows
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

const LANGUAGE_SELECT_PROMPT = "Please choose your language:";
const LANGUAGE_SELECT_FALLBACK = "Please choose your language:\n• العربية\n• English";
const LANGUAGE_BUTTONS: Array<{ id: string; title: string }> = [
  { id: "lang_ar", title: "العربية" },
  { id: "lang_en", title: "English" }
];

async function sendLanguageSelectionPrompt(params: {
  to: string;
  phoneNumberId?: string;
  conversationId: string;
}): Promise<void> {
  try {
    await sendWhatsAppButtons({
      to: params.to,
      body: LANGUAGE_SELECT_PROMPT,
      buttons: LANGUAGE_BUTTONS,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch (err) {
    console.error("WhatsApp language buttons send failed:", err instanceof Error ? err.message : String(err));
    await sendWhatsAppText({
      to: params.to,
      body: LANGUAGE_SELECT_FALLBACK,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
}

const BOOKING_MODE_ENTRY =
  "I'll help you book a stay. You can ask about room types or check availability. To get started, share your preferred dates and number of guests—e.g. 10–12 April for 2 guests.";
const APP_BASE_URL = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
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

type UpsellMemoryCtx = {
  memory: LightGuestMemory | null;
  /** Softer upsell copy for true repeat guests */
  repeatForSoftTone: boolean;
  frequencyFactor?: number;
  messageVariant?: "standard" | "soft" | "premium";
};

function getSmartUpsellTimingLine(
  params: { totalAmount?: number | null; nights?: number | null; checkIn?: string | null },
  upsellCtx?: UpsellMemoryCtx
): string {
  const total = typeof params.totalAmount === "number" ? params.totalAmount : 0;
  const nights = typeof params.nights === "number" ? params.nights : 0;
  const memory = upsellCtx?.memory ?? null;
  const repeatSoft = Boolean(upsellCtx?.repeatForSoftTone);
  const frequencyFactor = typeof upsellCtx?.frequencyFactor === "number" ? upsellCtx.frequencyFactor : 1;
  const variant = upsellCtx?.messageVariant ?? "standard";
  const checkInDays =
    params.checkIn && /^\d{4}-\d{2}-\d{2}$/.test(params.checkIn)
      ? Math.floor((new Date(`${params.checkIn}T12:00:00Z`).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
      : null;
  if (frequencyFactor <= 0.8 && total < 220 && nights < 3 && !(checkInDays !== null && checkInDays >= -1 && checkInDays <= 4)) {
    return "";
  }
  if (total >= 220) {
    if (memory?.hadComplaint) {
      return "We have premium room options available that may suit you. Reply if you would like to explore upgrades — there is no rush.";
    }
    if (variant === "soft") {
      return "If helpful, we can share premium room options for your dates. Let us know anytime if you would like details.";
    }
    if (variant === "premium") {
      return "Selected premium room options are available for your dates. Let us know if you would like us to reserve the best available category.";
    }
    if (repeatSoft) {
      return "We have premium upgrades available that may suit your past preferences. Let us know if you would like to explore options when convenient.";
    }
    return "We currently have limited upgraded rooms available for your dates. Let us know if you would like to explore this option.";
  }
  if (checkInDays !== null && checkInDays >= -1 && checkInDays <= 4) {
    const prefs = memory?.preferredActivities ?? [];
    if (prefs.includes("dune_buggy") || prefs.includes("bbq")) {
      return "We can arrange experiences you have enjoyed before — including dune buggy and BBQ options when you are ready. Let us know if you would like more details.";
    }
    if (variant === "soft") {
      return "If you wish, we can arrange optional experiences such as dune buggy and BBQ for your stay.";
    }
    return "Many guests visiting during this period enjoy our dune buggy and BBQ experiences. Let us know if you would like more details.";
  }
  if (nights >= 3) {
    if (repeatSoft) {
      return "For longer stays like this, we can quietly arrange add-ons such as meals, extra beds, or transfers — reply if any would help.";
    }
    return "Optional: For longer stays, we can arrange useful add-ons such as meals, extra beds, and transfers.";
  }
  if (repeatSoft) {
    return "If helpful, we can share options for early check-in, late check-out, upgrades, or activities — reply whenever you like.";
  }
  return "Optional: We can also arrange paid early check-in, late check-out, room upgrades, add-ons, and activities. Reply here if you want details.";
}
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
function isMenuChoiceHotelInfo(text: string): boolean {
  const t = normalizeMenuButtonInput(text).toLowerCase();
  return t === "hotel_info" || t === "hotel info" || t === "location" || t === "instagram" || t === "contacts";
}
function isMenuChoiceBrowseMenu(text: string): boolean {
  const t = normalizeMenuButtonInput(text).toLowerCase();
  return t === "browse_menu" || t === "browse menu" || t === "restaurant menu" || t === "food menu";
}
function isMenuChoiceChangeLanguage(text: string): boolean {
  const t = normalizeMenuButtonInput(text).toLowerCase();
  return (
    t === "change_language" ||
    t === "change language" ||
    t === "language" ||
    t === "lang" ||
    t === "arabic / english" ||
    t === "العربية / english" ||
    t === "اللغة" ||
    t === "تغيير اللغة"
  );
}
function isMenuChoiceTalkToAgent(text: string): boolean {
  const t = normalizeMenuButtonInput(text).toLowerCase();
  return t === "talk_to_agent" || t === "talk to an agent" || t === "chat with a receptionist" || t === "agent" || t === "reception";
}

function buildHotelInfoHubMessage(hotelName: string, lang: string): string {
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(hotelName)}`;
  const linksHeading = lang === "ar" ? "روابط مفيدة:" : "Useful links:";
  const mapsLabel = lang === "ar" ? "الموقع على خرائط Google" : "Google Maps";
  return [
    getLocationAndHotelInfoForSubmenu(),
    "",
    linksHeading,
    `${mapsLabel}: ${mapsUrl}`,
    answerFromKnowledge("instagram contact").answer ?? ""
  ].filter(Boolean).join("\n");
}

async function sendMobileBookingEntry(params: {
  hotel: { id: string; displayName: string; phoneNumberId?: string };
  guestId: string;
  to: string;
  language: string;
  conversationId: string;
}): Promise<{ body: string; channel: "flow" | "link" }> {
  const link = await createCalendarSessionLink({
    appBaseUrl: APP_BASE_URL,
    hotelId: params.hotel.id,
    guestId: params.guestId,
    phoneE164: params.to,
    language: params.language || "en",
    metadata: { source: "whatsapp_book_now" }
  });
  const bookingUrl = link.url.replace("/guest/calendar?", "/guest/book?");
  const body = [
    `Book ${params.hotel.displayName} faster from one mobile screen.`,
    "Choose dates, rooms, adults/children, preferred room, and special requests in one place.",
    "After you submit, I will send the confirmation here on WhatsApp."
  ].join("\n");
  const flowId = process.env.WHATSAPP_BOOKING_FLOW_ID?.trim();
  if (flowId) {
    const flow = await trySendWhatsAppFlow({
      to: params.to,
      body,
      flowId,
      flowToken: link.token,
      flowCta: "Book Now",
      screen: process.env.WHATSAPP_BOOKING_FLOW_SCREEN?.trim() || "BOOKING_FORM",
      data: {
        hotel_id: params.hotel.id,
        hotel_name: params.hotel.displayName,
        booking_url: bookingUrl,
        fallback_url: bookingUrl
      },
      phoneNumberId: params.hotel.phoneNumberId,
      conversationId: params.conversationId
    });
    if (flow.ok) return { body, channel: "flow" };
    console.warn("[WhatsApp] Booking Flow send failed; falling back to mobile booking link:", flow.errorMessage.slice(0, 320));
  }
  await sendWhatsAppCtaUrl({
    to: params.to,
    body,
    displayText: "Book Now",
    url: bookingUrl,
    phoneNumberId: params.hotel.phoneNumberId,
    conversationId: params.conversationId
  });
  return { body: `${body}\n${bookingUrl}`, channel: "link" };
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
    t === "resume_booking"
  );
}

type QuoteReplyAction = "cancel" | "change_details" | "confirm" | null;
type QuoteEditTarget = "dates" | "guests" | "rooms" | "meal_plan" | "payment";

function parseQuoteReplyAction(text: string): QuoteReplyAction {
  const normalized = normalizeText(text);
  const compact = normalized.replace(/\s+/g, "_");

  // 1) cancel
  if (
    normalized === "cancel" ||
    normalized === "no" ||
    normalized === "n" ||
    compact === "quote_cancel"
  ) {
    return "cancel";
  }

  // 2) change details
  if (
    compact === "change_details" ||
    compact === "quote_change_details" ||
    normalized === "edit" ||
    normalized === "change" ||
    normalized === "edit details" ||
    normalized === "change details"
  ) {
    return "change_details";
  }

  // 3) confirm
  if (
    /^(yes|y|confirm|confirm_booking|book|ok|okay|proceed|sure)$/i.test(text.trim()) ||
    compact === "quote_confirm"
  ) {
    return "confirm";
  }

  return null;
}

function parseQuoteEditTarget(text: string): QuoteEditTarget | null {
  const normalized = normalizeText(text);
  const compact = normalized.replace(/\s+/g, "_");
  if (
    compact === "edit_dates" ||
    compact === "change_dates" ||
    compact === "quote_edit_dates" ||
    normalized.includes("change date") ||
    normalized.includes("edit date") ||
    normalized.includes("update date")
  ) {
    return "dates";
  }
  if (
    compact === "edit_guests" ||
    compact === "change_guests" ||
    compact === "quote_edit_guests" ||
    normalized.includes("change guest") ||
    normalized.includes("edit guest") ||
    normalized.includes("add guest")
  ) {
    return "guests";
  }
  if (
    compact === "edit_rooms" ||
    compact === "change_rooms" ||
    compact === "quote_edit_rooms" ||
    normalized.includes("change room") ||
    normalized.includes("edit room") ||
    normalized.includes("update room")
  ) {
    return "rooms";
  }
  if (
    compact === "edit_meal_plan" ||
    compact === "change_meal_plan" ||
    compact === "quote_edit_meal_plan" ||
    compact === "meal_plan" ||
    normalized.includes("meal plan") ||
    normalized.includes("breakfast") ||
    normalized.includes("half board") ||
    normalized.includes("full board")
  ) {
    return "meal_plan";
  }
  if (compact === "edit_payment" || compact === "change_payment" || compact === "payment" || normalized.includes("payment")) {
    return "payment";
  }
  return null;
}

function isGenericQuoteEditRequest(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    normalized === "edit" ||
    normalized === "change" ||
    normalized === "change details" ||
    normalized === "edit details" ||
    normalized === "modify booking" ||
    normalized === "update booking"
  );
}

function isQuoteConfirmActionText(text: string): boolean {
  return parseQuoteReplyAction(text) === "confirm";
}

function parseGuestFeedbackRating(text: string): number | null {
  const raw = text.trim();
  if (/^fb_rate_[1-5]$/i.test(raw)) {
    return parseInt(raw.slice(-1), 10);
  }
  const n = normalizeText(raw);
  if (/^[1-5]$/.test(n)) return parseInt(n, 10);
  if (n.includes("excellent") || n.includes("5 star") || n.includes("⭐⭐⭐⭐⭐")) return 5;
  if (n.includes("good") || n.includes("4 star") || n.includes("⭐⭐⭐⭐")) return 4;
  if (n.includes("average") || n.includes("3 star") || n.includes("⭐⭐⭐")) return 3;
  if (n.includes("poor") || n.includes("2 star") || n.includes("⭐⭐")) return 2;
  if (n.includes("very poor") || n.includes("1 star") || n.includes("⭐")) return 1;
  return null;
}

function parseGuestFeedbackCategory(text: string): GuestFeedbackCategory | "OTHER_COMMENT" | null {
  const n = normalizeText(text).replace(/\s+/g, "_");
  if (n === "fb_cat_cleanliness" || n.includes("cleanliness")) return GuestFeedbackCategory.CLEANLINESS;
  if (n === "fb_cat_room_comfort" || n.includes("room_comfort") || n.includes("room comfort") || n.includes("room_and_comfort")) {
    return GuestFeedbackCategory.ROOM_COMFORT;
  }
  if (n === "fb_cat_service" || n === "service") return GuestFeedbackCategory.SERVICE;
  if (n === "fb_cat_food_beverage" || n.includes("food") || n.includes("beverage")) return GuestFeedbackCategory.FOOD_BEVERAGE;
  if (n === "fb_cat_facilities" || n.includes("facilities")) return GuestFeedbackCategory.FACILITIES;
  if (n === "fb_cat_other" || n === "other") return "OTHER_COMMENT";
  return null;
}

function isGuestFeedbackSkipComment(text: string): boolean {
  const n = normalizeText(text);
  return n === "fb_skip_comment" || n === "skip" || n === "no" || n === "no thanks" || n === "not now";
}

function isManagerContactRequested(text: string): boolean | null {
  const n = normalizeText(text).replace(/\s+/g, "_");
  if (n === "fb_mgr_yes" || n === "yes_contact_me") return true;
  if (n === "fb_mgr_no" || n === "no_thanks") return false;
  return null;
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

function parseCountSelection(text: string, prefix: string, max: number, allowZero = false): number | null {
  const trimmed = text.trim().toLowerCase();
  const min = allowZero ? 0 : 1;
  const prefixed = trimmed.match(new RegExp(`^${prefix}_(\\d{1,2})$`));
  if (prefixed) {
    const n = parseInt(prefixed[1] ?? "", 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  }
  if (/^[a-z]+_\d{1,2}$/.test(trimmed)) return null;
  return parseStepNumber(trimmed, max, allowZero);
}

function addCalendarDays(input: Date, days: number): Date {
  const next = new Date(input);
  next.setDate(next.getDate() + days);
  return next;
}

function isUniversalChangeBookingRequest(text: string): boolean {
  const normalized = normalizeText(text);
  const compact = normalized.replace(/\s+/g, "_");
  return [
    "change",
    "edit",
    "change_booking",
    "edit_booking",
    "change_details",
    "edit_details",
    "modify_booking",
    "update_booking",
    "تغيير",
    "تعديل",
    "تعديل_الحجز",
    "تغيير_الحجز"
  ].includes(compact);
}

function bookingLang(lang: string | undefined): "ar" | "en" {
  return effectiveLang(lang);
}

function bookingCopy(langRaw: string | undefined) {
  const ar = bookingLang(langRaw) === "ar";
  return {
    noSingleRoomPrefix: ar ? "لا توجد غرفة واحدة مناسبة لهذا العدد من الضيوف." : "No single room fits this group.",
    largestOptions: ar ? "أكبر الغرف المتاحة:" : "Our largest options:",
    splitPrompt: ar
      ? "يمكننا تقسيم الضيوف على أكثر من غرفة. اختر عدد الغرف للمتابعة:"
      : "We can split the guests across multiple rooms. Choose how many rooms to continue:",
    splitButton: ar ? "تقسيم الغرف" : "Split rooms",
    splitSection: ar ? "خيارات الغرف" : "Room options",
    splitInto: (rooms: number) => (ar ? `تقسيم إلى ${rooms} غرف` : `Split into ${rooms} rooms`),
    splitDesc: (rooms: number, guests: number) =>
      ar ? `متوسط ${Math.ceil(guests / rooms)} ضيوف لكل غرفة` : `About ${Math.ceil(guests / rooms)} guests per room`,
    changeGuests: ar ? "تغيير عدد الضيوف" : "Change guests",
    changeGuestsDesc: ar ? "العودة للبالغين والأطفال" : "Back to adults and children",
    splitFallback: ar ? "اكتب عدد الغرف مثل 2 أو 3، أو اكتب back لتغيير عدد الضيوف." : "Reply with the number of rooms, such as 2 or 3, or reply back to change guests.",
    invalidSplit: ar ? "اختر عدد الغرف من القائمة أو اكتب 2 أو 3." : "Please choose a room count from the list, or reply 2 or 3.",
    noSplitAvailability: ar
      ? "عذرًا، لا توجد غرف كافية لهذه التواريخ. جرّب عدد غرف مختلف أو تواريخ أخرى."
      : "Sorry, there are not enough rooms for those dates. Try a different room count or dates.",
    noSingleRoomChoiceBody: ar
      ? "لا توجد غرفة واحدة تناسب هذا العدد من الضيوف. ماذا تفضل؟"
      : "No single room fits this group. What would you like to do?",
    splitNow: ar ? "قسّم الغرف الآن" : "Split rooms now",
    splitNowDesc: ar ? "اختر غرفتين أو أكثر واكمل الحجز" : "Choose 2+ rooms and continue booking",
    talkReception: ar ? "تحدث مع الاستقبال" : "Talk to reception",
    talkReceptionDesc: ar ? "يساعدك الموظف مباشرة" : "A staff member will help directly",
    noAvailabilityBody: ar
      ? "لا توجد غرف متاحة لهذا الاختيار. اختر ما تريد تغييره:"
      : "No rooms are available for this choice. What would you like to change?",
    availabilityRecoveryButton: ar ? "تعديل الطلب" : "Change request",
    changeDates: ar ? "تغيير التواريخ" : "Change dates",
    changeDatesDesc: ar ? "اختر وصول ومغادرة جديدة" : "Pick new check-in/out dates",
    changeRooms: ar ? "تغيير عدد الغرف" : "Change room count",
    changeRoomsDesc: ar ? "جرّب غرفة أكثر أو أقل" : "Try more or fewer rooms",
    changeRoomType: ar ? "تغيير نوع الغرفة" : "Change room type",
    changeRoomTypeDesc: ar ? "اختر نوع غرفة آخر" : "Choose another room type",
    changeMenuBody: ar ? "ما الذي تريد تغييره في الحجز؟" : "What would you like to change in the booking?",
    changeMenuButton: ar ? "تعديل الحجز" : "Change booking",
    changeMealPlan: ar ? "تغيير الوجبات" : "Change meal plan",
    changeMealPlanDesc: ar ? "غرفة فقط أو نصف/كامل إقامة" : "Room only or board options",
    changePayment: ar ? "تغيير الدفع" : "Change payment",
    changePaymentDesc: ar ? "الدفع الآن أو لاحقاً" : "Pay now or pay later",
    paymentChoiceBody: ar ? "كيف تفضل إكمال الدفع؟" : "How would you like to handle payment?",
    payOnline: ar ? "الدفع الإلكتروني" : "Pay online",
    payOnlineDesc: ar ? "إرسال رابط دفع آمن عند التأكيد" : "Send a secure link after confirmation",
    payAtHotel: ar ? "الدفع في الفندق" : "Pay at hotel",
    payAtHotelDesc: ar ? "يكمل الاستقبال الدفع لاحقاً" : "Reception can follow up later",
    nearestDatesIntro: ar ? "أقرب خيارات متاحة:" : "Nearest available options:",
    tryDate: (date: string) => (ar ? `جرّب ${date}` : `Try ${date}`),
    checkInBody: ar
      ? "اختر تاريخ *الوصول*:\n\nافتح القائمة واختر التاريخ، أو اختر *تاريخ آخر* واكتب YYYY-MM-DD."
      : "Choose your *check-in* date:\n\nOpen the list below and tap a date, or choose *Other date* to type YYYY-MM-DD.",
    checkInButton: ar ? "تاريخ الوصول" : "Pick check-in",
    checkOutBody: ar
      ? "اختر تاريخ *المغادرة* (يجب أن يكون بعد الوصول):\n\nافتح القائمة، أو اختر *تاريخ آخر* واكتب YYYY-MM-DD."
      : "Choose your *check-out* date (must be after check-in):\n\nOpen the list below, or *Other date* to type YYYY-MM-DD.",
    checkOutButton: ar ? "تاريخ المغادرة" : "Pick check-out",
    adultsPrompt: ar ? "كم عدد البالغين؟" : "How many adults will be staying?",
    adultsButton: ar ? "البالغون" : "Adults",
    adultsFallback: ar ? "اكتب عدد البالغين، مثل 2." : "Reply with the number of adults, e.g. 2.",
    childrenPrompt: ar ? "كم عدد الأطفال؟" : "How many children will be staying?",
    childrenButton: ar ? "الأطفال" : "Children",
    childrenFallback: ar ? "اكتب عدد الأطفال، مثل 0 أو 2." : "Reply with the number of children, e.g. 0 or 2."
  };
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

async function buildLiveRoomTypesForBookingSubmenu(hotelId: string, currency: string): Promise<string> {
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId, isActive: true },
    orderBy: [{ baseNightlyRate: "asc" }, { name: "asc" }],
    take: 10,
    select: { name: true, capacity: true, baseNightlyRate: true }
  });
  if (!roomTypes.length) {
    return "No active room types are available right now. Please contact reception for assistance.";
  }
  return (
    "Available room types and live rates:\n" +
    roomTypes
      .map((room) => `- ${room.name}: max ${room.capacity} guests, from ${room.baseNightlyRate.toFixed(2)} ${currency}/night.`)
      .join("\n")
  );
}

async function sendNoSingleRoomChoiceMenu(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
  language?: string;
  largest: Array<{ name: string; capacity: number }>;
}): Promise<void> {
  const copy = bookingCopy(params.language);
  const hint =
    params.largest.length > 0
      ? "\n\n" + copy.largestOptions + "\n" + params.largest.map((r) => `• ${r.name} (${r.capacity})`).join("\n")
      : "";
  const body = `${copy.noSingleRoomChoiceBody}${hint}`;
  try {
    await sendWhatsAppList({
      to: params.to,
      body,
      buttonText: copy.splitButton,
      sections: [
        {
          title: copy.splitSection,
          rows: [
            { id: "split_rooms_now", title: copy.splitNow.slice(0, 24), description: copy.splitNowDesc.slice(0, 72) },
            { id: "talk_to_reception", title: copy.talkReception.slice(0, 24), description: copy.talkReceptionDesc.slice(0, 72) }
          ]
        }
      ],
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch {
    await sendWhatsAppText({
      to: params.to,
      body: `${body}\n\nReply *split* to split rooms, or *reception* to talk to reception.`,
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
      aiIntent: "BOOKING_NO_SINGLE_ROOM_CHOICE",
      aiConfidence: 0.95
    }
  });
}

async function sendSplitRoomOptions(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
  language?: string;
  totalGuests: number;
  adults: number;
  children: number;
  largest: Array<{ name: string; capacity: number }>;
}): Promise<void> {
  const copy = bookingCopy(params.language);
  const maxRooms = Math.min(6, Math.max(2, params.totalGuests));
  const roomRows = Array.from({ length: maxRooms - 1 }, (_, i) => i + 2).map((rooms) => ({
    id: `split_rooms_${rooms}`,
    title: copy.splitInto(rooms).slice(0, 24),
    description: copy.splitDesc(rooms, params.totalGuests).slice(0, 72)
  }));
  const hint =
    params.largest.length > 0
      ? "\n\n" + copy.largestOptions + "\n" + params.largest.map((r) => `• ${r.name} (${r.capacity})`).join("\n")
      : "";
  const body = `${copy.noSingleRoomPrefix}${hint}\n\n${copy.splitPrompt}`;
  try {
    await sendWhatsAppList({
      to: params.to,
      body,
      buttonText: copy.splitButton,
      sections: [
        {
          title: copy.splitSection,
          rows: [
            ...roomRows,
            { id: "split_change_guests", title: copy.changeGuests.slice(0, 24), description: copy.changeGuestsDesc.slice(0, 72) }
          ]
        }
      ],
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch (err) {
    console.error("WhatsApp split-room list send failed:", err instanceof Error ? err.message : String(err));
    await sendWhatsAppText({
      to: params.to,
      body: `${body}\n\n${copy.splitFallback}`,
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
      aiIntent: "BOOKING_STEP_SPLIT_ROOMS",
      aiConfidence: 0.95
    }
  });
}

async function sendNoAvailabilityRecoveryMenu(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
  language?: string;
  includeRoomType: boolean;
  nearestDates?: string[];
}): Promise<void> {
  const copy = bookingCopy(params.language);
  const rows = [
    ...(params.nearestDates ?? []).slice(0, 3).map((date) => ({
      id: `try_checkin_${date}`,
      title: copy.tryDate(date).slice(0, 24),
      description: copy.changeDatesDesc.slice(0, 72)
    })),
    { id: "no_avail_change_dates", title: copy.changeDates.slice(0, 24), description: copy.changeDatesDesc.slice(0, 72) },
    { id: "no_avail_change_rooms", title: copy.changeRooms.slice(0, 24), description: copy.changeRoomsDesc.slice(0, 72) },
    ...(params.includeRoomType
      ? [{ id: "no_avail_change_room_type", title: copy.changeRoomType.slice(0, 24), description: copy.changeRoomTypeDesc.slice(0, 72) }]
      : []),
    { id: "no_avail_change_guests", title: copy.changeGuests.slice(0, 24), description: copy.changeGuestsDesc.slice(0, 72) },
    { id: "talk_to_reception", title: copy.talkReception.slice(0, 24), description: copy.talkReceptionDesc.slice(0, 72) }
  ];
  try {
    await sendWhatsAppList({
      to: params.to,
      body:
        copy.noAvailabilityBody +
        ((params.nearestDates ?? []).length ? `\n\n${copy.nearestDatesIntro} ${(params.nearestDates ?? []).slice(0, 3).join(", ")}` : ""),
      buttonText: copy.availabilityRecoveryButton,
      sections: [{ title: copy.availabilityRecoveryButton, rows }],
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch {
    await sendWhatsAppText({
      to: params.to,
      body: `${copy.noAvailabilityBody}${
        (params.nearestDates ?? []).length ? `\n${copy.nearestDatesIntro} ${(params.nearestDates ?? []).slice(0, 3).join(", ")}` : ""
      }\n\nReply: dates, rooms, guests,${params.includeRoomType ? " room type," : ""} or reception.`,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
  await prisma.message.create({
    data: {
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      direction: MessageDirection.OUTBOUND,
      body:
        copy.noAvailabilityBody +
        ((params.nearestDates ?? []).length ? `\n${copy.nearestDatesIntro} ${(params.nearestDates ?? []).slice(0, 3).join(", ")}` : ""),
      aiIntent: "BOOKING_NO_AVAILABILITY_RECOVERY",
      aiConfidence: 0.95
    }
  });
}

async function sendUniversalBookingChangeMenu(params: {
  hotelId: string;
  conversationId: string;
  to: string;
  phoneNumberId?: string;
  language?: string;
  includeRoomType: boolean;
}): Promise<void> {
  const copy = bookingCopy(params.language);
  const rows = [
    { id: "no_avail_change_dates", title: copy.changeDates.slice(0, 24), description: copy.changeDatesDesc.slice(0, 72) },
    { id: "no_avail_change_guests", title: copy.changeGuests.slice(0, 24), description: copy.changeGuestsDesc.slice(0, 72) },
    { id: "no_avail_change_rooms", title: copy.changeRooms.slice(0, 24), description: copy.changeRoomsDesc.slice(0, 72) },
    ...(params.includeRoomType
      ? [{ id: "no_avail_change_room_type", title: copy.changeRoomType.slice(0, 24), description: copy.changeRoomTypeDesc.slice(0, 72) }]
      : []),
    { id: "edit_meal_plan", title: copy.changeMealPlan.slice(0, 24), description: copy.changeMealPlanDesc.slice(0, 72) },
    { id: "edit_payment", title: copy.changePayment.slice(0, 24), description: copy.changePaymentDesc.slice(0, 72) },
    { id: "talk_to_reception", title: copy.talkReception.slice(0, 24), description: copy.talkReceptionDesc.slice(0, 72) }
  ];
  try {
    await sendWhatsAppList({
      to: params.to,
      body: copy.changeMenuBody,
      buttonText: copy.changeMenuButton,
      sections: [{ title: copy.changeMenuButton, rows }],
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch {
    await sendWhatsAppText({
      to: params.to,
      body: `${copy.changeMenuBody}\n\nReply: dates, guests, rooms, meal plan, payment, or reception.`,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
  await prisma.message.create({
    data: {
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      direction: MessageDirection.OUTBOUND,
      body: copy.changeMenuBody,
      aiIntent: "BOOKING_CHANGE_MENU",
      aiConfidence: 0.95
    }
  });
}

async function findNearestAvailableCheckIns(params: {
  hotelId: string;
  fromDate: Date;
  nights: number;
  guests: number;
  rooms: number;
  adults?: number;
  children?: number;
  days?: number;
}): Promise<string[]> {
  const start = new Date(params.fromDate);
  start.setHours(0, 0, 0, 0);
  const found: string[] = [];
  for (let offset = 1; offset <= (params.days ?? 14) && found.length < 3; offset += 1) {
    const checkIn = addCalendarDays(start, offset);
    const checkOut = addCalendarDays(checkIn, Math.max(1, params.nights));
    const offers = await findAvailableRoomTypes({
      hotelId: params.hotelId,
      checkIn,
      checkOut,
      guests: params.guests,
      rooms: params.rooms,
      ...(typeof params.adults === "number" && typeof params.children === "number"
        ? { adults: params.adults, children: params.children }
        : {})
    });
    if (offers.length > 0) found.push(checkIn.toISOString().slice(0, 10));
  }
  return found;
}

async function switchBookingConversationToReception(params: {
  hotelId: string;
  guestId: string;
  conversationId: string;
  phoneE164: string;
  to: string;
  hotelDisplayName: string;
  phoneNumberId?: string;
  state: PersistentSessionState;
}): Promise<void> {
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { agentHandoffAt: new Date(), lastMessageAt: new Date() }
  });
  const handoffBody = guestReceptionistHandoffMessage(params.hotelDisplayName);
  await sendWhatsAppText({
    to: params.to,
    body: handoffBody,
    phoneNumberId: params.phoneNumberId,
    conversationId: params.conversationId
  });
  await prisma.message.create({
    data: {
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      direction: MessageDirection.OUTBOUND,
      body: handoffBody,
      aiIntent: "AGENT_HANDOFF",
      aiConfidence: 0.98
    }
  });
  await saveConversationSession({
    hotelId: params.hotelId,
    guestId: params.guestId,
    conversationId: params.conversationId,
    phoneE164: params.phoneE164,
    state: {
      ...params.state,
      conversationMode: "AGENT_MODE",
      preHandoffConversationMode:
        params.state.conversationMode && params.state.conversationMode !== "AGENT_MODE"
          ? params.state.conversationMode
          : "IDLE",
      lastActivityAt: new Date().toISOString()
    }
  });
}

function compactWhatsAppListRowId(text: string): string {
  return normalizeMenuButtonInput(text).toLowerCase().replace(/\s+/g, "_");
}

const IN_STAY_EXTRA_SLUG_LABEL: Record<string, string> = {
  mattress: "Extra mattress",
  pillow: "Extra pillow",
  sheet: "Extra sheet",
  blanket: "Extra blanket",
  towels: "Extra towels",
  toiletries: "Toiletries / amenities",
  water: "Drinking water",
  maintenance: "Maintenance issue"
};

async function postInStayGuestOpsTask(params: {
  hotelId: string;
  bookingId: string;
  roomUnitId: string | null;
  taskTitle: string;
  detailLines: string[];
}): Promise<void> {
  if (!params.roomUnitId) {
    throw new Error("no_room_unit");
  }
  const notes = [params.taskTitle, ...params.detailLines].join("\n").slice(0, 1900);
  await prisma.housekeepingTask.create({
    data: {
      hotelId: params.hotelId,
      roomUnitId: params.roomUnitId,
      status: HousekeepingTaskStatus.PENDING,
      source: HousekeepingTaskSource.FRONTDESK,
      bookingId: params.bookingId,
      notes
    }
  });
  await createRoleRoutedNotification({
    hotelId: params.hotelId,
    roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.HOUSEKEEPING, UserRole.OWNER],
    title: params.taskTitle,
    body: params.detailLines.join(" · ").slice(0, 500),
    category: "rooms",
    severity: "high",
    link: "/admin/hk",
    sourceType: "WHATSAPP_IN_STAY_REQUEST",
    sourceId: params.bookingId,
    requiresAttention: true,
    audience: ["front_desk", "housekeeping", "owner"]
  }).catch(() => undefined);
}

/** Quantity for extra-item flow, or complaint description after category pick. */
async function tryCompleteInStayTextCaptures(params: {
  hotel: { id: string; displayName: string; phoneNumberId?: string | null; currency: string; timezone?: string | null };
  guest: { id: string; fullName: string | null };
  conversation: { id: string };
  normalizedPhone: string;
  text: string;
  persisted: PersistentSessionState;
}): Promise<boolean> {
  const iso = new Date().toISOString();
  const extraSlug = params.persisted.inStayExtraAwaitQtyFor;
  if (extraSlug) {
    const m = params.text.trim().match(/^([1-9])$/);
    if (!m) {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "Please reply with a single digit from *1* to *9* for quantity, or open the services menu and tap *Talk to reception*.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return true;
    }
    const qty = parseInt(m[1], 10);
    const stay = await findGuestInHouseForServices(params.hotel.id, params.guest.id, params.hotel.timezone);
    const label = IN_STAY_EXTRA_SLUG_LABEL[extraSlug] ?? extraSlug;
    if (!stay?.roomUnitId) {
      await saveConversationSession({
        hotelId: params.hotel.id,
        guestId: params.guest.id,
        conversationId: params.conversation.id,
        phoneE164: params.normalizedPhone,
        state: { ...params.persisted, inStayExtraAwaitQtyFor: null, lastActivityAt: iso }
      });
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "We could not match a room for this request. Please tap *Talk to reception* on the services menu.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return true;
    }
    try {
      await postInStayGuestOpsTask({
        hotelId: params.hotel.id,
        bookingId: stay.id,
        roomUnitId: stay.roomUnitId,
        taskTitle: `WhatsApp · ${label} ×${qty}`,
        detailLines: [
          `Guest: ${params.guest.fullName ?? params.normalizedPhone}`,
          `Booking: ${stay.referenceCode ?? stay.id.slice(0, 10)}`,
          `Room: ${stay.roomUnit?.name ?? stay.roomUnitId}`
        ]
      });
    } catch {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "We could not log that request just now. Please tap *Talk to reception* on the services menu.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      await saveConversationSession({
        hotelId: params.hotel.id,
        guestId: params.guest.id,
        conversationId: params.conversation.id,
        phoneE164: params.normalizedPhone,
        state: { ...params.persisted, inStayExtraAwaitQtyFor: null, lastActivityAt: iso }
      });
      return true;
    }
    await saveConversationSession({
      hotelId: params.hotel.id,
      guestId: params.guest.id,
      conversationId: params.conversation.id,
      phoneE164: params.normalizedPhone,
      state: { ...params.persisted, inStayExtraAwaitQtyFor: null, lastActivityAt: iso }
    });
    const okBody = `Thanks — we logged *${label} ×${qty}* for your room. Staff have been notified.`;
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body: okBody,
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: params.hotel.id,
        conversationId: params.conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: okBody,
        aiIntent: "IN_STAY_EXTRA_REQUEST_LOGGED",
        aiConfidence: 0.96
      }
    });
    return true;
  }

  if (params.persisted.inStayComplaintStep === "await_description" && params.persisted.inStayComplaintCategory) {
    const t = params.text.trim();
    if (t.length < 4) {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "Please send a short description (at least 4 characters) so we can help.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return true;
    }
    const stay = await findGuestInHouseForServices(params.hotel.id, params.guest.id, params.hotel.timezone);
    const guestLabel = params.guest.fullName?.trim() || params.normalizedPhone;
    const ref = stay?.referenceCode?.trim() || stay?.id?.slice(0, 10) || "";
    await createRoleRoutedNotification({
      hotelId: params.hotel.id,
      roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.OWNER],
      title: `In-stay complaint (${params.persisted.inStayComplaintCategory})`,
      body: `${guestLabel} (${ref}) — ${t.slice(0, 400)}`,
      category: "messages",
      severity: "critical",
      link: `/admin/conversations/${encodeURIComponent(params.conversation.id)}`,
      sourceType: "WHATSAPP_IN_STAY_COMPLAINT",
      sourceId: stay?.id ?? params.conversation.id,
      requiresAttention: true,
      audience: ["front_desk", "owner"]
    }).catch(() => undefined);
    await saveConversationSession({
      hotelId: params.hotel.id,
      guestId: params.guest.id,
      conversationId: params.conversation.id,
      phoneE164: params.normalizedPhone,
      state: {
        ...params.persisted,
        inStayComplaintStep: null,
        inStayComplaintCategory: null,
        lastActivityAt: iso
      }
    });
    const thank = "Thank you — we have received your complaint and a manager or reception colleague will follow up.";
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body: thank,
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: params.hotel.id,
        conversationId: params.conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: thank,
        aiIntent: "IN_STAY_COMPLAINT_RECEIVED",
        aiConfidence: 0.97
      }
    });
    return true;
  }

  return false;
}

/** Handles in-stay welcome list replies (`isv_*`) when guest has an active stay. */
async function tryHandleInStayServiceListReply(params: {
  hotel: { id: string; displayName: string; phoneNumberId?: string | null; currency: string; timezone?: string | null };
  guest: { id: string; fullName: string | null };
  conversation: { id: string };
  normalizedPhone: string;
  text: string;
  persisted: PersistentSessionState;
}): Promise<boolean> {
  const id = compactWhatsAppListRowId(params.text);
  const knownPlain = new Set([
    "isv_invoice",
    "isv_book_meal",
    "isv_order_meal",
    "isv_room_service",
    "isv_browse_menus",
    "isv_bike",
    "isv_hk",
    "isv_extras",
    "isv_complaint",
    "isv_reception"
  ]);
  const recognized =
    knownPlain.has(id) || id.startsWith("isv_extra_") || id.startsWith("isv_cmp_cat_") || id === "isv_view_stay";
  if (!recognized) return false;

  const stay = await findGuestInHouseForServices(params.hotel.id, params.guest.id, params.hotel.timezone);
  if (!stay) {
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body: "We could not match this to an active in-house stay. If you just checked in, wait a moment or contact reception.",
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    return true;
  }

  const tz = hotelTimezoneOrUtc(params.hotel.timezone);

  if (id === "isv_view_stay" || id === "isv_invoice") {
    const full = await prisma.booking.findUnique({
      where: { id: stay.id },
      include: { guest: true, roomType: true }
    });
    if (!full) return true;
    const body = [
      "Your stay summary (room charges & posted F&B on your folio):",
      formatBookingSummary({
        id: full.id,
        guest: full.guest,
        roomType: full.roomType,
        checkIn: full.checkIn,
        checkOut: full.checkOut,
        nights: full.nights,
        adults: full.adults,
        children: full.children,
        totalAmount: full.totalAmount,
        currency: full.currency,
        status: full.status,
        paymentStatus: full.paymentStatus,
        mealPlan: full.mealPlan
      })
    ].join("\n");
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body,
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: params.hotel.id,
        conversationId: params.conversation.id,
        direction: MessageDirection.OUTBOUND,
        body,
        aiIntent: "IN_STAY_VIEW_STAY",
        aiConfidence: 0.95
      }
    });
    return true;
  }

  if (id === "isv_reception") {
    await switchBookingConversationToReception({
      hotelId: params.hotel.id,
      guestId: params.guest.id,
      conversationId: params.conversation.id,
      phoneE164: params.normalizedPhone,
      to: params.normalizedPhone,
      hotelDisplayName: params.hotel.displayName,
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      state: params.persisted
    });
    return true;
  }

  const startKitchenOrderFlow = async () => {
    const mp = String(stay.mealPlan ?? "NONE").toUpperCase();
    if (mp === "HALF_BOARD" || mp === "FULL_BOARD") {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body:
          "Your rate includes a fixed board plan (buffet / set menu / approved options only). For included meals and meal times, tap *Book meal time* or speak with reception. Items outside your plan are extra and must be confirmed at reception before ordering.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return;
    }
    const initDraft = {
      purpose: "stay" as const,
      step: "category" as const,
      cart: [],
      stayBookingId: stay.id
    };
    await saveConversationSession({
      hotelId: params.hotel.id,
      guestId: params.guest.id,
      conversationId: params.conversation.id,
      phoneE164: params.normalizedPhone,
      state: {
        ...params.persisted,
        fbCartDraft: initDraft,
        lastActivityAt: new Date().toISOString()
      }
    });
    await sendFoodFlowOutbounds({
      hotelId: params.hotel.id,
      to: params.normalizedPhone,
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id,
      outbounds: [initialFbOrderList("stay")]
    });
  };

  if (id === "isv_order_meal") {
    await startKitchenOrderFlow();
    return true;
  }

  if (id === "isv_room_service") {
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body: "Room service ordering — when asked *How should this order be served?*, tap *Room service* so delivery goes to your assigned room.",
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    await startKitchenOrderFlow();
    return true;
  }

  if (id === "isv_browse_menus") {
    const browseDraft = {
      purpose: "browse_only" as const,
      step: "category" as const,
      cart: [],
      stayBookingId: stay.id
    };
    await saveConversationSession({
      hotelId: params.hotel.id,
      guestId: params.guest.id,
      conversationId: params.conversation.id,
      phoneE164: params.normalizedPhone,
      state: {
        ...params.persisted,
        fbCartDraft: browseDraft,
        lastActivityAt: new Date().toISOString()
      }
    });
    await sendFoodFlowOutbounds({
      hotelId: params.hotel.id,
      to: params.normalizedPhone,
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id,
      outbounds: [initialFbOrderList("browse_only")]
    });
    return true;
  }

  if (id === "isv_book_meal") {
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body:
        "To reserve breakfast, lunch, or dinner times (and guest count), reply with your preferred meal and time — e.g. *Dinner 19:30, 2 guests* — and reception will confirm. Half/full board guests: included meals follow the fixed plan; times are arranged after check-in.",
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    return true;
  }

  if (id === "isv_extras") {
    try {
      await sendWhatsAppList({
        to: params.normalizedPhone,
        body: "Extra items for your room — tap one:",
        buttonText: "Request",
        sections: [
          {
            title: "Room extras",
            rows: [
              { id: "isv_extra_mattress", title: "Extra mattress", description: "Rollaway / foam" },
              { id: "isv_extra_pillow", title: "Extra pillow", description: "Comfort" },
              { id: "isv_extra_sheet", title: "Extra sheet", description: "Bedding" },
              { id: "isv_extra_blanket", title: "Extra blanket", description: "Warmth" },
              { id: "isv_extra_towels", title: "Towels", description: "Bath / pool" },
              { id: "isv_extra_toiletries", title: "Toiletries", description: "Amenity kit" },
              { id: "isv_extra_water", title: "Water", description: "Bottled" },
              { id: "isv_extra_maintenance", title: "Maintenance", description: "AC, plumbing…" }
            ]
          }
        ],
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
    } catch {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "Reply with *isv_extra_pillow*, *isv_extra_towels*, *isv_extra_water*, or tap *Talk to reception*.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
    }
    return true;
  }

  if (id.startsWith("isv_extra_")) {
    const slug = id.slice("isv_extra_".length);
    const label = IN_STAY_EXTRA_SLUG_LABEL[slug];
    if (!label) return false;
    await saveConversationSession({
      hotelId: params.hotel.id,
      guestId: params.guest.id,
      conversationId: params.conversation.id,
      phoneE164: params.normalizedPhone,
      state: {
        ...params.persisted,
        inStayExtraAwaitQtyFor: slug,
        lastActivityAt: new Date().toISOString()
      }
    });
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body: `${label} — how many? Reply with a single digit *1*–*9* (hotel default is your assigned room).`,
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    return true;
  }

  if (id === "isv_complaint") {
    try {
      await sendWhatsAppList({
        to: params.normalizedPhone,
        body: "We are sorry something went wrong. Pick a category:",
        buttonText: "Category",
        sections: [
          {
            title: "Complaint",
            rows: [
              { id: "isv_cmp_cat_noise", title: "Noise", description: "Sound, neighbours" },
              { id: "isv_cmp_cat_clean", title: "Cleanliness", description: "Room hygiene" },
              { id: "isv_cmp_cat_staff", title: "Service", description: "Staff interaction" },
              { id: "isv_cmp_cat_fb", title: "Food & drinks", description: "F&B quality" },
              { id: "isv_cmp_cat_bill", title: "Billing", description: "Charges, folio" },
              { id: "isv_cmp_cat_other", title: "Other", description: "Anything else" }
            ]
          }
        ],
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
    } catch {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "Reply with *Complaint:* and a short description. Reception will be notified.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
    }
    return true;
  }

  if (id.startsWith("isv_cmp_cat_")) {
    const cat = id.slice("isv_cmp_cat_".length);
    await saveConversationSession({
      hotelId: params.hotel.id,
      guestId: params.guest.id,
      conversationId: params.conversation.id,
      phoneE164: params.normalizedPhone,
      state: {
        ...params.persisted,
        inStayComplaintStep: "await_description",
        inStayComplaintCategory: cat,
        lastActivityAt: new Date().toISOString()
      }
    });
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body: "Thank you. Please send a *short description* of the issue in your next message (one message).",
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    return true;
  }

  if (id === "isv_hk") {
    const win = housekeepingRequestWindowMinutes();
    const now = new Date();
    if (!isWithinWindow(now, tz, win.start, win.end)) {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: nextWindowStartMessage(now, tz, win.start, win.end, "Housekeeping requests"),
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return true;
    }
    if (!stay.roomUnitId) {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "We could not see your room assignment yet. Tap *Talk to reception* on the services menu.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return true;
    }
    try {
      await postInStayGuestOpsTask({
        hotelId: params.hotel.id,
        bookingId: stay.id,
        roomUnitId: stay.roomUnitId,
        taskTitle: "WhatsApp · Housekeeping refresh",
        detailLines: [
          `Guest: ${params.guest.fullName ?? params.normalizedPhone}`,
          `Booking: ${stay.referenceCode ?? stay.id.slice(0, 10)}`,
          `Room: ${stay.roomUnit?.name ?? stay.roomUnitId}`
        ]
      });
    } catch {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: "We could not log housekeeping yet. Tap *Talk to reception*.",
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return true;
    }
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body: "Housekeeping request logged for your room. Thank you — we will follow up as soon as possible.",
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    return true;
  }

  if (id === "isv_bike") {
    const win = bikeRentalWindowMinutes();
    const now = new Date();
    if (!isWithinWindow(now, tz, win.start, win.end)) {
      await sendWhatsAppText({
        to: params.normalizedPhone,
        body: nextWindowStartMessage(now, tz, win.start, win.end, "Bike / activity desk"),
        phoneNumberId: params.hotel.phoneNumberId ?? undefined,
        conversationId: params.conversation.id
      });
      return true;
    }
    await sendWhatsAppText({
      to: params.normalizedPhone,
      body:
        "Bike and activities: tap *Talk to reception* on the services menu and our team will confirm availability and pricing for you.",
      phoneNumberId: params.hotel.phoneNumberId ?? undefined,
      conversationId: params.conversation.id
    });
    return true;
  }

  return false;
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
  language?: string;
}): Promise<void> {
  const copy = bookingCopy(params.language);
  const body = copy.checkInBody;
  try {
    await sendWhatsAppList({
      to: params.to,
      body,
      buttonText: copy.checkInButton,
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
  language?: string;
}): Promise<void> {
  const copy = bookingCopy(params.language);
  const body = copy.checkOutBody;
  try {
    await sendWhatsAppList({
      to: params.to,
      body,
      buttonText: copy.checkOutButton,
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

async function sendCountSelectionListWithFallback(params: {
  to: string;
  phoneNumberId?: string;
  conversationId: string;
  body: string;
  buttonText: string;
  rowPrefix: string;
  min: number;
  max: number;
  fallbackPrompt: string;
}): Promise<void> {
  const rows = Array.from({ length: params.max - params.min + 1 }, (_, i) => {
    const value = params.min + i;
    return {
      id: `${params.rowPrefix}_${value}`,
      title: String(value)
    };
  });
  try {
    await sendWhatsAppList({
      to: params.to,
      body: params.body,
      buttonText: params.buttonText,
      sections: [{ title: "Select", rows }],
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  } catch {
    const numbered = rows.map((r) => r.title).join(", ");
    await sendWhatsAppText({
      to: params.to,
      body: `${params.fallbackPrompt}\nOptions: ${numbered}`,
      phoneNumberId: params.phoneNumberId,
      conversationId: params.conversationId
    });
  }
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
  if (code === "BREAKFAST") return "BREAKFAST";
  if (code === "HALF_BOARD") return "HALF_BOARD";
  if (code === "FULL_BOARD") return "FULL_BOARD";
  return "NONE";
}

/** Session `totalAmount` / availability offer totals are room stay only; meal surcharge is computed separately. */
function computeWhatsAppStayTotalsFromRoomSubtotal(params: {
  roomStaySubtotal: number | null | undefined;
  mealPlan: MealPlanCode;
  adults: number;
  children: number;
  nights: number;
  /** Booked physical rooms; defaults to 1. */
  rooms?: number;
}): { roomTotal: number; mealPart: number; stayTotal: number } {
  const roomTotal = Number((Math.max(0, params.roomStaySubtotal ?? 0)).toFixed(2));
  const mealPart = computeMealPlanSurchargeForStay({
    mealPlan: params.mealPlan,
    adults: params.adults,
    children: params.children,
    nights: params.nights,
    rooms: params.rooms
  });
  const stayTotal = Number((roomTotal + mealPart).toFixed(2));
  return { roomTotal, mealPart, stayTotal };
}

function buildWhatsAppBookingQuoteBundle(params: {
  roomTypeName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  adults: number;
  children: number;
  rooms: number;
  nights: number;
  currency: string;
  roomStaySubtotal: number | null | undefined;
  mealPlan: MealPlanCode;
  prebookLine: string | null;
  upsellBlock: string;
}): { quoteBody: string; stayTotal: number; roomTotal: number; mealPart: number } {
  const rooms = Math.max(1, params.rooms);
  const nights = Math.max(1, params.nights);
  const { roomTotal, mealPart, stayTotal } = computeWhatsAppStayTotalsFromRoomSubtotal({
    roomStaySubtotal: params.roomStaySubtotal,
    mealPlan: params.mealPlan,
    adults: params.adults,
    children: params.children,
    nights,
    rooms
  });
  const denom = rooms * nights;
  const nightlyPerRoom = denom > 0 ? roomTotal / denom : 0;
  const mealExpl = formatMealPlanSurchargeExplanation({
    mealPlan: params.mealPlan,
    adults: params.adults,
    children: params.children,
    nights,
    rooms,
    currency: params.currency
  });
  const lines: string[] = [
    "Here is your quote:",
    `Room type: ${params.roomTypeName}`,
    `Rooms: ${rooms}`,
    `Nights: ${nights}`,
    `Guests: ${params.guestCount} (${params.adults} adult(s), ${params.children} child(ren))`,
    `Check-in: ${params.checkIn}`,
    `Check-out: ${params.checkOut}`,
    `Rate: ${nightlyPerRoom.toFixed(2)} ${params.currency} per room per night`,
    `Room stay total: ${rooms} room(s) × ${nights} night(s) × ${nightlyPerRoom.toFixed(2)} = ${roomTotal.toFixed(2)} ${params.currency}`,
    mealExpl
  ];
  if (params.prebookLine) lines.push(params.prebookLine);
  lines.push(`Grand total (room + meal plan): ${stayTotal.toFixed(2)} ${params.currency}`);
  if (params.upsellBlock.trim()) lines.push("", params.upsellBlock.trim());
  return { quoteBody: lines.join("\n"), stayTotal, roomTotal, mealPart };
}

function formatWhatsAppPrebookFolioEstimateLine(currency: string, estimatedTotal: number): string | null {
  if (!Number.isFinite(estimatedTotal) || estimatedTotal <= 0) return null;
  return `Estimated pre-booked F&B (folio): ~${estimatedTotal.toFixed(
    2
  )} ${currency} — not included in booking total below`;
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
  children?: number;
  totalAmount: number;
  currency: string;
  status: string;
  paymentStatus: string;
  mealPlan?: string | null;
}): string {
  const checkInStr = new Date(booking.checkIn).toISOString().slice(0, 10);
  const checkOutStr = new Date(booking.checkOut).toISOString().slice(0, 10);
  const ch = typeof booking.children === "number" ? booking.children : 0;
  const guestLine =
    typeof booking.children === "number"
      ? `Guests: ${booking.adults} adult(s), ${ch} child(ren)`
      : `Guests: ${booking.adults}`;
  const lines = [
    `Booking ID: ${booking.id}`,
    `Guest: ${booking.guest.fullName ?? booking.guest.phoneE164}`,
    `Room: ${booking.roomType.name}`,
    `Check-in: ${checkInStr}`,
    `Check-out: ${checkOutStr}`,
    guestLine,
    `Nights: ${booking.nights}`,
    ...(booking.mealPlan ? [`Meal plan: ${booking.mealPlan}`] : []),
    `Total: ${Number(booking.totalAmount).toFixed(2)} ${booking.currency}`,
    `Status: ${booking.status}`,
    `Payment: ${booking.paymentStatus}`
  ];
  return lines.join("\n");
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
  if (state === "awaiting_confirmation" || state === "quoted") {
    const action = parseQuoteReplyAction(text);
    if (action === "confirm") return "guest_confirmed";
    if (action === "cancel" || action === "change_details") return "guest_cancelled";
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
  // Strict per-tenant routing: only match a hotel that has explicitly registered this WABA phone-number-id.
  // `loadPartnerSetupConfig` no longer inherits `whatsappPhoneNumberId` from the `default` block, so the
  // match here is unique per property.
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
    // No hotel claims this inbound phone-number-id. Log loudly so operators see the routing miss; we keep
    // serving (single-tenant dev / not-yet-configured environments) by using the first hotel and replying via
    // the inbound id (always valid for the receiving WhatsApp Business token).
    if (hotels.length > 1) {
      console.warn(
        `[whatsapp-routing] No hotel matches inbound phone_number_id=${inboundPhoneNumberId}. ` +
          `Configure Settings → WhatsApp setup for the receiving property. Falling back to first hotel "${hotels[0].displayName}" for this turn only.`
      );
    } else {
      console.info(
        `[whatsapp-routing] Single-tenant fallback for inbound phone_number_id=${inboundPhoneNumberId} → ${hotels[0].displayName}.`
      );
    }
  }
  const fallback = hotels[0];
  const fallbackConfig = loadPartnerSetupConfig(fallback.id);
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
  guestMemoryCtx?: { memory: LightGuestMemory; confirmedStayCount: number };
  optimizationCtx?: { upsellFrequencyFactor: number; upsellMessageVariant: "standard" | "soft" | "premium" };
}): Promise<TurnResult> {
  const upsellMem: UpsellMemoryCtx | undefined = params.guestMemoryCtx
    ? {
        memory: params.guestMemoryCtx.memory,
        repeatForSoftTone:
          params.guestMemoryCtx.confirmedStayCount >= 2 || Boolean(params.guestMemoryCtx.memory.repeatGuest),
        frequencyFactor: params.optimizationCtx?.upsellFrequencyFactor ?? 1,
        messageVariant: params.optimizationCtx?.upsellMessageVariant ?? "standard"
      }
    : undefined;
  const next = nextState(params.state, params.event);
  const parsed = parseGuestMessage(params.text);
  const sessionCheckIn = typeof params.sessionData.checkIn === "string" ? new Date(params.sessionData.checkIn) : undefined;
  const sessionCheckOut = typeof params.sessionData.checkOut === "string" ? new Date(params.sessionData.checkOut) : undefined;
  const sessionGuests = typeof params.sessionData.guestCount === "number" ? params.sessionData.guestCount : 2;
  const sessionRooms = typeof params.sessionData.roomCount === "number" ? params.sessionData.roomCount : 1;

  if (params.state === "new" && next === "collecting_dates") {
    await trackDecisionEventSafe({
      hotelId: params.hotelId,
      eventType: "booking_started",
      guestId: params.guestId,
      conversationId: params.conversationId,
      source: "whatsapp_conversation"
    });
    return {
      nextState: next,
      conversationState: DbConversationState.NEW,
      responseBody: bookingStartPrompt(
        params.guestMemoryCtx
          ? { memory: params.guestMemoryCtx.memory, confirmedStayCount: params.guestMemoryCtx.confirmedStayCount }
          : undefined
      ),
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
        `Tap a button below or reply YES to confirm, EDIT to change, NO to cancel.\n${getSmartUpsellTimingLine(
          {
            totalAmount: offer.total,
            nights: offer.nights,
            checkIn: checkIn.toISOString().slice(0, 10)
          },
          upsellMem
        )}`
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
    if (parseQuoteReplyAction(params.text) === "confirm") {
      return {
        nextState: "awaiting_confirmation",
        conversationState: DbConversationState.QUOTED,
        responseBody: "Great! Please share the guest name for the reservation.",
        updateSession: { awaitingGuestName: true }
      };
    }
  }

  if (params.state === "quoted" && params.event === "guest_cancelled") {
    const action = parseQuoteReplyAction(params.text);
    if (action === "cancel") {
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
      responseBody: "Sure. What would you like to change: dates, guests, rooms, or meal plan?",
      updateSession: { awaitingGuestName: false }
    };
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
      responseBody: "Sure. What would you like to change: dates, guests, rooms, or meal plan?",
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
      responseBody: validation.ok
        ? bookingStartPrompt(
            params.guestMemoryCtx
              ? { memory: params.guestMemoryCtx.memory, confirmedStayCount: params.guestMemoryCtx.confirmedStayCount }
              : undefined
          )
        : missingBookingDetailsPrompt(parsed),
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
  const hotelConfig = loadPartnerSetupConfig(hotel.id);
  const optimization = hotelConfig.optimizationSettings;
  const normalizedPhone = normalizePhone(input.from);
  const guest = await prisma.guest.upsert({
    where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: normalizedPhone } },
    update: {},
    create: { hotelId: hotel.id, phoneE164: normalizedPhone }
  });
  const guestMemoryBundle = await loadGuestMemoryContext(guest.id);

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
    severity: "high",
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
  if (
    await tryCompleteInStayTextCaptures({
      hotel,
      guest,
      conversation,
      normalizedPhone,
      text: input.text,
      persisted
    })
  ) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }
  if (
    await tryHandleInStayServiceListReply({
      hotel,
      guest,
      conversation,
      normalizedPhone,
      text: input.text,
      persisted
    })
  ) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }
  const propertyContextId = conversation.propertyId ?? persisted.suggestedPropertyId;

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

  const feedbackPendingBooking = await prisma.booking.findFirst({
    where: {
      hotelId: hotel.id,
      guestId: guest.id,
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
      guestJourneyReviewRequestSentAt: { not: null },
      checkOut: { lte: new Date() },
      feedbacks: { none: {} }
    },
    select: { id: true },
    orderBy: { checkOut: "desc" }
  });
  const feedbackOpen = await prisma.guestFeedback.findFirst({
    where: {
      hotelId: hotel.id,
      guestId: guest.id,
      status: { in: [GuestFeedbackStatus.AWAITING_CATEGORY, GuestFeedbackStatus.AWAITING_COMMENT] }
    },
    orderBy: { createdAt: "desc" }
  });
  const partnerCfg = loadPartnerSetupConfig(hotel.id);
  const feedbackGuestHi = (guest.fullName ?? "").trim().split(/\s+/)[0] || "there";

  const feedbackRating = parseGuestFeedbackRating(input.text);
  if (feedbackPendingBooking && feedbackRating !== null) {
    const created = await prisma.guestFeedback.create({
      data: {
        hotelId: hotel.id,
        bookingId: feedbackPendingBooking.id,
        guestId: guest.id,
        guestName: guest.fullName ?? undefined,
        rating: feedbackRating,
        isHappyGuest: feedbackRating >= 4,
        isPromoter: feedbackRating === 5,
        isIssueCase: feedbackRating <= 2,
        status: feedbackRating >= 4 ? GuestFeedbackStatus.AWAITING_COMMENT : GuestFeedbackStatus.AWAITING_CATEGORY
      }
    });
    const feedbackBooking = await prisma.booking.findUnique({
      where: { id: created.bookingId },
      select: { roomUnit: { select: { name: true } }, referenceCode: true, checkOut: true }
    });
    await prisma.auditLog.create({
      data: {
        hotelId: hotel.id,
        action: "GUEST_FEEDBACK_RATING_RECEIVED",
        entityType: "GuestFeedback",
        entityId: created.id,
        bookingId: created.bookingId,
        metadataJson: JSON.stringify({ rating: feedbackRating })
      }
    });
    if (feedbackRating <= 2 && !created.lowRatingAlertedAt && partnerCfg.feedbackNotificationsEnabled) {
      await prisma.guestFeedback.update({
        where: { id: created.id },
        data: { lowRatingAlertedAt: new Date() }
      });
      const lowBody = `Low guest rating ${feedbackRating}⭐ received${
        feedbackBooking?.roomUnit?.name ? ` · Room ${feedbackBooking.roomUnit.name}` : ""
      }${feedbackBooking?.referenceCode ? ` · ${feedbackBooking.referenceCode}` : ""}.`;
      await createRoleRoutedNotification({
        hotelId: hotel.id,
        roles: [UserRole.MANAGER, UserRole.FRONTDESK, UserRole.OWNER],
        title: "Low guest rating alert",
        body: lowBody,
        category: "bookings",
        severity: "high",
        link: "/admin/profile",
        sourceType: "GUEST_FEEDBACK_LOW_RATING",
        sourceId: created.id,
        requiresAttention: true
      }).catch(() => undefined);
    }
    if (feedbackRating >= 4) {
      const happyFollowUpBody = [
        `Thanks, ${feedbackGuestHi} — we're glad your stay landed well.`,
        "",
        "If you have a spare moment, a Google review helps other guests discover us.",
        "You can also send one short line here about what we did best — only if you'd like to."
      ].join("\n");
      try {
        await sendWhatsAppButtons({
          to: normalizedPhone,
          body: happyFollowUpBody,
          buttons: [
            { id: "fb_google_review", title: "Review on Google" },
            { id: "fb_google_skip", title: "Maybe later" }
          ],
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: `${happyFollowUpBody}\n\nReply REVIEW or LATER.`,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: happyFollowUpBody,
          aiIntent: "GUEST_FEEDBACK_COMMENT_PROMPT",
          aiConfidence: 0.99
        }
      });
    } else {
      const recoveryOpenBody = [
        `Thank you, ${feedbackGuestHi}. We're sorry this stay didn't meet what you expected.`,
        "",
        "May a manager reach out personally to see how we can make it right?"
      ].join("\n");
      try {
        await sendWhatsAppButtons({
          to: normalizedPhone,
          body: recoveryOpenBody,
          buttons: [
            { id: "fb_mgr_yes", title: "Yes, contact me" },
            { id: "fb_mgr_no", title: "No thanks" }
          ],
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: `${recoveryOpenBody}\n\nReply YES or NO.`,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      try {
        await sendWhatsAppList({
          to: normalizedPhone,
          body: "Where should we focus first? One tap is enough.",
          buttonText: "Pick focus area",
          sections: [
            {
              title: "Your feedback",
              rows: [
                { id: "fb_cat_cleanliness", title: "Cleanliness" },
                { id: "fb_cat_room_comfort", title: "Room and comfort" },
                { id: "fb_cat_service", title: "Service" },
                { id: "fb_cat_food_beverage", title: "Food & drinks" },
                { id: "fb_cat_facilities", title: "Facilities" },
                { id: "fb_cat_other", title: "Something else" }
              ]
            }
          ],
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } catch {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Where should we focus? Reply: Cleanliness, Room comfort, Service, Food & beverage, Facilities, or Other.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: `${recoveryOpenBody}\n\n(List) Where should we focus first?`,
          aiIntent: "GUEST_FEEDBACK_RECOVERY_PROMPT",
          aiConfidence: 0.99
        }
      });
    }
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (feedbackOpen) {
    const managerChoice = isManagerContactRequested(input.text);
    if (managerChoice !== null && feedbackOpen.rating <= 2) {
      if (managerChoice) {
        await prisma.guestFeedback.update({
          where: { id: feedbackOpen.id },
          data: { managerFollowUpRequestedAt: new Date() }
        });
        if (partnerCfg.feedbackNotificationsEnabled) {
          await createRoleRoutedNotification({
            hotelId: hotel.id,
            roles: [UserRole.MANAGER, UserRole.FRONTDESK, UserRole.OWNER],
            title: "Guest asked for manager follow-up",
            body: `Recovery follow-up requested for ${feedbackOpen.rating}⭐ feedback.`,
            category: "bookings",
            severity: "high",
            link: "/admin/profile",
            sourceType: "GUEST_FEEDBACK_MANAGER_FOLLOWUP",
            sourceId: feedbackOpen.id,
            requiresAttention: true
          }).catch(() => undefined);
        }
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Thank you — a manager will reach out shortly.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      } else {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "Understood. We appreciate you sharing this — it helps us improve.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (feedbackOpen.status === GuestFeedbackStatus.AWAITING_CATEGORY) {
      const picked = parseGuestFeedbackCategory(input.text);
      if (picked) {
        if (picked === "OTHER_COMMENT") {
          await prisma.guestFeedback.update({
            where: { id: feedbackOpen.id },
            data: { category: GuestFeedbackCategory.OTHER, status: GuestFeedbackStatus.AWAITING_COMMENT }
          });
          const prompt = "A few words in your own voice help us most — whenever you're ready.";
          await sendWhatsAppText({
            to: normalizedPhone,
            body: prompt,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
          await prisma.message.create({
            data: {
              hotelId: hotel.id,
              conversationId: conversation.id,
              direction: MessageDirection.OUTBOUND,
              body: prompt,
              aiIntent: "GUEST_FEEDBACK_OTHER_COMMENT_PROMPT",
              aiConfidence: 0.98
            }
          });
        } else {
          await prisma.guestFeedback.update({
            where: { id: feedbackOpen.id },
            data: { category: picked, status: GuestFeedbackStatus.COMPLETED }
          });
          const thanks = "Thank you — we've noted this and will put it to use.";
          await sendWhatsAppText({
            to: normalizedPhone,
            body: thanks,
            phoneNumberId: hotel.phoneNumberId,
            conversationId: conversation.id
          });
          await prisma.message.create({
            data: {
              hotelId: hotel.id,
              conversationId: conversation.id,
              direction: MessageDirection.OUTBOUND,
              body: thanks,
              aiIntent: "GUEST_FEEDBACK_COMPLETED",
              aiConfidence: 0.99
            }
          });
        }
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
    }
    if (feedbackOpen.status === GuestFeedbackStatus.AWAITING_COMMENT) {
      const comment = String(input.text ?? "").trim();
      const normalizedComment = normalizeText(comment).replace(/\s+/g, "_");
      if (normalizedComment === "fb_google_review" || normalizedComment === "review") {
        const reviewLink = partnerCfg.googleReviewLink?.trim();
        await prisma.guestFeedback.update({
          where: { id: feedbackOpen.id },
          data: {
            publicReviewClickedAt: new Date(),
            status: GuestFeedbackStatus.COMPLETED
          }
        });
        await sendWhatsAppText({
          to: normalizedPhone,
          body: reviewLink
            ? `With gratitude — here's your link:\n${reviewLink}`
            : "With gratitude — whenever it suits you, we'd love your words on Google.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (normalizedComment === "fb_google_skip" || normalizedComment === "skip" || normalizedComment === "fb_skip_comment") {
        await prisma.guestFeedback.update({
          where: { id: feedbackOpen.id },
          data: { status: GuestFeedbackStatus.AWAITING_COMMENT }
        });
        await sendWhatsAppText({
          to: normalizedPhone,
          body: "No problem. If you'd like, share one short comment here. If not, reply *skip comment*.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (normalizedComment === "fb_add_comment" || normalizedComment === "add_a_comment") {
        const prompt = "Take your time — a short note here is perfect.";
        await sendWhatsAppText({
          to: normalizedPhone,
          body: prompt,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: prompt,
            aiIntent: "GUEST_FEEDBACK_COMMENT_PROMPT",
            aiConfidence: 0.98
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (isGuestFeedbackSkipComment(comment)) {
        await prisma.guestFeedback.update({
          where: { id: feedbackOpen.id },
          data: { status: GuestFeedbackStatus.COMPLETED }
        });
        const thanks = "Thank you — we're grateful you took the time.";
        await sendWhatsAppText({
          to: normalizedPhone,
          body: thanks,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: thanks,
            aiIntent: "GUEST_FEEDBACK_COMPLETED",
            aiConfidence: 0.99
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (comment.length >= 1 && comment.length <= 500) {
        await prisma.guestFeedback.update({
          where: { id: feedbackOpen.id },
          data: { comment, status: GuestFeedbackStatus.COMPLETED }
        });
        const thanks = "Received — thank you. We'll read this carefully.";
        await sendWhatsAppText({
          to: normalizedPhone,
          body: thanks,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: thanks,
            aiIntent: "GUEST_FEEDBACK_COMPLETED",
            aiConfidence: 0.99
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
    }
  }

  if (conversationMode === "AGENT_MODE") {
    return;
  }

  if (guestJourneyOperationalReply?.matched && guestJourneyOperationalReply.category) {
    const repeatUpsellSoft =
      guestMemoryBundle.confirmedStayCount >= 2 || Boolean(guestMemoryBundle.memory.repeatGuest);
    const activitiesFromMemory =
      guestMemoryBundle.memory.preferredActivities?.some((a) => a === "dune_buggy" || a === "bbq") ?? false;
    const orchestrated = buildGuestJourneyOrchestratedReply({
      journey: guestJourneyOperationalReply,
      memory: { hadComplaint: guestMemoryBundle.memory.hadComplaint },
      repeatGuestSoft: repeatUpsellSoft,
      activitiesFromMemory
    });
    await sendWhatsAppText({
      to: normalizedPhone,
      body: orchestrated.replyBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: orchestrated.replyBody,
        aiIntent: orchestrated.aiIntent,
        aiConfidence: 0.97
      }
    });
    if (inboundMessageId) {
      void dispatchGuestJourneyIntentActions({
        hotelId: hotel.id,
        propertyId: propertyContextId,
        conversationId: conversation.id,
        guestId: guest.id,
        guestName: guest.fullName,
        guestPhone: guest.phoneE164,
        bookingId: guestJourneyOperationalReply.bookingId,
        referenceCode: guestJourneyOperationalReply.referenceCode,
        prismaMessageId: inboundMessageId,
        rawMessage: input.text,
        journeyReply: guestJourneyOperationalReply,
        orchestrated,
        memory: guestMemoryBundle.memory
      }).catch((err) =>
        console.error("[guest-action-dispatcher] failed:", err instanceof Error ? err.message : String(err))
      );
    }
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
        body:
          orchestrated.staffUpsellAppend && orchestrated.meta.effectiveUpsellType
            ? `${followBody} Upsell interest: ${orchestrated.meta.effectiveUpsellType}.`
            : followBody,
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

  if (!persisted.fbCartDraft && !hasOperationalBookingContext) {
    const inHouseBooking = await findGuestInHouseForServices(hotel.id, guest.id, hotel.timezone);
    if (inHouseBooking) {
      const lastMs = persisted.lastInStayMenuSentAt ? new Date(persisted.lastInStayMenuSentAt).getTime() : 0;
      const throttled = lastMs > 0 && Date.now() - lastMs < 4 * 60 * 1000;
      const compact = compactWhatsAppListRowId(input.text);
      const skipTap =
        compact.startsWith("isv_") ||
        compact.startsWith("fb_") ||
        compact.startsWith("mp_") ||
        compact.startsWith("edit_");
      if (
        !throttled &&
        !skipTap &&
        (conversationMode === "IDLE" || conversationMode === "QUESTION_MODE") &&
        !persisted.bookingStep &&
        !isBookingIntent(normalizedInputText)
      ) {
        const bf = await prisma.booking.findUnique({
          where: { id: inHouseBooking.id },
          select: { id: true, referenceCode: true, checkIn: true, checkOut: true, roomType: { select: { name: true } } }
        });
        if (bf) {
          const menuRes = await sendInStayServiceMenuForActiveConversation({
            hotelId: hotel.id,
            displayName: hotel.displayName,
            booking: bf,
            conversationId: conversation.id,
            normalizedPhoneDigits: normalizedPhone,
            phoneNumberId: hotel.phoneNumberId ?? undefined
          });
          if (menuRes.ok) {
            await saveConversationSession({
              hotelId: hotel.id,
              guestId: guest.id,
              conversationId: conversation.id,
              phoneE164: normalizedPhone,
              state: {
                ...persisted,
                lastActivityAt: new Date().toISOString(),
                lastInStayMenuSentAt: new Date().toISOString()
              }
            });
            await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
            return;
          }
        }
      }
    }
  }

  if (!persisted.fbCartDraft && isMenuChoiceHotelInfo(input.text)) {
    const body = buildHotelInfoHubMessage(hotel.displayName, persisted.language || "en");
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
        aiIntent: "HOTEL_INFO_HUB",
        aiConfidence: 0.95
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (!persisted.fbCartDraft && isMenuChoiceBrowseMenu(input.text)) {
    const initDraft = { purpose: "browse_only" as const, step: "category" as const, cart: [] };
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: persisted.stage || "new",
        lastActivityAt: new Date().toISOString(),
        conversationMode,
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
        fbCartDraft: initDraft,
        bookingFlowReturn: null
      }
    });
    await sendFoodFlowOutbounds({
      hotelId: hotel.id,
      to: normalizedPhone,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id,
      outbounds: [initialFbOrderList("browse_only")]
    });
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
    const stay = await findGuestInHouseForServices(hotel.id, guest.id, hotel.timezone);
    if (stay) {
      const mp = String(stay.mealPlan ?? "NONE").toUpperCase();
      if (mp === "HALF_BOARD" || mp === "FULL_BOARD") {
        await sendWhatsAppText({
          to: normalizedPhone,
          body:
            "Your stay includes a fixed board plan. Use the *Book meal time* option from your in-stay menu, or contact reception for included buffet / set-menu times. À la carte items outside the plan are extra and must be confirmed at reception.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
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

    if (adv.viewFinished && persisted.bookingFlowReturn !== "meal_plan") {
      const body =
        (persisted.language || "en") === "ar"
          ? "تم إغلاق تصفح القائمة. اكتب *menu* للعودة إلى الخدمات الرئيسية."
          : "Menu browsing closed. Type *menu* to return to the main services.";
      await sendWhatsAppText({
        to: normalizedPhone,
        body,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (adv.prebookFinished && nextPrebook !== undefined && nextPrebook !== null) {
      const adults = persisted.adultCount ?? persisted.guestCount ?? 2;
      const children = persisted.childCount ?? 0;
      const nights = persisted.nights ?? 1;
      const rooms = persisted.roomCount ?? 1;
      const guestCount = persisted.guestCount ?? adults + children;
      const mp = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
      const prebookLine = formatWhatsAppPrebookFolioEstimateLine(hotel.currency, nextPrebook.estimatedTotal);
      const { stayTotal } = computeWhatsAppStayTotalsFromRoomSubtotal({
        roomStaySubtotal: persisted.totalAmount,
        mealPlan: mp,
        adults,
        children,
        nights,
        rooms
      });
      const upsellBlock = `Tap a button below or reply YES to confirm, EDIT to change, NO to cancel.\n${getSmartUpsellTimingLine(
        {
          totalAmount: stayTotal,
          nights: nights,
          checkIn: persisted.checkIn
        },
        {
          memory: guestMemoryBundle.memory,
          repeatForSoftTone:
            guestMemoryBundle.confirmedStayCount >= 2 || Boolean(guestMemoryBundle.memory.repeatGuest),
          frequencyFactor: optimization.upsellFrequencyFactor,
          messageVariant: optimization.upsellMessageVariant
        }
      )}`;
      const { quoteBody } = buildWhatsAppBookingQuoteBundle({
        roomTypeName: persisted.suggestedRoomTypeName ?? "—",
        checkIn: String(persisted.checkIn ?? ""),
        checkOut: String(persisted.checkOut ?? ""),
        guestCount,
        adults,
        children,
        rooms,
        nights,
        currency: hotel.currency,
        roomStaySubtotal: persisted.totalAmount,
        mealPlan: mp,
        prebookLine,
        upsellBlock
      });
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
              { id: "mp_bf", title: "Breakfast", description: "Morning package" },
              { id: "mp_half", title: "Half board", description: "Breakfast + dinner" },
              { id: "mp_full", title: "Full board", description: "All main meals" }
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

  const explicitLanguageChoice = isLanguageChoice(input.text);
  if (!needsLanguageSelection(persisted.language) && isMenuChoiceChangeLanguage(input.text)) {
    await sendLanguageSelectionPrompt({
      to: normalizedPhone,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
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

  if (!needsLanguageSelection(persisted.language) && explicitLanguageChoice) {
    const lang = explicitLanguageChoice;
    persisted.language = lang;
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        ...persisted,
        language: lang,
        lastActivityAt: new Date().toISOString(),
        phoneNumberId: hotel.phoneNumberId
      }
    });

    const hasActiveBookingProgress =
      persisted.conversationMode === "BOOKING_MODE" && (Boolean(persisted.bookingStep) || Boolean(persisted.awaitingGuestName));
    if (hasActiveBookingProgress || persisted.conversationMode === "AGENT_MODE") {
      const body =
        lang === "ar"
          ? "تم تغيير اللغة إلى العربية. يمكنك المتابعة من نفس المكان."
          : "Language changed to English. You can continue from the same place.";
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
          aiIntent: "LANGUAGE_CHANGED",
          aiConfidence: 0.98
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    const menuPersonalizedLanguageChange = personalizeMainMenuBodies(hotel.displayName, lang, {
      memory: guestMemoryBundle.memory,
      confirmedStayCount: guestMemoryBundle.confirmedStayCount
    });
    const { recordedBody: languageMenuRecorded } = await sendMainMenuForGuest({
      hotel,
      guestId: guest.id,
      to: normalizedPhone,
      conversationId: conversation.id,
      menuBody: menuPersonalizedLanguageChange.menuBody,
      fallbackBody: menuPersonalizedLanguageChange.fallbackBody
    });
    if (menuPersonalizedLanguageChange.stampedWelcomeBack) {
      await recordWelcomeBackMenuShown(guest.id).catch(() => undefined);
    }
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: languageMenuRecorded,
        aiIntent: "LANGUAGE_CHANGED_MAIN_MENU",
        aiConfidence: 0.98
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (needsLanguageSelection(persisted.language)) {
    const chosenLang = explicitLanguageChoice;
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
      const menuPersonalized = personalizeMainMenuBodies(hotel.displayName, lang, {
        memory: guestMemoryBundle.memory,
        confirmedStayCount: guestMemoryBundle.confirmedStayCount
      });
      const { recordedBody: outboundRecordedBody } = await sendMainMenuForGuest({
        hotel,
        guestId: guest.id,
        to: normalizedPhone,
        conversationId: conversation.id,
        menuBody: menuPersonalized.menuBody,
        fallbackBody: menuPersonalized.fallbackBody
      });
      if (menuPersonalized.stampedWelcomeBack) {
        await recordWelcomeBackMenuShown(guest.id).catch(() => undefined);
      }
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
    // MENU/RESET context routing per hospitality best practice:
    //  - In-house guest (CHECKED_IN, OCCUPIED room, or in-stay welcome already sent) → in-stay service menu.
    //  - Otherwise (pre-arrival CONFIRMED, post-checkout, unknown) → standard property welcome / main menu.
    const inHouseForReset = await findGuestInHouseForServices(hotel.id, guest.id, hotel.timezone);
    if (inHouseForReset) {
      const bfReset = await prisma.booking.findUnique({
        where: { id: inHouseForReset.id },
        select: {
          id: true,
          referenceCode: true,
          checkIn: true,
          checkOut: true,
          roomType: { select: { name: true } }
        }
      });
      if (bfReset) {
        const inStaySend = await sendInStayServiceMenuForActiveConversation({
          hotelId: hotel.id,
          displayName: hotel.displayName,
          booking: bfReset,
          conversationId: conversation.id,
          normalizedPhoneDigits: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
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
            lastInStayMenuSentAt: inStaySend.ok ? new Date().toISOString() : persisted.lastInStayMenuSentAt
          }
        });
        return;
      }
    }
    const menuPersonalizedReset = personalizeMainMenuBodies(hotel.displayName, lang, {
      memory: guestMemoryBundle.memory,
      confirmedStayCount: guestMemoryBundle.confirmedStayCount
    });
    const { recordedBody: resetMenuRecorded } = await sendMainMenuForGuest({
      hotel,
      guestId: guest.id,
      to: normalizedPhone,
      conversationId: conversation.id,
      menuBody: menuPersonalizedReset.menuBody,
      fallbackBody: menuPersonalizedReset.fallbackBody
    });
    if (menuPersonalizedReset.stampedWelcomeBack) {
      await recordWelcomeBackMenuShown(guest.id).catch(() => undefined);
    }
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
        ...persisted,
        language: persisted.language || "en",
        stage: persisted.stage || "new",
        lastActivityAt: new Date().toISOString(),
        preHandoffConversationMode:
          persisted.conversationMode && persisted.conversationMode !== "AGENT_MODE"
            ? persisted.conversationMode
            : persisted.bookingStep || persisted.awaitingGuestName
              ? "BOOKING_MODE"
              : "IDLE",
        conversationMode: "AGENT_MODE",
        phoneNumberId: hotel.phoneNumberId
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (isMenuChoiceBookStay(input.text)) {
    const copy = bookingCopy(persisted.language);
    const isAr = bookingLang(persisted.language) === "ar";
    const bookingEntryBody = [
      isAr ? `لنحجز إقامتك في ${hotel.displayName} هنا داخل واتساب.` : `Let's book your stay at ${hotel.displayName} here in WhatsApp.`,
      isAr
        ? "سأجمع التفاصيل، أعرض خيارات الغرف، أؤكد الحجز، وأبقي المتابعة كلها في هذه المحادثة."
        : "I will collect the details, show live room options, confirm the reservation, and keep all follow-up messages in this chat.",
      "",
      copy.adultsPrompt
    ].join("\n");
    await sendCountSelectionListWithFallback({
      to: normalizedPhone,
      conversationId: conversation.id,
      phoneNumberId: hotel.phoneNumberId,
      body: bookingEntryBody,
      buttonText: copy.adultsButton,
      rowPrefix: "adults",
      min: 1,
      max: 8,
      fallbackPrompt: bookingEntryBody + "\n\n" + copy.adultsFallback
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: bookingEntryBody,
        aiIntent: "MENU_BOOKING_NATIVE_WHATSAPP_START",
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
        bookingStep: "adults",
        phoneNumberId: hotel.phoneNumberId,
        checkIn: undefined,
        checkOut: undefined,
        checkInOptions: [],
        checkOutOptions: [],
        manualCheckInDate: false,
        manualCheckOutDate: false,
        guestCount: undefined,
        roomCount: undefined,
        adultCount: undefined,
        childCount: undefined,
        capacityPickRoomTypes: undefined,
        bookingRoomOffers: undefined,
        suggestedRoomTypeId: undefined,
        suggestedRoomTypeName: undefined,
        suggestedPropertyId: undefined,
        nightlyRate: undefined,
        nights: undefined,
        totalAmount: undefined,
        bookingMealPlanCode: null,
        fbCartDraft: null,
        pendingPrebookOrder: null,
        bookingFlowReturn: null
      }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  if (conversationMode === "BOOKING_MODE" && getBookingSubMenuChoice(input.text)) {
    const choice = getBookingSubMenuChoice(input.text)!;
    if (choice === "check_availability") {
      const copy = bookingCopy(persisted.language);
      const stepBody = copy.adultsPrompt + (bookingLang(persisted.language) === "ar" ? "\n\nاكتب back للرجوع." : BOOKING_NAV_HINT);
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
      const body = await buildLiveRoomTypesForBookingSubmenu(hotel.id, hotel.currency);
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

  const quoteEditTarget = parseQuoteEditTarget(input.text);
  const quoteAction = parseQuoteReplyAction(input.text);
  const compactBookingAction = normalizeText(input.text).replace(/\s+/g, "_");
  if (conversationMode === "BOOKING_MODE" && (compactBookingAction === "pay_online" || compactBookingAction === "pay_at_hotel")) {
    const preference = compactBookingAction === "pay_online" ? "PAY_NOW" : "PAY_LATER";
    const body =
      preference === "PAY_NOW"
        ? bookingLang(persisted.language) === "ar"
          ? "تم اختيار الدفع الإلكتروني. سأرسل رابط دفع آمن بعد تأكيد الحجز."
          : "Online payment selected. I will send a secure payment link after booking confirmation."
        : bookingLang(persisted.language) === "ar"
          ? "تم اختيار الدفع في الفندق. سيكمل الاستقبال الدفع حسب سياسة الفندق."
          : "Pay at hotel selected. Reception will complete payment according to hotel policy.";
    await sendWhatsAppText({ to: normalizedPhone, body, phoneNumberId: hotel.phoneNumberId, conversationId: conversation.id });
    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: { ...persisted, bookingPaymentPreference: preference, lastActivityAt: new Date().toISOString(), conversationMode: "BOOKING_MODE" }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }
  if (
    conversationMode === "BOOKING_MODE" &&
    (currentState === "quoted" || currentState === "awaiting_confirmation") &&
    !persisted.bookingStep &&
    !persisted.awaitingGuestName &&
    (quoteAction === "change_details" || quoteEditTarget || isGenericQuoteEditRequest(input.text))
  ) {
    const hasQuoteContext =
      Boolean(persisted.checkIn && persisted.checkOut) &&
      Boolean((persisted.suggestedRoomTypeName && persisted.suggestedRoomTypeName.trim()) || persisted.suggestedRoomTypeId) &&
      typeof persisted.guestCount === "number" &&
      persisted.guestCount > 0 &&
      typeof persisted.totalAmount === "number" &&
      Number.isFinite(persisted.totalAmount);
    if (!hasQuoteContext) {
      const recoveryBody = "Let’s update your request. Please share the booking details you want to change.";
      await sendWhatsAppText({
        to: normalizedPhone,
        body: recoveryBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: recoveryBody,
          aiIntent: "BOOKING_EDIT_RECOVERY",
          aiConfidence: 0.92
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    const baseUpdateState = {
      language: persisted.language || "en",
      stage: "new",
      lastActivityAt: new Date().toISOString(),
      conversationMode: "BOOKING_MODE" as const,
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
      bookingPaymentPreference: persisted.bookingPaymentPreference,
      fbCartDraft: persisted.fbCartDraft,
      pendingPrebookOrder: persisted.pendingPrebookOrder,
      bookingFlowReturn: persisted.bookingFlowReturn
    };

    if (quoteEditTarget === "dates") {
      await sendBookingCheckInPrompt({
        hotelId: hotel.id,
        conversationId: conversation.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        language: persisted.language
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseUpdateState, bookingStep: "checkin" }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (quoteEditTarget === "guests") {
      const body = "How many adults will be staying?";
      await sendCountSelectionListWithFallback({
        to: normalizedPhone,
        conversationId: conversation.id,
        phoneNumberId: hotel.phoneNumberId,
        body,
        buttonText: "Adults",
        rowPrefix: "adults",
        min: 1,
        max: 8,
        fallbackPrompt: "How many adults will be staying? Reply with a number, e.g. 2."
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseUpdateState, bookingStep: "adults" }
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: "How many adults will be staying?",
          aiIntent: "BOOKING_EDIT_GUESTS",
          aiConfidence: 0.95
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (quoteEditTarget === "rooms") {
      const body = "How many rooms do you need?";
      await sendCountSelectionListWithFallback({
        to: normalizedPhone,
        conversationId: conversation.id,
        phoneNumberId: hotel.phoneNumberId,
        body,
        buttonText: "Rooms",
        rowPrefix: "rooms",
        min: 1,
        max: 6,
        fallbackPrompt: "How many rooms do you need? Reply with a number, e.g. 1 or 2."
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseUpdateState, bookingStep: "rooms" }
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body,
          aiIntent: "BOOKING_EDIT_ROOMS",
          aiConfidence: 0.95
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (quoteEditTarget === "meal_plan") {
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: buildMealPlanSelectionOutbounds(effectiveLang(persisted.language))
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseUpdateState, bookingStep: "meal_plan" }
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: "Choose your meal package:",
          aiIntent: "BOOKING_EDIT_MEAL_PLAN",
          aiConfidence: 0.96
        }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (quoteEditTarget === "payment") {
      const copy = bookingCopy(persisted.language);
      await sendWhatsAppList({
        to: normalizedPhone,
        body: copy.paymentChoiceBody,
        buttonText: copy.changePayment,
        sections: [
          {
            title: copy.changePayment,
            rows: [
              { id: "pay_online", title: copy.payOnline.slice(0, 24), description: copy.payOnlineDesc.slice(0, 72) },
              { id: "pay_at_hotel", title: copy.payAtHotel.slice(0, 24), description: copy.payAtHotelDesc.slice(0, 72) },
              { id: "talk_to_reception", title: copy.talkReception.slice(0, 24), description: copy.talkReceptionDesc.slice(0, 72) }
            ]
          }
        ],
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseUpdateState, bookingStep: undefined }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    await sendUniversalBookingChangeMenu({
      hotelId: hotel.id,
      conversationId: conversation.id,
      to: normalizedPhone,
      phoneNumberId: hotel.phoneNumberId,
      language: persisted.language,
      includeRoomType: Boolean(persisted.suggestedRoomTypeId || persisted.capacityPickRoomTypes?.length || persisted.bookingRoomOffers?.length)
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    return;
  }

  const quoteConfirmAction = isQuoteConfirmActionText(input.text);
  if (conversationMode === "BOOKING_MODE" && quoteConfirmAction) {
    const confirmActionKey = `${conversation.id}:${normalizeText(input.text)}:${input.messageId}`;
    console.info(
      "[booking.quote_confirm.incoming]",
      JSON.stringify({
        conversationId: conversation.id,
        guestId: guest.id,
        messageId: input.messageId,
        payload: input.text,
        currentState,
        awaitingGuestName: Boolean(persisted.awaitingGuestName),
        bookingStep: persisted.bookingStep ?? null
      })
    );
    const stateAllowsConfirm = currentState === "quoted" || currentState === "awaiting_confirmation";
    const alreadyHandled =
      persisted.quoteConfirmedActionKey === confirmActionKey ||
      Boolean(persisted.awaitingGuestName) ||
      currentState === "confirmed" ||
      conversation.state === DbConversationState.CONFIRMED;
    if (!stateAllowsConfirm || alreadyHandled) {
      const duplicateBody = persisted.awaitingGuestName
        ? "We already received your confirmation. Please share the full guest name for the reservation."
        : "Your booking confirmation is already in progress.";
      await sendWhatsAppText({
        to: normalizedPhone,
        body: duplicateBody,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body: duplicateBody,
          aiIntent: "BOOKING_QUOTE_CONFIRM_DUPLICATE_IGNORED",
          aiConfidence: 0.96
        }
      });
      console.info(
        "[booking.quote_confirm.ignored]",
        JSON.stringify({
          conversationId: conversation.id,
          messageId: input.messageId,
          duplicateIgnored: true,
          reason: !stateAllowsConfirm ? "state_not_confirmable" : "already_handled",
          currentState
        })
      );
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId: conversation.id,
      phoneE164: normalizedPhone,
      state: {
        language: persisted.language || "en",
        stage: "awaiting_confirmation",
        lastActivityAt: new Date().toISOString(),
        conversationMode: "BOOKING_MODE",
        awaitingGuestName: true,
        quoteConfirmedAt: new Date().toISOString(),
        quoteConfirmedActionKey: confirmActionKey,
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
        bookingFlowReturn: persisted.bookingFlowReturn,
        bookingStep: undefined
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { state: DbConversationState.QUOTED, lastMessageAt: new Date() }
    });
    const nextStepBody = "Great! Please share the full guest name for the reservation.";
    await sendWhatsAppText({
      to: normalizedPhone,
      body: nextStepBody,
      phoneNumberId: hotel.phoneNumberId,
      conversationId: conversation.id
    });
    await prisma.message.create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: nextStepBody,
        aiIntent: "BOOKING_QUOTE_CONFIRMED_NEXT_GUEST_NAME",
        aiConfidence: 0.98
      }
    });
    console.info(
      "[booking.quote_confirm.processed]",
      JSON.stringify({
        conversationId: conversation.id,
        messageId: input.messageId,
        stateBefore: currentState,
        stateAfter: "awaiting_confirmation",
        nextStep: "await_guest_name",
        duplicateIgnored: false
      })
    );
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
        split_rooms: "split_rooms",
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
        split_rooms: "Please choose how many rooms to split this group into.",
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
    const rooms = persisted.roomCount ?? 1;
    const guestCount = persisted.guestCount ?? adults + children;
    const mp = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
    const prebookLine = formatWhatsAppPrebookFolioEstimateLine(
      hotel.currency,
      persisted.pendingPrebookOrder?.estimatedTotal ?? 0
    );
    const { stayTotal } = computeWhatsAppStayTotalsFromRoomSubtotal({
      roomStaySubtotal: persisted.totalAmount,
      mealPlan: mp,
      adults,
      children,
      nights,
      rooms
    });
    const upsellBlock = `Tap a button below or reply YES to confirm, EDIT to change, NO to cancel.\n${getSmartUpsellTimingLine(
      {
        totalAmount: stayTotal,
        nights: nights,
        checkIn: persisted.checkIn
      },
      {
        memory: guestMemoryBundle.memory,
        repeatForSoftTone:
          guestMemoryBundle.confirmedStayCount >= 2 || Boolean(guestMemoryBundle.memory.repeatGuest),
        frequencyFactor: optimization.upsellFrequencyFactor,
        messageVariant: optimization.upsellMessageVariant
      }
    )}`;
    const { quoteBody } = buildWhatsAppBookingQuoteBundle({
      roomTypeName: persisted.suggestedRoomTypeName ?? "—",
      checkIn: String(persisted.checkIn ?? ""),
      checkOut: String(persisted.checkOut ?? ""),
      guestCount,
      adults,
      children,
      rooms,
      nights,
      currency: hotel.currency,
      roomStaySubtotal: persisted.totalAmount,
      mealPlan: mp,
      prebookLine,
      upsellBlock
    });
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
      totalAmount: persisted.totalAmount,
      bookingMealPlanCode: persisted.bookingMealPlanCode,
      bookingPaymentPreference: persisted.bookingPaymentPreference,
      lastAvailabilityIssue: persisted.lastAvailabilityIssue,
      bookingRecoveryNudgeSentAt: persisted.bookingRecoveryNudgeSentAt,
      bookingRecoveryRecheckSentAt: persisted.bookingRecoveryRecheckSentAt
    };

    function previousBookingStep(s: BookingStep): BookingStep | "submenu" {
      switch (s) {
        case "adults":
          return "submenu";
        case "children":
          return "adults";
        case "capacity_room_pick":
          return "children";
        case "split_rooms":
          return "children";
        case "rooms":
          return "children";
        case "checkin":
          return (persisted.roomCount ?? 1) > 1 ? "split_rooms" : "capacity_room_pick";
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

    const recoveryAction = normalizeText(input.text).replace(/\s+/g, "_");
    if (isUniversalChangeBookingRequest(input.text)) {
      await sendUniversalBookingChangeMenu({
        hotelId: hotel.id,
        conversationId: conversation.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        language: persisted.language,
        includeRoomType: Boolean(persisted.suggestedRoomTypeId || persisted.capacityPickRoomTypes?.length || persisted.bookingRoomOffers?.length)
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    const tryCheckIn = recoveryAction.match(/^try_checkin_(\d{4}-\d{2}-\d{2})$/);
    if (tryCheckIn) {
      const nextCheckIn = tryCheckIn[1]!;
      await sendBookingCheckOutPrompt({
        hotelId: hotel.id,
        conversationId: conversation.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        checkInIso: nextCheckIn,
        language: persisted.language
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseState, stage: "new", bookingStep: "checkout", checkIn: nextCheckIn, checkOut: undefined }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (
      recoveryAction === "no_avail_change_dates" ||
      recoveryAction === "change_dates" ||
      recoveryAction === "dates"
    ) {
      await sendBookingCheckInPrompt({
        hotelId: hotel.id,
        conversationId: conversation.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        language: persisted.language
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseState, stage: "new", bookingStep: "checkin", checkIn: undefined, checkOut: undefined }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (recoveryAction === "edit_meal_plan" || recoveryAction === "change_meal_plan" || recoveryAction === "meal_plan") {
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: buildMealPlanSelectionOutbounds(bookingLang(persisted.language))
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseState, stage: "new", bookingStep: "meal_plan" }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (recoveryAction === "edit_payment" || recoveryAction === "change_payment" || recoveryAction === "payment") {
      const copy = bookingCopy(persisted.language);
      await sendWhatsAppList({
        to: normalizedPhone,
        body: copy.paymentChoiceBody,
        buttonText: copy.changePayment,
        sections: [
          {
            title: copy.changePayment,
            rows: [
              { id: "pay_online", title: copy.payOnline.slice(0, 24), description: copy.payOnlineDesc.slice(0, 72) },
              { id: "pay_at_hotel", title: copy.payAtHotel.slice(0, 24), description: copy.payAtHotelDesc.slice(0, 72) },
              { id: "talk_to_reception", title: copy.talkReception.slice(0, 24), description: copy.talkReceptionDesc.slice(0, 72) }
            ]
          }
        ],
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (recoveryAction === "pay_online" || recoveryAction === "pay_at_hotel") {
      const preference = recoveryAction === "pay_online" ? "PAY_NOW" : "PAY_LATER";
      const copy = bookingCopy(persisted.language);
      const body =
        preference === "PAY_NOW"
          ? bookingLang(persisted.language) === "ar"
            ? "تم اختيار الدفع الإلكتروني. سأرسل رابط دفع آمن بعد تأكيد الحجز."
            : "Online payment selected. I will send a secure payment link after booking confirmation."
          : bookingLang(persisted.language) === "ar"
            ? "تم اختيار الدفع في الفندق. سيكمل الاستقبال الدفع حسب سياسة الفندق."
            : "Pay at hotel selected. Reception will complete payment according to hotel policy.";
      await sendWhatsAppText({ to: normalizedPhone, body, phoneNumberId: hotel.phoneNumberId, conversationId: conversation.id });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseState, stage: persisted.stage || "new", bookingStep: step, bookingPaymentPreference: preference }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (
      recoveryAction === "no_avail_change_rooms" ||
      recoveryAction === "change_room_count" ||
      recoveryAction === "rooms"
    ) {
      await sendCountSelectionListWithFallback({
        to: normalizedPhone,
        conversationId: conversation.id,
        phoneNumberId: hotel.phoneNumberId,
        body: bookingLang(persisted.language) === "ar" ? "كم غرفة تحتاج؟" : "How many rooms do you need?",
        buttonText: bookingLang(persisted.language) === "ar" ? "الغرف" : "Rooms",
        rowPrefix: "rooms",
        min: 1,
        max: 6,
        fallbackPrompt: bookingLang(persisted.language) === "ar" ? "اكتب عدد الغرف، مثل 1 أو 2." : "How many rooms do you need? Reply with a number, e.g. 1 or 2."
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseState, stage: "new", bookingStep: "rooms", checkOut: undefined }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (
      recoveryAction === "no_avail_change_guests" ||
      recoveryAction === "change_guests" ||
      recoveryAction === "guests"
    ) {
      const copy = bookingCopy(persisted.language);
      await sendCountSelectionListWithFallback({
        to: normalizedPhone,
        conversationId: conversation.id,
        phoneNumberId: hotel.phoneNumberId,
        body: copy.adultsPrompt,
        buttonText: copy.adultsButton,
        rowPrefix: "adults",
        min: 1,
        max: 8,
        fallbackPrompt: copy.adultsFallback
      });
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: { ...baseState, stage: "new", bookingStep: "adults", adultCount: undefined, childCount: undefined, guestCount: undefined, roomCount: undefined, checkOut: undefined }
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (
      recoveryAction === "no_avail_change_room_type" ||
      recoveryAction === "change_room_type" ||
      recoveryAction === "room_type"
    ) {
      const adults = persisted.adultCount ?? 1;
      const children = persisted.childCount ?? 0;
      const totalGuests = adults + children;
      const eligible = await getEligibleRoomTypesForBookingFlow(hotel.id, adults, children);
      if (eligible.length > 0) {
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
            ...baseState,
            stage: "new",
            bookingStep: "capacity_room_pick",
            adultCount: adults,
            childCount: children,
            guestCount: totalGuests,
            roomCount: 1,
            checkOut: undefined,
            capacityPickRoomTypes: eligible.map((t) => ({
              roomTypeId: t.id,
              name: t.name,
              capacity: t.capacity,
              baseNightlyRate: t.baseNightlyRate,
              propertyId: t.propertyId
            }))
          }
        });
      } else {
        await sendNoSingleRoomChoiceMenu({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          language: persisted.language,
          largest: await getLargestRoomTypesForFallback(hotel.id, 3)
        });
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }
    if (recoveryAction === "talk_to_reception" || recoveryAction === "reception") {
      await switchBookingConversationToReception({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        to: normalizedPhone,
        hotelDisplayName: hotel.displayName,
        phoneNumberId: hotel.phoneNumberId,
        state: { ...baseState, stage: "new", bookingStep: step, adultCount: persisted.adultCount, childCount: persisted.childCount }
      });
      return;
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
        await sendFoodFlowOutbounds({
          hotelId: hotel.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id,
          outbounds: buildMealPlanSelectionOutbounds(effectiveLang(persisted.language))
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
          await sendNoSingleRoomChoiceMenu({
            hotelId: hotel.id,
            conversationId: conversation.id,
            to: normalizedPhone,
            phoneNumberId: hotel.phoneNumberId,
            language: persisted.language,
            largest
          });
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...commonBack,
              bookingStep: "split_rooms",
              adultCount: adults,
              childCount: children,
              guestCount: adults + children,
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

      if (prev === "split_rooms") {
        const adults = persisted.adultCount ?? 1;
        const children = persisted.childCount ?? 0;
        const totalGuests = adults + children;
        const largest = await getLargestRoomTypesForFallback(hotel.id, 3);
        await sendSplitRoomOptions({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          language: persisted.language,
          totalGuests,
          adults,
          children,
          largest
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...commonBack,
            bookingStep: "split_rooms",
            adultCount: adults,
            childCount: children,
            guestCount: totalGuests,
            roomCount: undefined,
            capacityPickRoomTypes: undefined
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
          phoneNumberId: hotel.phoneNumberId,
          language: persisted.language
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
          checkInIso: persisted.checkIn,
          language: persisted.language
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
      const copy = bookingCopy(persisted.language);
      const num = parseCountSelection(input.text, "adults", 20);
      if (num === null) {
        await sendCountSelectionListWithFallback({
          to: normalizedPhone,
          conversationId: conversation.id,
          phoneNumberId: hotel.phoneNumberId,
          body: copy.adultsPrompt,
          buttonText: copy.adultsButton,
          rowPrefix: "adults",
          min: 1,
          max: 8,
          fallbackPrompt: copy.adultsFallback
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: copy.adultsFallback,
            aiIntent: "BOOKING_STEP_ADULTS_INVALID",
            aiConfidence: 0.9
          }
        });
      } else {
        await sendCountSelectionListWithFallback({
          to: normalizedPhone,
          conversationId: conversation.id,
          phoneNumberId: hotel.phoneNumberId,
          body: copy.childrenPrompt,
          buttonText: copy.childrenButton,
          rowPrefix: "children",
          min: 0,
          max: 6,
          fallbackPrompt: copy.childrenFallback
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: copy.childrenPrompt,
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
      const copy = bookingCopy(persisted.language);
      const num = parseCountSelection(input.text, "children", 20, true);
      if (num === null) {
        await sendCountSelectionListWithFallback({
          to: normalizedPhone,
          conversationId: conversation.id,
          phoneNumberId: hotel.phoneNumberId,
          body: copy.childrenPrompt,
          buttonText: copy.childrenButton,
          rowPrefix: "children",
          min: 0,
          max: 6,
          fallbackPrompt: copy.childrenFallback
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: copy.childrenFallback,
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
          await sendNoSingleRoomChoiceMenu({
            hotelId: hotel.id,
            conversationId: conversation.id,
            to: normalizedPhone,
            phoneNumberId: hotel.phoneNumberId,
            language: persisted.language,
            largest
          });
          await saveConversationSession({
            hotelId: hotel.id,
            guestId: guest.id,
            conversationId: conversation.id,
            phoneE164: normalizedPhone,
            state: {
              ...baseState,
              stage: "new",
              bookingStep: "split_rooms",
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

    if (step === "split_rooms") {
      const copy = bookingCopy(persisted.language);
      const raw = input.text.trim();
      const normalizedRaw = normalizeText(raw).replace(/\s+/g, "_");
      const adults = persisted.adultCount ?? 1;
      const children = persisted.childCount ?? 0;
      const totalGuests = adults + children;
      if (raw === "talk_to_reception" || normalizedRaw === "reception" || normalizedRaw === "talk_to_reception") {
        await switchBookingConversationToReception({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          to: normalizedPhone,
          hotelDisplayName: hotel.displayName,
          phoneNumberId: hotel.phoneNumberId,
          state: { ...baseState, stage: "new", bookingStep: "split_rooms", adultCount: adults, childCount: children, guestCount: totalGuests }
        });
        return;
      }
      if (raw === "split_rooms_now" || normalizedRaw === "split" || normalizedRaw === "split_rooms") {
        const largest = await getLargestRoomTypesForFallback(hotel.id, 3);
        await sendSplitRoomOptions({
          hotelId: hotel.id,
          conversationId: conversation.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          language: persisted.language,
          totalGuests,
          adults,
          children,
          largest
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (raw === "split_change_guests" || isBackOneStepText(raw)) {
        await sendCountSelectionListWithFallback({
          to: normalizedPhone,
          conversationId: conversation.id,
          phoneNumberId: hotel.phoneNumberId,
          body: bookingLang(persisted.language) === "ar" ? "كم عدد البالغين؟" : "How many adults will be staying?",
          buttonText: bookingLang(persisted.language) === "ar" ? "البالغون" : "Adults",
          rowPrefix: "adults",
          min: 1,
          max: 8,
          fallbackPrompt: bookingLang(persisted.language) === "ar" ? "اكتب عدد البالغين، مثل 2." : "How many adults will be staying? Reply with a number, e.g. 2."
        });
        await saveConversationSession({
          hotelId: hotel.id,
          guestId: guest.id,
          conversationId: conversation.id,
          phoneE164: normalizedPhone,
          state: {
            ...baseState,
            stage: "new",
            bookingStep: "adults",
            adultCount: undefined,
            childCount: undefined,
            guestCount: undefined,
            roomCount: undefined,
            capacityPickRoomTypes: undefined
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      const idMatch = raw.match(/^split_rooms_(\d+)$/);
      const roomCount = idMatch ? parseInt(idMatch[1]!, 10) : parseStepNumber(raw, 6);
      if (!roomCount || roomCount < 2 || roomCount > 6) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body: copy.invalidSplit,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await prisma.message.create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            body: copy.invalidSplit,
            aiIntent: "BOOKING_STEP_SPLIT_ROOMS_INVALID",
            aiConfidence: 0.9
          }
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
          ...baseState,
          stage: "new",
          bookingStep: "checkin",
          adultCount: adults,
          childCount: children,
          guestCount: totalGuests,
          roomCount,
          suggestedRoomTypeId: undefined,
          suggestedRoomTypeName: undefined,
          suggestedPropertyId: undefined,
          capacityPickRoomTypes: undefined,
          manualCheckInDate: false,
          manualCheckOutDate: false
        }
      });
      await sendBookingCheckInPrompt({
        hotelId: hotel.id,
        conversationId: conversation.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        language: persisted.language
      });
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
          phoneNumberId: hotel.phoneNumberId,
          language: persisted.language
        });
      }
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      return;
    }

    if (step === "rooms") {
      const num = parseCountSelection(input.text, "rooms", 10);
      if (num === null) {
        await sendCountSelectionListWithFallback({
          to: normalizedPhone,
          conversationId: conversation.id,
          phoneNumberId: hotel.phoneNumberId,
          body: "Please choose the number of rooms:",
          buttonText: "Rooms",
          rowPrefix: "rooms",
          min: 1,
          max: 6,
          fallbackPrompt: "Please reply with the number of rooms (e.g. 1 or 2)."
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
          phoneNumberId: hotel.phoneNumberId,
          language: persisted.language
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
          checkInIso,
          language: persisted.language
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
          const nearestDates = await findNearestAvailableCheckIns({
            hotelId: hotel.id,
            fromDate: checkInDate,
            nights: Math.max(1, Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / (24 * 60 * 60 * 1000))),
            guests,
            rooms,
            ...(typeof persisted.adultCount === "number" && typeof persisted.childCount === "number"
              ? { adults: persisted.adultCount, children: persisted.childCount }
              : {})
          });
          await sendNoAvailabilityRecoveryMenu({
            hotelId: hotel.id,
            conversationId: conversation.id,
            to: normalizedPhone,
            phoneNumberId: hotel.phoneNumberId,
            language: persisted.language,
            includeRoomType: Boolean(persisted.suggestedRoomTypeId || persisted.capacityPickRoomTypes?.length),
            nearestDates
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
              manualCheckOutDate: false,
              lastAvailabilityIssue: `No availability for ${guests} guest(s), ${rooms} room(s), ${persisted.checkIn} to ${checkOutDate.toISOString().slice(0, 10)}`
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
      const mealPlanOutbounds = buildMealPlanSelectionOutbounds(effectiveLang(persisted.language));
      if (t.includes("mp_view")) {
        await sendWhatsAppText({
          to: normalizedPhone,
          body:
            "Browsing the full à la carte menu during booking is available for *room only* or *breakfast* stays. Half board and full board are fixed plans—after check-in you can pick meal times and included buffet / set-menu options on WhatsApp.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        await sendFoodFlowOutbounds({
          hotelId: hotel.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id,
          outbounds: mealPlanOutbounds
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      let code: WhatsAppMealPlanCode | null = null;
      if (t.includes("mp_half")) code = "HALF_BOARD";
      else if (t.includes("mp_full")) code = "FULL_BOARD";
      else if (t.includes("mp_bf")) code = "BREAKFAST";
      else if (t.includes("mp_none")) code = "NONE";
      if (code === null) {
        await sendFoodFlowOutbounds({
          hotelId: hotel.id,
          to: normalizedPhone,
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id,
          outbounds: mealPlanOutbounds
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      if (code === "HALF_BOARD" || code === "FULL_BOARD") {
        await sendWhatsAppText({
          to: normalizedPhone,
          body:
            "Your meal plan is fixed (buffet, set menu, or choices from the hotel’s approved board menu only). You can select meal times and included options after check-in on WhatsApp—we do not build à la carte meals during booking for this plan.",
          phoneNumberId: hotel.phoneNumberId,
          conversationId: conversation.id
        });
        const adults = persisted.adultCount ?? persisted.guestCount ?? 2;
        const children = persisted.childCount ?? 0;
        const nights = persisted.nights ?? 1;
        const rooms = persisted.roomCount ?? 1;
        const guestCount = persisted.guestCount ?? adults + children;
        const mp = whatsAppMealPlanToPricingCode(code);
        const { stayTotal } = computeWhatsAppStayTotalsFromRoomSubtotal({
          roomStaySubtotal: persisted.totalAmount,
          mealPlan: mp,
          adults,
          children,
          nights,
          rooms
        });
        const upsellBlock = `Tap a button below or reply YES to confirm, EDIT to change, NO to cancel.\n${getSmartUpsellTimingLine(
          {
            totalAmount: stayTotal,
            nights: nights,
            checkIn: persisted.checkIn
          },
          {
            memory: guestMemoryBundle.memory,
            repeatForSoftTone:
              guestMemoryBundle.confirmedStayCount >= 2 || Boolean(guestMemoryBundle.memory.repeatGuest),
            frequencyFactor: optimization.upsellFrequencyFactor,
            messageVariant: optimization.upsellMessageVariant
          }
        )}`;
        const { quoteBody } = buildWhatsAppBookingQuoteBundle({
          roomTypeName: persisted.suggestedRoomTypeName ?? "—",
          checkIn: String(persisted.checkIn ?? ""),
          checkOut: String(persisted.checkOut ?? ""),
          guestCount,
          adults,
          children,
          rooms,
          nights,
          currency: hotel.currency,
          roomStaySubtotal: persisted.totalAmount,
          mealPlan: mp,
          prebookLine: null,
          upsellBlock
        });
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
            bookingMealPlanCode: code,
            pendingPrebookOrder: null
          }
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { state: DbConversationState.QUOTED, lastMessageAt: new Date() }
        });
        return;
      }
      const mealLabel = code === "NONE" ? "Room only" : code === "BREAKFAST" ? "Breakfast" : String(code);
      await sendWhatsAppText({
        to: normalizedPhone,
        body: `✓ Meal plan: *${mealLabel}* — you can change it later with *EDIT* if needed.`,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id
      });
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
        const rooms = persisted.roomCount ?? 1;
        const guestCount = persisted.guestCount ?? adults + children;
        const mp = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
        const { stayTotal } = computeWhatsAppStayTotalsFromRoomSubtotal({
          roomStaySubtotal: persisted.totalAmount,
          mealPlan: mp,
          adults,
          children,
          nights,
          rooms
        });
        const upsellBlock = `Tap a button below or reply YES to confirm, EDIT to change, NO to cancel.\n${getSmartUpsellTimingLine(
          {
            totalAmount: stayTotal,
            nights: nights,
            checkIn: persisted.checkIn
          },
          {
            memory: guestMemoryBundle.memory,
            repeatForSoftTone:
              guestMemoryBundle.confirmedStayCount >= 2 || Boolean(guestMemoryBundle.memory.repeatGuest),
            frequencyFactor: optimization.upsellFrequencyFactor,
            messageVariant: optimization.upsellMessageVariant
          }
        )}`;
        const { quoteBody } = buildWhatsAppBookingQuoteBundle({
          roomTypeName: persisted.suggestedRoomTypeName ?? "—",
          checkIn: String(persisted.checkIn ?? ""),
          checkOut: String(persisted.checkOut ?? ""),
          guestCount,
          adults,
          children,
          rooms,
          nights,
          currency: hotel.currency,
          roomStaySubtotal: persisted.totalAmount,
          mealPlan: mp,
          prebookLine: null,
          upsellBlock
        });
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
      const storedOffers = persisted.bookingRoomOffers ?? [];
      let offers = storedOffers;
      if (persisted.checkIn && persisted.checkOut) {
        const checkIn = new Date(`${persisted.checkIn}T00:00:00Z`);
        const checkOut = new Date(`${persisted.checkOut}T00:00:00Z`);
        if (!Number.isNaN(checkIn.getTime()) && !Number.isNaN(checkOut.getTime())) {
          offers = await findAvailableRoomTypes({
            hotelId: hotel.id,
            checkIn,
            checkOut,
            guests: persisted.guestCount ?? Math.max(1, (persisted.adultCount ?? 0) + (persisted.childCount ?? 0)),
            rooms: persisted.roomCount ?? 1,
            adults: persisted.adultCount,
            children: persisted.childCount
          });
        }
      }
      const offer = offers.find((o) => o.roomTypeId === chosenId || o.roomTypeName.toLowerCase().includes(chosenId.toLowerCase()));
      if (!offer) {
        const body = "The room price or availability has just changed. Please check availability again so I can show the latest live rates.";
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
            aiIntent: "BOOKING_STEP_ROOM_CHOICE_INVALID",
            aiConfidence: 0.9
          }
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        return;
      }
      await sendFoodFlowOutbounds({
        hotelId: hotel.id,
        to: normalizedPhone,
        phoneNumberId: hotel.phoneNumberId,
        conversationId: conversation.id,
        outbounds: buildMealPlanSelectionOutbounds(effectiveLang(persisted.language))
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

    const mpCode = whatsAppMealPlanToPricingCode(persisted.bookingMealPlanCode ?? null);
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
      preferredRoomTypeId: persisted.suggestedRoomTypeId,
      mealPlan: mpCode,
      source: ChannelProvider.WHATSAPP
    });

    // `bookingService` returns `totalAmount` as the *group-wide* total (room + meal-plan), and per-row
    // `Booking.totalAmount` already has the meal share evenly distributed across child bookings. We must NOT
    // re-add the meal surcharge here (would double-count) and must NOT overwrite only the primary booking's
    // total (would desync child rows). Trust the canonical numbers returned by the booking service.
    const combinedStayTotal = booking.totalAmount;
    const mealPart = booking.mealSubtotal;
    const roomStayTotal = Number((combinedStayTotal - mealPart).toFixed(2));
    await mergeLightGuestMemorySpendingTouch({
      guestId: guest.id,
      totalAmount: combinedStayTotal,
      nights: booking.nights
    }).catch((err) =>
      console.error("[light-guest-memory] spending touch failed:", err instanceof Error ? err.message : String(err))
    );

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
        prebookSummaryLine = formatWhatsAppPrebookFolioEstimateLine(hotel.currency, po.estimatedTotal);
      } catch (err) {
        console.error("Pre-book F&B on confirm failed:", err instanceof Error ? err.message : String(err));
        prebookSummaryLine =
          "Pre-booked F&B could not be posted automatically — please contact reception with your order.";
      }
    }

    let paymentLink: string | null = null;
    let paymentLinkError: string | null = null;
    let paymentLinkMissingSetup = false;
    const payLaterSelected = persisted.bookingPaymentPreference === "PAY_LATER";
    if (!payLaterSelected) {
      try {
        const payment = await createBookingPaymentLink({
          hotelId: hotel.id,
          hotelName: hotel.displayName,
          bookingId: booking.bookingId,
          guestEmail: guest.email,
          amount: combinedStayTotal,
          currency: hotel.currency,
          description: `${rooms} room(s), ${booking.roomTypeName}, ${checkIn.toISOString().slice(0, 10)} to ${checkOut
            .toISOString()
            .slice(0, 10)}`,
          source: "whatsapp_native_booking"
        });
        paymentLink = payment.paymentLinkUrl;
      } catch (err) {
        if (err instanceof BookingPaymentLinkUnavailableError) {
          paymentLinkError = err.message;
          paymentLinkMissingSetup = true;
          console.warn("[whatsapp booking] payment link skipped:", err.message);
        } else {
          paymentLinkError = err instanceof Error ? err.message : String(err);
          console.error("[whatsapp booking] payment link creation failed:", err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (!paymentLink && !payLaterSelected) {
      await createRoleRoutedNotification({
        hotelId: hotel.id,
        propertyId: booking.propertyId,
        roles: [UserRole.FRONTDESK, UserRole.FINANCE, UserRole.MANAGER, UserRole.OWNER],
        title: "WhatsApp booking needs payment follow-up",
        body: `Booking ${booking.bookingId} was confirmed, but an automatic payment link was not sent. ${
          paymentLinkMissingSetup
            ? "Payment provider is not enabled on this server. For Oman, set PAYMENT_PROVIDER=thawani plus THAWANI_API_KEY and THAWANI_PUBLISHABLE_KEY."
            : "Payment checkout link creation failed during checkout."
        }${paymentLinkError ? ` Reason: ${paymentLinkError}` : ""}`,
        category: "payments",
        severity: "high",
        link: `/admin/bookings/${encodeURIComponent(booking.bookingId)}`,
        sourceType: "BOOKING_PAYMENT_LINK_FAILED",
        sourceId: booking.bookingId,
        requiresAttention: true,
        audience: ["front_desk", "owner"]
      }).catch(() => undefined);
    }

    const lang = effectiveLang(persisted.language);
    // Multi-room split summary: show the group reference + every reservation reference so the guest sees
    // the full picture (one transaction, one group, N reservation numbers). The default behaviour is single
    // master payer / one folio under the primary reservation; reception can switch to separate bills later.
    const isMultiRoom = booking.bookingIds.length > 1;
    const multiRoomLinesEn = isMultiRoom
      ? [
          "",
          `Reservations under this booking (group ref: ${booking.bookingGroupId ?? "—"}):`,
          ...booking.bookingIds.map((id, idx) => `  • Room ${idx + 1}: ${id}${idx === 0 ? " (primary payer / folio)" : ""}`),
          "Default: one master folio on the primary reservation. Reply *separate bills* if each room should pay separately, or share guest names per room (e.g. Room 1 — John, Room 2 — Anna)."
        ]
      : [];
    const multiRoomLinesAr = isMultiRoom
      ? [
          "",
          `الحجوزات ضمن هذه الإقامة (رقم المجموعة: ${booking.bookingGroupId ?? "—"}):`,
          ...booking.bookingIds.map((id, idx) => `  • الغرفة ${idx + 1}: ${id}${idx === 0 ? " (الدافع الرئيسي / الفاتورة)" : ""}`),
          "افتراضيًا: فاتورة واحدة على الحجز الرئيسي. اكتب *فواتير منفصلة* لتقسيم الفواتير، أو أرسل أسماء الضيوف لكل غرفة (مثال: الغرفة 1 — جون، الغرفة 2 — آنا)."
        ]
      : [];
    const confirmationBody =
      lang === "ar"
        ? [
            "تم تأكيد الحجز بنجاح.",
            `اسم الضيف: ${providedName}`,
            `الفندق: ${hotel.displayName}`,
            `الغرفة: ${booking.roomTypeName}`,
            `الوصول: ${checkIn.toISOString().slice(0, 10)}`,
            `المغادرة: ${checkOut.toISOString().slice(0, 10)}`,
            `الضيوف: ${guests} (${adultsForBooking} بالغ، ${childrenForBooking} طفل)`,
            `الليالي: ${booking.nights}`,
            `الغرف: ${booking.roomCount}`,
            `إجمالي الإقامة: ${roomStayTotal.toFixed(2)} ${hotel.currency}`,
            mealPart > 0
              ? `إضافة الوجبات (${mpCode}): ${booking.roomCount} غرفة × ${booking.nights} ليلة = +${mealPart.toFixed(2)} ${hotel.currency}`
              : "خطة الوجبات: بدون",
            prebookSummaryLine,
            `الإجمالي النهائي: ${combinedStayTotal.toFixed(2)} ${hotel.currency}`,
            `رقم الحجز: ${booking.bookingId}`,
            ...multiRoomLinesAr,
            paymentLink
              ? `رابط الدفع الآمن: ${paymentLink}`
              : "الدفع: لم نتمكن من إنشاء رابط الدفع تلقائيًا الآن. يمكنك الدفع حسب سياسة الفندق، وقد يتواصل معك موظف الاستقبال عند الحاجة.",
            "",
            "اكتب *MENU* أو *القائمة* للعودة إلى القائمة الرئيسية."
          ]
            .filter((x): x is string => typeof x === "string" && x.length > 0)
            .join("\n")
        : [
            "Booking confirmed successfully.",
            `Guest: ${providedName}`,
            `Hotel: ${hotel.displayName}`,
            `Room: ${booking.roomTypeName}`,
            `Check-in: ${checkIn.toISOString().slice(0, 10)}`,
            `Check-out: ${checkOut.toISOString().slice(0, 10)}`,
            `Guests: ${guests} (${adultsForBooking} adults, ${childrenForBooking} children)`,
            `Nights: ${booking.nights}`,
            `Rooms: ${booking.roomCount}`,
            `Room stay total: ${roomStayTotal.toFixed(2)} ${hotel.currency}`,
            mealPart > 0
              ? `Meal plan (${mpCode}): ${booking.roomCount} room(s) × ${booking.nights} night(s) = +${mealPart.toFixed(2)} ${hotel.currency}`
              : "Meal plan: none",
            prebookSummaryLine,
            `Booking total: ${combinedStayTotal.toFixed(2)} ${hotel.currency}`,
            `Booking ID: ${booking.bookingId}`,
            ...multiRoomLinesEn,
            paymentLink
              ? `Secure payment link: ${paymentLink}`
              : payLaterSelected
                ? "Payment: pay at the hotel according to hotel policy."
                : paymentLinkMissingSetup
                  ? "Payment: online payment is not enabled by the hotel yet. Your booking is received, and reception will follow up with the payment method."
                  : "Payment: the secure payment link could not be generated right now. Your booking is received, and reception will follow up with the payment method.",
            "",
            "Reply *MENU* anytime to return to the main menu."
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
        quoteConfirmedAt: undefined,
        quoteConfirmedActionKey: undefined,
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
      const menuPersonalizedMyBooking = personalizeMainMenuBodies(
        hotel.displayName,
        effectiveLang(persisted.language),
        { memory: guestMemoryBundle.memory, confirmedStayCount: guestMemoryBundle.confirmedStayCount }
      );
      const { recordedBody: myBookingMenuRecorded } = await sendMainMenuForGuest({
        hotel,
        guestId: guest.id,
        to: normalizedPhone,
        conversationId: conversation.id,
        menuBody: menuPersonalizedMyBooking.menuBody,
        fallbackBody: menuPersonalizedMyBooking.fallbackBody
      });
      if (menuPersonalizedMyBooking.stampedWelcomeBack) {
        await recordWelcomeBackMenuShown(guest.id).catch(() => undefined);
      }
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
      const summary = [
        "Here is your booking:",
        formatBookingSummary({
          id: bookingToShow.id,
          guest: bookingToShow.guest,
          roomType: bookingToShow.roomType,
          checkIn: bookingToShow.checkIn,
          checkOut: bookingToShow.checkOut,
          nights: bookingToShow.nights,
          adults: bookingToShow.adults,
          children: bookingToShow.children,
          totalAmount: bookingToShow.totalAmount,
          currency: bookingToShow.currency,
          status: bookingToShow.status,
          paymentStatus: bookingToShow.paymentStatus,
          mealPlan: bookingToShow.mealPlan
        })
      ].join("\n");
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
    const inHouseGreet = await findGuestInHouseForServices(hotel.id, guest.id, hotel.timezone);
    if (inHouseGreet) {
      const lastMenuMs = persisted.lastInStayMenuSentAt ? new Date(persisted.lastInStayMenuSentAt).getTime() : 0;
      const menuThrottled = lastMenuMs > 0 && Date.now() - lastMenuMs < 4 * 60 * 1000;
      if (!menuThrottled) {
        const bf = await prisma.booking.findUnique({
          where: { id: inHouseGreet.id },
          select: { id: true, referenceCode: true, checkIn: true, checkOut: true, roomType: { select: { name: true } } }
        });
        if (bf) {
          const menuRes = await sendInStayServiceMenuForActiveConversation({
            hotelId: hotel.id,
            displayName: hotel.displayName,
            booking: bf,
            conversationId: conversation.id,
            normalizedPhoneDigits: normalizedPhone,
            phoneNumberId: hotel.phoneNumberId ?? undefined
          });
          if (menuRes.ok) {
            await saveConversationSession({
              hotelId: hotel.id,
              guestId: guest.id,
              conversationId: conversation.id,
              phoneE164: normalizedPhone,
              state: {
                ...persisted,
                lastActivityAt: new Date().toISOString(),
                lastInStayMenuSentAt: new Date().toISOString(),
                stage: "new",
                conversationMode: "IDLE"
              }
            });
            await prisma.message.create({
              data: {
                hotelId: hotel.id,
                conversationId: conversation.id,
                direction: MessageDirection.OUTBOUND,
                body: menuRes.recordedBody.slice(0, 4000),
                aiIntent: "IN_STAY_SERVICE_MENU_GREETING",
                aiConfidence: 0.98
              }
            });
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { state: DbConversationState.NEW, lastMessageAt: new Date() }
            });
            return;
          }
        }
      }
    }
    const menuPersonalizedGreeting = personalizeMainMenuBodies(
      hotel.displayName,
      effectiveLang(persisted.language),
      { memory: guestMemoryBundle.memory, confirmedStayCount: guestMemoryBundle.confirmedStayCount }
    );
    const { recordedBody: greetingMenuRecorded } = await sendMainMenuForGuest({
      hotel,
      guestId: guest.id,
      to: normalizedPhone,
      conversationId: conversation.id,
      menuBody: menuPersonalizedGreeting.menuBody,
      fallbackBody: menuPersonalizedGreeting.fallbackBody
    });
    if (menuPersonalizedGreeting.stampedWelcomeBack) {
      await recordWelcomeBackMenuShown(guest.id).catch(() => undefined);
    }
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
    const menuPersonalizedFallback = personalizeMainMenuBodies(
      hotel.displayName,
      effectiveLang(persisted.language),
      { memory: guestMemoryBundle.memory, confirmedStayCount: guestMemoryBundle.confirmedStayCount }
    );
    const { recordedBody: fallbackMenuRecorded } = await sendMainMenuForGuest({
      hotel,
      guestId: guest.id,
      to: normalizedPhone,
      conversationId: conversation.id,
      menuBody: menuPersonalizedFallback.menuBody,
      fallbackBody: menuPersonalizedFallback.fallbackBody
    });
    if (menuPersonalizedFallback.stampedWelcomeBack) {
      await recordWelcomeBackMenuShown(guest.id).catch(() => undefined);
    }
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
    },
      guestMemoryCtx: guestMemoryBundle,
      optimizationCtx: {
        upsellFrequencyFactor: optimization.upsellFrequencyFactor,
        upsellMessageVariant: optimization.upsellMessageVariant
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

