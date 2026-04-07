import knowledge from "../data/al_ashkhara_knowledge.json";

type KnowledgeTopic =
  | "room_types"
  | "room_descriptions"
  | "amenities"
  | "restaurant"
  | "coffee_shop"
  | "activities"
  | "policies"
  | "cancellation_policy"
  | "contacts";

type KnowledgeAnswerResult = {
  isKnowledgeQuery: boolean;
  found: boolean;
  answer?: string;
  intent?: string;
};

const topicKeywords: Record<KnowledgeTopic, string[]> = {
  room_types: ["room", "rooms", "type", "accommodation", "suite", "apartment", "غرفة", "غرف"],
  room_descriptions: ["room details", "room description", "inside room", "bed", "balcony", "sea view", "وصف الغرف"],
  amenities: ["amenities", "facility", "facilities", "pool", "wifi", "gym", "خدمات", "مرافق"],
  restaurant: ["restaurant", "meal", "breakfast", "lunch", "dinner", "food", "مطعم", "فطور", "غداء", "عشاء"],
  coffee_shop: ["coffee", "cafe", "coffee shop", "latte", "espresso", "قهوجي", "قهوة", "كافيه"],
  activities: ["activity", "activities", "tour", "fishing", "boat", "quad", "sports", "انشطة", "رحلات"],
  policies: ["policy", "policies", "terms", "condition", "extra adult", "extra child", "سياسة", "شروط"],
  cancellation_policy: ["cancel", "cancellation", "refund", "non-refundable", "إلغاء", "استرجاع"],
  contacts: ["contact", "phone", "email", "website", "instagram", "واتساب", "تواصل"]
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTopic(question: string): KnowledgeTopic | undefined {
  const text = normalize(question);
  for (const [topic, keywords] of Object.entries(topicKeywords) as Array<[KnowledgeTopic, string[]]>) {
    if (keywords.some((keyword) => text.includes(normalize(keyword)))) {
      return topic;
    }
  }
  return undefined;
}

function buildRoomTypesAnswer(): string {
  const lines = knowledge.room_types.map(
    (room) =>
      `- ${room.name}: ${room.occupancy_note} Brochure rate ${room.brochure_rates.amount.toFixed(3)} ${room.brochure_rates.currency} (with breakfast).`
  );
  return `Available room types:\n${lines.join("\n")}`;
}

function buildRoomDescriptionsAnswer(): string {
  const entries = Object.entries(knowledge.room_descriptions).slice(0, 4);
  const lines = entries.map(([code, value]) => {
    const featureText = value.features.slice(0, 5).join(", ");
    return `- ${code}: ${value.summary} Key features: ${featureText}.`;
  });
  return `Room details:\n${lines.join("\n")}`;
}

function buildAmenitiesAnswer(): string {
  const general = knowledge.amenities.general.slice(0, 4).join(", ");
  const family = knowledge.amenities.family.slice(0, 3).join(", ");
  const recreation = knowledge.amenities.recreation_facilities.slice(0, 4).join(", ");
  return `Amenities overview:\n- General: ${general}\n- Family: ${family}\n- Recreation: ${recreation}`;
}

function buildRestaurantAnswer(): string {
  const timings = knowledge.restaurant.meal_timings;
  return [
    "Restaurant information:",
    `- Timings: Breakfast ${timings.breakfast}, Lunch ${timings.lunch}, Dinner ${timings.dinner}.`,
    `- Breakfast: ${knowledge.restaurant.breakfast.style}.`,
    `- Lunch brochure rate: ${knowledge.restaurant.lunch.brochure_rates.per_person.toFixed(3)} ${knowledge.restaurant.lunch.brochure_rates.currency} per person.`,
    `- Dinner brochure rate: ${knowledge.restaurant.dinner.brochure_rates.per_person.toFixed(3)} ${knowledge.restaurant.dinner.brochure_rates.currency} per person.`
  ].join("\n");
}

function buildCoffeeShopAnswer(): string {
  return [
    "Coffee shop information:",
    `- Hours: ${knowledge.coffee_shop.hours} (break ${knowledge.coffee_shop.break_time}).`,
    `- Beverages: ${knowledge.coffee_shop.beverages.join(", ")}.`,
    `- Snacks: ${knowledge.coffee_shop.snacks.join(", ")}.`,
    `- Pricing note: ${knowledge.coffee_shop.brochure_rates_note}`
  ].join("\n");
}

function buildActivitiesAnswer(): string {
  const lines = knowledge.activities.slice(0, 6).map((activity) => `- ${activity.name}: ${activity.details}`);
  return `Activities available:\n${lines.join("\n")}`;
}

function buildPoliciesAnswer(): string {
  const lines = [
    ...knowledge.policies.children_policy.map((x) => `- ${x}`),
    ...knowledge.policies.extra_person_policy.map((x) => `- ${x}`)
  ];
  return `Policies summary:\n${lines.join("\n")}`;
}

function buildCancellationAnswer(): string {
  const rules = knowledge.cancellation_policy.rules.slice(0, 4).map((rule) => `- ${rule}`);
  return `Cancellation policy:\n- ${knowledge.cancellation_policy.summary}\n${rules.join("\n")}`;
}

function buildContactsAnswer(): string {
  return [
    "Contact details:",
    `- Email: ${knowledge.contacts.email}`,
    `- Website: ${knowledge.contacts.website}`,
    `- Front desk: ${knowledge.contacts.front_desk_mobile.join(" / ")}`,
    `- Management: ${knowledge.contacts.management_contact.mobile}`,
    `- Instagram: ${knowledge.contacts.instagram}`
  ].join("\n");
}

function answerByTopic(topic: KnowledgeTopic): string {
  if (topic === "room_types") return buildRoomTypesAnswer();
  if (topic === "room_descriptions") return buildRoomDescriptionsAnswer();
  if (topic === "amenities") return buildAmenitiesAnswer();
  if (topic === "restaurant") return buildRestaurantAnswer();
  if (topic === "coffee_shop") return buildCoffeeShopAnswer();
  if (topic === "activities") return buildActivitiesAnswer();
  if (topic === "policies") return buildPoliciesAnswer();
  if (topic === "cancellation_policy") return buildCancellationAnswer();
  return buildContactsAnswer();
}

function matchFaq(question: string): { answer: string; topic: string } | null {
  const normalizedQuestion = normalize(question);
  for (const item of knowledge.faq_seed) {
    const normalizedSeed = normalize(item.question);
    if (
      normalizedQuestion.includes(normalizedSeed) ||
      normalizedSeed.includes(normalizedQuestion) ||
      normalizedQuestion.split(" ").some((token) => token.length > 4 && normalizedSeed.includes(token))
    ) {
      return { answer: item.answer, topic: item.topic };
    }
  }
  return null;
}

export function answerFromKnowledge(question: string): KnowledgeAnswerResult {
  const faq = matchFaq(question);
  if (faq) {
    return {
      isKnowledgeQuery: true,
      found: true,
      answer: faq.answer,
      intent: `FAQ_${faq.topic.toUpperCase()}`
    };
  }

  const topic = detectTopic(question);
  if (!topic) {
    return { isKnowledgeQuery: false, found: false };
  }

  const answer = answerByTopic(topic);
  if (!answer) {
    return { isKnowledgeQuery: true, found: false, intent: `FAQ_${topic.toUpperCase()}` };
  }

  return {
    isKnowledgeQuery: true,
    found: true,
    answer,
    intent: `FAQ_${topic.toUpperCase()}`
  };
}

export function buildKnowledgeFallbackMessage(): string {
  return "I could not find that specific detail in the current hotel knowledge file yet. You can ask about rooms, amenities, meals, coffee shop, activities, policies, cancellation, or contacts.";
}

export function getRoomTypesForBookingSubmenu(): string {
  return buildRoomTypesAnswer();
}

export function getOffersForBookingSubmenu(): string {
  const k = knowledge as Record<string, unknown>;
  const offers = Array.isArray(k.offers) ? (k.offers as string[]) : undefined;
  if (offers && offers.length > 0) {
    return "Current offers and promotions:\n" + offers.map((o, i) => `${i + 1}. ${o}`).join("\n");
  }
  return "No current offers or promotions are listed. For the best available rate, please check availability for your dates.";
}

export function getLocationAndHotelInfoForSubmenu(): string {
  const loc = knowledge.location as {
    village?: string;
    governorate?: string;
    country?: string;
    road_context?: string;
    distance_from_muscat_km?: number;
    distance_from_sur_km?: number;
  };
  const profile = knowledge.hotel_profile as { short_description?: string; hotel_name?: string };
  const parts: string[] = [];
  if (profile.hotel_name) parts.push(profile.hotel_name + ".");
  if (profile.short_description) parts.push(profile.short_description);
  if (loc.village || loc.governorate || loc.country) {
    parts.push(`Location: ${[loc.village, loc.governorate, loc.country].filter(Boolean).join(", ")}.`);
  }
  if (loc.road_context) parts.push(loc.road_context);
  if (loc.distance_from_muscat_km != null) parts.push(`About ${loc.distance_from_muscat_km} km from Muscat.`);
  return parts.length > 0 ? parts.join("\n") : "Location and hotel information is not available in the current knowledge file.";
}

