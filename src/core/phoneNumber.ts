import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type ParsedGuestPhone = {
  /** E.164 with leading + (canonical DB value). */
  phoneE164: string;
  /** Dial code with +, e.g. +968 */
  phoneCountryCode: string;
  /** National significant number without country code. */
  phoneNationalNumber: string;
  /** Digits only, full international (Meta `to` field). */
  phoneE164Digits: string;
  /** Original input when provided. */
  phoneRaw?: string;
  isValid: boolean;
};

function toCountryCode(iso: string | null | undefined): CountryCode {
  const c = String(iso ?? "OM").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) return c as CountryCode;
  return "OM";
}

/**
 * Parse and normalize a guest phone for storage and WhatsApp.
 * Never throws — returns best-effort result with isValid=false on hard failures.
 */
export function parseGuestPhone(
  raw: string,
  defaultCountryIso = "OM",
  options?: { phoneRaw?: string }
): ParsedGuestPhone {
  const input = String(raw ?? "").trim();
  const phoneRaw = options?.phoneRaw?.trim() || input || undefined;
  const fallbackDigits = input.replace(/\D/g, "");

  if (!fallbackDigits) {
    return {
      phoneE164: "",
      phoneCountryCode: "",
      phoneNationalNumber: "",
      phoneE164Digits: "",
      phoneRaw,
      isValid: false
    };
  }

  const country = toCountryCode(defaultCountryIso);
  let parsed = parsePhoneNumberFromString(input, country);
  if (!parsed?.isValid()) {
    const withPlus = input.startsWith("+") ? input : `+${fallbackDigits}`;
    parsed = parsePhoneNumberFromString(withPlus, country);
  }
  if (!parsed?.isValid() && fallbackDigits.startsWith("00")) {
    parsed = parsePhoneNumberFromString(`+${fallbackDigits.slice(2)}`, country);
  }

  if (parsed?.isValid()) {
    const phoneE164 = parsed.format("E.164");
    const phoneE164Digits = phoneE164.replace(/\D/g, "");
    const phoneCountryCode = `+${parsed.countryCallingCode}`;
    const phoneNationalNumber = parsed.nationalNumber;
    return {
      phoneE164,
      phoneCountryCode,
      phoneNationalNumber,
      phoneE164Digits,
      phoneRaw,
      isValid: true
    };
  }

  // Best-effort: preserve digits; add + if missing
  let digits = fallbackDigits;
  if (digits.startsWith("00")) digits = digits.slice(2);
  const cc = country === "OM" ? "968" : parsed?.countryCallingCode ?? "";
  if (cc && digits.length >= 7 && digits.length <= 10 && !digits.startsWith(cc)) {
    digits = `${cc}${digits.replace(/^0+/, "")}`;
  }
  const phoneE164 = `+${digits}`;
  const phoneCountryCode = cc ? `+${cc}` : "";
  const phoneNationalNumber =
    cc && digits.startsWith(cc) ? digits.slice(cc.length) : digits;

  return {
    phoneE164,
    phoneCountryCode,
    phoneNationalNumber,
    phoneE164Digits: digits,
    phoneRaw,
    isValid: digits.length >= 10
  };
}

/** Meta Cloud API expects digits only (no +). */
export function toWhatsAppDigits(phoneE164: string): string {
  return String(phoneE164 ?? "").replace(/\D/g, "");
}

export function phonesEquivalent(a: string, b: string, defaultCountryIso = "OM"): boolean {
  const pa = parseGuestPhone(a, defaultCountryIso);
  const pb = parseGuestPhone(b, defaultCountryIso);
  if (!pa.phoneE164Digits || !pb.phoneE164Digits) return false;
  return pa.phoneE164Digits === pb.phoneE164Digits;
}

/** Prisma guest create/update payload fields from parsed phone. */
export function guestPhoneData(
  parsed: ParsedGuestPhone
): {
  phoneE164: string;
  phoneCountryCode: string | null;
  phoneNationalNumber: string | null;
  phoneRaw: string | null;
} {
  if (!parsed.phoneE164) {
    return {
      phoneE164: "",
      phoneCountryCode: null,
      phoneNationalNumber: null,
      phoneRaw: parsed.phoneRaw ?? null
    };
  }
  return {
    phoneE164: parsed.phoneE164,
    phoneCountryCode: parsed.phoneCountryCode || null,
    phoneNationalNumber: parsed.phoneNationalNumber || null,
    phoneRaw: parsed.phoneRaw ?? null
  };
}

/**
 * Combine country code field + local number from admin forms, then parse.
 */
export function parseGuestPhoneFromFormFields(params: {
  countryCodeRaw: string | undefined;
  phoneRaw: string;
  defaultCountryIso?: string;
}): ParsedGuestPhone {
  const local = String(params.phoneRaw ?? "").trim();
  const ccRaw = String(params.countryCodeRaw ?? "").trim();
  if (!local) return parseGuestPhone("", params.defaultCountryIso);

  if (local.startsWith("+") || local.startsWith("00")) {
    return parseGuestPhone(local, params.defaultCountryIso, { phoneRaw: local });
  }

  const ccDigits = ccRaw.replace(/\D/g, "");
  const localDigits = local.replace(/\D/g, "");
  const combined = ccDigits ? `+${ccDigits}${localDigits.replace(/^0+/, "")}` : local;
  return parseGuestPhone(combined, params.defaultCountryIso, {
    phoneRaw: local
  });
}
