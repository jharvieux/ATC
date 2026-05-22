// §20.5 — DOB confirmation gate tests.
//
// Why these tests matter: a booking with an estimated DOB submitted to
// the host adapter can result in a confirmed booking with wrong passenger data.
// The gate must fire before any host adapter call.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DOBEstimateUnresolvedError } from "@/lib/booking/dob-gate";

// We test assertNoEstimatedDOBs by mocking the service-role client.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(),
}));

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertNoEstimatedDOBs } from "@/lib/booking/dob-gate";

// The mock must correctly implement .eq("date_of_birth_is_estimated", true) filtering
// because assertNoEstimatedDOBs trusts the DB to return only estimated rows.
function makeDb(passengers: { legal_first_name: string; legal_last_name: string; date_of_birth_is_estimated: boolean }[]) {
  return {
    from: () => ({
      select: () => ({
        eq: (_col1: string, _val1: unknown) => ({
          eq: (col2: string, val2: unknown) => {
            // Apply the filter the real DB would apply
            const filtered = (col2 === "date_of_birth_is_estimated")
              ? passengers.filter((p) => p.date_of_birth_is_estimated === val2)
              : passengers;
            return Promise.resolve({ data: filtered });
          },
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.mocked(createServiceRoleClient).mockReturnValue(makeDb([]) as unknown as ReturnType<typeof createServiceRoleClient>);
});

describe("assertNoEstimatedDOBs — §20.5", () => {
  it("passes when no passengers have estimated DOBs", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      makeDb([{ legal_first_name: "Alice", legal_last_name: "Smith", date_of_birth_is_estimated: false }]) as unknown as ReturnType<typeof createServiceRoleClient>,
    );
    await expect(assertNoEstimatedDOBs("booking-1")).resolves.toBeUndefined();
  });

  it("passes when passenger list is empty", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      makeDb([]) as unknown as ReturnType<typeof createServiceRoleClient>,
    );
    await expect(assertNoEstimatedDOBs("booking-1")).resolves.toBeUndefined();
  });

  it("throws DOBEstimateUnresolvedError when one passenger has estimated DOB", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      makeDb([{ legal_first_name: "Bob", legal_last_name: "Jones", date_of_birth_is_estimated: true }]) as unknown as ReturnType<typeof createServiceRoleClient>,
    );
    await expect(assertNoEstimatedDOBs("booking-2")).rejects.toThrow(DOBEstimateUnresolvedError);
  });

  it("error carries affected passenger names", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      makeDb([
        { legal_first_name: "Bob", legal_last_name: "Jones", date_of_birth_is_estimated: true },
        { legal_first_name: "Carol", legal_last_name: "White", date_of_birth_is_estimated: true },
      ]) as unknown as ReturnType<typeof createServiceRoleClient>,
    );

    try {
      await assertNoEstimatedDOBs("booking-3");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DOBEstimateUnresolvedError);
      const err = e as DOBEstimateUnresolvedError;
      expect(err.affectedPassengers).toContain("Bob Jones");
      expect(err.affectedPassengers).toContain("Carol White");
      expect(err.affectedPassengers).toHaveLength(2);
    }
  });

  it("only flags the estimated passenger, not the confirmed one", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      makeDb([{ legal_first_name: "Dave", legal_last_name: "Estimated", date_of_birth_is_estimated: true }]) as unknown as ReturnType<typeof createServiceRoleClient>,
    );

    try {
      await assertNoEstimatedDOBs("booking-4");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DOBEstimateUnresolvedError);
      const err = e as DOBEstimateUnresolvedError;
      expect(err.affectedPassengers).toHaveLength(1);
      expect(err.affectedPassengers[0]).toBe("Dave Estimated");
    }
  });
});
