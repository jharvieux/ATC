// §26.2 RBAC grants matrix — unit tests for permission-grants.ts.

import { describe, it, expect } from "vitest";
import { isPermitted, isKnownRole } from "@/lib/auth/permission-grants";

describe("isPermitted", () => {
  describe("tenant_owner", () => {
    it("can do everything in the matrix", () => {
      // Sample a broad slice across resources.
      expect(isPermitted("tenant_owner", "bookings", "submit")).toBe(true);
      expect(isPermitted("tenant_owner", "bookings", "cancel")).toBe(true);
      expect(isPermitted("tenant_owner", "host_config", "write")).toBe(true);
      expect(isPermitted("tenant_owner", "tenant_branding", "write")).toBe(true);
      expect(isPermitted("tenant_owner", "persona_addendum", "write")).toBe(true);
      expect(isPermitted("tenant_owner", "rag_submissions", "approve")).toBe(true);
      expect(isPermitted("tenant_owner", "subcontractors", "delete")).toBe(true);
      expect(isPermitted("tenant_owner", "forums", "moderate_user")).toBe(true);
    });

    it("denies completely unknown resource/action even for owner (fail-closed)", () => {
      expect(isPermitted("tenant_owner", "unknown_resource", "read")).toBe(false);
      expect(isPermitted("tenant_owner", "bookings", "nuke")).toBe(false);
    });
  });

  describe("agent", () => {
    it("can do operational work", () => {
      expect(isPermitted("agent", "bookings", "submit")).toBe(true);
      expect(isPermitted("agent", "quotes", "create")).toBe(true);
      expect(isPermitted("agent", "contacts", "update")).toBe(true);
      expect(isPermitted("agent", "tasks", "create")).toBe(true);
      expect(isPermitted("agent", "rag_submissions", "create")).toBe(true);
    });

    it("CANNOT touch tenant settings", () => {
      expect(isPermitted("agent", "host_config", "write")).toBe(false);
      expect(isPermitted("agent", "tenant_branding", "write")).toBe(false);
      expect(isPermitted("agent", "persona_addendum", "write")).toBe(false);
    });

    it("CANNOT manage subcontractors or moderate forums", () => {
      expect(isPermitted("agent", "subcontractors", "create")).toBe(false);
      expect(isPermitted("agent", "subcontractors", "delete")).toBe(false);
      expect(isPermitted("agent", "forums", "moderate_user")).toBe(false);
      expect(isPermitted("agent", "forums", "moderate_thread")).toBe(false);
      expect(isPermitted("agent", "rag_submissions", "approve")).toBe(false);
    });

    it("CANNOT update team member roles (owner-only)", () => {
      expect(isPermitted("agent", "team_members", "update_role")).toBe(false);
      expect(isPermitted("viewer", "team_members", "update_role")).toBe(false);
      expect(isPermitted("tenant_owner", "team_members", "update_role")).toBe(true);
    });

    it("CAN list team members (everyone can see who's in the tenant)", () => {
      expect(isPermitted("agent", "team_members", "list")).toBe(true);
      expect(isPermitted("viewer", "team_members", "list")).toBe(true);
      expect(isPermitted("tenant_owner", "team_members", "list")).toBe(true);
    });

    it("CAN read tenant settings (just not write)", () => {
      expect(isPermitted("agent", "host_config", "read")).toBe(true);
      expect(isPermitted("agent", "tenant_branding", "read")).toBe(true);
      expect(isPermitted("agent", "persona_addendum", "read")).toBe(true);
    });
  });

  describe("viewer", () => {
    it("can read across resources", () => {
      expect(isPermitted("viewer", "bookings", "read")).toBe(true);
      expect(isPermitted("viewer", "contacts", "list")).toBe(true);
      expect(isPermitted("viewer", "tasks", "list")).toBe(true);
      expect(isPermitted("viewer", "host_config", "read")).toBe(true);
      expect(isPermitted("viewer", "tenant_branding", "read")).toBe(true);
      expect(isPermitted("viewer", "team_members", "list")).toBe(true);
    });

    it("CANNOT create/update/delete anything", () => {
      expect(isPermitted("viewer", "bookings", "submit")).toBe(false);
      expect(isPermitted("viewer", "bookings", "cancel")).toBe(false);
      expect(isPermitted("viewer", "quotes", "create")).toBe(false);
      expect(isPermitted("viewer", "contacts", "create")).toBe(false);
      expect(isPermitted("viewer", "tasks", "create")).toBe(false);
      expect(isPermitted("viewer", "tasks", "delete")).toBe(false);
      expect(isPermitted("viewer", "notifications", "write")).toBe(false);
      expect(isPermitted("viewer", "rag_submissions", "create")).toBe(false);
    });
  });

  describe("unknown role", () => {
    it("denies everything", () => {
      expect(isPermitted("hacker", "bookings", "read")).toBe(false);
      expect(isPermitted("", "bookings", "read")).toBe(false);
      expect(isPermitted("admin", "bookings", "read")).toBe(false);
    });
  });
});

describe("isKnownRole", () => {
  it("accepts the three canonical roles", () => {
    expect(isKnownRole("tenant_owner")).toBe(true);
    expect(isKnownRole("agent")).toBe(true);
    expect(isKnownRole("viewer")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isKnownRole("admin")).toBe(false);
    expect(isKnownRole("owner")).toBe(false);
    expect(isKnownRole("")).toBe(false);
    expect(isKnownRole("Tenant_Owner")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exhaustive matrix — every (role, resource, action) tuple asserted.
//
// Stryker uncovered that the original test suite (samples above) doesn't
// pin the actual GRANT KEY STRINGS. A mutation that flipped
// `key("bookings", "submit")` to `key("", "submit")` would slip through
// because no assertion referenced "bookings" in a way that would FAIL on
// removal. The exhaustive matrix below pins every key by referencing it
// in an explicit expect — so any string-literal mutation in the source
// produces a test failure.
// ---------------------------------------------------------------------------

// Single source of truth for "who can do what." Parallel to the prod
// constants in permission-grants.ts — any drift between the two is itself
// a finding (the test asserts both that prod-allowed-pairs return true
// AND that prod-denied-pairs return false, which catches both
// additions-without-test-updates AND deletions-without-test-updates).

const READ_PAIRS: ReadonlyArray<[string, string]> = [
  ["bookings", "read"],
  ["bug_submission", "read"],
  ["contacts", "list"],
  ["contacts", "read"],
  ["feature_request", "read"],
  ["group.invitations", "list"],
  ["groups", "list"],
  ["help_docs", "read"],
  ["host_config", "read"],
  ["persona_addendum", "read"],
  ["price_watches", "list"],
  ["subcontractors", "read"],
  ["tasks", "list"],
  ["team_members", "list"],
  ["tenant_branding", "read"],
  // #996 — self-view for all roles (route scopes to caller's user_id for non-owners)
  ["api_tokens", "list"],
];

const AGENT_ONLY_PAIRS: ReadonlyArray<[string, string]> = [
  ["bookings", "cancel"],
  ["bookings", "modify"],
  ["bookings", "submit"],
  ["bookings", "update"],
  ["quotes", "accept"],
  ["quotes", "create"],
  ["quotes", "send"],
  ["contacts", "create"],
  ["contacts", "update"],
  ["tasks", "create"],
  ["tasks", "delete"],
  ["tasks", "update"],
  ["group.invitations", "manage"],
  ["groups", "create"],
  ["price_watches", "create"],
  ["price_watches", "rearm"],
  ["price_watches", "update"],
  ["forums", "edit_message"],
  ["forums", "post_message"],
  ["forums", "react"],
  ["bug_submission", "create"],
  ["feature_request", "create"],
  ["help_docs", "export"],
  ["help_session", "create"],
  ["help_session", "update"],
  ["notifications", "write"],
  ["rag_submissions", "create"],
  // #902 — TA-mode conversation list (agent + owner; viewer denied by this matrix)
  ["ta_chat", "list"],
  // #903 — Voice profiles (agent + owner; viewer denied)
  // #904 — draft composer (agent + owner; viewer denied)
  ["draft_reply", "create"],
  ["voice_profile", "read"],
  ["voice_profile", "write"],
];

// #1170 — self-service pairs: every role (viewer/agent/owner) gets these.
// The chat ops were never in the matrix and 403'd for everyone once RBAC
// enforcement went live ("Couldn't load history: HTTP 403"); the customer
// writes were mis-scoped to agent-only so viewers (customers) couldn't reach
// them. Both classes now live in the shared SELF_SERVICE_GRANTS set.
const SELF_SERVICE_PAIRS: ReadonlyArray<[string, string]> = [
  ["Chat conversations", "list"],
  ["Get conversation", "get"],
  ["Update conversation", "patch"],
  ["Switch persona", "post"],
  ["Chat feedback", "post"],
  ["Escalate conversation", "post"],
  ["CustomerMemory", "update"],
  ["CustomerMemory", "delete"],
  ["CustomerMemory", "opt_out"],
  ["UserProfile", "update"],
  ["SessionTransfer", "commit"],
  ["SessionTransfer", "discard"],
  ["SessionTransfer", "undo"],
];

const OWNER_ONLY_PAIRS: ReadonlyArray<[string, string]> = [
  ["host_config", "write"],
  ["tenant_branding", "write"],
  ["persona_addendum", "write"],
  ["team_members", "update_role"],
  ["subcontractors", "create"],
  ["subcontractors", "delete"],
  ["subcontractors", "update"],
  ["forums", "moderate_forum"],
  ["forums", "moderate_thread"],
  ["forums", "moderate_user"],
  ["rag_submissions", "approve"],
  ["rag_submissions", "reject"],
  ["rag_submissions", "review"],
];

describe("permission-grants — exhaustive matrix", () => {
  describe("viewer is granted exactly the READ pairs", () => {
    for (const [resource, action] of READ_PAIRS) {
      it(`grants viewer ${resource}:${action}`, () => {
        expect(isPermitted("viewer", resource, action)).toBe(true);
      });
    }
    for (const [resource, action] of AGENT_ONLY_PAIRS) {
      it(`denies viewer ${resource}:${action} (agent-only)`, () => {
        expect(isPermitted("viewer", resource, action)).toBe(false);
      });
    }
    for (const [resource, action] of OWNER_ONLY_PAIRS) {
      it(`denies viewer ${resource}:${action} (owner-only)`, () => {
        expect(isPermitted("viewer", resource, action)).toBe(false);
      });
    }
  });

  describe("agent is granted READ + AGENT_ONLY pairs, denied OWNER_ONLY", () => {
    for (const [resource, action] of READ_PAIRS) {
      it(`grants agent ${resource}:${action} (inherits READ)`, () => {
        expect(isPermitted("agent", resource, action)).toBe(true);
      });
    }
    for (const [resource, action] of AGENT_ONLY_PAIRS) {
      it(`grants agent ${resource}:${action}`, () => {
        expect(isPermitted("agent", resource, action)).toBe(true);
      });
    }
    for (const [resource, action] of OWNER_ONLY_PAIRS) {
      it(`denies agent ${resource}:${action} (owner-only)`, () => {
        expect(isPermitted("agent", resource, action)).toBe(false);
      });
    }
  });

  describe("tenant_owner is granted every pair", () => {
    for (const [resource, action] of READ_PAIRS) {
      it(`grants tenant_owner ${resource}:${action} (inherits READ)`, () => {
        expect(isPermitted("tenant_owner", resource, action)).toBe(true);
      });
    }
    for (const [resource, action] of AGENT_ONLY_PAIRS) {
      it(`grants tenant_owner ${resource}:${action} (inherits AGENT)`, () => {
        expect(isPermitted("tenant_owner", resource, action)).toBe(true);
      });
    }
    for (const [resource, action] of OWNER_ONLY_PAIRS) {
      it(`grants tenant_owner ${resource}:${action} (owner-only)`, () => {
        expect(isPermitted("tenant_owner", resource, action)).toBe(true);
      });
    }
  });

  // #1170 — every role gets the self-service pairs. This is the regression
  // pin: the chat ops 403'd for ALL roles (viewer/agent/owner) once RBAC
  // enforcement went live, and the customer writes 403'd for viewers. If a
  // future refactor drops any of these from any role, these tests fail.
  describe("all roles are granted the self-service pairs", () => {
    for (const role of ["viewer", "agent", "tenant_owner"] as const) {
      for (const [resource, action] of SELF_SERVICE_PAIRS) {
        it(`grants ${role} ${resource}:${action}`, () => {
          expect(isPermitted(role, resource, action)).toBe(true);
        });
      }
    }
  });

  describe("unknown role denies every known pair", () => {
    const allPairs = [
      ...READ_PAIRS,
      ...SELF_SERVICE_PAIRS,
      ...AGENT_ONLY_PAIRS,
      ...OWNER_ONLY_PAIRS,
    ];
    for (const [resource, action] of allPairs) {
      it(`denies unknown-role ${resource}:${action}`, () => {
        expect(isPermitted("hacker", resource, action)).toBe(false);
      });
    }
  });

  describe("unknown (resource, action) is denied for every role", () => {
    for (const role of ["tenant_owner", "agent", "viewer"] as const) {
      it(`denies ${role} on a fabricated pair`, () => {
        expect(isPermitted(role, "fabricated_resource", "fabricated_action")).toBe(false);
      });
      it(`denies ${role} on a real resource with a fabricated action`, () => {
        expect(isPermitted(role, "bookings", "nuke")).toBe(false);
      });
      it(`denies ${role} on a fabricated resource with a real action`, () => {
        expect(isPermitted(role, "fabricated_resource", "read")).toBe(false);
      });
    }
  });
});

describe("api_tokens (#712) — owner-only", () => {
  // PATs are long-lived credentials that act with the minting user's role.
  // Letting agents or viewers mint tokens would let them create durable
  // credentials outside session controls (no SSO revocation, no sensitive-
  // route re-auth). Owner-only is the security boundary, not a convenience.
  it("tenant_owner can list, create, and revoke tokens", () => {
    expect(isPermitted("tenant_owner", "api_tokens", "list")).toBe(true);
    expect(isPermitted("tenant_owner", "api_tokens", "create")).toBe(true);
    expect(isPermitted("tenant_owner", "api_tokens", "revoke")).toBe(true);
  });

  it("all roles can list tokens (self-view — route scopes to caller's user_id for non-owners)", () => {
    // #996: api_tokens:list moved to READ_GRANTS so any member can see tokens acting as them.
    for (const role of ["tenant_owner", "agent", "viewer"] as const) {
      expect(isPermitted(role, "api_tokens", "list")).toBe(true);
    }
  });

  it("agent and viewer cannot create or revoke tokens", () => {
    for (const role of ["agent", "viewer"] as const) {
      for (const action of ["create", "revoke"] as const) {
        expect(isPermitted(role, "api_tokens", action)).toBe(false);
      }
    }
  });
});
