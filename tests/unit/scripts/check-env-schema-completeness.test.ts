// Unit tests — env-schema completeness guard (D-091 #28 mechanical half,
// refs #2002/#2004). Intent: a raw process.env read of an identifier absent
// from the app's env schema bypasses boot validation and the secret inventory
// (the MAIN_APP_ADMIN_API_KEY class) — declared reads and platform runtime
// vars must stay silent so the gate points only at genuinely unregistered vars.
import { describe, it, expect } from "vitest";
import { declaredKeys, findUndeclaredReads, loadBaseline } from "../../../scripts/check-env-schema-completeness";

const ENV_TS = `
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  STRIPE_SECRET_KEY: z.string().regex(/^sk_(test|live)_/),
  SERVICE_JWT_KEY_ID_CURRENT: z.string().min(1),
});
`;

describe("declaredKeys", () => {
  it("parses the schema object's uppercase property names", () => {
    expect([...declaredKeys(ENV_TS)].sort()).toEqual(["NODE_ENV", "SERVICE_JWT_KEY_ID_CURRENT", "STRIPE_SECRET_KEY"]);
  });
});

describe("findUndeclaredReads", () => {
  const declared = declaredKeys(ENV_TS);
  const F = "apps/main/src/lib/pay.ts";

  it("flags a process.env read of an undeclared identifier (the #2002 class)", () => {
    const r = findUndeclaredReads("main", F, `const k = process.env.MAIN_APP_ADMIN_API_KEY;`, declared);
    expect(r).toHaveLength(1);
    expect(r[0]!.key).toBe("main::MAIN_APP_ADMIN_API_KEY");
  });

  it("clears a declared read", () => {
    expect(findUndeclaredReads("main", F, `const k = process.env.STRIPE_SECRET_KEY;`, declared)).toEqual([]);
  });

  it("clears platform runtime vars (VERCEL_ENV, CI, …) — not app configuration", () => {
    expect(findUndeclaredReads("main", F, `if (process.env.VERCEL_ENV === "production") {}`, declared)).toEqual([]);
  });

  it("skips test files", () => {
    expect(findUndeclaredReads("main", "apps/main/src/lib/pay.test.ts", `process.env.WHATEVER_KEY`, declared)).toEqual([]);
  });

  it("catches multiple reads on one line", () => {
    const r = findUndeclaredReads("main", F, `const a = process.env.FOO_KEY ?? process.env.BAR_KEY;`, declared);
    expect(r.map((f) => f.varName).sort()).toEqual(["BAR_KEY", "FOO_KEY"]);
  });
});

describe("loadBaseline", () => {
  it("returns an empty map for a missing file (fail-closed)", () => {
    expect(loadBaseline("/nonexistent/env-baseline-2002.txt")).toEqual(new Map());
  });
});
