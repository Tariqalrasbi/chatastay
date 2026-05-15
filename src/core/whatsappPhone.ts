/** ISO 3166-1 alpha-2 → E.164 country calling code (digits only). */
const DIAL_BY_COUNTRY: Record<string, string> = {
  OM: "968",
  AE: "971",
  SA: "966",
  QA: "974",
  KW: "965",
  BH: "973",
  US: "1",
  GB: "44",
  IN: "91"
};

/**
 * Normalize a stored guest phone to the digit string Meta expects (country code + national number, no +).
 */
export function normalizeWhatsAppRecipientId(phoneRaw: string, countryIso = "OM"): string {
  const digits = String(phoneRaw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  const cc = DIAL_BY_COUNTRY[String(countryIso ?? "OM").toUpperCase()] ?? "968";

  // Already international length with known country prefix
  if (digits.length >= 11 && digits.startsWith(cc)) return digits;
  if (digits.length >= 12) return digits;

  if (digits.startsWith(cc) && digits.length >= cc.length + 7) return digits;

  // Local trunk prefix (e.g. 09xxxxxxxx)
  if (digits.startsWith("0") && digits.length >= 8) {
    return `${cc}${digits.slice(1)}`;
  }

  // National number without country code (common in CRM imports)
  if (digits.length >= 7 && digits.length <= 10) {
    return `${cc}${digits}`;
  }

  return digits;
}
