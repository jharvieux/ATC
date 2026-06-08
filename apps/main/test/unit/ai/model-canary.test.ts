// #851 PR3 — model canary: pings every configured model so a retired one is
// caught before a customer hits it. fetch is injected so these stay offline.

import { describe, it, expect, vi } from "vitest";
import { runModelCanary } from "@/lib/ai/model-canary";
import { allConfiguredModels } from "@/lib/ai/models";

function fakeRes(ok: boolean, status: number, body = ""): Response {
  return { ok, status, text: async () => body } as unknown as Response;
}

describe("runModelCanary", () => {
  it("pings every configured model and reports no failures when all return ok", async () => {
    const f = vi.fn(async () => fakeRes(true, 200));
    const r = await runModelCanary("sk-test", f as unknown as typeof fetch);
    expect(r.checked).toEqual(allConfiguredModels());
    expect(r.failures).toEqual([]);
    expect(f.mock.calls.length).toBe(allConfiguredModels().length);
  });

  it("records a failure with status + detail when a model returns non-200 (retired)", async () => {
    const bad = allConfiguredModels()[0]!;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      return body.includes(`"${bad}"`)
        ? fakeRes(false, 404, "not_found_error: model retired")
        : fakeRes(true, 200);
    });
    const r = await runModelCanary("sk-test", f as unknown as typeof fetch);
    expect(r.failures).toEqual([
      { model: bad, status: 404, detail: expect.stringContaining("not_found") },
    ]);
  });

  it("records an 'error' failure when the fetch itself throws", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    const r = await runModelCanary("sk-test", f as unknown as typeof fetch);
    expect(r.failures.length).toBe(allConfiguredModels().length);
    expect(r.failures[0]).toMatchObject({ status: "error", detail: "network down" });
  });

  it("uses a 1-token messages-endpoint request with the api key header", async () => {
    const f = vi.fn(async () => fakeRes(true, 200));
    await runModelCanary("sk-test", f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(String(init.body)).max_tokens).toBe(1);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
  });
});
