import { SegmentTagKind } from "@prisma/client";
import { MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import type { LightGuestMemory } from "./lightGuestMemory";
import {
  getSafeSendTime,
  hotelTimezoneOrUtc,
  readWallClockInZone,
  wallClockLocalToUtc,
  type GuestJourneySendWindowReason
} from "./guestMessagingSchedule";

export type GuestMessageSegment = "VIP" | "FAMILY" | "BUSINESS" | "UNKNOWN";

export type LifecycleJourneyKind =
  | "POST_CHECKOUT_THANK_YOU"
  | "REVIEW_REQUEST"
  | "REVIEW_REMINDER"
  | "REPEAT_GUEST_PROMO"
  | "POST_STAY_FOLLOWUP"
  | "RE_ENGAGEMENT";

export function segmentPreferredLocalHM(segment: GuestMessageSegment): { hour: number; minute: number } {
  switch (segment) {
    case "VIP":
      return { hour: 11, minute: 0 };
    case "FAMILY":
      return { hour: 10, minute: 30 };
    case "BUSINESS":
      return { hour: 9, minute: 0 };
    default:
      return { hour: 10, minute: 0 };
  }
}

function isWeekdayUtc(d: Date): boolean {
  const w = d.getUTCDay();
  return w >= 1 && w <= 5;
}

export function inferGuestMessageSegment(params: {
  isVip: boolean;
  segmentTags: SegmentTagKind[];
  children: number;
  adults: number;
  nights: number;
  checkIn: Date;
  memory?: Pick<LightGuestMemory, "repeatGuest" | "spendingLevel"> | null;
}): GuestMessageSegment {
  const tags = new Set(params.segmentTags);
  const spendHigh = params.memory?.spendingLevel === "high";
  if (params.isVip || tags.has(SegmentTagKind.HIGH_SPENDER) || spendHigh) {
    return "VIP";
  }
  if (tags.has(SegmentTagKind.FAMILY) || params.children > 0) {
    return "FAMILY";
  }
  if (
    tags.has(SegmentTagKind.CORPORATE) ||
    (params.adults === 1 && params.children === 0 && params.nights <= 3 && isWeekdayUtc(params.checkIn))
  ) {
    return "BUSINESS";
  }
  return "UNKNOWN";
}

/**
 * Quiet-hours safe send, then snap to segment-preferred local time on that hotel day (never before policy floor).
 */
export function getLifecycleSendWindow(
  desiredSendUtc: Date,
  timeZone: string,
  segment: GuestMessageSegment
): {
  originalUtc: Date;
  adjustedUtc: Date;
  reason: GuestJourneySendWindowReason;
  segment: GuestMessageSegment;
} {
  const q = getSafeSendTime(desiredSendUtc, timeZone);
  const tz = hotelTimezoneOrUtc(timeZone);
  const pref = segmentPreferredLocalHM(segment);
  const hmStr = `${String(pref.hour).padStart(2, "0")}:${String(pref.minute).padStart(2, "0")}`;
  const { ymd } = readWallClockInZone(q.adjustedUtc, tz);
  const slotUtc = wallClockLocalToUtc(ymd, hmStr, tz);
  if (Number.isNaN(slotUtc.getTime())) {
    return { originalUtc: q.originalUtc, adjustedUtc: q.adjustedUtc, reason: q.reason, segment };
  }
  const floorMs = Math.max(q.adjustedUtc.getTime(), desiredSendUtc.getTime());
  const candidateMs = Math.max(slotUtc.getTime(), floorMs);
  const tightened = getSafeSendTime(new Date(candidateMs), timeZone);
  const reason =
    tightened.reason !== "none"
      ? tightened.reason
      : q.reason !== "none"
        ? q.reason
        : "none";
  return {
    originalUtc: q.originalUtc,
    adjustedUtc: tightened.adjustedUtc,
    reason,
    segment
  };
}

export function evaluateLifecycleMarketingEligibility(
  kind: LifecycleJourneyKind,
  prefs: { messagingDoNotDisturb?: boolean; messagingMarketingOptOut?: boolean }
): { send: boolean; reason: string } {
  const dnd = Boolean(prefs.messagingDoNotDisturb);
  const optOut = Boolean(prefs.messagingMarketingOptOut);
  if (dnd) {
    return { send: false, reason: "do_not_disturb" };
  }
  if (optOut && (kind === "REPEAT_GUEST_PROMO" || kind === "RE_ENGAGEMENT")) {
    return { send: false, reason: "marketing_opt_out" };
  }
  return { send: true, reason: "allowed" };
}

export function logLifecycleScheduleDecision(payload: Record<string, unknown>): void {
  console.info("[guest-lifecycle-schedule]", JSON.stringify(payload));
}

export async function hasRecentOutboundJourneyIntents(params: {
  hotelId: string;
  guestId: string;
  intents: string[];
  sinceMs: number;
}): Promise<boolean> {
  if (params.intents.length === 0) return false;
  const since = new Date(Date.now() - params.sinceMs);
  const row = await prisma.message.findFirst({
    where: {
      hotelId: params.hotelId,
      direction: MessageDirection.OUTBOUND,
      aiIntent: { in: params.intents },
      createdAt: { gte: since },
      conversation: { guestId: params.guestId }
    },
    select: { id: true }
  });
  return Boolean(row);
}
