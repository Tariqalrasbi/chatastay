type PasswordResetEmailInput = {
  resetLink: string;
  expiresMinutes: number;
};

export function buildPasswordResetEmail(input: PasswordResetEmailInput): { html: string; text: string } {
  const html = [
    "<p>Hello,</p>",
    "<p>We received a request to reset your ChatStay account password.</p>",
    `<p><a href="${escapeHtml(input.resetLink)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Reset Password</a></p>`,
    `<p>If the button does not work, use this secure link:<br /><a href="${escapeHtml(input.resetLink)}">${escapeHtml(input.resetLink)}</a></p>`,
    `<p>This link expires in ${input.expiresMinutes} minutes and can only be used once.</p>`,
    "<p>If you did not request a password reset, you can safely ignore this email.</p>",
    "<p>Regards,<br />ChatStay Team</p>"
  ].join("");

  const text = [
    "Hello,",
    "",
    "We received a request to reset your ChatStay account password.",
    "",
    `Reset your password: ${input.resetLink}`,
    "",
    `This link expires in ${input.expiresMinutes} minutes and can only be used once.`,
    "If you did not request this change, you can safely ignore this email.",
    "",
    "Regards,",
    "ChatStay Team"
  ].join("\n");

  return { html, text };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
