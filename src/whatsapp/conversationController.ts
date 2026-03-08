import { ConversationState as DbConversationState, MessageDirection } from "@prisma/client";
import { parseGuestMessage, validateParsedBookingInput } from "../core/parse";
import { findAvailableRoomType } from "../core/availability";
import { createConfirmedBookingAtomic } from "../core/bookingService";
import { nextState, type ConversationEvent, type ConversationState } from "../core/stateMachine";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { loadConversationSession, saveConversationSession, upsertBookingDraft } from "../core/sessionStore";
import { prisma } from "../db";
import { logWhatsAppMessage } from "./messageLogger";
import { answerFromKnowledge, buildKnowledgeFallbackMessage } from "./knowledgeBase";
import { sendWhatsAppText } from "./send";

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

function isBookingIntent(text: string): boolean {
  const n = normalizeText(text);
  return /\b(book|booking|reserve|reservation|i want to book|book now|confirm booking|حجز|اريد الحجز|أريد الحجز)\b/.test(n);
}

function buildMainMenuMessage(hotelName: string): string {
  return [
    `Welcome to ${hotelName}.`,
    "You can:",
    "1) Ask about rooms and facilities",
    "2) Ask about prices and policies",
    "3) Start a booking"
  ].join("\n");
}

function isActiveBookingState(state: ConversationState): boolean {
  return state === "collecting_dates" || state === "quoted" || state === "awaiting_confirmation";
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
    if (/^(no|n|cancel|edit|change)$/i.test(normalized)) {
      return "guest_cancelled";
    }
  }
  if (state === "collecting_dates" && parsed.checkIn && parsed.checkOut) {
    return "dates_collected";
  }
  if (state === "quoted") return "quote_sent";
  return "message_received";
}

async function resolveHotel(inboundPhoneNumberId?: string): Promise<{ id: string; displayName: string; currency: string; phoneNumberId?: string }> {
  const hotels = await prisma.hotel.findMany({ orderBy: { createdAt: "asc" } });
  if (!hotels.length) {
    throw new Error("No hotels configured");
  }
  if (inboundPhoneNumberId) {
    for (const hotel of hotels) {
      const config = loadPartnerSetupConfig(hotel.id);
      if (config.whatsappPhoneNumberId && config.whatsappPhoneNumberId === inboundPhoneNumberId) {
        return { id: hotel.id, displayName: hotel.displayName, currency: hotel.currency, phoneNumberId: config.whatsappPhoneNumberId };
      }
    }
  }
  const fallback = hotels[0];
  const fallbackConfig = loadPartnerSetupConfig(fallback.id);
  return { id: fallback.id, displayName: fallback.displayName, currency: fallback.currency, phoneNumberId: fallbackConfig.whatsappPhoneNumberId || undefined };
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
      updateSession: {}
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
    const offer = await findAvailableRoomType({
      hotelId: params.hotelId,
      checkIn,
      checkOut,
      guests: guestCount,
      rooms: roomCount
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
        "Reply YES to confirm, EDIT to change details, or NO to cancel."
      ].join("\n"),
      updateSession: {
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

  if (params.state === "awaiting_confirmation" && params.event === "guest_confirmed") {
    const checkIn = parsed.checkIn ?? sessionCheckIn;
    const checkOut = parsed.checkOut ?? sessionCheckOut;
    if (!checkIn || !checkOut) {
      return {
        nextState: "collecting_dates",
        conversationState: DbConversationState.QUALIFYING,
        responseBody: "I need your dates again before confirming. Please send check-in and check-out.",
        updateSession: {}
      };
    }
    const booking = await createConfirmedBookingAtomic({
      hotelId: params.hotelId,
      guestId: params.guestId,
      conversationId: params.conversationId,
      checkIn,
      checkOut,
      guests: sessionGuests,
      rooms: sessionRooms,
      currency: params.currency
    });
    return {
      nextState: "confirmed",
      conversationState: DbConversationState.CONFIRMED,
      responseBody: `Confirmed. Booking ID: ${booking.bookingId}. Thank you for booking with us.`,
      updateSession: {}
    };
  }

  if (params.state === "awaiting_confirmation" && params.event === "guest_cancelled") {
    const normalized = normalizeText(params.text);
    if (normalized === "cancel") {
      return {
        nextState: "cancelled",
        conversationState: DbConversationState.CLOSED,
        responseBody: "Booking cancelled. If you want, I can start a new booking anytime.",
        updateSession: {}
      };
    }
    return {
      nextState: "collecting_dates",
      conversationState: DbConversationState.QUALIFYING,
      responseBody: "Sure. What would you like to change: dates, guests, or rooms?",
      updateSession: {}
    };
  }

  if (next === "collecting_dates") {
    const validation = validateParsedBookingInput(parsed);
    return {
      nextState: next,
      conversationState: DbConversationState.QUALIFYING,
      responseBody: validation.ok ? bookingStartPrompt() : missingBookingDetailsPrompt(parsed),
      updateSession: {}
    };
  }

  if (next === "awaiting_confirmation") {
    return {
      nextState: next,
      conversationState: DbConversationState.QUOTED,
      responseBody: "Please reply YES to confirm your booking or NO to cancel.",
      updateSession: {}
    };
  }

  return {
    nextState: next,
    conversationState: toDbConversationState(next),
    responseBody: "How can I help with your booking today?",
    updateSession: {}
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
        state: { in: [DbConversationState.NEW, DbConversationState.QUALIFYING, DbConversationState.QUOTED, DbConversationState.PAYMENT_PENDING] }
      },
      orderBy: { updatedAt: "desc" }
    })) ??
    (await prisma.conversation.create({
      data: { hotelId: hotel.id, guestId: guest.id, state: DbConversationState.NEW, lastMessageAt: new Date() }
    }));

  await prisma.message
    .create({
      data: {
        hotelId: hotel.id,
        conversationId: conversation.id,
        providerMessageId: input.messageId,
        direction: MessageDirection.INBOUND,
        body: input.text
      }
    })
    .catch(() => undefined);
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
  const normalizedInputText = normalizeText(input.text);

  if (isGreeting(normalizedInputText)) {
    const responseBody = buildMainMenuMessage(hotel.displayName);
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
        language: persisted.language || "en",
        stage: "new",
        lastActivityAt: new Date().toISOString(),
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
  if (knowledgeReply.isKnowledgeQuery) {
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

  if (!isBookingIntent(normalizedInputText) && !isActiveBookingState(currentState)) {
    const responseBody = buildMainMenuMessage(hotel.displayName);
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
        language: persisted.language || "en",
        stage: currentState,
        lastActivityAt: new Date().toISOString(),
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

  const parsed = parseGuestMessage(input.text);
  const event = inferEvent(currentState, input.text, parsed);
  const turn = await buildTurnResult({
    state: currentState,
    event,
    text: input.text,
    hotelId: hotel.id,
    hotelName: hotel.displayName,
    currency: hotel.currency,
    guestId: guest.id,
    conversationId: conversation.id,
    sessionData: {
      checkIn: persisted.checkIn,
      checkOut: persisted.checkOut,
      guestCount: persisted.guestCount,
      roomCount: persisted.roomCount
    }
  });

  await sendWhatsAppText({
    to: normalizedPhone,
    body: turn.responseBody,
    phoneNumberId: hotel.phoneNumberId,
    conversationId: conversation.id
  });

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
    phoneNumberId: hotel.phoneNumberId,
    checkIn: typeof turn.updateSession.checkIn === "string" ? turn.updateSession.checkIn : persisted.checkIn,
    checkOut: typeof turn.updateSession.checkOut === "string" ? turn.updateSession.checkOut : persisted.checkOut,
    guestCount: typeof turn.updateSession.guestCount === "number" ? turn.updateSession.guestCount : persisted.guestCount,
    roomCount: typeof turn.updateSession.roomCount === "number" ? turn.updateSession.roomCount : persisted.roomCount,
    suggestedRoomTypeId:
      typeof turn.updateSession.suggestedRoomTypeId === "string" ? turn.updateSession.suggestedRoomTypeId : persisted.suggestedRoomTypeId,
    suggestedRoomTypeName:
      typeof turn.updateSession.suggestedRoomTypeName === "string" ? turn.updateSession.suggestedRoomTypeName : persisted.suggestedRoomTypeName,
    suggestedPropertyId:
      typeof turn.updateSession.suggestedPropertyId === "string" ? turn.updateSession.suggestedPropertyId : persisted.suggestedPropertyId,
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

