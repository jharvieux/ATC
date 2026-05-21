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
// Defense in depth: this proxy enforces scoping at the application layer.
// RLS enforces it at the database layer. Either alone is insufficient;
// both together are the design.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "./service-role-client";
import type { TenantContext } from "./tenant-context";
import { TENANT_SCOPED_TABLES } from "./tenant-scoped-tables";

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

export function tenantClient(ctx: TenantContext): SupabaseClient {
  const supabase = createServiceRoleClient();

  return new Proxy(supabase, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          const qb = target.from(table);
          if (!TENANT_SCOPED_TABLES.has(table)) {
            return qb;
          }
          return wrapQueryBuilder(qb, ctx.tenant_id);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SupabaseClient;
}
