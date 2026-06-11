// §26.9 — Vendor health probe.
//
// Runs every 15 minutes. Pings each vendor dependency, upserts durable
// state to the `vendor_health` table (#786), and fires an operator alert
// on status transitions (healthy→degraded/down, or any→healthy recovery).
// Alert fires exactly once per transition because the durable status is the
// gate — a down vendor doesn't page on every subsequent failure.
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

import { inngest } from "./client";
import { recordVendorFailure, recordVendorSuccess, upsertVendorHealth, type VendorName } from "@/lib/vendor-health/registry";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

interface PingResult {
  vendor: VendorName;
  success: boolean;
  error_message?: string;
}

async function ping(vendor: VendorName, url: string, headers: Record<string, string> = {}): Promise<PingResult> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok || res.status === 401 || res.status === 403) {
      recordVendorSuccess(vendor);
      return { vendor, success: true };
    }
    const msg = `http_${res.status}`;
    recordVendorFailure(vendor, msg);
    return { vendor, success: false, error_message: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordVendorFailure(vendor, msg);
    return { vendor, success: false, error_message: msg };
  }
}

// Inngest: statuspage returns 200 always; parse body for operational indicator.
// Endpoint verified 2026-06-10: https://status.inngest.com/api/v2/status.json
// returns { status: { indicator: "none" | "minor" | "major" | "critical" } }
// "none" = all systems operational.
async function pingInngest(): Promise<PingResult> {
  try {
    const res = await fetch("https://status.inngest.com/api/v2/status.json", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const msg = `http_${res.status}`;
      recordVendorFailure("inngest", msg);
      return { vendor: "inngest", success: false, error_message: msg };
    }
    const body = (await res.json()) as { status?: { indicator?: string } };
    const indicator = body?.status?.indicator ?? "unknown";
    if (indicator === "none") {
      recordVendorSuccess("inngest");
      return { vendor: "inngest", success: true };
    }
    const msg = `status_${indicator}`;
    recordVendorFailure("inngest", msg);
    return { vendor: "inngest", success: false, error_message: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordVendorFailure("inngest", msg);
    return { vendor: "inngest", success: false, error_message: msg };
  }
}

// RAG readiness: hits /api/health/ready on the RAG service, which pings Redis
// and RAG Supabase. Records "rag" down if the endpoint itself is unreachable;
// parses the JSON body for "upstash" and "supabase_rag" status.
async function pingRagReadiness(): Promise<PingResult[]> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) {
    const msg = "RAG_SERVICE_URL not configured";
    recordVendorFailure("rag", msg);
    recordVendorFailure("upstash", msg);
    recordVendorFailure("supabase_rag", msg);
    return [
      { vendor: "rag", success: false, error_message: msg },
      { vendor: "upstash", success: false, error_message: msg },
      { vendor: "supabase_rag", success: false, error_message: msg },
    ];
  }
  try {
    const res = await fetch(`${ragUrl}/api/health/ready`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { redis?: string; supabase_rag?: string };
    const results: PingResult[] = [];

    if (res.ok) {
      recordVendorSuccess("rag");
      results.push({ vendor: "rag", success: true });
    } else {
      const msg = `http_${res.status}`;
      recordVendorFailure("rag", msg);
      results.push({ vendor: "rag", success: false, error_message: msg });
    }
    if (body.redis === "ok") {
      recordVendorSuccess("upstash");
      results.push({ vendor: "upstash", success: true });
    } else {
      const msg = body.redis ?? "no_response";
      recordVendorFailure("upstash", msg);
      results.push({ vendor: "upstash", success: false, error_message: msg });
    }
    if (body.supabase_rag === "ok") {
      recordVendorSuccess("supabase_rag");
      results.push({ vendor: "supabase_rag", success: true });
    } else {
      const msg = body.supabase_rag ?? "no_response";
      recordVendorFailure("supabase_rag", msg);
      results.push({ vendor: "supabase_rag", success: false, error_message: msg });
    }
    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordVendorFailure("rag", msg);
    recordVendorFailure("upstash", `rag_unreachable: ${msg}`);
    recordVendorFailure("supabase_rag", `rag_unreachable: ${msg}`);
    return [
      { vendor: "rag", success: false, error_message: msg },
      { vendor: "upstash", success: false, error_message: `rag_unreachable: ${msg}` },
      { vendor: "supabase_rag", success: false, error_message: `rag_unreachable: ${msg}` },
    ];
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
      return { skipped_for_staging: true };
    }

    const [openaiResult, stripeResult, resendResult, supabaseResult, inngestResult, ...ragResults] =
      await Promise.all([
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

    // ragResults is [ PingResult[] ] (one element: the array from pingRagReadiness).
    const allResults: PingResult[] = [
      openaiResult,
      stripeResult,
      resendResult,
      supabaseResult,
      inngestResult,
      ...(ragResults[0] as PingResult[]),
    ];

    const svc = createServiceRoleClient();

    // Upsert durable state + fire transition alerts.
    await Promise.allSettled(
      allResults.map(async (r) => {
        const { prior_status, new_status, transitioned } = await upsertVendorHealth({
          vendor: r.vendor,
          success: r.success,
          error_message: r.error_message ?? null,
          db: svc,
        });

        if (!transitioned) return;

        if (new_status === "down") {
          await sendOperatorAlert({
            severity: "high",
            signal: "vendor_down",
            detail: `${r.vendor} is DOWN (was ${prior_status}). Error: ${r.error_message ?? "unknown"}`,
            payload: { vendor: r.vendor, prior_status, new_status, error: r.error_message ?? null },
          });
        } else if (new_status === "degraded") {
          await sendOperatorAlert({
            severity: "medium",
            signal: "vendor_degraded",
            detail: `${r.vendor} is DEGRADED (was ${prior_status}). Error: ${r.error_message ?? "unknown"}`,
            payload: { vendor: r.vendor, prior_status, new_status, error: r.error_message ?? null },
          });
        } else if (new_status === "healthy" && prior_status !== "healthy") {
          await sendOperatorAlert({
            severity: "low",
            signal: "vendor_recovered",
            detail: `${r.vendor} has RECOVERED (was ${prior_status}).`,
            payload: { vendor: r.vendor, prior_status, new_status },
          });
        }
      }),
    );

    return { ok: true };
  },
);
