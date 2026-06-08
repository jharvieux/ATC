// #851 PR3 — deploy/CI gate: refuse to ship a config that references a
// retired/unavailable Anthropic model.
//
// Self-guards: if ANTHROPIC_API_KEY isn't set (e.g. CI without the key
// provisioned), it SKIPS (exit 0) so it can't block on a missing secret — it
// activates automatically once the key exists. With the key, a configured model
// that fails a 1-token ping exits non-zero and fails the deploy.

import { runModelCanary } from "../apps/main/src/lib/ai/model-canary";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[check-models-live] ANTHROPIC_API_KEY not set — skipping model canary gate");
    return;
  }

  const { checked, failures } = await runModelCanary(apiKey);
  if (failures.length > 0) {
    console.error(`[check-models-live] ${failures.length}/${checked.length} configured models FAILED:`);
    for (const f of failures) console.error(`  ${f.model} [${f.status}]: ${f.detail}`);
    console.error("Update the chains in apps/main/src/lib/ai/models.ts before deploying.");
    process.exit(1);
  }
  console.log(`[check-models-live] OK — all ${checked.length} configured models reachable`);
}

main().catch((err) => {
  console.error("[check-models-live] unexpected error:", err);
  process.exit(1);
});
