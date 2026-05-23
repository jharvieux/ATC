// §26.3a.4 — Inngest event registry + validator.

import { describe, it, expect } from "vitest";
import {
  validateInngestEvent,
  EVENT_REGISTRY,
  EventNotRegisteredError,
  EventPayloadInvalidError,
} from "@/lib/inngest/event-registry";

describe("Inngest event registry", () => {
  it("accepts a registered tenant-scoped event with tenant_id", () => {
    expect(() =>
      validateInngestEvent("tenant.activated", { tenant_id: "abc" }),
    ).not.toThrow();
  });

  it("rejects an unregistered event", () => {
    expect(() => validateInngestEvent("foo.unknown", {})).toThrow(EventNotRegisteredError);
  });

  it("rejects a tenant-scoped event missing tenant_id", () => {
    expect(() => validateInngestEvent("tenant.activated", { foo: 1 } as unknown)).toThrow(
      EventPayloadInvalidError,
    );
  });

  it("seeds the critical BP-spawned event names", () => {
    const expected = [
      "tenant.activated",
      "tenant.rag_pii_recurring_pattern_detected",
      "chat.anonymous_chat_burst_detected",
      "user.data_purge_scheduled",
      "precruise/email.due",
      "email/soft.bounce.retry",
    ];
    for (const name of expected) {
      expect(EVENT_REGISTRY[name]).toBeDefined();
    }
  });
});
