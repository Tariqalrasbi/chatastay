import crypto from "node:crypto";
import { prisma } from "../db";

export type PersistentSessionState = {
  language: string;
  stage: string;
  lastActivityAt?: string;
  phoneNumberId?: string;
  guestName?: string;
  checkIn?: string;
  checkOut?: string;
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
};

export type CalendarLinkPayload = {
  token: string;
  url: string;
  expiresAt: Date;
};

const calendarSecret = process.env.CALENDAR_LINK_SECRET ?? "chatastay_calendar_secret";
const calendarSessionTtlMs = 20 * 60 * 1000;
const conversationInactivityTtlMs = 20 * 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signToken(raw: string): string {
  return crypto.createHmac("sha256", calendarSecret).update(raw).digest("hex");
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function loadConversationSession(params: {
  hotelId: string;
  guestId: string;
  phoneE164: string;
  conversationId: string;
  defaultLanguage: string;
}): Promise<PersistentSessionState> {
  const now = Date.now();
  const persisted = await prisma.conversationSession.findUnique({
    where: { hotelId_guestId: { hotelId: params.hotelId, guestId: params.guestId } }
  });
  if (!persisted) {
    return {
      language: params.defaultLanguage,
      stage: "IDLE"
    };
  }
  const metadata = parseMetadata(persisted.metadataJson);
  const persistedLastActivityRaw = typeof metadata.lastActivityAt === "string" ? metadata.lastActivityAt : undefined;
  const persistedLastActivity = persistedLastActivityRaw ? new Date(persistedLastActivityRaw).getTime() : persisted.updatedAt.getTime();
  const isExpiredByInactivity = Number.isFinite(persistedLastActivity) && now - persistedLastActivity >= conversationInactivityTtlMs;
  if (isExpiredByInactivity) {
    return {
      language: persisted.language || params.defaultLanguage,
      stage: "IDLE",
      lastActivityAt: new Date(now).toISOString()
    };
  }

  return {
    language: persisted.language,
    stage: persisted.stage,
    lastActivityAt: persistedLastActivityRaw ?? persisted.updatedAt.toISOString(),
    phoneNumberId: typeof metadata.phoneNumberId === "string" ? metadata.phoneNumberId : undefined,
    guestName: typeof metadata.guestName === "string" ? metadata.guestName : undefined,
    checkIn: typeof metadata.checkIn === "string" ? metadata.checkIn : undefined,
    checkOut: typeof metadata.checkOut === "string" ? metadata.checkOut : undefined,
    checkInOptions: Array.isArray(metadata.checkInOptions) ? metadata.checkInOptions.filter((x): x is string => typeof x === "string") : undefined,
    checkOutOptions: Array.isArray(metadata.checkOutOptions) ? metadata.checkOutOptions.filter((x): x is string => typeof x === "string") : undefined,
    guestCount: typeof metadata.guestCount === "number" ? metadata.guestCount : undefined,
    roomCount: typeof metadata.roomCount === "number" ? metadata.roomCount : undefined,
    suggestedRoomTypeId: typeof metadata.suggestedRoomTypeId === "string" ? metadata.suggestedRoomTypeId : undefined,
    suggestedRoomTypeName: typeof metadata.suggestedRoomTypeName === "string" ? metadata.suggestedRoomTypeName : undefined,
    suggestedPropertyId: typeof metadata.suggestedPropertyId === "string" ? metadata.suggestedPropertyId : undefined,
    nightlyRate: typeof metadata.nightlyRate === "number" ? metadata.nightlyRate : undefined,
    nights: typeof metadata.nights === "number" ? metadata.nights : undefined,
    totalAmount: typeof metadata.totalAmount === "number" ? metadata.totalAmount : undefined
  };
}

export async function saveConversationSession(params: {
  hotelId: string;
  guestId: string;
  conversationId?: string;
  phoneE164: string;
  state: PersistentSessionState;
  ttlMs?: number;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (params.ttlMs ?? conversationInactivityTtlMs));
  const metadata = {
    lastActivityAt: params.state.lastActivityAt ?? nowIso,
    phoneNumberId: params.state.phoneNumberId ?? null,
    guestName: params.state.guestName ?? null,
    checkIn: params.state.checkIn ?? null,
    checkOut: params.state.checkOut ?? null,
    checkInOptions: params.state.checkInOptions ?? [],
    checkOutOptions: params.state.checkOutOptions ?? [],
    guestCount: params.state.guestCount ?? null,
    roomCount: params.state.roomCount ?? null,
    suggestedRoomTypeId: params.state.suggestedRoomTypeId ?? null,
    suggestedRoomTypeName: params.state.suggestedRoomTypeName ?? null,
    suggestedPropertyId: params.state.suggestedPropertyId ?? null,
    nightlyRate: params.state.nightlyRate ?? null,
    nights: params.state.nights ?? null,
    totalAmount: params.state.totalAmount ?? null
  };
  await prisma.conversationSession.upsert({
    where: { hotelId_guestId: { hotelId: params.hotelId, guestId: params.guestId } },
    create: {
      hotelId: params.hotelId,
      guestId: params.guestId,
      conversationId: params.conversationId,
      phoneE164: params.phoneE164,
      language: params.state.language,
      stage: params.state.stage,
      metadataJson: JSON.stringify(metadata),
      expiresAt
    },
    update: {
      conversationId: params.conversationId,
      phoneE164: params.phoneE164,
      language: params.state.language,
      stage: params.state.stage,
      metadataJson: JSON.stringify(metadata),
      expiresAt
    }
  });
}

export async function upsertBookingDraft(params: {
  hotelId: string;
  guestId: string;
  conversationId?: string;
  state: PersistentSessionState;
  currency: string;
  source?: string;
}): Promise<void> {
  const openDraft = await prisma.bookingDraft.findFirst({
    where: { hotelId: params.hotelId, guestId: params.guestId, status: "OPEN" },
    orderBy: { updatedAt: "desc" }
  });
  const draftData = {
    hotelId: params.hotelId,
    guestId: params.guestId,
    conversationId: params.conversationId,
    source: params.source ?? "WHATSAPP",
    status: "OPEN",
    checkIn: params.state.checkIn ? new Date(params.state.checkIn) : null,
    checkOut: params.state.checkOut ? new Date(params.state.checkOut) : null,
    adults: params.state.guestCount ?? 2,
    rooms: params.state.roomCount ?? 1,
    guestName: params.state.guestName ?? null,
    roomTypeId: params.state.suggestedRoomTypeId ?? null,
    roomTypeName: params.state.suggestedRoomTypeName ?? null,
    propertyId: params.state.suggestedPropertyId ?? null,
    nightlyRate: params.state.nightlyRate ?? null,
    totalAmount: params.state.totalAmount ?? null,
    currency: params.currency,
    metadataJson: JSON.stringify({
      stage: params.state.stage,
      nights: params.state.nights ?? null,
      checkInOptions: params.state.checkInOptions ?? [],
      checkOutOptions: params.state.checkOutOptions ?? []
    }),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000)
  };
  if (!openDraft) {
    await prisma.bookingDraft.create({ data: draftData });
    return;
  }
  await prisma.bookingDraft.update({
    where: { id: openDraft.id },
    data: draftData
  });
}

export async function createCalendarSessionLink(params: {
  appBaseUrl: string;
  hotelId: string;
  guestId?: string;
  phoneE164: string;
  language: string;
  metadata?: Record<string, unknown>;
}): Promise<CalendarLinkPayload> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const rawToken = `${params.hotelId}.${nonce}.${Date.now()}`;
  const signature = signToken(rawToken);
  const token = `${rawToken}.${signature}`;
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + calendarSessionTtlMs);

  await prisma.calendarSession.create({
    data: {
      hotelId: params.hotelId,
      guestId: params.guestId,
      tokenHash,
      phoneE164: params.phoneE164,
      language: params.language,
      metadataJson: JSON.stringify(params.metadata ?? {}),
      expiresAt
    }
  });

  const base = params.appBaseUrl.endsWith("/") ? params.appBaseUrl.slice(0, -1) : params.appBaseUrl;
  const query = new URLSearchParams({ token });
  return {
    token,
    url: `${base}/guest/calendar?${query.toString()}`,
    expiresAt
  };
}

export async function resolveCalendarSession(token: string): Promise<{
  id: string;
  hotelId: string;
  guestId?: string | null;
  phoneE164: string;
  language: string;
  metadata: Record<string, unknown>;
  expiresAt: Date;
}> {
  const segments = token.split(".");
  if (segments.length < 4) {
    throw new Error("Invalid calendar token");
  }
  const providedSignature = segments[segments.length - 1];
  const rawToken = segments.slice(0, -1).join(".");
  const expectedSignature = signToken(rawToken);
  if (providedSignature !== expectedSignature) {
    throw new Error("Invalid calendar token signature");
  }
  const row = await prisma.calendarSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row) {
    throw new Error("Calendar session not found");
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new Error("Calendar session expired");
  }
  return {
    id: row.id,
    hotelId: row.hotelId,
    guestId: row.guestId,
    phoneE164: row.phoneE164,
    language: row.language,
    metadata: parseMetadata(row.metadataJson),
    expiresAt: row.expiresAt
  };
}

export async function markCalendarSessionUsed(id: string): Promise<void> {
  await prisma.calendarSession.update({
    where: { id },
    data: { usedAt: new Date() }
  });
}

