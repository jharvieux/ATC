// #851 PR3 — proactive model canary.
//
// Pings every configured model (a 1-token call) so a retired/unavailable model
// surfaces BEFORE a customer hits it. A 1-token call is the real "is it usable"
// check — unlike GET /v1/models, it works for undated aliases (which Anthropic
// does not list). Used by the daily cron AND the deploy/CI gate, so a config
// referencing a retired model can't ship or silently rot.
//
// fetch-based on purpose: this file is not the call-wrapper, so it must not import
// the Anthropic SDK (atc/no-direct-anthropic-or-openai-import). Inject `fetchImpl`
// in tests.

import { allConfiguredModels } from "./models";

export interface ModelCanaryFailure {
  model: string;
  status: number | "error";
  detail: string;
}

export interface ModelCanaryResult {
  checked: string[];
  failures: ModelCanaryFailure[];
}

export async function runModelCanary(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCanaryResult> {
  const models = allConfiguredModels();
  const failures: ModelCanaryFailure[] = [];

  for (const model of models) {
    try {
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        failures.push({ model, status: res.status, detail: detail.slice(0, 200) });
      }
    } catch (err) {
      failures.push({ model, status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return { checked: models, failures };
}
