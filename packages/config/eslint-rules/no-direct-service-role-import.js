"use strict";

// Spec ref: §5.4.4
//
// Forbids importing from `src/lib/db/service-role-client.ts` outside of
// the two files that are allowed to construct a raw service-role client:
//   - src/lib/db/tenant-client.ts
//   - src/lib/db/platform-admin-client.ts
//
// Every other code path must use `tenantClient(ctx)` or
// `withPlatformAdminAudit(...)`. A raw service-role client bypasses RLS,
// so an unaudited import silently defeats tenant isolation.

// Full path suffixes for allowed callers. Using path suffixes (not bare
// filenames) avoids false positives if a future file happens to share a name.
const ALLOWED_PATH_SUFFIXES = [
  "/lib/db/tenant-client.ts",
  "/lib/db/platform-admin-client.ts",
  // Middleware tenant resolver: runs before any user context exists, so
  // service-role is the only viable client. See BP04 / spec §1.4.
  "/lib/tenancy/resolve-tenant.ts",
  // Stripe webhook handler: operates before any user session; service-role
  // required for the idempotency insert into stripe_webhook_events. §7.9a.
  "/lib/stripe/webhook-handler.ts",
  // Inngest reconciliation job: background job running outside any user
  // session; service-role required to scan stripe_webhook_events. §7.9a.
  "/inngest/stripe-webhook-incomplete-reconcile.ts",
  // RAG sync retry cron: background job, no user session. §8.7a.
  "/inngest/rag-sync-retry.ts",
  // DOB re-prompt cron: cross-tenant scan, no user session. §11.5.
  "/inngest/dob-estimate-reprompt-eligible.ts",
  // RAG sync publisher: fires after DB write commits, outside user request scope. §8.7.
  "/lib/rag-sync/publish-tenant-event.ts",
  // Platform-internal admin endpoint: bearer-token auth, no user JWT. §8.3.
  "/api/admin/tenants/route.ts",
  // Supervisor dashboard: platform admin Server Component — reads cross-tenant
  // metrics. TODO(§26): replace with withPlatformAdminAudit once admin session
  // auth lands. Until then, this page is gated by the admin route group layout.
  "/app/(admin)/supervisor/page.tsx",
  // BP13: Anon-to-auth transfer finalize — background Inngest job, no user session. §11.4.
  "/inngest/transfer-finalize.ts",
  // BP14: Credential re-encryption cron — background Inngest job, no user session. §13.5.
  "/inngest/re-encrypt-old-records.ts",
  // BP14: Host adapter registry — loads adapter implementations from DB. §13.3.
  "/lib/host-adapters/registry.ts",
  // BP14: Adapter selection — reads tenant host configs and decrypts credentials. §13.7.
  "/lib/host-adapters/select-adapter.ts",
  // BP14: Credential health check — reads tenant host configs across tenants. §13.5.4.
  "/lib/host-adapters/credential-health.ts",
  // BP15: Commission split Inngest job — writes payout_records and platform_revenue. §14.3.
  "/inngest/commission-split-on-received.ts",
  // BP15: Payouts mark-available cron — cross-tenant payout_records scan. §14.6.
  "/inngest/payouts-mark-available.ts",
  // BP15: Payouts execute-transfer cron — Stripe transfer, no user session. §14.7.
  "/inngest/payouts-execute-transfer.ts",
  // BP15: Payouts reconcile-processing cron — cross-tenant recovery scan. §14.7.
  "/inngest/payouts-reconcile-processing.ts",
  // BP15: Statement reconciliation cron — cross-tenant daily fetch + match. §14.8.
  "/inngest/reconcile-statement-automated.ts",
  // BP15: Commission state machine — transitionCommissionState uses service_role
  // for the DB update. All callers are route handlers or Inngest jobs that have
  // already validated tenant context before calling this. §14.2.
  "/lib/commissions/state-machine.ts",
  // BP15: Booking submit — reads tier_definitions and writes commissions (locked rates). §14.3.
  "/app/api/bookings/[id]/submit/route.ts",
  // BP15: Booking cancel — reads payout_records for clawback logic. §14.9.
  "/app/api/bookings/[id]/cancel/route.ts",
  // BP15: Subcontractors — reads tenant.tenant_type to gate sub_host access. §14.3a.
  "/app/api/subcontractors/route.ts",
  // BP15: Reconciliation upload — processLineItem writes to reconciliation_review_queue. §14.8.
  "/app/api/admin/reconciliation/upload/route.ts",
];

function endsWithAllowed(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isServiceRoleClientImport(source) {
  if (!source) return false;
  // Match any path whose final segment is service-role-client(.ts)? — covers
  // ./service-role-client, ./db/service-role-client, ../../lib/db/service-role-client,
  // and @/lib/db/service-role-client equally.
  return /(?:^|[\\/])service-role-client(?:\.ts)?$/.test(source);
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing service-role-client.ts outside tenant-client.ts and platform-admin-client.ts (spec §5.4.4)",
    },
    schema: [],
    messages: {
      forbidden:
        "Importing service-role-client is not allowed here. Use tenantClient(ctx) or withPlatformAdminAudit(...) instead (spec §5.4.4).",
    },
  },
  create(context) {
    const filename = context.getFilename
      ? context.getFilename()
      : context.filename;
    if (endsWithAllowed(filename)) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        if (isServiceRoleClientImport(node.source.value)) {
          context.report({ node, messageId: "forbidden" });
        }
      },
      CallExpression(node) {
        // Dynamic import() and require()
        if (
          (node.callee.type === "Import" ||
            (node.callee.type === "Identifier" &&
              node.callee.name === "require")) &&
          node.arguments[0] &&
          node.arguments[0].type === "Literal" &&
          isServiceRoleClientImport(node.arguments[0].value)
        ) {
          context.report({ node, messageId: "forbidden" });
        }
      },
    };
  },
};
