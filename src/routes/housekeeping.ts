import { Router, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HousekeepingTaskStatus, NotificationStatus, type Prisma } from "@prisma/client";
import { prisma } from "../db";

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

  const roomUnits = await prisma.roomUnit.findMany({
    where: { hotelId: session.hotelId, isActive: true },
    orderBy: [{ roomType: { name: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
    include: { roomType: { select: { name: true } } }
  });
  const openTasks = await prisma.housekeepingTask.findMany({
    where: { hotelId: session.hotelId, status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] } },
    include: { assignedTo: { select: { fullName: true } } }
  });
  const taskByRoom = new Map(openTasks.map((t) => [t.roomUnitId, t]));

  const cards = roomUnits
    .map((u) => {
      const task = taskByRoom.get(u.id) ?? null;
      let status = parseStatus(u.notes) ?? "AVAILABLE";
      if (task && status !== "MAINTENANCE") status = "CLEANING";
      const assignedToMe = Boolean(task?.assignedToUserId && task.assignedToUserId === session.staffId);
      const assignedToOther = Boolean(task?.assignedToUserId && task.assignedToUserId !== session.staffId);

      if (view === "mine" && !assignedToMe) return null;
      if (view === "cleaning" && status !== "CLEANING") return null;
      if (view === "available" && status !== "AVAILABLE") return null;
      if (view === "maintenance" && status !== "MAINTENANCE") return null;

      const bg = status === "AVAILABLE" ? "#dcfce7" : status === "MAINTENANCE" ? "#fee2e2" : "#fef9c3";
      const statusLabel = status === "MAINTENANCE" ? "MAINTENANCE" : status === "CLEANING" ? "CLEANING" : "AVAILABLE";
      const assignedLabel = task?.assignedTo ? task.assignedTo.fullName : "Unclaimed";
      const claimDisabled = assignedToOther ? "disabled" : "";
      const lockText = assignedToOther ? `Claimed by ${assignedLabel}` : assignedToMe ? `Claimed by me` : "Unclaimed";
      const taskIdInput = task ? `<input type="hidden" name="taskId" value="${task.id}" />` : "";
      return `<article style="background:${bg};border:1px solid #d1d5db;border-radius:12px;padding:12px;display:grid;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center"><strong>${u.name}</strong><span style="font-size:12px;font-weight:700">${statusLabel}</span></div>
        <div style="font-size:12px;color:#334155">${u.roomType.name}</div>
        <div style="font-size:12px">${lockText}</div>
        <form method="post" action="/hk/room/${encodeURIComponent(u.id)}/claim" style="display:flex;gap:6px;flex-wrap:wrap">
          ${taskIdInput}
          <button type="submit" ${claimDisabled} style="padding:10px;border:1px solid #94a3b8;border-radius:9px;background:#fff;font-weight:600">Claim room</button>
        </form>
        <form method="post" action="/hk/room/${encodeURIComponent(u.id)}/status" style="display:flex;gap:6px;flex-wrap:wrap">
          <input type="hidden" name="taskId" value="${task?.id ?? ""}" />
          <button name="status" value="CLEANING" style="padding:10px;border:0;border-radius:9px;background:#facc15;font-weight:700">Mark Cleaning</button>
          <button name="status" value="AVAILABLE" style="padding:10px;border:0;border-radius:9px;background:#16a34a;color:#fff;font-weight:700">Mark Ready</button>
          <button name="status" value="MAINTENANCE" style="padding:10px;border:0;border-radius:9px;background:#dc2626;color:#fff;font-weight:700">Maintenance</button>
        </form>
      </article>`;
    })
    .filter((x): x is string => Boolean(x))
    .join("");

  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Housekeeping</title></head>
  <body style="font-family:system-ui;background:#f8fafc;margin:0;padding:12px">
    <header style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
      <div><h2 style="margin:0">Housekeeping</h2><div style="font-size:12px;color:#475569">${session.fullName}</div></div>
      <form method="post" action="/hk/logout"><button type="submit" style="padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff">Logout</button></form>
    </header>
    <form method="get" action="/hk" style="margin-bottom:10px">
      <select name="view" onchange="this.form.submit()" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px">
        <option value="all" ${view === "all" ? "selected" : ""}>All rooms</option>
        <option value="mine" ${view === "mine" ? "selected" : ""}>My rooms</option>
        <option value="cleaning" ${view === "cleaning" ? "selected" : ""}>Cleaning</option>
        <option value="available" ${view === "available" ? "selected" : ""}>Available</option>
        <option value="maintenance" ${view === "maintenance" ? "selected" : ""}>Maintenance</option>
      </select>
    </form>
    <section style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px">${cards || `<p style="color:#64748b">No rooms in this filter.</p>`}</section>
  </body></html>`;
  res.type("html").send(html);
});

housekeepingRouter.post("/room/:roomId/claim", requireHousekeepingEdit, async (req, res) => {
  const session = getSession(req)!;
  const roomId = String(req.params.roomId ?? "");
  const taskIdInput = String(req.body.taskId ?? "");
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
          createdByUserId: session.staffId
        }
      });
      taskId = created.id;
    }
  }

  const success = await prisma.$transaction(async (tx) => claimTaskAtomic(tx, taskId, session.hotelId, session.staffId));
  const prevStatus = parseStatus(room.notes);
  if (success) {
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
  }
  res.redirect("/hk");
});

housekeepingRouter.post("/room/:roomId/status", requireHousekeepingEdit, async (req, res) => {
  const session = getSession(req)!;
  const roomId = String(req.params.roomId ?? "");
  const statusRaw = String(req.body.status ?? "").trim().toUpperCase();
  const status: RoomBoardStatus = statusRaw === "MAINTENANCE" ? "MAINTENANCE" : statusRaw === "CLEANING" ? "CLEANING" : "AVAILABLE";
  const taskId = String(req.body.taskId ?? "");
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
  res.redirect("/hk");
});
