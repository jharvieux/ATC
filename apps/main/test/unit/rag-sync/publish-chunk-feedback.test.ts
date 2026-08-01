// §6.10 — publish-chunk-feedback helper tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacHexSign } from "@atc/contracts";
import { publishChunkFeedback } from "../../../src/lib/rag-sync/publish-chunk-feedback";

const ORIG_ENV = {
  RAG_SERVICE_URL: process.env.RAG_SERVICE_URL,
  RAG_WEBHOOK_SECRET: process.env.RAG_WEBHOOK_SECRET,
};

beforeEach(() => {
  process.env.RAG_SERVICE_URL = "https://rag.test/";
  process.env.RAG_WEBHOOK_SECRET = "test-secret";
  delete process.env.RAG_WEBHOOK_SECRET_CURRENT;
});

afterEach(() => {
  process.env.RAG_SERVICE_URL = ORIG_ENV.RAG_SERVICE_URL;
  process.env.RAG_WEBHOOK_SECRET = ORIG_ENV.RAG_WEBHOOK_SECRET;
  delete process.env.RAG_WEBHOOK_SECRET_CURRENT;
  vi.restoreAllMocks();
});

describe("publishChunkFeedback", () => {
  it("returns { ok: true } and skips fetch when chunk_ids is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const result = await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      chunk_ids: [],
    });
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns { ok: false } when env is not configured", async () => {
    delete process.env.RAG_SERVICE_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const result = await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      chunk_ids: ["chunk-1"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rag_env_not_set");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to RAG with HMAC signature header and JSON body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      raw_weight: 1.5,
      chunk_ids: ["chunk-1", "chunk-2"],
    });
    expect(result.ok).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://rag.test/api/feedback");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-webhook-signature"]).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      message_id: "msg-1",
      signal_direction: "up",
      raw_weight: 1.5,
      chunk_ids: ["chunk-1", "chunk-2"],
    });
  });

  it("signs with RAG_WEBHOOK_SECRET_CURRENT, not the legacy var, when both are set (#2004 rotation)", async () => {
    process.env.RAG_WEBHOOK_SECRET_CURRENT = "rotated-secret";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      chunk_ids: ["chunk-1"],
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(headers["x-webhook-signature"]).toBe(await hmacHexSign("rotated-secret", body));
    expect(headers["x-webhook-signature"]).not.toBe(await hmacHexSign("test-secret", body));
  });

  it("defaults raw_weight to 1.0 when omitted", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "down",
      chunk_ids: ["chunk-1"],
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.raw_weight).toBe(1.0);
  });

  it("caps chunk_ids to first 20 even if more provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const manyIds = Array.from({ length: 30 }, (_, i) => `chunk-${i}`);
    await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      chunk_ids: manyIds,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.chunk_ids).toHaveLength(20);
    expect(body.chunk_ids[0]).toBe("chunk-0");
    expect(body.chunk_ids[19]).toBe("chunk-19");
  });

  it("returns { ok: false } with status reason on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("server error", { status: 500 }),
    );
    const result = await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      chunk_ids: ["chunk-1"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rag_returned_500");
  });

  it("returns { ok: false } when fetch throws (network failure)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      chunk_ids: ["chunk-1"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("trims trailing slashes on RAG_SERVICE_URL", async () => {
    process.env.RAG_SERVICE_URL = "https://rag.test/////";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await publishChunkFeedback({
      message_id: "msg-1",
      signal_direction: "up",
      chunk_ids: ["chunk-1"],
    });
    const url = fetchSpy.mock.calls[0]![0];
    expect(url).toBe("https://rag.test/api/feedback");
  });
});
