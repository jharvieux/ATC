// §import — resolveText tenant isolation (#2003).
//
// The email-path read of gmail_inbound_messages runs under the service-role
// client (no RLS backstop) and previously filtered only by message_id. Since
// Gmail message-ids are globally unique, cross-tenant retrieval wasn't
// reachable in practice — but D-091 #4 requires an app-layer tenant
// predicate as defense-in-depth alongside any DB-layer constraint. This pins
// that the tenant_id filter is present on the query, not just the intent.

import { describe, it, expect } from "vitest";
import { resolveText } from "@/inngest/import-pipeline";

function makeSvc(row: { message_id: string; tenant_id: string }[]) {
  const calls: Array<{ column: string; value: unknown }> = [];
  const chain = {
    eq(column: string, value: unknown) {
      calls.push({ column, value });
      return chain;
    },
    async maybeSingle() {
      const messageIdCall = calls.find((c) => c.column === "message_id");
      const tenantIdCall = calls.find((c) => c.column === "tenant_id");
      const match = row.find(
        (r) =>
          r.message_id === messageIdCall?.value &&
          (tenantIdCall === undefined || r.tenant_id === tenantIdCall.value),
      );
      return { data: match ? { body_text: `body-for-${match.message_id}` } : null, error: null };
    },
  };
  return {
    calls,
    svc: {
      from: () => ({ select: () => chain }),
    } as unknown as Parameters<typeof resolveText>[0],
  };
}

describe("resolveText — email path tenant isolation", () => {
  it("filters gmail_inbound_messages by both message_id and tenant_id", async () => {
    const { svc, calls } = makeSvc([{ message_id: "msg-1", tenant_id: "tenant-a" }]);
    const row = {
      id: "q1",
      tenant_id: "tenant-a",
      status: "pending_classification",
      import_path: "email" as const,
      source_ref: "msg-1",
      raw_extracted_fields: null,
      uploaded_file_path: null,
      document_type: null,
    };

    const text = await resolveText(svc, row);

    expect(text).toBe("body-for-msg-1");
    expect(calls).toContainEqual({ column: "tenant_id", value: "tenant-a" });
    expect(calls).toContainEqual({ column: "message_id", value: "msg-1" });
  });

  it("returns null when the message_id matches but tenant_id does not (cross-tenant)", async () => {
    const { svc } = makeSvc([{ message_id: "msg-1", tenant_id: "tenant-a" }]);
    const row = {
      id: "q2",
      tenant_id: "tenant-b",
      status: "pending_classification",
      import_path: "email" as const,
      source_ref: "msg-1",
      raw_extracted_fields: null,
      uploaded_file_path: null,
      document_type: null,
    };

    const text = await resolveText(svc, row);

    expect(text).toBeNull();
  });
});
