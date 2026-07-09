// #890 — inbound persona-email lib: header extraction, tenant resolution,
// best-effort Receiving API fetch.
//
// The resolution tests encode the design's security invariant: References
// matching (spoof-resistant — attacker can't know another tenant's provider
// message ids) takes precedence, and the sender fallback fails closed on any
// ambiguity so a forged From can never attach mail to another tenant.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  extractReferencedMessageIds,
  resolveInboundTenant,
  fetchReceivedEmail,
} from "@/lib/email/inbound";

describe("extractReferencedMessageIds", () => {
  it("reads In-Reply-To and References from array-shaped headers, returning full ids and local parts", () => {
    const ids = extractReferencedMessageIds([
      { name: "In-Reply-To", value: "<abc-123@mail.resend.com>" },
      { name: "References", value: "<first@x.com> <second@y.com>" },
      { name: "Subject", value: "<not-a-ref@z.com>" },
    ]);
    expect(ids).toContain("abc-123");
    expect(ids).toContain("abc-123@mail.resend.com");
    expect(ids).toContain("first");
    expect(ids).toContain("second");
    expect(ids).not.toContain("not-a-ref");
  });

  it("reads record-shaped headers case-insensitively", () => {
    const ids = extractReferencedMessageIds({
      "in-reply-to": "<uuid-1@mail.resend.com>",
      REFERENCES: "<uuid-2@mail.resend.com>",
    });
    expect(ids).toContain("uuid-1");
    // Object.entries key matching is lowercased before comparison
    expect(ids).toContain("uuid-2");
  });

  it("returns [] for missing/None/garbage headers", () => {
    expect(extractReferencedMessageIds(null)).toEqual([]);
    expect(extractReferencedMessageIds(undefined)).toEqual([]);
    expect(extractReferencedMessageIds("References: <x@y>")).toEqual([]);
    expect(extractReferencedMessageIds([{ name: "References" }])).toEqual([]);
  });
});

// Minimal table-routed mock: each test declares what email_log / contacts
// return; unexpected tables throw so a query-shape change fails the test.
function mockDb(handlers: {
  email_log?: { tenant_id: string; contact_id: string | null }[];
  contacts?: { id: string; tenant_id: string }[];
}): { db: SupabaseClient; queried: string[] } {
  const queried: string[] = [];
  const db = {
    from(table: string) {
      queried.push(table);
      if (table === "email_log") {
        return {
          select: () => ({
            in: () => ({ limit: () => Promise.resolve({ data: handlers.email_log ?? [], error: null }) }),
          }),
        };
      }
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({ limit: () => Promise.resolve({ data: handlers.contacts ?? [], error: null }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { db, queried };
}

describe("resolveInboundTenant", () => {
  it("resolves via References match and never consults the spoofable sender when it hits", async () => {
    const { db, queried } = mockDb({
      email_log: [{ tenant_id: "t-1", contact_id: "c-9" }],
      contacts: [{ id: "attacker-planted", tenant_id: "t-EVIL" }],
    });
    const res = await resolveInboundTenant({ db, referencedIds: ["msg-1"], fromEmail: "a@b.com" });
    expect(res).toEqual({ method: "references", tenant_id: "t-1", contact_id: "c-9" });
    expect(queried).not.toContain("contacts");
  });

  it("skips the email_log query entirely when there are no referenced ids", async () => {
    const { db, queried } = mockDb({ contacts: [{ id: "c-1", tenant_id: "t-1" }] });
    const res = await resolveInboundTenant({ db, referencedIds: [], fromEmail: "a@b.com" });
    expect(res).toEqual({ method: "sender", tenant_id: "t-1", contact_id: "c-1" });
    expect(queried).not.toContain("email_log");
  });

  it("falls back to a UNIQUE sender match", async () => {
    const { db } = mockDb({ email_log: [], contacts: [{ id: "c-2", tenant_id: "t-2" }] });
    const res = await resolveInboundTenant({ db, referencedIds: ["nope"], fromEmail: "a@b.com" });
    expect(res).toEqual({ method: "sender", tenant_id: "t-2", contact_id: "c-2" });
  });

  it("fails closed to unresolved when the sender matches contacts in multiple tenants (forged-From safety)", async () => {
    const { db } = mockDb({
      contacts: [
        { id: "c-1", tenant_id: "t-1" },
        { id: "c-2", tenant_id: "t-2" },
      ],
    });
    const res = await resolveInboundTenant({ db, referencedIds: [], fromEmail: "shared@b.com" });
    expect(res).toEqual({ method: "unresolved" });
  });

  it("is unresolved when nothing matches", async () => {
    const { db } = mockDb({});
    const res = await resolveInboundTenant({ db, referencedIds: [], fromEmail: "stranger@b.com" });
    expect(res).toEqual({ method: "unresolved" });
  });
});

describe("fetchReceivedEmail (best-effort)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns text + headers on success", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "hi", headers: { References: "<a@b>" } }), { status: 200 }),
    ));
    const res = await fetchReceivedEmail("abc-123");
    expect(res).toEqual({ text: "hi", headers: { References: "<a@b>" } });
  });

  it("returns null (not throw) on API error so metadata-only processing continues", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    expect(await fetchReceivedEmail("abc-123")).toBeNull();
  });

  it("refuses a path-traversal-shaped email id without calling fetch", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchReceivedEmail("../emails?x=1")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchReceivedEmail("abc-123")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
