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
import { listKnowledgeEntries, listPolicies } from "../core/propertyKnowledge";

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
/* ===== Cursor hygiene: text containers use the default arrow; only true interactives use pointer/text. ===== */
.pricing-hero,.pricing-hero *,.pricing-grid,.pricing-grid *,.compare-card,.compare-card *,.faq-card,.faq-card *,.cta-banner,.cta-banner *,.pricing-trust-strip,.pricing-trust-strip *,.pricing-sizer,.pricing-sizer *,.pricing-toggle,.pricing-toggle *,.pricing-currency,.pricing-currency *,.pricing-hero-corner,.pricing-hero-corner *{cursor:default}
.pricing-hero a,.pricing-hero button,.plan-card a,.plan-card button,.compare-card a,.compare-card button,.faq-card a,.faq-card button,.faq-item summary,.cta-banner a,.cta-banner button,.pricing-currency button,.sizer-chips button,.pricing-toggle button,.pricing-float-cta,.stayli-launcher,.stayli-panel button{cursor:pointer}
.stayli-input{cursor:text}
/* ===== Stayli — pricing chat assistant ===== */
.stayli-launcher{cursor:pointer}
.stayli-launcher.is-stayli-open{transform:translateY(20px) scale(.92);opacity:0;pointer-events:none}
.stayli-panel{position:fixed;right:20px;bottom:20px;z-index:65;width:360px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:linear-gradient(180deg,#ffffff 0%,#f7fdfa 100%);border-radius:24px;box-shadow:0 32px 80px -12px rgba(7,68,58,.45),0 0 0 1px rgba(220,232,227,.6);overflow:hidden;opacity:0;transform:translateY(20px) scale(.96);pointer-events:none;transition:opacity .3s cubic-bezier(.22,1,.36,1),transform .3s cubic-bezier(.22,1,.36,1)}
.stayli-panel.is-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.stayli-header{display:flex;align-items:center;gap:12px;padding:14px 16px;background:linear-gradient(135deg,#053b34 0%,#0c7a6e 50%,#128c7e 100%);color:#fff;flex-shrink:0}
.stayli-avatar{width:38px;height:38px;border-radius:999px;background:linear-gradient(135deg,#25d366,#7df0ad);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 6px 14px -4px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.5);flex-shrink:0;cursor:default;overflow:visible}
.stayli-avatar .stayli-bot{width:30px;height:30px;display:block;overflow:visible}
.stayli-avatar .stayli-eye{transform-box:fill-box;transform-origin:center;animation:stayli-blink 5.4s ease-in-out infinite}
.stayli-avatar .stayli-eye-r{animation-delay:.04s}
@keyframes stayli-blink{0%,92%,100%{transform:scaleY(1)}94%{transform:scaleY(.12)}96%{transform:scaleY(1)}}
.stayli-id{flex:1;min-width:0;cursor:default}
.stayli-id .stayli-name{margin:0;font-weight:900;font-size:15px;letter-spacing:-.01em;line-height:1.1}
.stayli-id .stayli-status{margin:2px 0 0;font-size:11.5px;opacity:.88;font-weight:600;display:flex;align-items:center;gap:6px}
.stayli-dot{width:7px;height:7px;border-radius:999px;background:#7df0ad;display:inline-block;animation:stayli-pulse 1.6s ease-in-out infinite}
@keyframes stayli-pulse{0%,100%{box-shadow:0 0 0 0 rgba(125,240,173,.65)}50%{box-shadow:0 0 0 5px rgba(125,240,173,0)}}
.stayli-close{appearance:none;border:0;background:rgba(255,255,255,.14);color:#fff;width:30px;height:30px;border-radius:999px;font-size:22px;line-height:1;font-weight:600;display:inline-flex;align-items:center;justify-content:center;transition:background .15s ease,transform .15s ease;flex-shrink:0;cursor:pointer}
.stayli-close:hover{background:rgba(255,255,255,.24);transform:rotate(90deg)}
.stayli-body{flex:1;overflow-y:auto;padding:14px 14px 8px;background:linear-gradient(180deg,#f6fcf9 0%,#ecf7f1 100%);display:flex;flex-direction:column;gap:8px;cursor:default}
.stayli-msg{max-width:85%;padding:10px 14px;border-radius:16px;font-size:13.5px;line-height:1.5;animation:stayli-msg-in .26s cubic-bezier(.22,1,.36,1) both;cursor:default;word-wrap:break-word;overflow-wrap:break-word}
@keyframes stayli-msg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.stayli-msg.bot{align-self:flex-start;background:#ffffff;color:var(--ink);border:1px solid rgba(220,232,227,.85);border-top-left-radius:6px;box-shadow:0 4px 10px -4px rgba(15,44,38,.1)}
.stayli-msg.user{align-self:flex-end;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;border-top-right-radius:6px;box-shadow:0 8px 18px -8px rgba(37,211,102,.45)}
.stayli-msg.bot.typing{display:inline-flex;align-items:center;gap:5px;padding:12px 14px;width:fit-content}
.stayli-msg.bot.typing span{width:6px;height:6px;border-radius:999px;background:#94a3b8;animation:stayli-typing 1.2s ease-in-out infinite}
.stayli-msg.bot.typing span:nth-child(2){animation-delay:.15s}
.stayli-msg.bot.typing span:nth-child(3){animation-delay:.3s}
@keyframes stayli-typing{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
.stayli-quick-replies{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 4px;background:linear-gradient(180deg,rgba(236,247,241,.0) 0%,rgba(255,255,255,.85) 100%)}
.stayli-quick-replies button{appearance:none;cursor:pointer;padding:6px 12px;font-size:11.5px;font-weight:800;border:1px solid rgba(37,211,102,.35);background:rgba(37,211,102,.08);color:var(--brand-2);border-radius:999px;transition:background .15s ease,transform .15s ease,border-color .15s ease;white-space:nowrap}
.stayli-quick-replies button:hover{background:rgba(37,211,102,.18);border-color:rgba(37,211,102,.6);transform:translateY(-1px)}
.stayli-input-form{display:flex;gap:6px;padding:10px 12px 12px;border-top:1px solid rgba(220,232,227,.6);background:#ffffff;flex-shrink:0}
.stayli-input{flex:1;border:1px solid rgba(220,232,227,.85);border-radius:999px;padding:9px 14px;font-size:13.5px;outline:0;font-family:inherit;color:var(--ink);transition:border-color .15s ease,box-shadow .15s ease;cursor:text}
.stayli-input:focus{border-color:#25d366;box-shadow:0 0 0 3px rgba(37,211,102,.2)}
.stayli-send{appearance:none;border:0;width:38px;height:38px;border-radius:999px;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;font-size:16px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease;flex-shrink:0;cursor:pointer}
.stayli-send:hover{transform:translateY(-1px) translateX(1px);box-shadow:0 8px 18px -6px rgba(37,211,102,.55)}
.stayli-send:active{transform:translateY(0)}
@media (max-width:560px){
  .stayli-panel{right:12px;bottom:12px;width:calc(100vw - 24px);height:calc(100dvh - 100px);max-height:calc(100dvh - 100px);border-radius:20px}
  .stayli-quick-replies button{font-size:11px;padding:5px 10px}
}
@media (prefers-reduced-motion:reduce){
  .stayli-panel{transition:opacity .15s ease;transform:none}
  .stayli-msg{animation:none}
  .stayli-dot{animation:none}
  .stayli-msg.bot.typing span{animation:none;opacity:.5}
  .stayli-avatar .stayli-eye{animation:none}
}
/* ===== Marketplace home additive sections (how-it-works, destinations, value props, sample chat, partner CTA, footer, hero motif, designed card cover) ===== */
.home-reveal{opacity:0;transform:translateY(28px);transition:opacity .65s cubic-bezier(.22,1,.36,1),transform .65s cubic-bezier(.22,1,.36,1);will-change:opacity,transform}
.home-reveal.is-visible{opacity:1;transform:translateY(0)}
.home-section-eyebrow{display:inline-block;font-size:11.5px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:var(--brand-2);background:linear-gradient(135deg,#dcfce7,#ecfff5);padding:6px 12px;border-radius:999px;margin:0 0 10px;border:1px solid #c7f5d6}
.home-section-title{margin:0 0 6px;font-size:clamp(22px,3vw,30px);letter-spacing:-.025em;color:var(--ink)}
.home-section-lead{margin:0 0 18px;color:var(--muted);font-size:15.5px;max-width:640px;line-height:1.6}
/* Hero floating chat-bubble motif (C2) */
.hero-bubbles{position:absolute;inset:0;pointer-events:none;z-index:0;overflow:hidden;border-radius:inherit}
.hero-bubbles svg{position:absolute;color:rgba(255,255,255,.16);filter:drop-shadow(0 6px 18px rgba(0,0,0,.18))}
.hero-bubbles .b1{top:18%;right:8%;width:64px;height:64px;animation:hero-bub 5.6s ease-in-out infinite}
.hero-bubbles .b2{top:48%;right:22%;width:42px;height:42px;animation:hero-bub 5.6s ease-in-out .8s infinite}
.hero-bubbles .b3{top:9%;right:30%;width:30px;height:30px;animation:hero-bub 5.6s ease-in-out 1.6s infinite}
@keyframes hero-bub{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-6px) rotate(4deg)}}
.hero h1,.hero p,.hero .search-form{position:relative;z-index:2}
@media (max-width:760px){.hero-bubbles{display:none}}
/* Popular destinations chip row (A2) */
.destinations-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:18px 0 22px;padding:14px 18px;background:linear-gradient(180deg,rgba(255,255,255,.92) 0%,rgba(247,253,250,.92) 100%);border:1px solid rgba(220,232,227,.85);border-radius:999px;box-shadow:0 14px 30px -16px rgba(15,44,38,.1)}
.destinations-row .destinations-label{font-size:11.5px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:var(--brand-2);margin-right:4px}
.destinations-row a{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:800;font-size:13px;color:var(--ink);background:rgba(37,211,102,.08);border:1px solid rgba(37,211,102,.22);padding:7px 13px;border-radius:999px;transition:transform .18s cubic-bezier(.25,1,.5,1),background .18s ease,box-shadow .18s ease,color .18s ease}
.destinations-row a:hover{background:linear-gradient(135deg,#dcfce7,#7df0ad);color:#053b18;transform:translateY(-1px);box-shadow:0 10px 22px -8px rgba(37,211,102,.5)}
.destinations-row a::before{content:"";display:inline-block;width:6px;height:6px;border-radius:999px;background:#25d366;box-shadow:0 0 0 2px rgba(37,211,102,.18)}
@media (max-width:560px){.destinations-row{border-radius:22px;padding:12px 14px;gap:8px}.destinations-row a{font-size:12.5px;padding:6px 11px}}
/* How it works strip (A1) */
.how-it-works{margin:32px 0 28px}
.how-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:6px}
.how-card{position:relative;padding:24px 22px 22px;border-radius:22px;background:linear-gradient(180deg,#ffffff 0%,#f7fdfa 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 14px 36px -16px rgba(15,44,38,.14),inset 0 1px 0 rgba(255,255,255,.85);transition:transform .26s cubic-bezier(.25,1,.5,1),box-shadow .26s cubic-bezier(.25,1,.5,1)}
.how-card:hover{transform:translateY(-4px);box-shadow:0 24px 56px -16px rgba(7,68,58,.22)}
.how-card .how-icon{width:46px;height:46px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#25d366,#7df0ad);color:#053b18;box-shadow:0 10px 22px -6px rgba(37,211,102,.35),inset 0 1px 0 rgba(255,255,255,.5);margin-bottom:14px}
.how-card .how-icon svg{width:24px;height:24px}
.how-card .how-step{position:absolute;top:18px;right:18px;font-size:11.5px;font-weight:900;letter-spacing:.08em;color:rgba(7,68,58,.36);text-transform:uppercase}
.how-card h3{margin:0 0 6px;font-size:17px;letter-spacing:-.02em}
.how-card p{margin:0;color:var(--muted);font-size:14px;line-height:1.6}
/* Why ChatAstay value props (A3) */
.value-props-home{margin:36px 0 28px}
.vp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:6px}
.vp-card{padding:22px 22px 20px;border-radius:22px;background:linear-gradient(180deg,#ffffff 0%,#f7fdfa 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 14px 36px -16px rgba(15,44,38,.14);transition:transform .26s cubic-bezier(.25,1,.5,1),box-shadow .26s cubic-bezier(.25,1,.5,1)}
.vp-card:hover{transform:translateY(-4px);box-shadow:0 24px 56px -16px rgba(7,68,58,.2)}
.vp-card .vp-icon{width:42px;height:42px;border-radius:13px;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#dcfce7,#7df0ad);color:#053b18;margin-bottom:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.6)}
.vp-card .vp-icon svg{width:20px;height:20px}
.vp-card h3{margin:0 0 5px;font-size:15.5px;letter-spacing:-.02em}
.vp-card p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.55}
/* Sample WhatsApp conversation showcase (A4) */
.sample-chat-section{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:center;margin:36px 0 28px;padding:34px;border-radius:28px;background:linear-gradient(135deg,#ecfff5 0%,#f7fdfa 60%,#ffffff 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 24px 60px -20px rgba(15,44,38,.14)}
.sample-chat-copy h2{margin:6px 0 10px}
.sample-chat-copy .home-section-lead{margin-bottom:16px}
.sample-chat-thread{position:relative;background:#0c7a6e;background-image:radial-gradient(rgba(255,255,255,.06) 1.2px,transparent 1.2px);background-size:14px 14px;padding:18px 14px;border-radius:22px;display:flex;flex-direction:column;gap:8px;min-height:340px;box-shadow:0 22px 50px -20px rgba(7,68,58,.4),inset 0 1px 0 rgba(255,255,255,.12)}
.chat-bubble{max-width:78%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.45;animation:wa-fade-up .42s cubic-bezier(.22,1,.36,1) both;box-shadow:0 4px 10px -3px rgba(0,0,0,.15)}
.chat-bubble small{display:block;font-size:10.5px;font-weight:700;color:rgba(0,0,0,.45);margin-top:4px;text-align:right}
.chat-bubble.in{align-self:flex-start;background:#fff;color:#0b1f1c;border-top-left-radius:6px}
.chat-bubble.out{align-self:flex-end;background:#dcf8c6;color:#0b1f1c;border-top-right-radius:6px}
.chat-bubble.d2{animation-delay:.55s}
.chat-bubble.d3{animation-delay:1.1s}
.chat-bubble.d4{animation-delay:1.65s}
.chat-bubble.d5{animation-delay:2.2s}
@media (max-width:760px){.sample-chat-section{grid-template-columns:minmax(0,1fr);gap:22px;padding:24px}.sample-chat-thread{min-height:0;padding:16px 12px}}
/* Recent reviews (B1) */
.reviews-section{margin:32px 0 28px}
.reviews-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:6px}
.review-card{padding:20px 20px 18px;border-radius:20px;background:linear-gradient(180deg,#ffffff 0%,#f7fdfa 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 14px 36px -16px rgba(15,44,38,.12);display:flex;flex-direction:column;gap:8px}
.review-stars{color:#f59e0b;font-size:14px;letter-spacing:.04em;font-weight:900}
.review-comment{margin:0;color:var(--ink);font-size:14px;line-height:1.55;font-style:italic;flex:1}
.review-meta{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--muted);font-weight:600;border-top:1px solid rgba(220,232,227,.6);padding-top:8px;margin-top:4px}
.review-meta strong{color:var(--brand-2);font-size:13px;letter-spacing:-.01em}
/* Partner CTA (B2) */
.partner-cta{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;margin:36px 0 28px;padding:32px 30px;border-radius:28px;background:linear-gradient(135deg,#053b34 0%,#0c7a6e 50%,#128c7e 100%);color:#fff;box-shadow:0 32px 80px -22px rgba(7,68,58,.36);position:relative;overflow:hidden}
.partner-cta::after{content:"";position:absolute;right:-80px;top:-80px;width:240px;height:240px;border-radius:999px;background:rgba(255,255,255,.1);pointer-events:none}
.partner-cta>*{position:relative;z-index:1}
.partner-cta .home-section-eyebrow{background:rgba(255,255,255,.18);color:#dcfce7;border-color:rgba(255,255,255,.25)}
.partner-cta h2{margin:6px 0 6px;color:#fff;font-size:24px;letter-spacing:-.02em}
.partner-cta p{margin:0;font-size:14.5px;opacity:.93;max-width:560px;line-height:1.55}
.partner-actions{display:flex;flex-wrap:wrap;gap:10px}
.partner-cta .btn-ghost{background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.32);box-shadow:none}
.partner-cta .btn-ghost:hover{background:rgba(255,255,255,.24);filter:none}
/* Footer (A5) */
.home-footer{margin-top:38px;padding:36px 28px 24px;border-radius:28px;background:linear-gradient(180deg,rgba(255,255,255,.96) 0%,rgba(247,253,250,.96) 100%);border:1px solid rgba(220,232,227,.85);box-shadow:0 -8px 24px -16px rgba(15,44,38,.1)}
.home-footer .footer-top{display:grid;grid-template-columns:1.4fr repeat(3,1fr);gap:28px;align-items:flex-start}
.home-footer .footer-brand .footer-logo{display:inline-flex;align-items:center;gap:10px;font-weight:900;font-size:20px;color:var(--brand);letter-spacing:-.04em;text-decoration:none}
.home-footer .footer-brand .footer-logo::before{content:"";width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,#25d366,#b9f7d3);box-shadow:0 8px 18px rgba(37,211,102,.24)}
.home-footer .footer-brand p{margin:14px 0 0;font-size:13.5px;color:var(--muted);max-width:280px;line-height:1.6}
.home-footer .footer-col h4{margin:0 0 10px;font-size:11.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:var(--brand-2)}
.home-footer .footer-col ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.home-footer .footer-col a{text-decoration:none;color:var(--ink);font-size:13.5px;font-weight:600;transition:color .15s ease}
.home-footer .footer-col a:hover{color:var(--brand)}
.home-footer .footer-bottom{margin-top:28px;padding-top:18px;border-top:1px solid rgba(220,232,227,.7);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:12.5px;color:var(--muted)}
.home-footer .footer-bottom strong{color:var(--ink)}
@media (max-width:760px){.home-footer .footer-top{grid-template-columns:1fr 1fr;gap:22px}.home-footer .footer-brand{grid-column:1 / -1}}
@media (max-width:480px){.home-footer .footer-top{grid-template-columns:1fr}}
/* Designed empty hotel-card cover (C1) */
.hotel-card .cover-placeholder{background-color:#dcfce7;background-image:radial-gradient(rgba(7,68,58,.13) 1.6px,transparent 1.6px),linear-gradient(135deg,#dcfce7 0%,#7df0ad 100%);background-size:14px 14px,100% 100%;background-position:0 0,0 0;color:#053b18;position:relative;overflow:hidden}
.hotel-card .cover-placeholder::after{content:"";position:absolute;right:-30px;top:-30px;width:120px;height:120px;border-radius:999px;background:rgba(255,255,255,.4);filter:blur(2px);pointer-events:none}
.hotel-card .cover-placeholder .cover-initials{position:relative;z-index:1;font-size:34px;font-weight:900;letter-spacing:-.04em;text-shadow:0 2px 0 rgba(255,255,255,.5),0 8px 24px rgba(7,68,58,.18)}
.hotel-card .cover-placeholder .cover-chip{position:absolute;left:14px;bottom:14px;z-index:1;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:800;letter-spacing:.04em;color:#053b18;background:rgba(255,255,255,.92);border:1px solid rgba(255,255,255,.95);padding:5px 10px;border-radius:999px;backdrop-filter:blur(4px);box-shadow:0 6px 14px -6px rgba(7,68,58,.25)}
.hotel-card .cover-placeholder .cover-chip svg{width:11px;height:11px}
@media (prefers-reduced-motion:reduce){
  .home-reveal{opacity:1;transform:none;transition:none}
  .hero-bubbles svg{animation:none}
  .chat-bubble{animation:none}
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
  const initials = opts.displayName.split(/\s+/).map((s) => s[0] ?? "").slice(0, 2).join("").toUpperCase();
  let coverHtml: string;
  if (opts.cover) {
    const coverStyle = `background-image:url(${JSON.stringify(opts.cover).slice(1, -1)})`;
    coverHtml = `<div class="cover" style="${coverStyle}"></div>`;
  } else {
    // Designed placeholder — soft mint-to-emerald gradient with a dotted
    // pattern, large initials, and a city chip pinned in the corner so
    // covers feel intentional rather than empty.
    const cityChip = opts.city
      ? `<span class="cover-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-7.5-7-12a7 7 0 1114 0c0 4.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.2"/></svg>${escapeHtml(opts.city)}</span>`
      : "";
    coverHtml = `<div class="cover cover-placeholder"><span class="cover-initials">${escapeHtml(initials)}</span>${cityChip}</div>`;
  }
  return `<article class="hotel-card">
    ${coverHtml}
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

  // B1 — recent guest reviews. Scope to active hotels and (when the gate is
  // configured) marketplace-eligible plans, so we never surface reviews from
  // hotels that aren't visible on the marketplace itself. We only show
  // reviews with rating >= 4 and a non-empty comment.
  const recentReviews = await prisma.guestFeedback.findMany({
    where: {
      rating: { gte: 4 },
      comment: { not: null },
      hotel: {
        isActive: true,
        ...(gateOpen ? { subscriptionPlanCode: { in: marketplaceCodes } } : {})
      }
    },
    select: {
      id: true,
      rating: true,
      comment: true,
      guestName: true,
      createdAt: true,
      hotel: { select: { displayName: true, slug: true, city: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 6
  });
  const reviewsHtml = recentReviews
    .filter((r) => r.comment && r.comment.trim().length >= 12)
    .slice(0, 4)
    .map((r) => {
      const stars = "\u2605".repeat(Math.max(1, Math.min(5, r.rating))) + "\u2606".repeat(Math.max(0, 5 - r.rating));
      const guest = r.guestName ? r.guestName.split(/\s+/)[0] : "Guest";
      const dt = r.createdAt.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
      return `<article class="review-card">
        <span class="review-stars" aria-label="${r.rating} out of 5 stars">${stars}</span>
        <p class="review-comment">&ldquo;${escapeHtml(r.comment ?? "")}&rdquo;</p>
        <div class="review-meta"><span>${escapeHtml(guest)} &middot; ${escapeHtml(dt)}</span><strong>${escapeHtml(r.hotel.displayName)}</strong></div>
      </article>`;
    })
    .join("");

  // A2 — popular Oman destinations. Even when only one hotel is listed,
  // these chips fill horizontal space and become evergreen browse paths.
  const destinations = ["Muscat", "Sur", "Salalah", "Nizwa", "Sohar", "Khasab", "Ashkhara"];
  const destinationsHtml = destinations
    .map((c) => `<a href="/search?city=${encodeURIComponent(c)}">${escapeHtml(c)}</a>`)
    .join("");

  const body = `
    <section class="hero">
      <div class="hero-bubbles" aria-hidden="true">
        <svg class="b1" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5a3 3 0 013-3h12a3 3 0 013 3v8a3 3 0 01-3 3H8l-5 4V5z"/></svg>
        <svg class="b2" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5a3 3 0 013-3h12a3 3 0 013 3v8a3 3 0 01-3 3H8l-5 4V5z"/></svg>
        <svg class="b3" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5a3 3 0 013-3h12a3 3 0 013 3v8a3 3 0 01-3 3H8l-5 4V5z"/></svg>
      </div>
      <h1>Find your next stay &mdash; book on WhatsApp</h1>
      <p>ChatAstay-powered hotels offer instant booking with a real human handoff if you need it.</p>
      ${renderSearchForm({
        city: "",
        checkIn: toIsoDate(defaultCheckIn),
        checkOut: toIsoDate(defaultCheckOut),
        guests: 2,
        rooms: 1
      })}
    </section>

    <nav class="destinations-row" aria-label="Popular destinations">
      <span class="destinations-label">Popular destinations</span>
      ${destinationsHtml}
    </nav>

    <section class="how-it-works home-reveal" aria-label="How it works">
      <p class="home-section-eyebrow">How it works</p>
      <h2 class="home-section-title">Three taps from search to confirmed</h2>
      <p class="home-section-lead">No new app, no logins. Search a real ChatAstay hotel, tap to chat on WhatsApp, get confirmed in seconds.</p>
      <div class="how-grid">
        <article class="how-card">
          <span class="how-step">Step 1</span>
          <div class="how-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><line x1="20" y1="20" x2="16" y2="16"/></svg></div>
          <h3>Search</h3>
          <p>Pick your dates, guests and city. We show only ChatAstay-ready hotels with real-time availability.</p>
        </article>
        <article class="how-card">
          <span class="how-step">Step 2</span>
          <div class="how-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z"/><circle cx="9" cy="11" r="1" fill="currentColor"/><circle cx="13" cy="11" r="1" fill="currentColor"/><circle cx="17" cy="11" r="1" fill="currentColor"/></svg></div>
          <h3>Tap to chat</h3>
          <p>Click &ldquo;Book on WhatsApp&rdquo;. The hotel&apos;s assistant picks up instantly with your details ready.</p>
        </article>
        <article class="how-card">
          <span class="how-step">Step 3</span>
          <div class="how-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 6-7"/></svg></div>
          <h3>Confirmed</h3>
          <p>Booked in seconds, with a real human on standby for any change, request, or local tip you need.</p>
        </article>
      </div>
    </section>

    <h2 style="margin:20px 0 12px;font-size:20px">Featured hotels</h2>
    ${featured.length === 0
      ? `<div class="card empty"><p>No hotels are listed on the marketplace yet.${gateOpen ? "" : ' <span class="muted">(Tip: enable <a href="/owner/plans">Plan.supportsMarketplace</a> to feature a hotel here.)</span>'}</p></div>`
      : `<div class="grid">${featuredHtml}</div>`}

    <section class="value-props-home home-reveal" aria-label="Why book on ChatAstay">
      <p class="home-section-eyebrow">Why ChatAstay</p>
      <h2 class="home-section-title">A fairer way to book a hotel</h2>
      <p class="home-section-lead">Direct from the hotel, no third-party markups, no impersonation, no app to install. Just WhatsApp.</p>
      <div class="vp-grid">
        <article class="vp-card">
          <div class="vp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z"/><path d="M8 11h8M8 8h8"/></svg></div>
          <h3>Instant WhatsApp confirmations</h3>
          <p>The hotel&apos;s assistant replies the moment you tap &ldquo;Book&rdquo; &mdash; no email back-and-forth.</p>
        </article>
        <article class="vp-card">
          <div class="vp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5"/><path d="M16 12.5l3 2-3 2"/></svg></div>
          <h3>Real hotel staff, real handoff</h3>
          <p>Need a sea-view, late check-in, or airport pickup? You&apos;re talking to the actual front desk.</p>
        </article>
        <article class="vp-card">
          <div class="vp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.5l-9 9-9-9V3h9.5z"/><circle cx="8.5" cy="7.5" r="1.5" fill="currentColor"/></svg></div>
          <h3>No hidden marketplace fees</h3>
          <p>You pay the hotel&apos;s direct rate. ChatAstay never adds a service fee on top of your booking.</p>
        </article>
        <article class="vp-card">
          <div class="vp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0115-6.7L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/><path d="M3 20v-4h4"/></svg></div>
          <h3>Cancel or change through chat</h3>
          <p>Plans changed? Send a WhatsApp message. No portals, no holds, no &ldquo;please reply within 48h&rdquo;.</p>
        </article>
      </div>
    </section>

    <section class="sample-chat-section home-reveal" aria-label="Sample WhatsApp conversation">
      <div class="sample-chat-copy">
        <p class="home-section-eyebrow">See it in action</p>
        <h2 class="home-section-title">Like texting a friend who happens to run the hotel</h2>
        <p class="home-section-lead">Every ChatAstay hotel can answer in WhatsApp the moment you tap &ldquo;Book&rdquo;. Here&apos;s what an actual conversation looks like.</p>
        <a class="btn btn-whatsapp" href="/search">Try a real search</a>
      </div>
      <div class="sample-chat-thread" aria-hidden="true">
        <div class="chat-bubble in">Hi! I&apos;m looking for a sea-view room for 2 nights starting Friday.<small>10:24</small></div>
        <div class="chat-bubble out d2">Hi Sara &mdash; we have a Deluxe Sea View at 38 OMR/night. Breakfast included for 2. Want me to hold it?<small>10:24</small></div>
        <div class="chat-bubble in d3">Yes please. Late check-in around 11pm, is that ok?<small>10:25</small></div>
        <div class="chat-bubble out d4">All set. Late check-in noted, our night manager will meet you. Confirmation coming on WhatsApp now.<small>10:25</small></div>
        <div class="chat-bubble in d5">Amazing &mdash; thank you!<small>10:26</small></div>
      </div>
    </section>

    ${reviewsHtml
      ? `<section class="reviews-section home-reveal" aria-label="Recent guest reviews">
          <p class="home-section-eyebrow">Real guest reviews</p>
          <h2 class="home-section-title">Recent stays, in their own words</h2>
          <p class="home-section-lead">Honest feedback collected directly via WhatsApp after each stay &mdash; no edits, no incentives.</p>
          <div class="reviews-grid">${reviewsHtml}</div>
        </section>`
      : ""}

    <section class="partner-cta home-reveal">
      <div>
        <p class="home-section-eyebrow">Hotelier?</p>
        <h2>List your property on ChatAstay</h2>
        <p>WhatsApp-first PMS, marketplace exposure, 14-day free trial. Most teams are live the same day.</p>
      </div>
      <div class="partner-actions">
        <a class="btn btn-whatsapp" href="/admin/onboard">Become a partner</a>
        <a class="btn btn-ghost" href="/pricing">View pricing</a>
      </div>
    </section>

    <footer class="home-footer home-reveal">
      <div class="footer-top">
        <div class="footer-brand">
          <a href="/" class="footer-logo">ChatAstay</a>
          <p>The WhatsApp-first hotel marketplace and PMS. Discover, book, and stay &mdash; all in the chat you already use.</p>
        </div>
        <div class="footer-col">
          <h4>Marketplace</h4>
          <ul>
            <li><a href="/">Featured hotels</a></li>
            <li><a href="/search">Search hotels</a></li>
            <li><a href="/search?city=Muscat">Muscat</a></li>
            <li><a href="/search?city=Salalah">Salalah</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>For hotels</h4>
          <ul>
            <li><a href="/admin/onboard">Become a partner</a></li>
            <li><a href="/pricing">Pricing</a></li>
            <li><a href="/admin/login">Hotel extranet</a></li>
            <li><a href="mailto:sales@chatastay.com">Contact sales</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h4>Company</h4>
          <ul>
            <li><a href="/pricing">About ChatAstay</a></li>
            <li><a href="/guest/account">Traveller account</a></li>
            <li><a href="mailto:hello@chatastay.com">Contact</a></li>
            <li><a href="mailto:support@chatastay.com">Support</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <span>&copy; ${new Date().getFullYear()} <strong>ChatAstay</strong>. Built for WhatsApp-first hotel operations.</span>
        <span>Made with care in the Sultanate of Oman.</span>
      </div>
    </footer>
  `;

  // C3 — scroll-reveal observer for the new home sections. Reuses the same
  // pattern as the pricing page; degrades gracefully without IO support and
  // disables itself for prefers-reduced-motion users.
  const inlineScript = `
    (function(){
      var targets = document.querySelectorAll('.home-reveal');
      if (!targets.length) return;
      var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced || typeof IntersectionObserver === 'undefined') {
        Array.prototype.forEach.call(targets, function(el){ el.classList.add('is-visible'); });
        return;
      }
      var io = new IntersectionObserver(function(entries){
        entries.forEach(function(entry){
          if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      Array.prototype.forEach.call(targets, function(el){ io.observe(el); });
    })();
  `;

  res.type("html").send(
    renderShell({
      title: "ChatAstay marketplace",
      body: body + `<script>${inlineScript}</script>`
    })
  );
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
  const primaryProperty = hotel.properties[0] ?? null;
  const [publicPolicies, publicKnowledge] = await Promise.all([
    listPolicies(prisma, hotel.id, { propertyId: primaryProperty?.id ?? null, locale: "en" }),
    listKnowledgeEntries(prisma, hotel.id, { propertyId: primaryProperty?.id ?? null, locale: "en" })
  ]);
  const policyCardsHtml = publicPolicies.slice(0, 6).map((policy) => `<article class="card" style="margin-bottom:0">
      <span class="badge">${escapeHtml(policy.type.replaceAll("_", " "))}</span>
      <h3 style="font-size:16px;margin:10px 0 6px">${escapeHtml(policy.title)}</h3>
      <p style="margin:0;font-size:14px">${escapeHtml(policy.body)}</p>
    </article>`).join("");
  const faqCardsHtml = publicKnowledge
    .filter((entry) => entry.question && ["general", "rooms", "rates", "policies", "restaurant", "services", "activities", "directions", "contacts"].includes(entry.category))
    .slice(0, 6)
    .map((entry) => `<details class="card" style="margin-bottom:0">
      <summary style="cursor:pointer;font-weight:800">${escapeHtml(entry.question ?? entry.category)}</summary>
      <p style="margin:10px 0 0;font-size:14px">${escapeHtml(entry.answer)}</p>
    </details>`)
    .join("");

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
      : ""}
    ${policyCardsHtml ? `<section class="card"><h2 style="margin-top:0;font-size:18px">Policies</h2><div class="grid">${policyCardsHtml}</div></section>` : ""}
    ${faqCardsHtml ? `<section class="card"><h2 style="margin-top:0;font-size:18px">Guest FAQ</h2><div class="grid">${faqCardsHtml}</div></section>` : ""}`;

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

    <button type="button" class="pricing-float-cta stayli-launcher" aria-label="Open Stayli, the pricing assistant" aria-expanded="false" aria-controls="stayli-panel">
      <span class="float-cta-bubble" aria-hidden="true"></span>
      <span class="float-cta-text">Pricing question? <strong>Chat with Stayli</strong></span>
    </button>

    <aside id="stayli-panel" class="stayli-panel" role="dialog" aria-modal="false" aria-label="Stayli pricing assistant" aria-hidden="true">
      <header class="stayli-header">
        <div class="stayli-avatar" aria-hidden="true">
          <svg class="stayli-bot" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" focusable="false">
            <line x1="16" y1="3.6" x2="16" y2="7" stroke="#053b18" stroke-width="1.6" stroke-linecap="round"/>
            <circle cx="16" cy="3" r="1.7" fill="#053b18"/>
            <rect x="6" y="7" width="20" height="17" rx="5.5" ry="5.5" fill="#053b18"/>
            <rect x="4.4" y="13" width="1.8" height="5" rx="0.9" fill="#053b18"/>
            <rect x="25.8" y="13" width="1.8" height="5" rx="0.9" fill="#053b18"/>
            <rect x="9.5" y="11.5" width="5.5" height="5.5" rx="1.4" fill="#0c7a6e"/>
            <rect x="17" y="11.5" width="5.5" height="5.5" rx="1.4" fill="#0c7a6e"/>
            <circle class="stayli-eye stayli-eye-l" cx="12.25" cy="14.25" r="1.4" fill="#7df0ad"/>
            <circle class="stayli-eye stayli-eye-r" cx="19.75" cy="14.25" r="1.4" fill="#7df0ad"/>
            <rect x="11.5" y="19.6" width="9" height="1.6" rx="0.8" fill="#7df0ad"/>
          </svg>
        </div>
        <div class="stayli-id">
          <p class="stayli-name">Stayli</p>
          <p class="stayli-status"><span class="stayli-dot" aria-hidden="true"></span> Online &middot; Pricing assistant</p>
        </div>
        <button type="button" class="stayli-close" aria-label="Close pricing chat">&times;</button>
      </header>
      <div class="stayli-body" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div class="stayli-quick-replies" aria-label="Quick replies"></div>
      <form class="stayli-input-form" autocomplete="off">
        <input type="text" class="stayli-input" name="q" placeholder="Ask about pricing&hellip;" aria-label="Type your pricing question" maxlength="240" />
        <button type="submit" class="stayli-send" aria-label="Send message">
          <span aria-hidden="true">&#10148;</span>
        </button>
      </form>
    </aside>
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

    // ===== Stayli — ChatAstay's pricing-only assistant =====
    // Pure client-side: keyword-based knowledge graph, no LLM, no network.
    // If a question is unrelated to pricing, Stayli politely deflects.
    (function(){
      var launcher = document.querySelector('.stayli-launcher');
      var panel = document.getElementById('stayli-panel');
      if (!launcher || !panel) return;
      var bodyEl = panel.querySelector('.stayli-body');
      var quickWrap = panel.querySelector('.stayli-quick-replies');
      var form = panel.querySelector('.stayli-input-form');
      var input = panel.querySelector('.stayli-input');
      var closeBtn = panel.querySelector('.stayli-close');

      var GREETING = "Hi! I'm Stayli, your ChatAstay pricing assistant. Ask me about plans, trials, billing, currencies, or anything else price-related.";
      var THANKS_REPLY = "You're welcome! Anything else about pricing?";
      var FALLBACK = "I only answer pricing questions. Try asking about plans, trials, billing, currencies, upgrades, or payments — I've got you covered there!";

      var GREETINGS = ['hi', 'hello', 'hey', 'salam', 'marhaba', 'howdy', 'good morning', 'good evening', 'good afternoon', 'as-salamu alaykum'];
      var THANKS = ['thanks', 'thank you', 'shukran', 'cheers', 'appreciate', 'thx'];

      // Knowledge graph. Order matters: the first topic whose keywords appear
      // in the user's question wins.
      var TOPICS = [
        { keywords: ['starter'],
          answer: "Starter is 19 OMR / month — perfect for guesthouses and boutique hotels with up to 30 rooms. Includes the basic PMS (rack, reservations, check-in/out), the WhatsApp booking assistant, room/rate management, guest profiles, and email support." },
        { keywords: ['growth'],
          answer: "Growth is 49 OMR / month and our most popular plan — built for hotels with 30 to 80 rooms. Adds the Restaurant/Café module, housekeeping SLA board, in-stay WhatsApp service requests, the reports center, and guest review collection on top of Starter." },
        { keywords: ['pro', 'premium'],
          answer: "Pro is 99 OMR / month — for serious operators with 80+ rooms. Everything in Growth plus advanced PMS ops (folio adjustments/voids/refunds), multi-property readiness, staff roles & audit trail, advanced analytics, AI automation, and priority WhatsApp support." },
        { keywords: ['enterprise', 'chain', 'sso', 'sla', 'integration'],
          answer: "Enterprise is custom-priced for hotel chains and large operators. Includes everything in Pro plus multi-property management, custom integrations, dedicated onboarding, advanced permissions (SSO-ready), and SLA-backed support with a named CSM. Email sales@chatastay.com for a tailored quote." },
        { keywords: ['compare', 'difference', 'vs', 'between', 'which plan'],
          answer: "Quick comparison: Starter (19 OMR) covers basic PMS + WhatsApp; Growth (49 OMR) adds restaurant + housekeeping + reports; Pro (99 OMR) adds advanced ops, multi-property, and AI automation; Enterprise is custom. Use the chip selector at the top of the page to find the right fit for your size." },
        { keywords: ['trial', 'free', 'risk', 'try'],
          answer: "Every paid plan starts with a 14-day free trial — no credit card required. You can sign up, connect your WhatsApp number, onboard your team, and only pay if you decide to continue." },
        { keywords: ['demo', 'show me'],
          answer: "Happy to give you a guided demo — click 'Request Demo' on the page or message us via the WhatsApp button. We usually book a 30-minute walkthrough within a day." },
        { keywords: ['cancel', 'unsubscribe', 'quit subscription'],
          answer: "You can cancel anytime — no contracts, no exit fees. Your account stays active through the end of the current billing period." },
        { keywords: ['upgrade', 'downgrade', 'switch plan', 'change plan'],
          answer: "Upgrade or downgrade anytime from your hotel admin. Upgrades are immediate and prorated; downgrades take effect at the end of the current billing cycle." },
        { keywords: ['refund', 'money back', 'get my money'],
          answer: "We don't offer refunds because the 14-day free trial gives you a fully risk-free evaluation period. You can also cancel anytime to stop future billing." },
        { keywords: ['discount', 'deal', 'save 20', 'save money', 'cheaper', 'annual', 'yearly', 'pay yearly'],
          answer: "Annual billing saves 20% — that's roughly 2.4 months free per year. Toggle Monthly/Annual in the hero to see the annual price for any plan." },
        { keywords: ['payment', 'pay with', 'card', 'invoice', 'stripe', 'thawani', 'cash', 'billing method'],
          answer: "We accept cash, card, Stripe, and Thawani out of the box. Invoices are issued automatically when a folio is fully settled. Outstanding balances surface on your front-desk dashboard." },
        { keywords: ['currency', 'omr', 'usd', 'aed', 'sar', 'rial', 'dollar', 'dirham', 'riyal'],
          answer: "Use the currency switcher in the top-right corner of the hero to view prices in OMR, USD, AED, or SAR. Conversions are approximate; actual billing is in OMR." },
        { keywords: ['whatsapp', 'business api', 'cloud api'],
          answer: "ChatAstay is WhatsApp-first. Connect your WhatsApp Cloud API number once and the booking assistant, in-stay menus, and review requests work for every booking — direct, OTA, or marketplace." },
        { keywords: ['migrate', 'migration', 'import data', 'switch from', 'move from'],
          answer: "Growth, Pro, and Enterprise plans include guided data import — rooms, rates, guests, future bookings. Our team handles the heavy lifting so you switch without losing reservations." },
        { keywords: ['support', 'help me with pricing', 'contact sales', 'talk to sales'],
          answer: "For sales, email sales@chatastay.com. Pro and Enterprise plans include priority WhatsApp support; Enterprise comes with SLA-backed support and a named customer success manager." },
        { keywords: ['onboarding', 'guided setup', 'how long to go live', 'training session'],
          answer: "Most teams are live the same day. Front desk, housekeeping, and restaurant staff each get a focused workspace with only the tabs they need. Pro and Enterprise plans include guided onboarding sessions." },
        { keywords: ['how many rooms', 'rooms do i', 'rooms do we', 'hotel size', 'my hotel has', 'we have rooms', 'right plan for'],
          answer: "Use the chip selector in the hero ('How many rooms do you have?') and the page will highlight the right plan for your size — Starter for ≤30, Growth for 30-80, Pro for 80+, Enterprise for chains." },
        { keywords: ['price', 'cost', 'how much', 'pricing', 'rate plan', 'fees', 'expensive', 'cheap'],
          answer: "Plans start at 19 OMR/month for Starter, 49 OMR/month for Growth (most popular), 99 OMR/month for Pro, and Enterprise is custom-priced. Annual billing saves 20%." }
      ];

      var QUICK_REPLIES = [
        { label: 'How much?',     q: 'how much do plans cost' },
        { label: 'Free trial',    q: 'tell me about the free trial' },
        { label: 'Compare plans', q: 'whats the difference between plans' },
        { label: 'Switch plans?', q: 'can i upgrade or downgrade' },
        { label: 'Payments',      q: 'what payment methods do you support' },
        { label: 'Cancel?',       q: 'can i cancel anytime' }
      ];

      function escapeText(s){ return String(s == null ? '' : s); }

      function appendMessage(text, who){
        var el = document.createElement('div');
        el.className = 'stayli-msg ' + (who === 'user' ? 'user' : 'bot');
        el.textContent = escapeText(text);
        bodyEl.appendChild(el);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        return el;
      }

      function appendTyping(){
        var el = document.createElement('div');
        el.className = 'stayli-msg bot typing';
        el.setAttribute('data-typing', '1');
        el.innerHTML = '<span></span><span></span><span></span>';
        bodyEl.appendChild(el);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        return el;
      }

      function answerFor(q){
        var t = (q || '').toLowerCase().trim();
        if (!t) return null;
        for (var i = 0; i < GREETINGS.length; i++) {
          if (t === GREETINGS[i] || t.indexOf(GREETINGS[i] + ' ') === 0 || t.indexOf(GREETINGS[i] + ',') === 0 || t.indexOf(GREETINGS[i] + '!') === 0) {
            return GREETING;
          }
        }
        for (var j = 0; j < THANKS.length; j++) {
          if (t.indexOf(THANKS[j]) >= 0) return THANKS_REPLY;
        }
        for (var k = 0; k < TOPICS.length; k++) {
          var topic = TOPICS[k];
          for (var m = 0; m < topic.keywords.length; m++) {
            if (t.indexOf(topic.keywords[m]) >= 0) return topic.answer;
          }
        }
        return FALLBACK;
      }

      function ask(text){
        if (!text || !text.trim()) return;
        appendMessage(text, 'user');
        var typingEl = appendTyping();
        var delay = 380 + Math.min(700, text.length * 12);
        setTimeout(function(){
          if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
          appendMessage(answerFor(text), 'bot');
        }, delay);
      }

      function openPanel(){
        panel.classList.add('is-open');
        panel.setAttribute('aria-hidden', 'false');
        launcher.classList.add('is-stayli-open');
        launcher.setAttribute('aria-expanded', 'true');
        if (!bodyEl.dataset.greeted) {
          appendMessage(GREETING, 'bot');
          bodyEl.dataset.greeted = '1';
        }
        setTimeout(function(){ if (input) input.focus(); }, 280);
      }

      function closePanel(){
        panel.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        launcher.classList.remove('is-stayli-open');
        launcher.setAttribute('aria-expanded', 'false');
        try { launcher.focus(); } catch(e){}
      }

      // Wire interactions.
      launcher.addEventListener('click', openPanel);
      if (closeBtn) closeBtn.addEventListener('click', closePanel);
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape' && panel.classList.contains('is-open')) closePanel();
      });
      if (form) {
        form.addEventListener('submit', function(e){
          e.preventDefault();
          var text = (input && input.value) || '';
          if (input) input.value = '';
          ask(text);
        });
      }

      // Render quick-reply chips.
      QUICK_REPLIES.forEach(function(qr){
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = qr.label;
        btn.addEventListener('click', function(){ ask(qr.q); });
        quickWrap.appendChild(btn);
      });
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
