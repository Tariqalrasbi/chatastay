export type Language = "en" | "ar";

const messages: Record<Language, Record<string, string>> = {
  en: {
    welcome: "Welcome to ChatStay! Please share your check-in and check-out dates.",
    missingDates: "Please send your dates in this format: YYYY-MM-DD to YYYY-MM-DD.",
    quoteReady: "Great! Here is your quote.",
    noAvailability: "Sorry, no rooms are available for those dates."
  },
  ar: {
    welcome: "أهلاً بك في تشاتا ستاي! يُرجى إرسال تاريخ الوصول والمغادرة.",
    missingDates: "يُرجى إرسال التواريخ بهذا الشكل: YYYY-MM-DD إلى YYYY-MM-DD.",
    quoteReady: "ممتاز! هذا عرض السعر لإقامتك.",
    noAvailability: "عذراً، لا تتوفر غرف في هذه التواريخ."
  }
};

export function t(key: string, language: Language = "en"): string {
  return messages[language][key] ?? messages.en[key] ?? key;
}
