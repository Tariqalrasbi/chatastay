import { FolioLedgerKind, FolioTransactionType, PaymentStatus } from "@prisma/client";
import { prisma } from "../db";

/** Parses `YYYY-MM-DDTHH:mm` as local server time (datetime-local). */
export function parseDateTimeLocalInput(raw: unknown, fallback: Date): Date {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return fallback;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
}

export function formatDateTimeLocalForInput(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day}T${h}:${min}`;
}

export type PaymentMethodBucket = { label: string; amount: number; count: number };

export type ShiftComputedSnapshot = {
  shiftStart: string;
  shiftEnd: string;
  currency: string;
  transactionCount: number;
  /** Folio charge lines (non-payment), net amounts */
  revenueRoom: number;
  revenueFb: number;
  revenueActivity: number;
  revenueOtherCharges: number;
  revenueTotal: number;
  paymentBuckets: PaymentMethodBucket[];
  cashReceived: number;
  totalPaymentsRecorded: number;
  pendingPaymentIntents: number;
  pendingPaymentAmount: number;
};

export function bucketFolioPaymentMethod(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return "Unspecified";
  if (s.includes("CASH")) return "Cash";
  if (s.includes("CARD") || s.includes("STRIPE") || s.includes("VISA") || s.includes("MASTER")) return "Card / credit";
  if (s.includes("BANK") || s.includes("TRANSFER") || s.includes("WIRE")) return "Bank transfer";
  if (s.includes("MOBILE") || s.includes("OMAN") || s.includes("WALLET")) return "Mobile transfer";
  return (raw ?? "Other").trim().slice(0, 48);
}

function isCashBucket(label: string): boolean {
  return label === "Cash";
}

/**
 * Computes folio-based totals for [shiftStart, shiftEnd] inclusive of end instant
 * (chargeDate <= shiftEnd and >= shiftStart).
 */
export async function computeShiftSnapshot(params: {
  hotelId: string;
  currency: string;
  shiftStart: Date;
  shiftEnd: Date;
}): Promise<ShiftComputedSnapshot> {
  const { hotelId, currency, shiftStart, shiftEnd } = params;

  const rows = await prisma.folioTransaction.findMany({
    where: {
      hotelId,
      isVoided: false,
      chargeDate: { gte: shiftStart, lte: shiftEnd }
    },
    select: {
      transactionType: true,
      ledgerKind: true,
      netAmount: true,
      grossAmount: true,
      folioPaymentMethod: true
    }
  });

  let transactionCount = 0;
  let revenueRoom = 0;
  let revenueFb = 0;
  let revenueActivity = 0;
  let revenueOther = 0;
  const payMap = new Map<string, { amount: number; count: number }>();
  let totalPaymentsRecorded = 0;

  for (const r of rows) {
    transactionCount += 1;
    if (r.transactionType === FolioTransactionType.PAYMENT) {
      const g = r.grossAmount;
      totalPaymentsRecorded += g;
      const key = bucketFolioPaymentMethod(r.folioPaymentMethod);
      const cur = payMap.get(key) ?? { amount: 0, count: 0 };
      cur.amount += g;
      cur.count += 1;
      payMap.set(key, cur);
      continue;
    }
    const net = r.netAmount;
    const lk = r.ledgerKind;
    if (lk === FolioLedgerKind.ROOM_CHARGE) revenueRoom += net;
    else if (lk === FolioLedgerKind.FNB_CHARGE) revenueFb += net;
    else if (lk === FolioLedgerKind.ACTIVITY_CHARGE) revenueActivity += net;
    else if (r.transactionType === FolioTransactionType.FNB_CHARGE) revenueFb += net;
    else if (r.transactionType === FolioTransactionType.ACTIVITY_CHARGE) revenueActivity += net;
    else revenueOther += net;
  }

  const paymentBuckets: PaymentMethodBucket[] = Array.from(payMap.entries())
    .map(([label, v]) => ({ label, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount);

  let cashReceived = 0;
  for (const b of paymentBuckets) {
    if (isCashBucket(b.label)) cashReceived += b.amount;
  }

  const pendingRows = await prisma.paymentIntent.findMany({
    where: {
      hotelId,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.REQUIRES_ACTION] }
    },
    select: { amount: true }
  });
  const pendingPaymentIntents = pendingRows.length;
  const pendingPaymentAmount = pendingRows.reduce((s, p) => s + p.amount, 0);

  const revenueTotal = revenueRoom + revenueFb + revenueActivity + revenueOther;

  return {
    shiftStart: shiftStart.toISOString(),
    shiftEnd: shiftEnd.toISOString(),
    currency,
    transactionCount,
    revenueRoom,
    revenueFb,
    revenueActivity,
    revenueOtherCharges: revenueOther,
    revenueTotal,
    paymentBuckets,
    cashReceived,
    totalPaymentsRecorded,
    pendingPaymentIntents,
    pendingPaymentAmount
  };
}

export function computeExpectedClosingCash(params: {
  openingCash: number;
  cashReceived: number;
  expenseTotal: number;
  bankDepositAmount: number;
}): number {
  return params.openingCash + params.cashReceived - params.expenseTotal - params.bankDepositAmount;
}

/** Local civil date YYYY-MM-DD for shift business day. */
export function formatBusinessDateLocal(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export const SHIFT_SLOT_OPTIONS = ["MORNING", "EVENING", "NIGHT", "CUSTOM"] as const;
export type ShiftSlotOption = (typeof SHIFT_SLOT_OPTIONS)[number];

export type ShiftCloseMetaSnapshot = {
  shiftSlot: string;
  businessDate: string;
  shiftLabel?: string | null;
  openingCashSource: string;
  handoverNote?: string | null;
  priorShiftId?: string | null;
};

export type ShiftCloseHandoverSnapshot = {
  priorShiftId: string;
  priorShiftSlot?: string;
  priorBusinessDate?: string;
  priorClosingCounted: number;
  handoverAt: string;
  handedOverByUserId?: string | null;
  receivedByUserId?: string | null;
  openingCashSource: string;
  handoverNote?: string | null;
};

export type ShiftCloseSnapshotFile = {
  meta?: ShiftCloseMetaSnapshot;
  handover?: ShiftCloseHandoverSnapshot;
  computed: ShiftComputedSnapshot;
  expenses: { category: string; amount: number; note: string | null }[];
  openingCash: number;
  bankDepositAmount: number;
  expectedClosingCash: number;
  closingCashActual: number;
  cashVariance: number;
};

function escapeReportHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slotDisplayName(slot: string, label?: string | null): string {
  const u = (slot || "CUSTOM").toUpperCase();
  if (u === "MORNING") return "Morning";
  if (u === "EVENING") return "Evening";
  if (u === "NIGHT") return "Night";
  if (label && label.trim()) return label.trim();
  return "Custom";
}

/** Printable shift close report (HTML). Data should come from stored snapshot + DB row for locked shifts. */
export function renderShiftReportHtml(params: {
  hotelName: string;
  currency: string;
  shiftId: string;
  closedAtIso: string;
  shiftStartIso: string;
  shiftEndIso: string;
  closedByName: string | null;
  shiftSlot: string;
  shiftLabel: string | null;
  businessDate: string;
  openingCashSource: string;
  priorShiftId: string | null;
  handoverNote: string | null;
  snapshot: ShiftCloseSnapshotFile | null;
}): string {
  const snap = params.snapshot;
  const computed = snap?.computed;
  const meta = snap?.meta;
  const handover = snap?.handover;
  const expenses = snap?.expenses ?? [];
  const opening =
    snap?.openingCash ??
    0;
  const bank = snap?.bankDepositAmount ?? 0;
  const expected = snap?.expectedClosingCash ?? 0;
  const counted = snap?.closingCashActual ?? 0;
  const variance = snap?.cashVariance ?? 0;

  const slotTitle = slotDisplayName(meta?.shiftSlot ?? params.shiftSlot, meta?.shiftLabel ?? params.shiftLabel);
  const bizDate = meta?.businessDate ?? params.businessDate;

  const payRows =
    computed?.paymentBuckets?.map(
      (b) =>
        `<tr><td>${escapeReportHtml(b.label)}</td><td style="text-align:right">${b.count}</td><td style="text-align:right">${b.amount.toFixed(3)}</td></tr>`
    ).join("") ?? "";

  const expRows = expenses
    .map(
      (e) =>
        `<tr><td>${escapeReportHtml(e.category)}</td><td style="text-align:right">${e.amount.toFixed(3)}</td><td>${escapeReportHtml(e.note ?? "—")}</td></tr>`
    )
    .join("");

  const handoverBlock =
    handover || params.priorShiftId
      ? `<section class="block">
  <h2>Handover / carry-forward</h2>
  <table>
    <tbody>
      <tr><th>Prior shift ID</th><td>${escapeReportHtml(handover?.priorShiftId ?? params.priorShiftId ?? "—")}</td></tr>
      <tr><th>Prior slot / date</th><td>${escapeReportHtml(
        [handover?.priorShiftSlot, handover?.priorBusinessDate].filter(Boolean).join(" · ") || "—"
      )}</td></tr>
      <tr><th>Prior closing counted (carry basis)</th><td>${(handover?.priorClosingCounted ?? 0).toFixed(3)} ${escapeReportHtml(params.currency)}</td></tr>
      <tr><th>Opening cash source</th><td>${escapeReportHtml(handover?.openingCashSource ?? params.openingCashSource)}</td></tr>
      <tr><th>Recorded at</th><td>${escapeReportHtml(handover?.handoverAt ?? "—")}</td></tr>
    </tbody>
  </table>
</section>`
      : "";

  const rev = computed
    ? `<tr><td>Room (net)</td><td style="text-align:right">${computed.revenueRoom.toFixed(3)}</td></tr>
    <tr><td>F&amp;B (net)</td><td style="text-align:right">${computed.revenueFb.toFixed(3)}</td></tr>
    <tr><td>Activity (net)</td><td style="text-align:right">${computed.revenueActivity.toFixed(3)}</td></tr>
    <tr><td>Other charges (net)</td><td style="text-align:right">${computed.revenueOtherCharges.toFixed(3)}</td></tr>
    <tr><td><strong>Charges total (net)</strong></td><td style="text-align:right"><strong>${computed.revenueTotal.toFixed(3)}</strong></td></tr>`
    : `<tr><td colspan="2" class="muted">No computed snapshot</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shift report — ${escapeReportHtml(slotTitle)} — ${escapeReportHtml(bizDate)}</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #0f172a; }
    body { margin: 0; padding: 24px; background: #f1f5f9; }
    .sheet { max-width: 720px; margin: 0 auto; background: #fff; padding: 28px 32px; box-shadow: 0 1px 3px rgba(0,0,0,.08); border-radius: 4px; }
    h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.02em; }
    .sub { color: #64748b; font-size: 13px; margin: 0 0 20px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; margin: 22px 0 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    th { width: 38%; color: #334155; font-weight: 600; }
    .muted { color: #94a3b8; }
    .actions { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
    button, .btn { padding: 10px 16px; border-radius: 8px; border: 0; background: #0f766e; color: #fff; font-weight: 600; cursor: pointer; font-size: 14px; }
    .btn-secondary { background: #e2e8f0; color: #0f172a; text-decoration: none; display: inline-block; }
    @media print {
      body { background: #fff; padding: 0; }
      .actions { display: none !important; }
      .sheet { box-shadow: none; max-width: none; padding: 0; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <h1>${escapeReportHtml(params.hotelName)}</h1>
    <p class="sub">Cashier shift close report · Internal use</p>

    <section class="block">
      <h2>Shift</h2>
      <table>
        <tbody>
          <tr><th>Shift</th><td>${escapeReportHtml(slotTitle)} (${escapeReportHtml((meta?.shiftSlot ?? params.shiftSlot).toUpperCase())})</td></tr>
          <tr><th>Business date</th><td>${escapeReportHtml(bizDate)}</td></tr>
          <tr><th>Window (start → end)</th><td>${escapeReportHtml(params.shiftStartIso)} → ${escapeReportHtml(params.shiftEndIso)}</td></tr>
          <tr><th>Closed at (UTC)</th><td>${escapeReportHtml(params.closedAtIso)}</td></tr>
          <tr><th>Cashier / closer</th><td>${escapeReportHtml(params.closedByName ?? "—")}</td></tr>
          <tr><th>Report ref</th><td>${escapeReportHtml(params.shiftId)}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="block">
      <h2>Cash &amp; reconciliation</h2>
      <table>
        <tbody>
          <tr><th>Opening cash</th><td>${opening.toFixed(3)} ${escapeReportHtml(params.currency)}</td></tr>
          <tr><th>Cash received (folio, cash bucket)</th><td>${(computed?.cashReceived ?? 0).toFixed(3)} ${escapeReportHtml(params.currency)}</td></tr>
          <tr><th>Bank deposit</th><td>${bank.toFixed(3)} ${escapeReportHtml(params.currency)}</td></tr>
          <tr><th>Expected closing cash</th><td><strong>${expected.toFixed(3)}</strong> ${escapeReportHtml(params.currency)}</td></tr>
          <tr><th>Counted closing cash (actual)</th><td><strong>${counted.toFixed(3)}</strong> ${escapeReportHtml(params.currency)}</td></tr>
          <tr><th>Variance (counted − expected)</th><td style="font-weight:700;color:${variance === 0 ? "#166534" : "#991b1b"}">${variance.toFixed(3)} ${escapeReportHtml(params.currency)}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="block">
      <h2>Payment method breakdown</h2>
      <table>
        <thead><tr><th>Method</th><th style="text-align:right">Count</th><th style="text-align:right">Amount (${escapeReportHtml(params.currency)})</th></tr></thead>
        <tbody>${payRows || `<tr><td colspan="3" class="muted">No payments in window</td></tr>`}</tbody>
      </table>
    </section>

    <section class="block">
      <h2>Revenue summary (folio charges, net)</h2>
      <table>${rev}</table>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Folio lines in shift window: ${computed?.transactionCount ?? "—"}</p>
    </section>

    <section class="block">
      <h2>Expenses / payouts</h2>
      <table>
        <thead><tr><th>Category</th><th style="text-align:right">Amount</th><th>Note</th></tr></thead>
        <tbody>${expRows || `<tr><td colspan="3" class="muted">None recorded</td></tr>`}</tbody>
      </table>
    </section>

    ${handoverBlock}

    <section class="block">
      <h2>Notes</h2>
      <p style="margin:0;font-size:13px;white-space:pre-wrap">${escapeReportHtml((meta?.handoverNote ?? params.handoverNote ?? "").trim() || "—")}</p>
    </section>

    <p class="muted" style="font-size:11px;margin-top:24px">Generated from locked shift data. Pending payment intents (system-wide): ${computed?.pendingPaymentIntents ?? "—"} intent(s), ${(computed?.pendingPaymentAmount ?? 0).toFixed(3)} ${escapeReportHtml(params.currency)}.</p>
  </div>
  <div class="actions">
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
    <a class="btn btn-secondary" href="/admin/shifts">Back to shift list</a>
  </div>
</body>
</html>`;
}
