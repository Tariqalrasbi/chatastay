/**
 * ABR Restaurant & Coffee Shop — categories aligned with the ABR restaurant menu PDF (Soup, Starter, Salad, etc.).
 * Item names match `DEFAULT_FB_MENU_2026` / `MenuItem` seeds so the bot resolves prices from the database.
 */
export type AbrMenuItemRef = { name: string; outletType: "RESTAURANT" | "COFFEE_SHOP" };

export type AbrMenuCategory = { id: string; label: string; items: AbrMenuItemRef[] };

export const ABR_RESTAURANT_MENU: { title: string; sourceNote: string; categories: AbrMenuCategory[] } = {
  title: "ABR Restaurant & Coffee Shop",
  sourceNote:
    "Structured from ABR restaurant menu PDF categories; names align with seeded MenuItem rows (see defaultFbMenuSeed).",
  categories: [
    {
      id: "soup",
      label: "Soup",
      items: [
        { name: "Soup of the day", outletType: "RESTAURANT" },
        { name: "Lentil soup", outletType: "RESTAURANT" },
        { name: "Seafood chowder", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "starter",
      label: "Starter",
      items: [
        { name: "Hummus", outletType: "RESTAURANT" },
        { name: "Moutabal", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "salad",
      label: "Salad",
      items: [
        { name: "Fattoush salad", outletType: "RESTAURANT" },
        { name: "Caesar salad (chicken)", outletType: "RESTAURANT" },
        { name: "Greek salad", outletType: "RESTAURANT" },
        { name: "Tabbouleh", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "curry",
      label: "Curry Dishes",
      items: [{ name: "Chicken biryani", outletType: "RESTAURANT" }]
    },
    {
      id: "bbq",
      label: "Barbeque & Grilled",
      items: [
        { name: "Grilled hammour", outletType: "RESTAURANT" },
        { name: "Grilled kingfish", outletType: "RESTAURANT" },
        { name: "Mixed seafood grill", outletType: "RESTAURANT" },
        { name: "Omani prawns (grilled)", outletType: "RESTAURANT" },
        { name: "Grilled chicken breast", outletType: "RESTAURANT" },
        { name: "Lamb chops (3 pcs)", outletType: "RESTAURANT" },
        { name: "Mixed grill platter", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "fried_rice",
      label: "Fried Rice",
      items: [{ name: "Mixed fried rice (chicken)", outletType: "RESTAURANT" }]
    },
    {
      id: "biryani",
      label: "Biryani Dishes",
      items: [{ name: "Chicken biryani", outletType: "RESTAURANT" }]
    },
    {
      id: "pasta",
      label: "Italian Pastas",
      items: [
        { name: "Spaghetti Bolognese", outletType: "RESTAURANT" },
        { name: "Fettuccine Alfredo (chicken)", outletType: "RESTAURANT" },
        { name: "Seafood linguine", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "sandwiches",
      label: "Sandwiches",
      items: [
        { name: "Club sandwich", outletType: "RESTAURANT" },
        { name: "Chicken wrap", outletType: "RESTAURANT" },
        { name: "Grilled halloumi sandwich", outletType: "RESTAURANT" },
        { name: "Beef burger (180g)", outletType: "RESTAURANT" },
        { name: "Chicken burger", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "desserts",
      label: "Desserts",
      items: [
        { name: "Um Ali", outletType: "RESTAURANT" },
        { name: "Chocolate brownie & ice cream", outletType: "RESTAURANT" },
        { name: "Seasonal fruit plate", outletType: "RESTAURANT" },
        { name: "Ice cream (2 scoops)", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "kids",
      label: "Kids",
      items: [
        { name: "Kids chicken nuggets & fries", outletType: "RESTAURANT" },
        { name: "Kids pasta (tomato)", outletType: "RESTAURANT" },
        { name: "Kids fish fingers & fries", outletType: "RESTAURANT" }
      ]
    },
    {
      id: "coffee_drinks",
      label: "Coffee & Drinks",
      items: [
        { name: "Espresso", outletType: "COFFEE_SHOP" },
        { name: "Americano", outletType: "COFFEE_SHOP" },
        { name: "Cappuccino", outletType: "COFFEE_SHOP" },
        { name: "Latte", outletType: "COFFEE_SHOP" },
        { name: "Flat white", outletType: "COFFEE_SHOP" },
        { name: "Hot chocolate", outletType: "COFFEE_SHOP" },
        { name: "Pot of English tea", outletType: "COFFEE_SHOP" },
        { name: "Karak chai", outletType: "COFFEE_SHOP" },
        { name: "Fresh orange juice", outletType: "COFFEE_SHOP" },
        { name: "Fresh mixed juice", outletType: "COFFEE_SHOP" },
        { name: "Lemon mint cooler", outletType: "COFFEE_SHOP" },
        { name: "Iced latte", outletType: "COFFEE_SHOP" },
        { name: "Mineral water (small)", outletType: "COFFEE_SHOP" },
        { name: "Soft drink (can)", outletType: "COFFEE_SHOP" }
      ]
    },
    {
      id: "coffee_snacks",
      label: "Coffee shop snacks",
      items: [
        { name: "Butter croissant", outletType: "COFFEE_SHOP" },
        { name: "Chocolate muffin", outletType: "COFFEE_SHOP" },
        { name: "Date cake (slice)", outletType: "COFFEE_SHOP" }
      ]
    }
  ]
};
