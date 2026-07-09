// §10.6 / §26.9 / D-091 Round-3 #43 — the three AI kill-switch gates checked
// BEFORE any token can stream, collapsed into one resolver. Each gate previously
// copy-pasted the same send/send/send/close/return fallback block; centralizing
// the decision keeps handleChat's delivery of the fallback in one place.
//
// Order is load-bearing (first engaged gate wins the fallback message):
//   1. global   — platform_settings.ai_kill_switch_engaged (60s cache). #1653:
//      written alongside ai_kill_switch_state by /api/admin/ai-kill-switch.
//      Fail-OPEN preserved (read error → value null → not engaged); the
//      authoritative fail-CLOSED layer is the supervisor.
//   2. per-tenant — tenants.ai_paused_by_platform (request-scoped snapshot).
//   3. vendor    — resolveVendorHealthStatus("anthropic") === "down" (#1646
//      durable read-through so a cold instance still sees a fleet-wide down).

import { getCachedPlatformSetting } from "@/lib/platform/platform-setting-cache";
import { resolveVendorHealthStatus } from "@/lib/vendor-health/registry";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AiAvailability =
  | { available: true }
  | { available: false; fallbackBody: string };

export async function resolveAiAvailability(args: {
  svc: SupabaseClient;
  tenantAiPaused: boolean;
  bumpConfigReads: () => void;
}): Promise<AiAvailability> {
  const { svc, tenantAiPaused, bumpConfigReads } = args;

  const { value: killValue } = await getCachedPlatformSetting(
    svc,
    "ai_kill_switch_engaged",
    bumpConfigReads,
  );
  if (killValue === true || killValue === "true") {
    return {
      available: false,
      fallbackBody: "Our AI is paused right now. Please leave a message and we'll be in touch.",
    };
  }

  if (tenantAiPaused) {
    return {
      available: false,
      fallbackBody: "Our AI is taking a brief break. A human will be in touch shortly.",
    };
  }

  if ((await resolveVendorHealthStatus(svc, "anthropic")) === "down") {
    return {
      available: false,
      fallbackBody: "Our AI is temporarily unavailable. Please leave a message and we'll be in touch.",
    };
  }

  return { available: true };
}
