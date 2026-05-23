/**
 * §30.8 — Service-role-discipline lint is registered and active.
 *
 * BP26 added five rules to packages/eslint-plugin-atc and turned them on
 * (mostly at "error") in apps/main/.eslintrc.json. This test guards
 * against regression — if anyone silently disables a rule or removes the
 * plugin wiring, this fails.
 *
 * The actual rule behavior is exercised on every PR via `pnpm lint`.
 * That's the runtime gate; this test is the structural gate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const PLUGIN_PATH = join(REPO_ROOT, "packages", "eslint-plugin-atc", "index.js");
const ESLINTRC_PATH = join(REPO_ROOT, "apps", "main", ".eslintrc.json");

const REQUIRED_RULE_NAMES = [
  "no-direct-service-role-import",
  "no-direct-service-role-env-import",
  "platform-admin-functions-must-use-audit-wrapper",
  "no-direct-anthropic-or-openai-import",
  "no-money-math",
] as const;

describe("§30.8 service-role lint discipline", () => {
  it("packages/eslint-plugin-atc exports every required rule", () => {
    // Use require — the plugin is CommonJS.
    const plugin = require(PLUGIN_PATH) as { rules?: Record<string, unknown> };
    expect(plugin.rules).toBeDefined();
    const rules = plugin.rules ?? {};
    for (const name of REQUIRED_RULE_NAMES) {
      expect(rules, `eslint-plugin-atc must export rule '${name}'`).toHaveProperty(name);
    }
  });

  it("apps/main/.eslintrc.json activates each required rule", () => {
    const cfg = JSON.parse(readFileSync(ESLINTRC_PATH, "utf8")) as {
      rules?: Record<string, string | unknown>;
    };
    const rules = cfg.rules ?? {};
    for (const name of REQUIRED_RULE_NAMES) {
      const key = `atc/${name}`;
      const setting = rules[key];
      expect(setting, `apps/main/.eslintrc.json must reference 'atc/${name}'`).toBeDefined();
      // 'no-direct-anthropic-or-openai-import' is at "error" since BP27 ran;
      // 'no-ad-hoc-tenant-id-string' is the only deliberately-staged-off rule.
      // For these required ones, we expect "error".
      expect(setting, `atc/${name} must be at "error" severity`).toBe("error");
    }
  });

  it("no required rule is 'off' or downgraded to 'warn'", () => {
    const cfg = JSON.parse(readFileSync(ESLINTRC_PATH, "utf8")) as {
      rules?: Record<string, string | unknown>;
    };
    const rules = cfg.rules ?? {};
    const downgraded: string[] = [];
    for (const name of REQUIRED_RULE_NAMES) {
      const key = `atc/${name}`;
      const setting = rules[key];
      if (setting === "off" || setting === 0 || setting === "warn" || setting === 1) {
        downgraded.push(key);
      }
    }
    if (downgraded.length > 0) {
      throw new Error(
        `Required §30.8 lint rules are downgraded:\n` +
          downgraded.map((r) => `  - ${r}`).join("\n") +
          `\nThese rules guard the service-role / cost-attribution discipline. Restore to "error".`,
      );
    }
  });
});
