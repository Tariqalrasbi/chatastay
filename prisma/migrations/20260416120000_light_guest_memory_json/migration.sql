-- Lightweight structured memory for WhatsApp personalization (non-sensitive aggregates + preferences).
ALTER TABLE "Guest" ADD COLUMN "lightGuestMemoryJson" TEXT;
