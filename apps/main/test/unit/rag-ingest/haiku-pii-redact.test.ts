// D-091 Round-3 #44 — Haiku PII redact must fail-CLOSED.
//
// Pre-fix this returned status='clean' on missing API key or vendor
// error, which downstream interpreted as "no tolerable PII detected,
// safe to promote." Under a missing-key incident every submission
// would silently bypass redaction.
//
// Post-fix: those branches return status='failed' with a reason. The
// caller (inngest/rag-pii-redact.ts) quarantines on `failed` and does
// NOT emit the normalization-ready event.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callShouldThrow: false,
  callReturnText: "" as string,
}));

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: async () => {
    if (mocks.callShouldThrow) throw new Error("synthetic anthropic failure");
    return { text: mocks.callReturnText, raw: {} };
  },
}));

import { haikuPiiRedact } from "@/lib/rag-ingest/haiku-pii-redact";

const ORIG_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-test-fake";
  mocks.callShouldThrow = false;
  mocks.callReturnText = "";
});

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_KEY;
  vi.restoreAllMocks();
});

describe("haikuPiiRedact — fail-closed contract (D-091 #44)", () => {
  it("returns status='failed' with reason='anthropic_api_key_missing' when key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = await haikuPiiRedact("contact alice@example.com");
    expect(out).toEqual({ status: "failed", reason: "anthropic_api_key_missing" });
  });

  it("returns status='failed' with reason carrying the vendor message when Haiku throws", async () => {
    mocks.callShouldThrow = true;
    const out = await haikuPiiRedact("contact alice@example.com");
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.reason).toMatch(/haiku_error/);
      expect(out.reason).toMatch(/synthetic anthropic failure/);
    }
  });

  it("returns status='failed' with reason='haiku_empty_response' on empty model output", async () => {
    mocks.callReturnText = "";
    const out = await haikuPiiRedact("hello world");
    expect(out).toEqual({ status: "failed", reason: "haiku_empty_response" });
  });

  it("returns status='clean' when model echoes input verbatim (no PII detected)", async () => {
    mocks.callReturnText = "Sail away on the Star of the Sea.";
    const out = await haikuPiiRedact("Sail away on the Star of the Sea.");
    expect(out).toEqual({ status: "clean", content: "Sail away on the Star of the Sea." });
  });

  it("returns status='redacted' with [REDACTED]-marked content when model rewrites", async () => {
    mocks.callReturnText = "contact [REDACTED]";
    const out = await haikuPiiRedact("contact alice@example.com");
    expect(out).toEqual({ status: "redacted", content: "contact [REDACTED]" });
  });
});
