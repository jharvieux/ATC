// #1728 Phase 2 — the contact timeline must surface inbound persona-email
// replies (messages tagged source='email') alongside conversations/quotes/
// bookings, so the TA sees the reply and can launch the "Draft reply" action.
// Intent: an email message on the contact's conversation appears as a
// type:'email' timeline entry carrying its body; without source='email' rows
// the timeline is unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  contact: { id: "c-1" } as Record<string, unknown> | null,
  conversations: [] as Record<string, unknown>[],
  quotes: [] as Record<string, unknown>[],
  bookings: [] as Record<string, unknown>[],
  emails: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "t-1", source: { kind: "http_request", user_id: "u-1" } } })),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 401 })),
}));
vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: vi.fn(() => Response.json({ error: "db" }, { status: 500 })),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: table === "contacts" ? h.contact : null, error: null });
      chain.then = (resolve: (v: unknown) => void) => {
        const data =
          table === "conversations" ? h.conversations
          : table === "quotes" ? h.quotes
          : table === "bookings" ? h.bookings
          : table === "messages" ? h.emails
          : [];
        return resolve({ data, error: null });
      };
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/crm/contacts/[id]/timeline/route";

function req() {
  return new Request("https://t.example.com/api/crm/contacts/c-1/timeline");
}
function params() {
  return { params: Promise.resolve({ id: "c-1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.contact = { id: "c-1" };
  h.conversations = [{ id: "conv-1", created_at: "2026-07-01T00:00:00Z", status: "active", summary: null }];
  h.quotes = [];
  h.bookings = [];
  h.emails = [];
});

describe("GET /api/crm/contacts/[id]/timeline — inbound email entries (#1728)", () => {
  it("includes source='email' messages as type:'email' entries carrying the body", async () => {
    h.emails = [{ id: "m-1", created_at: "2026-07-02T00:00:00Z", content: "Looking forward to the cruise!" }];
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timeline: { type: string; content?: string }[] };
    const email = body.timeline.find((t) => t.type === "email");
    expect(email).toBeTruthy();
    expect(email!.content).toBe("Looking forward to the cruise!");
    // Newest-first: the email (Jul 2) sorts ahead of the conversation (Jul 1).
    expect(body.timeline[0]!.type).toBe("email");
  });

  it("omits email entries when the contact has no inbound-email messages", async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timeline: { type: string }[] };
    expect(body.timeline.some((t) => t.type === "email")).toBe(false);
  });

  it("404s an unknown contact before querying the timeline", async () => {
    h.contact = null;
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
  });
});
