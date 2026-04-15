import nodemailer from "nodemailer";

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export async function sendEmail(input: SendEmailInput): Promise<void> {
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

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error("Email provider not configured. Set EMAIL_PROVIDER/EMAIL_API_KEY (Resend) or SMTP_* env vars.");
  }
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
