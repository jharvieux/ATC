// §26.9 — Vendor health probe core logic.
// Runs every 15 minutes via Vercel cron (/api/cron/vendor-health-probe).
// Two-tier design (#1010): real traffic records vendor health in-process
// via recordVendorSuccess/Failure; this probe is the durable backstop and
// sole writer to the vendor_health table (cross-instance admin view +
// alert-once-per-transition guarantee ride the 15-min cadence).
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { upsertVendorHealth, type VendorName } from "@/lib/vendor-health/registry";
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
      return { vendor, success: true };
    }
    return { vendor, success: false, error_message: `http_${res.status}` };
  } catch (err) {
    return { vendor, success: false, error_message: err instanceof Error ? err.message : String(err) };
  }
}

// Inngest statuspage returns 200 always; parse body for operational indicator.
// Endpoint: https://status.inngest.com/api/v2/status.json
// Returns { status: { indicator: "none" | "minor" | "major" | "critical" } }
async function pingInngest(): Promise<PingResult> {
  try {
    const res = await fetch("https://status.inngest.com/api/v2/status.json", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { vendor: "inngest", success: false, error_message: `http_${res.status}` };
    }
    const body = (await res.json()) as { status?: { indicator?: string } };
    const indicator = body?.status?.indicator ?? "unknown";
    if (indicator === "none") {
      return { vendor: "inngest", success: true };
    }
    return { vendor: "inngest", success: false, error_message: `status_${indicator}` };
  } catch (err) {
    return { vendor: "inngest", success: false, error_message: err instanceof Error ? err.message : String(err) };
  }
}

// RAG readiness: hits /api/health/ready on the RAG service, which pings Redis
// and RAG Supabase. Records "rag" down if the endpoint itself is unreachable.
async function pingRagReadiness(): Promise<PingResult[]> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) {
    const msg = "RAG_SERVICE_URL not configured";
    return [
      { vendor: "rag", success: false, error_message: msg },
      { vendor: "upstash", success: false, error_message: msg },
      { vendor: "supabase_rag", success: false, error_message: msg },
    ];
  }
  try {
    const res = await fetch(`${ragUrl}/api/health/ready`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { redis?: string; supabase_rag?: string };
    return [
      res.ok
        ? { vendor: "rag", success: true }
        : { vendor: "rag", success: false, error_message: `http_${res.status}` },
      body.redis === "ok"
        ? { vendor: "upstash", success: true }
        : { vendor: "upstash", success: false, error_message: body.redis ?? "no_response" },
      body.supabase_rag === "ok"
        ? { vendor: "supabase_rag", success: true }
        : { vendor: "supabase_rag", success: false, error_message: body.supabase_rag ?? "no_response" },
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      { vendor: "rag", success: false, error_message: msg },
      { vendor: "upstash", success: false, error_message: `rag_unreachable: ${msg}` },
      { vendor: "supabase_rag", success: false, error_message: `rag_unreachable: ${msg}` },
    ];
  }
}

export async function runVendorHealthProbe() {
  if (process.env.STAGING_MODE === "true") {
    return { skipped_for_staging: true };
  }

  const [anthropicResult, openaiResult, stripeResult, resendResult, supabaseResult, inngestResult, ...ragResults] =
    await Promise.all([
      ping("anthropic", "https://api.anthropic.com/v1/models", {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      }),
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

  const allResults: PingResult[] = [
    anthropicResult,
    openaiResult,
    stripeResult,
    resendResult,
    supabaseResult,
    inngestResult,
    // ragResults is [ PingResult[] ] — one element wrapping the three RAG vendor results.
    ...ragResults[0],
  ];

  const svc = createServiceRoleClient();

  const settled = await Promise.allSettled(
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

  const upsertFailures = settled.filter((r) => r.status === "rejected");
  if (upsertFailures.length > 0) {
    console.error(
      `vendor-health-probe: ${upsertFailures.length} upsert(s) failed`,
      upsertFailures.map((r) => (r as PromiseRejectedResult).reason),
    );
  }

  return { ok: true, upsert_failures: upsertFailures.length };
}
