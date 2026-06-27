// Unit tests for the server-only leak guard (M9 / audit-service).
//
// Intent: a server-exclusive importable module (reads a secret / uses the
// service-role client) that omits `import 'server-only'` can be transitively
// bundled to the browser — flag it. Must NOT fire on app/ route|page files
// (server-only by location), tests, or modules with the poison-pill present.

import { describe, it, expect } from "vitest";
import { isServerExclusiveLeakRisk } from "../../../scripts/check-server-only";

const SR = `import { createServiceRoleClient } from "@/lib/db/service-role-client";`;
const SECRET = `const k = process.env.STRIPE_SECRET_KEY;`;

describe("isServerExclusiveLeakRisk", () => {
  it("flags a lib module using the service-role client without server-only", () => {
    expect(isServerExclusiveLeakRisk("apps/main/src/lib/db/rag-read.ts", SR)).toBe(true);
  });

  it("flags a lib module reading a *_SECRET* env without server-only", () => {
    expect(isServerExclusiveLeakRisk("apps/main/src/lib/billing/x.ts", SECRET)).toBe(true);
  });

  it("passes when the module imports 'server-only'", () => {
    expect(isServerExclusiveLeakRisk("apps/main/src/lib/db/rag-read.ts", `import 'server-only';\n${SR}`)).toBe(false);
  });

  it("does NOT fire on app/ route|page files (server-only by location)", () => {
    expect(isServerExclusiveLeakRisk("apps/main/src/app/api/x/route.ts", SR)).toBe(false);
    expect(isServerExclusiveLeakRisk("apps/main/src/app/dashboard/page.tsx", SECRET)).toBe(false);
  });

  it("does NOT fire on test / fixture files", () => {
    expect(isServerExclusiveLeakRisk("apps/main/src/lib/db/x.test.ts", SR)).toBe(false);
    expect(isServerExclusiveLeakRisk("apps/main/src/lib/__tests__/x.ts", SR)).toBe(false);
  });

  it("does NOT fire on a module with no secret / service-role reference", () => {
    expect(isServerExclusiveLeakRisk("apps/main/src/lib/util/format.ts", `export const f = (x:number)=>x+1;`)).toBe(false);
  });

  it("ignores non-ts files", () => {
    expect(isServerExclusiveLeakRisk("apps/main/src/lib/x.json", SR)).toBe(false);
  });
});
