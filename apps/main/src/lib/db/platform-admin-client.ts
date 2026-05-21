// Spec ref: §5.4.8
//
// `withPlatformAdminAudit` is the single supported way to obtain a
// platform-admin (raw service-role, unscoped) database client. There is
// no exported `platformAdminClient()` factory — the only public surface
// is this wrapper. Every call produces an audit row.
//
// Nesting safety: AsyncLocalStorage tracks whether we're already inside
// an audit wrapper. Re-entering reuses the outer context (same db, same
// recordQuery) so a function legally calling another platform-admin
// helper produces ONE audit row, not two.
//
// Audit-row write uses a SEPARATE dedicated client (not the wrapped
// function's `db`) so the audit row commits even if the wrapped function
// rolled back a transaction. The wrapped function's queries that DID
// commit are summarized via `recordQuery`; the wrapped function's queries
// that rolled back will still appear in the queries list — that is
// intentional, since the audit row is forensic, not transactional.
//
// TODO(audit-log): the audit_log table doesn't exist yet (§26 work).
// `writeAuditRow` below logs a structured JSON to console.warn for now.
// When the table lands, swap the body to a real insert. The audit-row
// shape mirrors what the table will accept.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "./service-role-client";
import type { PlatformAdminReason } from "./platform-admin-reasons";

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

function runInsidePlatformAdminAudit<T>(
  ctx: AuditContext,
  fn: () => Promise<T>,
): Promise<T> {
  return auditStorage.run(ctx, fn);
}

// TODO(audit-log): replace with insert into public.audit_log when §26 lands.
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
  console.warn(
    "[audit-log:STUB] " + JSON.stringify({ ...row, _stub: "audit_log table not yet created" }),
  );
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

  if (
    options.reason === "manual_emergency_intervention" &&
    !options.reason_detail
  ) {
    throw new Error(
      'withPlatformAdminAudit: reason_detail is required when reason is ' +
        '"manual_emergency_intervention". This is a deliberate friction.',
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
