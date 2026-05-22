// §20.5 — DOB confirmation gate.
//
// Submission must be blocked until all estimated DOBs are confirmed.
// Throws DOBEstimateUnresolvedError listing affected passenger names.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export class DOBEstimateUnresolvedError extends Error {
  public readonly affectedPassengers: string[];

  constructor(passengers: string[]) {
    super(`Estimated DOB must be confirmed for: ${passengers.join(", ")}`);
    this.name = "DOBEstimateUnresolvedError";
    this.affectedPassengers = passengers;
  }
}

export async function assertNoEstimatedDOBs(bookingId: string): Promise<void> {
  const svc = createServiceRoleClient();

  const { data: passengers } = await svc
    .from("booking_passengers")
    .select("legal_first_name,legal_last_name,date_of_birth_is_estimated")
    .eq("booking_id", bookingId)
    .eq("date_of_birth_is_estimated", true);

  if (!passengers || passengers.length === 0) return;

  const names = passengers.map(
    (p) => `${p.legal_first_name} ${p.legal_last_name}`,
  );
  throw new DOBEstimateUnresolvedError(names);
}
