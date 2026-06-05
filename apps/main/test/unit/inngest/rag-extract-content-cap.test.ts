// §22.4 — 1 MB cap on extracted content prevents decompression-bomb expansion
// from exhausting DB row limits and downstream Haiku token budgets (#742).
//
// Contract: if extractContent returns more than MAX_EXTRACTED_CHARS (1_000_000)
// characters, stored extracted_content is silently truncated to exactly that
// length. The row still transitions to extraction_status='extracted' and the
// downstream event is still emitted.

import { describe, it, expect, vi, beforeEach } from "vitest";

const sentEvents: { name: string; data: unknown }[] = [];
const updates: Record<string, unknown>[] = [];

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, fn: unknown) => fn,
    send: async (e: { name: string; data: unknown }) => { sentEvents.push(e); },
  },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "rag_submissions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    original_file_path: "tenant/uploads/doc.pdf",
                    original_file_mime_type: "application/pdf",
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              updates.push(patch);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      return {};
    },
  }),
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: async () => ({ ok: true }),
}));

vi.mock("@/lib/rag-ingest/extract-content", () => ({
  extractContent: vi.fn(),
}));

import { ragExtractContent } from "@/inngest/rag-extract-content";
import { extractContent } from "@/lib/rag-ingest/extract-content";

const MAX_EXTRACTED_CHARS = 1_000_000;

type Handler = (ctx: { event: { data: Record<string, string> } }) => Promise<unknown>;

async function runHandler(): Promise<unknown> {
  return (ragExtractContent as unknown as Handler)({
    event: { data: { submission_id: "sub-1", tenant_id: "t-1" } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sentEvents.length = 0;
  updates.length = 0;
});

describe("ragExtractContent — 1 MB decompression-bomb cap (#742)", () => {
  it("stores content as-is when under the cap", async () => {
    const content = "x".repeat(MAX_EXTRACTED_CHARS - 1);
    vi.mocked(extractContent).mockResolvedValueOnce({ status: "extracted", content });

    await runHandler();

    const written = updates.find((u) => u.extraction_status === "extracted");
    expect(written).toBeDefined();
    expect((written!.extracted_content as string)).toHaveLength(MAX_EXTRACTED_CHARS - 1);
  });

  it("truncates to exactly MAX_EXTRACTED_CHARS when content exceeds the cap", async () => {
    const oversized = "a".repeat(MAX_EXTRACTED_CHARS + 50_000);
    vi.mocked(extractContent).mockResolvedValueOnce({ status: "extracted", content: oversized });

    await runHandler();

    const written = updates.find((u) => u.extraction_status === "extracted");
    expect(written).toBeDefined();
    const stored = written!.extracted_content as string;
    expect(stored).toHaveLength(MAX_EXTRACTED_CHARS);
    expect(stored).toBe(oversized.slice(0, MAX_EXTRACTED_CHARS));
  });

  it("still emits rag.submission_ready_for_pii_redaction after truncation", async () => {
    const oversized = "b".repeat(MAX_EXTRACTED_CHARS + 1);
    vi.mocked(extractContent).mockResolvedValueOnce({ status: "extracted", content: oversized });

    await runHandler();

    expect(sentEvents).toContainEqual(
      expect.objectContaining({ name: "rag.submission_ready_for_pii_redaction" }),
    );
  });
});
