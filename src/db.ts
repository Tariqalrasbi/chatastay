import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";

declare global {
  // eslint-disable-next-line no-var
  var __chatastayPrisma__: PrismaClient | undefined;
}

export const prisma =
  global.__chatastayPrisma__ ??
  new PrismaClient({
    datasources: {
      db: { url: databaseUrl }
    }
  });

if (process.env.NODE_ENV !== "production") {
  global.__chatastayPrisma__ = prisma;
}
