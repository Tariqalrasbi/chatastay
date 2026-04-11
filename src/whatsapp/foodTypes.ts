import type { FbServiceMode } from "@prisma/client";

export type FbCartPurpose = "booking_prebook" | "stay" | "meal_plan_view";

export type FbCartStep = "category" | "item" | "qty" | "add_more" | "service" | "time";

export type FbCartLine = { menuItemId: string; name: string; unitPrice: number; qty: number };

export type FbCartDraftState = {
  purpose: FbCartPurpose;
  step: FbCartStep;
  categoryId?: string;
  pendingMenuItemId?: string;
  pendingName?: string;
  pendingUnitPrice?: number;
  cart: FbCartLine[];
  serviceMode?: FbServiceMode;
  timeNote?: string;
  stayBookingId?: string;
};

export type PendingPrebookOrder = {
  lines: Array<{ menuItemId: string; qty: number }>;
  serviceMode: FbServiceMode;
  timeNote: string;
  estimatedTotal: number;
};

export type WhatsAppMealPlanCode = "NONE" | "HALF_BOARD" | "FULL_BOARD";

/** After "View menu" from meal plan, return to meal-plan question. */
export type BookingFlowReturnHint = "meal_plan";
