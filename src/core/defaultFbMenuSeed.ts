import { FbOutletType } from "@prisma/client";
import { prisma } from "../db";

/** Default F&amp;B catalog (OMR) — Al Ashkhara–style resort; align with your printed “Restaurant menu 2026” PDF. */
export type SeedMenuRow = { outletType: FbOutletType; name: string; unitPrice: number; sortOrder: number };

export const DEFAULT_FB_MENU_2026: SeedMenuRow[] = [
  // Restaurant — cold & salads
  { outletType: FbOutletType.RESTAURANT, name: "Hummus", unitPrice: 1.2, sortOrder: 10 },
  { outletType: FbOutletType.RESTAURANT, name: "Moutabal", unitPrice: 1.2, sortOrder: 11 },
  { outletType: FbOutletType.RESTAURANT, name: "Fattoush salad", unitPrice: 2.8, sortOrder: 12 },
  { outletType: FbOutletType.RESTAURANT, name: "Caesar salad (chicken)", unitPrice: 3.5, sortOrder: 13 },
  { outletType: FbOutletType.RESTAURANT, name: "Greek salad", unitPrice: 3.2, sortOrder: 14 },
  { outletType: FbOutletType.RESTAURANT, name: "Tabbouleh", unitPrice: 2.5, sortOrder: 15 },
  // Soups
  { outletType: FbOutletType.RESTAURANT, name: "Soup of the day", unitPrice: 2.5, sortOrder: 20 },
  { outletType: FbOutletType.RESTAURANT, name: "Lentil soup", unitPrice: 2.2, sortOrder: 21 },
  { outletType: FbOutletType.RESTAURANT, name: "Seafood chowder", unitPrice: 3.8, sortOrder: 22 },
  // Sandwiches & light
  { outletType: FbOutletType.RESTAURANT, name: "Club sandwich", unitPrice: 3.9, sortOrder: 30 },
  { outletType: FbOutletType.RESTAURANT, name: "Chicken wrap", unitPrice: 3.5, sortOrder: 31 },
  { outletType: FbOutletType.RESTAURANT, name: "Grilled halloumi sandwich", unitPrice: 3.6, sortOrder: 32 },
  { outletType: FbOutletType.RESTAURANT, name: "Beef burger (180g)", unitPrice: 4.5, sortOrder: 33 },
  { outletType: FbOutletType.RESTAURANT, name: "Chicken burger", unitPrice: 4.2, sortOrder: 34 },
  // Mains — grill & local
  { outletType: FbOutletType.RESTAURANT, name: "Grilled hammour", unitPrice: 6.9, sortOrder: 40 },
  { outletType: FbOutletType.RESTAURANT, name: "Grilled kingfish", unitPrice: 6.5, sortOrder: 41 },
  { outletType: FbOutletType.RESTAURANT, name: "Mixed seafood grill", unitPrice: 8.5, sortOrder: 42 },
  { outletType: FbOutletType.RESTAURANT, name: "Omani prawns (grilled)", unitPrice: 7.5, sortOrder: 43 },
  { outletType: FbOutletType.RESTAURANT, name: "Grilled chicken breast", unitPrice: 5.5, sortOrder: 44 },
  { outletType: FbOutletType.RESTAURANT, name: "Lamb chops (3 pcs)", unitPrice: 8.9, sortOrder: 45 },
  { outletType: FbOutletType.RESTAURANT, name: "Mixed grill platter", unitPrice: 9.5, sortOrder: 46 },
  // Pasta & rice
  { outletType: FbOutletType.RESTAURANT, name: "Spaghetti Bolognese", unitPrice: 4.8, sortOrder: 50 },
  { outletType: FbOutletType.RESTAURANT, name: "Fettuccine Alfredo (chicken)", unitPrice: 5.2, sortOrder: 51 },
  { outletType: FbOutletType.RESTAURANT, name: "Seafood linguine", unitPrice: 6.2, sortOrder: 52 },
  { outletType: FbOutletType.RESTAURANT, name: "Chicken biryani", unitPrice: 5.0, sortOrder: 53 },
  { outletType: FbOutletType.RESTAURANT, name: "Mixed fried rice (chicken)", unitPrice: 4.5, sortOrder: 54 },
  // Kids
  { outletType: FbOutletType.RESTAURANT, name: "Kids chicken nuggets & fries", unitPrice: 2.9, sortOrder: 60 },
  { outletType: FbOutletType.RESTAURANT, name: "Kids pasta (tomato)", unitPrice: 2.8, sortOrder: 61 },
  { outletType: FbOutletType.RESTAURANT, name: "Kids fish fingers & fries", unitPrice: 3.0, sortOrder: 62 },
  // Desserts
  { outletType: FbOutletType.RESTAURANT, name: "Um Ali", unitPrice: 2.2, sortOrder: 70 },
  { outletType: FbOutletType.RESTAURANT, name: "Chocolate brownie & ice cream", unitPrice: 2.8, sortOrder: 71 },
  { outletType: FbOutletType.RESTAURANT, name: "Seasonal fruit plate", unitPrice: 2.0, sortOrder: 72 },
  { outletType: FbOutletType.RESTAURANT, name: "Ice cream (2 scoops)", unitPrice: 1.8, sortOrder: 73 },
  // Coffee shop — hot
  { outletType: FbOutletType.COFFEE_SHOP, name: "Espresso", unitPrice: 1.5, sortOrder: 100 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Americano", unitPrice: 1.8, sortOrder: 101 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Cappuccino", unitPrice: 2.2, sortOrder: 102 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Latte", unitPrice: 2.2, sortOrder: 103 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Flat white", unitPrice: 2.3, sortOrder: 104 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Hot chocolate", unitPrice: 2.5, sortOrder: 105 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Pot of English tea", unitPrice: 1.5, sortOrder: 106 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Karak chai", unitPrice: 1.2, sortOrder: 107 },
  // Coffee shop — cold
  { outletType: FbOutletType.COFFEE_SHOP, name: "Fresh orange juice", unitPrice: 2.0, sortOrder: 110 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Fresh mixed juice", unitPrice: 2.2, sortOrder: 111 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Lemon mint cooler", unitPrice: 2.0, sortOrder: 112 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Iced latte", unitPrice: 2.5, sortOrder: 113 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Mineral water (small)", unitPrice: 0.5, sortOrder: 114 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Soft drink (can)", unitPrice: 0.8, sortOrder: 115 },
  // Coffee shop — snacks
  { outletType: FbOutletType.COFFEE_SHOP, name: "Butter croissant", unitPrice: 1.2, sortOrder: 120 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Chocolate muffin", unitPrice: 1.5, sortOrder: 121 },
  { outletType: FbOutletType.COFFEE_SHOP, name: "Date cake (slice)", unitPrice: 1.8, sortOrder: 122 }
];

/** Adds items from {@link DEFAULT_FB_MENU_2026} that are not already present (same name + outlet). */
export async function appendMissingFbMenuItems(hotelId: string): Promise<number> {
  const existing = await prisma.menuItem.findMany({
    where: { hotelId },
    select: { name: true, outletType: true }
  });
  const key = (name: string, ot: FbOutletType) => `${ot}::${name}`;
  const have = new Set(existing.map((e) => key(e.name, e.outletType)));
  const toAdd = DEFAULT_FB_MENU_2026.filter((r) => !have.has(key(r.name, r.outletType)));
  if (toAdd.length === 0) return 0;
  await prisma.menuItem.createMany({
    data: toAdd.map((row) => ({ hotelId, ...row }))
  });
  return toAdd.length;
}
