import { describe, expect, it } from "vitest";
import { assertIsolationQuery } from "../../helpers/isolation-witness";

describe("assertIsolationQuery", () => {
  it("accepts exactly the allowed IDs while excluding denied IDs", async () => {
    await assertIsolationQuery({
      query: async () => [{ id: "global" }, { id: "tenant-a" }],
      allowedIds: ["tenant-a", "global"],
      deniedIds: ["tenant-b"],
    });
  });

  it("fails when a denied ID is observed", async () => {
    await expect(
      assertIsolationQuery({
        query: async () => [{ id: "tenant-b" }],
        allowedIds: [],
        deniedIds: ["tenant-b"],
      }),
    ).rejects.toThrow();
  });

  it("fails when the denied set is empty at runtime", async () => {
    await expect(
      assertIsolationQuery({
        query: async () => [],
        allowedIds: [],
        deniedIds: [] as unknown as [string, ...string[]],
      }),
    ).rejects.toThrow(/at least one denied ID/);
  });
});
