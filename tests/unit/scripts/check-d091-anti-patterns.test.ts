// #815 — unit tests for the mechanical D-091 anti-pattern detectors.
//
// Each test pins WHY the detector exists: it must catch the real anti-pattern,
// must NOT fire on the safe form, and must honor the inline `d091-allow:<id>`
// escape hatch. These are the deterministic backstops for what the probabilistic
// d091-reviewer subagent misses.

import { describe, it, expect } from "vitest";
import {
  detectSecretEq,
  detectUnboundedLimit,
  detectEventDataCast,
  detectCasRowcount,
  detectServiceRoleTenant,
  computeNewViolations,
} from "../../../scripts/check-d091-anti-patterns";

const L = (s: string) => s.split("\n");

describe("detectSecretEq (3)", () => {
  it("flags === on a secret/token-shaped var", () => {
    const v = detectSecretEq("f.ts", L(`if (providedToken === expected) ok();`));
    expect(v.map((x) => x.id)).toEqual(["secret-eq"]);
  });
  it("does NOT flag a null/undefined existence check", () => {
    expect(detectSecretEq("f.ts", L(`if (apiKey === null) throw new Error("missing");`))).toEqual([]);
  });
  it("honors the inline escape hatch", () => {
    expect(detectSecretEq("f.ts", L(`if (token === other) ok(); // d091-allow:secret-eq not a secret, a route token id`))).toEqual([]);
  });
  it("catches the secret on the RIGHT side too", () => {
    expect(detectSecretEq("f.ts", L(`if (provided === expectedToken) ok();`)).map((x) => x.id)).toEqual(["secret-eq"]);
  });
});

describe("detectUnboundedLimit (4)", () => {
  it("flags .limit() above the 1000-row PostgREST cap", () => {
    expect(detectUnboundedLimit("f.ts", L(`q.limit(2000)`)).map((x) => x.id)).toEqual(["unbounded-limit"]);
  });
  it("does NOT flag a bounded limit", () => {
    expect(detectUnboundedLimit("f.ts", L(`q.limit(500)`))).toEqual([]);
  });
  it("does NOT flag exactly the 1000 cap (boundary)", () => {
    expect(detectUnboundedLimit("f.ts", L(`q.limit(1000)`))).toEqual([]);
  });
});

describe("detectEventDataCast (5)", () => {
  it("flags an Inngest event.data cast with no Zod parse in the file", () => {
    const v = detectEventDataCast("apps/main/src/inngest/x.ts", L(`const p = event.data as Payload;\nawait run(p);`));
    expect(v.map((x) => x.id)).toEqual(["event-data-cast"]);
  });
  it("does NOT flag when the file Zod-parses event.data", () => {
    expect(detectEventDataCast("apps/main/src/inngest/x.ts", L(`const p = Schema.parse(event.data);\nconst q = event.data as Payload;`))).toEqual([]);
  });
  it("STILL flags when an UNRELATED .parse() is present — only a parse OF event.data validates it", () => {
    const v = detectEventDataCast("apps/main/src/inngest/x.ts", L(`const r = LlmSchema.parse(llmOutput);\nconst p = event.data as Payload;`));
    expect(v.map((x) => x.id)).toEqual(["event-data-cast"]);
  });
  it("only applies to inngest files", () => {
    expect(detectEventDataCast("apps/main/src/lib/x.ts", L(`const p = event.data as Payload;`))).toEqual([]);
  });
});

describe("detectCasRowcount (2)", () => {
  it("flags a status-guarded update with no row-count check", () => {
    const v = detectCasRowcount("f.ts", L(`await db.from("quotes").update({ status: "accepted" }).eq("id", id).eq("status", "pending");`));
    expect(v.map((x) => x.id)).toEqual(["cas-rowcount"]);
  });
  it("does NOT flag when the update verifies the affected rows (.select)", () => {
    expect(detectCasRowcount("f.ts", L(`const { data } = await db.from("quotes").update({ status: "accepted" }).eq("id", id).eq("status", "pending").select("id");`))).toEqual([]);
  });
  it("does NOT flag a plain (non-status) update", () => {
    expect(detectCasRowcount("f.ts", L(`await db.from("quotes").update({ title: t }).eq("id", id);`))).toEqual([]);
  });
});

describe("detectServiceRoleTenant (1)", () => {
  const svc = (q: string) => L(`const db = createServiceRoleClient();\n${q}`);
  it("flags a filtered service-role query on a tenant table with no tenant_id", () => {
    const v = detectServiceRoleTenant("f.ts", svc(`await db.from("bookings").select("*").eq("id", id);`));
    expect(v.map((x) => x.id)).toEqual(["service-role-tenant"]);
  });
  it("does NOT flag when tenant_id is in the chain", () => {
    expect(detectServiceRoleTenant("f.ts", svc(`await db.from("bookings").select("*").eq("id", id).eq("tenant_id", t);`))).toEqual([]);
  });
  it("does NOT flag a platform-scoped table", () => {
    expect(detectServiceRoleTenant("f.ts", svc(`await db.from("platform_settings").select("*").eq("id", id);`))).toEqual([]);
  });
  it("does NOT fire outside service-role files", () => {
    expect(detectServiceRoleTenant("f.ts", L(`await db.from("bookings").select("*").eq("id", id);`))).toEqual([]);
  });
  it("honors the inline escape hatch", () => {
    expect(detectServiceRoleTenant("f.ts", svc(`// d091-allow:service-role-tenant platform-scoped read, no tenant column\nawait db.from("bookings").select("*").eq("id", id);`))).toEqual([]);
  });
  it("flags a module that RECEIVES the client as a SupabaseClient-typed parameter (#1023)", () => {
    const v = detectServiceRoleTenant(
      "f.ts",
      L(`async function persist(svc: SupabaseClient, id: string) {\n  await svc.from("messages").update({ x: 1 }).eq("id", id);\n}`),
    );
    expect(v.map((x) => x.id)).toEqual(["service-role-tenant"]);
  });
  it("honors the escape hatch on the SupabaseClient-param gate path too", () => {
    const v = detectServiceRoleTenant(
      "f.ts",
      L(`async function persist(svc: SupabaseClient, id: string) {\n  // d091-allow:service-role-tenant RLS-backed client, tenant scoping enforced by policy\n  await svc.from("messages").update({ x: 1 }).eq("id", id);\n}`),
    );
    expect(v).toEqual([]);
  });
});

describe("computeNewViolations — count-based baseline", () => {
  const V = (snippet: string, line = 1) => ({ id: "secret-eq", file: "f.ts", line, snippet, why: "" });
  const KEY = "f.ts\tsecret-eq\ttok === x";

  it("allows occurrences up to the baselined count", () => {
    const baseline = new Map([[KEY, 2]]);
    expect(computeNewViolations([V("tok === x", 1), V("tok === x", 2)], baseline)).toEqual([]);
  });

  it("flags a NEW duplicate of a baselined line beyond its count (the WARNING-1 fix)", () => {
    const baseline = new Map([[KEY, 1]]);
    const out = computeNewViolations([V("tok === x", 1), V("tok === x", 2)], baseline);
    expect(out).toHaveLength(1); // the 2nd occurrence is new
  });

  it("flags an entirely unbaselined hit", () => {
    expect(computeNewViolations([V("brand new")], new Map())).toHaveLength(1);
  });
});
