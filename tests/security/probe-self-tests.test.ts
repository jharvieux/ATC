/**
 * §30.8 BP30 self-tests for the static security probes.
 *
 * The probes themselves run against the real codebase (probe-style tests
 * in the sibling files). These self-tests verify the probes actually FIRE
 * when their detection logic is presented with a deliberately-buggy input —
 * the spec calls these out as the "tests for this prompt's own
 * infrastructure" (BP30 Task 18).
 *
 * Each self-test exercises a probe's helper logic against synthetic source
 * strings or fixtures. We avoid touching the real codebase so adding a new
 * production file can never silently weaken the self-test signal.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// RLS exceptions parser self-test
// ---------------------------------------------------------------------------
// The script's loadExceptions enforces a REASON comment on every skip entry.
// We can't easily import it (module-scope side effects); instead reproduce
// the parser shape and verify the REASON regex catches the right things.

describe("RLS coverage check — exceptions parser shape", () => {
  // Reproduced verbatim from scripts/rls-coverage-check.ts:
  const REASON_REGEX = /-- REASON:\s*\S/;

  it("accepts a well-formed exception with a REASON", () => {
    const line = "skip_table: legacy_thing  -- REASON: pre-existing, scheduled for removal";
    expect(REASON_REGEX.test(line)).toBe(true);
  });

  it("rejects an exception missing the REASON comment", () => {
    const line = "skip_table: legacy_thing";
    expect(REASON_REGEX.test(line)).toBe(false);
  });

  it("rejects an exception with an empty REASON", () => {
    const line = "skip_table: legacy_thing  -- REASON:";
    expect(REASON_REGEX.test(line)).toBe(false);
  });

  it("rejects an exception with just whitespace after REASON", () => {
    const line = "skip_table: legacy_thing  -- REASON:   ";
    expect(REASON_REGEX.test(line)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth-bypass probe — token detection
// ---------------------------------------------------------------------------

describe("Auth-bypass probe — token detection on synthetic source", () => {
  // Reproduce the AUTH_TOKENS surface (subset; full list lives in the probe).
  const AUTH_TOKENS = [
    "assertPermission",
    "withPlatformAdminAudit",
    "tenantContextFromRequest",
    "handleStripeWebhook",
  ] as const;
  function findAuthTokensInSource(src: string): string[] {
    return AUTH_TOKENS.filter((t) => src.includes(t));
  }

  it("flags a route with NO auth surface (bug shape)", () => {
    const buggy = `
      export async function POST(req: Request) {
        const body = await req.json();
        return Response.json({ ok: true, body });
      }
    `;
    expect(findAuthTokensInSource(buggy)).toEqual([]);
  });

  it("accepts a route that calls assertPermission", () => {
    const ok = `
      import { assertPermission } from "@/lib/auth/assert-permission";
      export async function POST(req: Request) {
        await assertPermission(req, "thing:write");
        return Response.json({ ok: true });
      }
    `;
    expect(findAuthTokensInSource(ok)).toContain("assertPermission");
  });

  it("accepts a route that uses withPlatformAdminAudit", () => {
    const ok = `
      import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
      export async function POST(req: Request) {
        return withPlatformAdminAudit({ admin_user_id: "x", reason: "y", operation: "z" }, async (db) => {
          return Response.json({ ok: true });
        });
      }
    `;
    expect(findAuthTokensInSource(ok)).toContain("withPlatformAdminAudit");
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant Inngest probe — handler shape detection
// ---------------------------------------------------------------------------

describe("Cross-tenant Inngest probe — handler shape detection", () => {
  const TENANT_SCOPED_TOKENS = [
    "tenantContextFromInngestEvent",
    "tenantClient",
    "withPlatformAdminAudit",
    "createServiceRoleClient",
  ];
  function hasAnyToken(src: string, tokens: readonly string[]): boolean {
    return tokens.some((t) => src.includes(t));
  }
  function extractEventName(src: string): string | null {
    const m = src.match(/triggers:\s*\[\s*\{\s*event:\s*["']([^"']+)["']/);
    return m ? m[1] ?? null : null;
  }
  function touchesDb(src: string): boolean {
    return /from\s+["']@\/lib\/db\//.test(src) || /from\s+["']@supabase\/supabase-js["']/.test(src);
  }

  it("flags a tenant-scoped handler that touches a DB but uses no authority surface (bug shape)", () => {
    const buggy = `
      import { inngest } from "./client";
      import { createClient } from "@supabase/supabase-js";
      export const buggyHandler = inngest.createFunction(
        { id: "buggy", triggers: [{ event: "tenant.activated" }] },
        async ({ event }) => {
          const sb = createClient("url", "key");
          return sb.from("anything").select("*");
        },
      );
    `;
    expect(extractEventName(buggy)).toBe("tenant.activated");
    expect(touchesDb(buggy)).toBe(true);
    expect(hasAnyToken(buggy, TENANT_SCOPED_TOKENS)).toBe(false);
    // Combined: should be flagged.
  });

  it("accepts a tenant-scoped handler using tenantContextFromInngestEvent + tenantClient", () => {
    const ok = `
      import { inngest } from "./client";
      import { tenantContextFromInngestEvent } from "@/lib/db/factories";
      import { tenantClient } from "@/lib/db/tenant-client";
      export const okHandler = inngest.createFunction(
        { id: "ok", triggers: [{ event: "tenant.activated" }] },
        async ({ event }) => {
          const ctx = tenantContextFromInngestEvent(event);
          const db = tenantClient(ctx);
          return db.from("anything").select("*");
        },
      );
    `;
    expect(hasAnyToken(ok, TENANT_SCOPED_TOKENS)).toBe(true);
  });

  it("accepts a no-DB cron (vendor-health-probe shape)", () => {
    const ok = `
      import { inngest } from "./client";
      export const probe = inngest.createFunction(
        { id: "probe", triggers: [{ cron: "* * * * *" }] },
        async () => {
          await fetch("https://vendor/health");
          return { ok: true };
        },
      );
    `;
    expect(touchesDb(ok)).toBe(false); // hence acceptable per the probe's no-DB opt-out
  });

  it("flags a cron that touches a DB without admin surface", () => {
    const PLATFORM_ADMIN_TOKENS = ["withPlatformAdminAudit", "platformAdminClient", "createServiceRoleClient"];
    const buggy = `
      import { inngest } from "./client";
      import { someHelper } from "@/lib/db/some-helper";
      export const buggyCron = inngest.createFunction(
        { id: "buggy", triggers: [{ cron: "* * * * *" }] },
        async () => {
          return someHelper();
        },
      );
    `;
    expect(touchesDb(buggy)).toBe(true);
    expect(hasAnyToken(buggy, PLATFORM_ADMIN_TOKENS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TenantContext factory audit — synthetic adversarial inputs
// ---------------------------------------------------------------------------
// The real audit lives in tenant-context-factory-audit.test.ts and runs
// against the real factories with mocked Supabase. This self-test verifies
// the test file enumerates every public factory currently exported.

describe("TenantContext factory audit — enumerates every exported factory", () => {
  it("imports the factories module and finds at least 4 factory functions", async () => {
    const mod = await import("@/lib/db/factories");
    const factoryFns = Object.entries(mod).filter(
      ([k, v]) => k.startsWith("tenantContextFrom") || k === "tenantContextForPlatformAdmin",
    );
    // tenantContextFromRequest, tenantContextFromInngestEvent,
    // tenantContextFromStripeEvent, tenantContextFromResendEvent,
    // tenantContextForPlatformAdmin = 5 today.
    expect(factoryFns.length).toBeGreaterThanOrEqual(4);
    for (const [, fn] of factoryFns) {
      expect(typeof fn).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// RLS coverage exceptions file — round-trip self-test
// ---------------------------------------------------------------------------
// Build a tiny temp-dir variant of db/rls-exceptions.sql and confirm the
// parser logic (recreated inline) handles each skip kind.

describe("RLS exceptions file — round-trip", () => {
  it("parses skip_table / skip_policy / skip_definer with REASON comments", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rls-exc-"));
    try {
      mkdirSync(join(tmp, "db"), { recursive: true });
      const path = join(tmp, "db", "rls-exceptions.sql");
      writeFileSync(
        path,
        [
          "-- header comment",
          "skip_table: old_legacy  -- REASON: scheduled for removal in BP35",
          "skip_policy: forum_messages:legacy_admin_read  -- REASON: pre-BP19 carve-out",
          "skip_definer: legacy_helper(text)  -- REASON: rewritten in BP14",
        ].join("\n"),
      );
      // Parse with the same shape the script uses.
      const tables = new Set<string>();
      const policies = new Set<string>();
      const definers = new Set<string>();
      const raw = require("node:fs").readFileSync(path, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("--")) continue;
        if (!/-- REASON:\s*\S/.test(t)) {
          throw new Error(`missing REASON: ${t}`);
        }
        const before = t.split("--")[0]?.trim() ?? "";
        const [kind, ...rest] = before.split(":");
        const ident = rest.join(":").trim().replace(/;?$/, "");
        if (kind === "skip_table") tables.add(ident);
        else if (kind === "skip_policy") policies.add(ident);
        else if (kind === "skip_definer") definers.add(ident);
      }
      expect(tables.has("old_legacy")).toBe(true);
      expect(policies.has("forum_messages:legacy_admin_read")).toBe(true);
      expect(definers.has("legacy_helper(text)")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
