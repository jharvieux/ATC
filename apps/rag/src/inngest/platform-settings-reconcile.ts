// D-041 follow-up — Nightly reconcile: diff main app platform_settings against
// the rag-side replica. Catches drift caused by dropped webhooks / dropped
// pending_rag_sync retries / out-of-band edits in either DB.
//
// Mirrors tenant-registry-reconcile.ts (§8.3). Three cases per key:
//   • Present in main but absent in shadow → insert
//   • Present in both with newer source_revision in main → update
//   • Present in shadow but absent in main → log warning (investigate manually)
//
// Symmetric to the publish-platform-event sender, this cron applies an
// allowlist filter — only keys the rag side actually consumes are mirrored.
// Anything else is silently skipped (deny-list etc. stays on main only).
//
// Service-role import permitted: background job, no user session.
// This file is in the no-direct-service-role-import allowlist.

import { createClient } from "@supabase/supabase-js";
import { inngest } from "./client";

// Keep this list in sync with apps/main/src/lib/rag-sync/publish-platform-event.ts
// SYNC_ELIGIBLE_KEYS. Two copies because rag can't import from main; a
// reconcile-time drift check would catch a divergence (added key on one
// side but not the other → cron skips that key with a warning log).
const SYNC_ELIGIBLE_KEYS: ReadonlySet<string> = new Set([
  "feedback_adjustment_limit",
  "feedback_min_signal_count",
  "feedback_period_days",
  "feedback_decay_halflife_days",
]);

interface MainSetting {
  key: string;
  value: unknown;
  source_revision: number;
  updated_at: string;
}

interface ShadowSetting {
  key: string;
  value: unknown;
  source_revision: number;
}

export const platformSettingsReconcile = inngest.createFunction(
  { id: "platform-settings-reconcile", triggers: [{ cron: "30 3 * * *" }] },
  async () => {
    const mainAppUrl = process.env.MAIN_APP_URL;
    const adminKey = process.env.MAIN_APP_ADMIN_API_KEY;
    if (!mainAppUrl || !adminKey) {
      throw new Error("MAIN_APP_URL or MAIN_APP_ADMIN_API_KEY not set");
    }

    const res = await fetch(`${mainAppUrl}/api/admin/platform-settings`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (!res.ok) {
      throw new Error(`Main app admin API returned ${res.status}`);
    }
    const { settings: mainSettings }: { settings: MainSetting[] } = await res.json();

    const db = createClient(
      process.env.SUPABASE_RAG_URL!,
      process.env.SUPABASE_RAG_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data: shadowRows, error } = await db
      .from("platform_settings")
      .select("key, value, source_revision");
    if (error) throw error;

    const shadowMap = new Map<string, ShadowSetting>(
      (shadowRows ?? []).map((r) => [r.key, r as ShadowSetting]),
    );

    let inserted = 0;
    let updated = 0;
    let skipped_not_eligible = 0;

    for (const setting of mainSettings) {
      if (!SYNC_ELIGIBLE_KEYS.has(setting.key)) {
        skipped_not_eligible++;
        continue;
      }
      const shadow = shadowMap.get(setting.key);

      if (!shadow) {
        await db.from("platform_settings").insert({
          key: setting.key,
          value: setting.value as Record<string, unknown> | string | number | boolean | null,
          source_revision: setting.source_revision,
          last_reconcile_sync_at: new Date().toISOString(),
        });
        console.warn("[platform-settings-reconcile] inserted missing key", { key: setting.key });
        inserted++;
        continue;
      }

      const drifted =
        shadow.source_revision !== setting.source_revision ||
        JSON.stringify(shadow.value) !== JSON.stringify(setting.value);

      if (drifted && setting.source_revision >= shadow.source_revision) {
        await db
          .from("platform_settings")
          .update({
            value: setting.value as Record<string, unknown> | string | number | boolean | null,
            source_revision: setting.source_revision,
            last_reconcile_sync_at: new Date().toISOString(),
          })
          .eq("key", setting.key);
        console.warn("[platform-settings-reconcile] corrected drifted key", { key: setting.key });
        updated++;
      } else {
        await db
          .from("platform_settings")
          .update({ last_reconcile_sync_at: new Date().toISOString() })
          .eq("key", setting.key);
      }
    }

    // Shadow keys absent from main — usually fine for allowlist-filtered
    // keys (means main removed a key). Log so an operator can investigate
    // if it's unexpected.
    const mainKeys = new Set(mainSettings.map((s) => s.key));
    for (const [key] of shadowMap) {
      if (!mainKeys.has(key) && SYNC_ELIGIBLE_KEYS.has(key)) {
        console.warn("[platform-settings-reconcile] sync-eligible key in shadow but absent from main", { key });
      }
    }

    return { inserted, updated, skipped_not_eligible };
  },
);
