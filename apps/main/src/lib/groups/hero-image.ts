// §18.3 — Hero image selection for group bookings.
//
// Priority chain:
//   1. Coordinator-uploaded URL (already set on the group row)
//   2. Destination-image library match (public.destination_images)
//   3. AI generation (DALL-E 3) — tier-gated, rate-limited, cached
//   4. Cruise-line default fallback

import { createServiceRoleClient } from "@/lib/db/service-role-client";

const CRUISE_LINE_DEFAULTS: Record<string, string> = {
  "Royal Caribbean": "https://cdn.ai-travelconcierge.com/defaults/cruise-ship-ocean.jpg",
  "Norwegian Cruise Line": "https://cdn.ai-travelconcierge.com/defaults/cruise-ship-ocean.jpg",
  "Carnival Cruise Line": "https://cdn.ai-travelconcierge.com/defaults/cruise-ship-ocean.jpg",
  _default: "https://cdn.ai-travelconcierge.com/defaults/cruise-ship-ocean.jpg",
};

const AI_ELIGIBLE_TIERS = new Set([
  "sub_host_pro",
  "sub_host_agency",
  "byo_professional",
  "byo_agency",
]);

export interface HeroImageContext {
  tenant_id: string;
  tier: string;
  destination: string;
  cruise_line: string;
  coordinator_url?: string | null;
}

export async function selectHeroImage(ctx: HeroImageContext): Promise<string> {
  // 1. Coordinator-provided URL
  if (ctx.coordinator_url) return ctx.coordinator_url;

  const db = createServiceRoleClient();

  // 2. Library match
  const { data: lib } = await db
    .from("destination_images")
    .select("image_url")
    .eq("destination", ctx.destination)
    .limit(1)
    .maybeSingle();
  if (lib?.image_url) return lib.image_url;

  // 3. AI generation (tier-gated)
  if (AI_ELIGIBLE_TIERS.has(ctx.tier) && process.env.IMAGE_GEN_PROVIDER === "openai" && process.env.OPENAI_API_KEY) {
    // Check cache
    const { data: cached } = await db
      .from("destination_images_cache")
      .select("image_url")
      .eq("destination", ctx.destination)
      .eq("cruise_line", ctx.cruise_line)
      .maybeSingle();
    if (cached?.image_url) return cached.image_url;

    // Rate-limit check: count today's generations for this tenant
    const limit = Number(process.env.IMAGE_GEN_RATE_LIMIT_DAILY ?? 20);
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count } = await db
      .from("destination_images_cache")
      .select("id", { count: "exact", head: true })
      .gte("generated_at", todayStart.toISOString());
    if ((count ?? 0) < limit) {
      const url = await generateWithDallE(ctx.destination, ctx.cruise_line);
      if (url) {
        await db.from("destination_images_cache").upsert(
          { destination: ctx.destination, cruise_line: ctx.cruise_line, image_url: url, generated_at: new Date().toISOString() },
          { onConflict: "destination,cruise_line" },
        );
        return url;
      }
    }
  }

  // 4. Cruise-line default
  return (
    CRUISE_LINE_DEFAULTS[ctx.cruise_line] ??
    CRUISE_LINE_DEFAULTS._default ??
    "https://cdn.ai-travelconcierge.com/defaults/cruise-ship-ocean.jpg"
  );
}

async function generateWithDallE(destination: string, cruiseLine: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const prompt = `Photorealistic travel destination image for ${destination} for a ${cruiseLine} cruise. Beautiful scenic view, no text overlays, wide-format hero image.`;
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: "1792x1024" }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: { url?: string | null }[] };
    return body.data?.[0]?.url ?? null;
  } catch {
    return null;
  }
}
