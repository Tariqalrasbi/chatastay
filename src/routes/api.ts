import { Router } from "express";
import Stripe from "stripe";
import { BookingStatus, FolioPostingTarget, FolioTxnSourceType, PaymentStatus } from "@prisma/client";
import { prisma } from "../db";
import { recordBookingStatusChange } from "../core/bookingStatusHistory";
import { ensureActiveFolio, postPaymentToFolio } from "../core/folioService";
import { handleIncomingWhatsAppMessage } from "../whatsapp/conversationController";
import { buildBookingInvoicePdf } from "../core/invoicePdf";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { sendWhatsAppDocument } from "../whatsapp/send";

export const apiRouter = Router();
const defaultHotelSlug = "al-ashkhara-beach-resort";
const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

function formatDate(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function getStripeClient(): Stripe | null {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) return null;
  return new Stripe(apiKey);
}

async function upsertPaymentTransaction(params: {
  hotelId: string;
  paymentIntentId: string;
  externalTxnId?: string | null;
  amount: number;
  currency: string;
  status: Stripe.PaymentIntent.Status | "succeeded" | "failed" | "requires_action";
  providerPayload?: string;
}): Promise<void> {
  if (!params.externalTxnId) return;

  const existing = await prisma.paymentTransaction.findFirst({
    where: {
      paymentIntentId: params.paymentIntentId,
      externalTxnId: params.externalTxnId
    }
  });
  if (existing) return;

  const mappedStatus =
    params.status === "succeeded"
      ? "SUCCEEDED"
      : params.status === "failed"
        ? "FAILED"
        : "REQUIRES_ACTION";

  await prisma.paymentTransaction.create({
    data: {
      hotelId: params.hotelId,
      paymentIntentId: params.paymentIntentId,
      externalTxnId: params.externalTxnId,
      amount: params.amount,
      currency: params.currency,
      status: mappedStatus,
      providerPayload: params.providerPayload
    }
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function applyPaymentStatus(
  localPaymentIntentId: string,
  status: "SUCCEEDED" | "FAILED",
  externalTxnId?: string,
  providerPayload?: string
): Promise<void> {
  const paymentIntent = await prisma.paymentIntent.findUnique({
    where: { id: localPaymentIntentId },
    include: {
      hotel: true,
      booking: {
        include: {
          guest: true,
          roomType: true,
          property: true
        }
      }
    }
  });
  if (!paymentIntent) return;

  if (status === "SUCCEEDED" && paymentIntent.status === PaymentStatus.SUCCEEDED) {
    return;
  }

  const wasSucceeded = paymentIntent.status === PaymentStatus.SUCCEEDED;

  const nextPiStatus = status === "SUCCEEDED" ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED;

  await prisma.paymentIntent.update({
    where: { id: paymentIntent.id },
    data: {
      status: nextPiStatus,
      metadataJson: providerPayload ?? paymentIntent.metadataJson ?? undefined
    }
  });

  if (paymentIntent.bookingId && paymentIntent.booking) {
    const booking = paymentIntent.booking;
    const prevBookingStatus = booking.status;
    const paid = round2(paymentIntent.amount);
    const totalDue = round2(booking.totalAmount);
    const fullySettled = paid >= totalDue - 0.01;

    const nextBookingPayment: PaymentStatus =
      status === "FAILED"
        ? PaymentStatus.FAILED
        : fullySettled
          ? PaymentStatus.SUCCEEDED
          : PaymentStatus.PENDING;

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        paymentStatus: nextBookingPayment,
        ...(status === "SUCCEEDED" && prevBookingStatus !== BookingStatus.CONFIRMED
          ? { status: BookingStatus.CONFIRMED }
          : {})
      }
    });

    if (status === "SUCCEEDED" && prevBookingStatus !== BookingStatus.CONFIRMED) {
      await recordBookingStatusChange(prisma, {
        hotelId: paymentIntent.hotelId,
        bookingId: booking.id,
        fromStatus: prevBookingStatus,
        toStatus: BookingStatus.CONFIRMED,
        source: "STRIPE_WEBHOOK"
      });
    }
  }

  await upsertPaymentTransaction({
    hotelId: paymentIntent.hotelId,
    paymentIntentId: paymentIntent.id,
    externalTxnId,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    status: status === "SUCCEEDED" ? "succeeded" : "failed",
    providerPayload
  });

  if (!wasSucceeded && status === "SUCCEEDED" && paymentIntent.bookingId && paymentIntent.booking) {
    const booking = paymentIntent.booking;

    try {
      await ensureActiveFolio(prisma, {
        hotelId: paymentIntent.hotelId,
        bookingId: booking.id,
        guestId: booking.guestId,
        roomUnitId: booking.roomUnitId,
        currency: booking.currency,
        staffId: null
      });
      await postPaymentToFolio(prisma, {
        hotelId: paymentIntent.hotelId,
        bookingId: booking.id,
        guestId: booking.guestId,
        roomUnitId: booking.roomUnitId,
        roomTypeId: booking.roomTypeId,
        currency: paymentIntent.currency,
        amount: round2(paymentIntent.amount),
        folioPaymentMethod: "Stripe / card (Checkout)",
        postingTarget: FolioPostingTarget.GUEST_FOLIO,
        chargeDate: new Date(),
        referenceNumber: externalTxnId ?? paymentIntent.externalIntentId ?? null,
        notes: `Stripe Checkout · local PaymentIntent ${paymentIntent.id}`,
        sourceType: FolioTxnSourceType.API,
        allocateFifo: true,
        staffId: null
      });
    } catch (err) {
      console.error(
        "[stripe webhook] folio payment post failed:",
        err instanceof Error ? err.message : String(err)
      );
    }

    let invoiceId = paymentIntent.invoiceId ?? null;
    if (!invoiceId) {
      const invoice = await prisma.invoice.create({
        data: {
          hotelId: paymentIntent.hotelId,
          amountSubtotal: paymentIntent.amount,
          amountTax: 0,
          amountTotal: paymentIntent.amount,
          currency: paymentIntent.currency,
          status: "PAID",
          paidAt: new Date()
        }
      });
      invoiceId = invoice.id;
      await prisma.paymentIntent.update({
        where: { id: paymentIntent.id },
        data: { invoiceId }
      });
    }

    const invoicePdf = await buildBookingInvoicePdf({
      documentKind: "receipt",
      invoiceNumber: `RCP-${booking.id}`,
      issuedAt: new Date(),
      hotelName: paymentIntent.hotel.displayName,
      hotelCity: paymentIntent.hotel.city,
      hotelCountry: paymentIntent.hotel.country,
      guestName: booking.guest.fullName ?? "Guest",
      guestPhone: booking.guest.phoneE164,
      bookingId: booking.id,
      bookingStatus: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      roomType: booking.roomType.name,
      selectedUnit: null,
      propertyName: booking.property.name,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      nights: booking.nights,
      adults: booking.adults,
      children: booking.children,
      totalAmount: paymentIntent.amount,
      currency: paymentIntent.currency
    });

    const toPhone = booking.guest.phoneE164.replace(/\D/g, "");
    if (toPhone) {
      const config = loadPartnerSetupConfig(paymentIntent.hotelId);
      await sendWhatsAppDocument({
        to: toPhone,
        filename: `${booking.id}-receipt-${formatDate(new Date())}.pdf`,
        body: invoicePdf,
        caption: `${paymentIntent.hotel.displayName}: receipt for booking ${booking.id}. Payment received: ${paymentIntent.amount.toFixed(2)} ${paymentIntent.currency}.`,
        phoneNumberId: config.whatsappPhoneNumberId || undefined,
        conversationId: booking.conversationId ?? undefined
      });
    }
  }
}

function toMinorUnits(amount: number, currency: string): number {
  const zeroDecimal = new Set(["JPY", "KRW"]);
  const threeDecimal = new Set(["BHD", "KWD", "OMR"]);
  const upper = currency.toUpperCase();
  const factor = zeroDecimal.has(upper) ? 1 : threeDecimal.has(upper) ? 1000 : 100;
  return Math.round(amount * factor);
}

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "chatastay-api" });
});

apiRouter.post("/whatsapp/simulate", async (req, res) => {
  const from = String(req.body.from ?? "").trim();
  const text = String(req.body.text ?? "").trim();
  const inboundPhoneNumberId =
    typeof req.body.inboundPhoneNumberId === "string" && req.body.inboundPhoneNumberId.trim()
      ? req.body.inboundPhoneNumberId.trim()
      : undefined;
  if (!from || !text) {
    res.status(400).json({ error: "from and text are required" });
    return;
  }
  try {
    await handleIncomingWhatsAppMessage({
      from,
      text,
      messageId: `sim-${Date.now()}`,
      inboundPhoneNumberId
    });
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

apiRouter.get("/hotel", async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } });
  res.json({ hotel });
});

apiRouter.get("/rooms", async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: defaultHotelSlug },
    include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
  });

  if (!hotel) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }

  res.json({
    hotelId: hotel.id,
    rooms: hotel.roomTypes.map((room) => ({
      id: room.id,
      code: room.code,
      name: room.name,
      basePrice: room.baseNightlyRate,
      inventory: room.totalInventory,
      currency: hotel.currency
    }))
  });
});

apiRouter.get("/plans", async (_req, res) => {
  const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { monthlyPrice: "asc" } });
  res.json({
    plans
  });
});

apiRouter.get("/subscription", async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: defaultHotelSlug },
    include: {
      subscriptions: {
        where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        orderBy: { createdAt: "desc" },
        include: { plan: true },
        take: 1
      },
      properties: true,
      roomTypes: true,
      conversations: {
        where: { createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } }
      }
    }
  });

  if (!hotel) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }

  const sub = hotel.subscriptions[0];
  res.json({
    hotelId: hotel.id,
    planCode: sub?.plan.code ?? null,
    status: sub?.status ?? null,
    monthlyPrice: sub?.plan.monthlyPrice ?? null,
    currency: hotel.currency,
    renewalDate: sub?.currentPeriodEnd?.toISOString().slice(0, 10) ?? null,
    usage: {
      properties: { used: hotel.properties.length, limit: sub?.plan.maxProperties ?? null },
      roomTypes: { used: hotel.roomTypes.length, limit: sub?.plan.maxRoomTypes ?? null },
      monthlyConversations: {
        used: hotel.conversations.length,
        limit: sub?.plan.maxMonthlyConversations ?? null
      }
    }
  });
});

apiRouter.get("/billing/overview", async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: defaultHotelSlug },
    include: {
      invoices: { orderBy: { createdAt: "desc" }, take: 10 },
      paymentIntents: { orderBy: { createdAt: "desc" }, take: 10 }
    }
  });

  if (!hotel) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }

  res.json({
    paymentProvider: "stripe",
    currency: hotel.currency,
    invoices: hotel.invoices.map((invoice) => ({
      id: invoice.id,
      amount: invoice.amountTotal,
      status: invoice.status,
      issuedAt: invoice.createdAt.toISOString().slice(0, 10)
    })),
    bookingPayments: hotel.paymentIntents
      .filter((payment) => payment.kind === "BOOKING")
      .map((payment) => ({
        paymentIntentId: payment.id,
        amount: payment.amount,
        status: payment.status,
        bookingId: payment.bookingId
      }))
  });
});

apiRouter.get("/integrations", async (_req, res) => {
  const hotel = await prisma.hotel.findUnique({
    where: { slug: defaultHotelSlug },
    include: { integrations: { include: { mappings: true }, orderBy: { provider: "asc" } } }
  });

  if (!hotel) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }

  res.json({
    hotelId: hotel.id,
    providers: hotel.integrations.map((connection) => ({
      provider: connection.provider,
      connected: connection.status === "connected",
      mappedRooms: connection.mappings.length,
      lastSyncAt: connection.lastSyncedAt
    }))
  });
});

apiRouter.post("/payments/create-booking-link", async (req, res) => {
  const bookingId = String(req.body.bookingId ?? "");
  const amount = Number(req.body.amount ?? 0);

  if (!bookingId || !Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "bookingId and positive amount are required" });
    return;
  }

  const hotel = await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } });
  if (!hotel) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, hotelId: hotel.id },
    include: { guest: true }
  });

  if (!booking) {
    res.status(404).json({ error: "Booking not found for this hotel" });
    return;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    res.status(500).json({
      error: "Stripe is not configured. Set STRIPE_SECRET_KEY to enable payment links."
    });
    return;
  }

  try {
    const chargeAmount = amount > 0 ? amount : booking.totalAmount;
    const localPaymentIntent = await prisma.paymentIntent.create({
      data: {
        hotelId: hotel.id,
        kind: "BOOKING",
        provider: "stripe",
        amount: chargeAmount,
        currency: hotel.currency,
        status: "REQUIRES_ACTION",
        bookingId: booking.id
      }
    });

    const successUrl =
      process.env.STRIPE_CHECKOUT_SUCCESS_URL ??
      `${appBaseUrl}/admin/billing?payment=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = process.env.STRIPE_CHECKOUT_CANCEL_URL ?? `${appBaseUrl}/admin/billing?payment=cancel`;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: localPaymentIntent.id,
      customer_email: booking.guest.email ?? undefined,
      metadata: {
        paymentIntentId: localPaymentIntent.id,
        bookingId: booking.id,
        hotelId: hotel.id
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: hotel.currency.toLowerCase(),
            unit_amount: toMinorUnits(chargeAmount, hotel.currency),
            product_data: {
              name: `Booking ${booking.id} - ${hotel.displayName}`,
              description: `${booking.checkIn.toISOString().slice(0, 10)} to ${booking.checkOut
                .toISOString()
                .slice(0, 10)}`
            }
          }
        }
      ],
      payment_intent_data: {
        metadata: {
          paymentIntentId: localPaymentIntent.id,
          bookingId: booking.id,
          hotelId: hotel.id
        }
      }
    });

    const paymentIntent = await prisma.paymentIntent.update({
      where: { id: localPaymentIntent.id },
      data: {
        externalIntentId: checkoutSession.id,
        paymentLinkUrl: checkoutSession.url ?? undefined,
        metadataJson: JSON.stringify({
          stripeCheckoutSessionId: checkoutSession.id,
          stripePaymentIntent: checkoutSession.payment_intent
        })
      }
    });

    res.status(201).json({
      paymentIntentId: paymentIntent.id,
      provider: paymentIntent.provider,
      status: paymentIntent.status,
      checkoutSessionId: paymentIntent.externalIntentId,
      paymentLinkUrl: paymentIntent.paymentLinkUrl
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe checkout creation failed";
    res.status(502).json({ error: message });
  }
});

apiRouter.post("/payments/webhook/stripe", async (req, res) => {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    res.status(500).json({ error: "Stripe webhook is not configured." });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature || typeof signature !== "string") {
    res.status(400).json({ error: "Missing Stripe signature header." });
    return;
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const localPaymentIntentId =
        session.client_reference_id ?? session.metadata?.paymentIntentId ?? undefined;
      if (localPaymentIntentId) {
        await applyPaymentStatus(
          localPaymentIntentId,
          "SUCCEEDED",
          typeof session.payment_intent === "string" ? session.payment_intent : session.id,
          JSON.stringify(session)
        );
      }
    } else if (event.type === "checkout.session.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      const localPaymentIntentId =
        session.client_reference_id ?? session.metadata?.paymentIntentId ?? undefined;
      if (localPaymentIntentId) {
        const pi = await prisma.paymentIntent.findUnique({ where: { id: localPaymentIntentId } });
        if (pi && pi.status !== PaymentStatus.SUCCEEDED) {
          let merged: Record<string, unknown> = {};
          try {
            merged = pi.metadataJson ? (JSON.parse(pi.metadataJson) as Record<string, unknown>) : {};
          } catch {
            merged = {};
          }
          merged.checkoutSessionExpired = true;
          merged.expiredAt = new Date().toISOString();
          await prisma.paymentIntent.update({
            where: { id: pi.id },
            data: {
              status: PaymentStatus.PENDING,
              metadataJson: JSON.stringify(merged)
            }
          });
        }
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const failedIntent = event.data.object as Stripe.PaymentIntent;
      const localPaymentIntentId = failedIntent.metadata?.paymentIntentId;
      if (localPaymentIntentId) {
        await applyPaymentStatus(
          localPaymentIntentId,
          "FAILED",
          failedIntent.id,
          JSON.stringify(failedIntent)
        );
      }
    }

    res.json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Stripe webhook payload.";
    res.status(400).json({ error: message });
  }
});
