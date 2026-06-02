// #561 — the /supervisor dashboard runs six service-role reads with no RLS
// backstop. Supabase JS v2 returns `{ data: null, error }` on a DB fault rather
// than throwing, so a dropped `error` renders misleading zeroes / empty lists on
// the platform-admin observability surface — an operator could read "0 open
// escalations / no drift / budget fine" when the truth is "the query failed."
// These tests encode the intent of the D-094 fix: a read error must PROPAGATE
// (the page throws), never be silently rendered as zeroes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

// safe-mutation is intentionally NOT mocked — we want the real safeAwait /
// SupabaseMutationError to throw on the injected error.

import SupervisorDashboardPage from "../../../src/app/(admin)/supervisor/page";

type QueryResult = { data: unknown; error: unknown; count: number | null };

// Chainable Supabase-shaped query stub. Every filter/terminal method returns the
// same object, which is itself thenable and resolves to `result` — so a
// `.maybeSingle()`-terminated chain, a `.limit()`-terminated chain, and a bare
// awaited head-count chain all resolve to the table's canned result. Mirrors the
// established stub pattern in apps/main/test/error-injection/_helpers.ts.
function makeQuery(result: QueryResult): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of [
    "select",
    "eq",
    "in",
    "not",
    "gte",
    "lt",
    "filter",
    "order",
    "limit",
    "maybeSingle",
  ]) {
    q[m] = self;
  }
  q.then = (resolve: (v: QueryResult) => unknown) => resolve(result);
  return q;
}

function makeClient(resultFor: (table: string) => QueryResult) {
  return { from: (table: string) => makeQuery(resultFor(table)) };
}

const pgError = (table: string) => ({
  message: `boom:${table}`,
  code: "XX000",
  hint: null,
  details: null,
  name: "PostgrestError",
});

function successResult(table: string): QueryResult {
  if (table === "ai_kill_switch_state") {
    return {
      data: { global_paused: false, global_paused_at: null, global_paused_reason: null },
      error: null,
      count: null,
    };
  }
  if (table === "escalation_topics") {
    return {
      data: [
        {
          id: "esc-1",
          tenant_id: "11111111-1111-1111-1111-111111111111",
          conversation_id: "conv-1",
          topic_summary: "Escalation about refund",
          topic_tags: null,
          status: "open",
          initiated_by: "guest",
          assigned_agent_id: null,
          opened_at: "2026-05-30T12:00:00.000Z",
        },
      ],
      error: null,
      count: null,
    };
  }
  // messages: the one row feeds the two select helpers; `count` feeds the three
  // head-count helpers (regen-exhausted + drift current/prior).
  return {
    data: [
      {
        id: "msg-1",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        persona_id: "p-1",
        supervisor_findings: {
          findings: [{ check: "tone", severity: "warn", details: "off-brand" }],
          final_action: "regen",
          regen_count: 2,
        },
        feedback_score: -1,
        created_at: "2026-05-30T12:00:00.000Z",
      },
    ],
    error: null,
    count: 3,
  };
}

describe("/supervisor dashboard — service-role read error handling (#561)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders real values when every read succeeds (non-vacuous baseline)", async () => {
    mocks.createServiceRoleClient.mockReturnValue(makeClient(successResult));
    const html = renderToStaticMarkup(await SupervisorDashboardPage());
    expect(html).toContain("AI Supervisor Dashboard");
    expect(html).toContain("Escalation about refund"); // open escalation rendered
    expect(html).toContain("tone"); // flagged-by-check-type rendered
    expect(html).toContain("p-1"); // per-persona row rendered
  });

  // Each data source, erroring in isolation, must make the whole page throw —
  // never fall through to a zero/empty render. (messages is read by four
  // helpers; an error on it trips whichever resolves first — still a throw.)
  for (const table of ["ai_kill_switch_state", "escalation_topics", "messages"]) {
    it(`throws — not zeroes — when the ${table} read errors`, async () => {
      mocks.createServiceRoleClient.mockReturnValue(
        makeClient((t) =>
          t === table ? { data: null, error: pgError(table), count: null } : successResult(t),
        ),
      );
      await expect(SupervisorDashboardPage()).rejects.toThrow(`boom:${table}`);
    });
  }
});
