import { prisma } from "../db";
import { loadDecisionAnalyticsSummary } from "../core/decisionAnalytics";
import { loadPartnerSetupConfig, savePartnerSetupConfig } from "../core/partnerSetup";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export async function runAutoOptimizationSweep(): Promise<{ hotelsScanned: number; hotelsAdjusted: number }> {
  const hotels = await prisma.hotel.findMany({
    where: { isActive: true },
    select: { id: true }
  });
  let adjusted = 0;
  for (const hotel of hotels) {
    const summary = await loadDecisionAnalyticsSummary({ hotelId: hotel.id, days: 30 });
    const cfg = loadPartnerSetupConfig(hotel.id);
    const opt = cfg.optimizationSettings;
    if (opt.manualOverride) continue;

    const shown = summary.events.upsell_shown ?? 0;
    const started = summary.events.booking_started ?? 0;
    const followupSent = summary.events.followup_sent ?? 0;
    const sampleOk = shown >= 10 || started >= 20 || followupSent >= 10;
    if (!sampleOk) continue;

    let nextUpsellFactor = opt.upsellFrequencyFactor;
    let nextFollowupFactor = opt.followupDelayFactor;
    let nextVariant = opt.upsellMessageVariant;
    const reasons: string[] = [];

    if (summary.metrics.upsellAcceptanceRatePct < 8 && shown >= 20) {
      nextUpsellFactor = clamp(nextUpsellFactor - 0.1, 0.6, 1.2);
      reasons.push("Reduced upsell frequency due to low acceptance rate");
    } else if (summary.metrics.upsellAcceptanceRatePct >= 22 && shown >= 20) {
      nextUpsellFactor = clamp(nextUpsellFactor + 0.05, 0.6, 1.2);
      reasons.push("Increased upsell frequency due to strong acceptance");
    }

    if (summary.metrics.complaintFrequencyPct >= 12) {
      nextUpsellFactor = clamp(nextUpsellFactor - 0.1, 0.6, 1.2);
      nextVariant = "soft";
      reasons.push("Complaint frequency high, switched upsell tone to soft");
    } else if (summary.metrics.upsellAcceptanceRatePct >= 25 && summary.metrics.highValueGuestRatioPct >= 30) {
      nextVariant = "premium";
      reasons.push("Strong premium uptake, switched upsell variant to premium");
    } else if (summary.metrics.upsellAcceptanceRatePct < 15) {
      nextVariant = "standard";
    }

    if (summary.metrics.abandonmentRatePct >= 35 && started >= 20) {
      nextFollowupFactor = clamp(nextFollowupFactor - 0.1, 0.7, 1.3);
      reasons.push("Abandonment high, moved follow-ups earlier");
    }
    if (summary.metrics.followupConversionRatePct >= 18 && followupSent >= 15) {
      nextFollowupFactor = clamp(nextFollowupFactor - 0.05, 0.7, 1.3);
      reasons.push("Follow-up conversion strong, slightly earlier follow-ups");
    } else if (summary.metrics.followupConversionRatePct > 0 && summary.metrics.followupConversionRatePct < 5 && followupSent >= 15) {
      nextFollowupFactor = clamp(nextFollowupFactor + 0.1, 0.7, 1.3);
      reasons.push("Follow-up conversion weak, delayed follow-ups to reduce fatigue");
    }

    nextUpsellFactor = round2(nextUpsellFactor);
    nextFollowupFactor = round2(nextFollowupFactor);
    const changed =
      nextUpsellFactor !== opt.upsellFrequencyFactor ||
      nextFollowupFactor !== opt.followupDelayFactor ||
      nextVariant !== opt.upsellMessageVariant;
    if (!changed) continue;

    const nowIso = new Date().toISOString();
    cfg.optimizationSettings = {
      ...opt,
      upsellFrequencyFactor: nextUpsellFactor,
      followupDelayFactor: nextFollowupFactor,
      upsellMessageVariant: nextVariant,
      lastOptimizedAt: nowIso
    };
    savePartnerSetupConfig(cfg, hotel.id);
    adjusted++;
    await prisma.auditLog.create({
      data: {
        hotelId: hotel.id,
        action: "AUTO_OPTIMIZATION_ADJUSTED",
        entityType: "SYSTEM_SETTING",
        entityId: "partner_setup.optimizationSettings",
        metadataJson: JSON.stringify({
          previous: opt,
          next: cfg.optimizationSettings,
          reasons,
          basedOn: {
            metrics: summary.metrics,
            events: {
              booking_started: started,
              upsell_shown: shown,
              followup_sent: followupSent
            }
          },
          adjustedAt: nowIso
        })
      }
    });
  }
  return { hotelsScanned: hotels.length, hotelsAdjusted: adjusted };
}

export function startAutoOptimizationScheduler(): NodeJS.Timeout {
  const intervalMs = Math.max(5 * 60_000, parseInt(process.env.AUTO_OPTIMIZATION_INTERVAL_MS ?? "21600000", 10) || 21600000);
  const run = () => {
    runAutoOptimizationSweep().catch((err) =>
      console.error("[auto-optimization] sweep failed:", err instanceof Error ? err.message : String(err))
    );
  };
  run();
  return setInterval(run, intervalMs);
}
