/**
 * Room-type occupancy rules (Al Ashkhara-style categories).
 * Standard Superior / Executive: max 2 adults and 2 children.
 * Suite: max 2 adults and 3 children.
 * Apartment: max 2 adults with up to 4 children, or up to 4 adults when there are no children.
 */

export function roomTypeAllowsOccupancy(roomTypeCode: string, adults: number, children: number): { ok: boolean; message: string } {
  const a = Math.max(0, Math.floor(adults));
  const c = Math.max(0, Math.floor(children));
  if (a < 1 && c < 1) {
    return { ok: false, message: "At least one adult or child is required." };
  }

  switch (roomTypeCode) {
    case "STD_SUPERIOR":
    case "STD_EXEC":
      if (a > 2 || c > 2) {
        return {
          ok: false,
          message:
            "This room type allows at most 2 adults and 2 children. Choose a larger room type or reduce guests."
        };
      }
      return { ok: true, message: "" };
    case "SUITE":
      if (a > 2 || c > 3) {
        return {
          ok: false,
          message: "Suite allows at most 2 adults and 3 children. Choose Apartment or reduce guests."
        };
      }
      return { ok: true, message: "" };
    case "APARTMENT":
      if (c === 0) {
        if (a > 4) {
          return { ok: false, message: "Apartment allows at most 4 adults when there are no children." };
        }
        return { ok: true, message: "" };
      }
      if (a > 2) {
        return {
          ok: false,
          message:
            "Apartment with children: at most 2 adults (and up to 4 children). For 4 adults, set children to 0."
        };
      }
      if (c > 4) {
        return { ok: false, message: "Apartment allows at most 4 children with up to 2 adults." };
      }
      return { ok: true, message: "" };
    default:
      return { ok: true, message: "" };
  }
}
