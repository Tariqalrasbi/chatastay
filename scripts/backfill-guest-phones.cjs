/**
 * Idempotent backfill: normalize Guest.phoneE164 to +E.164 and fill country/national fields.
 * Usage: node scripts/backfill-guest-phones.cjs [--dry-run]
 */
const { PrismaClient } = require("@prisma/client");
const { parsePhoneNumberFromString } = require("libphonenumber-js");

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

function parsePhone(raw, countryIso = "OM") {
  const input = String(raw ?? "").trim();
  const fallbackDigits = input.replace(/\D/g, "");
  if (!fallbackDigits) return null;

  let parsed = parsePhoneNumberFromString(input, countryIso);
  if (!parsed?.isValid()) {
    const withPlus = input.startsWith("+") ? input : `+${fallbackDigits}`;
    parsed = parsePhoneNumberFromString(withPlus, countryIso);
  }
  if (!parsed?.isValid() && fallbackDigits.startsWith("00")) {
    parsed = parsePhoneNumberFromString(`+${fallbackDigits.slice(2)}`, countryIso);
  }

  if (parsed?.isValid()) {
    const phoneE164 = parsed.format("E.164");
    return {
      phoneE164,
      phoneCountryCode: `+${parsed.countryCallingCode}`,
      phoneNationalNumber: parsed.nationalNumber,
      phoneE164Digits: phoneE164.replace(/\D/g, "")
    };
  }

  let digits = fallbackDigits;
  if (digits.startsWith("00")) digits = digits.slice(2);
  const cc = countryIso === "OM" ? "968" : "";
  if (cc && digits.length >= 7 && digits.length <= 10 && !digits.startsWith(cc)) {
    digits = `${cc}${digits.replace(/^0+/, "")}`;
  }
  if (digits.length < 10) return null;
  return {
    phoneE164: `+${digits}`,
    phoneCountryCode: cc ? `+${cc}` : null,
    phoneNationalNumber: cc && digits.startsWith(cc) ? digits.slice(cc.length) : digits,
    phoneE164Digits: digits
  };
}

async function main() {
  const guests = await prisma.guest.findMany({
    select: {
      id: true,
      hotelId: true,
      phoneE164: true,
      phoneCountryCode: true,
      phoneNationalNumber: true,
      hotel: { select: { country: true } }
    }
  });

  let updated = 0;
  let skipped = 0;
  let collisions = 0;
  const failures = [];

  for (const g of guests) {
    const country = (g.hotel?.country ?? "OM").toUpperCase();
    const parsed = parsePhone(g.phoneE164, country);
    if (!parsed) {
      failures.push({ id: g.id, phone: g.phoneE164, reason: "unparseable" });
      skipped++;
      continue;
    }

    const needsUpdate =
      g.phoneE164 !== parsed.phoneE164 ||
      g.phoneCountryCode !== parsed.phoneCountryCode ||
      g.phoneNationalNumber !== parsed.phoneNationalNumber;

    if (!needsUpdate) {
      skipped++;
      continue;
    }

    const conflict = await prisma.guest.findFirst({
      where: {
        hotelId: g.hotelId,
        phoneE164: parsed.phoneE164,
        NOT: { id: g.id }
      },
      select: { id: true, phoneE164: true }
    });

    if (conflict) {
      collisions++;
      failures.push({
        id: g.id,
        phone: g.phoneE164,
        reason: `collision with guest ${conflict.id} (${conflict.phoneE164})`
      });
      continue;
    }

    if (!dryRun) {
      await prisma.guest.update({
        where: { id: g.id },
        data: {
          phoneE164: parsed.phoneE164,
          phoneCountryCode: parsed.phoneCountryCode,
          phoneNationalNumber: parsed.phoneNationalNumber
        }
      });
    }
    updated++;
  }

  console.log(
    JSON.stringify(
      { dryRun, total: guests.length, updated, skipped, collisions, failureCount: failures.length },
      null,
      2
    )
  );
  if (failures.length) {
    console.log("Failures (first 20):");
    console.log(JSON.stringify(failures.slice(0, 20), null, 2));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
