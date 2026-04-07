import PDFDocument from "pdfkit";

export type GuestDocumentKind = "invoice" | "quotation" | "receipt";

type InvoicePdfInput = {
  /** Invoice (folio), quotation (proposed charges), or receipt (payment acknowledgement). */
  documentKind?: GuestDocumentKind;
  invoiceNumber: string;
  issuedAt: Date;
  hotelName: string;
  hotelCity?: string | null;
  hotelCountry?: string | null;
  guestName: string;
  guestPhone: string;
  bookingId: string;
  bookingStatus: string;
  paymentStatus: string;
  roomType: string;
  selectedUnit?: string | null;
  propertyName: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  adults: number;
  children: number;
  /** Accommodation / room charges only (booking total) */
  totalAmount: number;
  currency: string;
  /** Optional F&B folio lines posted to the same guest account */
  fbLines?: Array<{ description: string; quantity: number; unitPrice: number; lineTotal: number }>;
  fbSubtotal?: number;
  /** Accommodation + F&B; defaults to totalAmount when no F&B */
  grandTotal?: number;
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

export async function buildBookingInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const kind: GuestDocumentKind = input.documentKind ?? "invoice";
  const doc = new PDFDocument({ margin: 44, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const row = (label: string, value: string): void => {
    doc.font("Helvetica-Bold").fontSize(11).text(`${label}:`, { continued: true });
    doc.font("Helvetica").fontSize(11).text(` ${value}`);
  };

  const kindTitle =
    kind === "quotation"
      ? "Quotation"
      : kind === "receipt"
        ? "Receipt"
        : "Invoice";
  const refLabel = kind === "quotation" ? "Quotation #" : kind === "receipt" ? "Receipt #" : "Invoice #";

  doc.font("Helvetica-Bold").fontSize(20).text(input.hotelName, { align: "left" });
  doc.moveDown(0.25);
  doc.font("Helvetica-Bold").fontSize(14).text(kindTitle, { align: "left" });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(10).text(`${refLabel} ${input.invoiceNumber}`);
  doc.text(`Issued: ${formatDate(input.issuedAt)}`);
  doc.moveDown(0.35);
  const locationLine = [input.hotelCity, input.hotelCountry].filter(Boolean).join(", ");
  if (locationLine) {
    doc.font("Helvetica").fontSize(10).text(locationLine);
    doc.moveDown(0.5);
  } else {
    doc.moveDown(0.35);
  }

  doc.font("Helvetica-Bold").fontSize(12).text("Guest Details");
  row("Guest", input.guestName);
  row("Phone", input.guestPhone);
  doc.moveDown(0.7);

  doc.font("Helvetica-Bold").fontSize(12).text("Booking Details");
  row("Booking ID", input.bookingId);
  row("Property", input.propertyName);
  row("Room Type", input.roomType);
  row("Room Unit", input.selectedUnit ?? "Not assigned");
  row("Stay", `${formatDate(input.checkIn)} to ${formatDate(input.checkOut)} (${input.nights} nights)`);
  row("Occupancy", `${input.adults} adults, ${input.children} children`);
  row("Booking Status", input.bookingStatus);
  row("Payment Status", input.paymentStatus);
  row("Accommodation total", `${formatMoney(input.totalAmount, input.currency)} (${input.currency})`);
  doc.moveDown(0.5);

  const fbSub = input.fbSubtotal ?? 0;
  const hasFb = (input.fbLines?.length ?? 0) > 0 && fbSub > 0;
  if (hasFb && input.fbLines) {
    doc.font("Helvetica-Bold").fontSize(12).text("Food & beverage (restaurant / coffee shop)");
    doc.font("Helvetica").fontSize(9);
    for (const ln of input.fbLines) {
      doc.text(
        `• ${ln.description}  ×${ln.quantity} @ ${formatMoney(ln.unitPrice, input.currency)} = ${formatMoney(ln.lineTotal, input.currency)}`,
        { indent: 8 }
      );
    }
    doc.font("Helvetica-Bold").fontSize(11).text(`F&B subtotal: ${formatMoney(fbSub, input.currency)}`, { indent: 8 });
    doc.moveDown(0.4);
  }

  const grand = input.grandTotal ?? (hasFb ? Number((input.totalAmount + fbSub).toFixed(2)) : input.totalAmount);
  const totalLabel =
    kind === "quotation"
      ? "Quoted total (proposed)"
      : kind === "receipt"
        ? "Total (this receipt)"
        : "Amount due (total folio)";
  doc.font("Helvetica-Bold").fontSize(13).text(`${totalLabel}: ${formatMoney(grand, input.currency)} (${input.currency})`);
  doc.moveDown(0.8);

  const noteTitle = "Important information";
  const noteBody =
    kind === "quotation"
      ? "This quotation is for planning purposes. Final charges and availability are confirmed by the hotel when you complete your booking."
      : kind === "receipt"
        ? "This receipt reflects payment and folio details at the time of issue. If anything changes, the hotel may send an updated document."
        : "This document reflects accommodation charges and any posted food & beverage orders on the guest folio at the time of issue. " +
          "If payment status or charges change, the hotel may send an updated copy.";
  doc.font("Helvetica-Bold").fontSize(12).text(noteTitle);
  doc.font("Helvetica").fontSize(10).fillColor("#000").text(noteBody, { align: "left" });

  doc.moveDown(1);
  doc.font("Helvetica").fontSize(9).fillColor("#444").text(`Issued by ${input.hotelName}.`);
  doc.font("Helvetica").fontSize(8).fillColor("#666").text("Document prepared using ChatAstay.");

  return await new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
