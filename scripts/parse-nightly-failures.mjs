#!/usr/bin/env node
// nightly-full-test.yml (#1833) extracts failing-test detail from the vitest
// JSON reporter and the unhandled-error banner from vitest's teed console
// output, then embeds both into a GitHub issue body — and this repo is
// PUBLIC. Actions' built-in secret-masking only scrubs its own log stream;
// it never touches files vitest/tee wrote to disk or the gh-api request body
// built from those files, so a raw postgres:// connection string or Bearer
// token surfacing in a stack trace would leak straight into a public issue
// (#1851 audit finding 1). This script owns the parsing AND the redaction
// pass so nothing unredacted reaches the issue body, and pins both behind
// tests/unit/scripts/parse-nightly-failures.test.ts (#1851 audit finding 2 —
// the extractors previously lived inline in the workflow's `run:` blocks
// with no test coverage).
//
// CLI: node scripts/parse-nightly-failures.mjs [report.json] [console.log] [failing-list-out] [unhandled-section-out]
// Writes the redacted failing-test list and unhandled-error section to the
// given output files for the workflow to `cat` into the issue body.

import { readFileSync, existsSync, writeFileSync } from "node:fs";

// Not reusing scripts/lib/redact-secrets.ts here: that helper takes an
// Error/unknown and returns `[redacted]`-bracketed text for internal CI-log
// crash handlers (#1784). This redacts plain extracted strings destined for
// a PUBLIC issue body and additionally scrubs exact known-env-value matches
// (#1851 finding 1) — different input shape and a stricter output contract.
const CONN_STRING = /postgres(ql)?:\/\/[^ @]*@/gi;
const BEARER_TOKEN = /Bearer\s+\S+/gi;
const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const UNHANDLED_BANNER_LINE = /Vitest caught .* unhandled error/i;
const UNHANDLED_CONTEXT_LINES = 60;
const UNHANDLED_MAX_CHARS = 4000;

// env vars on nightly-full-test.yml's `full-test` job (job-level `env:`
// block) that can carry a live credential. Redacted by exact-value match in
// addition to the shape-based regexes above, so a secret with no
// postgres:// or Bearer wrapper (e.g. a bare API key) still gets caught.
export const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_RAG_DB_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

export function redact(text, env = process.env) {
  let out = text.replace(CONN_STRING, "postgres://REDACTED@").replace(BEARER_TOKEN, "Bearer REDACTED");
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    // Placeholders/short values aren't real secrets, and a short value risks
    // matching unrelated substrings — skip them.
    if (!value || value.length < 8) continue;
    out = out.split(value).join(`[REDACTED:${name}]`);
  }
  return out;
}

export function extractFailingList(reportJsonText) {
  const r = JSON.parse(reportJsonText);
  const failing = [];
  for (const tr of r.testResults || []) {
    const failedAssertions = (tr.assertionResults || []).filter((a) => a.status === "failed");
    for (const a of failedAssertions) {
      const full = [...(a.ancestorTitles || []), a.title].join(" › ");
      failing.push("- `" + tr.name + "` › " + full);
    }
    if (tr.status === "failed" && failedAssertions.length === 0) {
      const msg = (tr.message || "").split("\n")[0].slice(0, 300) || "(no message captured)";
      failing.push("- `" + tr.name + "` — suite failed: " + msg);
    }
  }
  return failing.length ? failing.join("\n") : "(no per-test detail captured; see run logs)";
}

export function extractUnhandledSection(consoleLogText) {
  const lines = consoleLogText.replace(ANSI, "").split("\n");
  const startIdx = lines.findIndex((l) => UNHANDLED_BANNER_LINE.test(l));
  if (startIdx === -1) return "";
  const unhandled = lines
    .slice(startIdx, startIdx + 1 + UNHANDLED_CONTEXT_LINES)
    .join("\n")
    .slice(0, UNHANDLED_MAX_CHARS);
  return `\n**Unhandled errors (console output)**:\n\`\`\`\n${unhandled}\n\`\`\`\n`;
}

function main() {
  const [, , reportPath = "vitest-report.json", consoleLogPath = "vitest-console.log", failingOut = "nightly-failing-list.md", unhandledOut = "nightly-unhandled-section.md"] =
    process.argv;

  const failingList = existsSync(reportPath) ? extractFailingList(readFileSync(reportPath, "utf-8")) : "(no JSON report; see run logs)";

  const unhandledSection = existsSync(consoleLogPath) ? extractUnhandledSection(readFileSync(consoleLogPath, "utf-8")) : "";

  writeFileSync(failingOut, redact(failingList));
  writeFileSync(unhandledOut, redact(unhandledSection));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
