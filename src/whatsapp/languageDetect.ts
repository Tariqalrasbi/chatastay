import type { ChatLang } from "./chatbotCopy";

/** Normalize guest text for language heuristics (lowercase, strip diacritics / invisible chars). */
export function normalizeInboundText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isExplicitEnglishGreeting(text: string): boolean {
  const normalized = normalizeInboundText(text);
  return /(^|\s)(hi|hello|hey)(\s|$)/i.test(normalized);
}

/** Infer chat language from inbound message text (defaults to English). */
export function detectInboundLanguage(text: string): ChatLang {
  const normalized = normalizeInboundText(text);
  if (isExplicitEnglishGreeting(text)) {
    return "en";
  }
  if (/^(hi|hello|hey|good morning|good evening)$/i.test(normalized)) {
    return "en";
  }
  if (
    /[\u0600-\u06FF]/.test(text) ||
    /(السلام|مرحبا|اهلا|أهلا|هلا|شلونك|صباح الخير|مساء الخير|asalam|salam|assalamu)/i.test(normalized)
  ) {
    return "ar";
  }
  if (/\b(hola|buenas|gracias|reservar|quiero|habitacion|habitación)\b/i.test(normalized)) {
    return "es";
  }
  if (/\b(bonjour|salut|merci|reserver|réserver|chambre)\b/i.test(normalized)) {
    return "fr";
  }
  return "en";
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|start|menu|help|hola|bonjour|salut|marhaba|salam|assalamu alaikum|aslaimu alaikum|السلام عليكم|مرحبا|اهلا|أهلا|greetings)$/i.test(
    normalizeInboundText(text)
  );
}

/** Switch language mid-thread when the guest clearly writes in another language. */
export function shouldSwitchConversationLanguage(
  current: ChatLang,
  inferred: ChatLang,
  text: string
): boolean {
  if (current === inferred) return false;
  const normalized = normalizeInboundText(text);
  if (isGreeting(normalized)) return true;
  if (/(english|arabic|spanish|french|انجليزي|عربي|اسباني|فرنسي|español|francais|français)/i.test(normalized)) {
    return true;
  }
  if (/[\u0600-\u06FF]/.test(text) && inferred === "ar") return true;
  if (/\b(hola|buenas|gracias|reservar)\b/i.test(normalized) && inferred === "es") return true;
  if (/\b(bonjour|salut|merci|reserver)\b/i.test(normalized) && inferred === "fr") return true;
  return false;
}
