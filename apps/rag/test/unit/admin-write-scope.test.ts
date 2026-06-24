// F-rag-auth-02 (Day-1 scan) — mutating RAG admin routes must require write scope.
//
// The service JWT's `scope` claim (read|write) is set independently of
// `service_identifier`, so a read-scoped platform-admin token must NOT be able
// to delete/mutate chunks. These five routes previously gated only on
// service_identifier. WHY this matters: a least-privilege read token (e.g.
// minted for the curation/browse UI) could otherwise drive purges, demotions,
// post-termination marks/reviews, and authority overrides. The getRagDb mock
// throws, so each test also proves the 403 returns BEFORE any DB access.

import { beforeEach, describe, expect, it, vi } from "vitest";

let currentCtx = {
  scope: "write" as "read" | "write",
  service_identifier: "platform-admin",
  user_id: null as string | null,
  tenant_id: null as string | null,
};

vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth:
    (handler: (req: Request, ctx: typeof currentCtx) => Promise<Response>) =>
    (req: Request) =>
      handler(req, currentCtx),
}));

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => {
    throw new Error("DB reached despite insufficient scope — guard missing");
  },
}));

import { POST as purge } from "@/app/api/admin/purge-tenant-scoped-chunks/route";
import { POST as demote } from "@/app/api/admin/demote-chunk/route";
import { POST as mark } from "@/app/api/admin/post-termination-mark/route";
import { POST as review } from "@/app/api/admin/post-termination-review/route";
import { POST as authority } from "@/app/api/admin/set-authority-override/route";

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Array<[string, Handler]> = [
  ["purge-tenant-scoped-chunks", purge as never],
  ["demote-chunk", demote as never],
  ["post-termination-mark", mark as never],
  ["post-termination-review", review as never],
  ["set-authority-override", authority as never],
];

function req(): Request {
  return new Request("http://rag.test/admin", { method: "POST", body: "{}" });
}

beforeEach(() => {
  currentCtx = {
    scope: "write",
    service_identifier: "platform-admin",
    user_id: null,
    tenant_id: null,
  };
});

describe("RAG admin mutating routes — write-scope guard (F-rag-auth-02)", () => {
  for (const [name, handler] of ROUTES) {
    it(`${name}: a read-scoped platform-admin token → 403 insufficient_scope, no DB write`, async () => {
      currentCtx.scope = "read"; // read-scoped but still platform-admin
      const res = await handler(req());
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("insufficient_scope");
    });

    it(`${name}: a write-scoped non-platform-admin token is still rejected (gates are AND, not OR)`, async () => {
      // Pins the AND invariant: passing the scope gate must NOT bypass the
      // service_identifier gate. A future refactor collapsing the two early
      // returns into one `||` would pass the scope test above but fail here.
      currentCtx.scope = "write";
      currentCtx.service_identifier = "tenant-app";
      const res = await handler(req());
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      // The service_identifier gate fired, not the scope gate.
      expect(body.error).not.toBe("insufficient_scope");
    });
  }
});
