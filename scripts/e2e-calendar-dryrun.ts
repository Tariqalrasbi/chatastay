import "dotenv/config";
import { prisma } from "../src/db";
import { addDays, findAvailableRoomType, getAvailableCheckInDates, startOfDay, toIsoDate } from "../src/core/availability";

async function run(): Promise<void> {
  const hotel =
    (await prisma.hotel.findUnique({ where: { slug: process.env.DEFAULT_HOTEL_SLUG ?? "al-ashkhara-beach-resort" } })) ??
    (await prisma.hotel.findFirst({ orderBy: { createdAt: "asc" } }));
  if (!hotel) {
    throw new Error("No hotel data found for e2e calendar dry-run.");
  }

  const start = addDays(startOfDay(new Date()), 1);
  const checkInChoices = await getAvailableCheckInDates({
    hotelId: hotel.id,
    fromDate: start,
    days: 10,
    guests: 2,
    rooms: 1
  });

  console.log(`Hotel: ${hotel.displayName}`);
  console.log(`Available check-in choices found: ${checkInChoices.length}`);
  if (checkInChoices.length === 0) {
    console.log("No available check-in dates in next 10 days. Dry-run completed.");
    return;
  }

  const checkIn = new Date(checkInChoices[0]);
  const checkOut = addDays(checkIn, 2);
  const offer = await findAvailableRoomType({
    hotelId: hotel.id,
    checkIn,
    checkOut,
    guests: 2,
    rooms: 1
  });

  if (!offer) {
    throw new Error(`Offer expected but not found for ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)}`);
  }

  console.log(
    `Dry-run offer OK: ${offer.roomTypeName} ${toIsoDate(checkIn)} -> ${toIsoDate(checkOut)} total=${offer.total.toFixed(2)} ${hotel.currency}`
  );
}

run()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

