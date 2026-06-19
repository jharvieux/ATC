import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(() => ({ data: null, error: null })),
  from: vi.fn(),
}));
mocks.from.mockImplementation(() => ({ insert: mocks.insert }));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));

import { publishTenantEvent, type TenantEvent } from "@/lib/rag-sync/publish-tenant-event";

const EVENT: TenantEvent = {
  event_type: "tenant.status_changed",
  tenant_id: "11111111-1111-1111-1111-111111111111",
  source_revision: 1_780_000_000,
  payload: { status: "active", tenant_type: "byo_host", display_name: "Lisa Travel" },
};

const ORIG = { url: process.env.RAG_SERVICE_URL, secret: process.env.RAG_WEBHOOK_SECRET };

beforeEach(() => {
  mocks.from.mockClear();
  mocks.insert.mockClear();
});
afterEach(() => {
  process.env.RAG_SERVICE_URL = ORIG.url;
  process.env.RAG_WEBHOOK_SECRET = ORIG.secret;
});

describe("publishTenantEvent — missing config", () => {
  it("queues the event to pending_rag_sync instead of silently dropping it", async () => {
    delete process.env.RAG_SERVICE_URL;
    delete process.env.RAG_WEBHOOK_SECRET;

    await publishTenantEvent(EVENT);

    // The whole point of the fix: an unconfigured RAG URL must not lose the
    // event — the rag-sync-retry cron redelivers it once config is restored.
    expect(mocks.from).toHaveBeenCalledWith("pending_rag_sync");
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: EVENT.tenant_id,
        event_type: "tenant.status_changed",
        source_revision: EVENT.source_revision,
        last_error: "RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set",
      }),
    );
  });
});
