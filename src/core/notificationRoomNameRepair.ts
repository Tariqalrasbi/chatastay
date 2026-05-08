/**
 * One-time data fix: notifications generated before May 2026 referenced
 * `unit.id` (a CUID like "cmofrm57o01qmhnfqs5j6nvn6") in the user-facing
 * body instead of the human-readable room name (e.g. "N3" / "102").
 *
 * The originating bug is fixed at the write site, but historical rows still
 * sit in the in-app feed and the "Attention Needed" strip. This sanitiser
 * runs once at boot, finds those rows, and rewrites the body to use the
 * actual room number. Idempotent: if no rows match the buggy regex, it
 * exits without writing anything.
 */

import type { PrismaClient } from "@prisma/client";

// CUID v1 from cuid() looks like: c + lowercase letters/digits, ~24+ chars.
const CUID_RE = /Room (c[a-z0-9]{20,})/g;

export async function repairRoomCuidNotificationBodies(prisma: PrismaClient): Promise<void> {
  let candidates: { id: string; body: string }[];
  try {
    candidates = await prisma.notification.findMany({
      where: { body: { contains: "Room c" } },
      select: { id: true, body: true }
    });
  } catch {
    // If the table or columns differ in some local schema, do nothing.
    return;
  }

  if (!candidates.length) return;

  const cuidsNeeded = new Set<string>();
  for (const row of candidates) {
    const matches = row.body.matchAll(CUID_RE);
    for (const m of matches) cuidsNeeded.add(m[1]);
  }
  if (!cuidsNeeded.size) return;

  let units: { id: string; name: string }[];
  try {
    units = await prisma.roomUnit.findMany({
      where: { id: { in: Array.from(cuidsNeeded) } },
      select: { id: true, name: true }
    });
  } catch {
    return;
  }
  const nameById = new Map(units.map((u) => [u.id, u.name]));

  let fixed = 0;
  for (const row of candidates) {
    const newBody = row.body.replace(CUID_RE, (whole, cuid: string) => {
      const name = nameById.get(cuid);
      return name ? `Room ${name}` : whole;
    });
    if (newBody !== row.body) {
      try {
        await prisma.notification.update({ where: { id: row.id }, data: { body: newBody } });
        fixed += 1;
      } catch {
        // Skip rows that disappear or fail; this is a best-effort backfill.
      }
    }
  }

  if (fixed > 0) {
    console.log(`[chatastay] Repaired ${fixed} notification(s) that referenced a room ID instead of a room number.`);
  }
}
