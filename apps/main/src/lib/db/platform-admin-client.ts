// Spec ref: §5.4.8 / §26.3a.3
//
// `withPlatformAdminAudit` is the canonical way to scope a platform-admin
// (raw service-role, unscoped) database operation. Every call produces
// exactly one audit_log row. BP26 also exports `platformAdminClient()` so
// downstream helpers (e.g., decryptForensicsSnapshot) can reach the
// service-role db without it being plumbed through — the ALS check
// throws when called outside withPlatformAdminAudit.
//
// Nesting safety: AsyncLocalStorage tracks whether we're already inside
// an audit wrapper. Re-entering reuses the outer context (same db, same
// recordQuery) so a function legally calling another platform-admin
// helper produces ONE audit row, not two.
//
// Audit-row write uses a SEPARATE dedicated service-role client (not the
// wrapped function's `db`) so the audit row commits even if the wrapped
// function rolled back a transaction. The wrapped function's queries that
// DID commit are summarized via `recordQuery`; the wrapped function's
// queries that rolled back still appear in the queries list — that is
// intentional, since the audit row is forensic, not transactional.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "./service-role-client";
import type { PlatformAdminReason } from "./platform-admin-reasons";

// §26.3a.3 — Reasons that REQUIRE a non-empty reason_detail when invoked.
// Expanded 2026-05-25 to close audit Finding 6: every truly destructive
// operation gets the same friction as manual_emergency_intervention.
// Read/list operations under benign reasons (tenant_listing_for_admin_dashboard,
// abuse_signal_aggregation, etc.) deliberately don't require detail.
const REASONS_REQUIRING_DETAIL: ReadonlySet<PlatformAdminReason> = new Set([
  "manual_emergency_intervention",
  "tenant_termination_processing",
  "tenant_suspension_processing",
  "rag_chunk_demotion",
  "commission_manual_override",
  "abuse_override_revoke",
  "ccpa_deletion_processing",
  "ai_kill_switch_global_pause",
  "ai_kill_switch_global_resume",
  "ai_kill_switch_tenant_pause",
  "ai_kill_switch_tenant_resume",
]);

export type QueryRecord = {
  op: "select" | "insert" | "update" | "delete" | "rpc";
  table: string;
  columns?: string[];
  row_count?: number;
  rpc_name?: string;
};

export type PlatformAdminAuditOptions = {
  admin_user_id: string;
  reason: PlatformAdminReason;
  operation: string;
  request_context?: {
    ip?: string;
    user_agent?: string;
    request_id?: string;
  };
  reason_detail?: string;
};

type AuditContext = {
  db: SupabaseClient;
  recordQuery: (q: QueryRecord) => void;
  correlation_id: string;
};

const auditStorage = new AsyncLocalStorage<AuditContext>();

function isInsidePlatformAdminAudit(): boolean {
  return auditStorage.getStore() !== undefined;
}

function currentPlatformAdminAuditContext(): AuditContext {
  const ctx = auditStorage.getStore();
  if (!ctx) {
    throw new Error(
      "currentPlatformAdminAuditContext called outside withPlatformAdminAudit",
    );
  }
  return ctx;
}

// §26.3a.3 — Reads the active service-role db from the current
// withPlatformAdminAudit ALS context. Throws if called outside the
// wrapper — this is how decryptForensicsSnapshot and similar helpers
// enforce "only callable inside an audited admin operation".
//
// This function is the INVERSE of the rule the lint enforces: it can
// only run inside the wrapper, not call it. Disable the rule here.
// eslint-disable-next-line atc/platform-admin-functions-must-use-audit-wrapper
export function platformAdminClient(): SupabaseClient {
  return currentPlatformAdminAuditContext().db;
}

function runInsidePlatformAdminAudit<T>(
  ctx: AuditContext,
  fn: () => Promise<T>,
): Promise<T> {
  return auditStorage.run(ctx, fn);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function writeAuditRow(row: {
  tenant_id: string | null;
  actor_user_id: string;
  actor_type: "admin";
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<void> {
  // System callers (cron jobs, queue workers) pass sentinel strings like
  // "system-cron" rather than a real user UUID. The actor_user_id column
  // is UUID-typed and rejects strings — coerce to NULL and flip actor_type
  // to "system" so the audit row still lands. The sentinel is preserved
  // in the context blob for diagnostics. BP30 live-dispatch surfaced that
  // every cron audit_log write was silently failing before this fix.
  const isUuid = UUID_RE.test(row.actor_user_id);
  const actor_user_id = isUuid ? row.actor_user_id : null;
  const actor_type = isUuid ? row.actor_type : "system";
  const context = isUuid
    ? row.context
    : { ...row.context, system_actor_label: row.actor_user_id };

  // Dedicated service-role client so this commits even if the wrapped
  // function rolled back its own transaction. If the audit insert itself
  // fails, log to console and continue — we never throw from finally to
  // mask the wrapped fn's result.
  try {
    const auditDb = createServiceRoleClient();
    const { error } = await auditDb.from("audit_log").insert({
      tenant_id: row.tenant_id,
      actor_user_id,
      actor_type,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      changes: row.changes,
      context,
    });
    if (error) {
      console.warn("[audit-log:write-failed] " + JSON.stringify({ error: error.message, action: row.action }));
    }
  } catch (err) {
    console.warn(
      "[audit-log:write-threw] " +
        JSON.stringify({ error: err instanceof Error ? err.message : String(err), action: row.action }),
    );
  }
}

export async function withPlatformAdminAudit<T>(
  options: PlatformAdminAuditOptions,
  fn: (
    db: SupabaseClient,
    recordQuery: (q: QueryRecord) => void,
  ) => Promise<T>,
): Promise<T> {
  if (isInsidePlatformAdminAudit()) {
    const outer = currentPlatformAdminAuditContext();
    return fn(outer.db, outer.recordQuery);
  }

  // 2026-05-25 audit Auth #6 — expanded reason_detail requirement.
  // Previously only manual_emergency_intervention required detail; the audit
  // showed that equivalent destructive operations (tenant termination,
  // override revocation, AI kill-switch) could bypass the friction by picking
  // a different reason. Every truly destructive operation now requires detail.
  if (REASONS_REQUIRING_DETAIL.has(options.reason) && !options.reason_detail) {
    throw new Error(
      `withPlatformAdminAudit: reason_detail is required when reason is "${options.reason}". ` +
        `This is a deliberate friction — capture the human-readable justification ` +
        `(incident ID, ticket link, or one-sentence rationale) at the call site.`,
    );
  }

  const correlation_id = randomUUID();
  const start = performance.now();
  const queries: QueryRecord[] = [];

  const db = createServiceRoleClient();
  const recordQuery = (q: QueryRecord) => {
    queries.push(q);
  };

  let outcome: "success" | "error_thrown" = "success";
  let error_message: string | null = null;
  let result: T;

  try {
    result = await runInsidePlatformAdminAudit(
      { db, recordQuery, correlation_id },
      () => fn(db, recordQuery),
    );
    return result;
  } catch (err) {
    outcome = "error_thrown";
    error_message = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const duration_ms = Math.round(performance.now() - start);
    await writeAuditRow({
      tenant_id: null,
      actor_user_id: options.admin_user_id,
      actor_type: "admin",
      action: `platformAdmin.${options.reason}`,
      resource_type: "platform_admin_operation",
      resource_id: null,
      changes: {
        correlation_id,
        operation: options.operation,
        reason: options.reason,
        reason_detail: options.reason_detail ?? null,
        outcome,
        duration_ms,
        queries,
        error_message,
      },
      context: options.request_context ?? {},
    });
  }
}
