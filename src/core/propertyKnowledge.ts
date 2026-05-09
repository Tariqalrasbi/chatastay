import type { PrismaClient, PropertyKnowledgeEntry, PropertyPolicy } from "@prisma/client";
import { loadPartnerSetupConfig } from "./partnerSetup";

export type KnowledgeAnswerResult = {
  isKnowledgeQuery: boolean;
  found: boolean;
  answer?: string;
  intent?: string;
  source?: "db" | "partner_setup";
};

export type KnowledgeInput = {
  hotelId: string;
  propertyId?: string | null;
  question: string;
  locale?: string | null;
};

export const KNOWLEDGE_CATEGORIES = [
  "general",
  "rooms",
  "rates",
  "policies",
  "restaurant",
  "services",
  "activities",
  "directions",
  "contacts",
  "emergency",
  "custom"
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  rooms: ["room", "rooms", "suite", "apartment", "bed", "balcony", "sea view", "غرفة", "غرف"],
  rates: ["rate", "price", "cost", "how much", "breakfast included", "half board", "full board", "سعر"],
  policies: ["policy", "policies", "check in", "checkout", "cancel", "refund", "no show", "child", "pet", "smoking"],
  restaurant: ["restaurant", "breakfast", "lunch", "dinner", "coffee", "cafe", "room service", "مطعم", "فطور"],
  services: ["service", "airport", "transfer", "laundry", "housekeeping", "extra bed", "parking"],
  activities: ["activity", "activities", "tour", "rental", "boat", "bike", "quad", "fishing"],
  directions: ["location", "direction", "map", "maps", "address", "where", "drive", "وصل"],
  contacts: ["contact", "phone", "email", "whatsapp", "instagram", "website", "تواصل"],
  emergency: ["emergency", "urgent", "doctor", "hospital", "police", "help"]
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

function tokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((token) => token.length >= 3);
}

export function detectKnowledgeCategory(question: string): string | null {
  const normalized = normalize(question);
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => normalized.includes(normalize(keyword)))) {
      return category;
    }
  }
  return null;
}

function scoreEntry(entry: Pick<PropertyKnowledgeEntry, "category" | "question" | "answer">, question: string): number {
  const questionText = normalize(question);
  const entryQuestion = normalize(entry.question ?? "");
  const entryAnswer = normalize(entry.answer);
  const entryCategory = normalize(entry.category);
  const detectedCategory = detectKnowledgeCategory(question);
  let score = 0;
  if (detectedCategory && normalize(detectedCategory) === entryCategory) score += 4;
  if (entryQuestion && (questionText.includes(entryQuestion) || entryQuestion.includes(questionText))) score += 8;
  for (const token of tokens(question)) {
    if (entryQuestion.includes(token)) score += 2;
    if (entryAnswer.includes(token)) score += 1;
  }
  return score;
}

export async function listKnowledgeEntries(
  prisma: PrismaClient,
  hotelId: string,
  opts: { propertyId?: string | null; includeInactive?: boolean; locale?: string | null } = {}
): Promise<PropertyKnowledgeEntry[]> {
  return prisma.propertyKnowledgeEntry.findMany({
    where: {
      hotelId,
      ...(opts.propertyId ? { OR: [{ propertyId: opts.propertyId }, { propertyId: null }] } : {}),
      ...(opts.includeInactive ? {} : { isActive: true }),
      ...(opts.locale ? { locale: { in: [opts.locale, "en"] } } : {})
    },
    orderBy: [{ category: "asc" }, { updatedAt: "desc" }]
  });
}

export async function listPolicies(
  prisma: PrismaClient,
  hotelId: string,
  opts: { propertyId?: string | null; includeInactive?: boolean; locale?: string | null } = {}
): Promise<PropertyPolicy[]> {
  return prisma.propertyPolicy.findMany({
    where: {
      hotelId,
      ...(opts.propertyId ? { OR: [{ propertyId: opts.propertyId }, { propertyId: null }] } : {}),
      ...(opts.includeInactive ? {} : { isActive: true }),
      ...(opts.locale ? { locale: { in: [opts.locale, "en"] } } : {})
    },
    orderBy: [{ type: "asc" }, { updatedAt: "desc" }]
  });
}

function answerFromPartnerSetupText(question: string, raw: string): KnowledgeAnswerResult | null {
  const text = raw.trim();
  if (!text) return null;
  const normalizedQuestion = normalize(question);

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      const rows = parsed
        .map((item) => {
          const row = item as Record<string, unknown>;
          return {
            question: String(row.question ?? row.q ?? "").trim(),
            answer: String(row.answer ?? row.a ?? "").trim()
          };
        })
        .filter((item) => item.answer);
      const best = rows
        .map((row) => ({
          row,
          score:
            normalize(row.question) && normalizedQuestion.includes(normalize(row.question))
              ? 8
              : tokens(question).filter((token) => normalize(row.question + " " + row.answer).includes(token)).length
        }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0) {
        return {
          isKnowledgeQuery: true,
          found: true,
          answer: best.row.answer,
          intent: "FAQ_PARTNER_SETUP",
          source: "partner_setup"
        };
      }
    }
  } catch {
    // Fall through to line-based format.
  }

  const lineMatch = text
    .split(/\r?\n/)
    .map((line) => {
      const [questionPart, ...answerParts] = line.split("|");
      const questionLike = questionPart.trim();
      const answerLike = (answerParts.join("|").trim() || line.trim()).slice(0, 1200);
      const score = tokens(question).filter((token) => normalize(questionLike + " " + answerLike).includes(token)).length;
      return { answer: answerLike, score };
    })
    .filter((item) => item.answer.length > 0)
    .sort((a, b) => b.score - a.score)[0];

  if (lineMatch && lineMatch.score > 0) {
    return {
      isKnowledgeQuery: true,
      found: true,
      answer: lineMatch.answer,
      intent: "FAQ_PARTNER_SETUP",
      source: "partner_setup"
    };
  }

  return null;
}

export async function answerFromPropertyKnowledge(
  prisma: PrismaClient,
  input: KnowledgeInput
): Promise<KnowledgeAnswerResult> {
  const category = detectKnowledgeCategory(input.question);
  const entries = await listKnowledgeEntries(prisma, input.hotelId, {
    propertyId: input.propertyId ?? null,
    locale: input.locale ?? "en"
  });
  const best = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, input.question) }))
    .sort((a, b) => b.score - a.score)[0];

  if (best && best.score > 0) {
    return {
      isKnowledgeQuery: true,
      found: true,
      answer: best.entry.answer,
      intent: `FAQ_${best.entry.category.toUpperCase()}`,
      source: "db"
    };
  }

  const config = loadPartnerSetupConfig(input.hotelId);
  const fallbackText =
    input.locale === "ar"
      ? config.aiKnowledgeBaseAr || config.aiKnowledgeBase
      : input.locale === "es"
        ? config.aiKnowledgeBaseEs || config.aiKnowledgeBase
        : input.locale === "fr"
          ? config.aiKnowledgeBaseFr || config.aiKnowledgeBase
          : config.aiKnowledgeBaseEn || config.aiKnowledgeBase;
  const partnerSetupAnswer = answerFromPartnerSetupText(input.question, fallbackText);
  if (partnerSetupAnswer) return partnerSetupAnswer;

  if (!category) {
    return { isKnowledgeQuery: false, found: false };
  }

  return { isKnowledgeQuery: true, found: false, intent: `FAQ_${category.toUpperCase()}` };
}

export function buildKnowledgeFallbackMessage(): string {
  return "I could not find that specific detail in this property's knowledge bank yet. You can ask about rooms, amenities, meals, activities, policies, cancellation, directions, or contacts.";
}
