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
/* ===== Pricing page (subscription plans) — premium SaaS look in the existing brand palette ===== */
.pricing-hero{padding:60px 36px;border-radius:32px;text-align:left;margin-bottom:36px;background:linear-gradient(135deg,#053b34 0%,#0c7a6e 50%,#128c7e 100%);box-shadow:0 36px 90px -16px rgba(7,68,58,.32),inset 0 1px 0 rgba(255,255,255,.12);position:relative;overflow:hidden;color:#fff}
.pricing-hero::before{content:"";position:absolute;left:-90px;bottom:-90px;width:280px;height:280px;border-radius:999px;background:rgba(255,255,255,.08);pointer-events:none}
.pricing-hero::after{content:"";position:absolute;right:-90px;top:-90px;width:240px;height:240px;border-radius:999px;background:rgba(37,211,102,.18);pointer-events:none}
.pricing-hero .eyebrow{position:relative;display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);padding:6px 14px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-bottom:14px;color:#dcfce7}
.pricing-hero h1{position:relative;margin:0 0 12px;font-size:clamp(34px,5.4vw,58px);letter-spacing:-.04em;line-height:1.02;background:linear-gradient(135deg,#ffffff 0%,#d9fbe8 100%);-webkit-background-clip:text;background-clip:text;color:transparent;max-width:780px}
.pricing-hero p{position:relative;margin:0;opacity:.94;font-size:18px;line-height:1.55;max-width:680px}
.pricing-hero .trust-row{position:relative;margin-top:22px;display:flex;flex-wrap:wrap;gap:10px}
.pricing-hero .trust-pill{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);padding:7px 12px;border-radius:999px;font-size:12.5px;font-weight:700;color:#ecfdf5}
.pricing-toggle{display:inline-flex;align-items:center;gap:0;padding:5px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.24);border-radius:999px;margin-top:24px;position:relative}
.pricing-toggle button{appearance:none;border:0;background:transparent;color:#ecfdf5;padding:8px 18px;font-size:13.5px;font-weight:800;cursor:pointer;border-radius:999px;letter-spacing:.01em;transition:background .2s ease,color .2s ease,box-shadow .2s ease}
.pricing-toggle button.is-active{background:#ffffff;color:#053b18;box-shadow:0 8px 22px -6px rgba(0,0,0,.18)}
.pricing-toggle .save-flag{margin-left:8px;background:#dcfce7;color:#166534;font-size:11px;font-weight:800;border-radius:999px;padding:3px 8px;letter-spacing:.04em;text-transform:uppercase}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-bottom:34px;align-items:stretch}
.plan-card{position:relative;background:linear-gradient(180deg,#ffffff 0%,#f7fdfa 100%);border:1px solid rgba(220,232,227,.85);border-radius:24px;padding:26px 24px 24px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 48px -16px rgba(15,44,38,.16),inset 0 1px 0 rgba(255,255,255,.85);animation:wa-fade-up .42s cubic-bezier(.22,1,.36,1) both;transform-origin:center;will-change:transform;transition:transform .26s cubic-bezier(.25,1,.5,1),box-shadow .26s cubic-bezier(.25,1,.5,1),border-color .26s cubic-bezier(.25,1,.5,1)}
.plan-card:hover{transform:translateY(-8px) scale(1.035);box-shadow:0 36px 90px -20px rgba(7,68,58,.26);border-color:#cbe5da;z-index:2}
.plan-card:nth-child(2){animation-delay:.05s}
.plan-card:nth-child(3){animation-delay:.1s}
.plan-card:nth-child(4){animation-delay:.15s}
.plan-card .plan-name{font-size:14px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--brand-2);margin:0}
.plan-card .plan-tag{font-size:13px;color:var(--muted);margin:0 0 4px}
.plan-card .plan-price{display:flex;align-items:baseline;gap:6px;font-size:38px;font-weight:900;color:var(--ink);letter-spacing:-.025em;line-height:1.05;margin:6px 0 4px}
.plan-card .plan-price small{font-size:13px;font-weight:700;color:var(--muted);letter-spacing:0}
.plan-card .plan-price .legacy{text-decoration:line-through;font-size:18px;color:#94a3b8;font-weight:700;margin-right:4px}
.plan-card .plan-price.custom{font-size:30px}
.plan-card ul{list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:10px;flex:1}
.plan-card ul li{position:relative;padding-left:26px;font-size:14px;color:var(--ink);line-height:1.5}
.plan-card ul li::before{content:"";position:absolute;left:0;top:4px;width:18px;height:18px;border-radius:50%;background:linear-gradient(135deg,#25d366,#7df0ad);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 2px 6px rgba(37,211,102,.22)}
.plan-card ul li::after{content:"";position:absolute;left:5px;top:7px;width:8px;height:5px;border-left:2px solid #053b18;border-bottom:2px solid #053b18;transform:rotate(-45deg)}
.plan-card .plan-cta{margin-top:6px;display:flex;flex-direction:column;gap:8px}
.plan-card .plan-cta .btn{text-align:center;width:100%}
.plan-card .plan-cta .secondary-cta{display:inline-flex;justify-content:center;font-size:13px;font-weight:700;color:var(--brand-2);text-decoration:none;padding:6px 0}
.plan-card .plan-cta .secondary-cta:hover{text-decoration:underline}
.plan-card.recommended{border-color:transparent;background:linear-gradient(180deg,#ffffff 0%,#f0fdf6 100%);box-shadow:0 32px 80px -20px rgba(37,211,102,.32),inset 0 1px 0 rgba(255,255,255,.95);outline:2px solid rgba(37,211,102,.45);outline-offset:0;animation:wa-fade-up .42s cubic-bezier(.22,1,.36,1) both,plan-glow 3.4s ease-in-out infinite alternate;animation-delay:.05s,.4s}
.plan-card.recommended:hover{transform:translateY(-12px) scale(1.045);box-shadow:0 44px 100px -16px rgba(37,211,102,.5);z-index:3}
.plan-card.recommended .plan-name{color:var(--brand)}
.plan-card.recommended::before{content:"Most popular";position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#25d366 0%,#7df0ad 100%);color:#053b18;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;padding:6px 14px;border-radius:999px;box-shadow:0 12px 26px -6px rgba(37,211,102,.5);white-space:nowrap}
@keyframes plan-glow{from{box-shadow:0 32px 80px -20px rgba(37,211,102,.28),inset 0 1px 0 rgba(255,255,255,.95)}to{box-shadow:0 36px 90px -18px rgba(37,211,102,.5),inset 0 1px 0 rgba(255,255,255,.95)}}
.plan-card.enterprise{background:linear-gradient(180deg,#0b1f1c 0%,#053b34 100%);color:#ecfdf5;border-color:transparent}
.plan-card.enterprise .plan-name{color:#7df0ad}
.plan-card.enterprise .plan-tag{color:rgba(220,252,231,.78)}
.plan-card.enterprise .plan-price{color:#ffffff}
.plan-card.enterprise .plan-price small{color:rgba(220,252,231,.72)}
.plan-card.enterprise ul li{color:rgba(255,255,255,.9)}
.plan-card.enterprise ul li::before{background:linear-gradient(135deg,#7df0ad,#25d366)}
.plan-card.enterprise:hover{transform:translateY(-8px) scale(1.035);box-shadow:0 40px 100px -18px rgba(7,68,58,.65);z-index:2}
.compare-card{padding:26px 22px;animation:wa-fade-up .42s ease-out both;animation-delay:.18s}
.compare-card h2{margin:0 0 6px;font-size:22px;letter-spacing:-.025em}
.compare-card .lead{margin:0 0 16px;color:var(--muted);font-size:15px}
.compare-table-wrap{overflow-x:auto;border-radius:18px;border:1px solid var(--border);background:#fff;-webkit-overflow-scrolling:touch}
.compare-table{width:100%;min-width:640px;border-collapse:collapse;font-size:14px}
.compare-table thead th{position:sticky;top:0;background:linear-gradient(180deg,#f6fcf9,#eef7f2);text-align:left;padding:14px 14px;font-size:12.5px;font-weight:800;color:var(--brand);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border)}
.compare-table tbody td{padding:13px 14px;border-bottom:1px solid #eef2ef;color:var(--ink);vertical-align:middle}
.compare-table tbody tr:last-child td{border-bottom:0}
.compare-table tbody td:first-child{font-weight:700;color:var(--ink)}
.compare-table .yes{color:#059669;font-weight:800}
.compare-table .no{color:#cbd5d1;font-weight:700}
.compare-table .recommended-col{background:linear-gradient(180deg,rgba(37,211,102,.06),rgba(37,211,102,.02));border-left:1px solid rgba(37,211,102,.2);border-right:1px solid rgba(37,211,102,.2)}
.faq-card{padding:26px 22px;animation:wa-fade-up .42s ease-out both;animation-delay:.22s}
.faq-card h2{margin:0 0 8px;font-size:22px;letter-spacing:-.025em}
.faq-card .lead{margin:0 0 14px;color:var(--muted);font-size:15px}
.faq-list{display:flex;flex-direction:column;gap:10px}
.faq-item{border:1px solid var(--border);border-radius:14px;background:#ffffff;transition:border-color .2s ease,box-shadow .2s ease}
.faq-item[open]{border-color:#bbf7d0;box-shadow:0 12px 30px -16px rgba(37,211,102,.32)}
.faq-item summary{cursor:pointer;list-style:none;padding:14px 16px;font-weight:800;color:var(--ink);font-size:15px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.faq-item summary::-webkit-details-marker{display:none}
.faq-item summary::after{content:"+";font-size:22px;color:var(--brand-2);font-weight:700;transition:transform .2s ease}
.faq-item[open] summary::after{content:"−"}
.faq-item .answer{padding:0 16px 16px;color:var(--muted);line-height:1.6;font-size:14.5px}
.cta-banner{margin-top:30px;padding:36px 28px;border-radius:28px;background:linear-gradient(135deg,#053b34 0%,#0c7a6e 50%,#25d366 140%);color:#ffffff;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;box-shadow:0 32px 80px -22px rgba(7,68,58,.36)}
.cta-banner h3{margin:0 0 4px;font-size:22px;letter-spacing:-.02em}
.cta-banner p{margin:0;opacity:.92;font-size:14.5px;max-width:520px;line-height:1.55}
.cta-banner .cta-actions{display:flex;gap:10px;flex-wrap:wrap}
.cta-banner .btn{padding:12px 18px}
.cta-banner .btn-ghost{background:rgba(255,255,255,.16);color:#ffffff;border:1px solid rgba(255,255,255,.32);box-shadow:none}
.cta-banner .btn-ghost:hover{background:rgba(255,255,255,.24);filter:none}
@media (max-width:560px){.pricing-hero{padding:36px 22px;border-radius:24px}.pricing-hero h1{font-size:32px}.pricing-hero p{font-size:15px}.pricing-grid{grid-template-columns:minmax(0,1fr);gap:14px}.plan-card{padding:22px 20px}.plan-card.recommended::before{font-size:10px;padding:5px 10px}.plan-card:hover,.plan-card.recommended:hover,.plan-card.enterprise:hover{transform:translateY(-4px) scale(1.02)}.cta-banner{padding:26px 20px;border-radius:22px}.compare-card,.faq-card{padding:22px 18px}}
@media (prefers-reduced-motion:reduce){.plan-card,.compare-card,.faq-card{animation:none}.plan-card.recommended{animation:none}.plan-card:hover,.plan-card.recommended:hover,.plan-card.enterprise:hover{transform:none}}
/* ===== Nav: clearer hierarchy, Pricing promoted ===== */
.nav .nav-link{position:relative;text-decoration:none;font-weight:800;font-size:14px;color:#1f2937;padding:8px 14px;border-radius:999px;transition:color .18s ease,background .18s ease,transform .18s ease}
.nav .nav-link:hover{color:var(--brand);background:rgba(37,211,102,.08);transform:translateY(-1px)}
.nav .nav-link::after{content:"";position:absolute;left:50%;bottom:3px;width:0;height:2px;background:linear-gradient(90deg,#25d366,#128c7e);transform:translateX(-50%);transition:width .22s cubic-bezier(.25,1,.5,1);border-radius:2px}
.nav .nav-link:hover::after{width:60%}
.nav .nav-link-pricing{font-weight:900;color:var(--brand);background:linear-gradient(135deg,rgba(37,211,102,.1),rgba(125,240,173,.18));border:1px solid rgba(37,211,102,.22);box-shadow:0 6px 14px -6px rgba(37,211,102,.28)}
.nav .nav-link-pricing::before{content:"";display:inline-block;width:7px;height:7px;border-radius:999px;background:#25d366;margin-right:6px;vertical-align:middle;box-shadow:0 0 0 0 rgba(37,211,102,.6);animation:pricing-dot 2.4s ease-in-out infinite}
.nav .nav-link-pricing:hover{color:#053b18;background:linear-gradient(135deg,#dcfce7,#7df0ad);border-color:transparent;box-shadow:0 12px 26px -8px rgba(37,211,102,.5);transform:translateY(-2px)}
.nav .nav-link-pricing:hover::after{display:none}
@keyframes pricing-dot{0%,100%{box-shadow:0 0 0 0 rgba(37,211,102,.45)}50%{box-shadow:0 0 0 6px rgba(37,211,102,0)}}
@media (prefers-reduced-motion:reduce){.nav .nav-link-pricing::before{animation:none}}
/* ===== Pricing scroll-reveal (subtle pop-up on scroll, additive only) ===== */
.pricing-reveal{opacity:0;transform:translateY(28px);transition:opacity .65s cubic-bezier(.22,1,.36,1),transform .65s cubic-bezier(.22,1,.36,1);will-change:opacity,transform}
.pricing-reveal.is-visible{opacity:1;transform:translateY(0)}
@media (max-width:560px){.nav .nav-link{padding:7px 11px;font-size:13.5px}.nav .nav-link-pricing{padding:7px 12px}}
@media (prefers-reduced-motion:reduce){.pricing-reveal{opacity:1;transform:none;transition:none}}
/* ===== Pricing polish menu: best-for badge, sizer, currency, trust strip, FAQ chevron, floating CTA ===== */
.plan-card .plan-best-for{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--brand-2);background:linear-gradient(135deg,#dcfce7,#ecfff5);border:1px solid #c7f5d6;padding:5px 10px;border-radius:999px;margin:-2px 0 2px}
.plan-card .plan-best-for span{font-size:14px;line-height:1;color:#25d366}
.plan-card.recommended .plan-best-for{background:linear-gradient(135deg,#bbf7d0,#7df0ad);border-color:transparent;color:#053b18}
.plan-card.enterprise .plan-best-for{background:rgba(125,240,173,.16);border-color:rgba(125,240,173,.3);color:#7df0ad}
.plan-card.enterprise .plan-best-for span{color:#7df0ad}
.plan-card .plan-after-trial{margin:-2px 0 4px;font-size:12.5px;color:var(--muted);font-weight:600}
.plan-card.enterprise .plan-after-trial{color:rgba(220,252,231,.7)}
.plan-card.is-suggested{outline:3px solid rgba(37,211,102,.55);outline-offset:2px;animation:plan-suggest-pulse 1.6s ease-in-out 1}
@keyframes plan-suggest-pulse{0%{outline-color:rgba(37,211,102,0)}40%{outline-color:rgba(37,211,102,.7)}100%{outline-color:rgba(37,211,102,.55)}}
.plan-card .plan-price{transition:transform .22s cubic-bezier(.25,1,.5,1),opacity .22s ease}
.plan-card .plan-price.is-flipping{transform:translateY(-6px) scale(.96);opacity:.0}
/* Floating "Best for your size" callout that pops above a matched plan card. */
.plan-card .plan-suggested-callout{position:absolute;left:50%;top:-46px;transform:translateX(-50%) translateY(8px) scale(.92);display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:14px;background:linear-gradient(135deg,#053b18 0%,#0c7a6e 60%,#128c7e 100%);color:#fff;font-size:12.5px;font-weight:900;letter-spacing:.02em;box-shadow:0 18px 44px -10px rgba(7,68,58,.5),inset 0 1px 0 rgba(255,255,255,.16);white-space:nowrap;opacity:0;pointer-events:none;z-index:10;transition:opacity .35s cubic-bezier(.22,1,.36,1),transform .35s cubic-bezier(.22,1,.36,1)}
.plan-card .plan-suggested-callout::after{content:"";position:absolute;left:50%;bottom:-6px;width:14px;height:14px;background:linear-gradient(135deg,#0c7a6e,#128c7e);transform:translateX(-50%) rotate(45deg);border-radius:2px;box-shadow:6px 6px 12px -4px rgba(7,68,58,.35)}
.plan-card .plan-suggested-callout .callout-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;background:#25d366;color:#053b18;font-size:11px;font-weight:900}
.plan-card.is-suggested .plan-suggested-callout{opacity:1;transform:translateX(-50%) translateY(0) scale(1);animation:callout-bob 2.6s ease-in-out 1.2s infinite}
.plan-card.recommended .plan-suggested-callout{top:-58px}
@keyframes callout-bob{0%,100%{transform:translateX(-50%) translateY(0) scale(1)}50%{transform:translateX(-50%) translateY(-3px) scale(1.02)}}
/* Currency switcher anchored to the top-right corner of the pricing hero. */
.pricing-hero-corner{position:absolute;top:18px;right:18px;display:inline-flex;flex-direction:column;align-items:flex-end;gap:6px;z-index:4}
.pricing-hero-corner .corner-label{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(220,252,231,.78)}
.pricing-currency{display:inline-flex;gap:2px;padding:4px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.26);border-radius:999px;backdrop-filter:saturate(160%) blur(8px);box-shadow:0 10px 24px -10px rgba(0,0,0,.2)}
.pricing-currency button{appearance:none;border:0;background:transparent;color:#ecfdf5;padding:5px 11px;font-size:11.5px;font-weight:800;letter-spacing:.06em;cursor:pointer;border-radius:999px;transition:background .18s ease,color .18s ease,box-shadow .18s ease}
.pricing-currency button.is-active{background:#ffffff;color:#053b18;box-shadow:0 6px 18px -6px rgba(0,0,0,.18)}
.pricing-currency button:hover:not(.is-active){background:rgba(255,255,255,.12)}
/* Room-count sizer redesign — chip pills instead of a dropdown. */
.pricing-sizer{position:relative;display:flex;flex-direction:column;gap:10px;margin-top:22px;padding:16px 18px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:22px;backdrop-filter:saturate(140%) blur(6px);max-width:640px}
.pricing-sizer .sizer-label{font-size:12.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:rgba(220,252,231,.82)}
.sizer-chips{display:flex;flex-wrap:wrap;gap:6px}
.sizer-chips button{appearance:none;cursor:pointer;border:1px solid rgba(255,255,255,.26);background:rgba(255,255,255,.08);color:#ecfdf5;padding:8px 14px;font-size:13px;font-weight:800;letter-spacing:.01em;border-radius:999px;transition:transform .18s cubic-bezier(.25,1,.5,1),background .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease}
.sizer-chips button:hover{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.4);transform:translateY(-1px)}
.sizer-chips button.is-active{background:linear-gradient(135deg,#ffffff,#dcfce7);color:#053b18;border-color:transparent;box-shadow:0 12px 28px -10px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.6)}
.pricing-trust-strip{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px 22px;padding:14px 22px;margin:-22px 0 26px;border-radius:999px;background:linear-gradient(180deg,rgba(255,255,255,.92) 0%,rgba(247,253,250,.92) 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 12px 30px -16px rgba(15,44,38,.1);font-size:13px;color:var(--muted);font-weight:600}
.pricing-trust-strip span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pricing-trust-strip span::before{content:"\\2713";color:#25d366;font-weight:900}
.pricing-trust-strip strong{color:var(--ink);font-weight:800}
/* FAQ chevron: + → × rotation in WhatsApp green */
.faq-item summary::after{content:"+";font-size:24px;color:#25d366;font-weight:700;line-height:1;display:inline-block;transform-origin:center;transition:transform .25s cubic-bezier(.22,1,.36,1),color .2s ease}
.faq-item[open] summary::after{content:"+";transform:rotate(45deg);color:#dc2626}
/* Sticky comparison thead inside its scroll container */
.compare-table-wrap{max-height:75vh;overflow-y:auto}
.compare-table thead th{position:sticky;top:0;z-index:5;backdrop-filter:saturate(160%) blur(6px);box-shadow:0 1px 0 var(--border)}
/* Floating WhatsApp CTA, scoped to the pricing page only */
.pricing-float-cta{position:fixed;right:20px;bottom:20px;z-index:60;display:inline-flex;align-items:center;gap:10px;padding:12px 16px 12px 14px;border-radius:999px;background:linear-gradient(135deg,#25d366 0%,#1bb673 50%,#128c7e 100%);color:#053b18;font-weight:800;font-size:14px;text-decoration:none;box-shadow:0 22px 50px -12px rgba(37,211,102,.55),inset 0 1px 0 rgba(255,255,255,.45);transition:transform .2s cubic-bezier(.25,1,.5,1),box-shadow .2s cubic-bezier(.25,1,.5,1);animation:float-cta-in .6s cubic-bezier(.22,1,.36,1) .8s both}
.pricing-float-cta:hover{transform:translateY(-3px);box-shadow:0 30px 70px -12px rgba(37,211,102,.7),inset 0 1px 0 rgba(255,255,255,.55)}
.pricing-float-cta .float-cta-bubble{width:30px;height:30px;border-radius:999px;background:#ffffff;position:relative;display:inline-block;flex-shrink:0;box-shadow:0 4px 10px -2px rgba(0,0,0,.15)}
.pricing-float-cta .float-cta-bubble::before{content:"";position:absolute;inset:7px;background:linear-gradient(135deg,#25d366,#128c7e);border-radius:50%;mask:radial-gradient(circle at 50% 60%,transparent 38%,#000 39%);}
.pricing-float-cta .float-cta-bubble::after{content:"";position:absolute;left:18px;top:9px;width:4px;height:4px;background:#ffffff;border-radius:50%;box-shadow:-7px 0 0 #ffffff,-3px 0 0 #ffffff}
.pricing-float-cta .float-cta-text{line-height:1.15}
.pricing-float-cta .float-cta-text strong{display:block;font-size:13px;font-weight:900;letter-spacing:.01em}
@keyframes float-cta-in{from{opacity:0;transform:translateY(20px) scale(.92)}to{opacity:1;transform:translateY(0) scale(1)}}
@media (max-width:560px){
  .pricing-hero-corner{position:static;align-items:flex-start;flex-direction:row;justify-content:space-between;width:100%;margin-bottom:14px;gap:10px}
  .pricing-hero-corner .corner-label{display:none}
  .pricing-currency button{padding:5px 9px;font-size:11px}
  .pricing-sizer{padding:14px;border-radius:18px}
  .sizer-chips{gap:6px}
  .sizer-chips button{padding:7px 11px;font-size:12.5px}
  .plan-card .plan-suggested-callout{top:-40px;font-size:11.5px;padding:7px 12px}
  .plan-card.recommended .plan-suggested-callout{top:-50px}
  .pricing-trust-strip{margin-top:-12px;font-size:12px;padding:12px 16px;gap:8px 14px;border-radius:18px}
  .pricing-float-cta{right:14px;bottom:14px;padding:10px 14px 10px 12px;font-size:13px}
  .pricing-float-cta .float-cta-text strong{font-size:12px}
  .compare-table-wrap{max-height:none}
  .compare-table thead th{position:static}
}
@media (prefers-reduced-motion:reduce){
  .plan-card.is-suggested{animation:none}
  .plan-card .plan-price.is-flipping{transform:none}
  .plan-card.is-suggested .plan-suggested-callout{animation:none;transform:translateX(-50%) translateY(0) scale(1)}
  .pricing-float-cta{animation:none}
}
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
        <a class="nav-link" href="/search">Search</a>
        <a class="nav-link nav-link-pricing" href="/pricing">Pricing</a>
        <a class="nav-pill hotel" href="/admin/login">Hotel / Partner Extranet</a>
        <a class="nav-pill traveller" href="/guest/account">Traveller Account</a>
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
// =============================================================================
// GET /pricing — public subscription / plans page
// =============================================================================
// Frontend-only. Plans are presentational text rendered by the same shell
// (renderShell) every other public page uses, so it inherits the brand nav,
// styles, and accessibility chrome. CTAs deep-link to existing flows:
//   • "Start Free Trial" → /admin/onboard (real tenant signup)
//   • "Request Demo"     → wa.me with a pre-filled message
//   • "Contact Sales"    → mailto:
// No Prisma schema changes; no fake billing logic.
type PricingPlan = {
  id: "starter" | "growth" | "pro" | "enterprise";
  name: string;
  tagline: string;
  bestFor: string;
  monthly: number | null; // OMR / month, or null for custom
  legacyMonthly?: number | null;
  features: string[];
  ctaLabel: string;
  ctaHref: string;
  ctaClass: string;
  secondaryCtaLabel?: string;
  secondaryCtaHref?: string;
  recommended?: boolean;
  variant?: "enterprise";
  // Sizing hint used by the room-count helper to recommend a plan.
  sizeFloor: number; // matches "I have N rooms" >= sizeFloor → eligible
};

const PRICING_PLANS: PricingPlan[] = [
  {
    id: "starter",
    name: "Starter",
    tagline: "Small guesthouses & boutique hotels",
    bestFor: "Up to 30 rooms",
    sizeFloor: 0,
    monthly: 19,
    legacyMonthly: 29,
    features: [
      "Basic PMS (room rack, reservations, check-in / out)",
      "WhatsApp booking assistant for direct bookings",
      "Room types, rates & availability management",
      "Guest profiles with stay history",
      "Email & business-hours support"
    ],
    ctaLabel: "Start Free Trial",
    ctaHref: "/admin/onboard",
    ctaClass: "btn btn-primary"
  },
  {
    id: "growth",
    name: "Growth",
    tagline: "Growing hotels with restaurant & housekeeping",
    bestFor: "30 – 80 rooms",
    sizeFloor: 30,
    monthly: 49,
    legacyMonthly: 69,
    features: [
      "Everything in Starter",
      "Restaurant / Café module (menu, KOT, folio posting)",
      "Housekeeping tasks & SLA board",
      "WhatsApp in-stay service requests",
      "Reports center & guest review collection"
    ],
    ctaLabel: "Start Free Trial",
    ctaHref: "/admin/onboard",
    ctaClass: "btn btn-primary",
    recommended: true
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "Multi-department resorts & serious operators",
    bestFor: "80+ rooms · multi-dept",
    sizeFloor: 80,
    monthly: 99,
    legacyMonthly: 129,
    features: [
      "Everything in Growth",
      "Advanced PMS ops (folio adjustments, voids, refunds)",
      "Multi-property readiness",
      "Staff roles, permissions & audit trail",
      "Advanced analytics & AI automation",
      "Priority WhatsApp support"
    ],
    ctaLabel: "Start Free Trial",
    ctaHref: "/admin/onboard",
    ctaClass: "btn btn-primary"
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "Hotel chains & large operators",
    bestFor: "Chains · multi-property",
    sizeFloor: 200,
    monthly: null,
    features: [
      "Everything in Pro",
      "Multi-property management & central inventory",
      "Custom integrations (PMS, channel manager, OTAs)",
      "Dedicated onboarding & training",
      "Advanced permissions & SSO-ready",
      "SLA-backed support with named CSM"
    ],
    ctaLabel: "Contact Sales",
    ctaHref: "mailto:sales@chatastay.com?subject=ChatAstay%20Enterprise%20enquiry",
    ctaClass: "btn btn-whatsapp",
    secondaryCtaLabel: "Request Demo",
    secondaryCtaHref:
      "https://wa.me/?text=" +
      encodeURIComponent("Hi ChatAstay, I'd like a demo of the Enterprise plan."),
    variant: "enterprise"
  }
];

// Static FX rates relative to OMR. Clearly labelled "approx" in the UI so
// nobody confuses these with live rates. Update annually.
const PRICING_CURRENCY: { code: "OMR" | "USD" | "AED" | "SAR"; symbol: string; perOmr: number; round: number }[] = [
  { code: "OMR", symbol: "OMR", perOmr: 1,    round: 1 },
  { code: "USD", symbol: "USD", perOmr: 2.6,  round: 1 },
  { code: "AED", symbol: "AED", perOmr: 9.55, round: 5 },
  { code: "SAR", symbol: "SAR", perOmr: 9.75, round: 5 }
];

const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "Can I switch plans later?",
    a: "Yes. You can upgrade or downgrade at any time from your hotel admin. Upgrades are immediate and prorated; downgrades take effect at the end of the current billing period."
  },
  {
    q: "Is there a free trial?",
    a: "Every paid plan starts with a 14-day free trial — no credit card required. You can sign up, connect your WhatsApp number, and onboard your team before deciding."
  },
  {
    q: "Do you support WhatsApp Business / Cloud API?",
    a: "Yes. ChatAstay is WhatsApp-first. You connect your WhatsApp Cloud API number once and the assistant, in-stay menus, and review requests work for every booking — direct, OTA, or marketplace."
  },
  {
    q: "Will my staff need training?",
    a: "Most teams are live the same day. Front desk, housekeeping, and restaurant staff each get a focused workspace with only the tabs they need. Pro and Enterprise plans include guided onboarding sessions."
  },
  {
    q: "What about payments and invoicing?",
    a: "ChatAstay supports cash, card, Stripe, and Thawani out of the box. Invoices are issued automatically once a folio is fully settled, and outstanding balances surface on the front-desk dashboard."
  },
  {
    q: "Can I migrate from another PMS?",
    a: "Yes. Growth, Pro, and Enterprise plans include guided data import (rooms, rates, guests, future bookings). Our team handles the heavy lifting so you can switch without losing reservations."
  }
];

function renderPricingPlanCard(plan: PricingPlan): string {
  const classes = ["plan-card"];
  if (plan.recommended) classes.push("recommended");
  if (plan.variant === "enterprise") classes.push("enterprise");
  // data-monthly-omr lets the client-side JS recompute prices accurately for
  // the active currency + cadence without parsing rendered text.
  const priceHtml =
    plan.monthly == null
      ? `<div class="plan-price custom" data-custom="1"><span class="plan-price-value">Custom</span></div>`
      : `<div class="plan-price" data-monthly-omr="${plan.monthly}"${
          plan.legacyMonthly && plan.legacyMonthly > plan.monthly
            ? ` data-legacy-omr="${plan.legacyMonthly}"`
            : ""
        }>${
          plan.legacyMonthly && plan.legacyMonthly > plan.monthly
            ? `<span class="legacy">${plan.legacyMonthly} OMR</span>`
            : ""
        }<span class="plan-price-value">${plan.monthly} OMR</span><small class="plan-price-cadence">/ month</small></div>`;
  const featuresHtml = plan.features.map((f) => `<li>${escapeHtml(f)}</li>`).join("");
  const secondaryCta =
    plan.secondaryCtaLabel && plan.secondaryCtaHref
      ? `<a class="secondary-cta" href="${escapeHtml(plan.secondaryCtaHref)}"${plan.secondaryCtaHref.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>${escapeHtml(plan.secondaryCtaLabel)}</a>`
      : "";
  const trialHint = plan.monthly == null
    ? `<p class="plan-after-trial">Custom pricing &middot; tailored to your portfolio</p>`
    : `<p class="plan-after-trial">14-day free trial &middot; cancel anytime</p>`;
  return `<article class="${classes.join(" ")}" data-plan="${escapeHtml(plan.id)}" data-size-floor="${plan.sizeFloor}">
    <aside class="plan-suggested-callout" role="status" aria-live="polite" aria-hidden="true">
      <span class="callout-icon" aria-hidden="true">&#10003;</span>
      <span class="callout-text">Best for your hotel size</span>
    </aside>
    <p class="plan-name">${escapeHtml(plan.name)}</p>
    <p class="plan-tag">${escapeHtml(plan.tagline)}</p>
    <p class="plan-best-for"><span aria-hidden="true">&#9678;</span>${escapeHtml(plan.bestFor)}</p>
    ${priceHtml}
    ${trialHint}
    <ul>${featuresHtml}</ul>
    <div class="plan-cta">
      <a class="${escapeHtml(plan.ctaClass)}" href="${escapeHtml(plan.ctaHref)}"${plan.ctaHref.startsWith("http") || plan.ctaHref.startsWith("mailto:") ? ' rel="noopener"' : ""}>${escapeHtml(plan.ctaLabel)}</a>
      ${secondaryCta}
    </div>
  </article>`;
}

function renderPricingComparisonTable(): string {
  // Display-only comparison. Add new rows here without touching the route.
  const rows: { label: string; values: [string | boolean, string | boolean, string | boolean, string | boolean] }[] = [
    { label: "WhatsApp booking assistant", values: [true, true, true, true] },
    { label: "Room rack & reservations", values: [true, true, true, true] },
    { label: "Restaurant / Café module", values: [false, true, true, true] },
    { label: "Housekeeping SLA board", values: [false, true, true, true] },
    { label: "In-stay WhatsApp services", values: [false, true, true, true] },
    { label: "Reports & guest reviews", values: ["Basic", true, true, true] },
    { label: "Staff roles & permissions", values: ["1 admin", "Up to 5", "Unlimited", "Unlimited + SSO"] },
    { label: "Multi-property", values: [false, false, "Ready", true] },
    { label: "AI automation", values: [false, false, true, true] },
    { label: "Priority support", values: [false, false, true, "SLA + named CSM"] },
    { label: "Custom integrations", values: [false, false, false, true] }
  ];
  const cellHtml = (v: string | boolean) =>
    v === true
      ? '<span class="yes" aria-label="Included">✓</span>'
      : v === false
        ? '<span class="no" aria-label="Not included">—</span>'
        : `<span>${escapeHtml(String(v))}</span>`;
  const body = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.label)}</td>
        <td>${cellHtml(r.values[0])}</td>
        <td class="recommended-col">${cellHtml(r.values[1])}</td>
        <td>${cellHtml(r.values[2])}</td>
        <td>${cellHtml(r.values[3])}</td>
      </tr>`
    )
    .join("");
  return `<div class="compare-table-wrap">
    <table class="compare-table">
      <thead>
        <tr>
          <th>Feature</th>
          <th>Starter</th>
          <th class="recommended-col">Growth</th>
          <th>Pro</th>
          <th>Enterprise</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function renderPricingFaq(): string {
  const items = PRICING_FAQ.map(
    (f, i) => `<details class="faq-item"${i === 0 ? " open" : ""}>
      <summary>${escapeHtml(f.q)}</summary>
      <div class="answer">${escapeHtml(f.a)}</div>
    </details>`
  ).join("");
  return `<div class="faq-list">${items}</div>`;
}

marketplaceRouter.get("/pricing", (_req: Request, res: Response) => {
  const planCardsHtml = PRICING_PLANS.map(renderPricingPlanCard).join("");

  // Currency buttons rendered server-side so they appear before JS hydrates.
  const currencyButtonsHtml = PRICING_CURRENCY.map(
    (c, i) =>
      `<button type="button" data-currency="${c.code}" class="${i === 0 ? "is-active" : ""}" aria-pressed="${i === 0 ? "true" : "false"}">${c.code}</button>`
  ).join("");

  // Sizer chips: friendly labels with a numeric "rooms" value the JS reads off
  // each chip's data-rooms attribute. Replaces the old dropdown for a more
  // elegant pill-based picker that matches the page aesthetic.
  const sizerChipsHtml = [
    { rooms: 12, label: "Up to 20" },
    { rooms: 30, label: "21 – 50" },
    { rooms: 80, label: "51 – 120" },
    { rooms: 200, label: "120+" },
    { rooms: 999, label: "Multi-property" }
  ]
    .map(
      (o) =>
        `<button type="button" data-rooms="${o.rooms}" aria-pressed="false">${escapeHtml(o.label)}</button>`
    )
    .join("");

  // JSON-LD: emit one Product per plan with an Offer. Helps Google rich
  // results and AI crawlers index pricing accurately. Static, no PII.
  const jsonLdItems = PRICING_PLANS.filter((p) => p.monthly != null).map((plan, idx) => ({
    "@context": "https://schema.org",
    "@type": "Product",
    name: `ChatAstay ${plan.name}`,
    description: `${plan.tagline}. ${plan.bestFor}.`,
    brand: { "@type": "Brand", name: "ChatAstay" },
    category: "SoftwareApplication",
    offers: {
      "@type": "Offer",
      url: "https://chatastay.com/pricing",
      priceCurrency: "OMR",
      price: String(plan.monthly),
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: String(plan.monthly),
        priceCurrency: "OMR",
        unitCode: "MON",
        billingDuration: "P1M"
      },
      availability: "https://schema.org/InStock",
      itemOffered: {
        "@type": "Service",
        name: `ChatAstay ${plan.name} subscription`,
        serviceType: "Hospitality SaaS"
      }
    },
    position: idx + 1
  }));
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: jsonLdItems.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: p
    }))
  }).replace(/</g, "\\u003c");

  const body = `
    <section class="pricing-hero">
      <div class="pricing-hero-corner" aria-label="Display currency selector">
        <span class="corner-label">Show prices in</span>
        <div class="pricing-currency" role="tablist" aria-label="Display currency">
          ${currencyButtonsHtml}
        </div>
      </div>
      <span class="eyebrow">Pricing</span>
      <h1>Plans that grow with your hotel</h1>
      <p>Built for WhatsApp-first hotel operations. From a single boutique to a multi-property chain — pick the plan that fits today and upgrade in a click.</p>
      <div class="trust-row">
        <span class="trust-pill">14-day free trial</span>
        <span class="trust-pill">No credit card required</span>
        <span class="trust-pill">Cancel anytime</span>
        <span class="trust-pill">Setup in under a day</span>
      </div>
      <div class="pricing-toggle" role="tablist" aria-label="Billing cadence">
        <button type="button" role="tab" data-cadence="monthly" class="is-active" aria-pressed="true" aria-selected="true" tabindex="0">Monthly</button>
        <button type="button" role="tab" data-cadence="annual" aria-pressed="false" aria-selected="false" tabindex="-1">Annual <span class="save-flag">Save 20%</span></button>
      </div>
      <div class="pricing-sizer">
        <span class="sizer-label">How many rooms do you have?</span>
        <div class="sizer-chips" role="tablist" aria-label="Hotel size">
          ${sizerChipsHtml}
        </div>
      </div>
    </section>

    <div class="pricing-trust-strip pricing-reveal" role="list">
      <span role="listitem"><strong>Trusted by hotels</strong> in Oman, Saudi, UAE</span>
      <span role="listitem">PCI-aware payments &middot; Stripe &amp; Thawani</span>
      <span role="listitem">Daily encrypted backups</span>
      <span role="listitem">GDPR-friendly data handling</span>
    </div>

    <div class="pricing-grid">
      ${planCardsHtml}
    </div>

    <section class="card compare-card pricing-reveal">
      <h2>Compare every feature</h2>
      <p class="lead">All plans include the WhatsApp assistant, secure data hosting, and lifetime product updates. Scroll horizontally on small screens.</p>
      ${renderPricingComparisonTable()}
    </section>

    <section class="card faq-card pricing-reveal">
      <h2>Frequently asked</h2>
      <p class="lead">Quick answers about trials, plan changes, and onboarding.</p>
      ${renderPricingFaq()}
    </section>

    <section class="cta-banner pricing-reveal">
      <div>
        <h3>Ready to run your hotel on WhatsApp?</h3>
        <p>Start your free 14-day trial — bring your team, connect your WhatsApp number, and we'll help you import your rooms and rates.</p>
      </div>
      <div class="cta-actions">
        <a class="btn btn-whatsapp" href="/admin/onboard">Start Free Trial</a>
        <a class="btn btn-ghost" href="https://wa.me/?text=${encodeURIComponent(
          "Hi ChatAstay, I'd like to request a product demo."
        )}" target="_blank" rel="noopener">Request Demo</a>
        <a class="btn btn-ghost" href="mailto:sales@chatastay.com?subject=ChatAstay%20Sales%20enquiry">Contact Sales</a>
      </div>
    </section>

    <a class="pricing-float-cta" href="https://wa.me/?text=${encodeURIComponent(
      "Hi ChatAstay, I have a pricing question."
    )}" target="_blank" rel="noopener" aria-label="Talk to ChatAstay on WhatsApp">
      <span class="float-cta-bubble" aria-hidden="true"></span>
      <span class="float-cta-text">Pricing question? <strong>Chat with us</strong></span>
    </a>
  `;

  // FX rates are inlined into the script so we don't need a network call.
  // Keep these in sync with PRICING_CURRENCY above.
  const fxJson = JSON.stringify(
    PRICING_CURRENCY.reduce<Record<string, { symbol: string; perOmr: number; round: number }>>((acc, c) => {
      acc[c.code] = { symbol: c.symbol, perOmr: c.perOmr, round: c.round };
      return acc;
    }, {})
  );

  // One inline script handles: cadence toggle (with persistence + keyboard +
  // animated swap), currency switching, the room-count sizer, and the
  // existing scroll-reveal observer. All purely client-side.
  const inlineScript = `
    (function(){
      var FX = ${fxJson};
      var STORE_KEY_CADENCE = 'chatastay.pricing.cadence';
      var STORE_KEY_CURRENCY = 'chatastay.pricing.currency';
      var ANNUAL_DISCOUNT = 0.8; // 20% off
      var safeStorage = (function(){
        try { var k='__cs_t'; localStorage.setItem(k,'1'); localStorage.removeItem(k); return localStorage; }
        catch(e){ return null; }
      })();
      function readPref(key, fallback){
        if (!safeStorage) return fallback;
        try { var v = safeStorage.getItem(key); return v == null ? fallback : v; } catch(e){ return fallback; }
      }
      function writePref(key, value){
        if (!safeStorage) return;
        try { safeStorage.setItem(key, value); } catch(e){ /* quota exceeded, ignore */ }
      }
      function roundTo(value, step){
        if (step <= 1) return Math.round(value);
        return Math.round(value / step) * step;
      }
      function formatPrice(omrMonthly, currency, cadence){
        var fx = FX[currency] || FX.OMR;
        var amount = omrMonthly * fx.perOmr;
        if (cadence === 'annual') amount = amount * 12 * ANNUAL_DISCOUNT;
        return roundTo(amount, fx.round) + ' ' + fx.symbol;
      }
      function cadenceSuffix(cadence){
        return cadence === 'annual' ? '/ year (Save 20%)' : '/ month';
      }

      var state = {
        cadence: readPref(STORE_KEY_CADENCE, 'monthly') === 'annual' ? 'annual' : 'monthly',
        currency: (function(){ var c = readPref(STORE_KEY_CURRENCY, 'OMR'); return FX[c] ? c : 'OMR'; })()
      };

      var prices = Array.prototype.slice.call(document.querySelectorAll('.plan-card .plan-price'));
      var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      function rerenderAllPrices(animate){
        prices.forEach(function(el){
          if (el.dataset.custom === '1') return;
          var omr = parseFloat(el.dataset.monthlyOmr || '0');
          if (!omr) return;
          var legacyOmr = parseFloat(el.dataset.legacyOmr || '0');
          var newPrice = formatPrice(omr, state.currency, state.cadence);
          var newSuffix = cadenceSuffix(state.cadence);
          var legacyHtml = '';
          if (legacyOmr && legacyOmr > omr && state.cadence === 'monthly') {
            legacyHtml = '<span class="legacy">' + formatPrice(legacyOmr, state.currency, 'monthly') + '</span>';
          }
          var html = legacyHtml +
            '<span class="plan-price-value">' + newPrice + '</span>' +
            '<small class="plan-price-cadence">' + newSuffix + '</small>';
          if (animate && !prefersReduced) {
            el.classList.remove('is-flipping');
            void el.offsetWidth; // restart transition
            el.classList.add('is-flipping');
            setTimeout(function(){ el.innerHTML = html; }, 110);
            setTimeout(function(){ el.classList.remove('is-flipping'); }, 320);
          } else {
            el.innerHTML = html;
          }
        });
      }

      function setCadence(cadence, animate){
        state.cadence = cadence;
        writePref(STORE_KEY_CADENCE, cadence);
        var btns = document.querySelectorAll('.pricing-toggle button');
        Array.prototype.forEach.call(btns, function(b){
          var isActive = b.getAttribute('data-cadence') === cadence;
          b.classList.toggle('is-active', isActive);
          b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
          b.setAttribute('aria-selected', isActive ? 'true' : 'false');
          b.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        rerenderAllPrices(animate);
      }

      function setCurrency(code, animate){
        if (!FX[code]) return;
        state.currency = code;
        writePref(STORE_KEY_CURRENCY, code);
        var btns = document.querySelectorAll('.pricing-currency button');
        Array.prototype.forEach.call(btns, function(b){
          var isActive = b.getAttribute('data-currency') === code;
          b.classList.toggle('is-active', isActive);
          b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        rerenderAllPrices(animate);
      }

      // Wire up cadence buttons (click + keyboard arrow nav).
      var toggle = document.querySelector('.pricing-toggle');
      if (toggle) {
        var cadenceBtns = Array.prototype.slice.call(toggle.querySelectorAll('button'));
        cadenceBtns.forEach(function(btn){
          btn.addEventListener('click', function(){ setCadence(btn.getAttribute('data-cadence'), true); btn.focus(); });
          btn.addEventListener('keydown', function(e){
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              var nextIdx = (cadenceBtns.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : -1) + cadenceBtns.length) % cadenceBtns.length;
              cadenceBtns[nextIdx].focus();
              setCadence(cadenceBtns[nextIdx].getAttribute('data-cadence'), true);
            }
          });
        });
      }

      // Wire up currency buttons.
      var currencyBar = document.querySelector('.pricing-currency');
      if (currencyBar) {
        var ccBtns = Array.prototype.slice.call(currencyBar.querySelectorAll('button'));
        ccBtns.forEach(function(btn){
          btn.addEventListener('click', function(){ setCurrency(btn.getAttribute('data-currency'), true); btn.focus(); });
          btn.addEventListener('keydown', function(e){
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              var nextIdx = (ccBtns.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : -1) + ccBtns.length) % ccBtns.length;
              ccBtns[nextIdx].focus();
              setCurrency(ccBtns[nextIdx].getAttribute('data-currency'), true);
            }
          });
        });
      }

      // Initial paint reflects persisted preferences (no animation on load).
      setCadence(state.cadence, false);
      setCurrency(state.currency, false);

      // Room-count sizer (chip selector). Highlights the highest-tier plan
      // whose sizeFloor <= rooms (so 5 rooms → Starter, 50 → Growth, 90 →
      // Pro, 250 → Enterprise) and pops a callout above the matched card.
      var sizerChips = Array.prototype.slice.call(document.querySelectorAll('.sizer-chips button'));
      if (sizerChips.length) {
        sizerChips.forEach(function(chip){
          chip.addEventListener('click', function(){
            var rooms = parseInt(chip.getAttribute('data-rooms') || '0', 10);
            sizerChips.forEach(function(c){
              var isActive = c === chip;
              c.classList.toggle('is-active', isActive);
              c.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });
            if (rooms <= 0) return;
            var cards = Array.prototype.slice.call(document.querySelectorAll('.plan-card'));
            var match = null;
            cards.forEach(function(card){
              var floor = parseInt(card.getAttribute('data-size-floor') || '0', 10);
              if (rooms >= floor) match = card;
              card.classList.remove('is-suggested');
              var co = card.querySelector('.plan-suggested-callout');
              if (co) co.setAttribute('aria-hidden', 'true');
            });
            if (match) {
              match.classList.add('is-suggested');
              var co = match.querySelector('.plan-suggested-callout');
              if (co) co.setAttribute('aria-hidden', 'false');
              if (!prefersReduced && match.scrollIntoView) {
                match.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }
          });
        });
      }
    })();

    (function(){
      var targets = document.querySelectorAll('.pricing-reveal');
      if (!targets.length) return;
      var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced || typeof IntersectionObserver === 'undefined') {
        Array.prototype.forEach.call(targets, function(el){ el.classList.add('is-visible'); });
        return;
      }
      var io = new IntersectionObserver(function(entries){
        entries.forEach(function(entry){
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      Array.prototype.forEach.call(targets, function(el){ io.observe(el); });
    })();
  `;

  res.type("html").send(
    renderShell({
      title: "Pricing — ChatAstay",
      meta: {
        description:
          "ChatAstay subscription plans for hotels — Starter, Growth, Pro, and Enterprise. Built for WhatsApp-first hotel operations."
      },
      body:
        body +
        `<script type="application/ld+json">${jsonLd}</script>` +
        `<script>${inlineScript}</script>`
    })
  );
});

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
