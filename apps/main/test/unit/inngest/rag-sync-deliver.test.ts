// §8.7 / §8.7a (#1609) — rag-sync-deliver: the Inngest function that owns RAG
// webhook delivery after the in-request retry sleeps + pending_rag_sync cron
// were retired.
//
// Intent under test (WHY, not just call-shape):
//   1. A delivery is a pure signed POST of the event — so a duplicate delivery
//      re-POSTs the identical body/signature, which the revision-guarded RAG
//      consumer collapses to ONE effect (idempotent replay).
//   2. A transient failure BEFORE the ladder is exhausted must re-throw, so
//      Inngest schedules the next retry (the backoff the old cron provided).
//   3. Exhausting the ladder must ALERT (not silently drop) and stop throwing,
//      leaving the nightly reconcile as the durable backstop.
//   4. Missing RAG config must NOT drop the event — it throws so Inngest keeps
//      retrying until config is restored.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { hmacHexSign, type TenantEvent, type PlatformEvent } from "@atc/contracts";

// createFunction returns the raw handler so we can invoke it directly.
vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (_cfg: unknown, handler: unknown) => handler },
}));

const alertMock = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined));
vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: alertMock,
}));

import { ragSyncDeliver } from "@/inngest/rag-sync-deliver";

const handler = ragSyncDeliver as unknown as (arg: {
  event: { name: string; data: unknown };
  attempt: number;
}) => Promise<unknown>;

const SECRET = "test-secret";
const TENANT_EVENT: TenantEvent = {
  event_type: "tenant.status_changed",
  tenant_id: "11111111-1111-1111-1111-111111111111",
  source_revision: 1_780_000_000,
  payload: { status: "active", tenant_type: "byo_host", display_name: "Lisa Travel" },
};
const PLATFORM_EVENT: PlatformEvent = {
  event_type: "platform_settings.updated",
  source_revision: 1_780_000_001,
  payload: { changes: [{ key: "feedback_adjustment_limit", value: 0.1 }] },
};

const ORIG = { url: process.env.RAG_SERVICE_URL, secret: process.env.RAG_WEBHOOK_SECRET };
let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;

beforeEach(() => {
  process.env.RAG_SERVICE_URL = "https://rag.example.com/";
  process.env.RAG_WEBHOOK_SECRET = SECRET;
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  alertMock.mockClear();
});
afterEach(() => {
  process.env.RAG_SERVICE_URL = ORIG.url;
  process.env.RAG_WEBHOOK_SECRET = ORIG.secret;
  vi.unstubAllGlobals();
});

describe("ragSyncDeliver — routing + signing", () => {
  it("POSTs a tenant event to /api/tenant-events with a valid HMAC signature", async () => {
    await handler({ event: { name: "rag-sync/tenant.event", data: { event: TENANT_EVENT } }, attempt: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://rag.example.com/api/tenant-events");
    const body = opts.body as string;
    const sig = (opts.headers as Record<string, string>)["x-webhook-signature"];
    // Signature must be the HMAC of the exact body the consumer will verify.
    expect(sig).toBe(await hmacHexSign(SECRET, body));
    expect(JSON.parse(body)).toEqual(TENANT_EVENT);
  });

  it("signs with RAG_WEBHOOK_SECRET_CURRENT when set (#2004 rotation set)", async () => {
    // During a rotation the signer must move to the new secret immediately —
    // the rag verifier accepts both, so signing with the old one would mask a
    // half-finished rotation.
    process.env.RAG_WEBHOOK_SECRET_CURRENT = "rotated-current-secret";
    try {
      await handler({ event: { name: "rag-sync/tenant.event", data: { event: TENANT_EVENT } }, attempt: 0 });
      const [, opts] = fetchMock.mock.calls[0]!;
      const sig = (opts.headers as Record<string, string>)["x-webhook-signature"];
      expect(sig).toBe(await hmacHexSign("rotated-current-secret", opts.body as string));
    } finally {
      delete process.env.RAG_WEBHOOK_SECRET_CURRENT;
    }
  });

  it("POSTs a platform event to /api/platform-settings-events", async () => {
    await handler({ event: { name: "rag-sync/platform.event", data: { event: PLATFORM_EVENT } }, attempt: 0 });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://rag.example.com/api/platform-settings-events");
  });

  it("re-delivers an identical signed body on replay (revision-guarded consumer → one effect)", async () => {
    await handler({ event: { name: "rag-sync/tenant.event", data: { event: TENANT_EVENT } }, attempt: 0 });
    await handler({ event: { name: "rag-sync/tenant.event", data: { event: TENANT_EVENT } }, attempt: 3 });
    const first = fetchMock.mock.calls[0]![1].body;
    const second = fetchMock.mock.calls[1]![1].body;
    // Delivery is a pure function of the event: identical bytes each time, so
    // the consumer's source_revision guard collapses the replay to one effect.
    expect(second).toBe(first);
  });
});

describe("ragSyncDeliver — retry + exhaustion handoff", () => {
  it("re-throws a transient failure before the ladder is exhausted (Inngest schedules the retry)", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(
      handler({ event: { name: "rag-sync/tenant.event", data: { event: TENANT_EVENT } }, attempt: 0 }),
    ).rejects.toThrow(/503/);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("alerts and stops (no throw) once the retry ladder is exhausted", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
    const result = await handler({
      event: { name: "rag-sync/tenant.event", data: { event: TENANT_EVENT } },
      attempt: 10,
    });
    expect(result).toMatchObject({ failed: true });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]![0]).toMatchObject({ signal: "rag_sync_exhausted_retries" });
  });

  it("throws on missing RAG config so the event is retried, never silently dropped", async () => {
    delete process.env.RAG_SERVICE_URL;
    await expect(
      handler({ event: { name: "rag-sync/tenant.event", data: { event: TENANT_EVENT } }, attempt: 0 }),
    ).rejects.toThrow(/RAG_SERVICE_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
