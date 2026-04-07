export type BookingComSyncDomain = "availability" | "rates" | "inventory" | "bookings";
export type BookingComSyncMode = "incremental" | "full";

export interface BookingComSyncWindow {
  from: string;
  to: string;
}

export interface BookingComSyncPlanItem {
  domain: BookingComSyncDomain;
  action: string;
  mode: BookingComSyncMode;
  window: BookingComSyncWindow;
  notes: string;
}

export const bookingComDomains: BookingComSyncDomain[] = [
  "availability",
  "rates",
  "inventory",
  "bookings"
];

export function buildBookingComSyncPlan(params: {
  mode: BookingComSyncMode;
  window: BookingComSyncWindow;
  domains: BookingComSyncDomain[];
}): BookingComSyncPlanItem[] {
  return params.domains.map((domain) => ({
    domain,
    action: `BOOKING_COM_${domain.toUpperCase()}_${params.mode.toUpperCase()}`,
    mode: params.mode,
    window: params.window,
    notes: `Prepared architecture sync job for ${domain}. API call intentionally not implemented yet.`
  }));
}

