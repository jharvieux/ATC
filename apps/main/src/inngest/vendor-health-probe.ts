// §26.9 — Vendor health probe.
//
// Runs every 15 minutes. Pings a lightweight read endpoint on each vendor we
// depend on. Per-instance — each Vercel function instance maintains its
// own view of vendor health.
//
// NOT probed: Anthropic. Two reasons:
//   1. Anthropic doesn't expose a free GET endpoint — /v1/messages is
//      POST only, so the previous probe was returning 405 every minute
//      (1440 wasted requests/day against the per-minute rate limit, with
//      no useful signal).
//   2. Every real Anthropic call already records vendor health via
//      recordVendorSuccess/Failure in lib/ai/call-wrapper.ts +
//      lib/ai/stream-wrapper.ts. Real traffic is the right signal; an
//      idle probe tells us nothing the real path doesn't.
// If Anthropic ever exposes a cheap GET (e.g., /v1/models for org-key
// holders), wire it back in.

import { inngest } from "./client";
import { recordVendorFailure, recordVendorSuccess } from "@/lib/vendor-health/registry";

async function ping(name: string, url: string, headers: Record<string, string> = {}): Promise<void> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok || res.status === 401 || res.status === 403) {
      // 401/403 mean the vendor is up — just our request wasn't authorized.
      recordVendorSuccess(name as never);
    } else {
      recordVendorFailure(name as never, `http_${res.status}`);
    }
  } catch (err) {
    recordVendorFailure(name as never, err instanceof Error ? err.message : String(err));
  }
}

// Inngest: statuspage returns 200 always; parse body for operational indicator.
// Endpoint verified 2026-06-10: https://status.inngest.com/api/v2/status.json
// returns { status: { indicator: "none" | "minor" | "major" | "critical" } }
// "none" = all systems operational.
async function pingInngest(): Promise<void> {
  try {
    const res = await fetch("https://status.inngest.com/api/v2/status.json", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      recordVendorFailure("inngest", `http_${res.status}`);
      return;
    }
    const body = (await res.json()) as { status?: { indicator?: string } };
    const indicator = body?.status?.indicator ?? "unknown";
    if (indicator === "none") {
      recordVendorSuccess("inngest");
    } else {
      recordVendorFailure("inngest", `status_${indicator}`);
    }
  } catch (err) {
    recordVendorFailure("inngest", err instanceof Error ? err.message : String(err));
  }
}

// RAG readiness: hits /api/health/ready on the RAG service, which pings Redis
// and RAG Supabase. Records "rag" down if the endpoint itself is unreachable;
// parses the JSON body for "upstash" and "supabase_rag" status.
async function pingRagReadiness(): Promise<void> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) {
    recordVendorFailure("rag", "RAG_SERVICE_URL not configured");
    recordVendorFailure("upstash", "RAG_SERVICE_URL not configured");
    recordVendorFailure("supabase_rag", "RAG_SERVICE_URL not configured");
    return;
  }
  try {
    const res = await fetch(`${ragUrl}/api/health/ready`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { redis?: string; supabase_rag?: string };
    if (res.ok) {
      recordVendorSuccess("rag");
    } else {
      recordVendorFailure("rag", `http_${res.status}`);
    }
    if (body.redis === "ok") {
      recordVendorSuccess("upstash");
    } else {
      recordVendorFailure("upstash", body.redis ?? "no_response");
    }
    if (body.supabase_rag === "ok") {
      recordVendorSuccess("supabase_rag");
    } else {
      recordVendorFailure("supabase_rag", body.supabase_rag ?? "no_response");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordVendorFailure("rag", msg);
    recordVendorFailure("upstash", `rag_unreachable: ${msg}`);
    recordVendorFailure("supabase_rag", `rag_unreachable: ${msg}`);
  }
}

export const vendorHealthProbe = inngest.createFunction(
  {
    id: "vendor-health-probe",
    // 15-min cadence (#894 Inngest cost): real traffic also records vendor
    // health via recordVendorSuccess/Failure, so the probe is a backstop.
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") {
      // Don't probe vendors from staging.
      return { skipped_for_staging: true };
    }

    await Promise.allSettled([
      ping("openai", "https://api.openai.com/v1/models", {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
      }),
      ping("stripe", "https://api.stripe.com/v1/balance", {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY ?? ""}`,
      }),
      ping("resend", "https://api.resend.com/domains", {
        Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ""}`,
      }),
      ping("supabase", `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/auth/v1/health`),
      pingInngest(),
      pingRagReadiness(),
    ]);
    return { ok: true };
  },
);
