/**
 * Resolves adults / children / total guests from WhatsApp session fields without
 * treating total pax (`guestCount`) as adults when children are present.
 */

export type PartyCounts = {
  adults: number;
  children: number;
  total: number;
};

export type PartySessionFields = {
  adultCount?: number;
  childCount?: number;
  guestCount?: number;
};

export function resolvePartyCountsFromSession(s: PartySessionFields): PartyCounts {
  const hasAdults = typeof s.adultCount === "number";
  const hasChildren = typeof s.childCount === "number";
  const guestTotal = typeof s.guestCount === "number" ? Math.max(0, Math.floor(s.guestCount)) : undefined;

  if (hasAdults && hasChildren) {
    const adults = Math.max(1, Math.floor(s.adultCount!));
    const children = Math.max(0, Math.floor(s.childCount!));
    const sum = adults + children;
    const total = guestTotal !== undefined && guestTotal >= sum ? guestTotal : sum;
    return { adults, children, total };
  }

  if (hasChildren && guestTotal !== undefined && !hasAdults) {
    const children = Math.max(0, Math.floor(s.childCount!));
    const adults = Math.max(1, guestTotal - children);
    return { adults, children, total: adults + children };
  }

  if (guestTotal !== undefined) {
    if (hasAdults) {
      const adults = Math.max(1, Math.floor(s.adultCount!));
      const children = Math.max(0, guestTotal - adults);
      return { adults, children, total: adults + children };
    }
    return { adults: Math.max(1, guestTotal), children: 0, total: Math.max(1, guestTotal) };
  }

  if (hasAdults) {
    const adults = Math.max(1, Math.floor(s.adultCount!));
    return { adults, children: 0, total: adults };
  }

  return { adults: 2, children: 0, total: 2 };
}

/** Guest summary line for quotes and confirmations (never "N adults" for total pax). */
export function formatPartySummaryLine(p: PartyCounts, ar: boolean): string {
  if (ar) {
    return `الضيوف: ${p.total} إجمالي — بالغون: ${p.adults} — أطفال: ${p.children}`;
  }
  return `Guests: ${p.total} total — Adults: ${p.adults} — Children: ${p.children}`;
}
