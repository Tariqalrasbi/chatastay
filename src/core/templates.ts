import { QuoteResult } from "./pricing";

export function renderQuoteMessage(quote: QuoteResult): string {
  return [
    "Your stay quote:",
    `- Nights: ${quote.nights}`,
    `- Subtotal: ${quote.subtotal} ${quote.currency}`,
    `- Service fee: ${quote.serviceFee} ${quote.currency}`,
    `- Total: ${quote.total} ${quote.currency}`,
    "",
    "Reply YES to confirm your booking."
  ].join("\n");
}
