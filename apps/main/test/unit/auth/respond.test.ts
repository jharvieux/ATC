// Tests for respondToAuthError correlation ref (§26.3).
//
// WHY: an unknown error must NOT echo err.message (Postgres/RLS leak), but a
// bare "internal_error" is undiagnosable — the user reported exactly this on the
// billing screen. The fix stamps a short ref into both the 500 body and the
// server log so support can grep the log line. These tests pin that contract:
// the body carries a ref, the raw message never reaches the client, and known
// auth failures still map to their non-500 codes.

import { describe, it, expect, vi, afterEach } from "vitest";
import { respondToAuthError } from "@/lib/auth/respond";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("respondToAuthError — unknown error", () => {
  it("returns 500 + internal_error + a correlation ref, without leaking the raw message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = respondToAuthError(new Error("relation \"tenants\" does not exist"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; ref?: string };
    expect(body.error).toBe("internal_error");
    expect(body.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain("relation");
  });

  it("logs the same ref it returns so support can trace the failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = respondToAuthError(new Error("boom"));
    const body = (await res.json()) as { ref: string };
    const logged = spy.mock.calls[0]?.[0] as string;
    expect(logged).toContain(body.ref);
  });

  // #86: a multiline error message must be flattened to one log line so an
  // attacker-influenced error can't inject forged log entries via CR/LF.
  it("flattens CR/LF out of the logged error detail (no log forging)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    respondToAuthError(new Error("first line\nFORGED-SECOND-LINE"));
    const logged = (spy.mock.calls[0] ?? []).join(" ");
    expect(logged).toContain("FORGED-SECOND-LINE");
    expect(logged).not.toMatch(/[\r\n]/);
  });
});

describe("respondToAuthError — known auth failures still bypass the 500 path", () => {
  it("maps a known assertPermission failure to 401 unauthorized (no ref)", async () => {
    const res = respondToAuthError(
      new Error("assertPermission: missing Authorization Bearer token"),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; ref?: string };
    expect(body.error).toBe("unauthorized");
    expect(body.ref).toBeUndefined();
  });
});
