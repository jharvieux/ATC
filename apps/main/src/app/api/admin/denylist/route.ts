// §24.5 / §26.11 — Platform deny-list management API (platform_super_admin).
//
// GET    /api/admin/denylist           → { count, hashes: [...] }
// POST   /api/admin/denylist           → body { term, reason } → adds; audit count-only
// DELETE /api/admin/denylist?hash=...  → removes the term matching the hash
//
// Stored in platform_settings.supervisor_slur_deny_list (BP11 key — see
// MEMORY D-046, D-057). Audit logs hold counts only — NEVER the term itself.

import { createHash } from "node:crypto";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";
import { evictPlatformSetting } from "@/lib/platform/platform-setting-cache";

function hashTerm(term: string): string {
  return createHash("sha256").update(term.toLowerCase()).digest("hex").slice(0, 12);
}

async function loadList(
  db: Parameters<Parameters<typeof withPlatformAdminAudit>[1]>[0],
): Promise<string[]> {
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "supervisor_slur_deny_list")
    .maybeSingle();
  const v = (data as { value?: unknown } | null)?.value;
  return Array.isArray(v) ? (v as string[]) : [];
}

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "denylist")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "denylist_management", operation: "denylist.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "platform_settings" });
        const terms = await loadList(db);
        return { count: terms.length, hashes: terms.map(hashTerm) };
      },
    );
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "denylist")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: { term?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const term = String(body.term ?? "").trim();
  if (term.length === 0 || term.length > 200) {
    return Response.json({ error: "invalid_term" }, { status: 422 });
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "denylist_management", operation: "denylist.add" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "platform_settings" });
        const terms = await loadList(db);
        const lower = term.toLowerCase();
        if (terms.some((t) => t.toLowerCase() === lower)) {
          return { added: false, count: terms.length };
        }
        const updated = [...terms, term];
        recordQuery({ op: "update", table: "platform_settings" });
        await safeAwait(db
          .from("platform_settings")
          .update({ value: updated })
          .eq("key", "supervisor_slur_deny_list"), "platform_settings.update");
        // #1586 — drop this instance's cached copy so the supervisor re-reads
        // the new list immediately (other instances refresh within the 60s TTL).
        evictPlatformSetting("supervisor_slur_deny_list");
        // Audit changes carry COUNT ONLY (§24.5 — never the term itself).
        return { added: true, count: updated.length, _changes: { added_count: 1, removed_count: 0 } };
      },
    );
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "denylist")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const url = new URL(req.url);
  const hash = url.searchParams.get("hash");
  if (!hash) return Response.json({ error: "missing_hash" }, { status: 400 });

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "denylist_management", operation: "denylist.remove" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "platform_settings" });
        const terms = await loadList(db);
        const remaining = terms.filter((t) => hashTerm(t) !== hash);
        if (remaining.length === terms.length) {
          return { removed: false, count: terms.length };
        }
        recordQuery({ op: "update", table: "platform_settings" });
        await safeAwait(db
          .from("platform_settings")
          .update({ value: remaining })
          .eq("key", "supervisor_slur_deny_list"), "platform_settings.update");
        // #1586 — see POST: evict so the removal takes effect immediately here.
        evictPlatformSetting("supervisor_slur_deny_list");
        return { removed: true, count: remaining.length, _changes: { added_count: 0, removed_count: 1 } };
      },
    );
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
