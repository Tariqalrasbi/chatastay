import type { Guest, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { guestPhoneData, parseGuestPhone, phonesEquivalent, toWhatsAppDigits, type ParsedGuestPhone } from "./phoneNumber";

export type GuestPhoneWrite = {
  phoneE164: string;
  phoneCountryCode: string | null;
  phoneNationalNumber: string | null;
  phoneRaw: string | null;
};

/** Build Prisma guest phone fields from raw input. */
export function resolveGuestPhoneFields(
  raw: string,
  defaultCountryIso = "OM",
  options?: { phoneRaw?: string }
): { parsed: ParsedGuestPhone; data: GuestPhoneWrite } {
  const parsed = parseGuestPhone(raw, defaultCountryIso, options);
  const data = guestPhoneData(parsed);
  return { parsed, data };
}

function phoneLookupVariants(parsed: ParsedGuestPhone): string[] {
  const variants = new Set<string>();
  if (parsed.phoneE164) variants.add(parsed.phoneE164);
  if (parsed.phoneE164Digits) {
    variants.add(parsed.phoneE164Digits);
    variants.add(`+${parsed.phoneE164Digits}`);
  }
  return [...variants];
}

/**
 * Find an existing guest by phone (handles legacy digit-only vs +E.164 storage).
 */
export async function findGuestByPhone(
  hotelId: string,
  raw: string,
  defaultCountryIso = "OM"
): Promise<Guest | null> {
  const { parsed } = resolveGuestPhoneFields(raw, defaultCountryIso, { phoneRaw: raw });
  if (!parsed.phoneE164Digits) return null;

  const variants = phoneLookupVariants(parsed);
  const matches = await prisma.guest.findMany({
    where: { hotelId, phoneE164: { in: variants } },
    orderBy: { updatedAt: "desc" }
  });
  if (!matches.length) return null;
  return matches[0]!;
}

/**
 * Upsert guest with canonical +E.164; merges legacy format rows when unambiguous.
 */
export async function upsertGuestWithPhone(
  params: {
    hotelId: string;
    phoneRaw: string;
    defaultCountryIso?: string;
    create: Omit<
      Prisma.GuestCreateInput,
      "phoneE164" | "phoneCountryCode" | "phoneNationalNumber" | "phoneRaw" | "hotel" | "hotelId"
    > & { hotelId: string };
    update?: Prisma.GuestUpdateInput;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Guest> {
  const country = params.defaultCountryIso ?? "OM";
  const { parsed, data } = resolveGuestPhoneFields(params.phoneRaw, country, {
    phoneRaw: params.phoneRaw
  });
  if (!parsed.phoneE164 || parsed.phoneE164Digits.length < 10) {
    throw new Error("Invalid phone number");
  }

  const existing = await findGuestByPhone(params.hotelId, params.phoneRaw, country);
  const phoneUpdate: GuestPhoneWrite = data;

  if (existing) {
    const other = await db.guest.findFirst({
      where: {
        hotelId: params.hotelId,
        phoneE164: phoneUpdate.phoneE164,
        NOT: { id: existing.id }
      }
    });
    if (other) {
      console.warn(
        "[guest-phone] collision: cannot normalize",
        JSON.stringify({ hotelId: params.hotelId, existingId: existing.id, otherId: other.id })
      );
    } else {
      return db.guest.update({
        where: { id: existing.id },
        data: {
          ...phoneUpdate,
          ...(params.update ?? {})
        }
      });
    }
  }

  const { hotelId: _createHotelId, ...createRest } = params.create;
  try {
    return await db.guest.upsert({
      where: {
        hotelId_phoneE164: { hotelId: params.hotelId, phoneE164: phoneUpdate.phoneE164 }
      },
      create: {
        hotelId: params.hotelId,
        ...phoneUpdate,
        ...createRest
      },
      update: {
        ...phoneUpdate,
        ...(params.update ?? {})
      }
    });
  } catch (err) {
    const legacy = await findGuestByPhone(params.hotelId, params.phoneRaw, country);
    if (legacy) {
      return db.guest.update({
        where: { id: legacy.id },
        data: { ...phoneUpdate, ...(params.update ?? {}) }
      });
    }
    throw err;
  }
}

/** Session / cache keys: stable digits-only. */
export function phoneSessionKeyPart(raw: string, defaultCountryIso = "OM"): string {
  const { parsed } = resolveGuestPhoneFields(raw, defaultCountryIso);
  return parsed.phoneE164Digits || toWhatsAppDigits(raw);
}

export { parseGuestPhone, phonesEquivalent, toWhatsAppDigits };
