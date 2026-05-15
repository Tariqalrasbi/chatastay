import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { parseLightGuestMemory } from "./lightGuestMemory";

export const STAFF_SCHEDULED_FOLLOWUP_TYPE = "STAFF_SCHEDULED";

const MIN_MESSAGE_LEN = 10;
const MAX_MESSAGE_LEN = 900;
const MAX_PENDING_STAFF_PER_GUEST = 8;
const MIN_LEAD_MS = 15 * 60 * 1000;
const MAX_HORIZON_MS = 120 * 24 * 60 * 60 * 1000;

export type StaffFollowUpPayload = {
  message: string;
  createdByEmail?: string;
  createdByStaffId?: string;
};

export function guestFollowUpTypeLabel(type: string): string {
  if (type === STAFF_SCHEDULED_FOLLOWUP_TYPE) return "Staff scheduled";
  return type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function staffFollowUpMessageFromPayload(payloadJson: string | null | undefined): string | null {
  if (!payloadJson?.trim()) return null;
  try {
    const o = JSON.parse(payloadJson) as Record<string, unknown>;
    const msg = typeof o.message === "string" ? o.message.trim() : "";
    return msg.length >= MIN_MESSAGE_LEN ? msg.slice(0, MAX_MESSAGE_LEN) : null;
  } catch {
    return null;
  }
}

export function parseStaffFollowUpScheduledAt(raw: unknown): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T10:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type CreateStaffFollowUpResult =
  | { ok: true; followUpId: string }
  | { ok: false; error: string };

export async function createStaffScheduledGuestFollowUp(params: {
  hotelId: string;
  guestId: string;
  propertyId?: string | null;
  bookingId?: string | null;
  conversationId?: string | null;
  scheduledFor: Date;
  message: string;
  createdByEmail?: string | null;
  createdByStaffId?: string | null;
}): Promise<CreateStaffFollowUpResult> {
  const message = params.message.trim().slice(0, MAX_MESSAGE_LEN);
  if (message.length < MIN_MESSAGE_LEN) {
    return { ok: false, error: `Message must be at least ${MIN_MESSAGE_LEN} characters.` };
  }

  const now = Date.now();
  if (params.scheduledFor.getTime() < now + MIN_LEAD_MS) {
    return { ok: false, error: "Schedule at least 15 minutes from now." };
  }
  if (params.scheduledFor.getTime() > now + MAX_HORIZON_MS) {
    return { ok: false, error: "Schedule within the next 120 days." };
  }

  const guest = await prisma.guest.findFirst({
    where: { id: params.guestId, hotelId: params.hotelId },
    select: { id: true, lightGuestMemoryJson: true }
  });
  if (!guest) {
    return { ok: false, error: "Guest not found." };
  }

  const mem = parseLightGuestMemory(guest.lightGuestMemoryJson);
  if (mem.messagingDoNotDisturb) {
    return {
      ok: false,
      error: "Guest has Do Not Disturb on WhatsApp — cancel DND in light memory before scheduling, or message manually from the conversation."
    };
  }

  const pendingStaff = await prisma.guestFollowUp.count({
    where: {
      hotelId: params.hotelId,
      guestId: params.guestId,
      status: "PENDING",
      type: STAFF_SCHEDULED_FOLLOWUP_TYPE
    }
  });
  if (pendingStaff >= MAX_PENDING_STAFF_PER_GUEST) {
    return { ok: false, error: `Maximum ${MAX_PENDING_STAFF_PER_GUEST} pending staff follow-ups per guest.` };
  }

  if (params.bookingId) {
    const booking = await prisma.booking.findFirst({
      where: { id: params.bookingId, hotelId: params.hotelId, guestId: params.guestId },
      select: { id: true }
    });
    if (!booking) {
      return { ok: false, error: "Booking does not belong to this guest." };
    }
  }

  const payload: StaffFollowUpPayload = {
    message,
    ...(params.createdByEmail ? { createdByEmail: params.createdByEmail } : {}),
    ...(params.createdByStaffId ? { createdByStaffId: params.createdByStaffId } : {})
  };

  const dedupeKey = `staff:${params.hotelId}:${params.guestId}:${crypto.randomUUID()}`;

  try {
    const row = await prisma.guestFollowUp.create({
      data: {
        hotelId: params.hotelId,
        propertyId: params.propertyId ?? null,
        guestId: params.guestId,
        bookingId: params.bookingId ?? null,
        conversationId: params.conversationId ?? null,
        type: STAFF_SCHEDULED_FOLLOWUP_TYPE,
        dedupeKey,
        scheduledFor: params.scheduledFor,
        payloadJson: JSON.stringify(payload)
      },
      select: { id: true }
    });
    return { ok: true, followUpId: row.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "Could not schedule — duplicate entry. Try again." };
    }
    throw err;
  }
}
