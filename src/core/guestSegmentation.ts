import { BookingStatus, ChannelProvider, SegmentTagKind, SegmentTagSource } from "@prisma/client";
import { prisma } from "../db";

/** Human-readable labels for admin UI and future messaging. */
export const SEGMENT_TAG_LABELS: Record<SegmentTagKind, string> = {
  REPEAT_GUEST: "Repeat guest",
  FAMILY: "Family",
  CORPORATE: "Corporate",
  LONG_STAY: "Long stay",
  HIGH_SPENDER: "High spender",
  OTA_GUEST: "OTA guest",
  DIRECT_GUEST: "Direct guest",
  WHATSAPP_GUEST: "WhatsApp guest",
  WALK_IN: "Walk-in",
  PHONE_BOOKING: "Phone booking",
  REFERRAL: "Referral",
  OTHER: "Other"
};

const OTA_SOURCES: ChannelProvider[] = [
  ChannelProvider.BOOKING_COM,
  ChannelProvider.AIRBNB,
  ChannelProvider.EXPEDIA
];

function envNumber(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function collectAutoTags(params: {
  bookings: Array<{
    status: BookingStatus;
    source: ChannelProvider;
    conversationId: string | null;
    nights: number;
    children: number;
    totalAmount: number;
    checkOut: Date;
  }>;
  now: Date;
}): SegmentTagKind[] {
  const { bookings, now } = params;
  const confirmed = bookings.filter((b) => b.status === BookingStatus.CONFIRMED);
  const completedOrPast = confirmed.filter((b) => b.checkOut.getTime() <= now.getTime());
  const out: Set<SegmentTagKind> = new Set();

  if (completedOrPast.length >= 2) {
    out.add(SegmentTagKind.REPEAT_GUEST);
  }

  if (confirmed.some((b) => b.children > 0)) {
    out.add(SegmentTagKind.FAMILY);
  }

  const minLong = envNumber("GUEST_LONG_STAY_MIN_NIGHTS", 7);
  if (confirmed.some((b) => b.nights >= minLong)) {
    out.add(SegmentTagKind.LONG_STAY);
  }

  const minSpend = envNumber("GUEST_HIGH_SPENDER_MIN_TOTAL", 500);
  const totalSpend = confirmed.reduce((s, b) => s + b.totalAmount, 0);
  if (totalSpend >= minSpend) {
    out.add(SegmentTagKind.HIGH_SPENDER);
  }

  if (confirmed.some((b) => OTA_SOURCES.includes(b.source))) {
    out.add(SegmentTagKind.OTA_GUEST);
  }

  if (confirmed.some((b) => b.source === ChannelProvider.WHATSAPP)) {
    out.add(SegmentTagKind.WHATSAPP_GUEST);
  }

  if (confirmed.some((b) => b.source === ChannelProvider.DIRECT)) {
    out.add(SegmentTagKind.DIRECT_GUEST);
  }

  if (confirmed.some((b) => b.source === ChannelProvider.PHONE)) {
    out.add(SegmentTagKind.PHONE_BOOKING);
  }

  if (confirmed.some((b) => b.source === ChannelProvider.CORPORATE)) {
    out.add(SegmentTagKind.CORPORATE);
  }

  if (confirmed.some((b) => b.source === ChannelProvider.REFERRAL)) {
    out.add(SegmentTagKind.REFERRAL);
  }

  // Walk-in / desk: direct channel without linked conversation (common for front-desk bookings).
  if (confirmed.some((b) => b.source === ChannelProvider.DIRECT && !b.conversationId)) {
    out.add(SegmentTagKind.WALK_IN);
  }

  return Array.from(out);
}

/**
 * Recomputes AUTO segment tags from booking history. MANUAL tags are preserved unless they duplicate an AUTO intent
 * (same guestId+tag unique — manual row blocks auto re-insert for that tag).
 */
export async function refreshGuestSegmentTagsForGuest(guestId: string): Promise<void> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { id: true, hotelId: true }
  });
  if (!guest) return;

  const bookings = await prisma.booking.findMany({
    where: { guestId },
    select: {
      status: true,
      source: true,
      conversationId: true,
      nights: true,
      children: true,
      totalAmount: true,
      checkOut: true
    }
  });

  const now = new Date();
  const autoTags = collectAutoTags({ bookings, now });

  await prisma.$transaction(async (tx) => {
    await tx.guestSegmentTag.deleteMany({
      where: { guestId, source: SegmentTagSource.AUTO }
    });

    for (const tag of autoTags) {
      const existing = await tx.guestSegmentTag.findUnique({
        where: { guestId_tag: { guestId, tag } }
      });
      if (existing) continue;
      await tx.guestSegmentTag.create({
        data: { guestId, tag, source: SegmentTagSource.AUTO }
      });
    }
  });
}

export function segmentTagPillClass(kind: SegmentTagKind): string {
  switch (kind) {
    case SegmentTagKind.CORPORATE:
    case SegmentTagKind.OTA_GUEST:
      return "badge pending";
    case SegmentTagKind.HIGH_SPENDER:
    case SegmentTagKind.REPEAT_GUEST:
      return "badge ok";
    case SegmentTagKind.WHATSAPP_GUEST:
      return "badge ok";
    default:
      return "badge";
  }
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Compact HTML for admin booking/conversation headers: VIP strip + tag pills.
 * Uses existing admin `.badge` classes from layout.
 */
export function formatGuestVipAndTagsHtml(params: {
  guestId: string;
  isVip: boolean;
  vipNote: string | null;
  tags: Array<{ tag: SegmentTagKind; source: SegmentTagSource }>;
  profileHref?: string;
  /** When false, omit the "Guest profile" link (e.g. on the profile page itself). */
  showProfileLink?: boolean;
}): string {
  const showLink = params.showProfileLink !== false;
  const profile =
    params.profileHref ??
    `/admin/guests/${encodeURIComponent(params.guestId)}`;
  const vipBlock = params.isVip
    ? `<span class="badge" style="background:linear-gradient(135deg,#d97706,#b45309);color:#fff;border:0;font-weight:700">VIP</span>${
        params.vipNote?.trim()
          ? ` <span class="muted" style="font-size:12px" title="${escAttr(params.vipNote.trim())}">${escAttr(params.vipNote.trim().slice(0, 64))}${params.vipNote.trim().length > 64 ? "…" : ""}</span>`
          : ""
      }`
    : "";
  const sorted = [...params.tags].sort((a, b) => a.tag.localeCompare(b.tag));
  const pills = sorted.map((t) => {
    const label = SEGMENT_TAG_LABELS[t.tag];
    const src =
      t.source === SegmentTagSource.AUTO
        ? '<span class="muted" style="font-size:10px;margin-left:4px">auto</span>'
        : '<span class="muted" style="font-size:10px;margin-left:4px">manual</span>';
    return `<span class="${segmentTagPillClass(t.tag)}" style="margin:2px 4px 2px 0;display:inline-flex;align-items:center">${escAttr(label)}${src}</span>`;
  });
  const link = showLink
    ? `<a class="inline-link" style="font-size:12px;margin-left:6px" href="${escAttr(profile)}">Guest profile</a>`
    : "";
  const inner = [vipBlock, ...pills].filter(Boolean).join(" ");
  if (!inner) return `<span class="muted">No segment tags yet.</span>${link ? ` ${link}` : ""}`;
  return `${inner}${link ? ` ${link}` : ""}`;
}
