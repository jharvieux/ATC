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
  attachInboundToTimeline,
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
  email_log?: { resend_message_id: string; tenant_id: string; contact_id: string | null }[];
  emailLogError?: unknown;
  contacts?: { id: string; tenant_id: string }[];
}): {
  db: SupabaseClient;
  queried: string[];
  emailLogQuery: { columns: string | null; ids: string[] | null; limit: number | null };
} {
  const queried: string[] = [];
  const emailLogQuery = { columns: null as string | null, ids: null as string[] | null, limit: null as number | null };
  const db = {
    from(table: string) {
      queried.push(table);
      if (table === "email_log") {
        return {
          select: (columns: string) => ({
            in: (_column: string, ids: string[]) => ({
              limit: (limit: number) => {
                emailLogQuery.columns = columns;
                emailLogQuery.ids = ids;
                emailLogQuery.limit = limit;
                return Promise.resolve({
                  data: handlers.email_log ?? [],
                  error: handlers.emailLogError ?? null,
                });
              },
            }),
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
  return { db, queried, emailLogQuery };
}

describe("resolveInboundTenant", () => {
  it("resolves via References match and never consults the spoofable sender when it hits", async () => {
    const { db, queried } = mockDb({
      email_log: [{ resend_message_id: "msg-1", tenant_id: "t-1", contact_id: "c-9" }],
      contacts: [{ id: "attacker-planted", tenant_id: "t-EVIL" }],
    });
    const res = await resolveInboundTenant({ db, referencedIds: ["msg-1"], fromEmail: "a@b.com" });
    expect(res).toEqual({ method: "references", tenant_id: "t-1", contact_id: "c-9" });
    expect(queried).not.toContain("contacts");
  });

  it("resolves same-tenant references by header order regardless of query row order", async () => {
    const { db, queried, emailLogQuery } = mockDb({
      email_log: [
        { resend_message_id: "msg-1", tenant_id: "t-1", contact_id: "c-1" },
        { resend_message_id: "msg-2", tenant_id: "t-1", contact_id: "c-2" },
      ],
    });

    const res = await resolveInboundTenant({
      db,
      referencedIds: ["msg-2", "msg-1", "msg-2"],
      fromEmail: "a@b.com",
    });

    expect(res).toEqual({ method: "references", tenant_id: "t-1", contact_id: "c-2" });
    expect(emailLogQuery).toEqual({
      columns: "resend_message_id, tenant_id, contact_id",
      ids: ["msg-2", "msg-1"],
      limit: 2,
    });
    expect(queried).not.toContain("contacts");
  });

  it("fails closed when references match more than one tenant", async () => {
    const { db, queried } = mockDb({
      email_log: [
        { resend_message_id: "msg-1", tenant_id: "t-1", contact_id: "c-1" },
        { resend_message_id: "msg-2", tenant_id: "t-2", contact_id: "c-2" },
      ],
      contacts: [{ id: "sender-contact", tenant_id: "t-1" }],
    });

    const res = await resolveInboundTenant({
      db,
      referencedIds: ["msg-1", "msg-2"],
      fromEmail: "a@b.com",
    });

    expect(res).toEqual({ method: "unresolved" });
    expect(queried).not.toContain("contacts");
  });

  it("fails loud on a reference query error without falling back to sender routing", async () => {
    const { db, queried, emailLogQuery } = mockDb({
      emailLogError: { code: "XX000" },
      contacts: [{ id: "sender-contact", tenant_id: "t-1" }],
    });

    const resolution = resolveInboundTenant({
      db,
      referencedIds: ["msg-1", "msg-2"],
      fromEmail: "a@b.com",
    });

    await expect(resolution).rejects.toThrow("email_log reference lookup failed");
    expect(emailLogQuery).toEqual({
      columns: "resend_message_id, tenant_id, contact_id",
      ids: ["msg-1", "msg-2"],
      limit: 2,
    });
    expect(queried).not.toContain("contacts");
  });

  it("fails closed without querying when reference candidates exceed the bounded lookup", async () => {
    const { db, queried } = mockDb({
      contacts: [{ id: "sender-contact", tenant_id: "t-1" }],
    });

    const res = await resolveInboundTenant({
      db,
      referencedIds: Array.from({ length: 101 }, (_, index) => `msg-${index}`),
      fromEmail: "a@b.com",
    });

    expect(res).toEqual({ method: "unresolved" });
    expect(queried).toEqual([]);
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

// Table-routed mock for the timeline-attach writes. Mirrors the exact chain
// attachInboundToTimeline drives; unexpected tables throw.
function attachDb(cfg: {
  existingConv?: { id: string }[];
  convSelectError?: unknown;
  convInsert?: { data: { id: string } | null; error: unknown };
  msgInsertError?: { code?: string } | null;
  dupMessage?: { conversation_id: string } | null;
}): { db: SupabaseClient; inserted: { conversations: Record<string, unknown>[]; messages: Record<string, unknown>[] } } {
  const inserted = { conversations: [] as Record<string, unknown>[], messages: [] as Record<string, unknown>[] };
  const db = {
    from(table: string) {
      if (table === "conversations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: cfg.existingConv ?? [], error: cfg.convSelectError ?? null }),
                }),
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            inserted.conversations.push(row);
            return {
              select: () => ({
                single: () => Promise.resolve(cfg.convInsert ?? { data: { id: "conv-new" }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "messages") {
        return {
          insert: (row: Record<string, unknown>) => {
            inserted.messages.push(row);
            return Promise.resolve({ error: cfg.msgInsertError ?? null });
          },
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: cfg.dupMessage ?? null, error: null }) }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { db, inserted };
}

describe("attachInboundToTimeline", () => {
  const base = { tenant_id: "t-1", contact_id: "c-1", providerMessageId: "inb-9", subject: "Re: deck", text: "See you there" };

  it("attaches to the contact's existing conversation, tagging source + the provider id for dedup", async () => {
    const { db, inserted } = attachDb({ existingConv: [{ id: "conv-1" }] });
    const res = await attachInboundToTimeline({ db, ...base });
    expect(res).toEqual({ status: "attached", conversation_id: "conv-1" });
    expect(inserted.conversations).toHaveLength(0);
    expect(inserted.messages[0]).toMatchObject({
      tenant_id: "t-1",
      conversation_id: "conv-1",
      role: "user",
      content: "See you there",
      source: "email",
      source_message_id: "inb-9",
    });
  });

  it("creates a conversation titled from the subject when the contact has none", async () => {
    const { db, inserted } = attachDb({ existingConv: [], convInsert: { data: { id: "conv-new" }, error: null } });
    const res = await attachInboundToTimeline({ db, ...base });
    expect(res).toEqual({ status: "attached", conversation_id: "conv-new" });
    expect(inserted.conversations[0]).toMatchObject({ tenant_id: "t-1", contact_id: "c-1", title: "Re: deck", status: "active" });
    expect(inserted.messages[0]).toMatchObject({ conversation_id: "conv-new", source_message_id: "inb-9" });
  });

  it("uses a default title when the subject is blank", async () => {
    const { db, inserted } = attachDb({ existingConv: [], convInsert: { data: { id: "conv-new" }, error: null } });
    await attachInboundToTimeline({ db, ...base, subject: "   " });
    expect(inserted.conversations[0]!.title).toBe("Email reply");
  });

  it("stores a placeholder when the body is unavailable (content is NOT NULL)", async () => {
    const { db, inserted } = attachDb({ existingConv: [{ id: "conv-1" }] });
    await attachInboundToTimeline({ db, ...base, text: null });
    expect(inserted.messages[0]!.content).toBe("(Email reply — body unavailable.)");
  });

  it("is idempotent — a redelivered provider id (23505) no-ops and returns where it landed", async () => {
    const { db } = attachDb({ existingConv: [{ id: "conv-1" }], msgInsertError: { code: "23505" }, dupMessage: { conversation_id: "conv-earlier" } });
    const res = await attachInboundToTimeline({ db, ...base });
    expect(res).toEqual({ status: "duplicate", conversation_id: "conv-earlier" });
  });

  it("surfaces a hard DB error (non-23505) so the webhook returns 500 and the provider retries", async () => {
    const { db } = attachDb({ existingConv: [{ id: "conv-1" }], msgInsertError: { code: "XX000" } });
    expect(await attachInboundToTimeline({ db, ...base })).toEqual({ status: "error" });
  });

  it("surfaces a conversation-lookup error as error (no message written)", async () => {
    const { db, inserted } = attachDb({ convSelectError: { code: "XX000" } });
    expect(await attachInboundToTimeline({ db, ...base })).toEqual({ status: "error" });
    expect(inserted.messages).toHaveLength(0);
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
