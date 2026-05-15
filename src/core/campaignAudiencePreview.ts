import { MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { parseLightGuestMemory } from "./lightGuestMemory";
import { normalizeWhatsAppRecipientId } from "./whatsappPhone";
import type { CampaignGuestRow } from "./campaignAudience";

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CampaignReachability = "will_send" | "outside_24h" | "dnd" | "opt_out" | "bad_phone";

export type CampaignGuestPreviewRow = {
  id: string;
  fullName: string | null;
  phoneE164: string;
  reachability: CampaignReachability;
  note: string;
};

export async function guestIdsWithInboundWithinServiceWindow(
  hotelId: string,
  guestIds: string[]
): Promise<Set<string>> {
  if (!guestIds.length) return new Set();
  const since = new Date(Date.now() - SERVICE_WINDOW_MS);
  const rows = await prisma.message.findMany({
    where: {
      hotelId,
      direction: MessageDirection.INBOUND,
      createdAt: { gte: since },
      conversation: { guestId: { in: guestIds } }
    },
    select: { conversation: { select: { guestId: true } } }
  });
  return new Set(rows.map((r) => r.conversation.guestId));
}

export async function buildCampaignAudiencePreview(params: {
  hotelId: string;
  guests: CampaignGuestRow[];
  hotelCountryIso: string;
  hasMarketingTemplate: boolean;
}): Promise<CampaignGuestPreviewRow[]> {
  const ids = params.guests.map((g) => g.id);
  const inWindow = await guestIdsWithInboundWithinServiceWindow(params.hotelId, ids);
  const countryIso = params.hotelCountryIso?.trim() || "OM";

  const rows: CampaignGuestPreviewRow[] = [];
  for (const g of params.guests) {
    const prefs = parseLightGuestMemory(g.lightGuestMemoryJson);
    const phone = normalizeWhatsAppRecipientId(g.phoneE164, countryIso);
    if (phone.length < 10) {
      rows.push({
        id: g.id,
        fullName: g.fullName,
        phoneE164: g.phoneE164,
        reachability: "bad_phone",
        note: "Invalid phone number"
      });
      continue;
    }
    if (prefs.messagingDoNotDisturb) {
      rows.push({
        id: g.id,
        fullName: g.fullName,
        phoneE164: g.phoneE164,
        reachability: "dnd",
        note: "Do not disturb"
      });
      continue;
    }
    if (prefs.messagingMarketingOptOut) {
      rows.push({
        id: g.id,
        fullName: g.fullName,
        phoneE164: g.phoneE164,
        reachability: "opt_out",
        note: "Marketing opt-out"
      });
      continue;
    }
    const in24h = inWindow.has(g.id);
    if (in24h || params.hasMarketingTemplate) {
      rows.push({
        id: g.id,
        fullName: g.fullName,
        phoneE164: g.phoneE164,
        reachability: "will_send",
        note: in24h ? "In 24-hour WhatsApp window" : "Will use marketing template"
      });
      continue;
    }
    rows.push({
      id: g.id,
      fullName: g.fullName,
      phoneE164: g.phoneE164,
      reachability: "outside_24h",
      note: "No WhatsApp message in last 24h — configure a Meta marketing template to reach"
    });
  }

  const order: Record<CampaignReachability, number> = {
    will_send: 0,
    outside_24h: 1,
    dnd: 2,
    opt_out: 3,
    bad_phone: 4
  };
  rows.sort(
    (a, b) =>
      order[a.reachability] - order[b.reachability] ||
      (a.fullName ?? "").localeCompare(b.fullName ?? "", undefined, { sensitivity: "base" })
  );
  return rows;
}

export function parseCampaignIncludeGuestIds(body: Record<string, unknown>): string[] {
  const raw = body.includeGuestIds;
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw.map(String) : raw != null && String(raw).length ? [String(raw)] : [];
  return [...new Set(arr.filter(Boolean))];
}

export function isGuestIncludedInPreview(
  guestId: string,
  preview: CampaignGuestPreviewRow[],
  body: Record<string, unknown>
): boolean {
  if (body.audiencePreviewed === "1") {
    return parseCampaignIncludeGuestIds(body).includes(guestId);
  }
  const row = preview.find((r) => r.id === guestId);
  return row?.reachability === "will_send";
}

export function summarizeCampaignPreview(preview: CampaignGuestPreviewRow[]): {
  total: number;
  willSend: number;
  outside24h: number;
  suppressed: number;
} {
  let willSend = 0;
  let outside24h = 0;
  let suppressed = 0;
  for (const r of preview) {
    if (r.reachability === "will_send") willSend++;
    else if (r.reachability === "outside_24h") outside24h++;
    else suppressed++;
  }
  return { total: preview.length, willSend, outside24h, suppressed };
}
