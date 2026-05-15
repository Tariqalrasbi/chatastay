import { parseGuestPhone, toWhatsAppDigits } from "./phoneNumber";

/**
 * Normalize a stored guest phone to the digit string Meta expects (country code + national number, no +).
 * @deprecated Prefer parseGuestPhone + toWhatsAppDigits for new code.
 */
export function normalizeWhatsAppRecipientId(phoneRaw: string, countryIso = "OM"): string {
  const parsed = parseGuestPhone(phoneRaw, countryIso);
  if (parsed.phoneE164Digits.length >= 10) return parsed.phoneE164Digits;
  return toWhatsAppDigits(phoneRaw);
}
