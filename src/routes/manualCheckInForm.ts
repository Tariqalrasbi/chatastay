import type { Request } from "express";
import type { RoomType, RoomUnit } from "@prisma/client";
import { loadFrontDeskPricing } from "../core/frontDeskPricing";
import { MANUAL_CHECK_IN_NATIONALITY_OPTIONS } from "./manualCheckInNationalities";

export type ManualCheckInFormValues = {
  guestFullName: string;
  guestPhone: string;
  guestEmail: string;
  nationality: string;
  idNumber: string;
  /** Maps to ChannelProvider for booking reference prefix (WI, PH, CO, RF). */
  bookingChannel: string;
  internalNotes: string;
  checkIn: string;
  checkOut: string;
  adults: string;
  children: string;
  mealPlan: string;
  roomUnitId: string;
  paymentStatus: string;
  paymentMethod: string;
  adjustmentAmount: string;
  totalAmount: string;
  returnBoardDate: string;
  sendInvoiceWhatsApp: boolean;
  openInvoicePrint: boolean;
  selectedExtraIds: string[];
  extraHoursById: Record<string, number>;
};

type RoomTypeWithUnits = RoomType & { roomUnits: RoomUnit[] };

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function manualCheckInFormFromBody(req: Request): ManualCheckInFormValues {
  const fdPricing = loadFrontDeskPricing();
  const extraIdsRaw = req.body.extraIds;
  const extraIdsList = Array.isArray(extraIdsRaw) ? extraIdsRaw.map(String) : extraIdsRaw ? [String(extraIdsRaw)] : [];
  const allowedExtras = new Set(fdPricing.extras.map((x) => x.id));
  const selectedExtraIds = extraIdsList.filter((id) => allowedExtras.has(id));
  const extraHoursById: Record<string, number> = {};
  for (const ex of fdPricing.extras) {
    if (!ex.applyPerHour || !selectedExtraIds.includes(ex.id)) continue;
    const raw = req.body[`extraHour_${ex.id}`];
    const h = parseFloat(typeof raw === "string" || typeof raw === "number" ? String(raw) : "1");
    extraHoursById[ex.id] = Number.isFinite(h) && h >= 0.25 ? Math.min(168, h) : 1;
  }
  return {
    guestFullName: String(req.body.guestFullName ?? ""),
    guestPhone: String(req.body.guestPhone ?? ""),
    guestEmail: String(req.body.guestEmail ?? ""),
    nationality: String(req.body.nationality ?? ""),
    idNumber: String(req.body.idNumber ?? ""),
    bookingChannel: String(req.body.bookingChannel ?? "DIRECT"),
    internalNotes: String(req.body.internalNotes ?? ""),
    checkIn: String(req.body.checkIn ?? ""),
    checkOut: String(req.body.checkOut ?? ""),
    adults: String(req.body.adults ?? "2"),
    children: String(req.body.children ?? "0"),
    mealPlan: String(req.body.mealPlan ?? "NONE"),
    roomUnitId: String(req.body.roomUnitId ?? ""),
    paymentStatus: String(req.body.paymentStatus ?? "PENDING"),
    paymentMethod: String(req.body.paymentMethod ?? ""),
    adjustmentAmount: String(req.body.adjustmentAmount ?? "0"),
    totalAmount: String(req.body.totalAmount ?? ""),
    returnBoardDate: String(req.body.returnBoardDate ?? ""),
    sendInvoiceWhatsApp: req.body.sendInvoiceWhatsApp === "1" || req.body.sendInvoiceWhatsApp === "on",
    openInvoicePrint: req.body.openInvoicePrint === "1" || req.body.openInvoicePrint === "on",
    selectedExtraIds,
    extraHoursById
  };
}

type BuildManualCheckInDeps = {
  formatMoney: (amount: number, currency: string) => string;
  formatDateForInput: (input: Date | null | undefined) => string;
  parseDateInput: (raw: unknown, fallback: Date) => Date;
  addDays: (input: Date, days: number) => Date;
};

export function buildManualCheckInPageHtml(
  deps: BuildManualCheckInDeps,
  hotel: { displayName: string; currency: string },
  roomTypes: RoomTypeWithUnits[],
  fdPricing: ReturnType<typeof loadFrontDeskPricing>,
  options: { defaultDay: Date; errorMsg?: string; form?: ManualCheckInFormValues }
): string {
  const { formatMoney, formatDateForInput, parseDateInput, addDays } = deps;
  const form = options.form;
  const defaultDay = options.defaultDay;
  /** Submitted values win; otherwise check-in follows defaultDay (today when no ?date= on GET). */
  const defaultCheckIn = form?.checkIn?.trim()
    ? form.checkIn.trim()
    : formatDateForInput(defaultDay);
  const defaultCheckOut = form?.checkOut?.trim()
    ? form.checkOut.trim()
    : formatDateForInput(addDays(parseDateInput(defaultCheckIn, defaultDay), 1));
  const returnBoardHidden = form?.returnBoardDate?.trim() || defaultCheckIn;
  const errorMsg = options.errorMsg?.trim() ?? "";

  const unitOptgroups = roomTypes
    .map((rt) => {
      const opts = rt.roomUnits
        .map(
          (u) =>
            `<option value="${escapeHtml(u.id)}" data-nightly="${String(rt.baseNightlyRate)}"${
              form?.roomUnitId === u.id ? " selected" : ""
            }>${escapeHtml(u.name)}</option>`
        )
        .join("");
      return opts
        ? `<optgroup label="${escapeHtml(`${rt.name} — ${formatMoney(rt.baseNightlyRate, hotel.currency)}/night`)}">${opts}</optgroup>`
        : "";
    })
    .filter(Boolean)
    .join("");

  const extrasCheckboxes = fdPricing.extras
    .map((ex) => {
      const priceHint = ex.applyPerHour
        ? `${formatMoney(ex.amount, hotel.currency)}/hour`
        : ex.applyPerNight
          ? `${formatMoney(ex.amount, hotel.currency)}/night if selected`
          : `${formatMoney(ex.amount, hotel.currency)} flat`;
      const hourVal = form?.extraHoursById?.[ex.id] ?? 1;
      const checked = form?.selectedExtraIds?.includes(ex.id) ? " checked" : "";
      const hourField = ex.applyPerHour
        ? `<label class="muted" style="display:flex;align-items:center;gap:8px;margin-left:26px;flex-wrap:wrap">Hours
        <input type="number" class="fd-extra-hour-input" name="extraHour_${escapeHtml(ex.id)}" id="fd-extra-hour-${escapeHtml(ex.id)}" min="0.5" step="0.5" value="${hourVal}" style="width:80px;padding:6px;border:1px solid #d8dee6;border-radius:8px" />
      </label>`
        : "";
      return `<div class="fd-extra-row" style="display:flex;flex-direction:column;gap:6px;margin-bottom:4px">
    <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
    <input type="checkbox" class="fd-extra" name="extraIds" value="${escapeHtml(ex.id)}" data-per-hour="${ex.applyPerHour ? "1" : ""}"${checked} />
    <span>${escapeHtml(ex.label)} <span class="muted" style="font-size:12px">(${priceHint})</span></span>
    </label>${hourField}
  </div>`;
    })
    .join("");

  const mealHints = `Breakfast +${formatMoney(fdPricing.mealPlans.BREAKFAST.perPersonPerNight, hotel.currency)}/guest/night · Half board +${formatMoney(fdPricing.mealPlans.HALF_BOARD.perPersonPerNight, hotel.currency)}/guest/night`;
  const mp = (form?.mealPlan ?? "NONE").toUpperCase();
  const mealSelected = (v: string) => (mp === v ? " selected" : "");
  const bc = (form?.bookingChannel ?? "DIRECT").toUpperCase();
  const bcSel = (v: string) => (bc === v ? " selected" : "");
  const ps = form?.paymentStatus ?? "PENDING";
  const pm = form?.paymentMethod ?? "";
  const paySel = (v: string) => (ps === v ? " selected" : "");
  const methodSel = (v: string) => (pm === v ? " selected" : "");

  const guestFullName = escapeHtml(form?.guestFullName ?? "");
  const guestPhone = escapeHtml(form?.guestPhone ?? "");
  const guestEmail = escapeHtml(form?.guestEmail ?? "");
  const nationality = escapeHtml(form?.nationality ?? "");
  const idNumber = escapeHtml(form?.idNumber ?? "");
  const internalNotes = escapeHtml(form?.internalNotes ?? "");
  const adultsVal = escapeHtml(form?.adults ?? "2");
  const childrenVal = escapeHtml(form?.children ?? "0");
  const adjustmentVal = escapeHtml(form?.adjustmentAmount ?? "0");
  const totalVal = form?.totalAmount?.trim() ? escapeHtml(form.totalAmount) : "";
  const invWhats = form?.sendInvoiceWhatsApp ? " checked" : "";
  const invPrint = form?.openInvoicePrint ? " checked" : "";

  const nationalityDatalistHtml = MANUAL_CHECK_IN_NATIONALITY_OPTIONS.map(
    (n) => `<option value="${escapeHtml(n)}"></option>`
  ).join("");

  const isFreshLoad = !form;
  const guestAutofocus = isFreshLoad && !errorMsg ? " autofocus" : "";

  return `
<style>
.fd-checkin-wrap { max-width: 800px; }
.fd-checkin-form { display: grid; gap: 18px; }
.fd-req { color: #b91c1c; font-weight: 700; }
.fd-legend { margin: 0; font-size: 13px; color: #64748b; }
.fd-sec {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 16px 18px;
  display: grid;
  gap: 14px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.fd-sec--guest { border-left: 4px solid #128c7e; }
.fd-sec--stay { border-left: 4px solid #0ea5e9; }
.fd-sec--room { border-left: 4px solid #8b5cf6; }
.fd-sec--extras { border-left: 4px solid #94a3b8; }
.fd-sec--pay { border-left: 4px solid #f59e0b; }
.fd-sec--after { border-left: 4px solid #64748b; }
.fd-sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  border-bottom: 1px solid #f1f5f9;
  padding-bottom: 10px;
  margin: -4px 0 0 0;
}
.fd-sec-title { margin: 0; font-size: 1.08rem; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; }
.fd-sec-tag { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; }
.fd-field { display: flex; flex-direction: column; gap: 6px; }
.fd-field > span:first-child, .fd-field label:first-child { font-size: 13px; font-weight: 600; color: #334155; }
.fd-input, .fd-checkin-form select, .fd-checkin-form textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 15px;
  box-sizing: border-box;
}
.fd-input:focus, .fd-checkin-form select:focus, .fd-checkin-form textarea:focus {
  outline: 2px solid #128c7e;
  outline-offset: 1px;
  border-color: #0d9488;
}
.fd-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
@media (max-width: 640px) { .fd-grid-2 { grid-template-columns: 1fr; } }
.fd-hint { margin: 0; font-size: 12px; line-height: 1.45; color: #64748b; }
.fd-room-summary {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  padding: 12px 14px;
  border-radius: 8px;
  line-height: 1.4;
}
.fd-room-summary--empty {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}
.fd-room-summary--ok {
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  color: #065f46;
}
.fd-breakdown-box {
  font-size: 13px;
  line-height: 1.55;
  padding: 12px 14px;
  background: #f8fafc;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}
.fd-total-input { background: #f1f5f9 !important; font-weight: 700 !important; }
.fd-actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; padding-top: 4px; }
.fd-submit {
  padding: 12px 22px;
  border: 0;
  border-radius: 10px;
  background: #128c7e;
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
  box-shadow: 0 2px 4px rgba(18, 140, 126, 0.25);
}
.fd-submit:hover { filter: brightness(1.05); }
.fd-submit:focus-visible { outline: 2px solid #0f766e; outline-offset: 2px; }
</style>
<div class="fd-checkin-wrap">
<h2 style="margin-bottom:8px">Manual check-in</h2>
<p class="muted" style="margin-top:0;line-height:1.5">${escapeHtml(hotel.displayName)} — Walk-in or phone booking: one room, confirmed stay, board updated. <strong>Tab</strong> moves top-to-bottom; start with guest name.</p>
<p class="fd-legend"><span class="fd-req">*</span> = required before confirm.</p>
${errorMsg ? `<p class="badge" role="alert" style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:10px 14px;font-size:14px">${escapeHtml(errorMsg)}</p>` : ""}
<form method="post" action="/admin/front-desk/check-in" class="fd-checkin-form">
  <input type="hidden" name="returnBoardDate" value="${escapeHtml(returnBoardHidden)}" />
  <section class="fd-sec fd-sec--guest" aria-labelledby="fd-sec-guest-title">
    <div class="fd-sec-head">
      <h3 class="fd-sec-title" id="fd-sec-guest-title">Guest</h3>
      <span class="fd-sec-tag">Start here</span>
    </div>
    <div class="fd-field">
      <label for="fd-guest-name">Guest name <span class="fd-req">*</span></label>
      <input type="text" id="fd-guest-name" name="guestFullName" required autocomplete="name" value="${guestFullName}" class="fd-input" placeholder="As on ID / passport"${guestAutofocus} />
    </div>
    <div class="fd-grid-2">
      <div class="fd-field">
        <label for="fd-guest-phone">Mobile <span class="fd-req">*</span></label>
        <input type="tel" id="fd-guest-phone" name="guestPhone" required autocomplete="tel" value="${guestPhone}" class="fd-input" placeholder="+968…" inputmode="tel" />
      </div>
      <div class="fd-field">
        <label for="fd-guest-email">Email</label>
        <input type="email" id="fd-guest-email" name="guestEmail" autocomplete="email" value="${guestEmail}" class="fd-input" placeholder="Optional" />
      </div>
    </div>
    <div class="fd-grid-2">
      <div class="fd-field">
        <label for="fd-nationality">Nationality</label>
        <input type="text" name="nationality" id="fd-nationality" list="fd-nationality-list" value="${nationality}" autocomplete="country-name" class="fd-input" placeholder="Type or pick…" />
        <datalist id="fd-nationality-list">${nationalityDatalistHtml}</datalist>
      </div>
      <div class="fd-field">
        <label for="fd-id-number">ID / passport #</label>
        <input type="text" id="fd-id-number" name="idNumber" autocomplete="off" value="${idNumber}" class="fd-input" placeholder="Optional" />
      </div>
    </div>
  </section>
  <section class="fd-sec fd-sec--stay" aria-labelledby="fd-sec-stay-title">
    <div class="fd-sec-head">
      <h3 class="fd-sec-title" id="fd-sec-stay-title">Stay</h3>
      <span class="fd-sec-tag">Dates &amp; pax</span>
    </div>
    <div class="fd-grid-2">
      <div class="fd-field">
        <label for="fd-check-in">Check-in <span class="fd-req">*</span></label>
        <input type="date" id="fd-check-in" name="checkIn" value="${escapeHtml(defaultCheckIn)}" required inputmode="numeric" class="fd-input" aria-describedby="fd-date-hint" />
      </div>
      <div class="fd-field">
        <label for="fd-check-out">Check-out <span class="fd-req">*</span></label>
        <input type="date" id="fd-check-out" name="checkOut" value="${escapeHtml(defaultCheckOut)}" required inputmode="numeric" class="fd-input" aria-describedby="fd-date-hint" />
      </div>
    </div>
    <p id="fd-date-hint" class="fd-hint">Check-out is the <strong>departure morning</strong> (day after last night), same as the room board. If you change check-in, check-out stays at least the next night.</p>
    <div class="fd-grid-2">
      <div class="fd-field">
        <label for="fd-adults">Adults <span class="fd-req">*</span></label>
        <input type="number" id="fd-adults" name="adults" value="${adultsVal}" min="1" max="12" required class="fd-input" />
      </div>
      <div class="fd-field">
        <label for="fd-children">Children</label>
        <input type="number" id="fd-children" name="children" value="${childrenVal}" min="0" max="8" class="fd-input" />
      </div>
    </div>
    <div class="fd-field">
      <label for="fd-meal-plan">Meal plan</label>
      <select id="fd-meal-plan" name="mealPlan" class="fd-input">
        <option value="NONE"${mealSelected("NONE")}>Room only (default)</option>
        <option value="BREAKFAST"${mealSelected("BREAKFAST")}>Breakfast</option>
        <option value="HALF_BOARD"${mealSelected("HALF_BOARD")}>Half board</option>
      </select>
    </div>
    <div class="fd-field">
      <label for="fd-booking-channel">Booking source <span class="fd-hint" style="font-weight:400">(reference number prefix)</span></label>
      <select id="fd-booking-channel" name="bookingChannel" class="fd-input">
        <option value="DIRECT"${bcSel("DIRECT")}>Walk-in</option>
        <option value="PHONE"${bcSel("PHONE")}>Phone</option>
        <option value="CORPORATE"${bcSel("CORPORATE")}>Corporate / company</option>
        <option value="REFERRAL"${bcSel("REFERRAL")}>Referral</option>
      </select>
    </div>
    <p class="fd-hint">Walk-in default: <strong>today → tomorrow</strong>, 2 adults, 0 children, room only. Meals: ${escapeHtml(mealHints)} · <code>front-desk-pricing.json</code></p>
  </section>
  <section class="fd-sec fd-sec--room" aria-labelledby="fd-sec-room-title">
    <div class="fd-sec-head">
      <h3 class="fd-sec-title" id="fd-sec-room-title">Room</h3>
      <span class="fd-req">*</span>
    </div>
    <div class="fd-field">
      <label for="fd-room-unit">Assign unit</label>
      <select id="fd-room-unit" name="roomUnitId" required class="fd-input" aria-describedby="fd-room-summary fd-room-rules">
        <option value="" data-nightly="0">— Choose room —</option>${unitOptgroups}
      </select>
    </div>
    <p id="fd-room-summary" class="fd-room-summary fd-room-summary--empty" role="status" aria-live="polite">Select a room unit before confirming.</p>
    <p id="fd-room-rules" class="fd-hint">Occupancy: Superior / Executive — max 2 adults &amp; 2 children; Suite — max 2 &amp; 3; Apartment — max 2 &amp; 4, or 4 adults with no children.</p>
  </section>
  <section class="fd-sec fd-sec--extras" aria-labelledby="fd-sec-extras-title">
    <div class="fd-sec-head">
      <h3 class="fd-sec-title" id="fd-sec-extras-title">Extras</h3>
      <span class="fd-sec-tag">Optional</span>
    </div>
    <p class="fd-hint" style="margin-top:-6px">Add-ons from <code>front-desk-pricing.json</code>.</p>
    ${extrasCheckboxes || '<p class="muted">No extras configured.</p>'}
  </section>
  <section class="fd-sec fd-sec--pay" aria-labelledby="fd-sec-pay-title">
    <div class="fd-sec-head">
      <h3 class="fd-sec-title" id="fd-sec-pay-title">Rate, payment &amp; notes</h3>
      <span class="fd-sec-tag">Review</span>
    </div>
    <p class="fd-hint" style="margin-top:-6px">Total = rack rate × nights + meals + extras ± adjustment.</p>
    <div id="fd-breakdown" class="fd-breakdown-box"></div>
    <div class="fd-grid-2">
      <div class="fd-field">
        <label for="fd-total">Total (${escapeHtml(hotel.currency)})</label>
        <input type="number" id="fd-total" name="totalAmount" min="0" step="0.01" readonly value="${totalVal}" class="fd-input fd-total-input" />
      </div>
      <div class="fd-field">
        <label for="fd-adjustment">Adjustment ± (${escapeHtml(hotel.currency)})</label>
        <input type="number" id="fd-adjustment" name="adjustmentAmount" value="${adjustmentVal}" step="0.01" class="fd-input" />
      </div>
    </div>
    <p class="fd-hint">Rack rates: <a class="inline-link" href="/admin/rooms">Rooms &amp; pricing</a>.</p>
    <div class="fd-grid-2">
      <div class="fd-field">
        <label for="fd-pay-status">Payment status</label>
        <select id="fd-pay-status" name="paymentStatus" class="fd-input">
          <option value="PENDING"${paySel("PENDING")}>Pending</option>
          <option value="REQUIRES_ACTION"${paySel("REQUIRES_ACTION")}>Requires action</option>
          <option value="LPO"${paySel("LPO")}>LPO</option>
          <option value="FRIENDS_TRANSFER"${paySel("FRIENDS_TRANSFER")}>Friends / transfer</option>
          <option value="SUCCEEDED"${paySel("SUCCEEDED")}>Paid</option>
        </select>
      </div>
      <div class="fd-field">
        <label for="fd-pay-method">Payment method</label>
        <select id="fd-pay-method" name="paymentMethod" class="fd-input">
          <option value=""${methodSel("")}>—</option>
          <option value="CASH"${methodSel("CASH")}>Cash</option>
          <option value="CARD"${methodSel("CARD")}>Card</option>
          <option value="BANK_TRANSFER"${methodSel("BANK_TRANSFER")}>Bank transfer</option>
          <option value="OTA_PREPAID"${methodSel("OTA_PREPAID")}>OTA / prepaid</option>
        </select>
      </div>
    </div>
    <div class="fd-field">
      <label for="fd-internal-notes">Internal notes <span class="fd-hint" style="font-weight:400">(staff only)</span></label>
      <textarea id="fd-internal-notes" name="internalNotes" rows="2" class="fd-input" placeholder="Not sent to guest">${internalNotes}</textarea>
    </div>
  </section>
  <section class="fd-sec fd-sec--after" aria-labelledby="fd-sec-after-title">
    <div class="fd-sec-head">
      <h3 class="fd-sec-title" id="fd-sec-after-title">After booking</h3>
      <span class="fd-sec-tag">Optional</span>
    </div>
    <p class="fd-hint" style="margin-top:-6px">Uses the mobile number above after save.</p>
    <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-size:14px;font-weight:500">
      <input type="checkbox" name="sendInvoiceWhatsApp" value="1"${invWhats} style="margin-top:3px" />
      <span>WhatsApp invoice PDF</span>
    </label>
    <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-size:14px;font-weight:500">
      <input type="checkbox" name="openInvoicePrint" value="1"${invPrint} style="margin-top:3px" />
      <span>Open printable invoice</span>
    </label>
  </section>
  <div class="fd-actions">
    <button type="submit" class="fd-submit">Confirm check-in</button>
    <a class="btn-link" href="/admin/room-board?date=${escapeHtml(defaultCheckIn)}">Room board</a>
  </div>
<script>
window.__FD_PRICING__ = ${JSON.stringify({ mealPlans: fdPricing.mealPlans, extras: fdPricing.extras })};
(function () {
  var cur = "${escapeHtml(hotel.currency)}";
  function parseDay(s) {
    if (!s) return null;
    var p = s.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function formatIsoLocal(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function syncCheckoutMin() {
    var ci = document.getElementById("fd-check-in");
    var co = document.getElementById("fd-check-out");
    if (!ci || !co) return;
    var d = parseDay(ci.value);
    if (!d) return;
    var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    var iso = formatIsoLocal(next);
    co.setAttribute("min", iso);
    var coD = parseDay(co.value);
    if (!coD || coD.getTime() <= d.getTime()) {
      co.value = iso;
    }
  }
  function updateRoomSummary() {
    var sel = document.getElementById("fd-room-unit");
    var box = document.getElementById("fd-room-summary");
    if (!sel || !box) return;
    var opt = sel.selectedOptions[0];
    if (!opt || !opt.value) {
      box.textContent = "Select a room unit before confirming.";
      box.className = "fd-room-summary fd-room-summary--empty";
      return;
    }
    var og = "";
    var par = opt.parentElement;
    if (par && par.tagName === "OPTGROUP") og = par.label || "";
    var unitLabel = (opt.textContent || "").replace(/\\s+/g, " ").trim();
    box.textContent = "Assigning: " + unitLabel + (og ? " · " + og : "");
    box.className = "fd-room-summary fd-room-summary--ok";
  }
  function recalc() {
    var pricing = window.__FD_PRICING__;
    if (!pricing || !pricing.mealPlans) return;
    var sel = document.getElementById("fd-room-unit");
    var opt = sel && sel.selectedOptions[0];
    var nightly = opt ? parseFloat(opt.getAttribute("data-nightly") || "0") : 0;
    var ci = parseDay(document.getElementById("fd-check-in").value);
    var co = parseDay(document.getElementById("fd-check-out").value);
    var nights = 1;
    if (ci && co && co > ci) nights = Math.round((co - ci) / 86400000);
    var adults = Math.max(1, parseInt(document.getElementById("fd-adults").value, 10) || 1);
    var children = Math.max(0, parseInt(document.getElementById("fd-children").value, 10) || 0);
    var pax = adults + children;
    var mp = document.getElementById("fd-meal-plan").value;
    var mealRate = (pricing.mealPlans[mp] && pricing.mealPlans[mp].perPersonPerNight) || 0;
    var roomSub = nightly * nights;
    var mealSub = mealRate * pax * nights;
    var extrasSub = 0;
    var extraLines = [];
    document.querySelectorAll(".fd-extra:checked").forEach(function (cb) {
      var id = cb.value;
      var ex = pricing.extras.filter(function (e) { return e.id === id; })[0];
      if (!ex) return;
      var amt = 0;
      if (ex.applyPerHour) {
        var hi = document.getElementById("fd-extra-hour-" + id);
        var h = hi ? parseFloat(hi.value) : 1;
        if (isNaN(h) || h < 0.25) h = 1;
        amt = ex.amount * h;
        extraLines.push(ex.label + " (" + h + " h): " + amt.toFixed(2) + " " + cur);
      } else if (ex.applyPerNight) {
        amt = ex.amount * nights;
        extraLines.push(ex.label + ": " + amt.toFixed(2) + " " + cur);
      } else {
        amt = ex.amount;
        extraLines.push(ex.label + ": " + amt.toFixed(2) + " " + cur);
      }
      extrasSub += amt;
    });
    var adj = parseFloat(document.getElementById("fd-adjustment").value);
    if (isNaN(adj)) adj = 0;
    var total = roomSub + mealSub + extrasSub + adj;
    document.getElementById("fd-total").value = total >= 0 ? total.toFixed(2) : "0";
    var br = document.getElementById("fd-breakdown");
    var lines = [
      "Room (rack × " + nights + " night" + (nights === 1 ? "" : "s") + "): " + roomSub.toFixed(2) + " " + cur,
      "Meals (" + mp + ", " + pax + " guest" + (pax === 1 ? "" : "s") + "): " + mealSub.toFixed(2) + " " + cur
    ];
    extraLines.forEach(function (l) { lines.push(l); });
    lines.push("Adjustment: " + adj.toFixed(2) + " " + cur);
    lines.push("<strong>Total: " + total.toFixed(2) + " " + cur + "</strong>");
    br.innerHTML = lines.join("<br/>");
  }
  var ciEl = document.getElementById("fd-check-in");
  if (ciEl) {
    ciEl.addEventListener("change", syncCheckoutMin);
    ciEl.addEventListener("input", syncCheckoutMin);
  }
  syncCheckoutMin();
  ["fd-check-in","fd-check-out","fd-adults","fd-children","fd-meal-plan","fd-room-unit","fd-adjustment"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", recalc);
    if (el) el.addEventListener("input", recalc);
  });
  var ru = document.getElementById("fd-room-unit");
  if (ru) {
    ru.addEventListener("change", updateRoomSummary);
    ru.addEventListener("input", updateRoomSummary);
  }
  updateRoomSummary();
  document.querySelectorAll(".fd-extra").forEach(function (cb) {
    cb.addEventListener("change", recalc);
  });
  document.querySelectorAll(".fd-extra-hour-input").forEach(function (el) {
    el.addEventListener("change", recalc);
    el.addEventListener("input", recalc);
  });
  recalc();
})();
</script>
</form>
</div>`;
}
