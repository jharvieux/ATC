// §15.4 / §15.5 / §17.4 — Onboarding legal + ICA consent routes.
//
// Tests verify WHY the behavior matters:
//   - Missing any required document type blocks stage progression (onboarding gate).
//   - Documents not in the DB surface a 500 (misconfigured platform, affects all users).
//   - ICA typed_legal_name mismatch is the electronic signature check — wrong name must reject.
//   - ICA consent row records typed_legal_name in notes for audit trail.
//   - scroll_to_bottom: false always blocks signing per §15.5 UX requirement.
//   - Duplicate accept (23505) is idempotent — page refresh after acceptance must not 500.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth mock ──────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "t1" },
    user: { id: "user-1", auth_user_id: "auth-user-1" },
  })),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn((err: unknown) =>
    Response.json({ error: String(err) }, { status: 401 }),
  ),
}));

vi.mock("@/lib/onboarding/state-machine", () => ({
  progressTo: vi.fn(async () => undefined),
}));

// ── DB mocks ───────────────────────────────────────────────────────────────────
const mockTenantFrom = vi.fn();
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({ from: mockTenantFrom }),
}));

const mockServiceFrom = vi.fn();
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mockServiceFrom }),
}));

function makeChain(data: unknown, error: null | { message: string; code?: string } = null) {
  const resolve = () => Promise.resolve({ data, error });
  const deepChain = (): unknown =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return resolve().then.bind(resolve());
        return (..._args: unknown[]) => deepChain();
      },
    });
  return deepChain();
}

// ── Helper to make POST requests ───────────────────────────────────────────────
function postRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/legal
// ──────────────────────────────────────────────────────────────────────────────
describe("POST /api/onboarding/legal — §15.4 / §17.4", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const FULL_DOC_TYPES = ["tou", "privacy_policy", "ai_disclaimer", "cookie_policy"];
  const DOCS = FULL_DOC_TYPES.map((t, i) => ({ id: `doc-${i}`, document_type: t, version: 1 }));

  function setupHappyPath() {
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(DOCS);
      return makeChain([]);
    });
    mockServiceFrom.mockImplementation(() => ({
      insert: () => Promise.resolve({ data: null, error: null }),
    }));
  }

  it("rejects when any required document type is missing — onboarding gate", async () => {
    const { POST } = await import("@/app/api/onboarding/legal/route");
    const res = await POST(postRequest("/api/onboarding/legal", {
      accepted_types: ["tou", "privacy_policy", "ai_disclaimer"],
      // cookie_policy missing
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; missing: string[] };
    expect(body.error).toBe("missing_consents");
    expect(body.missing).toContain("cookie_policy");
  });

  it("returns 500 when legal documents are not in DB — platform setup error", async () => {
    mockTenantFrom.mockImplementation(() => makeChain([]));
    const { POST } = await import("@/app/api/onboarding/legal/route");
    const res = await POST(postRequest("/api/onboarding/legal", { accepted_types: FULL_DOC_TYPES }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("legal_documents_not_found");
  });

  it("happy path: inserts consent rows and advances to ica stage for sub_host", async () => {
    setupHappyPath();
    const { progressTo } = await import("@/lib/onboarding/state-machine");
    vi.mocked(progressTo).mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/onboarding/legal/route");
    const res = await POST(postRequest("/api/onboarding/legal", { accepted_types: FULL_DOC_TYPES }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; next_stage: string };
    expect(body.ok).toBe(true);
    expect(body.next_stage).toBe("ica");
    expect(vi.mocked(progressTo)).toHaveBeenCalledWith("t1", "ica");
  });

  it("BYO host skips ica + tax_form and advances to state_of_operation — §3.1", async () => {
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(DOCS);
      if (table === "tenants") return makeChain({ tenant_type: "byo_host" });
      return makeChain([]);
    });
    mockServiceFrom.mockImplementation(() => ({
      insert: () => Promise.resolve({ data: null, error: null }),
    }));
    const { progressTo } = await import("@/lib/onboarding/state-machine");
    vi.mocked(progressTo).mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/onboarding/legal/route");
    const res = await POST(postRequest("/api/onboarding/legal", { accepted_types: FULL_DOC_TYPES }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; next_stage: string };
    expect(body.next_stage).toBe("state_of_operation");
    expect(vi.mocked(progressTo)).toHaveBeenCalledWith("t1", "state_of_operation");
  });

  it("duplicate accept (23505) is idempotent — returns 200 not 500", async () => {
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(DOCS);
      return makeChain([]);
    });
    mockServiceFrom.mockImplementation(() => ({
      insert: () => Promise.resolve({ data: null, error: { message: "duplicate key", code: "23505" } }),
    }));
    const { POST } = await import("@/app/api/onboarding/legal/route");
    const res = await POST(postRequest("/api/onboarding/legal", { accepted_types: FULL_DOC_TYPES }));
    expect(res.status).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/ica
// ──────────────────────────────────────────────────────────────────────────────
describe("POST /api/onboarding/ica — §15.5 / §17.4", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const LEGAL_NAME = "Acme Travel LLC";
  const ICA_DOC = { id: "ica-doc-1", version: 1 };

  function setupHappyPath(overrides: { consentError?: { message: string; code?: string } } = {}) {
    let tenantFromCount = 0;
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        tenantFromCount++;
        if (tenantFromCount === 1) return makeChain({ legal_name: LEGAL_NAME });
      }
      if (table === "legal_documents") return makeChain([ICA_DOC]);
      return makeChain(null);
    });
    const consentErr = overrides.consentError ?? null;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "legal_consents") {
        return { insert: () => Promise.resolve({ data: null, error: consentErr }) };
      }
      if (table === "tenants") {
        return { update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
      }
      return { insert: () => Promise.resolve({ data: null, error: null }) };
    });
  }

  it("rejects when scrolled_to_bottom is false — must read the document before signing", async () => {
    const { POST } = await import("@/app/api/onboarding/ica/route");
    const res = await POST(postRequest("/api/onboarding/ica", {
      typed_legal_name: LEGAL_NAME,
      scrolled_to_bottom: false,
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("must_scroll_to_bottom");
  });

  it("rejects when typed_legal_name does not match tenant name — electronic signature check", async () => {
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "tenants") return makeChain({ legal_name: LEGAL_NAME });
      return makeChain(null);
    });
    const { POST } = await import("@/app/api/onboarding/ica/route");
    const res = await POST(postRequest("/api/onboarding/ica", {
      typed_legal_name: "Wrong Name LLC",
      scrolled_to_bottom: true,
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("name_mismatch");
  });

  it("ICA consent row includes typed_legal_name in notes — audit trail requirement", async () => {
    setupHappyPath();
    let capturedInsert: unknown = null;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "legal_consents") {
        return {
          insert: (row: unknown) => {
            capturedInsert = row;
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "tenants") {
        return { update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
      }
      return {};
    });

    const { POST } = await import("@/app/api/onboarding/ica/route");
    const res = await POST(postRequest("/api/onboarding/ica", {
      typed_legal_name: LEGAL_NAME,
      scrolled_to_bottom: true,
    }));
    expect(res.status).toBe(200);
    expect((capturedInsert as { notes: string }).notes).toBe(LEGAL_NAME);
    expect((capturedInsert as { document_type: string }).document_type).toBe("ica_subhost");
  });

  it("duplicate ICA accept (23505) is idempotent — returns 200", async () => {
    setupHappyPath({ consentError: { message: "duplicate key", code: "23505" } });
    const { POST } = await import("@/app/api/onboarding/ica/route");
    const res = await POST(postRequest("/api/onboarding/ica", {
      typed_legal_name: LEGAL_NAME,
      scrolled_to_bottom: true,
    }));
    expect(res.status).toBe(200);
  });

  it("returns 500 when ICA document is absent — stage is permanently uncompletable without operator fix", async () => {
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "tenants") return makeChain({ legal_name: LEGAL_NAME });
      if (table === "legal_documents") return makeChain([]);
      return makeChain(null);
    });
    const { POST } = await import("@/app/api/onboarding/ica/route");
    const res = await POST(postRequest("/api/onboarding/ica", {
      typed_legal_name: LEGAL_NAME,
      scrolled_to_bottom: true,
    }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("ica_document_not_found");
  });

  it("returns 500 with document_state_inconsistent when multiple current ICA versions exist — invariant violation makes ICA stage uncompletable", async () => {
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "tenants") return makeChain({ legal_name: LEGAL_NAME });
      if (table === "legal_documents") return makeChain([{ id: "ica-1", version: 1 }, { id: "ica-2", version: 2 }]);
      return makeChain(null);
    });
    const { POST } = await import("@/app/api/onboarding/ica/route");
    const res = await POST(postRequest("/api/onboarding/ica", {
      typed_legal_name: LEGAL_NAME,
      scrolled_to_bottom: true,
    }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("document_state_inconsistent");
  });

  it("returns 500 when tenants.ica_accepted_at update fails — stage does not advance without timestamp write", async () => {
    mockTenantFrom.mockImplementation((table: string) => {
      if (table === "tenants") return makeChain({ legal_name: LEGAL_NAME });
      if (table === "legal_documents") return makeChain([ICA_DOC]);
      return makeChain(null);
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "legal_consents") {
        return { insert: () => Promise.resolve({ data: null, error: null }) };
      }
      if (table === "tenants") {
        return { update: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "update failed" } }) }) };
      }
      return {};
    });
    const { POST } = await import("@/app/api/onboarding/ica/route");
    const res = await POST(postRequest("/api/onboarding/ica", {
      typed_legal_name: LEGAL_NAME,
      scrolled_to_bottom: true,
    }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("update failed");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/legal/[doctype]/current
// ──────────────────────────────────────────────────────────────────────────────
describe("GET /api/legal/[doctype]/current — §17.4", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 422 for invalid document type — prevents internal table enumeration", async () => {
    const { GET } = await import("@/app/api/legal/[doctype]/current/route");
    const res = await GET(
      new Request("http://test/api/legal/unknown/current"),
      { params: Promise.resolve({ doctype: "not_a_real_type" }) },
    );
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_document_type");
  });

  it("returns 404 when no current document exists for a valid type", async () => {
    mockTenantFrom.mockImplementation(() => makeChain([]));
    const { GET } = await import("@/app/api/legal/[doctype]/current/route");
    const res = await GET(
      new Request("http://test/api/legal/tou/current"),
      { params: Promise.resolve({ doctype: "tou" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns the document when found", async () => {
    const doc = { id: "doc-1", document_type: "tou", version: 1, content_markdown: "# Terms", content_html: null, effective_at: "2026-01-01T00:00:00Z" };
    mockTenantFrom.mockImplementation(() => makeChain([doc]));
    const { GET } = await import("@/app/api/legal/[doctype]/current/route");
    const res = await GET(
      new Request("http://test/api/legal/tou/current"),
      { params: Promise.resolve({ doctype: "tou" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as typeof doc;
    expect(body.document_type).toBe("tou");
    expect(body.version).toBe(1);
  });

  it("returns 500 with document_state_inconsistent when multiple current versions exist — invariant violation blocks all users", async () => {
    const doc1 = { id: "doc-1", document_type: "tou", version: 1, content_markdown: "v1", content_html: null, effective_at: "2026-01-01T00:00:00Z" };
    const doc2 = { id: "doc-2", document_type: "tou", version: 2, content_markdown: "v2", content_html: null, effective_at: "2026-02-01T00:00:00Z" };
    mockTenantFrom.mockImplementation(() => makeChain([doc1, doc2]));
    const { GET } = await import("@/app/api/legal/[doctype]/current/route");
    const res = await GET(
      new Request("http://test/api/legal/tou/current"),
      { params: Promise.resolve({ doctype: "tou" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("document_state_inconsistent");
  });
});
