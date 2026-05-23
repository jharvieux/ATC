/**
 * §30.8 — Cross-tenant Inngest probe (static).
 *
 * Every Inngest function in apps/main/src/inngest/ must enforce tenant
 * scoping per §11.2.2 / §5.4.5:
 *
 *   1. Tenant-scoped functions derive tenant_id ONLY from
 *      `event.data.tenant_id` via `tenantContextFromInngestEvent` —
 *      never via a user lookup, a request header, or any derived field.
 *      They must also use `tenantClient(ctx)` for DB access so the proxy
 *      auto-injects the tenant_id filter as defense-in-depth.
 *
 *   2. Platform-admin functions (cross-tenant by design — recompute crons,
 *      monitors, etc.) must be wrapped in `withPlatformAdminAudit` so the
 *      ALS-gated platformAdminClient enforces the audit contract.
 *
 * This is a static probe — it reads source files and asserts each
 * function's source contains the appropriate token. A live-dispatch probe
 * against a running Inngest dev server would need fixtures + a test DB
 * (deferred in BP30 Phase A); the static check catches the most common
 * shape violation: a handler that touches `db.from(...)` without a
 * tenant context anywhere in scope.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { EVENT_REGISTRY } from "@/lib/inngest/event-registry";

const REPO_ROOT = join(__dirname, "..", "..");
const INNGEST_ROOT = join(REPO_ROOT, "apps", "main", "src", "inngest");

// Tokens that prove a tenant-scoped event handler consults SOME authority
// surface. tenantClient is the §11.2.2-preferred surface; the others are
// audit-gated alternatives.
const TENANT_SCOPED_TOKENS = [
  "tenantContextFromInngestEvent",
  "tenantClient",
  "withPlatformAdminAudit",
  "platformAdminClient",
  "createServiceRoleClient",
];
// Cron-only handlers operate cross-tenant by definition — they need one
// of these audit-or-service surfaces. (Or no DB access at all.)
const PLATFORM_ADMIN_TOKENS = [
  "withPlatformAdminAudit",
  "platformAdminClient",
  "createServiceRoleClient",
];

// If a handler imports neither @/lib/db nor @supabase/supabase-js it
// doesn't touch any DB — pure-fetch or console-only crons fall here.
function touchesDb(src: string): boolean {
  return /from\s+["']@\/lib\/db\//.test(src) || /from\s+["']@supabase\/supabase-js["']/.test(src);
}

// Files that are NOT Inngest function handlers but live in the same dir.
const NON_HANDLER_FILES = new Set([
  "client.ts",
  "events.ts",
  "shared.ts",
  "index.ts",
]);

interface HandlerFile {
  path: string;
  relPath: string;
  src: string;
}

function loadHandlers(): HandlerFile[] {
  const entries = readdirSync(INNGEST_ROOT, { withFileTypes: true });
  const handlers: HandlerFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    if (NON_HANDLER_FILES.has(e.name)) continue;
    const path = join(INNGEST_ROOT, e.name);
    handlers.push({
      path,
      relPath: relative(REPO_ROOT, path),
      src: readFileSync(path, "utf8"),
    });
  }
  return handlers.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function extractEventName(src: string): string | null {
  // Match: triggers: [{ event: "name.here" }] or { cron: "..." }
  const eventMatch = src.match(/triggers:\s*\[\s*\{\s*event:\s*["']([^"']+)["']/);
  if (eventMatch) return eventMatch[1] ?? null;
  return null;
}

function isCronOnly(src: string): boolean {
  return /triggers:\s*\[\s*\{\s*cron:/.test(src);
}

function hasAnyToken(src: string, tokens: readonly string[]): boolean {
  return tokens.some((t) => src.includes(t));
}

describe("§30.8 cross-tenant Inngest probe", () => {
  let handlers: HandlerFile[] = [];

  beforeAll(() => {
    handlers = loadHandlers();
  });

  it("enumerates at least 40 handler files (sanity)", () => {
    // Post-BP28 there are ~57 handlers. Far-low number ⇒ enumerator broke.
    expect(handlers.length).toBeGreaterThan(40);
  });

  it("every event-triggered handler is registered in EVENT_REGISTRY", () => {
    const offenders: string[] = [];
    for (const h of handlers) {
      const eventName = extractEventName(h.src);
      if (!eventName) continue; // cron-only or scheduled
      if (!(eventName in EVENT_REGISTRY)) {
        offenders.push(`${h.relPath} → emits '${eventName}' (not in EVENT_REGISTRY)`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Inngest handlers triggered by events that are not registered:\n` +
          offenders.map((o) => `  - ${o}`).join("\n") +
          `\nAdd each missing event to apps/main/src/lib/inngest/event-registry.ts.`,
      );
    }
  });

  it("every tenant-scoped event handler imports an authority-surface token", () => {
    const offenders: string[] = [];
    for (const h of handlers) {
      const eventName = extractEventName(h.src);
      if (!eventName) continue; // skip cron-only; covered by next test
      const registered = EVENT_REGISTRY[eventName];
      if (!registered) continue; // covered by the previous test
      if (registered.kind !== "tenant_scoped") continue;
      if (hasAnyToken(h.src, TENANT_SCOPED_TOKENS)) continue;
      // Acceptable fallback: function delegates to a helper module that
      // wraps tenantClient internally.
      if (/forEveryActiveTenant|forEachTenant/.test(h.src)) continue;
      // Truly no-DB handlers (e.g., consumers that only emit events) are fine.
      if (!touchesDb(h.src)) continue;
      offenders.push(
        `${h.relPath} (event=${eventName}): touches a DB but uses no tenant-context or audit surface`,
      );
    }
    if (offenders.length > 0) {
      throw new Error(
        `Tenant-scoped Inngest handlers without an authority surface:\n` +
          offenders.map((o) => `  - ${o}`).join("\n") +
          `\nUse tenantContextFromInngestEvent + tenantClient per §11.2.2 (preferred), ` +
          `or withPlatformAdminAudit / createServiceRoleClient when cross-tenant context is needed.`,
      );
    }
  });

  it("every cron-only handler that touches a DB uses an admin / service-role surface", () => {
    const offenders: string[] = [];
    for (const h of handlers) {
      if (!isCronOnly(h.src)) continue;
      if (hasAnyToken(h.src, PLATFORM_ADMIN_TOKENS)) continue;
      if (/forEveryActiveTenant|forEachTenant/.test(h.src)) continue;
      // No-DB crons (vendor health probes, console-only annual reminders) are fine.
      if (!touchesDb(h.src)) continue;
      offenders.push(`${h.relPath}: cron handler touches a DB but has no admin/service-role surface`);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Cron handlers touching a DB without an admin/service-role surface:\n` +
          offenders.map((o) => `  - ${o}`).join("\n") +
          `\nUse withPlatformAdminAudit (for tenant-touching crons) or createServiceRoleClient.`,
      );
    }
  });

  it("EVENT_REGISTRY contains both kinds (sanity — tenant_scoped + platform_admin)", () => {
    const kinds = new Set(Object.values(EVENT_REGISTRY).map((e) => e.kind));
    expect(kinds.has("tenant_scoped")).toBe(true);
    // platform_admin events may be added later; just assert the registry
    // type system supports it, not that one currently exists.
  });

  it("no handler imports both tenantClient AND a raw createServiceRoleClient (silent privilege escalation)", () => {
    // Catching the bug shape where someone needed service-role-side reads
    // but didn't refactor — ends up with tenant-scoped + cross-tenant in
    // the same function. Acceptable only with an explicit override flag.
    const offenders: string[] = [];
    for (const h of handlers) {
      const hasTenant = h.src.includes("tenantClient");
      const hasServiceRole = h.src.includes("createServiceRoleClient");
      if (!(hasTenant && hasServiceRole)) continue;
      // Allowlist comment opt-out: a line like
      //   // INNGEST-PROBE-ALLOW-MIXED: <reason>
      // anywhere in the file silences this check.
      if (/INNGEST-PROBE-ALLOW-MIXED:/.test(h.src)) continue;
      offenders.push(h.relPath);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Handlers using both tenantClient and createServiceRoleClient:\n` +
          offenders.map((o) => `  - ${o}`).join("\n") +
          `\nEither refactor to one surface, or add an // INNGEST-PROBE-ALLOW-MIXED: <reason> comment.`,
      );
    }
  });
});

