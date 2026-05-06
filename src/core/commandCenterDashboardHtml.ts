/**
 * Pure HTML builder for the front-desk Command Center (Today) dashboard.
 * Data loading stays in admin routes; this file only renders the VM.
 */

export type CommandCenterRoomSnapshot = {
  total: number;
  available: number;
  reserved: number;
  occupied: number;
  cleaning: number;
  maintenance: number;
};

export type CommandCenterArrivalRow = {
  guestLabel: string;
  roomLine: string;
  arrivalTime: string;
  statusHtml: string;
  primaryHref: string;
  primaryLabel: string;
};

export type CommandCenterDepartureRow = {
  guestLabel: string;
  roomLine: string;
  balanceLine: string;
  primaryHref: string;
  primaryLabel: string;
};

export type CommandCenterInHouseRow = {
  guestLabel: string;
  roomLine: string;
  stayLine: string;
  bookingHref: string;
  waHref: string | null;
};

export type CommandCenterWhatsAppRow = {
  conversationId: string;
  guestLabel: string;
  snippet: string;
  badgeHtml: string;
};

export type CommandCenterOutletRow = {
  ticketId: string;
  outletKey: string;
  status: string;
  guestLabel: string;
  href: string;
};

export type CommandCenterServiceRow = {
  kindLabel: string;
  summary: string;
  detail: string;
  href: string;
  actionLabel: string;
};

export type CommandCenterDashboardVm = {
  hotelDisplayName: string;
  currency: string;
  timezone: string;
  dateLabel: string;
  roomBoardHref: string;
  /** Section visibility mirrors permissions */
  show: {
    bookings: boolean;
    rooms: boolean;
    comms: boolean;
    fb: boolean;
    hk: boolean;
  };
  roomSnapshot: CommandCenterRoomSnapshot | null;
  arrivals: CommandCenterArrivalRow[];
  departures: CommandCenterDepartureRow[];
  inHouse: CommandCenterInHouseRow[];
  whatsappRows: CommandCenterWhatsAppRow[];
  whatsappPendingInbound: number;
  outletRows: CommandCenterOutletRow[];
  serviceRows: CommandCenterServiceRow[];
  financial: {
    expectedRevenueToday: number;
    unpaidBookings: number;
    pendingPaymentIntents: number;
  };
  /** Pre-escaped safe HTML fragments for <li> content */
  alertItemsHtml: string[];
};

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ccTable(headers: string[], bodyRows: string, empty: string): string {
  if (!bodyRows.trim()) {
    return `<p class="cc-empty">${empty}</p>`;
  }
  return `<div class="cc-table-wrap"><table class="cc-table"><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join("")}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}

export function renderCommandCenterDashboard(htmlStyles: string, vm: CommandCenterDashboardVm): string {
  const alertStrip =
    vm.alertItemsHtml.length > 0
      ? `<div class="cc-alert-strip" role="region" aria-label="Operational alerts"><strong>Needs attention</strong><ul>${vm.alertItemsHtml
          .map((h) => `<li>${h}</li>`)
          .join("")}</ul></div>`
      : "";

  const roomCard =
    vm.show.rooms && vm.roomSnapshot
      ? `<section class="cc-card" aria-labelledby="cc-room-snap">
  <div class="cc-card-head">
    <h2 id="cc-room-snap">Room status snapshot</h2>
    <div class="cc-actions"><a href="${esc(vm.roomBoardHref)}">Open room grid →</a></div>
  </div>
  <div class="cc-kpis">
    <div class="cc-kpi"><strong>${vm.roomSnapshot.total}</strong><span>Total keys</span></div>
    <div class="cc-kpi"><strong>${vm.roomSnapshot.available}</strong><span>Vacant / ready</span></div>
    <div class="cc-kpi"><strong>${vm.roomSnapshot.reserved}</strong><span>Reserved / held</span></div>
    <div class="cc-kpi"><strong>${vm.roomSnapshot.occupied}</strong><span>Occupied</span></div>
    <div class="cc-kpi"><strong>${vm.roomSnapshot.cleaning}</strong><span>Dirty / cleaning</span></div>
    <div class="cc-kpi"><strong>${vm.roomSnapshot.maintenance}</strong><span>Maintenance / OOO</span></div>
  </div>
  <p class="cc-empty" style="margin:0;padding-top:4px">Reserved includes inventory holds; maintenance covers Out-of-order units and closed inventory.</p>
</section>`
      : vm.show.rooms
        ? `<section class="cc-card"><h2>Room status snapshot</h2><p class="cc-empty">Room snapshot could not be loaded. Use <a href="${esc(
            vm.roomBoardHref
          )}">room grid</a>.</p></section>`
        : "";

  const arrivalsBody = vm.arrivals
    .map(
      (r) =>
        `<tr><td class="cc-guest">${esc(r.guestLabel)}</td><td>${esc(r.roomLine)}</td><td>${esc(r.arrivalTime)}</td><td>${r.statusHtml}</td><td><a href="${esc(
          r.primaryHref
        )}">${esc(r.primaryLabel)}</a></td></tr>`
    )
    .join("");

  const departuresBody = vm.departures
    .map(
      (r) =>
        `<tr><td class="cc-guest">${esc(r.guestLabel)}</td><td>${esc(r.roomLine)}</td><td>${esc(r.balanceLine)}</td><td><a href="${esc(r.primaryHref)}">${esc(
          r.primaryLabel
        )}</a></td></tr>`
    )
    .join("");

  const inHouseBody = vm.inHouse
    .map(
      (r) =>
        `<tr><td class="cc-guest">${esc(r.guestLabel)}</td><td>${esc(r.roomLine)}</td><td>${esc(r.stayLine)}</td><td><a href="${esc(
          r.bookingHref
        )}">Booking</a>${r.waHref ? ` · <a href="${esc(r.waHref)}">WhatsApp</a>` : ""}</td></tr>`
    )
    .join("");

  const waBody = vm.whatsappRows
    .map(
      (r) =>
        `<tr><td class="cc-guest">${esc(r.guestLabel)}</td><td>${r.badgeHtml}</td><td>${esc(r.snippet)}</td><td><a href="/admin/conversations/${encodeURIComponent(
          r.conversationId
        )}">Open →</a></td></tr>`
    )
    .join("");

  const outletBody = vm.outletRows
    .map(
      (r) =>
        `<tr><td>${esc(r.outletKey)}</td><td>${esc(r.status)}</td><td class="cc-guest">${esc(r.guestLabel)}</td><td><a href="${esc(
          r.href
        )}">Orders →</a></td></tr>`
    )
    .join("");

  const serviceBody = vm.serviceRows
    .map(
      (r) =>
        `<tr><td>${esc(r.kindLabel)}</td><td class="cc-guest">${esc(r.summary)}</td><td>${esc(r.detail)}</td><td><a href="${esc(r.href)}">${esc(
          r.actionLabel
        )}</a></td></tr>`
    )
    .join("");

  const bookingsColumn = vm.show.bookings
    ? `<div class="cc-grid-main duplicate-cols">
  <section class="cc-card">
    <div class="cc-card-head">
      <h2>Today&apos;s arrivals</h2>
      <div class="cc-actions"><a href="/admin/front-desk/check-in?date=${esc(vm.dateLabel)}">Check-in desk →</a></div>
    </div>
    ${ccTable(["Guest", "Room / type", "Arrival", "Status", "Action"], arrivalsBody, "No arrivals scheduled for this calendar day.")}
  </section>
  <section class="cc-card">
    <div class="cc-card-head">
      <h2>Today&apos;s departures</h2>
      <div class="cc-actions"><a href="/admin/front-desk/check-out?date=${esc(vm.dateLabel)}">Check-out desk →</a></div>
    </div>
    ${ccTable(["Guest", "Room", "Balance / pay", "Action"], departuresBody, "No departures scheduled for this calendar day.")}
  </section>
  <section class="cc-card">
    <div class="cc-card-head">
      <h2>In-house guests</h2>
      <div class="cc-actions"><a href="/admin/bookings">All reservations →</a></div>
    </div>
    ${ccTable(["Guest", "Room", "Stay", "Actions"], inHouseBody, "No guests marked in-house (checked-in) right now.")}
  </section>
</div>`
    : `<div class="cc-card"><p class="cc-empty">Reservation lists are hidden — your role does not include bookings access.</p></div>`;

  const commsCard = vm.show.comms
    ? `<section class="cc-card">
  <div class="cc-card-head">
    <h2>WhatsApp — recent guest turns</h2>
    <div class="cc-actions"><a href="/admin/conversations">Inbox →</a></div>
  </div>
  <p class="cc-empty" style="padding-bottom:0;margin-bottom:8px">Latest threads where the last message is <strong>inbound</strong> (guest spoke last). Count: <strong>${vm.whatsappPendingInbound}</strong></p>
  ${ccTable(["Guest", "State", "Last message", "Action"], waBody, "No inbound-pending threads — you are caught up.")}
</section>`
    : "";

  const fbCard = vm.show.fb
    ? `<section class="cc-card">
  <div class="cc-card-head">
    <h2>Restaurant / café — outlet tickets</h2>
    <div class="cc-actions"><a href="/admin/outlet-dashboard">Outlet board →</a> <a href="/admin/outlet-orders">History →</a></div>
  </div>
  ${ccTable(["Outlet", "Ticket", "Guest / stay", "Action"], outletBody, "No active kitchen / outlet tickets.")}
</section>`
    : "";

  const hkServiceCard =
    vm.show.hk || vm.show.bookings || vm.show.rooms
      ? `<section class="cc-card">
  <div class="cc-card-head">
    <h2>Service requests &amp; housekeeping</h2>
    <div class="cc-actions"><a href="/admin/housekeeping">Housekeeping queue →</a></div>
  </div>
  ${ccTable(["Type", "Summary", "Detail", "Open"], serviceBody, "No open housekeeping tasks or escalated guest feedback in view.")}
</section>`
      : "";

  const financialCard = vm.show.bookings
    ? `<section class="cc-card">
  <div class="cc-card-head">
    <h2>Financial pulse</h2>
    <div class="cc-actions"><a href="/admin/bookings/search">Find folio →</a></div>
  </div>
  <div class="cc-kpis">
    <div class="cc-kpi"><strong>${esc(vm.currency)} ${vm.financial.expectedRevenueToday.toFixed(2)}</strong><span>Expected room revenue (arrivals today)</span></div>
    <div class="cc-kpi"><strong>${vm.financial.unpaidBookings}</strong><span>Bookings not fully paid (header)</span></div>
    <div class="cc-kpi"><strong>${vm.financial.pendingPaymentIntents}</strong><span>Pending / action payment links</span></div>
  </div>
  <p class="cc-empty" style="margin-top:10px">Figures use existing booking payment states and today&apos;s confirmed arrivals. Full folio balances live on each booking.</p>
</section>`
    : "";

  return `${htmlStyles}
<div class="cc-shell">
  <div class="pms-hero">
    <h1>Command Center</h1>
    <p>Operational control room for ${esc(vm.hotelDisplayName)} — arrivals, departures, rooms, guest messages, and cash pointers for the active property filter.</p>
  </div>
  <div class="cc-meta">
    <span>Ops date <code>${esc(vm.dateLabel)}</code></span>
    <span>Timezone <code>${esc(vm.timezone)}</code></span>
    <span>Currency <code>${esc(vm.currency)}</code></span>
  </div>
  ${alertStrip}
  ${roomCard ? `<div class="cc-grid-main">${roomCard}</div>` : ""}
  ${bookingsColumn}
  <div class="cc-grid-wide">
    ${commsCard}
    ${fbCard}
    ${hkServiceCard}
    ${financialCard}
  </div>
</div>`;
}
