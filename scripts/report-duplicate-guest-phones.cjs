/**
 * Report guest rows that share the same normalized digits but different phoneE164 strings.
 * Does NOT merge records.
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function digits(phone) {
  return String(phone ?? "").replace(/\D/g, "");
}

async function main() {
  const guests = await prisma.guest.findMany({
    select: { id: true, hotelId: true, fullName: true, phoneE164: true, phoneCountryCode: true },
    orderBy: [{ hotelId: "asc" }, { phoneE164: "asc" }]
  });

  const byHotelDigits = new Map();
  for (const g of guests) {
    const d = digits(g.phoneE164);
    if (d.length < 8) continue;
    const key = `${g.hotelId}:${d}`;
    if (!byHotelDigits.has(key)) byHotelDigits.set(key, []);
    byHotelDigits.get(key).push(g);
  }

  const groups = [...byHotelDigits.values()].filter((list) => list.length > 1);
  console.log(`Duplicate candidate groups: ${groups.length}`);
  for (const list of groups.slice(0, 50)) {
    console.log("---");
    for (const g of list) {
      console.log(`  ${g.id} | ${g.fullName ?? "—"} | ${g.phoneE164} | cc=${g.phoneCountryCode ?? "—"}`);
    }
  }
  if (groups.length > 50) console.log(`... and ${groups.length - 50} more groups`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
