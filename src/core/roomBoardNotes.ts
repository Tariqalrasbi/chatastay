/** Room board manual status stored in `RoomUnit.notes` as `[status:OCCUPIED]` etc. */

export type ManualRoomBoardStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";

export function parseManualRoomStatusFromNotes(notes: string | null | undefined): ManualRoomBoardStatus | null {
  if (!notes) return null;
  const match = notes.match(/\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)\]/);
  return (match?.[1] as ManualRoomBoardStatus | undefined) ?? null;
}

export function writeManualRoomStatusToNotes(notes: string | null | undefined, status: ManualRoomBoardStatus): string {
  const cleaned = (notes ?? "").replace(/\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)\]/g, "").trim();
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
  return URGENT_TAG_RE.test(notes);
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
    .replace(/\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)\]/gi, "")
    .replace(URGENT_TAG_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
