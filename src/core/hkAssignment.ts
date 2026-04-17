import {
  HousekeepingAssignmentMode,
  HousekeepingTaskStatus,
  UserRole,
  type Prisma
} from "@prisma/client";

type Db = Prisma.TransactionClient | import("@prisma/client").PrismaClient;

export type HkCleanerScore = {
  id: string;
  fullName: string;
  /** PENDING + IN_PROGRESS tasks currently assigned to this cleaner. */
  activeWorkload: number;
  /** Latest task createdAt where this user was assignee (any status); used for fair rotation. */
  lastAssignmentAtMs: number;
};

/**
 * Deterministic cleaner ranking for auto-assignment: lowest active workload first, then
 * longest idle since last assignment (oldest last assignment wins), then stable id order.
 * No randomness.
 */
export async function rankHousekeepingCleanersForAutoAssign(db: Db, hotelId: string): Promise<HkCleanerScore[]> {
  const cleaners = await db.hotelUser.findMany({
    where: { hotelId, isActive: true, role: UserRole.HOUSEKEEPING },
    select: { id: true, fullName: true },
    orderBy: { id: "asc" }
  });
  const scores: HkCleanerScore[] = [];
  for (const c of cleaners) {
    const activeWorkload = await db.housekeepingTask.count({
      where: {
        hotelId,
        assignedToUserId: c.id,
        status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
      }
    });
    const last = await db.housekeepingTask.aggregate({
      where: { hotelId, assignedToUserId: c.id },
      _max: { createdAt: true }
    });
    const lastAssignmentAtMs = last._max.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    scores.push({ id: c.id, fullName: c.fullName, activeWorkload, lastAssignmentAtMs });
  }
  scores.sort((a, b) => {
    if (a.activeWorkload !== b.activeWorkload) return a.activeWorkload - b.activeWorkload;
    if (a.lastAssignmentAtMs !== b.lastAssignmentAtMs) return a.lastAssignmentAtMs - b.lastAssignmentAtMs;
    return a.id.localeCompare(b.id);
  });
  return scores;
}

export async function pickCleanerForAutoAssign(db: Db, hotelId: string): Promise<{ id: string; fullName: string } | null> {
  const ranked = await rankHousekeepingCleanersForAutoAssign(db, hotelId);
  const top = ranked[0];
  if (!top) return null;
  return { id: top.id, fullName: top.fullName };
}

export function formatHousekeepingAssignmentMode(
  mode: HousekeepingAssignmentMode | null | undefined,
  hasAssignee: boolean
): string {
  if (!hasAssignee) return "Unassigned";
  if (mode === HousekeepingAssignmentMode.AUTO) return "Auto-assigned";
  if (mode === HousekeepingAssignmentMode.MANUAL) return "Manual";
  if (mode === HousekeepingAssignmentMode.SELF_CLAIMED) return "Self-claimed";
  return "Assigned";
}
