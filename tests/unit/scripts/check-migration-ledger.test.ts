// Unit tests for the DB-based migration-ledger collision pre-check (#1660).
//
// The DB/git edges (fetchLedger, addedMigrationsVsBase) are not exported; the
// pure core (parseVersionAndName, findLedgerCollisions) is tested directly.
//
// Intent: a branch's migration must be flagged when its version already has a
// DIFFERENT migration applied in the shared test DB ledger — that's the
// #1660 incident (a sibling PR's migration already claimed this version).
// Must NOT fire when the branch's own migration is what's already in the
// ledger (e.g. a re-run after this exact migration was already pushed), or
// when the version simply isn't in the ledger yet.

import { describe, it, expect } from "vitest";
import { parseVersionAndName, findLedgerCollisions } from "../../../scripts/check-migration-ledger";

describe("parseVersionAndName", () => {
  it("splits a main-style filename into version + name", () => {
    expect(parseVersionAndName("20260719000000_invitations_dedup.sql")).toEqual({
      version: "20260719000000",
      name: "invitations_dedup",
    });
  });

  it("splits a rag-style filename into version + name", () => {
    expect(parseVersionAndName("0033_region_itinerary_segment_match.sql")).toEqual({
      version: "0033",
      name: "region_itinerary_segment_match",
    });
  });

  it("returns null for a non-conforming filename", () => {
    expect(parseVersionAndName("README.md")).toBeNull();
  });
});

describe("findLedgerCollisions", () => {
  it("flags a branch migration whose version is already in the ledger under a different name", () => {
    const ledger = new Map([["20260719000000", "invitations_active_email_dedup"]]);
    const v = findLedgerCollisions(["20260719000000_subscription_status_event_ordering.sql"], ledger);
    expect(v).toEqual([
      {
        version: "20260719000000",
        branchFile: "20260719000000_subscription_status_event_ordering.sql",
        branchName: "subscription_status_event_ordering",
        ledgerName: "invitations_active_email_dedup",
      },
    ]);
  });

  it("does NOT fire when the ledger row IS this branch's own migration", () => {
    const ledger = new Map([["20260719000000", "invitations_active_email_dedup"]]);
    const v = findLedgerCollisions(["20260719000000_invitations_active_email_dedup.sql"], ledger);
    expect(v).toEqual([]);
  });

  it("does NOT fire when the version isn't in the ledger at all", () => {
    const ledger = new Map([["20260719000000", "invitations_active_email_dedup"]]);
    const v = findLedgerCollisions(["20260722000000_new_thing.sql"], ledger);
    expect(v).toEqual([]);
  });
});
