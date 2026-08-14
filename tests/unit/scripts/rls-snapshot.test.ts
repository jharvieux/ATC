import { describe, expect, it } from "vitest";
import { snapshotRelations } from "../../../scripts/rls-snapshot";

describe("snapshotRelations", () => {
  it("includes storage.objects only for the main database target", () => {
    expect(snapshotRelations("main")).toEqual(["public.*", "storage.objects"]);
    expect(snapshotRelations("rag")).toEqual(["public.*"]);
  });
});
