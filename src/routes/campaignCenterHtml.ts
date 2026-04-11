import { ChannelProvider, SegmentTagKind } from "@prisma/client";
import { SEGMENT_TAG_LABELS } from "../core/guestSegmentation";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function val(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

function hasCheckbox(body: Record<string, unknown>, key: string): boolean {
  return body[key] === "1" || body[key] === "on";
}

function arr(body: Record<string, unknown>, key: string): string[] {
  const v = body[key];
  if (Array.isArray(v)) return v.map(String);
  if (v != null && String(v).length) return [String(v)];
  return [];
}

const CHANNELS: ChannelProvider[] = [
  ChannelProvider.DIRECT,
  ChannelProvider.WHATSAPP,
  ChannelProvider.PHONE,
  ChannelProvider.CORPORATE,
  ChannelProvider.REFERRAL,
  ChannelProvider.BOOKING_COM,
  ChannelProvider.AIRBNB,
  ChannelProvider.EXPEDIA
];

const MEALS = ["NONE", "BREAKFAST", "HALF_BOARD", "FULL_BOARD"];
const LOCALES = ["en", "ar", "fr", "de", "hi"];

/**
 * HTML for /admin/campaigns/new compose + preview (echoes `body` on POST).
 */
export function renderCampaignComposePage(params: {
  hotelDisplayName: string;
  roomTypes: Array<{ id: string; name: string }>;
  offers: Array<{ id: string; title: string; code: string; isActive: boolean }>;
  body: Record<string, unknown>;
  previewCount: number | null;
  errorMsg: string | null;
}): string {
  const { body, previewCount, errorMsg } = params;
  const tagAny = new Set(
    arr(body, "filterTagsAny").filter((t) => Object.values(SegmentTagKind).includes(t as SegmentTagKind)) as SegmentTagKind[]
  );
  const tagAll = new Set(
    arr(body, "filterTagsAll").filter((t) => Object.values(SegmentTagKind).includes(t as SegmentTagKind)) as SegmentTagKind[]
  );
  const srcSel = new Set(
    arr(body, "filterBookingSources").filter((s) => Object.values(ChannelProvider).includes(s as ChannelProvider)) as ChannelProvider[]
  );

  const errBlock = errorMsg
    ? `<p class="badge alert" role="alert" style="max-width:720px">${esc(errorMsg)}</p>`
    : "";
  const previewBlock =
    previewCount !== null
      ? `<p class="badge ok" style="max-width:720px"><strong>Audience preview:</strong> ${previewCount} guest(s) match these filters (with a usable phone on file).</p>`
      : "";

  const tagAnyBoxes = (Object.keys(SEGMENT_TAG_LABELS) as SegmentTagKind[])
    .map(
      (tag) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:2px 0">
  <input type="checkbox" name="filterTagsAny" value="${esc(tag)}" ${tagAny.has(tag) ? "checked" : ""} />
  ${esc(SEGMENT_TAG_LABELS[tag])}
</label>`
    )
    .join("");

  const tagAllBoxes = (Object.keys(SEGMENT_TAG_LABELS) as SegmentTagKind[])
    .map(
      (tag) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:2px 0">
  <input type="checkbox" name="filterTagsAll" value="${esc(tag)}" ${tagAll.has(tag) ? "checked" : ""} />
  ${esc(SEGMENT_TAG_LABELS[tag])}
</label>`
    )
    .join("");

  const sourceBoxes = CHANNELS.map(
    (ch) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:2px 8px 2px 0">
  <input type="checkbox" name="filterBookingSources" value="${esc(ch)}" ${srcSel.has(ch) ? "checked" : ""} />
  ${esc(ch)}
</label>`
  ).join("");

  const roomBoxes = params.roomTypes
    .map(
      (rt) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:2px 0">
  <input type="checkbox" name="filterRoomTypeIds" value="${esc(rt.id)}" ${arr(body, "filterRoomTypeIds").includes(rt.id) ? "checked" : ""} />
  ${esc(rt.name)}
</label>`
    )
    .join("");

  const mealBoxes = MEALS.map(
    (m) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:2px 8px 2px 0">
  <input type="checkbox" name="filterMealPlans" value="${esc(m)}" ${arr(body, "filterMealPlans").includes(m) ? "checked" : ""} />
  ${esc(m)}
</label>`
  ).join("");

  const localeBoxes = LOCALES.map(
    (l) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:2px 8px 2px 0">
  <input type="checkbox" name="filterLocales" value="${esc(l)}" ${arr(body, "filterLocales").includes(l) ? "checked" : ""} />
  ${esc(l)}
</label>`
  ).join("");

  const offerOpts = params.offers
    .filter((o) => o.isActive)
    .map((o) => `<option value="${esc(o.id)}" ${val(body, "linkedOfferId") === o.id ? "selected" : ""}>${esc(o.title)} (${esc(o.code)})</option>`)
    .join("");

  return `
<h2>Campaign center</h2>
<p class="muted" style="max-width:720px">${esc(params.hotelDisplayName)} — Target guests using tags, VIP, and booking history, preview the audience size, then send a WhatsApp message. Use responsibly; guests must have a phone on file.</p>
${errBlock}
${previewBlock}
<form method="post" action="/admin/campaigns/new" style="max-width:900px; display:grid; gap:14px">
  <section style="padding:14px; background:var(--card); border:1px solid var(--border); border-radius:12px">
    <h3 style="margin:0 0 10px">1. Campaign details</h3>
    <label>Campaign name *
      <input name="campaignName" required value="${esc(val(body, "campaignName"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" placeholder="e.g. Spring repeat guest offer" />
    </label>
    <label>Internal purpose / note
      <input name="purposeNote" value="${esc(val(body, "purposeNote"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" placeholder="Why we are sending this" />
    </label>
  </section>

  <section style="padding:14px; background:var(--card); border:1px solid var(--border); border-radius:12px">
    <h3 style="margin:0 0 10px">2. Audience filters</h3>
    <p class="muted" style="margin:0 0 10px;font-size:13px">All selected constraints apply together (AND). Leave fields blank to ignore.</p>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600">
      <input type="checkbox" name="filterVip" value="1" ${hasCheckbox(body, "filterVip") ? "checked" : ""} /> VIP guests only
    </label>
    <div style="margin-top:10px">
      <strong style="font-size:13px">Segment tags — match any</strong>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px;margin-top:6px">${tagAnyBoxes}</div>
    </div>
    <div style="margin-top:10px">
      <strong style="font-size:13px">Segment tags — match all (stricter)</strong>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px;margin-top:6px">${tagAllBoxes}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <label>Min completed stays <input type="number" name="filterMinCompletedStays" min="0" value="${esc(val(body, "filterMinCompletedStays"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
      <label>Max completed stays <input type="number" name="filterMaxCompletedStays" min="0" value="${esc(val(body, "filterMaxCompletedStays"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <label>Min lifetime spend (confirmed bookings) <input type="number" name="filterMinLifetimeSpend" min="0" step="0.01" value="${esc(val(body, "filterMinLifetimeSpend"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
      <label>Max lifetime spend <input type="number" name="filterMaxLifetimeSpend" min="0" step="0.01" value="${esc(val(body, "filterMaxLifetimeSpend"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <label>Had a completed stay within last (days) <input type="number" name="filterLastStayWithinDays" min="1" value="${esc(val(body, "filterLastStayWithinDays"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
      <label>No completed stay since (days) — lapsed guests <input type="number" name="filterNoStaySinceDays" min="1" value="${esc(val(body, "filterNoStaySinceDays"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
    </div>
    <div style="margin-top:10px">
      <strong style="font-size:13px">Booking source (any confirmed booking)</strong>
      <div style="display:flex;flex-wrap:wrap;margin-top:6px">${sourceBoxes}</div>
    </div>
    <label style="margin-top:10px;display:block">Nationality contains (optional)
      <input name="filterNationalityContains" value="${esc(val(body, "filterNationalityContains"))}" style="width:100%;max-width:400px;padding:8px;border:1px solid var(--border);border-radius:8px" placeholder="e.g. OM" />
    </label>
    <div style="margin-top:10px">
      <strong style="font-size:13px">Guest locale</strong>
      <div style="display:flex;flex-wrap:wrap;margin-top:6px">${localeBoxes}</div>
    </div>
    <div style="margin-top:10px">
      <strong style="font-size:13px">Previously booked room type</strong>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px;margin-top:6px">${roomBoxes || '<span class="muted">No room types</span>'}</div>
    </div>
    <div style="margin-top:10px">
      <strong style="font-size:13px">Meal plan on any stay</strong>
      <div style="display:flex;flex-wrap:wrap;margin-top:6px">${mealBoxes}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <label>Min nights (any one stay) <input type="number" name="filterMinNights" min="1" value="${esc(val(body, "filterMinNights"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
      <label>Max nights (any one stay) <input type="number" name="filterMaxNights" min="1" value="${esc(val(body, "filterMaxNights"))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px" /></label>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px">
      <input type="checkbox" name="ackBroadAudience" value="1" ${hasCheckbox(body, "ackBroadAudience") ? "checked" : ""} />
      I understand this can include <strong>all guests with a phone</strong> if no filters are set above.
    </label>
  </section>

  <section style="padding:14px; background:var(--card); border:1px solid var(--border); border-radius:12px">
    <h3 style="margin:0 0 10px">3. Message &amp; offer</h3>
    <label>Message body * (WhatsApp)
      <textarea name="messageBody" required rows="8" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-family:inherit" placeholder="Write your promotional or follow-up message.">${esc(val(body, "messageBody"))}</textarea>
    </label>
    <p class="muted" style="margin:4px 0 0;font-size:12px">Opening line will greet the guest by first name. You may include <code>{guest_name}</code> anywhere in the text.</p>
    <label>Optional linked offer (from Offers list)
      <select name="linkedOfferId" style="width:100%;max-width:480px;padding:8px;border:1px solid var(--border);border-radius:8px;margin-top:4px">
        <option value="">— None —</option>
        ${offerOpts}
      </select>
    </label>
  </section>

  <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
    <button type="submit" name="_action" value="preview" style="padding:10px 16px;border:0;border-radius:10px;background:#0f766e;color:#fff;font-weight:700">Preview audience</button>
    <button type="submit" name="_action" value="send" style="padding:10px 16px;border:0;border-radius:10px;background:#128c7e;color:#fff;font-weight:700">Send campaign</button>
    <a class="btn-link" href="/admin/campaigns">Back to campaigns</a>
  </div>
</form>`;
}
