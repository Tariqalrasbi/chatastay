import { Router } from "express";
import { handleIncomingWhatsAppMessage } from "./conversationController";
import { WhatsAppWebhookPayload } from "./types";

export const whatsappWebhookRouter = Router();

function extractInboundText(message: Record<string, unknown>): string | undefined {
  const textBody = (message.text as { body?: unknown } | undefined)?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const buttonText = (message.button as { text?: unknown } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactive = message.interactive as
    | { button_reply?: { title?: unknown; id?: unknown }; list_reply?: { title?: unknown; id?: unknown } }
    | undefined;
  const buttonId = interactive?.button_reply?.id;
  if (typeof buttonId === "string" && buttonId.trim()) return buttonId.trim();
  const buttonTitle = interactive?.button_reply?.title;
  if (typeof buttonTitle === "string" && buttonTitle.trim()) return buttonTitle.trim();
  const listId = interactive?.list_reply?.id;
  if (typeof listId === "string" && listId.trim()) return listId.trim();
  const listTitle = interactive?.list_reply?.title;
  if (typeof listTitle === "string" && listTitle.trim()) return listTitle.trim();

  const imageCaption = (message.image as { caption?: unknown } | undefined)?.caption;
  if (typeof imageCaption === "string" && imageCaption.trim()) return imageCaption.trim();

  const documentCaption = (message.document as { caption?: unknown } | undefined)?.caption;
  if (typeof documentCaption === "string" && documentCaption.trim()) return documentCaption.trim();

  return undefined;
}

whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && verifyToken === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

whatsappWebhookRouter.post("/", async (req, res) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;
    if (payload.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const inboundPhoneNumberId = change.value?.metadata?.phone_number_id;
        for (const msg of change.value?.messages ?? []) {
          const text = extractInboundText(msg as unknown as Record<string, unknown>);
          if (!msg.from || !msg.id || !text) continue;
          await handleIncomingWhatsAppMessage({
            from: msg.from,
            messageId: msg.id,
            text,
            inboundPhoneNumberId
          });
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("WhatsApp webhook processing error:", message);
    return res.sendStatus(200);
  }
});

import { Router } from "express";
import { handleIncomingWhatsAppMessage } from "./conversationController";
import { WhatsAppWebhookPayload } from "./types";

export const whatsappWebhookRouter = Router();

function extractInboundText(message: Record<string, unknown>): string | undefined {
  const textBody = (message.text as { body?: unknown } | undefined)?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const buttonText = (message.button as { text?: unknown } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactive = message.interactive as
    | { button_reply?: { title?: unknown; id?: unknown }; list_reply?: { title?: unknown; id?: unknown } }
    | undefined;
  const buttonId = interactive?.button_reply?.id;
  if (typeof buttonId === "string" && buttonId.trim()) return buttonId.trim();
  const buttonTitle = interactive?.button_reply?.title;
  if (typeof buttonTitle === "string" && buttonTitle.trim()) return buttonTitle.trim();
  const listId = interactive?.list_reply?.id;
  if (typeof listId === "string" && listId.trim()) return listId.trim();
  const listTitle = interactive?.list_reply?.title;
  if (typeof listTitle === "string" && listTitle.trim()) return listTitle.trim();

  const imageCaption = (message.image as { caption?: unknown } | undefined)?.caption;
  if (typeof imageCaption === "string" && imageCaption.trim()) return imageCaption.trim();

  const documentCaption = (message.document as { caption?: unknown } | undefined)?.caption;
  if (typeof documentCaption === "string" && documentCaption.trim()) return documentCaption.trim();

  return undefined;
}

whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && verifyToken === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

whatsappWebhookRouter.post("/", async (req, res) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;
    if (payload.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const inboundPhoneNumberId = change.value?.metadata?.phone_number_id;
        for (const msg of change.value?.messages ?? []) {
          const text = extractInboundText(msg as unknown as Record<string, unknown>);
          if (!msg.from || !msg.id || !text) continue;
          await handleIncomingWhatsAppMessage({
            from: msg.from,
            messageId: msg.id,
            text,
            inboundPhoneNumberId
          });
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("WhatsApp webhook processing error:", message);
    return res.sendStatus(200);
  }
});

import { Router } from "express";
import { handleIncomingWhatsAppMessage } from "./conversationController";
import { WhatsAppWebhookPayload } from "./types";

export const whatsappWebhookRouter = Router();

function extractInboundText(message: Record<string, unknown>): string | undefined {
  const textBody = (message.text as { body?: unknown } | undefined)?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const buttonText = (message.button as { text?: unknown } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactive = message.interactive as
    | { button_reply?: { title?: unknown; id?: unknown }; list_reply?: { title?: unknown; id?: unknown } }
    | undefined;
  const buttonId = interactive?.button_reply?.id;
  if (typeof buttonId === "string" && buttonId.trim()) return buttonId.trim();
  const buttonTitle = interactive?.button_reply?.title;
  if (typeof buttonTitle === "string" && buttonTitle.trim()) return buttonTitle.trim();
  const listId = interactive?.list_reply?.id;
  if (typeof listId === "string" && listId.trim()) return listId.trim();
  const listTitle = interactive?.list_reply?.title;
  if (typeof listTitle === "string" && listTitle.trim()) return listTitle.trim();

  const imageCaption = (message.image as { caption?: unknown } | undefined)?.caption;
  if (typeof imageCaption === "string" && imageCaption.trim()) return imageCaption.trim();

  const documentCaption = (message.document as { caption?: unknown } | undefined)?.caption;
  if (typeof documentCaption === "string" && documentCaption.trim()) return documentCaption.trim();

  return undefined;
}

whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && verifyToken === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

whatsappWebhookRouter.post("/", async (req, res) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;
    if (payload.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const inboundPhoneNumberId = change.value?.metadata?.phone_number_id;
        for (const msg of change.value?.messages ?? []) {
          const text = extractInboundText(msg as unknown as Record<string, unknown>);
          if (!msg.from || !msg.id || !text) continue;
          await handleIncomingWhatsAppMessage({
            from: msg.from,
            messageId: msg.id,
            text,
            inboundPhoneNumberId
          });
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("WhatsApp webhook processing error:", message);
    return res.sendStatus(200);
  }
});

import { Router } from "express";
import { handleIncomingWhatsAppMessage } from "./conversationController";
import { WhatsAppWebhookPayload } from "./types";

export const whatsappWebhookRouter = Router();

function extractInboundText(message: Record<string, unknown>): string | undefined {
  const textBody = (message.text as { body?: unknown } | undefined)?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const buttonText = (message.button as { text?: unknown } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactive = message.interactive as
    | { button_reply?: { title?: unknown; id?: unknown }; list_reply?: { title?: unknown; id?: unknown } }
    | undefined;
  const buttonId = interactive?.button_reply?.id;
  if (typeof buttonId === "string" && buttonId.trim()) return buttonId.trim();
  const buttonTitle = interactive?.button_reply?.title;
  if (typeof buttonTitle === "string" && buttonTitle.trim()) return buttonTitle.trim();
  const listId = interactive?.list_reply?.id;
  if (typeof listId === "string" && listId.trim()) return listId.trim();
  const listTitle = interactive?.list_reply?.title;
  if (typeof listTitle === "string" && listTitle.trim()) return listTitle.trim();

  const imageCaption = (message.image as { caption?: unknown } | undefined)?.caption;
  if (typeof imageCaption === "string" && imageCaption.trim()) return imageCaption.trim();

  const documentCaption = (message.document as { caption?: unknown } | undefined)?.caption;
  if (typeof documentCaption === "string" && documentCaption.trim()) return documentCaption.trim();

  return undefined;
}

whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && verifyToken === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

whatsappWebhookRouter.post("/", async (req, res) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;
    if (payload.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const inboundPhoneNumberId = change.value?.metadata?.phone_number_id;
        for (const msg of change.value?.messages ?? []) {
          const text = extractInboundText(msg as unknown as Record<string, unknown>);
          if (!msg.from || !msg.id || !text) continue;
          await handleIncomingWhatsAppMessage({
            from: msg.from,
            messageId: msg.id,
            text,
            inboundPhoneNumberId
          });
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("WhatsApp webhook processing error:", message);
    return res.sendStatus(200);
  }
});

import { Router } from "express";
import { extractSingleDates, parseGuestMessage } from "../core/parse";
import { ChannelProvider, ConversationState, MessageDirection, PropertyStatus } from "@prisma/client";
import { prisma } from "../db";
import {
  findAvailableRoomType as findAvailableRoomTypeShared,
  getAvailableCheckInDates as getAvailableCheckInDatesShared,
  getAvailableCheckOutDates as getAvailableCheckOutDatesShared
} from "../core/availability";
import { createConfirmedBookingAtomic } from "../core/bookingService";
import { mergeGuestProfileFromBooking } from "../core/guestProfile";
import { applyPartnerTemplate, loadPartnerSetupConfig } from "../core/partnerSetup";
import { createCalendarSessionLink, loadConversationSession, saveConversationSession, upsertBookingDraft } from "../core/sessionStore";
import { sendWhatsAppButtons, sendWhatsAppList, sendWhatsAppText } from "./send";
import { WhatsAppWebhookPayload } from "./types";

export const whatsappWebhookRouter = Router();
const processedInboundMessageIds = new Map<string, number>();
const inboundMessageDedupTtlMs = 10 * 60 * 1000;
type ConversationLanguage = "en" | "ar" | "es" | "fr";
type ConversationStage =
  | "IDLE"
  | "WAITING_BOOKING_INTENT"
  | "WAITING_CHECKIN_PICK"
  | "WAITING_CHECKOUT_PICK"
  | "WAITING_BOOKING_DETAILS"
  | "WAITING_CONFIRMATION"
  | "WAITING_EDIT"
  | "WAITING_QA";

type GuestSession = {
  hotelId: string;
  conversationId: string;
  guestId: string;
  phoneNumberId?: string;
  language: ConversationLanguage;
  stage: ConversationStage;
  guestName?: string;
  checkIn?: Date;
  checkOut?: Date;
  checkInOptions?: string[];
  checkOutOptions?: string[];
  guestCount?: number;
  roomCount?: number;
  suggestedRoomTypeId?: string;
  suggestedRoomTypeName?: string;
  suggestedPropertyId?: string;
  nightlyRate?: number;
  nights?: number;
  totalAmount?: number;
  updatedAt: number;
};

const guestFlowSessions = new Map<string, GuestSession>();
const guestFlowSessionTtlMs = 60 * 60 * 1000;
const defaultHotelSlug = process.env.DEFAULT_HOTEL_SLUG ?? "al-ashkhara-beach-resort";
const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
const hotelContextCacheTtlMs = 5 * 60 * 1000;
const hotelContextCache = new Map<
  string,
  {
    hotelCity?: string | null;
    hotelCountry?: string | null;
    checkInTime?: string | null;
    checkOutTime?: string | null;
    addressLine1?: string | null;
    cheapestNightlyRate?: number;
    expiresAt: number;
  }
>();

function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}

function sessionKey(hotelId: string, from: string): string {
  return `${hotelId}:${normalizePhone(from)}`;
}

function normalizeInput(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isExplicitEnglishGreeting(text: string): boolean {
  const normalized = normalizeInput(text);
  return /(^|\s)(hi|hello|hey)(\s|$)/i.test(normalized);
}

function detectLanguage(text: string): ConversationLanguage {
  const normalized = normalizeInput(text);
  if (/^(hi|hello|hey|good morning|good evening)$/i.test(normalized)) {
    return "en";
  }
  if (
    /[\u0600-\u06FF]/.test(text) ||
    /(السلام|مرحبا|اهلا|أهلا|هلا|شلونك|صباح الخير|مساء الخير|asalam|salam|assalamu)/i.test(normalized)
  ) {
    return "ar";
  }
  if (/\b(hola|buenas|gracias|reservar)\b/i.test(normalized)) return "es";
  if (/\b(bonjour|salut|merci|reserver)\b/i.test(normalized)) return "fr";
  return "en";
}

function shouldSwitchLanguage(current: ConversationLanguage, inferred: ConversationLanguage, text: string): boolean {
  if (current === inferred) return false;
  const normalized = normalizeInput(text);
  if (isGreeting(normalized)) return true;
  if (/(english|arabic|spanish|french|انجليزي|عربي|اسباني|فرنسي)/i.test(normalized)) return true;
  if (/[\u0600-\u06FF]/.test(text) && inferred === "ar") return true;
  return false;
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|start|menu|help|hola|bonjour|salut|marhaba|salam|assalamu alaikum|aslaimu alaikum|السلام عليكم|مرحبا|اهلا|أهلا|greetings)$/i.test(
    normalizeInput(text)
  );
}

function isBookingIntent(text: string): boolean {
  const normalized = normalizeInput(text);
  return /\b(book|booking|reserve|reservation|i want to book|book now|quiero reservar|reserver|reserver|حجز|احجز|أحجز|اريد الحجز|ابي احجز)\b/i.test(
    normalized
  );
}

function isAffirmative(text: string): boolean {
  return /^(yes|y|confirm|confirm booking|book|go ahead|ok|okay|proceed|sure|نعم|اجل|أجل|ايوه|تمام|si|oui|أكيد|اكيد)$/i.test(
    normalizeInput(text)
  );
}

function isNegative(text: string): boolean {
  return /^(no|n|change|modify|edit|edit details|لا|كلا|non|مو|not now)$/i.test(normalizeInput(text));
}

function isAgentRequest(text: string): boolean {
  const normalized = normalizeInput(text);
  return /\b(agent|human|staff|support|talk to agent|representative|موظف|موظفه|موظفة|بشر|خدمة العملاء)\b/i.test(normalized);
}

function isMenuIntent(text: string): boolean {
  const normalized = normalizeInput(text);
  return /^(menu|help|options|main menu|القائمة|مساعدة|خيارات)$/i.test(normalized);
}

function isBookingStatusIntent(text: string): boolean {
  const normalized = normalizeInput(text);
  return /\b(my booking|booking status|check booking|reservation status|track booking|حجزي|حالة الحجز|متابعة الحجز)\b/i.test(normalized);
}

function isQuestionModeRequest(text: string): boolean {
  const normalized = normalizeInput(text);
  return /^(ask|question|questions|faq|help me|اسال|اسأل|سؤال|اسئلة|أسئلة)$/i.test(normalized);
}

function isBookChoice(text: string): boolean {
  const normalized = normalizeInput(text);
  return /^(book now|start booking|book_now|ابدأ الحجز)$/i.test(normalized);
}

function isQuestionChoice(text: string): boolean {
  const normalized = normalizeInput(text);
  return /^(ask question|ask a question|ask_question|question mode|عندي سؤال)$/i.test(normalized);
}

function isAgentChoice(text: string): boolean {
  const normalized = normalizeInput(text);
  return /^(talk to agent|agent|human agent|تواصل مع موظف)$/i.test(normalized);
}

function isConfirmChoice(text: string): boolean {
  const normalized = normalizeInput(text);
  return /^(1|confirm|confirm booking|confirm_booking|تاكيد الحجز)$/i.test(normalized);
}

function isEditChoice(text: string): boolean {
  const normalized = normalizeInput(text);
  return /^(2|edit|edit details|edit_booking|تعديل البيانات)$/i.test(normalized);
}

function extractPrimaryMenuChoice(text: string): 1 | 2 | 3 | null {
  const normalized = normalizeInput(text);
  if (normalized === "1") return 1;
  if (normalized === "2") return 2;
  if (normalized === "3") return 3;
  return null;
}

function isLikelyQuestion(text: string): boolean {
  const raw = text.trim();
  const normalized = normalizeInput(text);
  if (raw.includes("?") || raw.includes("؟")) return true;
  return /^(what|where|when|how|can|do|does|is|are|which|why|هل|كم|متى|كيف|وين|ما|ماذا)\b/i.test(normalized);
}

function getTexts(language: ConversationLanguage, hotelName: string): Record<string, string> {
  if (language === "ar") {
    return {
      welcome: `اهلا بك في ${hotelName}. كيف نقدر نخدمك اليوم؟`,
      askIntent: "اذا حاب تبدأ الحجز، اختر ابدأ الحجز أو ارسل تفاصيل الإقامة مباشرة.",
      askDetails:
        "رائع. ارسل بيانات الحجز بطريقة بسيطة.\nمثال: من 2026-04-10 الى 2026-04-12، لشخصين.\nيمكنك اضافة عدد الغرف والاسم إذا رغبت.",
      invalidFormat:
        "لم نتمكن من قراءة التفاصيل كاملة. فضلا ارسل تاريخ الدخول والخروج وعدد الضيوف. عدد الغرف اختياري (الافتراضي 1).",
      oneDateOnly: "تم العثور على تاريخ واحد فقط. رجاء ارسل تاريخ الدخول والخروج معًا.",
      invalidGuests: "عدد الضيوف يجب ان يكون بين 1 و 16.",
      invalidRooms: "عدد الغرف يجب ان يكون بين 1 و 6.",
      invalidDates: "تاريخ الخروج يجب ان يكون بعد تاريخ الدخول، والاقامة لا تزيد عن 30 ليلة.",
      unavailable: "عذرًا، لا يوجد نوع غرفة مناسب حاليا للتواريخ او عدد الضيوف المطلوب.",
      quoteIntro: "هذه التفاصيل متاحة:",
      askConfirm: "هل تريد تاكيد الحجز؟ ارسل نعم او لا.",
      confirmed: "شكرًا لحجزك معنا. هذا رابط متابعة الحجز:",
      editPrompt: "ما البيانات التي تريد تعديلها؟ ارسل التعديل بالطريقة التي تناسبك.",
      qaIntro: "هذا هو المساعد الذكي للفندق. يمكنك سؤاله عن الاسعار، المرافق، الموقع، وقت الدخول والخروج، الدفع، وسياسة الالغاء.",
      qaExamples: "مثال: هل يوجد واي فاي؟ | ما سعر الليلة؟ | اين موقع الفندق؟",
      qaContinue: "يمكنك سؤال المزيد من الاسئلة، او اختر 1 لبدء الحجز.",
      menuLabel: "القائمة السريعة",
      bookingStatusMissing: "للاطلاع على الحجز، ارسل رقم الحجز أو استخدم رابط متابعة الحجز الذي وصلك.",
      bookingStatusPrefix: "اخر حالة حجز لديك:"
    };
  }
  if (language === "es") {
    return {
      welcome: `Bienvenido a ${hotelName}. Como podemos ayudarte hoy?`,
      askIntent: "Si quieres reservar, escribe que deseas reservar o pulsa Book now.",
      askDetails:
        "Perfecto. Comparte los datos de forma simple.\nEjemplo: del 2026-04-10 al 2026-04-12 para 2 personas.\nTambien puedes agregar habitaciones y nombre.",
      invalidFormat: "No pudimos leer todos los datos. Envia check-in, check-out y guests. Rooms es opcional (por defecto 1).",
      oneDateOnly: "Encontramos solo una fecha. Envia check-in y check-out.",
      invalidGuests: "Guests debe estar entre 1 y 16.",
      invalidRooms: "Rooms debe estar entre 1 y 6.",
      invalidDates: "Check-out debe ser despues de check-in y la estancia max es 30 noches.",
      unavailable: "No hay habitacion disponible para esas fechas y capacidad.",
      quoteIntro: "Disponibilidad encontrada:",
      askConfirm: "Quieres confirmar la reserva? Responde YES o NO.",
      confirmed: "Gracias por reservar con nosotros. Aqui tienes tu portal de reserva:",
      editPrompt: "Que informacion deseas editar? Enviala como prefieras.",
      qaIntro: "Este es nuestro chatbot inteligente. Puedes preguntar sobre tarifas, servicios, ubicacion, horarios de check-in/check-out, pagos y cancelacion.",
      qaExamples: "Ejemplo: Do you have WiFi? | What is the nightly rate? | Where are you located?",
      qaContinue: "Puedes hacer mas preguntas o elegir 1 para empezar la reserva.",
      menuLabel: "Quick menu",
      bookingStatusMissing: "Please share your booking ID or open your booking portal link to check latest status.",
      bookingStatusPrefix: "Your latest booking status:"
    };
  }
  if (language === "fr") {
    return {
      welcome: `Bienvenue chez ${hotelName}. Comment pouvons-nous vous aider?`,
      askIntent: "Pour reserver, dites que vous souhaitez reserver ou appuyez sur Book now.",
      askDetails:
        "Parfait. Envoyez vos details simplement.\nExemple: du 2026-04-10 au 2026-04-12 pour 2 personnes.\nVous pouvez aussi ajouter le nombre de chambres et votre nom.",
      invalidFormat: "Nous n'avons pas pu lire tous les details. Envoyez check-in, check-out et guests. Rooms est optionnel (defaut 1).",
      oneDateOnly: "Une seule date detectee. Envoyez check-in et check-out.",
      invalidGuests: "Guests doit etre entre 1 et 16.",
      invalidRooms: "Rooms doit etre entre 1 et 6.",
      invalidDates: "Check-out doit etre apres check-in et sejour max 30 nuits.",
      unavailable: "Aucune chambre disponible pour ces dates et cette capacite.",
      quoteIntro: "Disponibilite trouvee:",
      askConfirm: "Voulez-vous confirmer la reservation? Repondez YES ou NO.",
      confirmed: "Merci pour votre reservation. Voici votre portail de reservation:",
      editPrompt: "Quelles informations souhaitez-vous modifier?",
      qaIntro: "Voici notre chatbot intelligent. Vous pouvez poser des questions sur les tarifs, services, emplacement, check-in/check-out, paiements et annulation.",
      qaExamples: "Exemple: Do you have WiFi? | What is the nightly rate? | Where are you located?",
      qaContinue: "Vous pouvez poser plusieurs questions ou choisir 1 pour commencer la reservation.",
      menuLabel: "Quick menu",
      bookingStatusMissing: "Please share your booking ID or open your booking portal link to check latest status.",
      bookingStatusPrefix: "Your latest booking status:"
    };
  }
  return {
    welcome: `Welcome to ${hotelName}. How can we help you today?`,
    askIntent: "If you would like to reserve, just say you want to book or tap Book now.",
    askDetails:
      "Great. Please share your booking details in a simple sentence.\nExample: from 2026-04-10 to 2026-04-12 for 2 guests.\nYou can add room count and your name anytime.",
    invalidFormat: "I could not read all details yet. Please send check-in, check-out, and guest count. Room count is optional (default is 1).",
    oneDateOnly: "I found one date only. Please send check-in and check-out.",
    invalidGuests: "Guest count must be between 1 and 16.",
    invalidRooms: "Room count must be between 1 and 6.",
    invalidDates: "Check-out must be after check-in, and max stay is 30 nights.",
    unavailable: "No suitable room is available for the provided dates and capacity.",
    quoteIntro: "Availability found:",
    askConfirm: "Do you want to confirm your booking? Reply YES or NO.",
    confirmed: "Thank you for booking with us. Here is your booking portal link:",
    editPrompt: "What would you like to change? Send the updated details in any natural way.",
    qaIntro: "This is our intelligent chatbot. You can ask about rates, amenities, location, check-in/check-out, payment, and cancellation policy.",
    qaExamples: "Example: Do you have WiFi? | What is the nightly rate? | Where are you located?",
    qaContinue: "You can ask multiple questions, or choose 1 to start booking.",
    menuLabel: "Quick menu",
    bookingStatusMissing: "Please share your booking ID or open your booking portal link to check latest status.",
    bookingStatusPrefix: "Your latest booking status:"
  };
}

function getPrimaryButtons(language: ConversationLanguage): Array<{ id: string; title: string }> {
  if (language === "ar") {
    return [
      { id: "book_now", title: "ابدأ الحجز" },
      { id: "ask_question", title: "عندي سؤال" },
      { id: "talk_agent", title: "تواصل مع موظف" }
    ];
  }
  return [
    { id: "book_now", title: "Book now" },
    { id: "ask_question", title: "Ask question" },
    { id: "talk_agent", title: "Talk to agent" }
  ];
}

function getConfirmButtons(language: ConversationLanguage): Array<{ id: string; title: string }> {
  if (language === "ar") {
    return [
      { id: "confirm_booking", title: "تاكيد الحجز" },
      { id: "edit_booking", title: "تعديل البيانات" },
      { id: "talk_agent", title: "تواصل مع موظف" }
    ];
  }
  return [
    { id: "confirm_booking", title: "Confirm" },
    { id: "edit_booking", title: "Edit details" },
    { id: "talk_agent", title: "Talk to agent" }
  ];
}

function getPrimaryMenuHint(language: ConversationLanguage): string {
  if (language === "ar") return "1) ابدأ الحجز\n2) اسأل المساعد الذكي\n3) تواصل مع موظف";
  return "1) Book now\n2) Ask the intelligent assistant\n3) Talk to agent";
}

function getConfirmMenuHint(language: ConversationLanguage): string {
  if (language === "ar") return "اختر رقم:\n1) تاكيد الحجز\n2) تعديل البيانات\n3) تواصل مع موظف";
  return "Reply with a number:\n1) Confirm booking\n2) Edit details\n3) Talk to agent";
}

function parseRoomCount(text: string): number | undefined {
  const labeled = text.match(/(?:rooms?|room|غرف|habitaciones|chambres?)\s*[:=-]?\s*(\d{1,2})/i);
  if (labeled) return Number(labeled[1]);
  const reverse = text.match(/(\d{1,2})\s*(?:rooms?|room|غرف|habitaciones|chambres?)/i);
  if (reverse) return Number(reverse[1]);
  return undefined;
}

function parseGuestName(text: string): string | undefined {
  const labeled = text.match(/(?:name|guest|اسم|nombre|nom)\s*[:=-]?\s*([^\n;,]+)/i);
  if (labeled) return labeled[1].trim();
  const intro = text.match(/(?:i am|i'm|my name is|انا|اسمي)\s+([^\n,;.]+)/i);
  if (intro) return intro[1].trim();
  return undefined;
}

function buildMissingFieldsPrompt(language: ConversationLanguage, missing: string[]): string {
  const has = (key: string) => missing.includes(key);
  if (language === "ar") {
    const parts: string[] = [];
    if (has("dates")) parts.push("تاريخ الدخول والخروج");
    if (has("guests")) parts.push("عدد الضيوف");
    if (has("rooms")) parts.push("عدد الغرف");
    return `يرجى تزويدنا بـ: ${parts.join("، ")}.`;
  }
  const parts: string[] = [];
  if (has("dates")) parts.push("check-in and check-out dates");
  if (has("guests")) parts.push("guest count");
  if (has("rooms")) parts.push("room count");
  return `Please provide: ${parts.join(", ")}.`;
}

function buildBookingPortalLink(bookingId: string): string {
  const base = appBaseUrl.endsWith("/") ? appBaseUrl.slice(0, -1) : appBaseUrl;
  return `${base}/guest?bookingId=${encodeURIComponent(bookingId)}`;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildDateChoices(start: Date, days: number): string[] {
  const options: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    options.push(toIsoDate(d));
  }
  return options;
}

function buildDateRangeChoices(start: Date, days: number): string[] {
  const choices: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    choices.push(toIsoDate(d));
  }
  return choices;
}

function buildCheckInPickerText(language: ConversationLanguage, options: string[]): string {
  const lines = options.map((date, idx) => `${idx + 1}) ${date}`);
  if (language === "ar") {
    return `هذه هي تواريخ الدخول المتاحة فقط. اختر من القائمة التفاعلية أو ارسل التاريخ مباشرة (YYYY-MM-DD):\n${lines.join("\n")}`;
  }
  return `These are available check-in dates only. Tap from the interactive list, or type date directly (YYYY-MM-DD):\n${lines.join("\n")}`;
}

function buildCheckOutPickerText(language: ConversationLanguage, options: string[]): string {
  const lines = options.map((date, idx) => `${idx + 1}) ${date}`);
  if (language === "ar") {
    return `هذه هي تواريخ الخروج المتاحة فقط لتاريخ الدخول المحدد. اختر من القائمة التفاعلية أو ارسل التاريخ مباشرة (YYYY-MM-DD):\n${lines.join("\n")}`;
  }
  return `These are available checkout dates only for your selected check-in. Tap from the interactive list, or type date directly (YYYY-MM-DD):\n${lines.join("\n")}`;
}

function extractChoiceNumber(text: string): number | null {
  const normalized = normalizeInput(text);
  const match = normalized.match(/^(\d{1,2})$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseDateChoiceId(text: string, prefix: "checkin" | "checkout"): string | null {
  const value = text.trim().toLowerCase();
  const match = value.match(new RegExp(`^${prefix}_(\\d{4}-\\d{2}-\\d{2})$`));
  if (!match) return null;
  return match[1];
}

async function findAvailableRoomType(params: {
  hotelId: string;
  checkIn: Date;
  checkOut: Date;
  guests: number;
  rooms: number;
  adults?: number;
  children?: number;
}): Promise<{
  roomTypeId: string;
  roomTypeName: string;
  propertyId: string;
  nightlyTotal: number;
  total: number;
  nights: number;
} | null> {
  return findAvailableRoomTypeShared(params);
}

async function getAvailableCheckInDates(params: {
  hotelId: string;
  fromDate: Date;
  days: number;
  guests: number;
  rooms: number;
}): Promise<string[]> {
  return getAvailableCheckInDatesShared(params);
}

async function getAvailableCheckOutDates(params: {
  hotelId: string;
  checkIn: Date;
  maxNights: number;
  guests: number;
  rooms: number;
}): Promise<string[]> {
  return getAvailableCheckOutDatesShared(params);
}

type SmartAnswerContext = {
  messageText: string;
  language: ConversationLanguage;
  hotelName: string;
  hotelCity?: string | null;
  hotelCountry?: string | null;
  hotelDescription: string;
  amenitiesSummary: string;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  addressLine1?: string | null;
  currency: string;
  cheapestNightlyRate?: number;
  knowledgeBase: string;
  knowledgeBaseEn: string;
  knowledgeBaseAr: string;
  knowledgeBaseEs: string;
  knowledgeBaseFr: string;
};

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function extractInboundText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;

  const textBody = (m.text as { body?: unknown } | undefined)?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const buttonText = (m.button as { text?: unknown } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactive = m.interactive as
    | { button_reply?: { title?: unknown; id?: unknown }; list_reply?: { title?: unknown; id?: unknown } }
    | undefined;
  const interactiveButtonId = interactive?.button_reply?.id;
  if (typeof interactiveButtonId === "string" && interactiveButtonId.trim()) return interactiveButtonId.trim();
  const interactiveButton = interactive?.button_reply?.title;
  if (typeof interactiveButton === "string" && interactiveButton.trim()) return interactiveButton.trim();
  const interactiveListId = interactive?.list_reply?.id;
  if (typeof interactiveListId === "string" && interactiveListId.trim()) return interactiveListId.trim();
  const interactiveList = interactive?.list_reply?.title;
  if (typeof interactiveList === "string" && interactiveList.trim()) return interactiveList.trim();

  const imageCaption = (m.image as { caption?: unknown } | undefined)?.caption;
  if (typeof imageCaption === "string" && imageCaption.trim()) return imageCaption.trim();

  const documentCaption = (m.document as { caption?: unknown } | undefined)?.caption;
  if (typeof documentCaption === "string" && documentCaption.trim()) return documentCaption.trim();

  return undefined;
}

function parseKnowledgeBaseEntries(raw: string): Array<{ question: string; answer: string }> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const q = String((item as { question?: unknown }).question ?? "").trim();
          const a = String((item as { answer?: unknown }).answer ?? "").trim();
          return q && a ? { question: q, answer: a } : null;
        })
        .filter((item): item is { question: string; answer: string } => Boolean(item));
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([q, a]) => ({ question: q.trim(), answer: String(a ?? "").trim() }))
        .filter((item) => item.question && item.answer);
    }
  } catch {
    // Best-effort plain text fallback.
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.includes("|") ? "|" : line.includes("=>") ? "=>" : line.includes("->") ? "->" : ":";
      const [q, ...rest] = line.split(separator);
      return { question: (q ?? "").trim(), answer: rest.join(separator).trim() };
    })
    .filter((item) => item.question && item.answer);
}

function buildBigrams(input: string): Set<string> {
  const normalized = normalizeInput(input).replace(/\s+/g, " ");
  const set = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const pair = normalized.slice(i, i + 2);
    if (!pair.includes(" ")) set.add(pair);
  }
  return set;
}

function jaccardSimilarity<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function searchKnowledgeBaseAnswer(question: string, raw: string): { answer: string; score: number } | null {
  const entries = parseKnowledgeBaseEntries(raw);
  if (!entries.length) return null;
  const normalizedQuestion = normalizeInput(question);
  const questionTokens = new Set(
    normalizedQuestion.split(" ").map((token) => token.trim()).filter((token) => token.length >= 3)
  );
  const questionBigrams = buildBigrams(normalizedQuestion);
  let best: { score: number; answer: string } | null = null;
  for (const entry of entries) {
    const normalizedEntryQuestion = normalizeInput(entry.question);
    const entryTokens = new Set(
      normalizedEntryQuestion.split(" ").map((token) => token.trim()).filter((token) => token.length >= 3)
    );
    const entryBigrams = buildBigrams(normalizedEntryQuestion);
    const tokenSimilarity = jaccardSimilarity(questionTokens, entryTokens);
    const bigramSimilarity = jaccardSimilarity(questionBigrams, entryBigrams);
    const containsBoost = normalizedQuestion.includes(normalizedEntryQuestion) || normalizedEntryQuestion.includes(normalizedQuestion) ? 0.2 : 0;
    const score = tokenSimilarity * 0.6 + bigramSimilarity * 0.4 + containsBoost;
    if (score < 0.18) continue;
    if (!best || score > best.score) {
      best = { score, answer: entry.answer };
    }
  }
  return best ? { answer: best.answer, score: best.score } : null;
}

type SmartAnswerResult = {
  answer: string;
  intent: string;
  confidence: number;
};

function selectKnowledgeBaseForLanguage(ctx: SmartAnswerContext): string {
  if (ctx.language === "ar") return ctx.knowledgeBaseAr || ctx.knowledgeBase || "";
  if (ctx.language === "es") return ctx.knowledgeBaseEs || ctx.knowledgeBase || "";
  if (ctx.language === "fr") return ctx.knowledgeBaseFr || ctx.knowledgeBase || "";
  return ctx.knowledgeBaseEn || ctx.knowledgeBase || "";
}

function buildSmartAnswer(ctx: SmartAnswerContext): SmartAnswerResult | null {
  const text = normalizeInput(ctx.messageText);
  const selectedKnowledgeBase = selectKnowledgeBaseForLanguage(ctx);
  const kbAnswer = searchKnowledgeBaseAnswer(text, selectedKnowledgeBase);
  if (kbAnswer) {
    return {
      answer: kbAnswer.answer,
      intent: "FAQ_KNOWLEDGE_BASE",
      confidence: Math.max(0.3, Math.min(0.98, kbAnswer.score))
    };
  }

  const isArabic = ctx.language === "ar";
  if (
    hasAnyKeyword(text, [
      "amenit",
      "facility",
      "facilities",
      "pool",
      "beach",
      "parking",
      "wifi",
      "gym",
      "spa",
      "restaurant",
      "خدمات",
      "مرافق",
      "واي فاي",
      "شاطئ"
    ])
  ) {
    return {
      answer: isArabic
      ? `هذه اهم المرافق في ${ctx.hotelName}: ${ctx.amenitiesSummary || "يرجى مراجعة الاستقبال للمزيد من التفاصيل."}`
      : `Top amenities at ${ctx.hotelName}: ${ctx.amenitiesSummary || "Please contact reception for full details."}`,
      intent: "FAQ_AMENITIES",
      confidence: 0.88
    };
  }

  if (
    hasAnyKeyword(text, ["check in", "check-in", "checkin", "check out", "checkout", "check-out", "دخول", "خروج"])
  ) {
    return {
      answer: isArabic
      ? `موعد الدخول: ${ctx.checkInTime || "14:00"}. موعد الخروج: ${ctx.checkOutTime || "12:00"}.`
      : `Check-in is ${ctx.checkInTime || "14:00"} and check-out is ${ctx.checkOutTime || "12:00"}.`,
      intent: "FAQ_CHECKIN_CHECKOUT",
      confidence: 0.9
    };
  }

  if (hasAnyKeyword(text, ["where", "location", "address", "map", "عنوان", "الموقع", "وين"])) {
    const location = [ctx.addressLine1, ctx.hotelCity, ctx.hotelCountry].filter(Boolean).join(", ");
    return {
      answer: isArabic
      ? `موقع الفندق: ${location || ctx.hotelDescription || "سيتم ارسال الموقع من فريق الاستقبال."}`
      : `Hotel location: ${location || ctx.hotelDescription || "Our front desk can share the exact map pin."}`,
      intent: "FAQ_LOCATION",
      confidence: 0.87
    };
  }

  if (hasAnyKeyword(text, ["price", "rate", "how much", "cost", "سعر", "كم"])) {
    if (typeof ctx.cheapestNightlyRate === "number") {
      return {
        answer: isArabic
        ? `الاسعار تبدأ من ${ctx.cheapestNightlyRate.toFixed(2)} ${ctx.currency} لليلة (حسب التوفر والتواريخ).`
        : `Rates currently start from ${ctx.cheapestNightlyRate.toFixed(2)} ${ctx.currency} per night (subject to dates and availability).`,
        intent: "FAQ_PRICING",
        confidence: 0.84
      };
    }
    return {
      answer: isArabic
      ? "السعر يعتمد على التواريخ وعدد الضيوف. ارسل التواريخ وعدد الضيوف لعرض سعر دقيق."
      : "Pricing depends on dates and guest count. Share your dates and guests for an accurate quote.",
      intent: "FAQ_PRICING",
      confidence: 0.74
    };
  }

  if (hasAnyKeyword(text, ["payment", "pay", "card", "cash", "online", "دفع", "بطاقة", "كاش"])) {
    return {
      answer: isArabic
      ? "نقبل الدفع الالكتروني وبطاقات الدفع، ويمكن مشاركة رابط الدفع بعد تأكيد الحجز."
      : "We support online payment and card payment; a secure payment link can be shared after booking confirmation.",
      intent: "FAQ_PAYMENT",
      confidence: 0.82
    };
  }

  if (hasAnyKeyword(text, ["cancel", "cancellation", "refund", "إلغاء", "استرجاع"])) {
    return {
      answer: isArabic
      ? "سياسة الالغاء تعتمد على نوع السعر وتاريخ الوصول. شارك رقم الحجز لنراجع حالتك بدقة."
      : "Cancellation depends on the booked rate and arrival date. Share your booking ID and we will check your exact policy.",
      intent: "FAQ_CANCELLATION",
      confidence: 0.8
    };
  }

  if (hasAnyKeyword(text, ["available", "availability", "متاح", "توفر"])) {
    return {
      answer: isArabic
      ? "للتحقق من التوفر بدقة، ارسل: check-in و check-out وعدد الضيوف وعدد الغرف."
      : "To check availability accurately, send check-in, check-out, guest count, and room count.",
      intent: "FAQ_AVAILABILITY",
      confidence: 0.78
    };
  }

  return null;
}

async function getHotelRuntimeContext(hotelId: string): Promise<{
  hotelCity?: string | null;
  hotelCountry?: string | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  addressLine1?: string | null;
  cheapestNightlyRate?: number;
}> {
  const now = Date.now();
  const cached = hotelContextCache.get(hotelId);
  if (cached && cached.expiresAt > now) {
    return cached;
  }
  // SaaS lifecycle: WhatsApp guest-facing context must only reflect ACTIVE properties.
  // A DRAFT/SUSPENDED/ARCHIVED property's check-in/check-out times must never leak into guest replies.
  const [hotelProfile, primaryProperty, cheapestRoomType] = await Promise.all([
    prisma.hotel.findUnique({ where: { id: hotelId }, select: { city: true, country: true } }),
    prisma.property.findFirst({
      where: { hotelId, status: PropertyStatus.ACTIVE },
      orderBy: { createdAt: "asc" }
    }),
    prisma.roomType.findFirst({ where: { hotelId, isActive: true }, orderBy: { baseNightlyRate: "asc" } })
  ]);
  const next = {
    hotelCity: hotelProfile?.city,
    hotelCountry: hotelProfile?.country,
    checkInTime: primaryProperty?.checkInTime,
    checkOutTime: primaryProperty?.checkOutTime,
    addressLine1: primaryProperty?.addressLine1,
    cheapestNightlyRate: cheapestRoomType?.baseNightlyRate,
    expiresAt: now + hotelContextCacheTtlMs
  };
  hotelContextCache.set(hotelId, next);
  return next;
}

async function resolveHotelContext(phoneNumberId?: string): Promise<{ id: string; displayName: string; currency: string; outboundPhoneNumberId?: string }> {
  // Mirror of resolveHotel() in conversationController: only ACTIVE hotels are eligible for inbound
  // routing. Suspended hotels are dropped here as well so cron-driven webhook re-checks (status,
  // template feedback, etc.) don't accidentally write into a tenant the platform owner has archived.
  const hotels = await prisma.hotel.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true, currency: true, slug: true },
    orderBy: { createdAt: "asc" }
  });
  if (!hotels.length) {
    throw new Error("No active hotels configured");
  }
  if (phoneNumberId) {
    for (const hotel of hotels) {
      const config = loadPartnerSetupConfig(hotel.id);
      if (config.whatsappPhoneNumberId && config.whatsappPhoneNumberId === phoneNumberId) {
        return { id: hotel.id, displayName: hotel.displayName, currency: hotel.currency, outboundPhoneNumberId: phoneNumberId };
      }
    }
  }
  const fallback = hotels.find((hotel) => hotel.slug === defaultHotelSlug) ?? hotels[0];
  const fallbackConfig = loadPartnerSetupConfig(fallback.id);
  return {
    id: fallback.id,
    displayName: fallback.displayName,
    currency: fallback.currency,
    outboundPhoneNumberId: phoneNumberId || fallbackConfig.whatsappPhoneNumberId || undefined
  };
}

function cleanupProcessedMessageIds(now: number): void {
  for (const [id, seenAt] of processedInboundMessageIds.entries()) {
    if (now - seenAt > inboundMessageDedupTtlMs) {
      processedInboundMessageIds.delete(id);
    }
  }
}

function cleanupGuestSessions(now: number): void {
  for (const [phone, session] of guestFlowSessions.entries()) {
    if (now - session.updatedAt > guestFlowSessionTtlMs) {
      guestFlowSessions.delete(phone);
    }
  }
}

whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === process.env.WHATSAPP_VERIFY_TOKEN &&
    typeof challenge === "string"
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

whatsappWebhookRouter.post("/", async (req, res) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const inboundMessageId = message?.id;
    const from = message?.from;
    const text = extractInboundText(message);
    const inboundPhoneNumberId = value?.metadata?.phone_number_id;

    if (inboundMessageId) {
      const now = Date.now();
      cleanupProcessedMessageIds(now);
      cleanupGuestSessions(now);
      if (processedInboundMessageIds.has(inboundMessageId)) {
        return res.sendStatus(200);
      }
      processedInboundMessageIds.set(inboundMessageId, now);
    }

    if (!from || !text) {
      return res.sendStatus(200);
    }

    const hotel = await resolveHotelContext(inboundPhoneNumberId);
    const config = loadPartnerSetupConfig(hotel.id);
    const runtimeContext = await getHotelRuntimeContext(hotel.id);
    const normalizedPhone = normalizePhone(from);
    const guest = await prisma.guest.upsert({
      where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: normalizedPhone } },
      update: {},
      create: { hotelId: hotel.id, phoneE164: normalizedPhone }
    });
    const existingConversation = await prisma.conversation.findFirst({
      where: { hotelId: hotel.id, guestId: guest.id, state: { in: ["NEW", "QUALIFYING", "QUOTED", "PAYMENT_PENDING", "CONFIRMED"] } },
      orderBy: { updatedAt: "desc" }
    });
    const conversation =
      existingConversation ??
      (await prisma.conversation.create({
        data: { hotelId: hotel.id, guestId: guest.id, state: ConversationState.NEW, lastMessageAt: new Date() }
      }));

    if (inboundMessageId) {
      await prisma.message
        .create({
          data: {
            hotelId: hotel.id,
            conversationId: conversation.id,
            providerMessageId: inboundMessageId,
            direction: MessageDirection.INBOUND,
            body: text
          }
        })
        .catch(() => undefined);
    }

    const key = sessionKey(hotel.id, from);
    const normalized = text.trim();
    const inferredLanguage = isExplicitEnglishGreeting(normalized) ? "en" : detectLanguage(normalized);
    const persistedState = await loadConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      phoneE164: normalizedPhone,
      conversationId: conversation.id,
      defaultLanguage: inferredLanguage
    });
    const isNewSession = !guestFlowSessions.has(key);
    const session =
      guestFlowSessions.get(key) ??
      ({
        hotelId: hotel.id,
        conversationId: conversation.id,
        guestId: guest.id,
        phoneNumberId: hotel.outboundPhoneNumberId,
        language: (persistedState.language as ConversationLanguage) || inferredLanguage,
        stage: (persistedState.stage as ConversationStage) || "IDLE",
        guestName: persistedState.guestName,
        checkIn: persistedState.checkIn ? new Date(persistedState.checkIn) : undefined,
        checkOut: persistedState.checkOut ? new Date(persistedState.checkOut) : undefined,
        checkInOptions: persistedState.checkInOptions,
        checkOutOptions: persistedState.checkOutOptions,
        guestCount: persistedState.guestCount,
        roomCount: persistedState.roomCount,
        suggestedRoomTypeId: persistedState.suggestedRoomTypeId,
        suggestedRoomTypeName: persistedState.suggestedRoomTypeName,
        suggestedPropertyId: persistedState.suggestedPropertyId,
        nightlyRate: persistedState.nightlyRate,
        nights: persistedState.nights,
        totalAmount: persistedState.totalAmount,
        updatedAt: Date.now()
      } satisfies GuestSession);
    if (isNewSession) {
      session.language = inferredLanguage;
    } else if (shouldSwitchLanguage(session.language, inferredLanguage, normalized)) {
      session.language = inferredLanguage;
    }
    session.phoneNumberId = hotel.outboundPhoneNumberId;
    session.conversationId = conversation.id;
    session.guestId = guest.id;
    session.hotelId = hotel.id;

    const greetingLanguage = isExplicitEnglishGreeting(normalized) ? "en" : session.language;
    const texts = getTexts(greetingLanguage, hotel.displayName);
    const sendReply = async (
      body: string,
      nextStage?: ConversationStage,
      state?: ConversationState,
      aiIntent = "BOT_REPLY",
      aiConfidence?: number,
      buttons?: Array<{ id: string; title: string }>,
      buttonFallbackHint?: string,
      listPayload?: {
        buttonText: string;
        sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
      }
    ): Promise<void> => {
      try {
        if (listPayload && listPayload.sections.length) {
          await sendWhatsAppList({
            to: normalizedPhone,
            body,
            buttonText: listPayload.buttonText,
            sections: listPayload.sections,
            phoneNumberId: session.phoneNumberId
          });
        } else if (buttons && buttons.length) {
          await sendWhatsAppButtons({
            to: normalizedPhone,
            body,
            buttons,
            phoneNumberId: session.phoneNumberId
          });
        } else {
          await sendWhatsAppText({
            to: normalizedPhone,
            body,
            phoneNumberId: session.phoneNumberId
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Interactive send fallback to text:", message);
        const fallbackBody =
          (buttons && buttons.length) || (listPayload && listPayload.sections.length)
            ? `${body}\n\nInteractive options may not appear on this WhatsApp account right now.\n${buttonFallbackHint ?? ""}`.trim()
            : body;
        await sendWhatsAppText({
          to: normalizedPhone,
          body: fallbackBody,
          phoneNumberId: session.phoneNumberId
        });
      }
      await prisma.message.create({
        data: {
          hotelId: hotel.id,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body,
          aiIntent,
          aiConfidence
        }
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date(), ...(state ? { state } : {}) }
      });
      if (nextStage) {
        session.stage = nextStage;
      }
      session.updatedAt = Date.now();
      guestFlowSessions.set(key, session);
      await saveConversationSession({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        phoneE164: normalizedPhone,
        state: {
          language: session.language,
          stage: session.stage,
          phoneNumberId: session.phoneNumberId,
          guestName: session.guestName,
          checkIn: session.checkIn ? session.checkIn.toISOString().slice(0, 10) : undefined,
          checkOut: session.checkOut ? session.checkOut.toISOString().slice(0, 10) : undefined,
          checkInOptions: session.checkInOptions,
          checkOutOptions: session.checkOutOptions,
          guestCount: session.guestCount,
          roomCount: session.roomCount,
          suggestedRoomTypeId: session.suggestedRoomTypeId,
          suggestedRoomTypeName: session.suggestedRoomTypeName,
          suggestedPropertyId: session.suggestedPropertyId,
          nightlyRate: session.nightlyRate,
          nights: session.nights,
          totalAmount: session.totalAmount
        },
        ttlMs: guestFlowSessionTtlMs
      });
      await upsertBookingDraft({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        currency: hotel.currency,
        state: {
          language: session.language,
          stage: session.stage,
          guestName: session.guestName,
          checkIn: session.checkIn ? session.checkIn.toISOString().slice(0, 10) : undefined,
          checkOut: session.checkOut ? session.checkOut.toISOString().slice(0, 10) : undefined,
          checkInOptions: session.checkInOptions,
          checkOutOptions: session.checkOutOptions,
          guestCount: session.guestCount,
          roomCount: session.roomCount,
          suggestedRoomTypeId: session.suggestedRoomTypeId,
          suggestedRoomTypeName: session.suggestedRoomTypeName,
          suggestedPropertyId: session.suggestedPropertyId,
          nightlyRate: session.nightlyRate,
          nights: session.nights,
          totalAmount: session.totalAmount
        }
      });
    };
    const smartAnswer = buildSmartAnswer({
      messageText: normalized,
      language: session.language,
      hotelName: hotel.displayName,
      hotelCity: runtimeContext.hotelCity,
      hotelCountry: runtimeContext.hotelCountry,
      hotelDescription: config.hotelDescription,
      amenitiesSummary: config.amenitiesSummary,
      checkInTime: runtimeContext.checkInTime,
      checkOutTime: runtimeContext.checkOutTime,
      addressLine1: runtimeContext.addressLine1,
      currency: hotel.currency,
      cheapestNightlyRate: runtimeContext.cheapestNightlyRate,
      knowledgeBase: config.aiKnowledgeBase,
      knowledgeBaseEn: config.aiKnowledgeBaseEn,
      knowledgeBaseAr: config.aiKnowledgeBaseAr,
      knowledgeBaseEs: config.aiKnowledgeBaseEs,
      knowledgeBaseFr: config.aiKnowledgeBaseFr
    });
    const primaryMenuChoice = extractPrimaryMenuChoice(normalized);

    const sendLatestBookingStatus = async (): Promise<void> => {
      const latestBooking = await prisma.booking.findFirst({
        where: { hotelId: hotel.id, guestId: guest.id },
        include: { roomType: true },
        orderBy: { createdAt: "desc" }
      });
      if (!latestBooking) {
        await sendReply(texts.bookingStatusMissing, "WAITING_BOOKING_INTENT", ConversationState.NEW, "BOOKING_STATUS_MISSING", 0.9);
        return;
      }
      const bookingStatusText = [
        texts.bookingStatusPrefix,
        `Booking ID: ${latestBooking.id}`,
        `Status: ${latestBooking.status}`,
        `Payment: ${latestBooking.paymentStatus}`,
        `Stay: ${latestBooking.checkIn.toISOString().slice(0, 10)} to ${latestBooking.checkOut.toISOString().slice(0, 10)}`,
        `Room: ${latestBooking.roomType.name}`,
        `Portal: ${buildBookingPortalLink(latestBooking.id)}`
      ].join("\n");
      await sendReply(bookingStatusText, "WAITING_BOOKING_INTENT", ConversationState.NEW, "BOOKING_STATUS_SHARED", 0.95);
    };

    if (isMenuIntent(normalized)) {
      await sendReply(
        `${texts.welcome}\n${texts.askIntent}\n\n${texts.menuLabel}:\n${getPrimaryMenuHint(session.language)}\n\nType "my booking status" anytime to check your latest booking.`,
        "WAITING_BOOKING_INTENT",
        ConversationState.NEW,
        "MENU",
        0.95,
        getPrimaryButtons(session.language),
        getPrimaryMenuHint(session.language)
      );
      return res.sendStatus(200);
    }

    if (isBookingStatusIntent(normalized)) {
      await sendLatestBookingStatus();
      return res.sendStatus(200);
    }

    if (
      (isQuestionChoice(normalized) ||
        isQuestionModeRequest(normalized) ||
        (primaryMenuChoice === 2 && (session.stage === "WAITING_BOOKING_INTENT" || session.stage === "WAITING_QA" || session.stage === "IDLE"))) &&
      session.stage !== "WAITING_QA"
    ) {
      await sendReply(
        `${texts.qaIntro}\n${texts.qaExamples}\n\n${texts.qaContinue}`,
        "WAITING_QA",
        ConversationState.NEW,
        "PROMPT_QUESTION",
        0.92,
        getPrimaryButtons(session.language),
        getPrimaryMenuHint(session.language)
      );
      return res.sendStatus(200);
    }

    if (isGreeting(normalized)) {
      await sendReply(
        `${texts.welcome}\n${texts.askIntent}\n\n${getPrimaryMenuHint(greetingLanguage)}`,
        "WAITING_BOOKING_INTENT",
        ConversationState.NEW,
        "GREETING",
        0.95,
        getPrimaryButtons(greetingLanguage),
        getPrimaryMenuHint(greetingLanguage)
      );
      return res.sendStatus(200);
    }

    if (
      isAgentRequest(normalized) ||
      isAgentChoice(normalized) ||
      (primaryMenuChoice === 3 && (session.stage === "WAITING_BOOKING_INTENT" || session.stage === "WAITING_QA" || session.stage === "IDLE"))
    ) {
      await sendReply(
        "A hotel team member will follow up with you shortly. In the meantime, you can still send your booking dates anytime.",
        "WAITING_BOOKING_INTENT",
        ConversationState.NEW,
        "AGENT_HANDOFF_REQUESTED",
        0.96
      );
      return res.sendStatus(200);
    }

    if (session.stage === "IDLE" && smartAnswer && !isBookingIntent(normalized) && !isBookChoice(normalized)) {
      if (smartAnswer.confidence < 0.33) {
        await sendReply(
          `${smartAnswer.answer}\n\nPlease rephrase your question, or type: I want to book`,
          "WAITING_BOOKING_INTENT",
          ConversationState.NEW,
          "FAQ_LOW_CONFIDENCE",
          smartAnswer.confidence
        );
        return res.sendStatus(200);
      }
      await sendReply(
        `${smartAnswer.answer}\n\n${texts.askIntent}\n\n${getPrimaryMenuHint(session.language)}`,
        "WAITING_BOOKING_INTENT",
        ConversationState.NEW,
        smartAnswer.intent,
        smartAnswer.confidence,
        getPrimaryButtons(session.language),
        getPrimaryMenuHint(session.language)
      );
      return res.sendStatus(200);
    }

    if (session.stage === "WAITING_BOOKING_INTENT" && isQuestionChoice(normalized)) {
      await sendReply(
        `${texts.qaIntro}\n${texts.qaExamples}\n\n${texts.qaContinue}`,
        "WAITING_QA",
        ConversationState.NEW,
        "PROMPT_QUESTION",
        0.92,
        getPrimaryButtons(session.language)
      );
      return res.sendStatus(200);
    }

    if (
      session.stage === "WAITING_BOOKING_INTENT" &&
      !isBookingIntent(normalized) &&
      !isAffirmative(normalized) &&
      !isBookChoice(normalized) &&
      primaryMenuChoice !== 1
    ) {
      if (smartAnswer) {
        await sendReply(
          `${smartAnswer.answer}\n\n${texts.askIntent}\n\n${getPrimaryMenuHint(session.language)}`,
          "WAITING_BOOKING_INTENT",
          ConversationState.NEW,
          smartAnswer.intent,
          smartAnswer.confidence,
          getPrimaryButtons(session.language),
          getPrimaryMenuHint(session.language)
        );
        return res.sendStatus(200);
      }
      await sendReply(
        `${texts.askIntent}\n\n${getPrimaryMenuHint(session.language)}`,
        "WAITING_BOOKING_INTENT",
        ConversationState.NEW,
        "PROMPT_BOOKING_INTENT",
        0.9,
        getPrimaryButtons(session.language),
        getPrimaryMenuHint(session.language)
      );
      return res.sendStatus(200);
    }

    if (
      isBookingIntent(normalized) ||
      isBookChoice(normalized) ||
      (session.stage === "WAITING_BOOKING_INTENT" && isAffirmative(normalized)) ||
      (primaryMenuChoice === 1 && (session.stage === "WAITING_BOOKING_INTENT" || session.stage === "WAITING_QA" || session.stage === "IDLE"))
    ) {
      const defaultGuests = session.guestCount ?? 2;
      const defaultRooms = session.roomCount ?? 1;
      const checkInOptions = await getAvailableCheckInDates({
        hotelId: hotel.id,
        fromDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        days: 10,
        guests: defaultGuests,
        rooms: defaultRooms
      });
      if (!checkInOptions.length) {
        await sendReply(
          texts.unavailable,
          "WAITING_BOOKING_INTENT",
          ConversationState.QUALIFYING,
          "NO_CHECKIN_DATES_AVAILABLE",
          0.9
        );
        return res.sendStatus(200);
      }
      session.checkInOptions = checkInOptions;
      session.checkOutOptions = undefined;
      session.checkIn = undefined;
      session.checkOut = undefined;
      const calendarLink = await createCalendarSessionLink({
        appBaseUrl,
        hotelId: hotel.id,
        guestId: guest.id,
        phoneE164: normalizedPhone,
        language: session.language,
        metadata: { source: "WHATSAPP", stage: session.stage, guests: defaultGuests, rooms: defaultRooms }
      });
      await sendReply(
        `${texts.askDetails}\n\nOpen mini calendar: ${calendarLink.url}\n\n(If link fails, you can still type dates like 2026-04-10 to 2026-04-12 for 2 guests.)`,
        "WAITING_CHECKIN_PICK",
        ConversationState.QUALIFYING,
        "ASK_BOOKING_DETAILS",
        0.97
      );
      return res.sendStatus(200);
    }

    if (session.stage === "WAITING_QA") {
      if (isBookChoice(normalized) || isBookingIntent(normalized) || isAffirmative(normalized)) {
        const defaultGuests = session.guestCount ?? 2;
        const defaultRooms = session.roomCount ?? 1;
        const checkInOptions = await getAvailableCheckInDates({
          hotelId: hotel.id,
          fromDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
          days: 10,
          guests: defaultGuests,
          rooms: defaultRooms
        });
        if (!checkInOptions.length) {
          await sendReply(
            texts.unavailable,
            "WAITING_BOOKING_INTENT",
            ConversationState.QUALIFYING,
            "NO_CHECKIN_DATES_AVAILABLE",
            0.9
          );
          return res.sendStatus(200);
        }
        session.checkInOptions = checkInOptions;
        session.checkOutOptions = undefined;
        session.checkIn = undefined;
        session.checkOut = undefined;
        const calendarLink = await createCalendarSessionLink({
          appBaseUrl,
          hotelId: hotel.id,
          guestId: guest.id,
          phoneE164: normalizedPhone,
          language: session.language,
          metadata: { source: "WHATSAPP", stage: session.stage, guests: defaultGuests, rooms: defaultRooms }
        });
        await sendReply(
          `${texts.askDetails}\n\nOpen mini calendar: ${calendarLink.url}\n\n(If link fails, you can still type dates like 2026-04-10 to 2026-04-12 for 2 guests.)`,
          "WAITING_CHECKIN_PICK",
          ConversationState.QUALIFYING,
          "ASK_BOOKING_DETAILS",
          0.97
        );
        return res.sendStatus(200);
      }
      if (isAgentChoice(normalized) || isAgentRequest(normalized)) {
        await sendReply(
          "A hotel team member will follow up with you shortly.",
          "WAITING_BOOKING_INTENT",
          ConversationState.NEW,
          "AGENT_HANDOFF_REQUESTED",
          0.96
        );
        return res.sendStatus(200);
      }
      if (smartAnswer) {
        await sendReply(
          `${smartAnswer.answer}\n\n${texts.qaContinue}`,
          "WAITING_QA",
          ConversationState.NEW,
          smartAnswer.intent,
          smartAnswer.confidence
        );
        return res.sendStatus(200);
      }
      await sendReply(
        `${texts.qaIntro}\n${texts.qaExamples}\n\n${texts.qaContinue}`,
        "WAITING_QA",
        ConversationState.NEW,
        "PROMPT_QUESTION",
        0.8
      );
      return res.sendStatus(200);
    }

    if (
      smartAnswer &&
      isLikelyQuestion(normalized) &&
      (session.stage === "WAITING_BOOKING_DETAILS" ||
        session.stage === "WAITING_CHECKIN_PICK" ||
        session.stage === "WAITING_CHECKOUT_PICK" ||
        session.stage === "WAITING_EDIT")
    ) {
      await sendReply(
        `${smartAnswer.answer}\n\n${texts.qaContinue}`,
        "WAITING_QA",
        ConversationState.NEW,
        smartAnswer.intent,
        smartAnswer.confidence
      );
      return res.sendStatus(200);
    }

    if (session.stage === "WAITING_CHECKIN_PICK") {
      const choice = extractChoiceNumber(normalized);
      const parsed = parseGuestMessage(text);
      let selectedCheckIn: Date | undefined = parsed.checkIn;
      const selectedCheckInFromId = parseDateChoiceId(text, "checkin");
      if (!selectedCheckIn && selectedCheckInFromId) {
        selectedCheckIn = new Date(selectedCheckInFromId);
      }
      if (!selectedCheckIn && choice && session.checkInOptions && choice >= 1 && choice <= session.checkInOptions.length) {
        selectedCheckIn = new Date(session.checkInOptions[choice - 1]);
      }
      if (!selectedCheckIn) {
        const singleDates = extractSingleDates(text);
        if (singleDates.length) {
          selectedCheckIn = new Date(singleDates[0]);
        }
      }
      if (!selectedCheckIn || Number.isNaN(selectedCheckIn.getTime())) {
        await sendReply(
          buildCheckInPickerText(session.language, session.checkInOptions ?? buildDateChoices(new Date(Date.now() + 24 * 60 * 60 * 1000), 7)),
          "WAITING_CHECKIN_PICK",
          ConversationState.QUALIFYING,
          "CALENDAR_CHECKIN_RETRY",
          0.86
        );
        return res.sendStatus(200);
      }
      session.checkIn = selectedCheckIn;
      const checkoutOptions = await getAvailableCheckOutDates({
        hotelId: hotel.id,
        checkIn: selectedCheckIn,
        maxNights: 14,
        guests: session.guestCount ?? 2,
        rooms: session.roomCount ?? 1
      });
      if (!checkoutOptions.length) {
        await sendReply(
          texts.unavailable,
          "WAITING_BOOKING_INTENT",
          ConversationState.QUALIFYING,
          "NO_CHECKOUT_DATES_AVAILABLE",
          0.86
        );
        return res.sendStatus(200);
      }
      session.checkOutOptions = checkoutOptions;
      await sendReply(
        buildCheckOutPickerText(session.language, session.checkOutOptions),
        "WAITING_CHECKOUT_PICK",
        ConversationState.QUALIFYING,
        "CALENDAR_CHECKOUT_PROMPT",
        0.96,
        undefined,
        getPrimaryMenuHint(session.language),
        {
          buttonText: session.language === "ar" ? "اختر الخروج" : "Choose checkout",
          sections: [
            {
              title: session.language === "ar" ? "تواريخ الخروج المتاحة" : "Available checkout dates",
              rows: session.checkOutOptions.map((date, idx) => ({
                id: `checkout_${date}`,
                title: `${idx + 1}) ${date}`,
                description: session.language === "ar" ? "اضغط للاختيار" : "Tap to select"
              }))
            }
          ]
        }
      );
      return res.sendStatus(200);
    }

    if (session.stage === "WAITING_CHECKOUT_PICK") {
      const choice = extractChoiceNumber(normalized);
      const parsed = parseGuestMessage(text);
      let selectedCheckOut: Date | undefined = parsed.checkOut;
      const selectedCheckOutFromId = parseDateChoiceId(text, "checkout");
      if (!selectedCheckOut && selectedCheckOutFromId) {
        selectedCheckOut = new Date(selectedCheckOutFromId);
      }
      if (!selectedCheckOut && choice && session.checkOutOptions && choice >= 1 && choice <= session.checkOutOptions.length) {
        selectedCheckOut = new Date(session.checkOutOptions[choice - 1]);
      }
      if (!selectedCheckOut) {
        const singleDates = extractSingleDates(text);
        if (singleDates.length) {
          selectedCheckOut = new Date(singleDates[0]);
        }
      }
      if (!selectedCheckOut || Number.isNaN(selectedCheckOut.getTime()) || !session.checkIn || selectedCheckOut <= session.checkIn) {
        await sendReply(
          buildCheckOutPickerText(session.language, session.checkOutOptions ?? []),
          "WAITING_CHECKOUT_PICK",
          ConversationState.QUALIFYING,
          "CALENDAR_CHECKOUT_RETRY",
          0.82
        );
        return res.sendStatus(200);
      }
      session.checkOut = selectedCheckOut;
      await sendReply(
        session.language === "ar"
          ? "ممتاز. الآن ارسل عدد الضيوف (ويمكنك اضافة عدد الغرف). مثال: 2 ضيوف، 1 غرفة."
          : "Perfect. Now send guest count (and optionally room count). Example: 2 guests, 1 room.",
        "WAITING_BOOKING_DETAILS",
        ConversationState.QUALIFYING,
        "CALENDAR_SELECTION_DONE",
        0.96
      );
      return res.sendStatus(200);
    }

    if (session.stage === "WAITING_CONFIRMATION" && (isAffirmative(normalized) || isConfirmChoice(normalized))) {
      if (
        !session.checkIn ||
        !session.checkOut ||
        !session.guestCount ||
        !session.roomCount ||
        !session.suggestedRoomTypeId ||
        !session.suggestedPropertyId ||
        !session.nights ||
        !session.totalAmount
      ) {
        await sendReply(texts.askDetails, "WAITING_BOOKING_DETAILS", ConversationState.QUALIFYING, "ASK_BOOKING_DETAILS", 0.88);
        return res.sendStatus(200);
      }
      const finalAvailability = await findAvailableRoomType({
        hotelId: hotel.id,
        checkIn: session.checkIn,
        checkOut: session.checkOut,
        guests: session.guestCount,
        rooms: session.roomCount
      });
      if (!finalAvailability || finalAvailability.roomTypeId !== session.suggestedRoomTypeId) {
        await sendReply(
          "Availability changed just now. We will refresh options for you immediately.",
          "WAITING_BOOKING_DETAILS",
          ConversationState.QUALIFYING,
          "AVAILABILITY_REFRESH_REQUIRED",
          0.94
        );
        session.stage = "WAITING_BOOKING_DETAILS";
        return res.sendStatus(200);
      }
      await mergeGuestProfileFromBooking({
        guestId: guest.id,
        fullName: session.guestName,
        localeHint: session.language
      });
      const booking = await createConfirmedBookingAtomic({
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conversation.id,
        checkIn: session.checkIn,
        checkOut: session.checkOut,
        guests: session.guestCount,
        rooms: session.roomCount,
        currency: hotel.currency,
        source: ChannelProvider.WHATSAPP
      });
      const confirmationTemplate = applyPartnerTemplate(config.instantConfirmationTemplate, {
        hotel_name: hotel.displayName,
        guest_name: session.guestName || guest.fullName || "Guest",
        room_type: booking.roomTypeName || session.suggestedRoomTypeName || "Room",
        check_in: session.checkIn.toISOString().slice(0, 10),
        check_out: session.checkOut.toISOString().slice(0, 10),
        booking_id: booking.bookingId
      }).trim();
      const confirmationBody = confirmationTemplate || `${texts.confirmed} ${buildBookingPortalLink(booking.bookingId)}`;
      await sendReply(
        `${confirmationBody}\n${texts.confirmed} ${buildBookingPortalLink(booking.bookingId)}`,
        "IDLE",
        ConversationState.CONFIRMED,
        "BOOKING_CONFIRMED_AUTOMATION",
        0.99
      );
      return res.sendStatus(200);
    }

    if (session.stage === "WAITING_CONFIRMATION" && (isNegative(normalized) || isEditChoice(normalized))) {
      await sendReply(texts.editPrompt, "WAITING_EDIT", ConversationState.QUALIFYING, "BOOKING_EDIT_REQUESTED", 0.95);
      return res.sendStatus(200);
    }

    if (session.stage === "WAITING_EDIT") {
      await sendReply(texts.askDetails, "WAITING_BOOKING_DETAILS", ConversationState.QUALIFYING, "ASK_BOOKING_DETAILS", 0.9);
      return res.sendStatus(200);
    }

    if (smartAnswer && session.stage !== "WAITING_BOOKING_DETAILS" && session.stage !== "WAITING_CONFIRMATION") {
      await sendReply(
        `${smartAnswer.answer}\n\n${texts.askDetails}`,
        "WAITING_BOOKING_DETAILS",
        ConversationState.QUALIFYING,
        smartAnswer.intent,
        smartAnswer.confidence
      );
      return res.sendStatus(200);
    }

    const parsed = parseGuestMessage(text);
    const parsedRoomCount = parseRoomCount(text);
    const roomCount = parsedRoomCount ?? session.roomCount ?? 1;
    const guestName = parseGuestName(text) ?? session.guestName;
    if (guestName) {
      await mergeGuestProfileFromBooking({ guestId: guest.id, fullName: guestName, localeHint: session.language });
    }
    const effectiveCheckIn = parsed.checkIn ?? session.checkIn;
    const effectiveCheckOut = parsed.checkOut ?? session.checkOut;
    const effectiveGuestCount = parsed.guestCount ?? session.guestCount;

    if (!effectiveCheckIn || !effectiveCheckOut || !effectiveGuestCount) {
      const singleDates = extractSingleDates(text);
      const missing: string[] = [];
      if (!effectiveCheckIn || !effectiveCheckOut) missing.push("dates");
      if (!effectiveGuestCount) missing.push("guests");
      if (!parsedRoomCount && !session.roomCount) {
        // First capture: nudge for rooms, but keep it optional by defaulting to 1.
      } else if (!roomCount) {
        missing.push("rooms");
      }
      const hint = singleDates.length === 1 ? texts.oneDateOnly : texts.invalidFormat;
      const missingPrompt = buildMissingFieldsPrompt(session.language, missing);
      await sendReply(`${hint}\n${missingPrompt}\n${texts.askDetails}`, "WAITING_BOOKING_DETAILS", ConversationState.QUALIFYING);
      return res.sendStatus(200);
    }

    if (effectiveGuestCount < 1 || effectiveGuestCount > 16) {
      await sendReply(texts.invalidGuests, "WAITING_BOOKING_DETAILS", ConversationState.QUALIFYING);
      return res.sendStatus(200);
    }
    if (roomCount < 1 || roomCount > 6) {
      await sendReply(texts.invalidRooms, "WAITING_BOOKING_DETAILS", ConversationState.QUALIFYING);
      return res.sendStatus(200);
    }

    const nights = Math.ceil((effectiveCheckOut.getTime() - effectiveCheckIn.getTime()) / (1000 * 60 * 60 * 24));
    if (nights <= 0 || nights > 30) {
      await sendReply(texts.invalidDates, "WAITING_BOOKING_DETAILS", ConversationState.QUALIFYING);
      return res.sendStatus(200);
    }

    const availableOffer = await findAvailableRoomType({
      hotelId: hotel.id,
      checkIn: effectiveCheckIn,
      checkOut: effectiveCheckOut,
      guests: effectiveGuestCount,
      rooms: roomCount
    });
    if (!availableOffer) {
      const unavailable = applyPartnerTemplate(config.instantUnavailableTemplate, {
        hotel_name: hotel.displayName,
        alternative_room: "higher-capacity room"
      }).trim();
      await sendReply(unavailable || texts.unavailable, "WAITING_EDIT", ConversationState.QUALIFYING);
      return res.sendStatus(200);
    }

    // Defense in depth: even if a stale offer pointed to a non-ACTIVE property, refuse the booking.
    const property = await prisma.property.findFirst({
      where: { id: availableOffer.propertyId, status: PropertyStatus.ACTIVE }
    });
    if (!property) {
      await sendReply(texts.unavailable, "WAITING_EDIT", ConversationState.QUALIFYING);
      return res.sendStatus(200);
    }

    const nightlyTotal = availableOffer.nightlyTotal;
    const total = availableOffer.total;
    const aiQuote = applyPartnerTemplate(config.instantQuoteTemplate, {
      hotel_name: hotel.displayName,
      guest_name: guestName || guest.fullName || "Guest",
      room_type: availableOffer.roomTypeName,
      nightly_rate: `${nightlyTotal.toFixed(2)} ${hotel.currency}`,
      nights: availableOffer.nights,
      check_in: effectiveCheckIn.toISOString().slice(0, 10),
      check_out: effectiveCheckOut.toISOString().slice(0, 10),
      booking_id: "Draft"
    }).trim();

    const fallbackQuote = [
      texts.quoteIntro,
      `Room type: ${availableOffer.roomTypeName}`,
      `Nights: ${availableOffer.nights}`,
      `Guests: ${effectiveGuestCount}`,
      `Rooms: ${roomCount}`,
      `Total: ${total.toFixed(2)} ${hotel.currency}`,
      texts.askConfirm
    ].join("\n");
    const outgoing = config.aiEnabled && aiQuote ? `${aiQuote}\n\n${fallbackQuote}` : fallbackQuote;
    session.checkIn = effectiveCheckIn;
    session.checkOut = effectiveCheckOut;
    session.guestCount = effectiveGuestCount;
    session.roomCount = roomCount;
    session.guestName = guestName;
    session.suggestedRoomTypeId = availableOffer.roomTypeId;
    session.suggestedRoomTypeName = availableOffer.roomTypeName;
    session.suggestedPropertyId = property.id;
    session.nightlyRate = nightlyTotal;
    session.nights = availableOffer.nights;
    session.totalAmount = total;
    await sendReply(
      `${outgoing}\n\n${getConfirmMenuHint(session.language)}`,
      "WAITING_CONFIRMATION",
      ConversationState.QUOTED,
      "BOOKING_QUOTE_PROVIDED",
      0.95,
      getConfirmButtons(session.language),
      getConfirmMenuHint(session.language)
    );
    return res.sendStatus(200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("WhatsApp webhook processing error:", message);
    return res.sendStatus(200);
  }
});
