// #1759/#1781 — request-scoped tenant config load, extracted verbatim from
// handleChat.
//
// #1586 — load the tenant snapshot + tenant_settings ONCE per turn and derive
// the tier/sandbox/kill-switch/tone/profanity values from it, instead of
// re-reading `tenants` (×3) / `tenant_settings` (×2) / `tier_definitions`
// (×1) at each use site. Fail-closed (is_sandbox → is_test) / fail-open
// (pause) derivation lives in deriveChatTenantFlags so the security-critical
// defaults can't silently invert on a snapshot-load failure.
//
// `bumpConfigReads` is the caller's shared counter — this function doesn't
// own the count (also bumped by resolveAiAvailability later in the turn), it
// just contributes to it, so the caller passes the same closure through.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeForLog } from "@/lib/log/sanitize";
import { loadTenantSnapshot, type CachedTenantSnapshot } from "@/lib/abuse/snapshot";
import { loadChatTenantSettings, deriveChatTenantFlags } from "@/lib/chat/chat-tenant-settings";

export type RequestScopedTenantConfig = {
  snapshot: CachedTenantSnapshot | null;
  tenantTier: string;
  tenantIsSandbox: boolean;
  tenantAiPaused: boolean;
  tenantMaxTone: number;
  tenantAllowProfanity: boolean;
};

export async function loadRequestScopedConfig(
  svc: SupabaseClient,
  tenantId: string,
  bumpConfigReads: () => void,
): Promise<RequestScopedTenantConfig> {
  let snapshot: CachedTenantSnapshot | null = null;
  try {
    snapshot = await loadTenantSnapshot(svc, tenantId, bumpConfigReads);
  } catch (err) {
    // Non-fatal (matches the prior inline reads): degrade to fail-closed
    // defaults — is_test=true (over-tag), not paused, base tier.
    console.warn("[chat] tenant snapshot load failed (non-fatal):", sanitizeForLog(err));
  }
  const { tenantTier, isSandbox: tenantIsSandbox, aiPausedByPlatform: tenantAiPaused } =
    deriveChatTenantFlags(snapshot);

  const { personaToneMaxLevel: tenantMaxTone, allowProfanity: tenantAllowProfanity } =
    await loadChatTenantSettings(svc, tenantId, bumpConfigReads);

  return { snapshot, tenantTier, tenantIsSandbox, tenantAiPaused, tenantMaxTone, tenantAllowProfanity };
}
