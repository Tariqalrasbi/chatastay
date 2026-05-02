import Stripe from "stripe";
import { PaymentStatus } from "@prisma/client";
import { prisma } from "../db";

const appBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export type BookingPaymentLinkSource = "guest_mobile_booking" | "admin_booking_link" | "whatsapp_native_booking";

export class BookingPaymentLinkUnavailableError extends Error {
  constructor(message = "Stripe is not configured. Set STRIPE_SECRET_KEY to enable payment links.") {
    super(message);
    this.name = "BookingPaymentLinkUnavailableError";
  }
}

export function getStripeClient(): Stripe | null {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  return apiKey ? new Stripe(apiKey) : null;
}

export function toMinorUnits(amount: number, currency: string): number {
  const zeroDecimal = new Set(["JPY", "KRW"]);
  const threeDecimal = new Set(["BHD", "KWD", "OMR"]);
  const upper = currency.toUpperCase();
  const factor = zeroDecimal.has(upper) ? 1 : threeDecimal.has(upper) ? 1000 : 100;
  return Math.max(1, Math.round(amount * factor));
}

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
  const stripe = getStripeClient();
  if (!stripe) {
    throw new BookingPaymentLinkUnavailableError();
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
