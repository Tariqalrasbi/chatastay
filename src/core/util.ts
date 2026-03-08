export function toDate(input: string): Date | undefined {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

export function daysBetween(start: Date, end: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(0, Math.ceil((end.getTime() - start.getTime()) / msPerDay));
}

export function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
