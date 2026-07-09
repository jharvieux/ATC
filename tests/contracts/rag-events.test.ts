// Contract: the main→rag webhook HMAC wire format and the shared event
// envelopes (@atc/contracts/rag-events, #1595).
//
// WHY a RECORDED-signature fixture (D-091 #12): every rag webhook receiver
// (tenant-events, platform-settings-events, feedback) authenticates by
// recomputing HMAC-SHA256 over the raw body and comparing to the
// x-webhook-signature header. The encoding (SHA-256 → lowercase hex, no
// prefix) is the wire contract shared across two apps. A golden vector pins
// that encoding: if hmacHexSign ever changes algorithm/casing/encoding, this
// fails instead of silently 401-ing every event in production. The vector was
// generated independently with node:crypto createHmac, so it also cross-checks
// the Web Crypto implementation against a second HMAC engine.

import { describe, it, expect } from "vitest";
import {
  hmacHexSign,
  verifyWebhookSignature,
  TenantEventSchema,
  PlatformEventSchema,
  ChunkFeedbackEventSchema,
} from "@atc/contracts";

const SECRET = "test-webhook-secret-1595";
const BODY = JSON.stringify({
  event_type: "tenant.created",
  tenant_id: "11111111-1111-1111-1111-111111111111",
  source_revision: 1720000000,
  payload: { status: "active", tenant_type: "customer", display_name: "Acme Cruises" },
});
// HMAC-SHA256(SECRET, BODY) as lowercase hex — recorded via node:crypto.
const RECORDED_SIG = "d19ec2ef328ff2871599671aded20b4d78557470d0949591c855656eec3f9dfa";

describe("hmacHexSign / verifyWebhookSignature", () => {
  it("reproduces the recorded signature exactly (pins the hex wire format)", async () => {
    expect(await hmacHexSign(SECRET, BODY)).toBe(RECORDED_SIG);
  });

  it("accepts a request signed with the recorded signature", async () => {
    expect(await verifyWebhookSignature(SECRET, BODY, RECORDED_SIG)).toBe(true);
  });

  it("rejects a tampered body under the same signature", async () => {
    const tampered = BODY.replace("Acme Cruises", "Evil Cruises");
    expect(await verifyWebhookSignature(SECRET, tampered, RECORDED_SIG)).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    expect(await verifyWebhookSignature("wrong-secret", BODY, RECORDED_SIG)).toBe(false);
  });

  it("rejects a missing/empty signature (fail closed)", async () => {
    expect(await verifyWebhookSignature(SECRET, BODY, null)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, BODY, "")).toBe(false);
  });

  it("is not length-fooled: a truncated signature never matches", async () => {
    expect(await verifyWebhookSignature(SECRET, BODY, RECORDED_SIG.slice(0, -2))).toBe(false);
  });
});

describe("event envelope schemas (single source of truth for both apps)", () => {
  it("TenantEventSchema round-trips the recorded body producers send", () => {
    expect(TenantEventSchema.parse(JSON.parse(BODY)).tenant_id).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("PlatformEventSchema bounds `key` to 128 chars on BOTH sides (the prior main/rag skew)", () => {
    const base = {
      event_type: "platform_settings.updated",
      source_revision: 1,
      payload: { changes: [{ key: "feedback_period_days", value: 30 }] },
    };
    expect(PlatformEventSchema.safeParse(base).success).toBe(true);
    const overlong = {
      ...base,
      payload: { changes: [{ key: "k".repeat(129), value: 1 }] },
    };
    expect(PlatformEventSchema.safeParse(overlong).success).toBe(false);
  });

  it("ChunkFeedbackEventSchema caps chunk_ids at 20", () => {
    const ids = Array.from({ length: 21 }, (_, i) =>
      `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
    );
    const r = ChunkFeedbackEventSchema.safeParse({
      message_id: null,
      signal_direction: "up",
      raw_weight: 1,
      chunk_ids: ids,
    });
    expect(r.success).toBe(false);
  });
});
