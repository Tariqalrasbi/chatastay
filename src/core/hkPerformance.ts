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
  /** Average minutes from startedAt to completedAt when both exist; excludes invalid durations. */
  averageCompletionMinutes: number | null;
  /** Same value as averageCompletionMinutes (operational shorthand). */
  avgCompletionMinutes: number | null;
  completionRate: number | null;
  activeWorkload: number;
  manualAssignedCount: number;
  selfClaimedCount: number;
  /** 0–100 from completionRate when assignedCount > 0; else null. */
  reliabilityScore: number | null;
  /** 0–100 min-max vs other staff with valid averages in this result set; lower avg minutes = higher score; single valid user = 100. */
  speedScore: number | null;
  /** 0–100 min-max of (completedCount + activeWorkload) among staff with any contribution in this result set; single eligible = 100. */
  workloadBalanceScore: number | null;
  /** Weighted blend of available sub-scores (reliability 0.5, speed 0.3, workload 0.2), reweighted if some are null. */
  kpiScore: number | null;
  /** Order position in this filtered dataset (1 = highest KPI among comparable rows). */
  rank: number;
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

function clampInt0to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Min–max on the current array only; null inputs stay null. "Lower is better" (e.g. minutes). */
function normalizeLowerIsBetter(values: (number | null)[]): (number | null)[] {
  const eligible = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (eligible.length === 0) return values.map(() => null);
  const min = Math.min(...eligible);
  const max = Math.max(...eligible);
  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    if (max === min) return 100;
    return clampInt0to100(((max - v) / (max - min)) * 100);
  });
}

/** Min–max on the current array only; null inputs stay null. "Higher is better". */
function normalizeHigherIsBetter(values: (number | null)[]): (number | null)[] {
  const eligible = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (eligible.length === 0) return values.map(() => null);
  const min = Math.min(...eligible);
  const max = Math.max(...eligible);
  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    if (max === min) return 100;
    return clampInt0to100(((v - min) / (max - min)) * 100);
  });
}

type HkStaffPerfBase = Omit<
  HkStaffPerformanceRow,
  | "avgCompletionMinutes"
  | "reliabilityScore"
  | "speedScore"
  | "workloadBalanceScore"
  | "kpiScore"
  | "rank"
>;

function applyRankAndKpis(rows: HkStaffPerfBase[]): HkStaffPerformanceRow[] {
  if (rows.length === 0) return [];

  const avgMinsList = rows.map((r) => r.averageCompletionMinutes);
  const speedScores = normalizeLowerIsBetter(avgMinsList);

  const workloadRaw = rows.map((r) =>
    r.completedCount === 0 && r.activeWorkload === 0 ? null : r.completedCount + r.activeWorkload
  );
  const workloadScores = normalizeHigherIsBetter(workloadRaw);

  const withScores: HkStaffPerformanceRow[] = rows.map((r, i) => {
    const avgCompletionMinutes = r.averageCompletionMinutes;
    const reliabilityScore =
      r.assignedCount > 0 && r.completionRate != null && Number.isFinite(r.completionRate)
        ? clampInt0to100(r.completionRate * 100)
        : null;
    return {
      ...r,
      avgCompletionMinutes,
      reliabilityScore,
      speedScore: speedScores[i] ?? null,
      workloadBalanceScore: workloadScores[i] ?? null,
      kpiScore: null,
      rank: 0
    };
  });

  for (let i = 0; i < withScores.length; i++) {
    const r = withScores[i];
    const parts: { w: number; s: number }[] = [];
    if (r.reliabilityScore != null) parts.push({ w: 0.5, s: r.reliabilityScore });
    if (r.speedScore != null) parts.push({ w: 0.3, s: r.speedScore });
    if (r.workloadBalanceScore != null) parts.push({ w: 0.2, s: r.workloadBalanceScore });
    if (parts.length === 0) {
      r.kpiScore = null;
    } else {
      const sumW = parts.reduce((a, p) => a + p.w, 0);
      const blended = parts.reduce((a, p) => a + p.s * p.w, 0) / sumW;
      r.kpiScore = clampInt0to100(blended);
    }
  }

  const order = withScores
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => {
      const ak = a.r.kpiScore;
      const bk = b.r.kpiScore;
      if (ak != null && bk != null && ak !== bk) return bk - ak;
      if (ak != null && bk == null) return -1;
      if (ak == null && bk != null) return 1;
      const cc = b.r.completedCount - a.r.completedCount;
      if (cc !== 0) return cc;
      const wl = b.r.activeWorkload - a.r.activeWorkload;
      if (wl !== 0) return wl;
      return a.r.displayName.localeCompare(b.r.displayName, undefined, { sensitivity: "base" });
    });

  order.forEach((o, pos) => {
    o.r.rank = pos + 1;
  });

  return withScores;
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

  const baseRows: HkStaffPerfBase[] = hkUsers.map((u) => {
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

  return applyRankAndKpis(baseRows);
}

export { prisma };
