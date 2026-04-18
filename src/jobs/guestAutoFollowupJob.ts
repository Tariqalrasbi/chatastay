import { BookingStatus, ConversationState, MessageDirection, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { getSafeSendTime, hotelTimezoneOrUtc } from "./preArrivalReminderJob";
import { trySendWhatsAppText } from "../whatsapp/send";
import { parseLightGuestMemory } from "../core/lightGuestMemory";
import { trackDecisionEventSafe } from "../core/decisionAnalytics";

type FollowUpType =
  | "BOOKING_RECOVERY"
  | "PENDING_REQUEST"
  | "PRE_ARRIVAL_ENGAGEMENT"
  | "POST_STAY_FOLLOWUP"
  | "RE_ENGAGEMENT";

function envHoursToMs(envKey: string, defaultHours: number): number {
  const h = parseInt(process.env[envKey] ?? String(defaultHours), 10);
  const hours = Number.isFinite(h) && h >= 0 ? h : defaultHours;
  return hours * 60 * 60 * 1000;
}

function envDaysToMs(envKey: string, defaultDays: number): number {
  const d = parseInt(process.env[envKey] ?? String(defaultDays), 10);
  const days = Number.isFinite(d) && d >= 0 ? d : defaultDays;
  return days * 24 * 60 * 60 * 1000;
}

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function firstName(fullName: string | null | undefined): string {
  const t = fullName?.trim();
  if (!t) return "Guest";
  return t.split(/\s+/)[0] ?? "Guest";
}

function withFollowupFactor(baseMs: number, factor: number): number {
  return Math.max(30 * 60 * 1000, Math.round(baseMs * factor));
}

async function getOrCreateConversation(hotelId: string, guestId: string): Promise<{ id: string }> {
  const existing = await prisma.conversation.findFirst({
    where: { hotelId, guestId },
    orderBy: { updatedAt: "desc" },
    select: { id: true }
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: {
      hotelId,
      guestId,
      channel: "WHATSAPP",
      state: ConversationState.NEW,
      lastMessageAt: new Date()
    },
    select: { id: true }
  });
}

async function enqueueFollowUp(params: {
  hotelId: string;
  propertyId?: string | null;
  guestId: string;
  bookingId?: string | null;
  conversationId?: string | null;
  type: FollowUpType;
  dedupeKey: string;
  scheduledFor: Date;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await prisma.guestFollowUp
    .create({
      data: {
        hotelId: params.hotelId,
        propertyId: params.propertyId ?? null,
        guestId: params.guestId,
        bookingId: params.bookingId ?? null,
        conversationId: params.conversationId ?? null,
        type: params.type,
        dedupeKey: params.dedupeKey,
        scheduledFor: params.scheduledFor,
        payloadJson: JSON.stringify(params.payload ?? {})
      }
    })
    .catch((err) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
      throw err;
    });
}

async function seedBookingRecovery(now: Date, recoveryDelayMs: number): Promise<void> {
  const rows = await prisma.conversationSession.findMany({
    where: {
      stage: { in: ["collecting_dates", "quoted", "awaiting_confirmation"] }
    },
    include: {
      guest: { select: { hotelId: true } }
    },
    take: 200
  });
  for (const s of rows) {
    const sessionConversation = s.conversationId
      ? await prisma.conversation.findUnique({
          where: { id: s.conversationId },
          select: { propertyId: true }
        })
      : null;
    const factor = loadPartnerSetupConfig(s.hotelId).optimizationSettings.followupDelayFactor;
    const effectiveDelayMs = withFollowupFactor(recoveryDelayMs, factor);
    const scheduledFor = new Date(s.updatedAt.getTime() + effectiveDelayMs);
    const dedupeKey = `booking_recovery:${s.id}:${scheduledFor.toISOString().slice(0, 13)}`;
    // Skip if already confirmed booking exists recently for this guest.
    const confirmed = await prisma.booking.findFirst({
      where: {
        guestId: s.guestId,
        hotelId: s.hotelId,
        status: BookingStatus.CONFIRMED,
        createdAt: { gte: s.updatedAt }
      },
      select: { id: true }
    });
    if (confirmed) continue;
    await enqueueFollowUp({
      hotelId: s.hotelId,
      propertyId: sessionConversation?.propertyId ?? null,
      guestId: s.guestId,
      conversationId: s.conversationId,
      type: "BOOKING_RECOVERY",
      dedupeKey,
      scheduledFor,
      payload: { sessionId: s.id }
    });
    await trackDecisionEventSafe({
      hotelId: s.hotelId,
      propertyId: sessionConversation?.propertyId ?? null,
      eventType: "booking_abandoned",
      guestId: s.guestId,
      conversationId: s.conversationId ?? undefined,
      source: "followup_seed_booking_recovery",
      dedupeKey: `booking_abandoned:${dedupeKey}`
    });
  }
}

async function seedPendingRequest(now: Date, pendingDelayMs: number): Promise<void> {
  const since = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const audits = await prisma.auditLog.findMany({
    where: {
      action: "GUEST_INTENT_ACTION_TASK",
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" },
    take: 300
  });
  for (const a of audits) {
    const meta = safeJson(a.metadataJson);
    const guestId = typeof meta.guestId === "string" ? meta.guestId : null;
    const conversationId = typeof meta.conversationId === "string" ? meta.conversationId : null;
    const bookingId = typeof a.bookingId === "string" ? a.bookingId : null;
    const actionKey = typeof meta.actionKey === "string" ? meta.actionKey : "pending_request";
    if (!guestId) continue;
    const factor = loadPartnerSetupConfig(a.hotelId).optimizationSettings.followupDelayFactor;
    const effectiveDelayMs = withFollowupFactor(pendingDelayMs, factor);
    const scheduledFor = new Date(a.createdAt.getTime() + effectiveDelayMs);
    await enqueueFollowUp({
      hotelId: a.hotelId,
      propertyId: typeof meta.propertyId === "string" ? meta.propertyId : null,
      guestId,
      bookingId,
      conversationId,
      type: "PENDING_REQUEST",
      dedupeKey: `pending_request:${a.id}`,
      scheduledFor,
      payload: { actionKey }
    });
  }
}

async function seedPreArrivalAndPostStay(now: Date): Promise<void> {
  const bookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.CONFIRMED,
      OR: [{ checkIn: { gt: now } }, { checkOut: { lt: now } }]
    },
    include: {
      conversation: { select: { id: true } }
    },
    take: 400
  });
  const hotelRows = await prisma.hotel.findMany({ select: { id: true, timezone: true } });
  const tzByHotelId = new Map(hotelRows.map((h) => [h.id, hotelTimezoneOrUtc(h.timezone)]));
  for (const b of bookings) {
    const tz = tzByHotelId.get(b.hotelId) ?? "UTC";
    const factor = loadPartnerSetupConfig(b.hotelId).optimizationSettings.followupDelayFactor;
    const checkInMs = b.checkIn.getTime();
    const checkOutMs = b.checkOut.getTime();
    if (checkInMs > now.getTime()) {
      const hoursBefore = envHoursToMs("AUTO_FOLLOWUP_PRE_ARRIVAL_HOURS", 36);
      const adjustedHoursBefore = withFollowupFactor(hoursBefore, factor);
      const rawPre = new Date(checkInMs - adjustedHoursBefore);
      const scheduledFor = getSafeSendTime(rawPre, tz).adjustedUtc;
      await enqueueFollowUp({
        hotelId: b.hotelId,
        propertyId: b.propertyId,
        guestId: b.guestId,
        bookingId: b.id,
        conversationId: b.conversationId,
        type: "PRE_ARRIVAL_ENGAGEMENT",
        dedupeKey: `pre_arrival:${b.id}`,
        scheduledFor,
        payload: {}
      });
    }
    if (checkOutMs < now.getTime()) {
      const postStayDelay = envHoursToMs("AUTO_FOLLOWUP_POST_STAY_HOURS", 24);
      const adjustedPostStayDelay = withFollowupFactor(postStayDelay, factor);
      const rawPost = new Date(checkOutMs + adjustedPostStayDelay);
      const scheduledFor = getSafeSendTime(rawPost, tz).adjustedUtc;
      await enqueueFollowUp({
        hotelId: b.hotelId,
        propertyId: b.propertyId,
        guestId: b.guestId,
        bookingId: b.id,
        conversationId: b.conversationId,
        type: "POST_STAY_FOLLOWUP",
        dedupeKey: `post_stay:${b.id}`,
        scheduledFor,
        payload: {}
      });
    }
  }
}

async function seedReEngagement(now: Date): Promise<void> {
  const reengageAfterMs = envDaysToMs("AUTO_FOLLOWUP_REENGAGE_DAYS", 60);
  const hotelRows = await prisma.hotel.findMany({ select: { id: true, timezone: true } });
  const tzByHotelId = new Map(hotelRows.map((h) => [h.id, hotelTimezoneOrUtc(h.timezone)]));
  const guests = await prisma.guest.findMany({
    where: {
      bookings: {
        some: {
          status: BookingStatus.CONFIRMED,
          checkOut: { lt: new Date(now.getTime() - reengageAfterMs) }
        }
      }
    },
    include: {
      bookings: {
        where: { status: BookingStatus.CONFIRMED },
        orderBy: { checkOut: "desc" },
        take: 1,
        select: { id: true, checkOut: true, hotelId: true, propertyId: true }
      }
    },
    take: 200
  });
  for (const g of guests) {
    const last = g.bookings[0];
    if (!last) continue;
    const upcoming = await prisma.booking.findFirst({
      where: { guestId: g.id, hotelId: g.hotelId, status: BookingStatus.CONFIRMED, checkIn: { gt: now } },
      select: { id: true }
    });
    if (upcoming) continue;
    const factor = loadPartnerSetupConfig(g.hotelId).optimizationSettings.followupDelayFactor;
    const adjustedReengageMs = withFollowupFactor(reengageAfterMs, factor);
    const tz = tzByHotelId.get(g.hotelId) ?? "UTC";
    const rawRe = new Date(last.checkOut.getTime() + adjustedReengageMs);
    const scheduledFor = getSafeSendTime(rawRe, tz).adjustedUtc;
    await enqueueFollowUp({
      hotelId: g.hotelId,
      propertyId: last.propertyId ?? null,
      guestId: g.id,
      bookingId: null,
      type: "RE_ENGAGEMENT",
      dedupeKey: `reengage:${g.id}:${last.checkOut.toISOString().slice(0, 10)}`,
      scheduledFor,
      payload: {}
    });
  }
}

function buildFollowUpBody(params: {
  type: FollowUpType;
  guestName: string;
  hotelName: string;
  memoryJson?: string | null;
}): string {
  const who = firstName(params.guestName);
  const mem = parseLightGuestMemory(params.memoryJson ?? null);
  if (params.type === "BOOKING_RECOVERY") {
    return `Hello ${who}, just checking in — would you like us to complete your booking or assist you further?`;
  }
  if (params.type === "PENDING_REQUEST") {
    return `Hello ${who}, following up on your request — please let us know if you would like us to proceed with the arrangement.`;
  }
  if (params.type === "PRE_ARRIVAL_ENGAGEMENT") {
    if ((mem.preferredActivities ?? []).length > 0) {
      return `Hello ${who}, we look forward to welcoming you soon. If you wish, we can also arrange activities similar to your previous preferences before arrival.`;
    }
    return `Hello ${who}, we look forward to welcoming you soon. Let us know if you would like to arrange any activities or services before arrival.`;
  }
  if (params.type === "POST_STAY_FOLLOWUP") {
    return `Dear ${who}, thank you for staying with ${params.hotelName}. We hope you had a wonderful experience and look forward to welcoming you again.`;
  }
  return `Dear ${who}, we would love to welcome you again at ${params.hotelName}. Let us know if you would like to explore our latest offers or plan your next visit.`;
}

async function shouldSuppressSend(fu: {
  hotelId: string;
  guestId: string;
  bookingId: string | null;
  conversationId: string | null;
  type: string;
  createdAt: Date;
}): Promise<boolean> {
  // Never interrupt active back-and-forth: skip if inbound in last 45 minutes.
  const activeSince = new Date(Date.now() - 45 * 60 * 1000);
  const latestInbound = await prisma.message.findFirst({
    where: {
      hotelId: fu.hotelId,
      direction: MessageDirection.INBOUND,
      conversation: { guestId: fu.guestId },
      createdAt: { gte: activeSince }
    },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  if (latestInbound) return true;

  if (fu.type === "BOOKING_RECOVERY") {
    const session = await prisma.conversationSession.findFirst({
      where: { hotelId: fu.hotelId, guestId: fu.guestId },
      select: { stage: true, updatedAt: true }
    });
    if (!session) return true;
    if (!["collecting_dates", "quoted", "awaiting_confirmation"].includes(session.stage)) return true;
    if (session.updatedAt > fu.createdAt) return true;
    const confirmed = await prisma.booking.findFirst({
      where: { hotelId: fu.hotelId, guestId: fu.guestId, status: BookingStatus.CONFIRMED, createdAt: { gte: fu.createdAt } },
      select: { id: true }
    });
    if (confirmed) return true;
  }
  if (fu.type === "PRE_ARRIVAL_ENGAGEMENT" && fu.bookingId) {
    const b = await prisma.booking.findUnique({ where: { id: fu.bookingId }, select: { status: true, checkIn: true } });
    if (!b || b.status !== BookingStatus.CONFIRMED || b.checkIn.getTime() <= Date.now()) return true;
  }
  if (fu.type === "POST_STAY_FOLLOWUP" && fu.bookingId) {
    const b = await prisma.booking.findUnique({ where: { id: fu.bookingId }, select: { status: true, checkOut: true } });
    if (!b || b.status !== BookingStatus.CONFIRMED || b.checkOut.getTime() > Date.now()) return true;
  }
  if (fu.type === "RE_ENGAGEMENT") {
    const upcoming = await prisma.booking.findFirst({
      where: { hotelId: fu.hotelId, guestId: fu.guestId, status: BookingStatus.CONFIRMED, checkIn: { gt: new Date() } },
      select: { id: true }
    });
    if (upcoming) return true;
  }
  return false;
}

export async function runGuestAutoFollowupSweep(): Promise<{ scheduled: number; sent: number; skipped: number }> {
  const now = new Date();
  const bookingRecoveryDelayMs = envHoursToMs("AUTO_FOLLOWUP_BOOKING_RECOVERY_HOURS", 2);
  const pendingRequestDelayMs = envHoursToMs("AUTO_FOLLOWUP_PENDING_REQUEST_HOURS", 8);

  await seedBookingRecovery(now, bookingRecoveryDelayMs);
  await seedPendingRequest(now, pendingRequestDelayMs);
  await seedPreArrivalAndPostStay(now);
  await seedReEngagement(now);

  const due = await prisma.guestFollowUp.findMany({
    where: { status: "PENDING", scheduledFor: { lte: now } },
    include: {
      guest: { select: { id: true, fullName: true, phoneE164: true, lightGuestMemoryJson: true } },
      hotel: { select: { id: true, displayName: true, timezone: true } }
    },
    orderBy: { scheduledFor: "asc" },
    take: 200
  });

  let sent = 0;
  let skipped = 0;
  for (const fu of due) {
    const tz = hotelTimezoneOrUtc(fu.hotel.timezone);
    const sendNotBefore = getSafeSendTime(fu.scheduledFor, tz).adjustedUtc;
    if (now.getTime() < sendNotBefore.getTime()) {
      skipped++;
      continue;
    }

    const suppress = await shouldSuppressSend(fu);
    if (suppress) {
      await prisma.guestFollowUp.update({
        where: { id: fu.id },
        data: { status: "CANCELLED", cancelledAt: new Date() }
      });
      skipped++;
      continue;
    }
    const cfg = loadPartnerSetupConfig(fu.hotelId);
    const phoneNumberId = cfg.whatsappPhoneNumberId?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!phoneNumberId || !fu.guest.phoneE164?.trim()) {
      await prisma.guestFollowUp.update({
        where: { id: fu.id },
        data: { status: "CANCELLED", cancelledAt: new Date() }
      });
      skipped++;
      continue;
    }
    const conversation = fu.conversationId
      ? { id: fu.conversationId }
      : await getOrCreateConversation(fu.hotelId, fu.guestId);

    const body = buildFollowUpBody({
      type: fu.type as FollowUpType,
      guestName: fu.guest.fullName ?? "Guest",
      hotelName: fu.hotel.displayName,
      memoryJson: fu.guest.lightGuestMemoryJson
    });
    const send = await trySendWhatsAppText({
      to: fu.guest.phoneE164,
      body,
      phoneNumberId,
      conversationId: conversation.id
    });
    if (!send.ok) {
      // Keep pending for retry on next run.
      skipped++;
      continue;
    }
    const sentAt = new Date();
    await prisma.$transaction([
      prisma.guestFollowUp.update({
        where: { id: fu.id },
        data: { status: "SENT", sentAt }
      }),
      prisma.message.create({
        data: {
          hotelId: fu.hotelId,
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          body,
          aiIntent: `AUTO_FOLLOWUP_${fu.type}`,
          aiConfidence: 0.95
        }
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: sentAt }
      }),
      prisma.auditLog.create({
        data: {
          hotelId: fu.hotelId,
          propertyId: fu.propertyId ?? null,
          action: "AUTO_FOLLOWUP_SENT",
          entityType: "GuestFollowUp",
          entityId: fu.id,
          bookingId: fu.bookingId ?? null,
          metadataJson: JSON.stringify({
            type: fu.type,
            guestId: fu.guestId,
            conversationId: conversation.id,
            scheduledFor: fu.scheduledFor.toISOString(),
            sentAt: sentAt.toISOString()
          })
        }
      })
    ]);
    await trackDecisionEventSafe({
      hotelId: fu.hotelId,
      eventType: "followup_sent",
      guestId: fu.guestId,
      bookingId: fu.bookingId ?? undefined,
      conversationId: conversation.id,
      source: "auto_followup_job",
      dedupeKey: `followup_sent:${fu.id}`,
      metadata: { followupType: fu.type, propertyId: fu.propertyId ?? null },
      propertyId: fu.propertyId ?? null
    });
    sent++;
  }
  return { scheduled: due.length, sent, skipped };
}

export function startGuestAutoFollowupScheduler(): NodeJS.Timeout {
  const intervalMs = Math.max(60_000, parseInt(process.env.AUTO_FOLLOWUP_INTERVAL_MS ?? "900000", 10) || 900_000);
  const run = () => {
    runGuestAutoFollowupSweep().catch((err) =>
      console.error("[auto-followup] sweep failed:", err instanceof Error ? err.message : String(err))
    );
  };
  run();
  return setInterval(run, intervalMs);
}
