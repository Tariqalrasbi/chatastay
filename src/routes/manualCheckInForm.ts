import type { Request } from "express";
import type { RoomType, RoomUnit } from "@prisma/client";
import { getMealPlanUnitRate, loadFrontDeskPricing } from "../core/frontDeskPricing";
import { MANUAL_CHECK_IN_NATIONALITY_OPTIONS } from "./manualCheckInNationalities";
import type { ManualCheckInRoomSelectionSnapshot } from "./manualCheckInRoomSelection";

export type ManualCheckInFormValues = {
  guestFullName: string;
  guestPhone: string;
  guestPhoneCountryCode: string;
  guestPhoneCountryCodeCustom: string;
  guestEmail: string;
  nationality: string;
  idNumber: string;
  /** Maps to ChannelProvider for booking reference prefix (WI, PH, CO, RF). */
  bookingChannel: string;
  /**
   * Hospitality "Booked by" (Direct, OTA, Tour company, Walk-in, Corporate, Friend/Gift, Phone).
   * Stored on the per-stay `ROOM_UNIT_GUEST_DETAILS` audit so it surfaces in the room-unit details
   * view alongside the rest of the registration card.
   */
  bookedBy: string;
  /** Free-text company name; only meaningful when `bookedBy === "TOUR_COMPANY"`. */
  tourCompany: string;
  /** Card / bank-transfer reference number — captured at desk for finance reconciliation. */
  transactionNumber: string;
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

export function resolveRoomTypeIdForUnit(
  roomTypes: Array<{ id: string; roomUnits: Array<{ id: string }> }>,
  unitId: string | undefined | null
): string | null {
  if (!unitId) return null;
  for (const rt of roomTypes) {
    if (rt.roomUnits.some((u) => u.id === unitId)) return rt.id;
  }
  return null;
}

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
    guestPhoneCountryCode: String(req.body.guestPhoneCountryCode ?? "+968"),
    guestPhoneCountryCodeCustom: String(req.body.guestPhoneCountryCodeCustom ?? ""),
    guestEmail: String(req.body.guestEmail ?? ""),
    nationality: String(req.body.nationality ?? ""),
    idNumber: String(req.body.idNumber ?? ""),
    bookingChannel: String(req.body.bookingChannel ?? "DIRECT"),
    bookedBy: String(req.body.bookedBy ?? "WALK_IN"),
    tourCompany: String(req.body.tourCompany ?? ""),
    transactionNumber: String(req.body.transactionNumber ?? ""),
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
  options: {
    defaultDay: Date;
    errorMsg?: string;
    form?: ManualCheckInFormValues;
    roomSelection: ManualCheckInRoomSelectionSnapshot;
    selectedRoomTypeId?: string | null;
  }
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

  const { roomSelection, selectedRoomTypeId: selectedRoomTypeIdOpt } = options;
  const selectableIds = new Set(roomSelection.selectableRoomTypes.map((r) => r.id));
  const resolvedTypeId = resolveRoomTypeIdForUnit(roomTypes, form?.roomUnitId);
  const initialRoomTypeId =
    selectedRoomTypeIdOpt && selectableIds.has(selectedRoomTypeIdOpt)
      ? selectedRoomTypeIdOpt
      : resolvedTypeId && selectableIds.has(resolvedTypeId)
        ? resolvedTypeId
        : "";

  const roomTypeOptionsHtml = roomSelection.selectableRoomTypes
    .map((rt) => {
      const sel = rt.id === initialRoomTypeId ? " selected" : "";
      return `<option value="${escapeHtml(rt.id)}" data-nightly="${String(rt.baseNightlyRate)}"${sel}>${escapeHtml(
        `${rt.name} — ${formatMoney(rt.baseNightlyRate, hotel.currency)}/night`
      )}</option>`;
    })
    .join("");

  const initialUnits = initialRoomTypeId ? (roomSelection.availableUnitsByRoomTypeId[initialRoomTypeId] ?? []) : [];
  const unitOptionsHtml = initialUnits
    .map((u) => {
      const sel = form?.roomUnitId === u.id ? " selected" : "";
      const nightly =
        roomSelection.selectableRoomTypes.find((r) => r.id === initialRoomTypeId)?.baseNightlyRate ?? 0;
      return `<option value="${escapeHtml(u.id)}" data-nightly="${String(nightly)}"${sel}>${escapeHtml(u.name)}</option>`;
    })
    .join("");

  const roomPaxWarnVisible = roomSelection.selectableRoomTypes.length === 0;
  const roomPaxWarnHtml = `<p id="fd-room-pax-warn" class="badge" role="alert" style="display:${roomPaxWarnVisible ? "block" : "none"};margin-top:8px;background:#fef3c7;color:#92400e;border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.4">No room category is available for this guest mix and stay dates (occupancy, inventory, or all physical units are taken). Adjust dates, guest counts, or try another category later.</p>`;

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

  const br = getMealPlanUnitRate("BREAKFAST");
  const hr = getMealPlanUnitRate("HALF_BOARD");
  const fr = getMealPlanUnitRate("FULL_BOARD");
  const mealHints = `Breakfast +${formatMoney(br.rate, hotel.currency)}/${br.mode === "PER_GUEST_PER_NIGHT" ? "guest" : "room"}/night · Half +${formatMoney(hr.rate, hotel.currency)}/${hr.mode === "PER_GUEST_PER_NIGHT" ? "guest" : "room"}/night · Full +${formatMoney(fr.rate, hotel.currency)}/${fr.mode === "PER_GUEST_PER_NIGHT" ? "guest" : "room"}/night`;
  const mp = (form?.mealPlan ?? "NONE").toUpperCase();
  const mealSelected = (v: string) => (mp === v ? " selected" : "");
  const mealCardOn = (v: string) => (mp === v ? " fd-meal-card--on" : "");
  const bc = (form?.bookingChannel ?? "DIRECT").toUpperCase();
  const bcSel = (v: string) => (bc === v ? " selected" : "");
  const ps = form?.paymentStatus ?? "PENDING";
  const pm = form?.paymentMethod ?? "";
  const paySel = (v: string) => (ps === v ? " selected" : "");
  const methodSel = (v: string) => (pm === v ? " selected" : "");

  const guestFullName = escapeHtml(form?.guestFullName ?? "");
  const guestPhone = escapeHtml(form?.guestPhone ?? "");
  const guestPhoneCountryCode = escapeHtml(form?.guestPhoneCountryCode ?? "+968");
  const guestPhoneCountryCodeCustom = escapeHtml(form?.guestPhoneCountryCodeCustom ?? "");
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
  const bookedBy = (form?.bookedBy ?? "WALK_IN").toUpperCase();
  const bookedBySel = (v: string) => (bookedBy === v ? " selected" : "");
  const tourCompany = escapeHtml(form?.tourCompany ?? "");
  const transactionNumber = escapeHtml(form?.transactionNumber ?? "");
  const tourCompanyHidden = bookedBy === "TOUR_COMPANY" ? "" : "display:none";
  // Card / bank-transfer / OTA-prepaid all need a finance reference; cash usually does not.
  const txnFieldHidden = (form?.paymentMethod ?? "") && ["CARD", "BANK_TRANSFER", "OTA_PREPAID"].includes((form?.paymentMethod ?? "").toUpperCase()) ? "" : "display:none";

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
.fd-meal-fieldset { border: 1px solid #cfe8e0; border-radius: 12px; padding: 12px 14px; margin: 0; background: #f7fdfb; }
.fd-legend-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 700; font-size: 15px; padding: 0 2px; }
.fd-meal-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 8px; }
@media (min-width: 560px) {
  .fd-meal-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.fd-meal-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 2px solid #d8eee5;
  border-radius: 10px;
  padding: 10px 8px;
  cursor: pointer;
  background: #fff;
  position: relative;
  min-height: 72px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.fd-meal-card:hover { border-color: #94d4c9; }
.fd-meal-card--on { border-color: #128c7e; box-shadow: 0 0 0 1px #128c7e; background: #ecfff8; }
.fd-meal-card input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.fd-meal-card-title { font-weight: 700; font-size: 14px; color: #0f172a; }
.fd-meal-card-desc { font-size: 12px; color: #64748b; line-height: 1.35; }
</style>
<div class="fd-checkin-wrap">
<h2 style="margin-bottom:8px">Manual check-in</h2>
<p class="muted" style="margin-top:0;line-height:1.5">${escapeHtml(hotel.displayName)} — Walk-in or phone booking: one room, confirmed stay, board updated. <strong>Tab</strong> moves top-to-bottom; start with guest name.</p>
<p class="fd-legend"><span class="fd-req">*</span> = required before confirm.</p>
${errorMsg ? `<p class="badge" role="alert" style="background:#fee2e2;color:#991b1b;border-radius:8px;padding:10px 14px;font-size:14px">${escapeHtml(errorMsg)}</p>` : ""}
<form method="post" action="/admin/front-desk/check-in" enctype="multipart/form-data" class="fd-checkin-form">
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
        <label for="fd-guest-phone">Mobile / WhatsApp <span class="fd-req">*</span></label>
        <div style="display:grid;grid-template-columns:120px 92px minmax(150px,1fr);gap:8px;align-items:end">
          <select name="guestPhoneCountryCode" class="fd-input" aria-label="Country code">
            <option value="+968" ${guestPhoneCountryCode === "+968" ? "selected" : ""}>Oman +968</option>
            <option value="+971" ${guestPhoneCountryCode === "+971" ? "selected" : ""}>UAE +971</option>
            <option value="+966" ${guestPhoneCountryCode === "+966" ? "selected" : ""}>KSA +966</option>
            <option value="+974" ${guestPhoneCountryCode === "+974" ? "selected" : ""}>Qatar +974</option>
            <option value="+973" ${guestPhoneCountryCode === "+973" ? "selected" : ""}>Bahrain +973</option>
            <option value="+965" ${guestPhoneCountryCode === "+965" ? "selected" : ""}>Kuwait +965</option>
            <option value="+91" ${guestPhoneCountryCode === "+91" ? "selected" : ""}>India +91</option>
            <option value="+44" ${guestPhoneCountryCode === "+44" ? "selected" : ""}>UK +44</option>
            <option value="+1" ${guestPhoneCountryCode === "+1" ? "selected" : ""}>US/CA +1</option>
          </select>
          <input type="tel" name="guestPhoneCountryCodeCustom" value="${guestPhoneCountryCodeCustom}" class="fd-input" placeholder="+..." inputmode="tel" aria-label="Other country code" />
          <input type="tel" id="fd-guest-phone" name="guestPhone" required autocomplete="tel" value="${guestPhone}" class="fd-input" placeholder="local number or +968…" inputmode="tel" />
        </div>
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
    <div class="fd-grid-2">
      <div class="fd-field">
        <label for="fd-booked-by">Booked by</label>
        <select id="fd-booked-by" name="bookedBy" class="fd-input">
          <option value="WALK_IN"${bookedBySel("WALK_IN")}>Walk-in</option>
          <option value="DIRECT"${bookedBySel("DIRECT")}>Direct (web / call)</option>
          <option value="OTAS"${bookedBySel("OTAS")}>OTA (Booking.com / Airbnb / Expedia)</option>
          <option value="TOUR_COMPANY"${bookedBySel("TOUR_COMPANY")}>Tour company</option>
          <option value="CORPORATE"${bookedBySel("CORPORATE")}>Corporate</option>
          <option value="PHONE"${bookedBySel("PHONE")}>Phone</option>
          <option value="WHATSAPP"${bookedBySel("WHATSAPP")}>WhatsApp</option>
          <option value="FRIEND_GIFT"${bookedBySel("FRIEND_GIFT")}>Friend / gift</option>
        </select>
      </div>
      <div class="fd-field" id="fd-tour-company-wrap" style="${tourCompanyHidden}">
        <label for="fd-tour-company">Tour company name</label>
        <input type="text" id="fd-tour-company" name="tourCompany" value="${tourCompany}" class="fd-input" placeholder="e.g. Oman Tours LLC" />
      </div>
    </div>
    <div class="fd-field">
      <label for="fd-id-upload">ID / passport scan <span class="fd-hint" style="font-weight:400">(image or PDF, max 5 MB)</span></label>
      <input type="file" id="fd-id-upload" name="idCard" accept=".jpg,.jpeg,.png,.pdf,.webp" class="fd-input" />
      <p class="fd-hint">Saved to the room-unit registration card. You can also re-upload from the Reservation details page.</p>
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
    <fieldset class="fd-field fd-meal-fieldset" aria-labelledby="fd-meal-legend">
      <legend id="fd-meal-legend" class="fd-legend-row">
        <span class="fd-sec-tag">Meal plan</span>
        <span class="fd-hint" style="font-weight: 400">Pick before room category</span>
      </legend>
      <div class="fd-meal-grid" role="radiogroup" aria-label="Meal plan">
        <label class="fd-meal-card${mealCardOn("NONE")}">
          <input type="radio" name="mealPlan" value="NONE"${mealSelected("NONE")} />
          <span class="fd-meal-card-title">Room only</span>
          <span class="fd-meal-card-desc">No meals included</span>
        </label>
        <label class="fd-meal-card${mealCardOn("BREAKFAST")}">
          <input type="radio" name="mealPlan" value="BREAKFAST"${mealSelected("BREAKFAST")} />
          <span class="fd-meal-card-title">Breakfast</span>
          <span class="fd-meal-card-desc">Morning meal package</span>
        </label>
        <label class="fd-meal-card${mealCardOn("HALF_BOARD")}">
          <input type="radio" name="mealPlan" value="HALF_BOARD"${mealSelected("HALF_BOARD")} />
          <span class="fd-meal-card-title">Half board</span>
          <span class="fd-meal-card-desc">Breakfast + dinner</span>
        </label>
        <label class="fd-meal-card${mealCardOn("FULL_BOARD")}">
          <input type="radio" name="mealPlan" value="FULL_BOARD"${mealSelected("FULL_BOARD")} />
          <span class="fd-meal-card-title">Full board</span>
          <span class="fd-meal-card-desc">All main meals</span>
        </label>
      </div>
    </fieldset>
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
      <label for="fd-room-type">Room category <span class="fd-req">*</span></label>
      <select id="fd-room-type" name="manualRoomCategory" class="fd-input" required aria-describedby="fd-room-summary fd-room-pax-warn fd-room-rules fd-room-fetch-err">
        <option value="" data-nightly="0">— Choose category —</option>${roomTypeOptionsHtml}
      </select>
    </div>
    <div class="fd-field">
      <label for="fd-room-unit">Room unit <span class="fd-req">*</span></label>
      <select id="fd-room-unit" name="roomUnitId" class="fd-input" required ${initialRoomTypeId ? "" : "disabled"} aria-describedby="fd-room-summary fd-room-pax-warn fd-room-rules fd-room-fetch-err">
        <option value="" data-nightly="0">${initialRoomTypeId ? "— Choose unit —" : "— First choose a category —"}</option>${unitOptionsHtml}
      </select>
    </div>
    <p id="fd-room-fetch-err" class="badge" role="alert" style="display:none;margin-top:8px;background:#fee2e2;color:#991b1b;border-radius:8px;padding:8px 12px;font-size:13px"></p>
    <p id="fd-room-summary" class="fd-room-summary fd-room-summary--empty" role="status" aria-live="polite">Select a category, then a room unit.</p>
    ${roomPaxWarnHtml}
    <p id="fd-room-rules" class="fd-hint">Pick a <strong>category</strong> first (only types that fit adults/children and have availability appear). Then pick a <strong>unit</strong> that is free for these dates. Superior/Executive — max 2 adults &amp; 2 children; Suite — max 2 &amp; 3; Apartment — max 2 &amp; 4, or 4 adults with no children.</p>
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
    <div class="fd-field" id="fd-txn-wrap" style="${txnFieldHidden}">
      <label for="fd-txn-number">Transaction / reference number <span class="fd-hint" style="font-weight:400">(card receipt, bank ref, OTA voucher)</span></label>
      <input type="text" id="fd-txn-number" name="transactionNumber" value="${transactionNumber}" class="fd-input" placeholder="POS approval / bank reference" autocomplete="off" />
      <p class="fd-hint">Future-ready: this field is also where a card terminal / payment gateway callback can write back the auth code.</p>
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
window.__FD_ROOM_SNAPSHOT__ = ${JSON.stringify(roomSelection)};
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
  function fillRoomTypeOptions(snap) {
    var rtSel = document.getElementById("fd-room-type");
    if (!rtSel) return;
    var prev = rtSel.value;
    while (rtSel.options.length > 1) rtSel.remove(1);
    (snap.selectableRoomTypes || []).forEach(function (rt) {
      var o = document.createElement("option");
      o.value = rt.id;
      o.setAttribute("data-nightly", String(rt.baseNightlyRate));
      o.textContent = rt.name + " — " + Number(rt.baseNightlyRate).toFixed(2) + " " + cur + "/night";
      rtSel.appendChild(o);
    });
    if (prev && [].some.call(rtSel.options, function (x) { return x.value === prev; })) {
      rtSel.value = prev;
    }
  }
  function fillUnitOptionsForType(roomTypeId) {
    var uSel = document.getElementById("fd-room-unit");
    var snap = window.__FD_ROOM_SNAPSHOT__;
    if (!uSel || !snap) return;
    while (uSel.options.length > 1) uSel.remove(1);
    var nightly = "0";
    var rtMeta = (snap.selectableRoomTypes || []).filter(function (r) { return r.id === roomTypeId; })[0];
    if (rtMeta) nightly = String(rtMeta.baseNightlyRate);
    var units = (snap.availableUnitsByRoomTypeId && snap.availableUnitsByRoomTypeId[roomTypeId]) || [];
    units.forEach(function (u) {
      var o = document.createElement("option");
      o.value = u.id;
      o.setAttribute("data-nightly", nightly);
      o.textContent = u.name;
      uSel.appendChild(o);
    });
    uSel.disabled = !roomTypeId || units.length === 0;
    var ph = uSel.options[0];
    if (ph) {
      ph.textContent = roomTypeId ? "— Choose unit —" : "— First choose a category —";
    }
  }
  function onRoomTypeChange() {
    var rtSel = document.getElementById("fd-room-type");
    var uSel = document.getElementById("fd-room-unit");
    if (!rtSel || !uSel) return;
    var rid = rtSel.value;
    uSel.value = "";
    fillUnitOptionsForType(rid);
    updateRoomSummary();
    recalc();
  }
  var refreshTimer = null;
  function scheduleRefreshRoomSnapshot() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshRoomSnapshot, 320);
  }
  function refreshRoomSnapshot() {
    var ci = document.getElementById("fd-check-in");
    var co = document.getElementById("fd-check-out");
    var aEl = document.getElementById("fd-adults");
    var cEl = document.getElementById("fd-children");
    var errEl = document.getElementById("fd-room-fetch-err");
    if (!ci || !co || !aEl || !cEl) return;
    var q =
      "?checkIn=" + encodeURIComponent(ci.value) +
      "&checkOut=" + encodeURIComponent(co.value) +
      "&adults=" + encodeURIComponent(aEl.value) +
      "&children=" + encodeURIComponent(cEl.value);
    if (errEl) {
      errEl.style.display = "none";
      errEl.textContent = "";
    }
    fetch("/admin/front-desk/check-in/room-options" + q, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load room options.");
        return r.json();
      })
      .then(function (snap) {
        window.__FD_ROOM_SNAPSHOT__ = snap;
        var rtSel = document.getElementById("fd-room-type");
        var uSel = document.getElementById("fd-room-unit");
        var prevRt = rtSel ? rtSel.value : "";
        var prevU = uSel ? uSel.value : "";
        fillRoomTypeOptions(snap);
        if (prevRt && rtSel && [].some.call(rtSel.options, function (o) { return o.value === prevRt; })) {
          rtSel.value = prevRt;
          fillUnitOptionsForType(prevRt);
          if (prevU && uSel && [].some.call(uSel.options, function (o) { return o.value === prevU; })) {
            uSel.value = prevU;
          }
        } else if (rtSel) {
          rtSel.value = "";
          fillUnitOptionsForType("");
        }
        var warn = document.getElementById("fd-room-pax-warn");
        if (warn) {
          warn.style.display = (snap.selectableRoomTypes && snap.selectableRoomTypes.length) ? "none" : "block";
        }
        updateRoomSummary();
        recalc();
      })
      .catch(function (e) {
        if (errEl) {
          errEl.style.display = "block";
          errEl.textContent = e && e.message ? e.message : "Could not refresh room list.";
        }
      });
  }
  function updateRoomSummary() {
    var rtSel = document.getElementById("fd-room-type");
    var sel = document.getElementById("fd-room-unit");
    var box = document.getElementById("fd-room-summary");
    if (!sel || !box) return;
    var rtLabel = "";
    if (rtSel && rtSel.selectedOptions[0] && rtSel.value) {
      rtLabel = (rtSel.selectedOptions[0].textContent || "").replace(/\\s+/g, " ").trim();
    }
    var opt = sel.selectedOptions[0];
    if (!rtSel || !rtSel.value) {
      box.textContent = "Choose a room category that fits your guests, then pick an available unit.";
      box.className = "fd-room-summary fd-room-summary--empty";
      return;
    }
    if (!opt || !opt.value) {
      box.textContent = "Category: " + rtLabel + ". Now select a physical unit.";
      box.className = "fd-room-summary fd-room-summary--empty";
      return;
    }
    var unitLabel = (opt.textContent || "").replace(/\\s+/g, " ").trim();
    box.textContent = "Assigning: " + unitLabel + " · " + rtLabel;
    box.className = "fd-room-summary fd-room-summary--ok";
  }
  // Mirror of the server formula in src/core/frontDeskPricing.ts (computeManualCheckInTotal +
  // computeMealPlanSurchargeForStay). The previous implementation read only the legacy
  // perPersonPerNight key and applied it per-pax even when the config was PER_ROOM_PER_NIGHT —
  // which is the hospitality-industry default and what the server actually uses. That caused the
  // breakdown shown to receptionists to disagree with the saved total. This now respects
  // pricingMode, falls back through perRoomPerNight → perPersonPerNight legacy, and prints a
  // transparent line so the rate × units × nights computation is auditable on the form itself.
  function resolveMealPlanRate(row) {
    if (!row) return { mode: "PER_ROOM_PER_NIGHT", rate: 0 };
    var mode = (row.pricingMode === "PER_GUEST_PER_NIGHT") ? "PER_GUEST_PER_NIGHT" : "PER_ROOM_PER_NIGHT";
    if (mode === "PER_GUEST_PER_NIGHT") {
      return { mode: mode, rate: Number(row.perGuestPerNight != null ? row.perGuestPerNight : (row.perPersonPerNight || 0)) || 0 };
    }
    return { mode: mode, rate: Number(row.perRoomPerNight != null ? row.perRoomPerNight : (row.perPersonPerNight || 0)) || 0 };
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
    var rooms = 1; // manual check-in is always one physical room
    var mpEl = document.querySelector('input[name="mealPlan"]:checked');
    var mp = mpEl ? mpEl.value : "NONE";
    var mpResolved = resolveMealPlanRate(pricing.mealPlans[mp]);
    var roomSub = nightly * nights * rooms;
    var mealUnits = mpResolved.mode === "PER_GUEST_PER_NIGHT" ? pax : rooms;
    var mealUnitLabel = mpResolved.mode === "PER_GUEST_PER_NIGHT"
      ? (pax + " guest" + (pax === 1 ? "" : "s"))
      : (rooms + " room" + (rooms === 1 ? "" : "s"));
    var mealSub = mp === "NONE" ? 0 : mpResolved.rate * mealUnits * nights;
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
        extraLines.push(ex.label + " (" + h + " h × " + ex.amount.toFixed(2) + " " + cur + "): " + amt.toFixed(2) + " " + cur);
      } else if (ex.applyPerNight) {
        amt = ex.amount * nights;
        extraLines.push(ex.label + " (" + nights + " night" + (nights === 1 ? "" : "s") + " × " + ex.amount.toFixed(2) + " " + cur + "): " + amt.toFixed(2) + " " + cur);
      } else {
        amt = ex.amount;
        extraLines.push(ex.label + " (flat): " + amt.toFixed(2) + " " + cur);
      }
      extrasSub += amt;
    });
    var adj = parseFloat(document.getElementById("fd-adjustment").value);
    if (isNaN(adj)) adj = 0;
    var total = roomSub + mealSub + extrasSub + adj;
    document.getElementById("fd-total").value = total >= 0 ? total.toFixed(2) : "0";
    var br = document.getElementById("fd-breakdown");
    var lines = [];
    lines.push("Room: " + nightly.toFixed(2) + " " + cur + "/night × " + nights + " night" + (nights === 1 ? "" : "s") + " × " + rooms + " room = <strong>" + roomSub.toFixed(2) + " " + cur + "</strong>");
    if (mp !== "NONE" && mpResolved.rate > 0) {
      lines.push("Meals (" + mp + "): " + mpResolved.rate.toFixed(2) + " " + cur + "/" + (mpResolved.mode === "PER_GUEST_PER_NIGHT" ? "guest" : "room") + "/night × " + mealUnitLabel + " × " + nights + " night" + (nights === 1 ? "" : "s") + " = <strong>" + mealSub.toFixed(2) + " " + cur + "</strong>");
    } else {
      lines.push("Meals: room only (no surcharge)");
    }
    extraLines.forEach(function (l) { lines.push("Extras · " + l); });
    if (adj !== 0) {
      lines.push("Adjustment: " + (adj > 0 ? "+" : "") + adj.toFixed(2) + " " + cur);
    }
    lines.push('<hr style="border:0;border-top:1px solid #cbd5e1;margin:6px 0" />');
    lines.push('<strong style="font-size:14px">Total: ' + total.toFixed(2) + " " + cur + "</strong>");
    br.innerHTML = lines.join("<br/>");
  }
  var ciEl = document.getElementById("fd-check-in");
  if (ciEl) {
    ciEl.addEventListener("change", function () {
      syncCheckoutMin();
      scheduleRefreshRoomSnapshot();
      recalc();
    });
    ciEl.addEventListener("input", function () {
      syncCheckoutMin();
      scheduleRefreshRoomSnapshot();
      recalc();
    });
  }
  syncCheckoutMin();
  var coEl = document.getElementById("fd-check-out");
  if (coEl) {
    coEl.addEventListener("change", function () {
      scheduleRefreshRoomSnapshot();
      recalc();
    });
    coEl.addEventListener("input", function () {
      scheduleRefreshRoomSnapshot();
      recalc();
    });
  }
  document.querySelectorAll('input[name="mealPlan"]').forEach(function (el) {
    el.addEventListener("change", recalc);
  });
  var adjEl = document.getElementById("fd-adjustment");
  if (adjEl) {
    adjEl.addEventListener("change", recalc);
    adjEl.addEventListener("input", recalc);
  }
  ["fd-adults","fd-children"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", function () {
        scheduleRefreshRoomSnapshot();
        recalc();
      });
      el.addEventListener("input", function () {
        scheduleRefreshRoomSnapshot();
        recalc();
      });
    }
  });
  var rtEl = document.getElementById("fd-room-type");
  if (rtEl) rtEl.addEventListener("change", onRoomTypeChange);
  var ru = document.getElementById("fd-room-unit");
  if (ru) {
    ru.addEventListener("change", function () {
      updateRoomSummary();
      recalc();
    });
    ru.addEventListener("input", function () {
      updateRoomSummary();
      recalc();
    });
  }
  document.querySelectorAll(".fd-extra").forEach(function (cb) {
    cb.addEventListener("change", recalc);
  });
  document.querySelectorAll(".fd-extra-hour-input").forEach(function (el) {
    el.addEventListener("change", recalc);
    el.addEventListener("input", recalc);
  });
  // Conditional field visibility — hospitality UX: hide irrelevant inputs to keep the form scannable.
  function syncBookedBy() {
    var sel = document.getElementById("fd-booked-by");
    var wrap = document.getElementById("fd-tour-company-wrap");
    if (!sel || !wrap) return;
    wrap.style.display = sel.value === "TOUR_COMPANY" ? "" : "none";
  }
  function syncTxnVisibility() {
    var sel = document.getElementById("fd-pay-method");
    var wrap = document.getElementById("fd-txn-wrap");
    if (!sel || !wrap) return;
    var v = (sel.value || "").toUpperCase();
    wrap.style.display = (v === "CARD" || v === "BANK_TRANSFER" || v === "OTA_PREPAID") ? "" : "none";
  }
  var bbEl = document.getElementById("fd-booked-by");
  if (bbEl) bbEl.addEventListener("change", syncBookedBy);
  var pmEl = document.getElementById("fd-pay-method");
  if (pmEl) pmEl.addEventListener("change", syncTxnVisibility);
  syncBookedBy();
  syncTxnVisibility();
  updateRoomSummary();
  recalc();
})();
</script>
</form>
</div>`;
}
