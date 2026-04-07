/**
 * Half-open range [gte, lt) for one local calendar day, used to match `Inventory.date`
 * regardless of small time-of-day differences in storage.
 */
export function inventoryDayRangeExclusive(day: Date): { gte: Date; lt: Date } {
  const gte = new Date(day);
  gte.setHours(0, 0, 0, 0);
  const lt = new Date(gte);
  lt.setDate(lt.getDate() + 1);
  return { gte, lt };
}
