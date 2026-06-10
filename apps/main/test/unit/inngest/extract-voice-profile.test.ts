// #903 — Voice-profile extraction core logic.
//
// The billing-critical property: the hash guard must prevent the Anthropic
// call when samples haven't changed. An extraction job that re-bills on every
// settings-page load would quietly overspend. A test that can't fail when the
// guard is removed is the wrong test.

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runExtractVoiceProfile } from "@/inngest/extract-voice-profile";
import type { SupabaseClient } from "@supabase/supabase-js";

const TENANT = "tenant-abc";
const USER = "users-xyz";
const SAMPLE_A = "Hi Sarah, thanks for reaching out about your Caribbean cruise inquiry.";
const SAMPLE_B = "Dear Mike, I wanted to follow up on the Alaska sailing we discussed.";

// Compute what the hash should be for a given set of samples.
function hashOf(bodies: string[]): string {
  return createHash("sha256").update([...bodies].sort().join("\n---\n")).digest("hex");
}

const EXTRACTED_CARD = '{"greeting":"Hi {first},","signoff":"Best,","formality":"friendly","rhythm":"Short paragraphs.","signature_phrases":[],"emoji_habits":"none","bad_news":"Apologetic but direct."}';

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: vi.fn(async () => ({ text: EXTRACTED_CARD, raw: {} })),
}));
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: vi.fn(async (q: Promise<unknown>) => { await q; return { data: null, error: null }; }),
}));

import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";

// Build a mock DB/svc with configurable state.
function makeClients(opts: {
  samples?: string[];
  existingHash?: string;
  existingId?: string | null;
}) {
  const samples = opts.samples ?? [SAMPLE_A, SAMPLE_B];
  const existingHash = opts.existingHash ?? "";
  const existingId = opts.existingId ?? null;

  const dbChain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order"]) dbChain[m] = () => dbChain;
  dbChain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: samples.map((body) => ({ body })), error: null });

  const db = { from: () => dbChain } as unknown as SupabaseClient;

  const svcChain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "delete", "update", "insert"]) {
    svcChain[m] = () => svcChain;
  }
  svcChain.maybeSingle = async () => ({
    data: existingHash ? { id: existingId ?? "profile-id", samples_hash: existingHash } : null,
    error: null,
  });
  svcChain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });

  const svc = { from: () => svcChain } as unknown as SupabaseClient;
  return { db, svc };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("runExtractVoiceProfile (#903)", () => {
  it("hash guard: unchanged samples → returns 'unchanged' without calling Anthropic", async () => {
    const { db, svc } = makeClients({
      samples: [SAMPLE_A, SAMPLE_B],
      existingHash: hashOf([SAMPLE_A, SAMPLE_B]),
    });
    const result = await runExtractVoiceProfile({ tenant_id: TENANT, user_id: USER, db, svc });
    expect(result).toEqual({ status: "unchanged" });
    // The guard is real: Anthropic was never called.
    expect(instrumentedClaudeCall).not.toHaveBeenCalled();
  });

  it("new samples (hash mismatch) → calls Anthropic and returns 'extracted'", async () => {
    const { db, svc } = makeClients({ samples: [SAMPLE_A], existingHash: "old-hash" });
    const result = await runExtractVoiceProfile({ tenant_id: TENANT, user_id: USER, db, svc });
    expect(result).toEqual({ status: "extracted", samples: 1 });
    expect(instrumentedClaudeCall).toHaveBeenCalledOnce();
  });

  it("no samples → returns 'no_samples' without calling Anthropic", async () => {
    const { db, svc } = makeClients({ samples: [] });
    const result = await runExtractVoiceProfile({ tenant_id: TENANT, user_id: USER, db, svc });
    expect(result).toEqual({ status: "no_samples" });
    expect(instrumentedClaudeCall).not.toHaveBeenCalled();
  });

  it("house style (user_id=null) obeys the same hash guard", async () => {
    const { db, svc } = makeClients({
      samples: [SAMPLE_B],
      existingHash: hashOf([SAMPLE_B]),
    });
    const result = await runExtractVoiceProfile({ tenant_id: TENANT, user_id: null, db, svc });
    expect(result).toEqual({ status: "unchanged" });
    expect(instrumentedClaudeCall).not.toHaveBeenCalled();
  });

  it("first-time extraction (no existing row) → inserts new profile", async () => {
    const { db, svc } = makeClients({ samples: [SAMPLE_A], existingHash: "" });
    const result = await runExtractVoiceProfile({ tenant_id: TENANT, user_id: USER, db, svc });
    expect(result).toEqual({ status: "extracted", samples: 1 });
  });
});
