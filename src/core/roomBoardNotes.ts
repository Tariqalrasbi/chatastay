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
