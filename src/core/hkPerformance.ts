import {
  HousekeepingAssignmentMode,
  HousekeepingTaskStatus,
  UserRole,
  type Prisma
} from "@prisma/client";
import { prisma } from "../db";

type Db = Prisma.TransactionClient | typeof prisma;

export type HkStaffPerformanceRow = {
  userId: string;
  displayName: string;
  secondaryLabel: string | null;
  assignedCount: number;
  claimedCount: number;
  inProgressCount: number;
  completedCount: number;
  averageCompletionMinutes: number | null;
  completionRate: number | null;
  activeWorkload: number;
  manualAssignedCount: number;
  selfClaimedCount: number;
};

function displayNameForUser(u: { fullName: string; email: string | null; username: string | null }): string {
  return u.fullName?.trim() || u.email?.trim() || u.username?.trim() || "Staff";
}

function secondaryLabelForUser(u: { fullName: string; email: string | null; username: string | null }): string | null {
  const primary = displayNameForUser(u);
  if (u.email && u.email.trim() && primary !== u.email.trim()) return u.email.trim();
  if (u.username && u.username.trim() && primary !== u.username.trim()) return u.username.trim();
  return null;
}

function inDateRange(d: Date, from: Date, to: Date): boolean {
  const t = d.getTime();
  return t >= from.getTime() && t <= to.getTime();
}

function claimTimestampMs(claimedAt: Date | null, createdAt: Date): number {
  return claimedAt?.getTime() ?? createdAt.getTime();
}

type Agg = {
  assignedCount: number;
  claimedCount: number;
  manualAssignedCount: number;
  selfClaimedCount: number;
  completedCount: number;
  durationSum: number;
  durationN: number;
  inProgressCount: number;
  activeWorkload: number;
};

function mk(): Agg {
  return {
    assignedCount: 0,
    claimedCount: 0,
    manualAssignedCount: 0,
    selfClaimedCount: 0,
    completedCount: 0,
    durationSum: 0,
    durationN: 0,
    inProgressCount: 0,
    activeWorkload: 0
  };
}

/**
 * Housekeeping staff metrics from existing task rows (hotel-scoped; optional property via room type).
 * Period metrics use task create/claim/completion timestamps; snapshot metrics use current open tasks.
 */
export async function getHousekeepingStaffPerformance(
  db: Db,
  opts: {
    hotelId: string;
    propertyId?: string | null;
    from: Date;
    to: Date;
    maxPeriodTasks?: number;
  }
): Promise<HkStaffPerformanceRow[]> {
  const { hotelId, from, to } = opts;
  const maxPeriodTasks = opts.maxPeriodTasks ?? 8000;
  const roomScope =
    opts.propertyId && String(opts.propertyId).trim().length > 0
      ? { roomUnit: { roomType: { propertyId: String(opts.propertyId).trim() } } }
      : {};

  const hkUsers = await db.hotelUser.findMany({
    where: { hotelId, isActive: true, role: UserRole.HOUSEKEEPING },
    select: { id: true, fullName: true, email: true, username: true },
    orderBy: { fullName: "asc" }
  });

  const byUser = new Map<string, Agg>();
  const ensure = (uid: string): Agg => {
    let a = byUser.get(uid);
    if (!a) {
      a = mk();
      byUser.set(uid, a);
    }
    return a;
  };

  for (const u of hkUsers) {
    ensure(u.id);
  }

  const [assignedInPeriod, completedInPeriod, openSnapshot] = await Promise.all([
    db.housekeepingTask.findMany({
      where: {
        hotelId,
        ...roomScope,
        assignedToUserId: { not: null },
        OR: [{ createdAt: { gte: from, lte: to } }, { claimedAt: { gte: from, lte: to } }]
      },
      select: {
        id: true,
        assignedToUserId: true,
        assignmentMode: true,
        claimedAt: true,
        createdAt: true
      },
      take: maxPeriodTasks,
      orderBy: { createdAt: "desc" }
    }),
    db.housekeepingTask.findMany({
      where: {
        hotelId,
        ...roomScope,
        status: HousekeepingTaskStatus.COMPLETED,
        completedAt: { gte: from, lte: to },
        completedByUserId: { not: null }
      },
      select: {
        completedByUserId: true,
        startedAt: true,
        completedAt: true
      },
      take: maxPeriodTasks,
      orderBy: { completedAt: "desc" }
    }),
    db.housekeepingTask.findMany({
      where: {
        hotelId,
        ...roomScope,
        status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] },
        assignedToUserId: { not: null }
      },
      select: {
        assignedToUserId: true,
        status: true
      },
      take: 5000,
      orderBy: { updatedAt: "desc" }
    })
  ]);

  const countedAssign = new Set<string>();
  for (const t of assignedInPeriod) {
    const uid = t.assignedToUserId!;
    const createdIn = inDateRange(t.createdAt, from, to);
    const claimedIn = t.claimedAt ? inDateRange(t.claimedAt, from, to) : false;
    if (!createdIn && !claimedIn) continue;
    if (countedAssign.has(t.id)) continue;
    countedAssign.add(t.id);

    const row = ensure(uid);
    row.assignedCount += 1;
    if (t.assignmentMode === HousekeepingAssignmentMode.MANUAL) {
      row.manualAssignedCount += 1;
    }

    const claimMs = claimTimestampMs(t.claimedAt, t.createdAt);
    const claimInWindow = inDateRange(new Date(claimMs), from, to);
    const isSelfClaimed =
      t.assignmentMode === HousekeepingAssignmentMode.SELF_CLAIMED ||
      (t.assignmentMode == null && t.claimedAt != null);
    if (isSelfClaimed && claimInWindow) {
      row.selfClaimedCount += 1;
      row.claimedCount += 1;
    }
  }

  for (const t of completedInPeriod) {
    const uid = t.completedByUserId!;
    if (!byUser.has(uid)) continue;
    const row = ensure(uid);
    row.completedCount += 1;
    if (t.startedAt && t.completedAt) {
      const mins = Math.round((t.completedAt.getTime() - t.startedAt.getTime()) / 60000);
      if (Number.isFinite(mins) && mins >= 0) {
        row.durationSum += mins;
        row.durationN += 1;
      }
    }
  }

  for (const t of openSnapshot) {
    const uid = t.assignedToUserId!;
    if (!byUser.has(uid)) continue;
    const row = ensure(uid);
    row.activeWorkload += 1;
    if (t.status === HousekeepingTaskStatus.IN_PROGRESS) {
      row.inProgressCount += 1;
    }
  }

  return hkUsers.map((u) => {
    const a = ensure(u.id);
    const avgMins = a.durationN > 0 ? Math.round(a.durationSum / a.durationN) : null;
    const completionRate = a.assignedCount > 0 ? Math.min(1, a.completedCount / a.assignedCount) : null;
    return {
      userId: u.id,
      displayName: displayNameForUser(u),
      secondaryLabel: secondaryLabelForUser(u),
      assignedCount: a.assignedCount,
      claimedCount: a.claimedCount,
      inProgressCount: a.inProgressCount,
      completedCount: a.completedCount,
      averageCompletionMinutes: avgMins,
      completionRate,
      activeWorkload: a.activeWorkload,
      manualAssignedCount: a.manualAssignedCount,
      selfClaimedCount: a.selfClaimedCount
    };
  });
}

export { prisma };
