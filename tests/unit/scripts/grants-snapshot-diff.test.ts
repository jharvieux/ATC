// decideOutcome is the fail-closed exit gate for the grants-drift check (#546).
// The whole point of this check is that a grant regression must never pass
// SILENTLY — that was the #544 outage class. The riskiest failure mode is a
// half-configured rollout: one of the two prod connection-string secrets is set
// and the other is not, so one target is checked while the other is skipped. If
// a skip counted as a pass, a regression on the unconfigured DB would sail
// through the blocking gate. These cases pin that boundary in both directions:
// a skip blocks on a real (human/release) run, but the Dependabot path — which
// legitimately can't receive the DB secrets — is still allowed to pass. If this
// regresses (a flipped boolean, a dropped guard), the gate goes fail-open and
// the check becomes security theater.

import { describe, it, expect } from "vitest";
import { decideOutcome } from "../../../scripts/grants-snapshot-diff";

describe("decideOutcome", () => {
  it("passes when every checked target is clean", () => {
    const d = decideOutcome({ anyChecked: true, anyDrift: false, anySkipped: false, allowNoTargets: false });
    expect(d.pass).toBe(true);
    expect(d.reason).toBe("clean");
  });

  it("fails on drift in a checked target", () => {
    const d = decideOutcome({ anyChecked: true, anyDrift: true, anySkipped: false, allowNoTargets: false });
    expect(d.pass).toBe(false);
    expect(d.reason).toBe("drift");
  });

  it("FAILS CLOSED when a target is skipped on a blocking run (half-configured secret)", () => {
    // The #546 core guarantee: one secret set, one unset → the skipped target's
    // DB is never checked, so the run must not pass.
    const d = decideOutcome({ anyChecked: true, anyDrift: false, anySkipped: true, allowNoTargets: false });
    expect(d.pass).toBe(false);
    expect(d.reason).toBe("skip-fail");
  });

  it("blocks drift even when another target was also skipped", () => {
    const d = decideOutcome({ anyChecked: true, anyDrift: true, anySkipped: true, allowNoTargets: false });
    expect(d.pass).toBe(false);
  });

  it("allows a skipped target ONLY when GRANTS_ALLOW_NO_TARGETS is set (Dependabot)", () => {
    // Dependabot can't receive the prod DB secrets; the workflow sets the flag
    // for it alone. A skip is tolerated here precisely because no code that could
    // change grants is in a dependency bump.
    const d = decideOutcome({ anyChecked: true, anyDrift: false, anySkipped: true, allowNoTargets: true });
    expect(d.pass).toBe(true);
  });

  it("fails when nothing could be checked on a blocking run", () => {
    const d = decideOutcome({ anyChecked: false, anyDrift: false, anySkipped: true, allowNoTargets: false });
    expect(d.pass).toBe(false);
    expect(d.reason).toBe("no-targets-fail");
  });

  it("passes when nothing was checked but the run is the Dependabot exemption", () => {
    const d = decideOutcome({ anyChecked: false, anyDrift: false, anySkipped: false, allowNoTargets: true });
    expect(d.pass).toBe(true);
    expect(d.reason).toBe("no-targets-pass");
  });
});
