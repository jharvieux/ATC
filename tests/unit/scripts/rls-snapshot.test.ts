import { describe, expect, it } from "vitest";
import { snapshotSchemas } from "../../../scripts/rls-snapshot";

describe("snapshotSchemas", () => {
  it("includes storage.objects only for the main database target", () => {
    expect(snapshotSchemas("main")).toEqual(["public", "storage.objects"]);
    expect(snapshotSchemas("rag")).toEqual(["public"]);
  });
});
