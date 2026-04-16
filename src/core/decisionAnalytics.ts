import { BookingStatus } from "@prisma/client";
import { prisma } from "../db";

export type DecisionEventType =
  | "booking_started"
  | "booking_completed"
  | "booking_abandoned"
  | "early_checkin_requested"
  | "late_checkout_requested"
  | "special_request"
  | "payment_issue"
  | "payment_completed"
  | "complaint"
  | "escalation"
  | "upsell_shown"
  | "upsell_accepted"
  | "upsell_ignored"
  | "followup_sent"
  | "followup_converted"
  | "returning_guest"
  | "repeat_booking"
  | "lead_contacted"
  | "lead_responded"
  | "lead_converted";

type TrackParams = {
  hotelId: string;
  propertyId?: string | null;
  eventType: DecisionEventType;
  guestId?: string | null;
  bookingId?: string | null;
  conversationId?: string | null;
  source?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
};

export async function trackDecisionEvent(params: TrackParams): Promise<void> {
  const entityId = params.dedupeKey ?? `${params.eventType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  if (params.dedupeKey) {
    const existing = await prisma.auditLog.findFirst({
      where: {
        hotelId: params.hotelId,
        action: "DECISION_EVENT",
        entityType: "ANALYTICS_EVENT",
        entityId
      },
      select: { id: true }
    });
    if (existing) return;
  }
  await prisma.auditLog.create({
    data: {
      hotelId: params.hotelId,
      propertyId: params.propertyId ?? null,
      action: "DECISION_EVENT",
      entityType: "ANALYTICS_EVENT",
      entityId,
      bookingId: params.bookingId ?? null,
      metadataJson: JSON.stringify({
        eventType: params.eventType,
        guestId: params.guestId ?? null,
        conversationId: params.conversationId ?? null,
        source: params.source ?? null,
        createdAt: new Date().toISOString(),
        ...(params.metadata ?? {})
      })
    }
  });
}

export async function trackDecisionEventSafe(params: TrackParams): Promise<void> {
  await trackDecisionEvent(params).catch(() => undefined);
}

function pct(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.round((num / den) * 10000) / 100;
}

function toDateFloor(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export async function loadDecisionAnalyticsSummary(params: {
  hotelId: string;
  propertyId?: string;
  days?: number;
}): Promise<{
  rangeDays: number;
  events: Record<string, number>;
  metrics: {
    bookingConversionRatePct: number;
    abandonmentRatePct: number;
    upsellAcceptanceRatePct: number;
    highValueGuestRatioPct: number;
    complaintFrequencyPct: number;
    followupConversionRatePct: number;
    repeatGuestRatePct: number;
  };
  insights: string[];
}> {
  const days = Math.max(1, Math.min(params.days ?? 30, 180));
  const start = toDateFloor(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

  const rows = await prisma.auditLog.findMany({
    where: {
      hotelId: params.hotelId,
      ...(params.propertyId ? { propertyId: params.propertyId } : {}),
      action: "DECISION_EVENT",
      createdAt: { gte: start }
    },
    select: { metadataJson: true }
  });
  const events: Record<string, number> = {};
  for (const r of rows) {
    if (!r.metadataJson) continue;
    try {
      const m = JSON.parse(r.metadataJson) as Record<string, unknown>;
      const t = typeof m.eventType === "string" ? m.eventType : "";
      if (!t) continue;
      events[t] = (events[t] ?? 0) + 1;
    } catch {
      // ignore invalid json
    }
  }

  const started = events.booking_started ?? 0;
  const completed = events.booking_completed ?? 0;
  const abandoned = events.booking_abandoned ?? 0;
  const upsellAccepted = events.upsell_accepted ?? 0;
  const upsellIgnored = events.upsell_ignored ?? 0;
  const upsellShown = events.upsell_shown ?? 0;
  const followupSent = events.followup_sent ?? 0;
  const followupConverted = events.followup_converted ?? 0;
  const complaints = (events.complaint ?? 0) + (events.escalation ?? 0);
  const returning = events.returning_guest ?? 0;

  const highValueConfirmed = await prisma.booking.count({
    where: {
      hotelId: params.hotelId,
      status: BookingStatus.CONFIRMED,
      totalAmount: { gte: 220 },
      createdAt: { gte: start }
    }
  });
  const totalConfirmed = await prisma.booking.count({
    where: {
      hotelId: params.hotelId,
      status: BookingStatus.CONFIRMED,
      createdAt: { gte: start }
    }
  });

  const bookingConversionRatePct = pct(completed, started);
  const abandonmentRatePct = pct(abandoned, started);
  const upsellAcceptanceRatePct = pct(upsellAccepted, Math.max(upsellShown, upsellAccepted + upsellIgnored));
  const highValueGuestRatioPct = pct(highValueConfirmed, totalConfirmed);
  const complaintFrequencyPct = pct(complaints, Math.max(1, completed));
  const followupConversionRatePct = pct(followupConverted, followupSent);
  const repeatGuestRatePct = pct(returning, Math.max(1, completed));

  const insights: string[] = [];
  if (abandonmentRatePct >= 35 && started >= 10) {
    insights.push("High abandonment detected after booking start. Review quote-to-confirmation friction.");
  }
  if (upsellAcceptanceRatePct >= 25 && upsellShown >= 10) {
    insights.push("Upsell acceptance is strong. Pre-arrival and high-value timing appears effective.");
  } else if (upsellAcceptanceRatePct > 0 && upsellAcceptanceRatePct < 10 && upsellShown >= 10) {
    insights.push("Upsell acceptance is low. Consider gentler phrasing and tighter timing windows.");
  }
  if (repeatGuestRatePct >= 30 && completed >= 10) {
    insights.push("Repeat-guest share is healthy. Retention messaging and personalization are performing well.");
  }
  if (complaintFrequencyPct >= 12 && completed >= 10) {
    insights.push("Complaint frequency is elevated. Prioritize support-resolution SLA and proactive service checks.");
  }
  if (followupSent >= 10 && followupConversionRatePct >= 15) {
    insights.push("Follow-up campaigns are converting. Continue abandoned-booking and pending-request recovery.");
  }

  return {
    rangeDays: days,
    events,
    metrics: {
      bookingConversionRatePct,
      abandonmentRatePct,
      upsellAcceptanceRatePct,
      highValueGuestRatioPct,
      complaintFrequencyPct,
      followupConversionRatePct,
      repeatGuestRatePct
    },
    insights
  };
}

export async function loadDecisionAnalyticsCrossPropertySummary(params: {
  hotelId: string;
  days?: number;
}): Promise<{
  aggregate: Awaited<ReturnType<typeof loadDecisionAnalyticsSummary>>;
  perProperty: Array<{
    propertyId: string;
    propertyName: string;
    propertyCity: string | null;
    summary: Awaited<ReturnType<typeof loadDecisionAnalyticsSummary>>;
    revenue: number;
    commission: number;
    bookingsTotal: number;
    confirmedBookings: number;
    avgBookingValue: number;
  }>;
  totals: {
    revenue: number;
    commission: number;
    bookingsTotal: number;
    confirmedBookings: number;
    avgBookingValue: number;
  };
}> {
  const days = Math.max(1, Math.min(params.days ?? 30, 180));
  const start = toDateFloor(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  const aggregate = await loadDecisionAnalyticsSummary({ hotelId: params.hotelId, days });
  const properties = await prisma.property.findMany({
    where: { hotelId: params.hotelId },
    select: { id: true, name: true, city: true },
    orderBy: { createdAt: "asc" }
  });
  const perProperty = await Promise.all(
    properties.map(async (property) => {
      const summary = await loadDecisionAnalyticsSummary({
        hotelId: params.hotelId,
        propertyId: property.id,
        days
      });
      const bookingAgg = await prisma.booking.aggregate({
        where: {
          hotelId: params.hotelId,
          propertyId: property.id,
          createdAt: { gte: start }
        },
        _sum: { totalAmount: true },
        _avg: { totalAmount: true }
      });
      const bookingsTotal = await prisma.booking.count({
        where: {
          hotelId: params.hotelId,
          propertyId: property.id,
          createdAt: { gte: start }
        }
      });
      const confirmedBookings = await prisma.booking.count({
        where: {
          hotelId: params.hotelId,
          propertyId: property.id,
          status: BookingStatus.CONFIRMED,
          createdAt: { gte: start }
        }
      });
      return {
        propertyId: property.id,
        propertyName: property.name,
        propertyCity: property.city ?? null,
        summary,
        revenue: bookingAgg._sum?.totalAmount ?? 0,
        // Dedicated commission field is not persisted yet; keep placeholder for owner dashboard consistency.
        commission: 0,
        bookingsTotal,
        confirmedBookings,
        avgBookingValue: Math.round(((bookingAgg._avg?.totalAmount ?? 0) as number) * 100) / 100
      };
    })
  );
  const totals = perProperty.reduce(
    (acc, p) => {
      acc.revenue += p.revenue;
      acc.commission += p.commission;
      acc.bookingsTotal += p.bookingsTotal;
      acc.confirmedBookings += p.confirmedBookings;
      return acc;
    },
    { revenue: 0, commission: 0, bookingsTotal: 0, confirmedBookings: 0, avgBookingValue: 0 }
  );
  totals.avgBookingValue = totals.bookingsTotal > 0 ? Math.round((totals.revenue / totals.bookingsTotal) * 100) / 100 : 0;
  return { aggregate, perProperty, totals };
}
