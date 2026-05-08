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
import crypto from "node:crypto";
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
import { PLATFORM_HOTEL_ID, trackDecisionEventSafe } from "../core/decisionAnalytics";

/// Phase E: how long a marketplace intent token is valid (30 days). After
/// expiry the wa.me link still opens WhatsApp, but the webhook silently
/// ignores the token and the guest goes through the normal flow.
const MARKETPLACE_INTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/// Marker embedded in the wa.me message text. The WhatsApp webhook scans
/// inbound messages for `[#chatastay-mp:<token>]` and seeds a BookingDraft
/// from the matching MarketplaceBookingIntent. Keep the marker stable —
/// if it changes, also update src/whatsapp/marketplaceIntentClaim.ts.
const MARKETPLACE_INTENT_MARKER_PREFIX = "[#chatastay-mp:";
const MARKETPLACE_INTENT_MARKER_SUFFIX = "]";

function newIntentToken(): string {
  return crypto.randomBytes(16).toString("base64url");
}

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
:root{--brand:#064e46;--brand-2:#128c7e;--accent:#25d366;--mint:#dcfce7;--bg:#eef7f3;--ink:#0b1f1c;--muted:#64736f;--card:#fff;--border:#dce8e3;--shadow:0 18px 55px rgba(15,44,38,.10);--shadow-card:0 10px 30px rgba(15,44,38,.08)}
*{box-sizing:border-box}
body{font-family:Inter,Arial,sans-serif;margin:0;background:radial-gradient(circle at 12% -10%,rgba(37,211,102,.22),transparent 30%),radial-gradient(circle at 90% 8%,rgba(18,140,126,.16),transparent 28%),linear-gradient(180deg,#f9fffc 0%,var(--bg) 54%,#e8f2ee 100%);color:var(--ink);font-feature-settings:"cv02","cv03","cv04","cv11"}
a{color:var(--brand)}
.wrap{max-width:1160px;margin:0 auto;padding:22px}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 0;margin-bottom:18px}
.nav .brand{display:inline-flex;align-items:center;gap:10px;font-weight:900;font-size:22px;color:var(--brand);text-decoration:none;letter-spacing:-.04em}
.nav .brand::before{content:"";width:34px;height:34px;border-radius:12px;background:linear-gradient(135deg,#25d366,#b9f7d3);box-shadow:0 12px 26px rgba(37,211,102,.24)}
.nav .brand-tag{background:var(--mint);color:#075e54;padding:3px 9px;border-radius:999px;font-size:11px;margin-left:4px;letter-spacing:.02em}
.nav .links{display:flex;gap:9px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.nav .muted{text-decoration:none;font-weight:800}
.nav .nav-pill{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:900;border:1px solid rgba(7,94,84,.12);border-radius:999px;padding:8px 12px;background:rgba(255,255,255,.78);color:var(--brand);box-shadow:0 8px 18px rgba(15,44,38,.05)}
.nav .nav-pill.hotel{background:linear-gradient(135deg,#075e54,#128c7e);color:#fff;border-color:transparent}
.nav .nav-pill.traveller{background:linear-gradient(135deg,#dcfce7,#ecfff5);color:#064e46;border-color:#bbf7d0}
.card{background:rgba(255,255,255,.96);border:1px solid var(--border);border-radius:22px;padding:18px;margin-bottom:16px;box-shadow:var(--shadow-card)}
.muted{color:var(--muted)}
.hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#064e46 0%,#128c7e 58%,#25d366 145%);color:#fff;padding:44px 30px;border-radius:28px;margin-bottom:20px;box-shadow:var(--shadow)}
.hero::after{content:"";position:absolute;right:-70px;top:-70px;width:220px;height:220px;border-radius:999px;background:rgba(255,255,255,.12)}
.hero h1{position:relative;margin:0 0 10px;font-size:clamp(30px,5vw,52px);line-height:1.02;font-weight:900;letter-spacing:-.055em;max-width:760px}
.hero p{position:relative;margin:0;opacity:.94;font-size:17px;line-height:1.55;max-width:680px}
.search-form{position:relative;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:22px;padding:10px;border-radius:18px;background:rgba(255,255,255,.14);backdrop-filter:blur(14px)}
.search-form input,.search-form select,.search-form button{padding:12px 13px;border:1px solid transparent;border-radius:13px;font-size:15px;font-weight:700;font-family:inherit;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}
.search-form input,.search-form select{background:#fff;color:var(--ink)}
.search-form input:focus,.search-form select:focus{outline:0;border-color:#25d366;box-shadow:0 0 0 4px rgba(37,211,102,.18)}
.search-form button{background:linear-gradient(135deg,#25d366,#7df0ad);color:#063d31;cursor:pointer;box-shadow:0 12px 26px rgba(37,211,102,.2)}
.search-form button:hover,.btn:hover,.hotel-card:hover{transform:translateY(-2px)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.hotel-card{background:#fff;border:1px solid var(--border);border-radius:22px;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow-card);transition:transform .16s ease,box-shadow .16s ease}
.hotel-card:hover{box-shadow:var(--shadow)}
.hotel-card .cover{height:164px;background:#d9fbe8 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#075e54;font-weight:900;font-size:24px}
.hotel-card .body{padding:16px}
.hotel-card h3{margin:0 0 5px;font-size:17px;letter-spacing:-.02em}
.hotel-card .price{margin-top:10px;font-size:14px}
.hotel-card .price strong{font-size:20px;color:var(--brand)}
.badge{display:inline-block;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:800;background:#dcfce7;color:#166534;border:1px solid #b7f1cc}
.btn{display:inline-block;padding:11px 15px;border-radius:13px;text-decoration:none;font-weight:800;transition:transform .16s ease,box-shadow .16s ease,filter .16s ease}
.btn-primary{background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;box-shadow:0 12px 24px rgba(7,94,84,.18)}
.btn-whatsapp{background:linear-gradient(135deg,#25d366,#7df0ad);color:#063d31;box-shadow:0 12px 24px rgba(37,211,102,.2)}
.profile-cover{height:280px;border-radius:28px;background:#cfe7e3 center/cover no-repeat;margin-bottom:18px;display:flex;align-items:flex-end;padding:24px;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.4);box-shadow:var(--shadow);overflow:hidden}
.amenities{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.amenity{background:#eefbf4;color:var(--brand);padding:6px 11px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid #d9f3e4;text-transform:capitalize}
.room-card{display:flex;gap:14px;border-bottom:1px solid var(--border);padding:16px 0;align-items:flex-start}
.room-card:last-child{border-bottom:0}
.room-card .meta{flex:1}
.room-card .price{text-align:right;min-width:120px}
.empty{text-align:center;padding:44px 16px;color:var(--muted)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
@media (max-width:560px){.wrap{padding:14px}.hero{padding:28px 18px;border-radius:22px}.hero h1{font-size:30px}.profile-cover{height:180px;border-radius:22px}.room-card{display:block}.room-card .price{text-align:left;margin-top:10px}}
/* ===== Polish layer 2: spacing, hierarchy, animations, premium SaaS feel ===== */
::selection{background:rgba(37,211,102,.32);color:#053b18}
html{scroll-behavior:smooth}
*:focus-visible{outline:2px solid #25d366;outline-offset:2px;border-radius:8px}
h1,h2,h3{letter-spacing:-.025em}
p,li{line-height:1.6}
.wrap{padding:28px 22px}
.nav{padding:6px 0 14px}
.hero{padding:64px 36px;border-radius:32px}
.hero::before{content:"";position:absolute;left:-90px;bottom:-90px;width:260px;height:260px;border-radius:999px;background:rgba(255,255,255,.08);pointer-events:none}
.hero h1{margin-bottom:14px;font-size:clamp(32px,5.4vw,58px);max-width:780px}
.hero p{font-size:18px;line-height:1.55;max-width:680px}
.search-form{margin-top:26px;padding:14px;border-radius:22px;background:rgba(255,255,255,.18);box-shadow:0 22px 60px rgba(7,68,58,.14)}
.search-form input,.search-form select,.search-form button{padding:13px 14px;font-size:15px;border-radius:14px}
.search-form input:hover,.search-form select:hover{border-color:#b9d8cd}
.search-form button:active,.btn:active,.hotel-card:active{transform:translateY(0) scale(.99)}
.grid{gap:20px;margin-top:8px}
.hotel-card{transform:translateZ(0)}
.hotel-card .cover{position:relative;height:180px;transition:filter .25s ease}
.hotel-card:hover .cover{filter:saturate(1.08) brightness(1.02)}
.hotel-card .body{padding:18px 18px 20px}
.hotel-card h3{font-size:18px;letter-spacing:-.02em}
.hotel-card .price{margin-top:12px}
.hotel-card .price strong{font-size:22px}
.hotel-card a.btn{margin-top:14px;padding:12px 16px}
.btn{padding:13px 18px;font-size:15px;border-radius:14px;letter-spacing:.005em}
.btn-primary:hover,.btn-whatsapp:hover{filter:brightness(1.04);box-shadow:0 16px 32px rgba(7,94,84,.22)}
.profile-cover{position:relative;height:320px;padding:32px;border-radius:32px}
.profile-cover::after{content:"";position:absolute;inset:auto 0 0 0;height:55%;background:linear-gradient(180deg,transparent 0%,rgba(0,0,0,.55) 100%);pointer-events:none;border-bottom-left-radius:32px;border-bottom-right-radius:32px}
.profile-cover>*{position:relative;z-index:1}
.amenity{padding:7px 13px;font-size:12.5px}
.room-card{padding:18px 0;gap:16px}
.room-card h3{font-size:17px}
.room-card .price strong{font-size:22px}
.card{padding:22px;border-radius:24px}
.card h2{font-size:19px;margin-bottom:8px}
.empty{padding:56px 18px;font-size:15px}
.badge{padding:5px 11px;font-size:11.5px;letter-spacing:.02em}
@keyframes wa-fade-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.hero{animation:wa-fade-up .42s cubic-bezier(.22,1,.36,1) both}
.card{animation:wa-fade-up .36s ease-out both}
.hotel-card{animation:wa-fade-up .42s ease-out both}
.hotel-card:nth-child(2){animation-delay:.04s}
.hotel-card:nth-child(3){animation-delay:.08s}
.hotel-card:nth-child(4){animation-delay:.12s}
.hotel-card:nth-child(5){animation-delay:.16s}
.hotel-card:nth-child(n+6){animation-delay:.18s}
html{scrollbar-width:thin;scrollbar-color:rgba(7,94,84,.32) transparent}
body::-webkit-scrollbar{width:10px;height:10px}
body::-webkit-scrollbar-thumb{background:linear-gradient(180deg,rgba(37,211,102,.5),rgba(7,94,84,.45));border-radius:999px;border:2px solid transparent;background-clip:padding-box}
@media (max-width:560px){.wrap{padding:18px}.hero{padding:36px 22px;border-radius:26px}.hero h1{font-size:32px}.hero p{font-size:16px}.profile-cover{height:220px;padding:22px;border-radius:24px}.search-form{padding:8px}.btn{padding:12px 16px}.card{padding:18px;border-radius:20px}}
/* ===== Polish layer 3: premium SaaS depth, hierarchy, micro-interactions ===== */
body{font-family:"Inter","SF Pro Display","Segoe UI",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;background:radial-gradient(ellipse at 8% -8%,rgba(37,211,102,.18),transparent 35%),radial-gradient(ellipse at 95% 5%,rgba(18,140,126,.14),transparent 32%),radial-gradient(ellipse at 50% 100%,rgba(37,211,102,.06),transparent 40%),linear-gradient(180deg,#f7fcf9 0%,#eef7f2 45%,#e6f1ec 100%);background-attachment:fixed}
.hero{background:linear-gradient(135deg,#064e46 0%,#0c7a6e 45%,#128c7e 100%),radial-gradient(circle at 20% 0%,rgba(37,211,102,.32),transparent 45%);box-shadow:0 36px 90px -16px rgba(7,68,58,.32),inset 0 1px 0 rgba(255,255,255,.12)}
.hero h1{background:linear-gradient(135deg,#ffffff 0%,#d9fbe8 100%);-webkit-background-clip:text;background-clip:text;color:transparent;letter-spacing:-.04em}
.hotel-card{background:linear-gradient(180deg,#ffffff 0%,#f7fdfa 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 18px 48px -16px rgba(15,44,38,.16),inset 0 1px 0 rgba(255,255,255,.85);transition:transform .22s cubic-bezier(.25,1,.5,1),box-shadow .22s cubic-bezier(.25,1,.5,1)}
.hotel-card:hover{transform:translateY(-4px);box-shadow:0 32px 80px -20px rgba(7,68,58,.22)}
.hotel-card .price strong{background:linear-gradient(135deg,#0b1f1c 0%,#0e3d34 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.btn-primary,.btn-whatsapp{background:linear-gradient(135deg,#25d366 0%,#1bb673 50%,#128c7e 100%);color:#053b18;border:0;box-shadow:0 14px 30px -8px rgba(37,211,102,.4),inset 0 1px 0 rgba(255,255,255,.45);transition:transform .18s cubic-bezier(.25,1,.5,1),box-shadow .18s cubic-bezier(.25,1,.5,1),filter .18s cubic-bezier(.25,1,.5,1)}
.btn-primary:hover,.btn-whatsapp:hover{transform:translateY(-1px);box-shadow:0 22px 44px -10px rgba(37,211,102,.5),inset 0 1px 0 rgba(255,255,255,.5);filter:brightness(1.04)}
.search-form input,.search-form select{background:#ffffff;border:1px solid #d9e7e1;transition:border-color .18s cubic-bezier(.25,1,.5,1),box-shadow .18s cubic-bezier(.25,1,.5,1)}
.search-form input:focus,.search-form select:focus{border-color:#25d366;box-shadow:0 0 0 4px rgba(37,211,102,.18);outline:0}
.card{background:linear-gradient(180deg,rgba(255,255,255,.98) 0%,rgba(252,255,253,.92) 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 22px 60px -16px rgba(15,44,38,.16),inset 0 1px 0 rgba(255,255,255,.85)}
.amenity{background:linear-gradient(135deg,#dcfce7 0%,#c7f5d6 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 2px 6px rgba(15,44,38,.04)}
.badge{font-weight:700}
::selection{background:rgba(37,211,102,.3);color:#053b18}
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
      <div class="links">
        <a class="muted" href="/search">Search</a>
        <a class="nav-pill hotel" href="/admin/login">Hotel / Partner Extranet</a>
        <a class="nav-pill traveller" href="/guest/account">Traveller Account</a>
        <a class="nav-pill" href="/guest/trips">My Trips</a>
      </div>
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

  /// Phase H: record the search as a platform-level decision event so the
  /// /owner/marketplace KPI dashboard can chart searches/day.
  await trackDecisionEventSafe({
    hotelId: PLATFORM_HOTEL_ID,
    eventType: "marketplace_search",
    metadata: {
      city: city || null,
      checkIn: toIsoDate(checkIn),
      checkOut: toIsoDate(checkOut),
      guests,
      rooms,
      offerCount: offers.length
    }
  });

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

  /// Phase E: route the WhatsApp CTA through `/m/start` so we can mint a
  /// MarketplaceBookingIntent token, embed it in the wa.me message text, and
  /// later (when the webhook receives the inbound message) seed a BookingDraft
  /// from this intent for the now-resolved guest.
  const whatsappCta = hotel.whatsappPhone
    ? `<a class="btn btn-whatsapp" href="/m/start?slug=${encodeURIComponent(hotel.slug)}&checkIn=${encodeURIComponent(toIsoDate(checkIn))}&checkOut=${encodeURIComponent(toIsoDate(checkOut))}&guests=${guests}&rooms=${rooms}" target="_blank" rel="noopener">Continue on WhatsApp</a>`
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

  /// Phase H: record the property view as a per-hotel decision event so the
  /// KPI dashboard can chart view-to-book conversion per hotel.
  await trackDecisionEventSafe({
    hotelId: hotel.id,
    eventType: "marketplace_property_view",
    metadata: {
      slug: hotel.slug,
      checkIn: toIsoDate(checkIn),
      checkOut: toIsoDate(checkOut),
      guests,
      rooms,
      eligible
    }
  });

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

// =============================================================================
// GET /m/start — mint MarketplaceBookingIntent + redirect to wa.me
// =============================================================================
// Creates a one-shot intent token and redirects the guest to WhatsApp with the
// token embedded in the message text. The WhatsApp webhook (Phase E claim
// handler) will pick up the token and seed a BookingDraft for the
// now-resolved guest. If anything fails (no whatsappPhone, no ACTIVE property)
// we fall back to the property profile page so the guest still has a path
// forward.
marketplaceRouter.get("/m/start", async (req: Request, res: Response) => {
  const slug = String(req.query.slug ?? "").trim();
  if (!slug) {
    res.redirect("/");
    return;
  }
  const hotel = await prisma.hotel.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      displayName: true,
      whatsappPhone: true,
      isActive: true,
      properties: { where: { status: PropertyStatus.ACTIVE }, select: { id: true } }
    }
  });
  if (!hotel || !hotel.isActive || hotel.properties.length === 0 || !hotel.whatsappPhone) {
    res.redirect(`/h/${encodeURIComponent(slug)}`);
    return;
  }

  const checkIn = parseDateOrToday(req.query.checkIn, 1);
  const checkOut = parseDateOrToday(req.query.checkOut, 2);
  const guests = parseInt(req.query.guests, 2, 1, 12);
  const rooms = parseInt(req.query.rooms, 1, 1, 6);

  const token = newIntentToken();
  await prisma.marketplaceBookingIntent.create({
    data: {
      token,
      hotelId: hotel.id,
      hotelSlug: hotel.slug,
      checkIn,
      checkOut,
      guests,
      rooms,
      expiresAt: new Date(Date.now() + MARKETPLACE_INTENT_TTL_MS)
    }
  });

  const phoneDigits = hotel.whatsappPhone.replace(/\D/g, "");
  const messageText = `Hi! I'd like to book ${hotel.displayName} from ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)} for ${guests} guest${guests > 1 ? "s" : ""}. ${MARKETPLACE_INTENT_MARKER_PREFIX}${token}${MARKETPLACE_INTENT_MARKER_SUFFIX}`;
  const waUrl = `https://wa.me/${encodeURIComponent(phoneDigits)}?text=${encodeURIComponent(messageText)}`;

  /// Phase H: record the intent mint as a per-hotel event for funnel analytics.
  await trackDecisionEventSafe({
    hotelId: hotel.id,
    eventType: "marketplace_intent_minted",
    metadata: {
      slug: hotel.slug,
      token,
      checkIn: toIsoDate(checkIn),
      checkOut: toIsoDate(checkOut),
      guests,
      rooms
    },
    dedupeKey: `intent:${token}`
  });

  res.redirect(waUrl);
});

/// Exported so the WhatsApp webhook can use the same marker definition.
export const MARKETPLACE_INTENT_MARKERS = {
  prefix: MARKETPLACE_INTENT_MARKER_PREFIX,
  suffix: MARKETPLACE_INTENT_MARKER_SUFFIX,
  ttlMs: MARKETPLACE_INTENT_TTL_MS
} as const;

/**
 * Parse a marketplace intent token out of an inbound WhatsApp message body.
 * Returns null if no marker is present. The token must be a base64url-style
 * string (letters, digits, `-`, `_`); anything else is rejected so guests
 * can't accidentally claim arbitrary tokens by typing weird text.
 */
export function extractMarketplaceIntentToken(messageText: string | null | undefined): string | null {
  if (!messageText) return null;
  const idx = messageText.indexOf(MARKETPLACE_INTENT_MARKER_PREFIX);
  if (idx === -1) return null;
  const rest = messageText.slice(idx + MARKETPLACE_INTENT_MARKER_PREFIX.length);
  const closeIdx = rest.indexOf(MARKETPLACE_INTENT_MARKER_SUFFIX);
  if (closeIdx === -1) return null;
  const token = rest.slice(0, closeIdx);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
  return token;
}
