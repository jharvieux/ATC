// WHY: The fail-closed throw for involuntary_content RAG marking failure is
// the security-critical behavioral change in PR #758 (D-091 fail-closed,
// §15.14.3). A RAG service outage during an involuntary_content termination
// must trigger Inngest retry — silently succeeding would leave offending chunks
// in reviewed_retained status instead of the pending review queue.
// This test fails if the throw is removed or the kind check is widened.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  signServiceJwt: vi.fn().mockResolvedValue("fake.jwt.token"),
}));

vi.mock("../../../src/inngest/client", () => ({
  inngest: {
    send: mocks.send,
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));

vi.mock("../../../src/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: mocks.signServiceJwt,
}));

vi.mock("../../../src/lib/rag-auth/platform-sentinel", () => ({
  PLATFORM_SENTINEL_TENANT_ID: "00000000-0000-0000-0000-000000000000",
}));

import { onTerminated } from "../../../src/inngest/tenant-on-terminated";

// safeAwait(db.from("tenant_host_configs").update({...}).eq("tenant_id", id), ...)
// needs { data: null, error: null } — no error, void-result update.
function makeDb() {
  const eq = () => Promise.resolve({ data: null, error: null });
  const update = () => ({ eq });
  return { from: () => ({ update }) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RAG_SERVICE_URL", "http://rag.test");
});

describe("onTerminated — RAG chunk marking fail-closed (§15.14.3, D-091)", () => {
  it("throws for involuntary_content when RAG responds non-ok — triggers Inngest retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    }));

    await expect(
      onTerminated(makeDb(), "t-1", "involuntary_content"),
    ).rejects.toThrow(/RAG chunk marking failed for involuntary_content/);
  });

  it("resolves without throwing for voluntary when RAG fails (advisory — no retry needed)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    }));

    await expect(
      onTerminated(makeDb(), "t-2", "voluntary"),
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for involuntary_other when RAG fails (advisory)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    }));

    await expect(
      onTerminated(makeDb(), "t-3", "involuntary_other"),
    ).resolves.toBeUndefined();
  });
});
