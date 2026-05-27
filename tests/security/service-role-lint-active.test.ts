/**
 * §30.8 — Service-role-discipline lint is registered and active.
 *
 * BP26 added five rules to packages/eslint-plugin-atc and turned them on
 * (mostly at "error") in apps/main's ESLint config. This test guards
 * against regression — if anyone silently disables a rule or removes the
 * plugin wiring, this fails.
 *
 * The actual rule behavior is exercised on every PR via `pnpm lint`.
 * That's the runtime gate; this test is the structural gate.
 *
 * Next 16 migration: apps/main moved from .eslintrc.json to flat config
 * (eslint.config.mjs). This test now imports the flat config and looks
 * for the atc/* rule activations in any config block.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const PLUGIN_PATH = join(REPO_ROOT, "packages", "eslint-plugin-atc", "index.js");
const FLAT_CONFIG_PATH = join(REPO_ROOT, "apps", "main", "eslint.config.mjs");

const REQUIRED_RULE_NAMES = [
  "no-direct-service-role-import",
  "no-direct-service-role-env-import",
  "platform-admin-functions-must-use-audit-wrapper",
  "no-direct-anthropic-or-openai-import",
  "no-money-math",
] as const;

type FlatConfigBlock = {
  files?: string[];
  rules?: Record<string, unknown>;
};

async function loadFlatConfig(): Promise<FlatConfigBlock[]> {
  const mod = (await import(FLAT_CONFIG_PATH)) as { default: FlatConfigBlock[] };
  return mod.default;
}

function collectRuleSettings(
  blocks: FlatConfigBlock[],
  ruleKey: string,
): Array<{ value: unknown; blockIndex: number }> {
  const hits: Array<{ value: unknown; blockIndex: number }> = [];
  blocks.forEach((b, i) => {
    if (b.rules && ruleKey in b.rules) {
      hits.push({ value: b.rules[ruleKey], blockIndex: i });
    }
  });
  return hits;
}

describe("§30.8 service-role lint discipline", () => {
  it("packages/eslint-plugin-atc exports every required rule", () => {
    const plugin = require(PLUGIN_PATH) as { rules?: Record<string, unknown> };
    expect(plugin.rules).toBeDefined();
    const rules = plugin.rules ?? {};
    for (const name of REQUIRED_RULE_NAMES) {
      expect(rules, `eslint-plugin-atc must export rule '${name}'`).toHaveProperty(name);
    }
  });

  it("apps/main/eslint.config.mjs activates each required rule at 'error'", async () => {
    const blocks = await loadFlatConfig();
    for (const name of REQUIRED_RULE_NAMES) {
      const key = `atc/${name}`;
      const settings = collectRuleSettings(blocks, key);
      expect(settings.length, `apps/main/eslint.config.mjs must reference '${key}'`).toBeGreaterThan(0);
      // Last write wins in flat config — take the last setting.
      const lastSetting = settings[settings.length - 1]!.value;
      expect(lastSetting, `${key} must be at 'error' severity`).toBe("error");
    }
  });

  it("no required rule is 'off' or downgraded to 'warn'", async () => {
    const blocks = await loadFlatConfig();
    const downgraded: string[] = [];
    for (const name of REQUIRED_RULE_NAMES) {
      const key = `atc/${name}`;
      const settings = collectRuleSettings(blocks, key);
      // Look at the LAST setting (flat-config semantics — later blocks override).
      const lastSetting = settings[settings.length - 1]?.value;
      if (lastSetting === "off" || lastSetting === 0 || lastSetting === "warn" || lastSetting === 1) {
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
