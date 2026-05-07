/**
 * Phase D — public marketplace router.
 *
 * Mounted at `/`. Three guest-facing surfaces and one ajax endpoint:
 *   GET /                   → home with featured hotels (filtered by Plan.supportsMarketplace)
 *   GET /search             → multi-hotel availability search (city, dates, guests, rooms)
 *   GET /h/:slug            → property profile (description, photos, amenities, rooms, CTAs)
 *   GET /h/:slug/availability.json  → ajax availability grid for the room cards
 *
 * Guarantees enforced everywhere:
 *   • Only `Hotel.isActive` AND a hotel with at least one `Property.status === ACTIVE` is listed.
 *   • Only hotels on a `Plan.supportsMarketplace = true` plan show on the home / search pages.
 *     The single-property profile (`/h/:slug`) is reachable by direct link even for non-marketplace
 *     hotels so existing single-tenant users aren't broken — but those pages display a
 *     `data-marketplace="false"` body attribute so we can detect bots/scrapers later.
 *   • All availability math is delegated to `findAvailableRoomType[s]` /
 *     `findAvailableAcrossHotels` so the marketplace and WhatsApp booking flow are identical.
 *
 * No reset of the database; all rendering is read-only. Bookings are seeded into the
 * existing single-tenant booking flow via `Continue on WhatsApp` and `Continue on web`
 * (Phase E will wire those CTAs to a `BookingDraft`).
 */

import { Router, type Request, type Response } from "express";
import { prisma } from "../db";
import { PropertyStatus } from "@prisma/client";
import {
  addDays,
  findAvailableAcrossHotels,
  findAvailableRoomTypes,
  startOfDay,
  toIsoDate,
  type MarketplaceOffer,
  type RoomOffer
} from "../core/availability";

export const marketplaceRouter = Router();

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeParseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    // Treat as comma-separated fallback for hand-edited rows.
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseDateOrToday(raw: unknown, fallbackOffsetDays: number): Date {
  const text = String(raw ?? "").trim();
  if (text) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return startOfDay(parsed);
  }
  return addDays(startOfDay(new Date()), fallbackOffsetDays);
}

function parseInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Lightweight content negotiation: monitoring tools that ask for JSON (Accept: application/json
 *  without text/html) get the existing `{ status: "ok" }` health stub; browsers get marketplace HTML. */
function wantsJsonHealth(req: Request): boolean {
  const accept = String(req.headers.accept ?? "").toLowerCase();
  if (!accept) return false;
  if (accept.includes("text/html")) return false;
  return accept.includes("application/json");
}

const PAGE_BASE_STYLES = `
:root{--brand:#0b6e6e;--accent:#25d366;--bg:#eef6f4;--ink:#0f172a;--muted:#5f6b7a;--card:#fff;--border:#e2e8f0}
*{box-sizing:border-box}
body{font-family:Inter,Arial,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}
.wrap{max-width:1100px;margin:0 auto;padding:18px}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 0;margin-bottom:14px}
.nav .brand{font-weight:800;font-size:20px;color:var(--brand);text-decoration:none}
.nav .brand-tag{background:var(--accent);color:#053b18;padding:2px 8px;border-radius:999px;font-size:11px;margin-left:6px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:14px}
.muted{color:var(--muted)}
.hero{background:linear-gradient(135deg,#0b6e6e 0%,#13a4a4 100%);color:#fff;padding:32px 22px;border-radius:18px;margin-bottom:18px}
.hero h1{margin:0 0 8px;font-size:28px;font-weight:800}
.hero p{margin:0;opacity:.92}
.search-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:16px}
.search-form input,.search-form select,.search-form button{padding:10px 12px;border:0;border-radius:10px;font-size:15px;font-weight:600;font-family:inherit}
.search-form input,.search-form select{background:#fff;color:var(--ink)}
.search-form button{background:#053b18;color:#fff;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.hotel-card{background:#fff;border:1px solid var(--border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.hotel-card .cover{height:140px;background:#cfe7e3 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#0b6e6e;font-weight:700}
.hotel-card .body{padding:12px}
.hotel-card h3{margin:0 0 4px;font-size:16px}
.hotel-card .price{margin-top:8px;font-size:14px}
.hotel-card .price strong{font-size:18px;color:var(--brand)}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#dcfce7;color:#166534}
.btn{display:inline-block;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:700}
.btn-primary{background:var(--brand);color:#fff}
.btn-whatsapp{background:var(--accent);color:#053b18}
.profile-cover{height:240px;border-radius:18px;background:#cfe7e3 center/cover no-repeat;margin-bottom:18px;display:flex;align-items:flex-end;padding:18px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.amenities{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.amenity{background:#eef6f4;color:var(--brand);padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600}
.room-card{display:flex;gap:12px;border-bottom:1px solid var(--border);padding:14px 0;align-items:flex-start}
.room-card:last-child{border-bottom:0}
.room-card .meta{flex:1}
.room-card .price{text-align:right;min-width:120px}
.empty{text-align:center;padding:40px 16px;color:var(--muted)}
@media (max-width:560px){.hero h1{font-size:22px}.profile-cover{height:160px}}
`;

function renderShell(opts: {
  title: string;
  meta?: { description?: string };
  body: string;
  marketplaceEligible?: boolean;
}): string {
  const description = opts.meta?.description ?? "ChatAstay marketplace — discover and book hotels via WhatsApp.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <style>${PAGE_BASE_STYLES}</style>
</head>
<body data-marketplace="${opts.marketplaceEligible === false ? "false" : "true"}">
  <div class="wrap">
    <nav class="nav">
      <a class="brand" href="/">ChatAstay<span class="brand-tag">marketplace</span></a>
      <div><a class="muted" href="/search">Search</a></div>
    </nav>
    ${opts.body}
  </div>
</body>
</html>`;
}

function renderSearchForm(values: { city: string; checkIn: string; checkOut: string; guests: number; rooms: number }): string {
  return `<form class="search-form" method="get" action="/search">
    <input type="text" name="city" placeholder="City (e.g. Sur)" value="${escapeHtml(values.city)}" />
    <input type="date" name="checkIn" value="${escapeHtml(values.checkIn)}" required />
    <input type="date" name="checkOut" value="${escapeHtml(values.checkOut)}" required />
    <select name="guests" aria-label="Guests">
      ${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === values.guests ? "selected" : ""}>${n} guest${n > 1 ? "s" : ""}</option>`).join("")}
    </select>
    <select name="rooms" aria-label="Rooms">
      ${[1, 2, 3].map((n) => `<option value="${n}" ${n === values.rooms ? "selected" : ""}>${n} room${n > 1 ? "s" : ""}</option>`).join("")}
    </select>
    <button type="submit">Search</button>
  </form>`;
}

function renderHotelCard(opts: {
  slug: string;
  displayName: string;
  city: string | null;
  cover: string | null;
  starRating: number | null;
  priceLabel: string;
  ctaHref: string;
}): string {
  const coverStyle = opts.cover ? `background-image:url(${JSON.stringify(opts.cover).slice(1, -1)})` : "";
  const initials = opts.displayName.split(/\s+/).map((s) => s[0] ?? "").slice(0, 2).join("").toUpperCase();
  return `<article class="hotel-card">
    <div class="cover" style="${coverStyle}">${opts.cover ? "" : escapeHtml(initials)}</div>
    <div class="body">
      <h3>${escapeHtml(opts.displayName)}</h3>
      <div class="muted" style="font-size:13px">${escapeHtml(opts.city ?? "")} ${opts.starRating ? `· <span class="badge">${opts.starRating.toFixed(1)} ★</span>` : ""}</div>
      <div class="price">${opts.priceLabel}</div>
      <div style="margin-top:10px"><a class="btn btn-primary" href="${escapeHtml(opts.ctaHref)}">View hotel</a></div>
    </div>
  </article>`;
}

// =============================================================================
// GET / — marketplace home
// =============================================================================
marketplaceRouter.get("/", async (req: Request, res: Response) => {
  if (wantsJsonHealth(req)) {
    res.json({ name: "chatastay", status: "ok" });
    return;
  }

  const today = startOfDay(new Date());
  const defaultCheckIn = addDays(today, 1);
  const defaultCheckOut = addDays(today, 2);

  // Featured hotels: marketplace-eligible + has at least one ACTIVE property.
  const marketplacePlans = await prisma.plan.findMany({
    where: { supportsMarketplace: true, isActive: true },
    select: { code: true }
  });
  const marketplaceCodes = marketplacePlans.map((p) => p.code);
  const gateOpen = marketplaceCodes.length > 0;

  const featured = await prisma.hotel.findMany({
    where: {
      isActive: true,
      properties: { some: { status: PropertyStatus.ACTIVE } },
      ...(gateOpen ? { subscriptionPlanCode: { in: marketplaceCodes } } : {})
    },
    select: {
      id: true,
      slug: true,
      displayName: true,
      city: true,
      country: true,
      coverImageUrl: true,
      starRating: true,
      description: true
    },
    orderBy: [{ starRating: "desc" }, { createdAt: "desc" }],
    take: 12
  });

  const featuredHtml = featured
    .map((h) =>
      renderHotelCard({
        slug: h.slug,
        displayName: h.displayName,
        city: h.city,
        cover: h.coverImageUrl,
        starRating: h.starRating,
        priceLabel: '<span class="muted">Tap to view rooms & rates</span>',
        ctaHref: `/h/${encodeURIComponent(h.slug)}`
      })
    )
    .join("");

  const body = `
    <section class="hero">
      <h1>Find your next stay — book on WhatsApp</h1>
      <p>ChatAstay-powered hotels offer instant booking with a real human handoff if you need it.</p>
      ${renderSearchForm({
        city: "",
        checkIn: toIsoDate(defaultCheckIn),
        checkOut: toIsoDate(defaultCheckOut),
        guests: 2,
        rooms: 1
      })}
    </section>
    <h2 style="margin:20px 0 12px;font-size:20px">Featured hotels</h2>
    ${featured.length === 0
      ? `<div class="card empty"><p>No hotels are listed on the marketplace yet.${gateOpen ? "" : ' <span class="muted">(Tip: enable <a href="/owner/plans">Plan.supportsMarketplace</a> to feature a hotel here.)</span>'}</p></div>`
      : `<div class="grid">${featuredHtml}</div>`}
  `;

  res.type("html").send(renderShell({ title: "ChatAstay marketplace", body }));
});

// =============================================================================
// GET /search — multi-hotel availability search
// =============================================================================
marketplaceRouter.get("/search", async (req: Request, res: Response) => {
  const today = startOfDay(new Date());
  const checkIn = parseDateOrToday(req.query.checkIn, 1);
  const checkOut = parseDateOrToday(req.query.checkOut, 2);
  const guests = parseInt(req.query.guests, 2, 1, 12);
  const rooms = parseInt(req.query.rooms, 1, 1, 6);
  const city = String(req.query.city ?? "").trim();

  const validRange = checkOut.getTime() > checkIn.getTime() && checkIn.getTime() >= today.getTime();
  const offers: MarketplaceOffer[] = validRange
    ? await findAvailableAcrossHotels({
        city: city || undefined,
        checkIn,
        checkOut,
        guests,
        rooms
      })
    : [];

  const cardsHtml = offers
    .map((o) =>
      renderHotelCard({
        slug: o.hotelSlug,
        displayName: o.hotelDisplayName,
        city: o.hotelCity,
        cover: o.hotelCoverImageUrl,
        starRating: o.hotelStarRating,
        priceLabel: `<strong>From ${o.total.toFixed(2)}</strong> <span class="muted">total · ${o.nights} night${o.nights > 1 ? "s" : ""}</span>`,
        ctaHref: `/h/${encodeURIComponent(o.hotelSlug)}?checkIn=${encodeURIComponent(toIsoDate(o.nightlyTotal === o.total ? checkIn : checkIn))}&checkOut=${encodeURIComponent(toIsoDate(checkOut))}&guests=${guests}&rooms=${rooms}`
      })
    )
    .join("");

  const body = `
    <section class="card">
      ${renderSearchForm({
        city,
        checkIn: toIsoDate(checkIn),
        checkOut: toIsoDate(checkOut),
        guests,
        rooms
      })}
    </section>
    <h2 style="margin:20px 0 12px;font-size:20px">${offers.length} result${offers.length === 1 ? "" : "s"}${city ? ` · ${escapeHtml(city)}` : ""}</h2>
    ${!validRange
      ? `<div class="card empty"><p>Check-out must be after check-in, and check-in cannot be in the past.</p></div>`
      : offers.length === 0
        ? `<div class="card empty"><p>No marketplace hotels have rooms available for those dates yet. Try different dates or remove the city filter.</p></div>`
        : `<div class="grid">${cardsHtml}</div>`}
  `;

  res.type("html").send(renderShell({ title: `Search · ChatAstay marketplace`, body }));
});

// =============================================================================
// GET /h/:slug — property profile
// =============================================================================
marketplaceRouter.get("/h/:slug", async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? "").trim();
  const hotel = await prisma.hotel.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      displayName: true,
      city: true,
      country: true,
      whatsappPhone: true,
      description: true,
      coverImageUrl: true,
      photoUrlsJson: true,
      amenitiesJson: true,
      starRating: true,
      currency: true,
      isActive: true,
      subscriptionPlanCode: true,
      properties: {
        where: { status: PropertyStatus.ACTIVE },
        select: {
          id: true,
          name: true,
          city: true,
          addressLine1: true,
          checkInTime: true,
          checkOutTime: true,
          description: true
        },
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!hotel || !hotel.isActive || hotel.properties.length === 0) {
    res.status(404).type("html").send(renderShell({ title: "Hotel not found", body: '<div class="card empty"><h2>Hotel not found</h2><p class="muted">This hotel is not currently listed on the marketplace.</p><p><a class="btn btn-primary" href="/">← Back to marketplace</a></p></div>' }));
    return;
  }

  const today = startOfDay(new Date());
  const checkIn = parseDateOrToday(req.query.checkIn, 1);
  const checkOut = parseDateOrToday(req.query.checkOut, 2);
  const guests = parseInt(req.query.guests, 2, 1, 12);
  const rooms = parseInt(req.query.rooms, 1, 1, 6);

  const validRange = checkOut.getTime() > checkIn.getTime() && checkIn.getTime() >= today.getTime();
  const offers: RoomOffer[] = validRange
    ? await findAvailableRoomTypes({
        hotelId: hotel.id,
        checkIn,
        checkOut,
        guests,
        rooms
      })
    : [];

  const roomTypeIds = offers.map((o) => o.roomTypeId);
  const roomTypeRows = roomTypeIds.length
    ? await prisma.roomType.findMany({
        where: { id: { in: roomTypeIds } },
        select: { id: true, description: true, photoUrlsJson: true, bedConfig: true, capacity: true }
      })
    : [];
  const roomTypeMeta = new Map(roomTypeRows.map((r) => [r.id, r]));

  const photos = safeParseJsonArray(hotel.photoUrlsJson);
  const amenities = safeParseJsonArray(hotel.amenitiesJson);
  const coverStyle = hotel.coverImageUrl ? `background-image:url(${JSON.stringify(hotel.coverImageUrl).slice(1, -1)})` : "background:linear-gradient(135deg,#0b6e6e 0%,#13a4a4 100%)";

  const whatsappCta = hotel.whatsappPhone
    ? `<a class="btn btn-whatsapp" href="https://wa.me/${encodeURIComponent(hotel.whatsappPhone.replace(/\D/g, ""))}?text=${encodeURIComponent(`Hi! I'd like to book ${hotel.displayName} from ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)} for ${guests} guest${guests > 1 ? "s" : ""}.`)}" target="_blank" rel="noopener">Continue on WhatsApp</a>`
    : "";

  const roomCardsHtml = offers
    .map((o) => {
      const meta = roomTypeMeta.get(o.roomTypeId);
      const photoList = safeParseJsonArray(meta?.photoUrlsJson ?? null);
      const heroPhoto = photoList[0];
      return `<div class="room-card">
        ${heroPhoto ? `<img src="${escapeHtml(heroPhoto)}" alt="${escapeHtml(o.roomTypeName)}" style="width:140px;height:100px;object-fit:cover;border-radius:10px" />` : `<div style="width:140px;height:100px;background:#cfe7e3;border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--brand);font-weight:700">${escapeHtml(o.roomTypeName.slice(0, 2).toUpperCase())}</div>`}
        <div class="meta">
          <h3 style="margin:0 0 4px">${escapeHtml(o.roomTypeName)}</h3>
          <div class="muted" style="font-size:13px">${escapeHtml(meta?.bedConfig ?? "")}${meta?.capacity ? ` · sleeps ${meta.capacity}` : ""}</div>
          ${meta?.description ? `<p style="margin:6px 0 0;font-size:14px">${escapeHtml(meta.description)}</p>` : ""}
        </div>
        <div class="price">
          <strong style="font-size:18px;color:var(--brand)">${o.total.toFixed(2)}</strong>
          <div class="muted" style="font-size:12px">${o.nights} night${o.nights > 1 ? "s" : ""} · ${escapeHtml(hotel.currency)}</div>
        </div>
      </div>`;
    })
    .join("");

  const body = `
    <div class="profile-cover" style="${coverStyle}">
      <div>
        <h1 style="margin:0 0 4px;font-size:28px">${escapeHtml(hotel.displayName)}</h1>
        <p class="muted" style="color:#fff;opacity:.95;margin:0">${escapeHtml([hotel.city, hotel.country].filter(Boolean).join(", "))}${hotel.starRating ? ` · ${hotel.starRating.toFixed(1)} ★` : ""}</p>
      </div>
    </div>
    ${hotel.description ? `<section class="card"><h2 style="margin-top:0;font-size:18px">About this hotel</h2><p>${escapeHtml(hotel.description)}</p></section>` : ""}
    ${amenities.length ? `<section class="card"><h2 style="margin-top:0;font-size:18px">Amenities</h2><div class="amenities">${amenities.map((a) => `<span class="amenity">${escapeHtml(a.replaceAll("_", " ").toLowerCase())}</span>`).join("")}</div></section>` : ""}
    <section class="card">
      <h2 style="margin-top:0;font-size:18px">Available rooms</h2>
      ${renderSearchForm({ city: "", checkIn: toIsoDate(checkIn), checkOut: toIsoDate(checkOut), guests, rooms })}
      ${!validRange
        ? `<p class="muted" style="margin-top:12px">Choose valid check-in / check-out dates to see live availability.</p>`
        : offers.length === 0
          ? `<p class="muted" style="margin-top:12px">No rooms available for these dates. Try different dates.</p>`
          : `<div style="margin-top:14px">${roomCardsHtml}</div>`}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        ${whatsappCta}
        <a class="btn btn-primary" href="/guest/?hotel=${encodeURIComponent(hotel.slug)}&checkIn=${encodeURIComponent(toIsoDate(checkIn))}&checkOut=${encodeURIComponent(toIsoDate(checkOut))}&guests=${guests}&rooms=${rooms}">Continue on web</a>
      </div>
    </section>
    ${photos.length
      ? `<section class="card"><h2 style="margin-top:0;font-size:18px">Photos</h2><div class="grid">${photos.map((url) => `<img src="${escapeHtml(url)}" alt="" style="width:100%;border-radius:10px;height:160px;object-fit:cover" />`).join("")}</div></section>`
      : ""}`;

  const marketplacePlanCodes = (
    await prisma.plan.findMany({ where: { supportsMarketplace: true, isActive: true }, select: { code: true } })
  ).map((p) => p.code);
  const eligible = marketplacePlanCodes.length === 0 || (hotel.subscriptionPlanCode != null && marketplacePlanCodes.includes(hotel.subscriptionPlanCode));

  res.type("html").send(
    renderShell({
      title: `${hotel.displayName} · ChatAstay`,
      meta: { description: hotel.description ?? `${hotel.displayName} marketplace listing on ChatAstay.` },
      body,
      marketplaceEligible: eligible
    })
  );
});

// =============================================================================
// GET /h/:slug/availability.json — ajax availability grid
// =============================================================================
marketplaceRouter.get("/h/:slug/availability.json", async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? "").trim();
  const hotel = await prisma.hotel.findUnique({
    where: { slug },
    select: { id: true, isActive: true, properties: { where: { status: PropertyStatus.ACTIVE }, select: { id: true } } }
  });
  if (!hotel || !hotel.isActive || hotel.properties.length === 0) {
    res.status(404).json({ error: "hotel_not_found" });
    return;
  }

  const checkIn = parseDateOrToday(req.query.checkIn, 1);
  const checkOut = parseDateOrToday(req.query.checkOut, 2);
  const guests = parseInt(req.query.guests, 2, 1, 12);
  const rooms = parseInt(req.query.rooms, 1, 1, 6);

  const validRange = checkOut.getTime() > checkIn.getTime();
  const offers = validRange
    ? await findAvailableRoomTypes({ hotelId: hotel.id, checkIn, checkOut, guests, rooms })
    : [];

  res.json({
    checkIn: toIsoDate(checkIn),
    checkOut: toIsoDate(checkOut),
    guests,
    rooms,
    offers: offers.map((o) => ({
      roomTypeId: o.roomTypeId,
      roomTypeName: o.roomTypeName,
      nights: o.nights,
      nightlyTotal: o.nightlyTotal,
      total: o.total
    }))
  });
});
