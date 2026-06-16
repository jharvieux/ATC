// §25.4a Category 3 — List notes for the tenant admin review page.
//
// GET /api/tenant/crm/notes/list?anonymized=true
//   → contacts rows in this tenant where anonymized_customer_hash IS NOT NULL
//     AND notes IS NOT NULL (residual text to review).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "CRM notes list",
      action: "list",
    });
    const url = new URL(req.url);
    const anonymizedOnly = url.searchParams.get("anonymized") === "true";

    const db = tenantClient(ctx);
    // Cast to unknown then to a minimal query shape so TS doesn't have to
    // walk the deeply-recursive PostgrestFilterBuilder generic — the chain
    // here trips its depth limit otherwise.
    type AnyQuery = {
      not(col: string, op: string, val: unknown): AnyQuery;
      order(col: string, opts?: { ascending: boolean }): AnyQuery;
      limit(n: number): AnyQuery;
      then<TResult>(cb: (v: { data: unknown; error: { message: string } | null }) => TResult): TResult;
    };
    const baseQuery = db
      .from("contacts")
      .select("id, first_name, last_name, notes, anonymized_customer_hash, updated_at") as unknown as AnyQuery;

    let q = baseQuery.not("notes", "is", null);
    if (anonymizedOnly) q = q.not("anonymized_customer_hash", "is", null);
    q = q.order("updated_at", { ascending: false }).limit(200);
    const { data, error } = await (q as unknown as Promise<{
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    }>);
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ rows: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}
