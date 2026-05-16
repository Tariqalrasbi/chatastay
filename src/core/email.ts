import nodemailer from "nodemailer";

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export function isEmailConfigured(): boolean {
  const provider = String(process.env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "resend" && process.env.EMAIL_API_KEY) return true;
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  return Boolean(host && user && pass);
}

/** One-line startup hint; never logs secrets. */
export function logEmailStartupHints(): void {
  if (isEmailConfigured()) {
    const via =
      String(process.env.EMAIL_PROVIDER ?? "")
        .trim()
        .toLowerCase() === "resend" && process.env.EMAIL_API_KEY
        ? "Resend"
        : "SMTP";
    console.log(`[email] Outbound email configured (${via}).`);
    return;
  }
  console.warn(
    "[email] Outbound email NOT configured. Traveller verification codes will not send until SMTP_HOST, SMTP_USER, and SMTP_PASS (or Resend) are set in .env, then the server is restarted."
  );
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error("Email provider not configured. Set EMAIL_PROVIDER/EMAIL_API_KEY (Resend) or SMTP_* env vars.");
  }
  const provider = String(process.env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const from = process.env.EMAIL_FROM || process.env.MAIL_FROM || process.env.ADMIN_EMAIL || "noreply@chatastay.com";
  if (provider === "resend" && process.env.EMAIL_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text
      })
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Resend send failed (${resp.status}): ${body}`);
    }
    return;
  }

  const host = process.env.SMTP_HOST!;
  const user = process.env.SMTP_USER!;
  const pass = process.env.SMTP_PASS!;
  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass }
  });
  await transporter.sendMail({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text
  });
}
