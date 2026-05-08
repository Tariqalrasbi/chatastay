/**
 * Guest feedback / reviews dashboard data layer.
 *
 * Reads `GuestFeedback` rows (created by the WhatsApp post-stay flow and the
 * /guest/review web page) and turns them into the shapes a manager wants to
 * see at a glance:
 *   - Headline KPIs (avg rating, response count, low-score count, unresolved
 *     complaints)
 *   - Star-distribution histogram
 *   - Category breakdown (Cleanliness / Room comfort / Service / etc.)
 *   - Trend strip: this week vs last week
 *   - Open complaints (low rating without a manager follow-up close)
 *   - Latest comments (with a happy/issue badge)
 */

import { PrismaClient, type GuestFeedback, type GuestFeedbackCategory } from "@prisma/client";

export interface FeedbackKpis {
  totalResponses: number;
  averageRating: number;
  lowRatings: number;
  unresolvedComplaints: number;
  promoters: number;
  publicReviewClicks: number;
}

export interface FeedbackHistogramRow {
  rating: number;
  count: number;
  percent: number;
}

export interface FeedbackCategoryRow {
  category: string;
  label: string;
  count: number;
  averageRating: number;
}

export interface FeedbackTrendRow {
  label: string;
  averageRating: number;
  responseCount: number;
}

export interface FeedbackComplaintRow {
  feedbackId: string;
  bookingId: string;
  guestName: string;
  rating: number;
  category: string | null;
  comment: string | null;
  createdAt: Date;
  followUpRequested: boolean;
  ageHours: number;
}

export interface FeedbackCommentRow {
  feedbackId: string;
  bookingId: string;
  guestName: string;
  rating: number;
  category: string | null;
  comment: string;
  createdAt: Date;
  badge: "happy" | "issue" | "neutral";
}

export interface FeedbackDashboardData {
  asOf: Date;
  windowDays: number;
  kpis: FeedbackKpis;
  histogram: FeedbackHistogramRow[];
  categories: FeedbackCategoryRow[];
  thisWeek: FeedbackTrendRow;
  lastWeek: FeedbackTrendRow;
  openComplaints: FeedbackComplaintRow[];
  recentComments: FeedbackCommentRow[];
}

const CATEGORY_LABEL: Record<string, string> = {
  CLEANLINESS: "Cleanliness",
  ROOM_COMFORT: "Room comfort",
  SERVICE: "Service",
  FOOD_BEVERAGE: "Food & drink",
  FACILITIES: "Facilities",
  OTHER: "Other"
};

function buildHistogram(rows: GuestFeedback[]): FeedbackHistogramRow[] {
  const counts = [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: 0, percent: 0 }));
  for (const f of rows) {
    if (f.rating >= 1 && f.rating <= 5) {
      counts[f.rating - 1].count += 1;
    }
  }
  const total = counts.reduce((s, r) => s + r.count, 0) || 1;
  for (const row of counts) {
    row.percent = Math.round((row.count / total) * 100);
  }
  return counts.reverse();
}

function buildCategories(rows: GuestFeedback[]): FeedbackCategoryRow[] {
  const buckets = new Map<string, { count: number; sum: number }>();
  for (const f of rows) {
    const key = (f.category as string | null) ?? "OTHER";
    const b = buckets.get(key) ?? { count: 0, sum: 0 };
    b.count += 1;
    b.sum += f.rating;
    buckets.set(key, b);
  }
  return Array.from(buckets.entries())
    .map<FeedbackCategoryRow>(([key, value]) => ({
      category: key,
      label: CATEGORY_LABEL[key] ?? key,
      count: value.count,
      averageRating: value.count ? value.sum / value.count : 0
    }))
    .sort((a, b) => b.count - a.count);
}

function trendForWindow(rows: GuestFeedback[], from: Date, to: Date, label: string): FeedbackTrendRow {
  const inWindow = rows.filter((f) => f.createdAt >= from && f.createdAt < to);
  const sum = inWindow.reduce((s, f) => s + f.rating, 0);
  return {
    label,
    averageRating: inWindow.length ? sum / inWindow.length : 0,
    responseCount: inWindow.length
  };
}

function pickBadge(f: GuestFeedback): "happy" | "issue" | "neutral" {
  if (f.rating <= 2 || f.isIssueCase) return "issue";
  if (f.rating >= 4 || f.isHappyGuest || f.isPromoter) return "happy";
  return "neutral";
}

export async function loadFeedbackDashboard(
  prisma: PrismaClient,
  hotelId: string,
  asOf: Date = new Date(),
  windowDays = 90
): Promise<FeedbackDashboardData> {
  const windowStart = new Date(asOf.getTime() - windowDays * 24 * 3600 * 1000);
  const lastWeekEnd = new Date(asOf.getTime() - 7 * 24 * 3600 * 1000);
  const lastWeekStart = new Date(asOf.getTime() - 14 * 24 * 3600 * 1000);
  const thisWeekStart = new Date(asOf.getTime() - 7 * 24 * 3600 * 1000);

  const rows = await prisma.guestFeedback.findMany({
    where: { hotelId, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "desc" }
  });

  const totalResponses = rows.length;
  const ratingSum = rows.reduce((s, f) => s + f.rating, 0);
  const averageRating = totalResponses ? ratingSum / totalResponses : 0;
  const lowRatings = rows.filter((f) => f.rating <= 2).length;
  const unresolvedComplaints = rows.filter(
    (f) => (f.rating <= 2 || f.managerFollowUpRequestedAt) && !f.managerFollowUpClosedAt
  ).length;
  const promoters = rows.filter((f) => f.isPromoter || f.rating === 5).length;
  const publicReviewClicks = rows.filter((f) => f.publicReviewClickedAt).length;

  const openComplaints: FeedbackComplaintRow[] = rows
    .filter((f) => (f.rating <= 2 || f.managerFollowUpRequestedAt) && !f.managerFollowUpClosedAt)
    .map((f) => ({
      feedbackId: f.id,
      bookingId: f.bookingId,
      guestName: f.guestName ?? "Guest",
      rating: f.rating,
      category: (f.category as GuestFeedbackCategory | null) ? CATEGORY_LABEL[f.category as string] ?? null : null,
      comment: f.comment ?? null,
      createdAt: f.createdAt,
      followUpRequested: Boolean(f.managerFollowUpRequestedAt),
      ageHours: Math.max(0, Math.round((asOf.getTime() - f.createdAt.getTime()) / 3600000))
    }))
    .slice(0, 30);

  const recentComments: FeedbackCommentRow[] = rows
    .filter((f) => Boolean(f.comment && f.comment.trim().length))
    .slice(0, 12)
    .map((f) => ({
      feedbackId: f.id,
      bookingId: f.bookingId,
      guestName: f.guestName ?? "Guest",
      rating: f.rating,
      category: (f.category as GuestFeedbackCategory | null) ? CATEGORY_LABEL[f.category as string] ?? null : null,
      comment: f.comment ?? "",
      createdAt: f.createdAt,
      badge: pickBadge(f)
    }));

  return {
    asOf,
    windowDays,
    kpis: {
      totalResponses,
      averageRating,
      lowRatings,
      unresolvedComplaints,
      promoters,
      publicReviewClicks
    },
    histogram: buildHistogram(rows),
    categories: buildCategories(rows),
    thisWeek: trendForWindow(rows, thisWeekStart, asOf, "This week"),
    lastWeek: trendForWindow(rows, lastWeekStart, lastWeekEnd, "Last week"),
    openComplaints,
    recentComments
  };
}
