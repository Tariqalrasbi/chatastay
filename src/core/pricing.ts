import { clamp, daysBetween } from "./util";

export interface QuoteInput {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  baseNightlyPrice: number;
}

export interface QuoteResult {
  nights: number;
  subtotal: number;
  serviceFee: number;
  total: number;
  currency: "SAR";
}

export function buildQuote(input: QuoteInput): QuoteResult {
  const nights = daysBetween(input.checkIn, input.checkOut);
  const occupancyMultiplier = 1 + clamp(0, input.guestCount - 2, 6) * 0.05;
  const adjustedNightly = input.baseNightlyPrice * occupancyMultiplier;
  const subtotal = Number((adjustedNightly * nights).toFixed(2));
  const serviceFee = Number((subtotal * 0.08).toFixed(2));
  const total = Number((subtotal + serviceFee).toFixed(2));

  return { nights, subtotal, serviceFee, total, currency: "SAR" };
}
