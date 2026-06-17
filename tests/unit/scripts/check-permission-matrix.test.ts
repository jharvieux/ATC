// #1176 — unit tests for the permission-matrix guard.
//
// Pins the two correctness properties that matter:
// 1. extractAssertedPairs correctly extracts (resource, action) from both
//    inline and multi-line assertPermission calls, in either property order.
// 2. extractGrantedPairs correctly extracts key("R", "A") calls.
//
// These are the exact patterns that would let a missing-grant slip through
// undetected if the regexes regressed.

import { describe, it, expect } from "vitest";
import {
  extractAssertedPairs,
  extractGrantedPairs,
} from "../../../scripts/check-permission-matrix";

describe("extractAssertedPairs", () => {
  it("finds resource-first inline call", () => {
    const src = `await assertPermission(req, { resource: "bookings", action: "cancel" });`;
    expect(extractAssertedPairs(src)).toEqual(new Set(["bookings:cancel"]));
  });

  it("finds action-first inline call (order-independent)", () => {
    const src = `await assertPermission(req, { action: "cancel", resource: "bookings" });`;
    expect(extractAssertedPairs(src)).toEqual(new Set(["bookings:cancel"]));
  });

  it("finds multi-line resource-first call", () => {
    const src = [
      `const { ctx } = await assertPermission(req, {`,
      `  resource: "tenant.ai-config",`,
      `  action: "tenant.config.update",`,
      `});`,
    ].join("\n");
    expect(extractAssertedPairs(src)).toEqual(
      new Set(["tenant.ai-config:tenant.config.update"]),
    );
  });

  it("finds multi-line action-first call", () => {
    const src = [
      `const { ctx } = await assertPermission(req, {`,
      `  action: "read",`,
      `  resource: "quotes",`,
      `});`,
    ].join("\n");
    expect(extractAssertedPairs(src)).toEqual(new Set(["quotes:read"]));
  });

  it("deduplicates identical pairs within a file", () => {
    const src = [
      `await assertPermission(req, { resource: "bookings", action: "read" });`,
      `await assertPermission(req, { resource: "bookings", action: "read" });`,
    ].join("\n");
    expect(extractAssertedPairs(src).size).toBe(1);
  });

  it("collects multiple distinct pairs from one file", () => {
    const src = [
      `await assertPermission(req, { resource: "bookings", action: "read" });`,
      `await assertPermission(req, { resource: "contacts", action: "list" });`,
    ].join("\n");
    expect(extractAssertedPairs(src)).toEqual(
      new Set(["bookings:read", "contacts:list"]),
    );
  });

  it("returns empty set for content with no assertPermission calls", () => {
    expect(extractAssertedPairs("const x = 42;")).toEqual(new Set());
  });
});

describe("extractGrantedPairs", () => {
  it("extracts key() calls from a typical grants block", () => {
    const src = [
      `const READ_GRANTS = new Set([`,
      `  key("bookings", "read"),`,
      `  key("contacts", "list"),`,
      `]);`,
    ].join("\n");
    expect(extractGrantedPairs(src)).toEqual(
      new Set(["bookings:read", "contacts:list"]),
    );
  });

  it("handles action strings with dots and colons (e.g. tenant.config.update)", () => {
    const src = `key("tenant.ai-config", "tenant.config.update"),`;
    expect(extractGrantedPairs(src)).toEqual(
      new Set(["tenant.ai-config:tenant.config.update"]),
    );
  });

  it("returns empty set for content with no key() calls", () => {
    expect(extractGrantedPairs("const x = 42;")).toEqual(new Set());
  });
});
