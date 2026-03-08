import fs from "node:fs";
import path from "node:path";

export type PartnerSetupConfig = {
  hotelDescription: string;
  amenitiesSummary: string;
  whatsappPhoneNumberId: string;
  aiEnabled: boolean;
  aiTone: "friendly" | "premium" | "concise";
  instantWelcomeTemplate: string;
  instantQuoteTemplate: string;
  instantUnavailableTemplate: string;
  instantConfirmationTemplate: string;
  aiKnowledgeBase: string;
  aiKnowledgeBaseEn: string;
  aiKnowledgeBaseAr: string;
  aiKnowledgeBaseEs: string;
  aiKnowledgeBaseFr: string;
};

const partnerSetupConfigPath = path.join(process.cwd(), "hotel-partner-config.json");

const defaultPartnerSetupConfig: PartnerSetupConfig = {
  hotelDescription: "Beachfront resort with direct WhatsApp booking assistance and flexible room options.",
  amenitiesSummary: "Private beach access, family apartments, sea-view suites, breakfast options.",
  whatsappPhoneNumberId: "",
  aiEnabled: true,
  aiTone: "friendly",
  instantWelcomeTemplate: "Welcome to {{hotel_name}}. Tell us your check-in/check-out dates and number of guests to get instant options.",
  instantQuoteTemplate:
    "Thanks {{guest_name}}. We currently suggest {{room_type}} at {{nightly_rate}} per night for {{nights}} nights. Would you like us to reserve it?",
  instantUnavailableTemplate:
    "Sorry, that room type is limited for your dates. We can offer {{alternative_room}} instead. Would you like details?",
  instantConfirmationTemplate:
    "Great news {{guest_name}}. Your stay is confirmed: {{room_type}} from {{check_in}} to {{check_out}}. Booking ID: {{booking_id}}.",
  aiKnowledgeBase: "",
  aiKnowledgeBaseEn: "",
  aiKnowledgeBaseAr: "",
  aiKnowledgeBaseEs: "",
  aiKnowledgeBaseFr: ""
};

type StoredPartnerConfigShape = {
  default?: Partial<PartnerSetupConfig>;
  hotels?: Record<string, Partial<PartnerSetupConfig>>;
};

function sanitizePartnerConfig(parsed: Partial<PartnerSetupConfig> | undefined): PartnerSetupConfig {
  const source = parsed ?? {};
  return {
    hotelDescription: source.hotelDescription ?? defaultPartnerSetupConfig.hotelDescription,
    amenitiesSummary: source.amenitiesSummary ?? defaultPartnerSetupConfig.amenitiesSummary,
    whatsappPhoneNumberId: source.whatsappPhoneNumberId ?? defaultPartnerSetupConfig.whatsappPhoneNumberId,
    aiEnabled: typeof source.aiEnabled === "boolean" ? source.aiEnabled : defaultPartnerSetupConfig.aiEnabled,
    aiTone:
      source.aiTone === "friendly" || source.aiTone === "premium" || source.aiTone === "concise"
        ? source.aiTone
        : defaultPartnerSetupConfig.aiTone,
    instantWelcomeTemplate: source.instantWelcomeTemplate ?? defaultPartnerSetupConfig.instantWelcomeTemplate,
    instantQuoteTemplate: source.instantQuoteTemplate ?? defaultPartnerSetupConfig.instantQuoteTemplate,
    instantUnavailableTemplate: source.instantUnavailableTemplate ?? defaultPartnerSetupConfig.instantUnavailableTemplate,
    instantConfirmationTemplate: source.instantConfirmationTemplate ?? defaultPartnerSetupConfig.instantConfirmationTemplate,
    aiKnowledgeBase: source.aiKnowledgeBase ?? defaultPartnerSetupConfig.aiKnowledgeBase,
    aiKnowledgeBaseEn: source.aiKnowledgeBaseEn ?? defaultPartnerSetupConfig.aiKnowledgeBaseEn,
    aiKnowledgeBaseAr: source.aiKnowledgeBaseAr ?? defaultPartnerSetupConfig.aiKnowledgeBaseAr,
    aiKnowledgeBaseEs: source.aiKnowledgeBaseEs ?? defaultPartnerSetupConfig.aiKnowledgeBaseEs,
    aiKnowledgeBaseFr: source.aiKnowledgeBaseFr ?? defaultPartnerSetupConfig.aiKnowledgeBaseFr
  };
}

function loadRawPartnerSetupStore(): StoredPartnerConfigShape {
  try {
    if (!fs.existsSync(partnerSetupConfigPath)) {
      const seed: StoredPartnerConfigShape = { default: { ...defaultPartnerSetupConfig }, hotels: {} };
      fs.writeFileSync(partnerSetupConfigPath, JSON.stringify(seed, null, 2), "utf8");
      return seed;
    }
    const parsed = JSON.parse(fs.readFileSync(partnerSetupConfigPath, "utf8")) as StoredPartnerConfigShape | Partial<PartnerSetupConfig>;
    if (
      parsed &&
      typeof parsed === "object" &&
      ("default" in parsed || "hotels" in parsed)
    ) {
      return {
        default: (parsed as StoredPartnerConfigShape).default ?? {},
        hotels: (parsed as StoredPartnerConfigShape).hotels ?? {}
      };
    }
    return {
      default: parsed as Partial<PartnerSetupConfig>,
      hotels: {}
    };
  } catch {
    return { default: { ...defaultPartnerSetupConfig }, hotels: {} };
  }
}

export function loadPartnerSetupConfig(hotelKey = "default"): PartnerSetupConfig {
  const store = loadRawPartnerSetupStore();
  const defaultConfig = sanitizePartnerConfig(store.default);
  if (hotelKey === "default") {
    return defaultConfig;
  }
  const hotelConfig = sanitizePartnerConfig(store.hotels?.[hotelKey]);
  return {
    ...defaultConfig,
    ...hotelConfig
  };
}

export function savePartnerSetupConfig(config: PartnerSetupConfig, hotelKey = "default"): void {
  const store = loadRawPartnerSetupStore();
  const nextStore: StoredPartnerConfigShape = {
    default: store.default ?? {},
    hotels: store.hotels ?? {}
  };
  if (hotelKey === "default") {
    nextStore.default = { ...config };
  } else {
    nextStore.hotels![hotelKey] = { ...config };
  }
  fs.writeFileSync(partnerSetupConfigPath, JSON.stringify(nextStore, null, 2), "utf8");
}

export function applyPartnerTemplate(template: string, values: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === null || value === undefined ? "" : String(value);
  });
}
