import { FbOutletType } from "@prisma/client";
import { prisma } from "../db";
import { ABR_RESTAURANT_MENU } from "../data/abrRestaurantMenu";

/** Key used to match catalog entries to DB `MenuItem` rows. */
export function menuItemKey(outletType: FbOutletType, name: string): string {
  return `${outletType}::${name.trim()}`;
}

/**
 * Build a map of catalog keys → MenuItem id for this hotel (only active items present in DB).
 */
export async function buildResolvedMenuItemMap(hotelId: string): Promise<Map<string, { id: string; unitPrice: number; name: string }>> {
  const items = await prisma.menuItem.findMany({
    where: { hotelId, isActive: true },
    select: { id: true, name: true, outletType: true, unitPrice: true }
  });
  const map = new Map<string, { id: string; unitPrice: number; name: string }>();
  for (const row of items) {
    map.set(menuItemKey(row.outletType, row.name), { id: row.id, unitPrice: row.unitPrice, name: row.name });
  }
  return map;
}

export function getAbrCategories() {
  return ABR_RESTAURANT_MENU.categories;
}

export function findCategoryById(id: string) {
  return ABR_RESTAURANT_MENU.categories.find((c) => c.id === id);
}
