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
