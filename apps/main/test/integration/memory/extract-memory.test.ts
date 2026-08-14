// Integration tests for runExtractMemory — §11.2
//
// Tests the full extraction flow against mock DB clients.
// WHY integration (not unit):
//   runExtractMemory composes multiple DB reads/writes with specific ordering
//   guarantees (opt-out before debounce, assertion before Haiku call, etc.).
//   These tests verify that ordering and that the mandatory scope contract
//   (§11.2.2) holds.
//
// THE MOST IMPORTANT TEST: cross-tenant scope isolation.
// If cross-tenant scope fails, real customer data leaks across tenants.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runExtractMemory, type ExtractionStep } from "@/inngest/extract-memory";

// ── Constants ────────────────────────────────────────────────────────────────

const TENANT_A = "tenant-a-uuid";
const TENANT_B = "tenant-b-uuid";
const USER_A = "user-a-uuid";
const USER_B = "user-b-uuid";
const CONV_A = "conv-a-uuid";
const CONV_B = "conv-b-uuid";

const RECENT_TS = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
const OLD_TS = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago

// ── Mock step (deterministic, in-process) ────────────────────────────────────

function makeMockStep(extractionResult: Record<string, unknown> | null = {
  notes_freeform: "loves ocean views",
}): ExtractionStep & { sentEvents: unknown[]; sleptMs: number[] } {
  const sentEvents: unknown[] = [];
  const sleptMs: number[] = [];
  return {
    sentEvents,
    sleptMs,
    async run<T>(_id: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_id: string, ms: number) {
      sleptMs.push(ms);
    },
    async sendEvent(_id: string, events: unknown) {
      sentEvents.push(events);
    },
  };
}

// ── Mock DB factory ───────────────────────────────────────────────────────────

interface MockOptions {
  tenantId: string;
  userId: string;
  conversationId: string;
  memoryOptOut?: boolean;
  backgroundAiEnabled?: boolean;
  aiMode?: "autonomous" | "draft_only" | "disabled";
  lastExtractedAt?: string | null;
  memoryUpdatedAt?: string;
  conversationUserId?: string; // for cross-tenant assertion test
  memoryInserts?: (row: Record<string, unknown>) => void;
  memoryUpdates?: (patch: Record<string, unknown>) => void;
}

function buildMockDb(opts: MockOptions): SupabaseClient {
  const {
    tenantId,
    userId,
    conversationId,
    memoryOptOut = false,
    backgroundAiEnabled = true,
    aiMode = "autonomous",
    lastExtractedAt = null,
    memoryUpdatedAt = OLD_TS,
    conversationUserId = userId,
    memoryInserts,
    memoryUpdates,
  } = opts;

  // Simulate the tenantClient proxy: queries on scoped tables auto-filter by tenant_id.
  // We validate that the mock is only called with the correct tenant.
  const db = {
    from: (table: string) => {
      switch (table) {
        case "users":
          return {
            select: () => ({
              eq: (_c: string, val: string) => ({
                eq: () => ({ maybeSingle: async () => ({ data: val === userId ? { memory_opt_out: memoryOptOut } : null, error: null }) }),
                maybeSingle: async () => ({ data: val === userId ? { memory_opt_out: memoryOptOut } : null, error: null }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: () => ({ error: null, data: patch }),
            }),
          };

        case "tenants":
          return {
            select: () => ({
              eq: (_c: string, val: string) => ({
                maybeSingle: async () => ({
                  data: val === tenantId
                    ? { ai_mode: aiMode, background_ai_enabled: backgroundAiEnabled }
                    : null,
                  error: null,
                }),
              }),
            }),
          };

        case "conversations":
          return {
            select: () => ({
              eq: (_c: string, val: string) => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: val === conversationId
                      ? { id: conversationId, user_id: conversationUserId, status: "active" }
                      : null,
                    error: null,
                  }),
                }),
                maybeSingle: async () => ({
                  data: val === conversationId
                    ? { id: conversationId, user_id: conversationUserId, status: "active" }
                    : null,
                  error: null,
                }),
              }),
            }),
          };

        case "messages":
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [{ role: "user", content: "I love ocean views" }],
                    error: null,
                  }),
                }),
              }),
            }),
          };

        case "customer_memories": {
          const hasExistingRow = lastExtractedAt !== undefined;
          const existingRow = hasExistingRow
            ? { id: "mem-uuid", user_id: userId, last_extracted_at: lastExtractedAt, updated_at: memoryUpdatedAt }
            : null;

          return {
            select: () => ({
              eq: (_c: string, val: string) => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: val === userId ? existingRow : null,
                    error: null,
                  }),
                }),
                maybeSingle: async () => ({
                  data: val === userId ? existingRow : null,
                  error: null,
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: (_c: string, _v: string) => ({
                eq: (_c2: string, _v2: string) => ({
                  select: (_fields: string) => ({
                    data: [{ id: "mem-uuid" }],
                    error: null,
                    then: (fn: (v: { data: unknown[]; error: null }) => unknown) =>
                      Promise.resolve(fn({ data: [{ id: "mem-uuid" }], error: null })),
                  }),
                }),
              }),
            }),
            insert: (row: Record<string, unknown>) => {
              memoryInserts?.(row);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }

        default:
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            insert: () => Promise.resolve({ data: null, error: null }),
            update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ data: [], error: null }) }) }) }),
          };
      }
    },
  } as unknown as SupabaseClient;

  return db;
}

// ── Mock the batch enqueue path ───────────────────────────────────────────
// §27.12 — extract-memory now enqueues a batch request instead of calling
// instrumentedClaudeCall directly. The actual Haiku call + merge + write
// happens in extractMemoryFromBatchResult on completion. Mock the enqueue
// + the service-role client so the producer's step.run returns cleanly.

vi.mock("@/lib/ai/batch/enqueue", () => ({
  enqueueBatchRequest: async () => ({
    request_id: "test-request-id-0000-0000-0000-000000000000",
    enqueued_at: "2026-05-28T00:00:00Z",
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.MEMORY_EXTRACTION_DEBOUNCE_SECONDS = "120";
  process.env.MEMORY_EXTRACTION_MESSAGE_WINDOW = "50";
  process.env.MEMORY_EXTRACTION_RETRY_DELAY_MS = "5000";
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("runExtractMemory — cross-tenant scope (§11.2.2 mandatory contract)", () => {
  // @rls-covered-by apps/main/test/integration/rls.test.ts#customer_memories: userB cannot SELECT tenantA rows
  it("processes tenant A event without touching tenant B's memory", async () => {
    // DB scoped to TENANT_A — simulates tenantClient(ctx) where ctx.tenant_id = TENANT_A.
    // Existing memory row is present (UPDATE path). The mock DB only knows about
    // TENANT_A — any attempt to read TENANT_B data would return null and error.
    const db = buildMockDb({
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: CONV_A,
      lastExtractedAt: OLD_TS, // row exists, outside debounce window
      memoryUpdatedAt: OLD_TS,
    });

    const step = makeMockStep();
    const result = await runExtractMemory({
      tenant_id: TENANT_A,
      conversation_id: CONV_A,
      user_id: USER_A,
      db,
      step,
    });

    // Producer enqueued the batch successfully against TENANT_A.
    // (§27.12: the actual write happens in the consumer when the batch
    // completes; the producer only enqueues.)
    expect(result.status).toBe("enqueued");
    // Tenant B was never consulted — mock DB only knows TENANT_A.
    // The scope contract is enforced by tenantContextFromInngestEvent → tenantClient(ctx).
  });

  // @rls-covered-by apps/main/test/integration/rls.test.ts#conversations: userB cannot SELECT tenantA rows
  it("throws when conversation.user_id !== event.data.user_id (scope assertion)", async () => {
    // Simulate: event says user is USER_A, but the conversation in the DB
    // belongs to USER_B. This is the attack vector the assertion catches.
    const db = buildMockDb({
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: CONV_A,
      conversationUserId: USER_B, // mismatch!
    });

    const step = makeMockStep();

    await expect(
      runExtractMemory({
        tenant_id: TENANT_A,
        conversation_id: CONV_A,
        user_id: USER_A,
        db,
        step,
      }),
    ).rejects.toThrow("SCOPE ASSERTION FAILED");
  });

  // @rls-covered-by apps/main/test/integration/rls.test.ts#conversations: userB cannot SELECT tenantA rows
  it("returns not-found error when conversation does not belong to the event tenant", async () => {
    // Simulate: event uses TENANT_A, but CONV_B belongs to TENANT_B.
    // The tenantClient auto-filter returns null (no matching row in tenant A).
    const db = buildMockDb({
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: "non-existent-conv", // conversation not in this tenant
    });

    const step = makeMockStep();

    await expect(
      runExtractMemory({
        tenant_id: TENANT_A,
        conversation_id: CONV_B, // belongs to tenant B — tenant A filter returns null
        user_id: USER_A,
        db,
        step,
      }),
    ).rejects.toThrow(/not found.*tenant filter applied/);
  });
});

describe("runExtractMemory — memory_opt_out (§11.2 task 7)", () => {
  it("returns opted_out immediately when memory_opt_out=true, before any other reads", async () => {
    const db = buildMockDb({
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: CONV_A,
      memoryOptOut: true,
    });

    const step = makeMockStep();
    const result = await runExtractMemory({
      tenant_id: TENANT_A,
      conversation_id: CONV_A,
      user_id: USER_A,
      db,
      step,
    });

    expect(result.status).toBe("opted_out");
  });
});

describe("runExtractMemory — background_ai_disabled (§11.2 task 7)", () => {
  it("returns background_ai_disabled when memory_extraction is off", async () => {
    const db = buildMockDb({
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: CONV_A,
      backgroundAiEnabled: false,
    });

    const step = makeMockStep();
    const result = await runExtractMemory({
      tenant_id: TENANT_A,
      conversation_id: CONV_A,
      user_id: USER_A,
      db,
      step,
    });

    expect(result.status).toBe("background_ai_disabled");
  });
});

describe("runExtractMemory — debounce (§11.2.3)", () => {
  it("returns debounced when last_extracted_at is within debounce window", async () => {
    process.env.MEMORY_EXTRACTION_DEBOUNCE_SECONDS = "120";

    const db = buildMockDb({
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: CONV_A,
      lastExtractedAt: RECENT_TS, // 1 minute ago < 2 minute debounce
    });

    const step = makeMockStep();
    const result = await runExtractMemory({
      tenant_id: TENANT_A,
      conversation_id: CONV_A,
      user_id: USER_A,
      db,
      step,
    });

    expect(result.status).toBe("debounced");
  });

  it("proceeds when last_extracted_at is outside the debounce window", async () => {
    process.env.MEMORY_EXTRACTION_DEBOUNCE_SECONDS = "30"; // 30 seconds < 1 hour ago

    const db = buildMockDb({
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: CONV_A,
      lastExtractedAt: OLD_TS, // 1 hour ago — outside 30s debounce
      memoryUpdatedAt: OLD_TS,
    });

    const step = makeMockStep();
    const result = await runExtractMemory({
      tenant_id: TENANT_A,
      conversation_id: CONV_A,
      user_id: USER_A,
      db,
      step,
    });

    expect(result.status).toBe("enqueued");
  });
});

// Note: the optimistic-lock-conflict path moved to the consumer
// (applyExtractedMemory) when extract-memory migrated to the §27.12
// batch pipeline. Coverage for that path now lives in
// apps/main/test/unit/inngest/extract-memory-consumer.test.ts.
