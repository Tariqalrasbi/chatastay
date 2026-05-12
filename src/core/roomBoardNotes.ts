/** Room board manual status stored in `RoomUnit.notes` as `[status:OCCUPIED]` etc. */

export type ManualRoomBoardStatus =
  | "AVAILABLE"
  | "RESERVED"
  | "OCCUPIED"
  | "CLEANING"
  | "MAINTENANCE"
  | "NO_SHOW"
  | "CANCELLED";

// Single regex source-of-truth — extend here when adding new manual statuses.
const STATUS_TAG_RE = /\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE|NO_SHOW|CANCELLED)\]/;
const STATUS_TAG_RE_G = /\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE|NO_SHOW|CANCELLED)\]/gi;

export function parseManualRoomStatusFromNotes(notes: string | null | undefined): ManualRoomBoardStatus | null {
  if (!notes) return null;
  const match = notes.match(STATUS_TAG_RE);
  return (match?.[1] as ManualRoomBoardStatus | undefined) ?? null;
}

export function writeManualRoomStatusToNotes(notes: string | null | undefined, status: ManualRoomBoardStatus): string {
  const cleaned = (notes ?? "").replace(STATUS_TAG_RE_G, "").trim();
  return `${cleaned ? `${cleaned} ` : ""}[status:${status}]`.trim();
}

/**
 * "Urgent" maintenance flag stored alongside the status tag in `RoomUnit.notes`
 * as the literal token `[urgent]`. Lets a manager mark a maintenance room as
 * priority — surfaced on the maintenance page with a red badge.
 */
const URGENT_TAG_RE = /\[urgent\]/gi;

export function parseMaintenanceUrgentFromNotes(notes: string | null | undefined): boolean {
  if (!notes) return false;
  // Use a fresh non-global regex; URGENT_TAG_RE has the `g` flag and `.test()`
  // would mutate its internal `lastIndex` across calls, returning alternating
  // true/false for the same input.
  return /\[urgent\]/i.test(notes);
}

export function setMaintenanceUrgentInNotes(notes: string | null | undefined, urgent: boolean): string {
  const stripped = (notes ?? "").replace(URGENT_TAG_RE, "").replace(/\s{2,}/g, " ").trim();
  if (!urgent) return stripped;
  return stripped.length ? `${stripped} [urgent]` : "[urgent]";
}

/** Strip every meta tag and return the human-readable note part. */
export function stripRoomNoteTags(notes: string | null | undefined): string {
  if (!notes) return "";
  return notes
    .replace(STATUS_TAG_RE_G, "")
    .replace(URGENT_TAG_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Replace the human-readable portion of `notes` with `text` while preserving
 * the `[status:X]` and `[urgent]` meta tags. Used by the maintenance page so
 * staff can type a real reason / fix description next to the operational tags
 * without losing the room state.
 */
export function setRoomNoteText(notes: string | null | undefined, text: string): string {
  const original = notes ?? "";
  const tags: string[] = [];
  const statusMatch = original.match(STATUS_TAG_RE);
  if (statusMatch) tags.push(statusMatch[0]);
  // Don't reuse URGENT_TAG_RE here — it carries the `g` flag and `.test()` would
  // mutate `lastIndex` across calls, producing flaky results on repeated reads.
  if (/\[urgent\]/i.test(original)) tags.push("[urgent]");
  const human = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  return [human, ...tags].filter(Boolean).join(" ").trim();
}
