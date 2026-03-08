export interface ParsedMessage {
  rawText: string;
  checkIn?: Date;
  checkOut?: Date;
  guestCount?: number;
  roomCount?: number;
  detectedDateCount: number;
  hasDateLikeText: boolean;
}

export interface ParseValidationResult {
  ok: boolean;
  message?: string;
  missing: Array<"dates" | "guests">;
}

const DATE_TOKEN_REGEX = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/g;
const DATE_TOKEN_HAS_REGEX = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/;
const DATE_RANGE_REGEX = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\s*(?:to|until|till|-|->|الى|إلى)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i;
const MONTH_NAME_RANGE_REGEX =
  /(?:from\s+)?(\d{1,2}\s+(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:\s+\d{4})?)\s*(?:to|until|till|الى|إلى)\s*(\d{1,2}\s+(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:\s+\d{4})?)/i;
const CHECK_IN_REGEX = /(?:check[\s-]?in|arrival|دخول|تسجيل الدخول)\s*(?:[:=-]|\s)?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i;
const CHECK_OUT_REGEX = /(?:check[\s-]?out|departure|خروج|تسجيل الخروج)\s*(?:[:=-]|\s)?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i;
const GUESTS_LABELED_REGEX =
  /(?:guests?|guest|adults?|people|persons?|pax|ضيوف|ضيف|اشخاص|أشخاص|نفر)\s*[:=-]?\s*(\d{1,2})/i;
const GUESTS_INLINE_REGEX =
  /(?:for|with|لـ|ل)\s*(\d{1,2})\s*(?:guests?|guest|adults?|people|persons?|pax|ضيوف|ضيف|اشخاص|أشخاص|نفر)?/i;
const ROOMS_LABELED_REGEX = /(?:rooms?|room|غرف|غرفة|habitaciones|chambres?)\s*[:=-]?\s*(\d{1,2})/i;
const ROOMS_INLINE_REGEX = /(\d{1,2})\s*(?:rooms?|room|غرف|غرفة|habitaciones|chambres?)/i;
const GUESTS_SHORT_REGEX = /^(\d{1,2})$/;
const MAX_STAY_NIGHTS = 30;
const MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

function toStrictDate(token: string): Date | undefined {
  const normalized = token.trim().replaceAll("/", "-");
  const parts = normalized.split("-");
  if (parts.length !== 3) return undefined;

  let year = 0;
  let month = 0;
  let day = 0;

  if (parts[0].length === 4) {
    year = Number(parts[0]);
    month = Number(parts[1]);
    day = Number(parts[2]);
  } else if (parts[2].length === 4) {
    day = Number(parts[0]);
    month = Number(parts[1]);
    year = Number(parts[2]);
  } else {
    return undefined;
  }

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > 31) return undefined;

  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return undefined;
  }
  return value;
}

function toMonthNamedDate(token: string): Date | undefined {
  const parts = token.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const day = Number(parts[0]);
  const month = MONTH_MAP[parts[1]];
  const nowYear = new Date().getUTCFullYear();
  const year = parts.length === 3 ? Number(parts[2]) : nowYear;
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return undefined;
  if (day < 1 || day > 31) return undefined;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return undefined;
  }
  return value;
}

function extractGuestCount(text: string): number | undefined {
  const labeled = text.match(GUESTS_LABELED_REGEX);
  if (labeled) return Number(labeled[1]);

  const inline = text.match(GUESTS_INLINE_REGEX);
  if (inline) return Number(inline[1]);

  const short = text.trim().match(GUESTS_SHORT_REGEX);
  if (short) return Number(short[1]);

  return undefined;
}

function extractRoomCount(text: string): number | undefined {
  const labeled = text.match(ROOMS_LABELED_REGEX);
  if (labeled) return Number(labeled[1]);

  const inline = text.match(ROOMS_INLINE_REGEX);
  if (inline) return Number(inline[1]);

  return undefined;
}

export function parseGuestMessage(text: string): ParsedMessage {
  const dateTokens = extractSingleDates(text);
  const parsed: ParsedMessage = {
    rawText: text,
    detectedDateCount: dateTokens.length,
    hasDateLikeText: DATE_TOKEN_HAS_REGEX.test(text)
  };

  const dateRange = extractDateRange(text);
  if (dateRange) {
    parsed.checkIn = dateRange.checkIn;
    parsed.checkOut = dateRange.checkOut;
  }

  parsed.guestCount = extractGuestCount(text);
  parsed.roomCount = extractRoomCount(text);

  return parsed;
}

export function extractDateRange(text: string): { checkIn?: Date; checkOut?: Date } | null {
  const range = text.match(DATE_RANGE_REGEX);
  if (range) {
    return {
      checkIn: toStrictDate(range[1]),
      checkOut: toStrictDate(range[2])
    };
  }

  const monthRange = text.match(MONTH_NAME_RANGE_REGEX);
  if (monthRange) {
    const checkIn = toMonthNamedDate(monthRange[1]);
    const checkOut = toMonthNamedDate(monthRange[2]);
    return { checkIn, checkOut };
  }

  const checkInMatch = text.match(CHECK_IN_REGEX);
  const checkOutMatch = text.match(CHECK_OUT_REGEX);
  if (checkInMatch || checkOutMatch) {
    return {
      checkIn: checkInMatch ? toStrictDate(checkInMatch[1]) : undefined,
      checkOut: checkOutMatch ? toStrictDate(checkOutMatch[1]) : undefined
    };
  }

  const singles = extractSingleDates(text);
  if (singles.length >= 2) {
    return {
      checkIn: toStrictDate(singles[0]),
      checkOut: toStrictDate(singles[1])
    };
  }

  return null;
}

export function extractSingleDates(text: string): string[] {
  const seen = new Set<string>();
  const matches = text.matchAll(DATE_TOKEN_REGEX);
  for (const match of matches) {
    const parsed = toStrictDate(match[1]);
    if (!parsed) continue;
    const value = parsed.toISOString().slice(0, 10);
    if (!seen.has(value)) seen.add(value);
  }
  return Array.from(seen);
}

export function validateParsedBookingInput(parsed: ParsedMessage): ParseValidationResult {
  const missing: Array<"dates" | "guests"> = [];
  if (!parsed.checkIn || !parsed.checkOut) missing.push("dates");
  if (parsed.guestCount === undefined) missing.push("guests");

  if (parsed.hasDateLikeText && parsed.detectedDateCount === 0) {
    return {
      ok: false,
      missing,
      message: "I could not read the date format. Please use YYYY-MM-DD (example: 2026-04-10 to 2026-04-12)."
    };
  }

  if ((parsed.checkIn && !parsed.checkOut) || (!parsed.checkIn && parsed.checkOut)) {
    return {
      ok: false,
      missing,
      message: "I found one date only. Please send both check-in and check-out."
    };
  }

  if (parsed.checkIn && parsed.checkOut) {
    if (parsed.checkOut.getTime() <= parsed.checkIn.getTime()) {
      return {
        ok: false,
        missing,
        message: "Check-out must be after check-in. Please resend your dates."
      };
    }
    const nights = Math.ceil((parsed.checkOut.getTime() - parsed.checkIn.getTime()) / (1000 * 60 * 60 * 24));
    if (nights > MAX_STAY_NIGHTS) {
      return {
        ok: false,
        missing,
        message: `Maximum stay is ${MAX_STAY_NIGHTS} nights. Please send a shorter date range.`
      };
    }
  }

  if (parsed.guestCount !== undefined && (parsed.guestCount < 1 || parsed.guestCount > 16)) {
    return {
      ok: false,
      missing,
      message: "Guest count must be between 1 and 16."
    };
  }

  if (parsed.roomCount !== undefined && (parsed.roomCount < 1 || parsed.roomCount > 6)) {
    return {
      ok: false,
      missing,
      message: "Room count must be between 1 and 6."
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message: "Please send check-in, check-out, and guest count. Example: 2026-04-10 to 2026-04-12 for 2 guests, 1 room."
    };
  }

  return { ok: true, missing };
}
