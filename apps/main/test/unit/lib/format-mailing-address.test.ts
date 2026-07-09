// Intent: formatMailingAddress must coerce the JSONB mailing_address column
// (an object with {line1,city,state,zip,country}) to a flat string for email
// footers. React throws "Objects are not valid as a React child" if it receives
// the raw object — this is the bug fixed in #1546.

import { describe, it, expect } from "vitest";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";

describe("formatMailingAddress", () => {
  it("formats a full JSONB address object to a flat string", () => {
    expect(
      formatMailingAddress({ line1: "123 Main St", city: "Miami", state: "FL", zip: "33101", country: "US" }),
    ).toBe("123 Main St, Miami, FL 33101, US");
  });

  it("omits zip when state is present but zip is absent", () => {
    expect(
      formatMailingAddress({ line1: "1 Park Ave", city: "New York", state: "NY", country: "US" }),
    ).toBe("1 Park Ave, New York, NY, US");
  });

  it("passes a string through unchanged (legacy string column value)", () => {
    expect(formatMailingAddress("456 Oak St, Dallas, TX")).toBe("456 Oak St, Dallas, TX");
  });

  it("returns empty string for null/undefined", () => {
    expect(formatMailingAddress(null)).toBe("");
    expect(formatMailingAddress(undefined)).toBe("");
  });

  // Coverage migrated from compliance-nightly's local formatAddress (#1556),
  // which used postal_code/line2 field names instead of zip/no-line2.
  it("includes line2 and accepts postal_code as a zip alias", () => {
    expect(
      formatMailingAddress({
        line1: "1 Main St",
        line2: "Suite 4",
        city: "Austin",
        state: "TX",
        postal_code: "78701",
        country: "USA",
      }),
    ).toBe("1 Main St, Suite 4, Austin, TX 78701, USA");
  });

  it("drops missing, empty, and non-string parts (no stray commas)", () => {
    expect(
      formatMailingAddress({
        line1: "1 Main St",
        line2: "",
        city: "Austin",
        state: null,
        postal_code: 78701, // number, not string — must be dropped
        country: "USA",
      }),
    ).toBe("1 Main St, Austin, USA");
  });

  it("returns empty string when no part is a non-empty string", () => {
    expect(formatMailingAddress({ line1: "", city: null, postal_code: 0 })).toBe("");
  });
});
