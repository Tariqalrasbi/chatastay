import { NotificationStatus, UserRole } from "@prisma/client";
import { prisma } from "../db";

export type NotificationCategory = "bookings" | "messages" | "housekeeping" | "rooms" | "payments" | "system" | "support";
export type NotificationSeverity = "critical" | "high" | "normal" | "info";

type CreateNotificationInput = {
  hotelId: string;
  propertyId?: string;
  userId?: string;
  role?: UserRole;
  title: string;
  body: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  link?: string;
  sourceType?: string;
  sourceId?: string;
  requiresAttention?: boolean;
};

type ListNotificationsOptions = {
  limit?: number;
  unreadOnly?: boolean;
};

type RoleRoutingInput = Omit<CreateNotificationInput, "userId" | "role"> & {
  roles?: UserRole[];
  userIds?: string[];
};

type NotificationPayload = {
  category: NotificationCategory;
  severity: NotificationSeverity;
  propertyId?: string;
  link?: string;
  sourceType?: string;
  sourceId?: string;
  requiresAttention: boolean;
};

function parsePayload(raw: string | null): NotificationPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.category || !parsed.severity) return null;
    return {
      category: parsed.category,
      severity: parsed.severity,
      link: parsed.link,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      requiresAttention: parsed.requiresAttention === true
    };
  } catch {
    return null;
  }
}

function buildPayload(input: CreateNotificationInput): NotificationPayload {
  return {
    category: input.category,
    severity: input.severity,
    propertyId: input.propertyId,
    link: input.link,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    requiresAttention: input.requiresAttention ?? (input.severity === "critical" || input.severity === "high")
  };
}

export async function createNotification(input: CreateNotificationInput): Promise<void> {
  if (!input.userId && !input.role) return;
  const payload = buildPayload(input);

  if (input.userId) {
    await prisma.notification.create({
      data: {
        hotelId: input.hotelId,
        propertyId: input.propertyId,
        hotelUserId: input.userId,
        type: `OPS_${input.category.toUpperCase()}`,
        title: input.title,
        body: input.body,
        payloadJson: JSON.stringify(payload),
        status: NotificationStatus.PENDING
      }
    });
    return;
  }

  const users = await prisma.hotelUser.findMany({
    where: { hotelId: input.hotelId, role: input.role, isActive: true },
    select: { id: true }
  });
  if (!users.length) return;
  await prisma.notification.createMany({
    data: users.map((user) => ({
      hotelId: input.hotelId,
      propertyId: input.propertyId,
      hotelUserId: user.id,
      type: `OPS_${input.category.toUpperCase()}`,
      title: input.title,
      body: input.body,
      payloadJson: JSON.stringify(payload),
      status: NotificationStatus.PENDING
    }))
  });
}

export async function createRoleRoutedNotification(input: RoleRoutingInput): Promise<void> {
  const userIds = new Set<string>(input.userIds ?? []);
  if (input.roles?.length) {
    const users = await prisma.hotelUser.findMany({
      where: { hotelId: input.hotelId, role: { in: input.roles }, isActive: true },
      select: { id: true }
    });
    for (const user of users) userIds.add(user.id);
  }
  if (!userIds.size) return;

  const payload = buildPayload(input);
  await prisma.notification.createMany({
    data: Array.from(userIds).map((userId) => ({
      hotelId: input.hotelId,
      propertyId: input.propertyId,
      hotelUserId: userId,
      type: `OPS_${input.category.toUpperCase()}`,
      title: input.title,
      body: input.body,
      payloadJson: JSON.stringify(payload),
      status: NotificationStatus.PENDING
    }))
  });
}

export async function listUserNotifications(userId: string, opts: ListNotificationsOptions = {}) {
  const rows = await prisma.notification.findMany({
    where: { hotelUserId: userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(opts.limit ?? 20, 100))
  });

  return rows.map((row) => {
    const payload = parsePayload(row.payloadJson);
    return {
      id: row.id,
      title: row.title ?? row.type,
      body: row.body,
      type: row.type,
      category: payload?.category ?? "system",
      severity: payload?.severity ?? "info",
      link: payload?.link,
      sourceType: payload?.sourceType,
      sourceId: payload?.sourceId,
      requiresAttention: payload?.requiresAttention ?? false,
      readAt: row.readAt,
      createdAt: row.createdAt
    };
  });
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { hotelUserId: userId, readAt: null }
  });
}

export async function markNotificationRead(notificationId: string, userId: string): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, hotelUserId: userId, readAt: null },
    data: { readAt: new Date(), status: NotificationStatus.READ }
  });
  return result.count > 0;
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { hotelUserId: userId, readAt: null },
    data: { readAt: new Date(), status: NotificationStatus.READ }
  });
  return result.count;
}
