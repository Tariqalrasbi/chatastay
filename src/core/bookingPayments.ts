import Stripe from "stripe";
import { PaymentStatus } from "@prisma/client";
import { prisma } from "../db";

const appBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export type BookingPaymentLinkSource = "guest_mobile_booking" | "admin_booking_link" | "whatsapp_native_booking";

export class BookingPaymentLinkUnavailableError extends Error {
  constructor(message = "Payment links are not configured. Set PAYMENT_PROVIDER and the provider API keys to enable payment links.") {
    super(message);
    this.name = "BookingPaymentLinkUnavailableError";
  }
}

type BookingPaymentProvider = "stripe" | "thawani";

export function getStripeClient(): Stripe | null {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  return apiKey ? new Stripe(apiKey) : null;
}

function getPaymentProvider(): BookingPaymentProvider {
  const configured = (process.env.PAYMENT_PROVIDER ?? "").trim().toLowerCase();
  if (configured === "thawani" || configured === "stripe") return configured;
  if (process.env.THAWANI_API_KEY && process.env.THAWANI_PUBLISHABLE_KEY) return "thawani";
  return "stripe";
}

export function toMinorUnits(amount: number, currency: string): number {
  const zeroDecimal = new Set(["JPY", "KRW"]);
  const threeDecimal = new Set(["BHD", "KWD", "OMR"]);
  const upper = currency.toUpperCase();
  const factor = zeroDecimal.has(upper) ? 1 : threeDecimal.has(upper) ? 1000 : 100;
  return Math.max(1, Math.round(amount * factor));
}

function getThawaniCheckoutBaseUrl(): string {
  const configured = process.env.THAWANI_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const mode = (process.env.THAWANI_MODE ?? process.env.NODE_ENV ?? "").trim().toLowerCase();
  return mode === "live" || mode === "production" ? "https://checkout.thawani.om" : "https://uatcheckout.thawani.om";
}

type ThawaniCreateSessionResponse = {
  data?: {
    session_id?: string;
    payment_status?: string;
  };
  session_id?: string;
  payment_status?: string;
  success?: boolean;
  description?: string;
};

export async function createBookingPaymentLink(params: {
  hotelId: string;
  hotelName: string;
  bookingId: string;
  guestEmail?: string | null;
  amount: number;
  currency: string;
  description: string;
  source: BookingPaymentLinkSource;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{
  paymentIntentId: string;
  provider: string;
  status: PaymentStatus;
  checkoutSessionId: string | null;
  paymentLinkUrl: string | null;
}> {
  const provider = getPaymentProvider();
  if (provider === "thawani") {
    return createThawaniBookingPaymentLink(params);
  }

  const stripe = getStripeClient();
  if (!stripe) {
    throw new BookingPaymentLinkUnavailableError("Stripe is not configured. Set STRIPE_SECRET_KEY to enable Stripe payment links.");
  }

  const chargeAmount = Number(params.amount);
  if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
    throw new Error("A positive payment amount is required.");
  }

  const localPaymentIntent = await prisma.paymentIntent.create({
    data: {
      hotelId: params.hotelId,
      kind: "BOOKING",
      provider: "stripe",
      amount: chargeAmount,
      currency: params.currency,
      status: PaymentStatus.REQUIRES_ACTION,
      bookingId: params.bookingId
    }
  });

  const guestBookingUrl = `${appBaseUrl}/guest?bookingId=${encodeURIComponent(params.bookingId)}`;
  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: params.successUrl ?? guestBookingUrl,
    cancel_url: params.cancelUrl ?? guestBookingUrl,
    client_reference_id: localPaymentIntent.id,
    customer_email: params.guestEmail ?? undefined,
    metadata: {
      paymentIntentId: localPaymentIntent.id,
      bookingId: params.bookingId,
      hotelId: params.hotelId,
      source: params.source
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: params.currency.toLowerCase(),
          unit_amount: toMinorUnits(chargeAmount, params.currency),
          product_data: {
            name: `Booking ${params.bookingId} - ${params.hotelName}`,
            description: params.description
          }
        }
      }
    ],
    payment_intent_data: {
      metadata: {
        paymentIntentId: localPaymentIntent.id,
        bookingId: params.bookingId,
        hotelId: params.hotelId,
        source: params.source
      }
    }
  });

  const paymentIntent = await prisma.paymentIntent.update({
    where: { id: localPaymentIntent.id },
    data: {
      externalIntentId: checkoutSession.id,
      paymentLinkUrl: checkoutSession.url ?? undefined,
      paymentLinkSentAt: new Date(),
      metadataJson: JSON.stringify({
        stripeCheckoutSessionId: checkoutSession.id,
        stripePaymentIntent: checkoutSession.payment_intent,
        source: params.source
      })
    }
  });

  await prisma.booking.update({
    where: { id: params.bookingId },
    data: { paymentStatus: PaymentStatus.REQUIRES_ACTION }
  });

  return {
    paymentIntentId: paymentIntent.id,
    provider: paymentIntent.provider,
    status: paymentIntent.status,
    checkoutSessionId: paymentIntent.externalIntentId,
    paymentLinkUrl: paymentIntent.paymentLinkUrl
  };
}

async function createThawaniBookingPaymentLink(params: {
  hotelId: string;
  hotelName: string;
  bookingId: string;
  guestEmail?: string | null;
  amount: number;
  currency: string;
  description: string;
  source: BookingPaymentLinkSource;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{
  paymentIntentId: string;
  provider: string;
  status: PaymentStatus;
  checkoutSessionId: string | null;
  paymentLinkUrl: string | null;
}> {
  const apiKey = process.env.THAWANI_API_KEY?.trim();
  const publishableKey = process.env.THAWANI_PUBLISHABLE_KEY?.trim();
  if (!apiKey || !publishableKey) {
    throw new BookingPaymentLinkUnavailableError(
      "Thawani is not configured. Set THAWANI_API_KEY and THAWANI_PUBLISHABLE_KEY to enable Oman payment links."
    );
  }
  if (params.currency.toUpperCase() !== "OMR") {
    throw new Error("Thawani payment links require OMR currency.");
  }

  const chargeAmount = Number(params.amount);
  if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
    throw new Error("A positive payment amount is required.");
  }

  const localPaymentIntent = await prisma.paymentIntent.create({
    data: {
      hotelId: params.hotelId,
      kind: "BOOKING",
      provider: "thawani",
      amount: chargeAmount,
      currency: params.currency,
      status: PaymentStatus.REQUIRES_ACTION,
      bookingId: params.bookingId
    }
  });

  const guestBookingUrl = `${appBaseUrl}/guest?bookingId=${encodeURIComponent(params.bookingId)}`;
  const checkoutBase = getThawaniCheckoutBaseUrl();
  const sessionResponse = await fetch(`${checkoutBase}/api/v1/checkout/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "thawani-api-key": apiKey
    },
    body: JSON.stringify({
      client_reference_id: localPaymentIntent.id,
      mode: "payment",
      products: [
        {
          name: `Booking ${params.bookingId} - ${params.hotelName}`.slice(0, 120),
          unit_amount: Math.max(100, toMinorUnits(chargeAmount, params.currency)),
          quantity: 1
        }
      ],
      success_url: params.successUrl ?? guestBookingUrl,
      cancel_url: params.cancelUrl ?? guestBookingUrl,
      metadata: {
        paymentIntentId: localPaymentIntent.id,
        bookingId: params.bookingId,
        hotelId: params.hotelId,
        source: params.source,
        description: params.description
      }
    })
  });

  const payload = (await sessionResponse.json().catch(() => ({}))) as ThawaniCreateSessionResponse;
  if (!sessionResponse.ok) {
    throw new Error(payload.description || `Thawani checkout creation failed with HTTP ${sessionResponse.status}.`);
  }
  const sessionId = payload.data?.session_id ?? payload.session_id;
  if (!sessionId) {
    throw new Error("Thawani checkout creation failed: missing session_id.");
  }

  const paymentLinkUrl = `${checkoutBase}/pay/${encodeURIComponent(sessionId)}?key=${encodeURIComponent(publishableKey)}`;
  const paymentIntent = await prisma.paymentIntent.update({
    where: { id: localPaymentIntent.id },
    data: {
      externalIntentId: sessionId,
      paymentLinkUrl,
      paymentLinkSentAt: new Date(),
      metadataJson: JSON.stringify({
        thawaniSessionId: sessionId,
        thawaniPaymentStatus: payload.data?.payment_status ?? payload.payment_status ?? null,
        source: params.source
      })
    }
  });

  await prisma.booking.update({
    where: { id: params.bookingId },
    data: { paymentStatus: PaymentStatus.REQUIRES_ACTION }
  });

  return {
    paymentIntentId: paymentIntent.id,
    provider: paymentIntent.provider,
    status: paymentIntent.status,
    checkoutSessionId: paymentIntent.externalIntentId,
    paymentLinkUrl: paymentIntent.paymentLinkUrl
  };
}
