-- Issue #545 — narrow the service_role grants from 20260627000014 to least privilege.
--
-- 20260627000014 restored a full CRUD grant (select, insert, update, delete) to
-- service_role on 13 tables that had been created without any grant (the prod
-- incident was a MISSING grant: assertPlatformAdmin's SELECT returned PostgREST
-- 403, failing the admin gate closed with 500). That fix was correct but coarse:
-- it handed every one of the 13 tables all four privileges regardless of what the
-- app actually does with each.
--
-- service_role is RLS-bypassing (BYPASSRLS), so its table grants are the only
-- privilege boundary it has. Narrowing them does not enforce tenant isolation
-- (RLS does that for the authenticated path); it limits the blast radius of an
-- app-layer bug that issues an unintended mutation through the service-role
-- client — defense in depth, per the §26 least-privilege posture.
--
-- The privilege set per table is the union of operations the app actually
-- performs, derived from an exhaustive scan of apps/main/src: every
-- `.from("<table>")` call site plus every `.delete()` call site. Of these 13
-- tables only help_doc_versions has an app DELETE path (the retention-purge
-- cron, inngest/help-doc-versions-purge.ts) — it keeps full CRUD and is omitted
-- below. SELECT is retained on all 13: re-narrowing it would recreate the
-- 20260627000014 incident. Upsert paths (general_pricing_ranges,
-- cruisemapper_url_inventory, destination_images_cache, pricing_cache) require
-- INSERT + UPDATE, both retained.
--
-- RLS and the authenticated/anon grants are unchanged — this only touches
-- service_role, matching the scope of 20260627000014.

-- SELECT only — read-only at the app layer.
--   platform_admins: assertPlatformAdmin reads the roster (seeded out-of-band
--     via SQL); no app INSERT/UPDATE/DELETE path.
--   destination_images: lib/groups/hero-image.ts reads image_url only; the
--     table is populated out-of-band, not by the app.
revoke insert, update, delete on table
  public.platform_admins,
  public.destination_images
from service_role;

-- SELECT + INSERT — append-only ledger, no update/delete path.
--   apify_spend_ledger: written by ApifyPricingAdapter / cruisemapper-actor
--     inserts; read for spend rollups. Never updated or deleted by the app.
revoke update, delete on table
  public.apify_spend_ledger
from service_role;

-- SELECT + INSERT + UPDATE — read/write or upsert, no app delete path.
revoke delete on table
  public.bug_submissions,
  public.feature_requests,
  public.help_sessions,
  public.general_pricing_ranges,
  public.price_watches,
  public.customer_bug_submission_counters,
  public.cruisemapper_url_inventory,
  public.destination_images_cache,
  public.pricing_cache
from service_role;

-- help_doc_versions intentionally retains full CRUD: the retention-purge cron
-- (inngest/help-doc-versions-purge.ts) issues a hard DELETE by id. No revoke.
