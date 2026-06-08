// Contract: verifies RetrieveRequestSchema accepts the shapes main → rag actually sends.
//
// Root cause: the schema previously required persona_id as UUID and user_id as
// non-null UUID, but callRagRetrieve sends a persona SLUG and null for anon users.
// That caused a 400 on every RAG retrieve call, silently disabling RAG-grounded
// answers for all tenants. (#868)

import { describe, it, expect } from "vitest";
import { RetrieveRequestSchema } from "@atc/contracts";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CONV_ID = "00000000-0000-0000-0000-000000000002";
const PERSONA_UUID = "00000000-0000-0000-0000-000000000003";

const base = {
  query: "Norwegian Bliss itinerary October 3 2026",
  tenant_id: TENANT_ID,
  conversation_id: CONV_ID,
};

describe("RetrieveRequestSchema — main→rag call contract", () => {
  it("accepts a persona slug (the shape callRagRetrieve sends)", () => {
    const result = RetrieveRequestSchema.safeParse({
      ...base,
      persona_id: "marcus-cole",
      user_id: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null user_id for anon chat turns", () => {
    const result = RetrieveRequestSchema.safeParse({
      ...base,
      persona_id: "marcus-cole",
      user_id: null,
    });
    expect(result.success).toBe(true);
    expect(result.data?.user_id).toBeNull();
  });

  it("still accepts a UUID for persona_id when the caller has one", () => {
    const result = RetrieveRequestSchema.safeParse({
      ...base,
      persona_id: PERSONA_UUID,
      user_id: null,
    });
    expect(result.success).toBe(true);
  });

  it("defaults user_id to null when omitted", () => {
    const result = RetrieveRequestSchema.safeParse({
      ...base,
      persona_id: "marcus-cole",
    });
    expect(result.success).toBe(true);
    expect(result.data?.user_id).toBeNull();
  });

  it("still rejects an empty persona_id string", () => {
    const result = RetrieveRequestSchema.safeParse({
      ...base,
      persona_id: "",
      user_id: null,
    });
    expect(result.success).toBe(false);
  });

  it("accepts itinerary_lookup with ship + sail_date_from", () => {
    const result = RetrieveRequestSchema.safeParse({
      ...base,
      persona_id: "marcus-cole",
      user_id: null,
      itinerary_lookup: {
        ship: "Norwegian Bliss",
        sail_date_from: "2026-10-03",
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.itinerary_lookup?.ship).toBe("Norwegian Bliss");
  });
});
