// Shift-left guard batch (#1613) — behavior tests for the three new AST rules
// plus the no-money-math /100 display extension.
//
// Uses ESLint's RuleTester so each case proves the rule FIRES on a real
// violation and STAYS SILENT on the allowed shape — a module-shape smoke test
// can't catch a rule that silently matches nothing (stub-shaped, D-091 #1).

import { describe, it } from "vitest";
import type { RuleTester as RuleTesterType } from "eslint";

// "eslint" isn't reliably resolvable as a bare specifier from the root
// tests/ context under CI's pnpm hoisting; anchor the require to
// packages/config, which declares eslint as a devDependency — same reasoning
// as the require()s below.
type RuleTester = RuleTesterType;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RuleTester } = require(
  require.resolve("eslint", { paths: [require.resolve("../../packages/config/package.json")] }),
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const noDirectAuditLogWrite = require("../../packages/config/eslint-rules/no-direct-audit-log-write");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noLocalEscapeHtml = require("../../packages/config/eslint-rules/no-local-escape-html");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noInlineSupabaseClient = require("../../packages/config/eslint-rules/no-inline-supabase-client");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noMoneyMath = require("../../packages/config/eslint-rules/no-money-math");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noSecretShapedPublicEnv = require("../../packages/config/eslint-rules/no-secret-shaped-public-env");

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

// TS-syntax cases (`import type`, inline `type` specifiers) need the
// @typescript-eslint parser — espree can't parse them.
const tsTester = new RuleTester({
  languageOptions: {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    parser: require("@typescript-eslint/parser"),
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

// RuleTester.run throws on failure; wrap each in a vitest `it` so failures are
// attributed to the right rule.
function run(
  name: string,
  rule: unknown,
  cases: Parameters<RuleTester["run"]>[2],
  which: RuleTester = tester,
) {
  describe(name, () => {
    it("passes RuleTester valid/invalid cases", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      which.run(name, rule as any, cases);
    });
  });
}

run("no-direct-audit-log-write", noDirectAuditLogWrite, {
  valid: [
    // Reads are always fine.
    { code: `db.from("audit_log").select("id")`, filename: "src/lib/x/reader.ts" },
    // The consolidated writer is allowed.
    { code: `db.from("audit_log").insert(row)`, filename: "src/lib/audit/write.ts" },
    // The platform-admin write path is allowed.
    { code: `db.from("audit_log").insert(row)`, filename: "src/lib/db/platform-admin-client.ts" },
    // The retention purge is allowed.
    { code: `db.from("audit_log").delete()`, filename: "src/inngest/audit-log-retention-purge.ts" },
    // A different table's insert is untouched.
    { code: `db.from("other").insert(row)`, filename: "src/lib/x.ts" },
  ],
  invalid: [
    {
      code: `db.from("audit_log").insert(row)`,
      filename: "src/lib/cron/monitor.ts",
      errors: [{ messageId: "directWrite" }],
    },
    {
      code: `db.from("audit_log").delete().lt("occurred_at", cutoff)`,
      filename: "src/app/api/tenant/route.ts",
      errors: [{ messageId: "directWrite" }],
    },
  ],
});

run("no-local-escape-html", noLocalEscapeHtml, {
  valid: [
    // The canonical definition is exempt.
    { code: `export function escapeHtml(s) { return s; }`, filename: "src/lib/utils.ts" },
    // Importing / calling it is fine anywhere.
    { code: `import { escapeHtml } from "@/lib/utils"; escapeHtml(x);`, filename: "src/app/page.tsx" },
    // A differently-named helper is untouched.
    { code: `function escapeCsv(s) { return s; }`, filename: "src/lib/x.ts" },
  ],
  invalid: [
    {
      code: `function escapeHtml(s) { return s; }`,
      filename: "src/lib/report/render.ts",
      errors: [{ messageId: "localEscapeHtml" }],
    },
    {
      code: `const escapeHtml = (s) => s;`,
      filename: "src/lib/email/build.ts",
      errors: [{ messageId: "localEscapeHtml" }],
    },
  ],
});

run("no-inline-supabase-client", noInlineSupabaseClient, {
  valid: [
    // The factory itself may call createClient.
    { code: `import { createClient } from "@supabase/supabase-js";`, filename: "src/lib/db/supabase.ts" },
    // Type-only import of the client type is fine (constructs nothing).
    { code: `import type { SupabaseClient } from "@supabase/supabase-js";`, filename: "src/inngest/job.ts" },
    // Using the factory is the whole point.
    { code: `import { getRagDb } from "@/lib/db/supabase";`, filename: "src/inngest/job.ts" },
  ],
  invalid: [
    {
      code: `import { createClient } from "@supabase/supabase-js";`,
      filename: "src/inngest/new-job.ts",
      errors: [{ messageId: "inlineClient" }],
    },
    {
      code: `import { createClient, type SupabaseClient } from "@supabase/supabase-js";`,
      filename: "src/app/api/new-route/route.ts",
      errors: [{ messageId: "inlineClient" }],
    },
  ],
}, tsTester);

run("no-secret-shaped-public-env", noSecretShapedPublicEnv, {
  valid: [
    // The two names that ARE public by design (allowlisted).
    { code: `const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;` },
    { code: `const k = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;` },
    // A legit NEXT_PUBLIC_ name with no credential shape.
    { code: `const u = process.env.NEXT_PUBLIC_BASE_URL;` },
    { code: `const f = process.env.NEXT_PUBLIC_FEATURE_FLAG_X;` },
    // Secret-shaped but NOT NEXT_PUBLIC_ — server var, not this rule's concern.
    { code: `const s = process.env.STRIPE_SECRET_KEY;` },
    // Allowlisted name via bracket access.
    { code: `const k = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];` },
  ],
  invalid: [
    {
      code: `const k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;`,
      errors: [{ messageId: "secretShaped" }],
    },
    {
      code: `const k = process.env.NEXT_PUBLIC_ADMIN_SECRET;`,
      errors: [{ messageId: "secretShaped" }],
    },
    {
      code: `const k = process.env.NEXT_PUBLIC_SLACK_TOKEN;`,
      errors: [{ messageId: "secretShaped" }],
    },
    // Computed bracket access is flagged too.
    {
      code: `const k = process.env["NEXT_PUBLIC_SERVICE_ROLE_KEY"];`,
      errors: [{ messageId: "secretShaped" }],
    },
  ],
});

run("no-money-math (/100 display extension)", noMoneyMath, {
  valid: [
    // fromCents-style helper, no manual division.
    { code: `const dollars = fromCents(price_cents);` },
    // Division of a non-money identifier is fine.
    { code: `const avg = total_count / 100;` },
    // Dividing by a different literal is not the display bypass.
    { code: `const x = fee_cents / 1000;` },
  ],
  invalid: [
    {
      code: `const dollars = amount_cents / 100;`,
      errors: [{ messageId: "noCentsDivDisplay" }],
    },
    {
      code: `const usd = total_amount / 100;`,
      errors: [{ messageId: "noCentsDivDisplay" }],
    },
  ],
});
