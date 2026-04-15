import { Router, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BookingStatus, HousekeepingTaskStatus, NotificationStatus, UserRole, type Prisma } from "@prisma/client";
import { prisma } from "../db";
import { createNotification, createRoleRoutedNotification } from "../core/notifications";

export const housekeepingRouter = Router();

type HkSession = {
  staffId: string;
  hotelId: string;
  fullName: string;
  role: string;
  permissions: {
    VIEW: boolean;
    EDIT: boolean;
    MANAGE: boolean;
  };
};

const hkCookieName = "chatastay_hk_session";
const hkSessions = new Map<string, HkSession>();
const permissionFile = path.join(process.cwd(), "admin-user-permissions.json");

type RoomBoardStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";
type HkShift = "MORNING" | "EVENING" | "NIGHT";
type TaskPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "NORMAL";

function parseStatus(notes: string | null | undefined): RoomBoardStatus | null {
  if (!notes) return null;
  const m = notes.match(/@manual-status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)@/i);
  return (m?.[1]?.toUpperCase() as RoomBoardStatus | undefined) ?? null;
}

function writeStatus(notes: string | null | undefined, status: RoomBoardStatus): string {
  const base = (notes ?? "").replace(/\s*@manual-status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)@\s*/gi, " ").trim();
  const token = `@manual-status:${status}@`;
  return base ? `${base} ${token}` : token;
}

function parseShift(notes: string | null | undefined): HkShift | null {
  if (!notes) return null;
  const m = notes.match(/@hk-shift:(MORNING|EVENING|NIGHT)@/i);
  return (m?.[1]?.toUpperCase() as HkShift | undefined) ?? null;
}

function writeShift(notes: string | null | undefined, shift: HkShift): string {
  const base = (notes ?? "").replace(/\s*@hk-shift:(MORNING|EVENING|NIGHT)@\s*/gi, " ").trim();
  const token = `@hk-shift:${shift}@`;
  return base ? `${base} ${token}` : token;
}

function deriveShift(now = new Date()): HkShift {
  const hour = now.getHours();
  if (hour >= 6 && hour < 14) return "MORNING";
  if (hour >= 14 && hour < 22) return "EVENING";
  return "NIGHT";
}

function parseShiftInput(input: unknown): HkShift {
  const v = String(input ?? "").trim().toUpperCase();
  if (v === "MORNING" || v === "EVENING" || v === "NIGHT") return v;
  return deriveShift();
}

function durationMinutes(start: Date | null | undefined, end: Date | null | undefined): number | null {
  if (!start || !end) return null;
  const diff = end.getTime() - start.getTime();
  if (!Number.isFinite(diff) || diff < 0) return null;
  return Math.round(diff / 60000);
}

function formatMinutes(mins: number | null): string {
  if (mins === null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  return raw.split(";").reduce<Record<string, string>>((acc, part) => {
    const [k, ...v] = part.trim().split("=");
    if (!k) return acc;
    acc[k] = decodeURIComponent(v.join("=") ?? "");
    return acc;
  }, {});
}

function verifySecret(input: string, hash: string | null | undefined): boolean {
  if (!hash) return false;
  const [salt, stored] = hash.split(":");
  if (!salt || !stored) return false;
  const derived = crypto.scryptSync(input, salt, 64).toString("hex");
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(derived, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getSession(req: Request): HkSession | undefined {
  const token = parseCookies(req)[hkCookieName];
  if (!token) return undefined;
  return hkSessions.get(token);
}

function readStore(): Record<string, unknown> {
  try {
    if (!fs.existsSync(permissionFile)) return {};
    return JSON.parse(fs.readFileSync(permissionFile, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hkPermForUser(role: string, email: string | null | undefined): HkSession["permissions"] {
  if (role === "MANAGER") return { VIEW: true, EDIT: true, MANAGE: true };
  const store = readStore();
  const e = (email ?? "").toLowerCase();
  const row = e ? (store[e] as Record<string, unknown> | undefined) : undefined;
  const hk = (row?.HOUSEKEEPING as Record<string, unknown> | undefined) ?? {};
  const rooms = (row?.ROOMS as Record<string, unknown> | undefined) ?? {};
  const view = hk.VIEW === true || hk.MANAGE === true || rooms.EDIT === true || role === "HOUSEKEEPING";
  const edit = hk.EDIT === true || hk.MANAGE === true || rooms.EDIT === true || role === "HOUSEKEEPING";
  const manage = hk.MANAGE === true || rooms.MANAGE === true || role === "MANAGER";
  return { VIEW: view, EDIT: edit, MANAGE: manage };
}

function requireHousekeepingView(req: Request, res: Response, next: NextFunction): void {
  const s = getSession(req);
  if (!s) {
    res.redirect("/hk/login");
    return;
  }
  if (!s.permissions.VIEW) {
    res.status(403).type("html").send("<h2>Access denied</h2><p>HOUSEKEEPING_VIEW required.</p>");
    return;
  }
  next();
}

function requireHousekeepingEdit(req: Request, res: Response, next: NextFunction): void {
  const s = getSession(req);
  if (!s) {
    res.redirect("/hk/login");
    return;
  }
  if (!s.permissions.EDIT) {
    res.status(403).type("html").send("<h2>Access denied</h2><p>HOUSEKEEPING_EDIT required.</p>");
    return;
  }
  next();
}

async function logAudit(params: {
  hotelId: string;
  staffId: string;
  action: string;
  roomId?: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  claimedByUserId?: string | null;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      hotelId: params.hotelId,
      actorUserId: params.staffId,
      action: params.action,
      entityType: "RoomUnit",
      entityId: params.roomId,
      metadataJson: JSON.stringify({
        previousStatus: params.previousStatus ?? undefined,
        newStatus: params.newStatus ?? undefined,
        claimedByUserId: params.claimedByUserId ?? undefined
      })
    }
  });
}

async function claimTaskAtomic(tx: Prisma.TransactionClient, taskId: string, hotelId: string, staffId: string): Promise<boolean> {
  const result = await tx.housekeepingTask.updateMany({
    where: {
      id: taskId,
      hotelId,
      status: HousekeepingTaskStatus.PENDING,
      assignedToUserId: null
    },
    data: {
      status: HousekeepingTaskStatus.IN_PROGRESS,
      assignedToUserId: staffId,
      startedAt: new Date()
    }
  });
  return result.count > 0;
}

function computeTaskPriority(params: {
  bookingCheckIn?: Date | null;
  bookingGuestVip?: boolean;
}): TaskPriority {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  if (!params.bookingCheckIn) return "NORMAL";
  const checkInDay = new Date(params.bookingCheckIn.getFullYear(), params.bookingCheckIn.getMonth(), params.bookingCheckIn.getDate());
  const dayDiff = Math.round((checkInDay.getTime() - startToday.getTime()) / dayMs);
  const earlyWindow = now.getHours() < 15;
  if (params.bookingGuestVip && dayDiff <= 0) return "CRITICAL";
  if (dayDiff === 0 && earlyWindow) return "HIGH";
  if (params.bookingGuestVip && dayDiff === 1) return "HIGH";
  if (dayDiff === 0 || dayDiff === 1) return "MEDIUM";
  return "NORMAL";
}

housekeepingRouter.get("/login", (_req, res) => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Housekeeping Login</title></head>
  <body style="font-family:system-ui;background:#f8fafc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
    <form method="post" action="/hk/login" style="width:min(420px,92vw);background:#fff;border:1px solid #dbeafe;padding:20px;border-radius:14px">
      <h2 style="margin:0 0 6px">Housekeeping Sign In</h2>
      <p style="margin:0 0 14px;color:#475569;font-size:14px">Login using staff ID, username, or email + PIN.</p>
      <label style="display:block;margin-bottom:10px">Staff ID / Username / Email<br/><input name="identifier" required style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px" /></label>
      <label style="display:block;margin-bottom:14px">PIN<br/><input name="pin" type="password" minlength="4" maxlength="32" required style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px" /></label>
      <button type="submit" style="width:100%;padding:11px;border:0;border-radius:10px;background:#0f766e;color:#fff;font-weight:700">Login</button>
    </form>
  </body></html>`;
  res.type("html").send(html);
});

housekeepingRouter.post("/login", async (req, res) => {
  const identifier = String(req.body.identifier ?? "").trim();
  const pin = String(req.body.pin ?? "").trim();
  const hotel = await prisma.hotel.findFirst({ where: { slug: "al-ashkhara-beach-resort" }, select: { id: true } });
  if (!hotel || !identifier || pin.length < 4) {
    res.redirect("/hk/login");
    return;
  }
  const idLower = identifier.toLowerCase();
  const user = await prisma.hotelUser.findFirst({
    where: {
      hotelId: hotel.id,
      isActive: true,
      OR: [{ id: identifier }, { username: idLower }, { email: idLower }]
    }
  });
  if (!user) {
    res.redirect("/hk/login");
    return;
  }
  const pinOk = verifySecret(pin, user.pinHash) || verifySecret(pin, user.passwordHash);
  if (!pinOk) {
    res.redirect("/hk/login");
    return;
  }
  const perms = hkPermForUser(String(user.role), user.email);
  if (!perms.VIEW) {
    res.redirect("/hk/login");
    return;
  }
  const token = crypto.randomUUID();
  hkSessions.set(token, {
    staffId: user.id,
    hotelId: user.hotelId,
    fullName: user.fullName,
    role: String(user.role),
    permissions: perms
  });
  res.setHeader("Set-Cookie", `${hkCookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`);
  res.redirect("/hk");
});

housekeepingRouter.post("/logout", (req, res) => {
  const token = parseCookies(req)[hkCookieName];
  if (token) hkSessions.delete(token);
  res.setHeader("Set-Cookie", `${hkCookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.redirect("/hk/login");
});

housekeepingRouter.get("/", requireHousekeepingView, async (req, res) => {
  const session = getSession(req)!;
  const viewRaw = String(req.query.view ?? "all").toLowerCase();
  const view = ["all", "mine", "cleaning", "available", "maintenance"].includes(viewRaw) ? viewRaw : "all";
  const shiftFilterRaw = String(req.query.shift ?? "all").trim().toUpperCase();
  const shiftFilter = shiftFilterRaw === "MORNING" || shiftFilterRaw === "EVENING" || shiftFilterRaw === "NIGHT" ? shiftFilterRaw : "all";
  const priorityFilterRaw = String(req.query.priority ?? "all").trim().toUpperCase();
  const priorityFilter =
    priorityFilterRaw === "CRITICAL" || priorityFilterRaw === "HIGH" || priorityFilterRaw === "MEDIUM" || priorityFilterRaw === "NORMAL"
      ? priorityFilterRaw
      : "all";

  const roomUnits = await prisma.roomUnit.findMany({
    where: { hotelId: session.hotelId, isActive: true },
    orderBy: [{ roomType: { name: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
    include: { roomType: { select: { name: true } } }
  });
  const openTasks = await prisma.housekeepingTask.findMany({
    where: { hotelId: session.hotelId, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
    include: {
      assignedTo: { select: { fullName: true } },
      booking: { select: { checkIn: true, guest: { select: { isVip: true } } } }
    }
  });
  const taskByRoom = new Map(openTasks.map((t) => [t.roomUnitId, t]));
  const roomIds = roomUnits.map((r) => r.id);
  const upcoming = await prisma.booking.findMany({
    where: {
      hotelId: session.hotelId,
      roomUnitId: { in: roomIds },
      status: BookingStatus.CONFIRMED,
      checkIn: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) }
    },
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
    select: { roomUnitId: true, checkIn: true, guest: { select: { isVip: true } } }
  });
  const upcomingByRoom = new Map<string, (typeof upcoming)[number]>();
  for (const b of upcoming) {
    if (!b.roomUnitId) continue;
    if (!upcomingByRoom.has(b.roomUnitId)) upcomingByRoom.set(b.roomUnitId, b);
  }

  const cards = roomUnits
    .map((u) => {
      const task = taskByRoom.get(u.id) ?? null;
      let status = parseStatus(u.notes) ?? "AVAILABLE";
      if (task && status !== "MAINTENANCE") status = "CLEANING";
      const assignedToMe = Boolean(task?.assignedToUserId && task.assignedToUserId === session.staffId);
      const assignedToOther = Boolean(task?.assignedToUserId && task.assignedToUserId !== session.staffId);
      const shift = parseShift(task?.notes) ?? (task ? deriveShift(task.startedAt ?? task.createdAt) : deriveShift());
      const bookingHint = task?.booking ?? upcomingByRoom.get(u.id);
      const priority = computeTaskPriority({
        bookingCheckIn: bookingHint?.checkIn,
        bookingGuestVip: bookingHint?.guest?.isVip === true
      });
      const elapsed = task?.startedAt ? formatMinutes(durationMinutes(task.startedAt, new Date())) : "—";

      if (view === "mine" && !assignedToMe) return null;
      if (view === "cleaning" && status !== "CLEANING") return null;
      if (view === "available" && status !== "AVAILABLE") return null;
      if (view === "maintenance" && status !== "MAINTENANCE") return null;
      if (shiftFilter !== "all" && shift !== shiftFilter) return null;
      if (priorityFilter !== "all" && priority !== priorityFilter) return null;

      const bg = status === "AVAILABLE" ? "#dcfce7" : status === "MAINTENANCE" ? "#fee2e2" : "#fef9c3";
      const statusLabel = status === "MAINTENANCE" ? "MAINTENANCE" : status === "CLEANING" ? "CLEANING" : "AVAILABLE";
      const assignedLabel = task?.assignedTo ? task.assignedTo.fullName : "Unclaimed";
      const claimDisabled = assignedToOther ? "disabled" : "";
      const lockText = assignedToOther ? `Claimed by ${assignedLabel}` : assignedToMe ? `Claimed by me` : "Unclaimed";
      const taskIdInput = task ? `<input type="hidden" name="taskId" value="${task.id}" />` : "";
      const priorityBg = priority === "CRITICAL" ? "#b91c1c" : priority === "HIGH" ? "#dc2626" : priority === "MEDIUM" ? "#ca8a04" : "#475569";
      return `<article style="background:${bg};border:1px solid #d1d5db;border-radius:12px;padding:12px;display:grid;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px"><strong>${u.name}</strong><span style="font-size:12px;font-weight:700">${statusLabel}</span></div>
        <div style="font-size:12px;color:#334155">${u.roomType.name}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span style="font-size:11px;background:${priorityBg};color:#fff;border-radius:999px;padding:3px 8px;font-weight:700">${priority}</span>
          <span style="font-size:11px;background:#e2e8f0;color:#0f172a;border-radius:999px;padding:3px 8px;font-weight:700">${shift}</span>
        </div>
        <div style="font-size:12px">${lockText}</div>
        <div style="font-size:12px;color:#475569">Elapsed: ${elapsed}</div>
        <form method="post" action="/hk/room/${encodeURIComponent(u.id)}/claim" style="display:flex;gap:6px;flex-wrap:wrap">
          ${taskIdInput}
          <select name="shift" style="padding:8px;border:1px solid #94a3b8;border-radius:8px">
            <option value="MORNING" ${shift === "MORNING" ? "selected" : ""}>Morning</option>
            <option value="EVENING" ${shift === "EVENING" ? "selected" : ""}>Evening</option>
            <option value="NIGHT" ${shift === "NIGHT" ? "selected" : ""}>Night</option>
          </select>
          <button type="submit" ${claimDisabled} style="padding:10px;border:1px solid #94a3b8;border-radius:9px;background:#fff;font-weight:600">Claim room</button>
        </form>
        <form method="post" action="/hk/room/${encodeURIComponent(u.id)}/status" style="display:flex;gap:6px;flex-wrap:wrap">
          <input type="hidden" name="taskId" value="${task?.id ?? ""}" />
          <input type="hidden" name="shift" value="${shift}" />
          <button name="status" value="CLEANING" style="padding:10px;border:0;border-radius:9px;background:#facc15;font-weight:700">Mark Cleaning</button>
          <button name="status" value="AVAILABLE" style="padding:10px;border:0;border-radius:9px;background:#16a34a;color:#fff;font-weight:700">Mark Ready</button>
          <button name="status" value="MAINTENANCE" style="padding:10px;border:0;border-radius:9px;background:#dc2626;color:#fff;font-weight:700">Maintenance</button>
        </form>
      </article>`;
    })
    .filter((x): x is string => Boolean(x))
    .join("");
  const completedToday = await prisma.housekeepingTask.findMany({
    where: {
      hotelId: session.hotelId,
      status: HousekeepingTaskStatus.COMPLETED,
      completedAt: {
        gte: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
      }
    },
    include: { completedBy: { select: { fullName: true } } },
    take: 200
  });
  const durations = completedToday.map((t) => durationMinutes(t.startedAt, t.completedAt)).filter((x): x is number => x !== null);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const inProgress = openTasks.filter((t) => t.status === HousekeepingTaskStatus.IN_PROGRESS).length;

  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Housekeeping</title></head>
  <body style="font-family:system-ui;background:#f8fafc;margin:0;padding:12px">
    <header style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
      <div><h2 style="margin:0">Housekeeping</h2><div style="font-size:12px;color:#475569">${session.fullName}</div></div>
      <form method="post" action="/hk/logout"><button type="submit" style="padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff">Logout</button></form>
    </header>
    <form method="get" action="/hk" style="margin-bottom:10px">
      <div style="display:grid;gap:8px">
      <select name="view" onchange="this.form.submit()" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px">
        <option value="all" ${view === "all" ? "selected" : ""}>All rooms</option>
        <option value="mine" ${view === "mine" ? "selected" : ""}>My rooms</option>
        <option value="cleaning" ${view === "cleaning" ? "selected" : ""}>Cleaning</option>
        <option value="available" ${view === "available" ? "selected" : ""}>Available</option>
        <option value="maintenance" ${view === "maintenance" ? "selected" : ""}>Maintenance</option>
      </select>
      <select name="shift" onchange="this.form.submit()" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px">
        <option value="all" ${shiftFilter === "all" ? "selected" : ""}>All shifts</option>
        <option value="MORNING" ${shiftFilter === "MORNING" ? "selected" : ""}>Morning</option>
        <option value="EVENING" ${shiftFilter === "EVENING" ? "selected" : ""}>Evening</option>
        <option value="NIGHT" ${shiftFilter === "NIGHT" ? "selected" : ""}>Night</option>
      </select>
      <select name="priority" onchange="this.form.submit()" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px">
        <option value="all" ${priorityFilter === "all" ? "selected" : ""}>All priorities</option>
        <option value="CRITICAL" ${priorityFilter === "CRITICAL" ? "selected" : ""}>Critical</option>
        <option value="HIGH" ${priorityFilter === "HIGH" ? "selected" : ""}>High</option>
        <option value="MEDIUM" ${priorityFilter === "MEDIUM" ? "selected" : ""}>Medium</option>
        <option value="NORMAL" ${priorityFilter === "NORMAL" ? "selected" : ""}>Normal</option>
      </select>
      </div>
    </form>
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:10px">
      <article style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px"><div style="font-size:12px;color:#475569">Open tasks</div><strong>${openTasks.length}</strong></article>
      <article style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px"><div style="font-size:12px;color:#475569">In progress</div><strong>${inProgress}</strong></article>
      <article style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px"><div style="font-size:12px;color:#475569">Completed today</div><strong>${completedToday.length}</strong></article>
      <article style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px"><div style="font-size:12px;color:#475569">Avg clean time</div><strong>${formatMinutes(avg)}</strong></article>
    </section>
    <section style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px">${cards || `<p style="color:#64748b">No rooms in this filter.</p>`}</section>
  </body></html>`;
  res.type("html").send(html);
});

housekeepingRouter.post("/room/:roomId/claim", requireHousekeepingEdit, async (req, res) => {
  const session = getSession(req)!;
  const roomId = String(req.params.roomId ?? "");
  const taskIdInput = String(req.body.taskId ?? "");
  const shift = parseShiftInput(req.body.shift);
  const room = await prisma.roomUnit.findFirst({ where: { id: roomId, hotelId: session.hotelId }, select: { id: true, notes: true } });
  if (!room) {
    res.redirect("/hk");
    return;
  }

  let taskId = taskIdInput;
  if (!taskId) {
    const existing = await prisma.housekeepingTask.findFirst({
      where: {
        hotelId: session.hotelId,
        roomUnitId: roomId,
        status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
      },
      select: { id: true }
    });
    if (existing) taskId = existing.id;
    else {
      const created = await prisma.housekeepingTask.create({
        data: {
          hotelId: session.hotelId,
          roomUnitId: roomId,
          source: "MANUAL",
          status: HousekeepingTaskStatus.PENDING,
          createdByUserId: session.staffId,
          notes: writeShift(null, shift)
        }
      });
      taskId = created.id;
    }
  }

  const success = await prisma.$transaction(async (tx) => claimTaskAtomic(tx, taskId, session.hotelId, session.staffId));
  const prevStatus = parseStatus(room.notes);
  if (success) {
    await prisma.housekeepingTask.update({
      where: { id: taskId },
      data: { notes: writeShift((await prisma.housekeepingTask.findUnique({ where: { id: taskId }, select: { notes: true } }))?.notes, shift) }
    });
    await prisma.roomUnit.update({ where: { id: roomId }, data: { notes: writeStatus(room.notes, "CLEANING") } });
    await logAudit({
      hotelId: session.hotelId,
      staffId: session.staffId,
      action: "HK_STATUS_UPDATE",
      roomId,
      previousStatus: prevStatus,
      newStatus: "CLEANING",
      claimedByUserId: session.staffId
    });
    await createNotification({
      hotelId: session.hotelId,
      userId: session.staffId,
      title: "Task assigned to you",
      body: `Room ${roomId} is now assigned to your cleaning queue.`,
      category: "housekeeping",
      severity: "high",
      link: "/hk",
      sourceType: "HK_STATUS_UPDATE",
      sourceId: roomId,
      requiresAttention: true
    }).catch(() => undefined);
  }
  res.redirect("/hk");
});

housekeepingRouter.post("/room/:roomId/status", requireHousekeepingEdit, async (req, res) => {
  const session = getSession(req)!;
  const roomId = String(req.params.roomId ?? "");
  const statusRaw = String(req.body.status ?? "").trim().toUpperCase();
  const status: RoomBoardStatus = statusRaw === "MAINTENANCE" ? "MAINTENANCE" : statusRaw === "CLEANING" ? "CLEANING" : "AVAILABLE";
  const taskId = String(req.body.taskId ?? "");
  const shift = parseShiftInput(req.body.shift);
  const room = await prisma.roomUnit.findFirst({ where: { id: roomId, hotelId: session.hotelId }, select: { id: true, notes: true } });
  if (!room) {
    res.redirect("/hk");
    return;
  }
  const previousStatus = parseStatus(room.notes);

  await prisma.$transaction(async (tx) => {
    await tx.roomUnit.update({ where: { id: roomId }, data: { notes: writeStatus(room.notes, status) } });
    if (status === "CLEANING") {
      if (taskId) await claimTaskAtomic(tx, taskId, session.hotelId, session.staffId);
      else {
        const existing = await tx.housekeepingTask.findFirst({
          where: { hotelId: session.hotelId, roomUnitId: roomId, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
          select: { id: true }
        });
        if (existing) await claimTaskAtomic(tx, existing.id, session.hotelId, session.staffId);
      }
      const targetId = taskId
        || (await tx.housekeepingTask.findFirst({
          where: { hotelId: session.hotelId, roomUnitId: roomId, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
          select: { id: true }
        }))?.id;
      if (targetId) {
        const current = await tx.housekeepingTask.findUnique({ where: { id: targetId }, select: { notes: true } });
        await tx.housekeepingTask.update({ where: { id: targetId }, data: { notes: writeShift(current?.notes, shift) } });
      }
    } else {
      await tx.housekeepingTask.updateMany({
        where: { hotelId: session.hotelId, roomUnitId: roomId, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
        data: {
          status: HousekeepingTaskStatus.COMPLETED,
          completedAt: new Date(),
          completedByUserId: session.staffId
        }
      });
    }
  });

  await prisma.notification.updateMany({
    where: { hotelId: session.hotelId, hotelUserId: session.staffId, readAt: null, type: { startsWith: "HK_" } },
    data: { readAt: new Date(), status: NotificationStatus.READ }
  });
  await logAudit({
    hotelId: session.hotelId,
    staffId: session.staffId,
    action: "HK_STATUS_UPDATE",
    roomId,
    previousStatus,
    newStatus: status,
    claimedByUserId: status === "CLEANING" ? session.staffId : null
  });
  if (status === "MAINTENANCE") {
    await createRoleRoutedNotification({
      hotelId: session.hotelId,
      roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.OWNER],
      title: "Room flagged for maintenance",
      body: `Room ${roomId} was marked maintenance by housekeeping.`,
      category: "rooms",
      severity: "high",
      link: "/admin/room-board",
      sourceType: "HK_STATUS_UPDATE",
      sourceId: roomId,
      requiresAttention: true
    }).catch(() => undefined);
  }
  res.redirect("/hk");
});
