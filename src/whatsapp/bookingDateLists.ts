/** WhatsApp list rows: title max 24 chars; max 10 rows per list message (Meta). */

export const CHECKIN_LIST_OTHER_ID = "dci_other";
export const CHECKOUT_LIST_OTHER_ID = "dco_other";
const CHECKIN_ROW_PREFIX = "dci_";
const CHECKOUT_ROW_PREFIX = "dco_";

export function checkInRowId(isoYmd: string): string {
  return `${CHECKIN_ROW_PREFIX}${isoYmd.replace(/-/g, "")}`;
}

export function checkOutRowId(isoYmd: string): string {
  return `${CHECKOUT_ROW_PREFIX}${isoYmd.replace(/-/g, "")}`;
}

function parseRowId(prefix: string, text: string): string | null {
  const m = new RegExp(`^${prefix}(\\d{8})$`).exec(text.trim());
  if (!m) return null;
  const d = m[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function parseCheckInListId(text: string): "other" | { iso: string } | null {
  const t = text.trim();
  if (t === CHECKIN_LIST_OTHER_ID) return "other";
  const iso = parseRowId(CHECKIN_ROW_PREFIX, t);
  if (iso) return { iso };
  return null;
}

export function parseCheckOutListId(text: string): "other" | { iso: string } | null {
  const t = text.trim();
  if (t === CHECKOUT_LIST_OTHER_ID) return "other";
  const iso = parseRowId(CHECKOUT_ROW_PREFIX, t);
  if (iso) return { iso };
  return null;
}

/** Today and next 8 nights in UTC calendar (9 rows) — same basis as existing date checks. */
export function upcomingCheckInIsoDates(count: number): string[] {
  const todayStr = new Date().toISOString().slice(0, 10);
  const base = new Date(todayStr + "T12:00:00Z");
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function checkoutIsoDatesAfterCheckIn(checkInIso: string, count: number): string[] {
  const checkIn = new Date(checkInIso + "T12:00:00Z");
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(checkIn);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function parseCheckInDigitReply(text: string): string | null {
  const t = text.trim();
  if (!/^[1-9]$/.test(t)) return null;
  const idx = parseInt(t, 10) - 1;
  const dates = upcomingCheckInIsoDates(9);
  return dates[idx] ?? null;
}

export function parseCheckOutDigitReply(checkInIso: string, text: string): string | null {
  const t = text.trim();
  if (!/^[1-9]$/.test(t)) return null;
  const idx = parseInt(t, 10) - 1;
  const dates = checkoutIsoDatesAfterCheckIn(checkInIso, 9);
  return dates[idx] ?? null;
}

/** Short label for list row (≤24 chars). */
export function formatDateListRowTitle(isoYmd: string): string {
  const d = new Date(isoYmd + "T12:00:00Z");
  const label = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const full = `${label} ${d.getUTCFullYear()}`;
  return full.length <= 24 ? full : label.slice(0, 24);
}

export function buildCheckInListSections(): Array<{
  title: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}> {
  const dates = upcomingCheckInIsoDates(9);
  const rows = dates.map((iso) => ({
    id: checkInRowId(iso),
    title: formatDateListRowTitle(iso),
    description: "Check-in"
  }));
  rows.push({
    id: CHECKIN_LIST_OTHER_ID,
    title: "Other date",
    description: "Type YYYY-MM-DD"
  });
  return [{ title: "Pick check-in", rows }];
}

export function buildCheckOutListSections(checkInIso: string): Array<{
  title: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}> {
  const dates = checkoutIsoDatesAfterCheckIn(checkInIso, 9);
  const rows = dates.map((iso) => ({
    id: checkOutRowId(iso),
    title: formatDateListRowTitle(iso),
    description: "Check-out"
  }));
  rows.push({
    id: CHECKOUT_LIST_OTHER_ID,
    title: "Other date",
    description: "Type YYYY-MM-DD"
  });
  return [{ title: "Pick check-out", rows }];
}

export function fallbackCheckInTextBody(): string {
  const dates = upcomingCheckInIsoDates(9);
  const lines = dates.map((iso, i) => `${i + 1}) ${iso} (${formatDateListRowTitle(iso)})`);
  return [
    "Choose your check-in date:",
    "",
    ...lines,
    "",
    `Reply with the number 1–${dates.length}, or type a date as YYYY-MM-DD (today or later).`,
    `Or reply *${CHECKIN_LIST_OTHER_ID}* then type your date.`
  ].join("\n");
}

export function fallbackCheckOutTextBody(checkInIso: string): string {
  const dates = checkoutIsoDatesAfterCheckIn(checkInIso, 9);
  const lines = dates.map((iso, i) => `${i + 1}) ${iso} (${formatDateListRowTitle(iso)})`);
  return [
    "Choose your check-out date (must be after check-in):",
    "",
    ...lines,
    "",
    `Reply with the number 1–${dates.length}, or type a date as YYYY-MM-DD.`,
    `Or reply *${CHECKOUT_LIST_OTHER_ID}* then type your date.`
  ].join("\n");
}
