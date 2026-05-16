type PasswordResetEmailInput = {
  resetLink: string;
  expiresMinutes: number;
};

type TravellerVerificationEmailInput = {
  verifyLink: string;
  fullName?: string | null;
  expiresHours: number;
};

type TravellerVerificationCodeEmailInput = {
  code: string;
  fullName?: string | null;
  expiresMinutes: number;
};

export function buildTravellerVerificationCodeEmail(input: TravellerVerificationCodeEmailInput): {
  html: string;
  text: string;
} {
  const greeting = input.fullName ? `Hello ${escapeHtml(input.fullName)},` : "Hello,";
  const code = escapeHtml(input.code);
  const html = [
    `<p>${greeting}</p>`,
    "<p>Your ChatAstay verification code is:</p>",
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>`,
    `<p>Enter this code on the verification page. It expires in ${input.expiresMinutes} minutes.</p>`,
    "<p>If you did not request this code, you can ignore this email.</p>",
    "<p>Regards,<br />ChatAstay</p>"
  ].join("");
  const text = [
    greeting.replace(/<[^>]+>/g, ""),
    "",
    `Your ChatAstay verification code: ${input.code}`,
    "",
    `This code expires in ${input.expiresMinutes} minutes.`,
    "",
    "Regards,",
    "ChatAstay"
  ].join("\n");
  return { html, text };
}

export function buildTravellerVerificationEmail(input: TravellerVerificationEmailInput): { html: string; text: string } {
  const greeting = input.fullName ? `Hello ${escapeHtml(input.fullName)},` : "Hello,";
  const html = [
    `<p>${greeting}</p>`,
    "<p>Thanks for creating a ChatAstay traveller account. Please verify your email to access My Trips and booking history.</p>",
    `<p><a href="${escapeHtml(input.verifyLink)}" style="display:inline-block;background:#128c7e;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Verify email</a></p>`,
    `<p>If the button does not work, copy this link:<br /><a href="${escapeHtml(input.verifyLink)}">${escapeHtml(input.verifyLink)}</a></p>`,
    `<p>This link expires in ${input.expiresHours} hours.</p>`,
    "<p>If you did not create this account, you can ignore this email.</p>",
    "<p>Regards,<br />ChatAstay</p>"
  ].join("");
  const text = [
    greeting.replace(/<[^>]+>/g, ""),
    "",
    "Verify your ChatAstay traveller account:",
    input.verifyLink,
    "",
    `This link expires in ${input.expiresHours} hours.`,
    "",
    "Regards,",
    "ChatAstay"
  ].join("\n");
  return { html, text };
}

export function buildTravellerPasswordResetEmail(input: PasswordResetEmailInput): { html: string; text: string } {
  const html = [
    "<p>Hello,</p>",
    "<p>We received a request to reset your ChatAstay traveller account password.</p>",
    `<p><a href="${escapeHtml(input.resetLink)}" style="display:inline-block;background:#128c7e;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Reset password</a></p>`,
    `<p>If the button does not work, use this link:<br /><a href="${escapeHtml(input.resetLink)}">${escapeHtml(input.resetLink)}</a></p>`,
    `<p>This link expires in ${input.expiresMinutes} minutes and can only be used once.</p>`,
    "<p>If you did not request this, you can safely ignore this email.</p>",
    "<p>Regards,<br />ChatAstay</p>"
  ].join("");
  const text = [
    "Hello,",
    "",
    "Reset your ChatAstay traveller password:",
    input.resetLink,
    "",
    `This link expires in ${input.expiresMinutes} minutes.`,
    "",
    "Regards,",
    "ChatAstay"
  ].join("\n");
  return { html, text };
}

export function buildPasswordResetEmail(input: PasswordResetEmailInput): { html: string; text: string } {
  const html = [
    "<p>Hello,</p>",
    "<p>We received a request to reset your ChatAstay hotel account password.</p>",
    `<p><a href="${escapeHtml(input.resetLink)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Reset Password</a></p>`,
    `<p>If the button does not work, use this secure link:<br /><a href="${escapeHtml(input.resetLink)}">${escapeHtml(input.resetLink)}</a></p>`,
    `<p>This link expires in ${input.expiresMinutes} minutes and can only be used once.</p>`,
    "<p>If you did not request a password reset, you can safely ignore this email.</p>",
    "<p>Regards,<br />ChatAstay Team</p>"
  ].join("");

  const text = [
    "Hello,",
    "",
    "We received a request to reset your ChatAstay hotel account password.",
    "",
    `Reset your password: ${input.resetLink}`,
    "",
    `This link expires in ${input.expiresMinutes} minutes and can only be used once.`,
    "If you did not request this change, you can safely ignore this email.",
    "",
    "Regards,",
    "ChatAstay Team"
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
