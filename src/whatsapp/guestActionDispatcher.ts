import { UserRole } from "@prisma/client";
import { createRoleRoutedNotification } from "../core/notifications";
import { prisma } from "../db";
import type { LightGuestMemory } from "../core/lightGuestMemory";
import type { GuestJourneyOperationalReply } from "./preArrivalGuestReplyNotify";
import type { OrchestratedGuestJourneyOutbound } from "./guestMessageOrchestration";

type IntentCategory = NonNullable<GuestJourneyOperationalReply["category"]>;

type ActionPlan = {
  key: string;
  title: string;
  body: string;
  roles: UserRole[];
  category: "messages" | "payments" | "support" | "bookings" | "housekeeping";
  severity: "critical" | "high" | "normal";
};

function shouldTriggerUpsellAction(reply: GuestJourneyOperationalReply): boolean {
  return Boolean(reply.upsellType) && reply.guestResponse === "accepted";
}

function baseGuestLabel(params: { guestName?: string | null; guestPhone: string; referenceCode?: string | null }): string {
  const nameOrPhone = params.guestName?.trim() || params.guestPhone;
  const ref = params.referenceCode?.trim();
  return ref ? `${nameOrPhone} (${ref})` : nameOrPhone;
}

function actionPlansFromIntent(params: {
  intent: IntentCategory;
  guestLabel: string;
  rawMessage: string;
  upsell: GuestJourneyOperationalReply;
}): ActionPlan[] {
  const snippet = params.rawMessage.trim().slice(0, 260);
  const plans: ActionPlan[] = [];
  if (params.intent === "late_arrival") {
    plans.push({
      key: "late_arrival_frontdesk",
      title: "Late arrival update",
      body: `${params.guestLabel} reported late arrival. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
      category: "messages",
      severity: "high"
    });
  }
  if (params.intent === "on_the_way") {
    plans.push({
      key: "on_the_way_prep",
      title: "Guest on the way",
      body: `${params.guestLabel} is on the way. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.STAFF],
      category: "messages",
      severity: "normal"
    });
  }
  if (params.intent === "early_checkin_request") {
    plans.push({
      key: "early_checkin_task",
      title: "Early check-in request",
      body: `${params.guestLabel} requested early check-in. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
      category: "bookings",
      severity: "high"
    });
  }
  if (params.intent === "late_checkout_request") {
    plans.push({
      key: "late_checkout_task",
      title: "Late check-out request",
      body: `${params.guestLabel} requested late check-out. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.HOUSEKEEPING, UserRole.MANAGER, UserRole.STAFF],
      category: "housekeeping",
      severity: "high"
    });
  }
  if (params.intent === "special_request") {
    plans.push({
      key: "special_request_ops",
      title: "Special request received",
      body: `${params.guestLabel} sent a special request. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.HOUSEKEEPING, UserRole.MANAGER, UserRole.STAFF],
      category: "messages",
      severity: "high"
    });
  }
  if (params.intent === "booking_modification") {
    plans.push({
      key: "booking_modification_task",
      title: "Booking modification request",
      body: `${params.guestLabel} requested booking modification. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
      category: "bookings",
      severity: "high"
    });
  }
  if (params.intent === "cancellation_request") {
    plans.push({
      key: "cancellation_task",
      title: "Cancellation request",
      body: `${params.guestLabel} requested cancellation. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
      category: "bookings",
      severity: "high"
    });
  }
  if (params.intent === "payment_issue") {
    plans.push({
      key: "payment_issue_finance",
      title: "Payment issue needs review",
      body: `${params.guestLabel} reported payment issue. Message: ${snippet}`,
      roles: [UserRole.FINANCE, UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
      category: "payments",
      severity: "critical"
    });
  }
  if (params.intent === "refund_request") {
    plans.push({
      key: "refund_request_finance",
      title: "Refund request received",
      body: `${params.guestLabel} requested refund. Message: ${snippet}`,
      roles: [UserRole.FINANCE, UserRole.MANAGER, UserRole.STAFF],
      category: "payments",
      severity: "critical"
    });
  }
  if (params.intent === "complaint") {
    plans.push({
      key: "complaint_alert",
      title: "Guest complaint alert",
      body: `${params.guestLabel} submitted complaint. Message: ${snippet}`,
      roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
      category: "support",
      severity: "critical"
    });
  }
  if (params.intent === "escalation") {
    plans.push({
      key: "escalation_alert",
      title: "Guest escalation alert",
      body: `${params.guestLabel} escalated issue. Message: ${snippet}`,
      roles: [UserRole.MANAGER, UserRole.FRONTDESK, UserRole.STAFF],
      category: "support",
      severity: "critical"
    });
  }

  if (shouldTriggerUpsellAction(params.upsell)) {
    if (params.upsell.upsellType === "upgrade_interest") {
      plans.push({
        key: "upgrade_interest_reservations",
        title: "Upgrade interest accepted",
        body: `${params.guestLabel} accepted upgrade interest. Message: ${snippet}`,
        roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
        category: "bookings",
        severity: "high"
      });
    } else if (params.upsell.upsellType === "add_on_interest") {
      plans.push({
        key: "addon_interest_ops",
        title: "Add-on interest accepted",
        body: `${params.guestLabel} accepted add-on interest. Message: ${snippet}`,
        roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
        category: "messages",
        severity: "normal"
      });
    } else if (params.upsell.upsellType === "activities_interest") {
      plans.push({
        key: "activities_interest_concierge",
        title: "Activity interest accepted",
        body: `${params.guestLabel} requested activities. Message: ${snippet}`,
        roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF],
        category: "messages",
        severity: "normal"
      });
    }
  }

  return plans;
}

export async function dispatchGuestJourneyIntentActions(params: {
  hotelId: string;
  propertyId?: string;
  conversationId: string;
  guestId: string;
  guestName?: string | null;
  guestPhone: string;
  bookingId?: string;
  referenceCode?: string | null;
  prismaMessageId: string;
  rawMessage: string;
  journeyReply: GuestJourneyOperationalReply;
  orchestrated: OrchestratedGuestJourneyOutbound;
  memory: LightGuestMemory;
}): Promise<void> {
  if (!params.journeyReply.category) return;
  const intent = params.journeyReply.category;
  const guestLabel = baseGuestLabel({
    guestName: params.guestName,
    guestPhone: params.guestPhone,
    referenceCode: params.referenceCode
  });
  const plans = actionPlansFromIntent({
    intent,
    guestLabel,
    rawMessage: params.rawMessage,
    upsell: params.journeyReply
  });
  if (!plans.length) return;

  for (const plan of plans) {
    const actionEntityId = `${params.prismaMessageId}:${plan.key}`;
    const existing = await prisma.auditLog.findFirst({
      where: {
        hotelId: params.hotelId,
        action: "GUEST_INTENT_ACTION_TASK",
        entityType: "INBOUND_MESSAGE",
        entityId: actionEntityId
      },
      select: { id: true }
    });
    if (existing) continue;

    await createRoleRoutedNotification({
      hotelId: params.hotelId,
      propertyId: params.propertyId,
      roles: plan.roles,
      title: plan.title,
      body: plan.body,
      category: plan.category,
      severity: plan.severity,
      link: `/admin/conversations/${encodeURIComponent(params.conversationId)}`,
      sourceType: "GUEST_INTENT_ACTION_TASK",
      sourceId: actionEntityId,
      requiresAttention: true
    });

    await prisma.auditLog.create({
      data: {
        hotelId: params.hotelId,
        propertyId: params.propertyId ?? null,
        action: "GUEST_INTENT_ACTION_TASK",
        entityType: "INBOUND_MESSAGE",
        entityId: actionEntityId,
        bookingId: params.bookingId ?? null,
        metadataJson: JSON.stringify({
          intent,
          role: params.orchestrated.meta.role,
          priority: params.orchestrated.meta.priority,
          invokedHandler: params.orchestrated.meta.invokedHandler,
          actionKey: plan.key,
          actionTitle: plan.title,
          conversationId: params.conversationId,
          guestId: params.guestId,
          propertyId: params.propertyId ?? null,
          referenceCode: params.referenceCode ?? null,
          prismaMessageId: params.prismaMessageId,
          rawMessage: params.rawMessage,
          memory: {
            repeatGuest: params.memory.repeatGuest ?? null,
            spendingLevel: params.memory.spendingLevel ?? null,
            preferredRoomTypeName: params.memory.preferredRoomTypeName ?? null
          },
          createdAt: new Date().toISOString()
        })
      }
    });
  }
}
