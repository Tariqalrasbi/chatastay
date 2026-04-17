import { type Response, Router } from "express";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "../core/partnerSetup";

export const publicHotelRouter = Router();

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function badgeForScore(avg: number, count: number): string {
  if (count >= 20 && avg >= 4.6) return "Top Performer";
  if (count >= 10 && avg >= 4.2) return "Guest Favorite";
  if (avg >= 3.8) return "Strong Rating";
  return "Improving";
}

function insightText(avg: number, total: number, lowMixPct: number, topIssue: string | null): string {
  if (total === 0) return "New rating profile: this property is collecting guest feedback.";
  if (avg >= 4.4 && lowMixPct < 15) return "Your rating is strong and guest satisfaction is consistently high.";
  if (topIssue && lowMixPct >= 20) {
    return `Your rating is stable, but ${lowMixPct.toFixed(
      0
    )}% of lower ratings mention ${topIssue.toLowerCase()}. Improving this area could lift your overall score.`;
  }
  if (avg < 3.8) return "Recent ratings show service recovery opportunities. Focus on low-rated categories first.";
  return "Guest sentiment is healthy. Continue consistency and encourage happy guests to leave public reviews.";
}

async function renderPublicHotelRatingPage(res: Response, hotelId: string, showAll: boolean): Promise<void> {
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    select: { id: true, slug: true, displayName: true, city: true, country: true, isActive: true }
  });
  if (!hotel || !hotel.isActive) {
    res.status(404).type("html").send("<h1>Hotel not found</h1>");
    return;
  }

  const [aggAll, recent, byCategory, lowCount] = await Promise.all([
    prisma.guestFeedback.aggregate({
      where: { hotelId: hotel.id },
      _avg: { rating: true },
      _count: { _all: true }
    }),
    prisma.guestFeedback.findMany({
      where: {
        hotelId: hotel.id,
        ...(showAll ? {} : { rating: { gte: 3 } })
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { rating: true, category: true, comment: true, createdAt: true }
    }),
    prisma.guestFeedback.groupBy({
      by: ["category"],
      where: { hotelId: hotel.id, category: { not: null } },
      _count: { _all: true }
    }),
    prisma.guestFeedback.count({ where: { hotelId: hotel.id, rating: { lte: 2 } } })
  ]);

  const avg = Number((aggAll._avg.rating ?? 0).toFixed(2));
  const total = aggAll._count._all;
  const cfg = loadPartnerSetupConfig(hotel.id);
  const lowMixPct = total > 0 ? (lowCount / total) * 100 : 0;
  const topIssueRaw = byCategory.sort((a, b) => b._count._all - a._count._all)[0]?.category ?? null;
  const topIssue = topIssueRaw ? String(topIssueRaw).replaceAll("_", " ") : null;
  const insight = insightText(avg, total, lowMixPct, topIssue);
  const badge = badgeForScore(avg, total);

  const rows = recent
    .map(
      (r) => `<article class="review">
      <div class="review-head">
        <strong>${"⭐".repeat(Math.max(1, Math.min(5, r.rating)))}</strong>
        <span class="muted">${fmtDate(r.createdAt)}</span>
      </div>
      <div class="muted" style="font-size:12px">${escapeHtml(r.category ? String(r.category).replaceAll("_", " ") : "General")}</div>
      <p>${escapeHtml((r.comment ?? "Guest shared a rating without a comment.").slice(0, 320))}</p>
    </article>`
    )
    .join("");

  const categoryRows = byCategory
    .map((c) => `<li>${escapeHtml(String(c.category).replaceAll("_", " "))}: ${c._count._all}</li>`)
    .join("");

  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(hotel.displayName)} Rating & Reviews</title>
  <meta name="description" content="${escapeHtml(
    `${hotel.displayName} ${hotel.city ?? ""} ${hotel.country ?? ""} guest rating ${avg > 0 ? avg.toFixed(1) : "N/A"} stars`
  )}" />
  <style>
    body{font-family:Inter,Arial,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
    .wrap{max-width:860px;margin:0 auto;padding:18px}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:14px}
    .muted{color:#64748b}
    .badge{display:inline-block;padding:4px 10px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:700;font-size:12px}
    .btn{display:inline-block;padding:9px 12px;border-radius:8px;background:#075e54;color:#fff;text-decoration:none;font-weight:700}
    .review{border-top:1px solid #e2e8f0;padding-top:10px;margin-top:10px}
    .review:first-child{border-top:0;margin-top:0;padding-top:0}
    .review-head{display:flex;justify-content:space-between;gap:10px}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1 style="margin:0 0 6px">${escapeHtml(hotel.displayName)}</h1>
      <p class="muted" style="margin:0">${escapeHtml([hotel.city, hotel.country].filter(Boolean).join(", ") || "Location")}</p>
      <p style="margin:10px 0 6px"><strong>${total ? `${avg.toFixed(1)} ⭐` : "No ratings yet"}</strong> · ${total} review${
    total === 1 ? "" : "s"
  }</p>
      <span class="badge">${escapeHtml(badge)}</span>
      ${
        cfg.googleReviewLink
          ? `<div style="margin-top:12px"><a class="btn" href="${escapeHtml(cfg.googleReviewLink)}" rel="noopener noreferrer" target="_blank">Leave a Google Review</a></div>`
          : ""
      }
    </section>
    <section class="card">
      <h2 style="margin-top:0;font-size:18px">Performance Insight</h2>
      <p>${escapeHtml(insight)}</p>
      <p class="muted" style="font-size:13px;margin-bottom:0">Low-rating mix: ${lowMixPct.toFixed(1)}% · Positive share: ${
    total ? (((total - lowCount) / total) * 100).toFixed(1) : "0.0"
  }%</p>
    </section>
    <section class="card">
      <h2 style="margin-top:0;font-size:18px">Rating Categories</h2>
      <ul>${categoryRows || "<li class='muted'>No category data yet.</li>"}</ul>
    </section>
    <section class="card">
      <h2 style="margin-top:0;font-size:18px">Recent Reviews</h2>
      ${rows || "<p class='muted'>No reviews available yet.</p>"}
      ${
        showAll
          ? `<p class="muted" style="font-size:12px">Showing all ratings.</p>`
          : `<p class="muted" style="font-size:12px">Showing ratings 3⭐ and above by default. <a href="/hotel/${encodeURIComponent(
              hotel.slug
            )}?all=1">Show all</a></p>`
      }
    </section>
  </main>
</body>
</html>`;
  res.type("html").send(page);
}

publicHotelRouter.get("/hotel/:slug", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  const showAll = String(req.query.all ?? "") === "1";
  const hotel = await prisma.hotel.findUnique({ where: { slug }, select: { id: true } });
  if (!hotel) {
    res.status(404).type("html").send("<h1>Hotel not found</h1>");
    return;
  }
  await renderPublicHotelRatingPage(res, hotel.id, showAll);
});

publicHotelRouter.get("/public/hotel/:hotelId", async (req, res) => {
  const hotelId = String(req.params.hotelId ?? "").trim();
  const showAll = String(req.query.all ?? "") === "1";
  await renderPublicHotelRatingPage(res, hotelId, showAll);
});

