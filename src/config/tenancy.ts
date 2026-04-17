/**
 * Default hotel slug for single-tenant deployments. Override with DEFAULT_HOTEL_SLUG for staging/other properties
 * until full multi-tenant routing is implemented.
 */
export const defaultHotelSlug: string = (process.env.DEFAULT_HOTEL_SLUG ?? "al-ashkhara-beach-resort").trim();
