// Spec refs: §5.4.3 (Proxy wrapper), §5.4.7 (architectural-centerpiece note)
//
// `tenantClient(ctx)` is the only correct database client for code that acts
// on behalf of a single tenant. The Proxy mechanism is the architectural
// centerpiece — every Supabase query goes through `.from(table)`, and for
// tables in TENANT_SCOPED_TABLES the proxy transparently scopes the query
// to ctx.tenant_id. A developer cannot forget the filter.
//
// SCOPING SEMANTICS (per operation):
//   .select(...)   → appends .eq('tenant_id', ctx.tenant_id) to the result
//   .update(...)   → appends .eq('tenant_id', ctx.tenant_id) to the result
//   .delete()      → appends .eq('tenant_id', ctx.tenant_id) to the result
//   .insert(rows)  → injects tenant_id into each row before calling
//   .upsert(rows)  → injects tenant_id into each row before calling
//
// DEVIATION FROM SPEC §5.4.3: The spec writes
//   `return target.from(table).eq('tenant_id', ctx.tenant_id);`
// which compiles against an older or hypothetical Supabase JS API where
// `.eq()` lives on the query builder returned by `.from()`. In current
// @supabase/supabase-js v2, `.eq()` only exists on the filter builder
// returned after `.select/.update/.delete`, and inserts/upserts need the
// tenant_id in the payload rather than as a filter. The implementation
// below preserves the spec's stated *intent* ("every query is automatically
// scoped") with corrections for the actual API. See MEMORY.md for the
// decision record.
//
// CAUTION (§5.4.7): The Proxy only intercepts the five query-builder
// methods above. If the codebase later adds raw SQL paths via `.rpc()` or
// new query patterns, those MUST either be added to the proxy or moved
// behind `withPlatformAdminAudit`. The unit tests catch the five known
// operations; new surface area requires a deliberate code review.
//
// Defense in depth — but note WHICH layer applies on THIS path. The proxy wraps
// the SERVICE-ROLE client (createServiceRoleClient below), and service_role
// bypasses RLS, so RLS does NOT backstop queries made through this proxy. The
// tenant boundary here is the proxy's injected `.eq("tenant_id", ctx.tenant_id)`
// (and tenant_id in insert/upsert payloads) — which is exactly the explicit
// service-role tenant filter D-091 accepts as the DB-layer constraint. RLS is
// the genuine second layer for the SEPARATE authenticated-client / SSR path,
// where the caller's JWT (not service_role) drives the query.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "./service-role-client";
import type { TenantContext } from "./tenant-context";
import {
  TENANT_SCOPED_TABLES,
  PLATFORM_READABLE_TABLES,
} from "./tenant-scoped-tables";

// FAIL-CLOSED CONTRACT (added 2026-05-25 after the security audit):
// `tenantClient(ctx).from(table)` throws if `table` is in neither the
// tenant-scoped nor platform-readable set. Surfaced by the audit finding
// that the proxy previously fell through to raw service-role access for
// any unknown table — e.g., `tasks` and `quote_options` were reachable
// cross-tenant from authenticated handlers.
class UnregisteredTenantTableError extends Error {
  constructor(table: string) {
    super(
      `tenantClient: refusing to access table '${table}'. ` +
        `Add it to TENANT_SCOPED_TABLES (and ensure 4 RLS policies exist) ` +
        `or to PLATFORM_READABLE_TABLES (if it is genuinely platform-wide). ` +
        `Until added, this access is blocked to prevent silent service-role passthrough. ` +
        `See apps/main/src/lib/db/tenant-scoped-tables.ts.`,
    );
    this.name = "UnregisteredTenantTableError";
  }
}

type AnyRecord = Record<string, unknown>;

function injectTenantId(
  payload: AnyRecord | AnyRecord[],
  tenant_id: string,
): AnyRecord | AnyRecord[] {
  if (Array.isArray(payload)) {
    return payload.map((row) => ({ ...row, tenant_id }));
  }
  return { ...payload, tenant_id };
}

function wrapQueryBuilder(qb: unknown, tenant_id: string): unknown {
  return new Proxy(qb as object, {
    get(target, prop, receiver) {
      const raw = Reflect.get(target, prop, receiver);
      if (typeof raw !== "function") return raw;

      // Tenant-scoping for filter-based operations.
      if (prop === "select" || prop === "update" || prop === "delete") {
        return (...args: unknown[]) => {
          const result = (raw as (...a: unknown[]) => { eq: (col: string, val: string) => unknown }).apply(target, args);
          return result.eq("tenant_id", tenant_id);
        };
      }

      // Tenant-id injection for write-payload operations.
      if (prop === "insert" || prop === "upsert") {
        return (rows: AnyRecord | AnyRecord[], ...rest: unknown[]) => {
          const scoped = injectTenantId(rows, tenant_id);
          return (raw as (r: unknown, ...rest: unknown[]) => unknown).apply(
            target,
            [scoped, ...rest],
          );
        };
      }

      // Default: bind to original so `this` is preserved.
      return (raw as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

// Methods on the Supabase client that BYPASS the from()-based proxy and
// give the caller a fully-unscoped, service-role surface. Letting these
// through without an error is the same footgun the fail-closed proxy was
// created to prevent (audit pass 2, Finding 6). If a caller legitimately
// needs to call .rpc() or .schema(), they should reach for
// withPlatformAdminAudit explicitly — the audit row is part of the contract.
const UNSCOPED_METHODS: ReadonlySet<string> = new Set(["rpc", "schema"]);

class UnscopedTenantClientMethodError extends Error {
  constructor(method: string) {
    super(
      `tenantClient: refusing to expose '${method}'. This method bypasses ` +
        `the tenant-scoping Proxy and would give callers a raw service-role ` +
        `client. Use withPlatformAdminAudit(...) explicitly if the operation ` +
        `genuinely needs to run cross-tenant.`,
    );
    this.name = "UnscopedTenantClientMethodError";
  }
}

export function tenantClient(ctx: TenantContext): SupabaseClient {
  const supabase = createServiceRoleClient();

  return new Proxy(supabase, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          if (TENANT_SCOPED_TABLES.has(table)) {
            return wrapQueryBuilder(target.from(table), ctx.tenant_id);
          }
          if (PLATFORM_READABLE_TABLES.has(table)) {
            // Platform-wide table — callers self-scope. The proxy intentionally
            // does NOT inject a tenant_id filter (the column may not exist or
            // may not equal ctx.tenant_id for tables like `tenants` keyed by id).
            return target.from(table);
          }
          throw new UnregisteredTenantTableError(table);
        };
      }
      if (typeof prop === "string" && UNSCOPED_METHODS.has(prop)) {
        throw new UnscopedTenantClientMethodError(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SupabaseClient;
}
