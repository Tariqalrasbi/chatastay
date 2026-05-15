/**
 * CRM-facing WhatsApp / email copy for partner acquisition and related surfaces.
 * Single source for partner outreach bodies so admin routes stay thin.
 */

export const PARTNER_LEAD_OUTREACH_TEMPLATE_KEYS = [
  "initial_intro",
  "followup_1",
  "followup_2",
  "demo_reminder",
  "proposal_followup",
  "onboarding_checklist"
] as const;

export type PartnerLeadOutreachTemplateKey = (typeof PARTNER_LEAD_OUTREACH_TEMPLATE_KEYS)[number];

export const PARTNER_LEAD_OUTREACH_TEMPLATE_OPTIONS: Array<{ value: PartnerLeadOutreachTemplateKey; label: string }> = [
  { value: "initial_intro", label: "Introduction" },
  { value: "followup_1", label: "Follow-up — demo" },
  { value: "followup_2", label: "Follow-up — soft close" },
  { value: "demo_reminder", label: "Demo reminder" },
  { value: "proposal_followup", label: "Proposal follow-up" },
  { value: "onboarding_checklist", label: "Onboarding checklist" }
];

export function isPartnerLeadOutreachTemplateKey(raw: string): raw is PartnerLeadOutreachTemplateKey {
  return (PARTNER_LEAD_OUTREACH_TEMPLATE_KEYS as readonly string[]).includes(raw);
}

function firstName(contactName: string | null | undefined): string {
  const t = String(contactName ?? "").trim();
  if (!t) return "there";
  return t.split(/\s+/)[0] || "there";
}

/** Shared body for partner lead email + WhatsApp outreach. */
export function buildPartnerLeadOutreachBody(
  templateKey: PartnerLeadOutreachTemplateKey,
  params: { leadHotelName: string; contactName?: string | null }
): string {
  const { leadHotelName, contactName } = params;
  const name = firstName(contactName);
  switch (templateKey) {
    case "followup_1":
      return `Hello, just following up from ChatStay regarding ${leadHotelName}. Would you be open to a short demo on how AI WhatsApp booking and operations can help your hotel team?`;
    case "followup_2":
      return `Quick follow-up from ChatStay for ${leadHotelName}. If this is not a fit now, we are happy to reconnect later.`;
    case "demo_reminder":
      return `Hi ${name}, this is ChatStay — friendly reminder about the demo we discussed for ${leadHotelName}. Reply with a time that works this week, or tell us if you would prefer a short voice note instead.`;
    case "proposal_followup":
      return `Hi ${name}, following up on the proposal sent for ${leadHotelName}. Happy to walk through pricing, rollout, and any questions on WhatsApp or email — just let us know what is easiest.`;
    case "onboarding_checklist":
      return `Hi ${name}, for ${leadHotelName}: onboarding typically needs property details, room types, WhatsApp Business number, and one kickoff call. We can send a checklist and schedule setup — interested?`;
    case "initial_intro":
    default:
      return `Hello from ChatStay. We help hotels like ${leadHotelName} automate WhatsApp booking, guest operations, upsell, and follow-up in one platform. Would you like a quick walkthrough?`;
  }
}
