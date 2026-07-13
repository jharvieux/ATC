// #1816 — help-docs PDF export retry-safety.
//
// Intent pinned here: render (re-reads + re-parses every embedded image,
// #1811) is the expensive step. Wrapping it in step.run means a whole-
// function Inngest retry that crashes AFTER a successful render (e.g. on the
// storage upload) resumes from the memoized render output instead of
// redoing it. This test proves that by sharing durable step state across two
// handler invocations, the way Inngest replays a retried run.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (config: unknown, handler: unknown) => ({ config, handler }) },
}));

vi.mock("@/lib/env", () => ({
  env: () => ({ HELP_DOCS_CACHE_TTL_SECONDS: 3600 }),
}));

const mockRenderHelpDocsPdf = vi.fn();
vi.mock("@/lib/help-docs/help-docs-pdf", () => ({
  renderHelpDocsPdf: (...args: unknown[]) => mockRenderHelpDocsPdf(...args),
}));

let uploadFailNext = false;
const uploadCalls: Array<{ path: string; contentType: string }> = [];
const updateCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    storage: {
      from: (_bucket: string) => ({
        upload: async (path: string, _buf: Buffer, opts: { contentType: string }) => {
          uploadCalls.push({ path, contentType: opts.contentType });
          if (uploadFailNext) {
            uploadFailNext = false;
            return { error: { message: "simulated storage crash" } };
          }
          return { error: null };
        },
      }),
    },
    from: (table: string) => {
      if (table !== "help_doc_versions") throw new Error(`unexpected table ${table}`);
      return {
        update: (payload: Record<string, unknown>) => {
          const chain = {
            eq: () => chain,
            then: (resolve: (v: unknown) => unknown) => {
              updateCalls.push(payload);
              return Promise.resolve(resolve({ data: null, error: null }));
            },
          };
          return chain;
        },
      };
    },
  }),
}));

import { helpDocsPdfGenerate } from "@/inngest/help-docs-pdf-generate";

type RawHandler = {
  handler: (args: {
    event: { id: string; name: string; data: unknown };
    step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };
  }) => Promise<unknown>;
};

// Durable step store shared across two handler invocations — models Inngest
// persisting step output across a whole-function retry of the SAME run.
function makeDurableStepPair() {
  const store = new Map<string, unknown>();
  const runCounts = new Map<string, number>();
  function makeStep() {
    return {
      run: async (id: string, fn: () => Promise<unknown>) => {
        runCounts.set(id, (runCounts.get(id) ?? 0) + 1);
        if (store.has(id)) return store.get(id);
        const result = await fn();
        store.set(id, result);
        return result;
      },
    };
  }
  return { makeStep, runCounts };
}

const EVENT = {
  id: "evt-1",
  name: "help/docs.export.pdf",
  data: { tenant_id: "t-1", job_id: "job-1", code_version: "v9" },
};

beforeEach(() => {
  uploadFailNext = false;
  uploadCalls.length = 0;
  updateCalls.length = 0;
  mockRenderHelpDocsPdf.mockReset();
  mockRenderHelpDocsPdf.mockResolvedValue(Buffer.from("PDF-BYTES"));
});

describe("#1816 — help-docs-pdf-generate step.run boundaries", () => {
  it("happy path renders, uploads, and stamps the version row exactly once", async () => {
    const { makeStep } = makeDurableStepPair();
    const fn = helpDocsPdfGenerate as unknown as RawHandler;
    const result = await fn.handler({ event: EVENT, step: makeStep() });

    expect(mockRenderHelpDocsPdf).toHaveBeenCalledTimes(1);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.contentType).toBe("application/pdf");
    expect(updateCalls).toHaveLength(1);
    expect(result).toEqual({
      job_id: "job-1",
      storage_path: "tenant_t-1/help-docs/v9-pdf.pdf",
      size_bytes: Buffer.from("PDF-BYTES").length,
    });
  });

  it("a retry after a successful render resumes from the memoized render step instead of re-rendering", async () => {
    const { makeStep, runCounts } = makeDurableStepPair();
    const fn = helpDocsPdfGenerate as unknown as RawHandler;

    // Run 1: render succeeds and memoizes; the upload step then crashes.
    uploadFailNext = true;
    await expect(fn.handler({ event: EVENT, step: makeStep() })).rejects.toThrow(
      /storage upload failed/,
    );
    expect(mockRenderHelpDocsPdf).toHaveBeenCalledTimes(1);
    expect(uploadCalls).toHaveLength(1); // the failed attempt
    expect(updateCalls).toHaveLength(0); // never reached

    // Run 2 (Inngest re-run of the same event, same durable step store):
    // render-pdf returns the memoized bytes without calling renderHelpDocsPdf
    // again; upload now succeeds; the DB update finally lands.
    const result = await fn.handler({ event: EVENT, step: makeStep() });

    expect(mockRenderHelpDocsPdf).toHaveBeenCalledTimes(1); // NOT re-rendered
    expect(runCounts.get("render-pdf")).toBe(2); // step re-entered, memoized both times after run 1
    expect(uploadCalls).toHaveLength(2); // failed attempt + successful retry
    expect(updateCalls).toHaveLength(1);
    expect(result).toEqual({
      job_id: "job-1",
      storage_path: "tenant_t-1/help-docs/v9-pdf.pdf",
      size_bytes: Buffer.from("PDF-BYTES").length,
    });
  });
});
