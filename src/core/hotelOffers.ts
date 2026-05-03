import fs from "node:fs";
import path from "node:path";

export type HotelOffer = {
  id: string;
  code: string;
  title: string;
  type: string;
  discountPercent: number;
  isActive: boolean;
  seasonStart?: string;
  seasonEnd?: string;
  minNights?: number;
  minDaysBeforeCheckIn?: number;
  stayX?: number;
  stayY?: number;
  corporateOnly?: boolean;
};

const offersFile = path.join(process.cwd(), "hotel-offers.json");

export function readActiveHotelOffers(): HotelOffer[] {
  try {
    if (!fs.existsSync(offersFile)) return [];
    const raw = JSON.parse(fs.readFileSync(offersFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return (raw as HotelOffer[]).filter((offer) => offer && offer.isActive);
  } catch {
    return [];
  }
}

export function formatHotelOfferDetails(offer: HotelOffer): string {
  const details: string[] = [];
  if (offer.type === "STAY_X_GET_Y_FREE" && offer.stayX && offer.stayY) details.push(`Stay ${offer.stayX}, get ${offer.stayY} free`);
  if (offer.minNights) details.push(`Min ${offer.minNights} nights`);
  if (offer.minDaysBeforeCheckIn) details.push(`Book ${offer.minDaysBeforeCheckIn}+ days early`);
  if (offer.seasonStart && offer.seasonEnd) details.push(`${offer.seasonStart} to ${offer.seasonEnd}`);
  if (offer.corporateOnly) details.push("Corporate only");
  if (!details.length) details.push("Standard offer terms");
  return details.join(" • ");
}

export function buildLiveOffersMessage(): string {
  const offers = readActiveHotelOffers();
  if (!offers.length) {
    return "No current offers or promotions are listed. For the best available rate, please check availability for your dates.";
  }
  return (
    "Current live offers and promotions:\n" +
    offers
      .map((offer, index) => {
        const discount = Number.isFinite(offer.discountPercent) ? `${offer.discountPercent}%` : "special rate";
        return `${index + 1}. ${offer.title} - ${discount}\n   ${formatHotelOfferDetails(offer)}`;
      })
      .join("\n")
  );
}
