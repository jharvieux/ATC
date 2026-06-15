// §15.1–15.2 — Onboarding stage state machine.
//
// Stages advance strictly forward through the §15.1 diagram.
// Allowed forward skips (multi-step advances):
//   - connect_setup → review_submitted  (branding is optional per §15.10)
//   - legal → state_of_operation        (BYO hosts skip ica + tax_form)
//   - ica → state_of_operation          (BYO recovery: stuck at ica)
//   - tax_form → state_of_operation     (BYO recovery: stuck at tax_form)
//   - subscription → branding           (BYO hosts skip connect_setup)

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const ONBOARDING_STAGES = [
  "signup",
  "profile",
  "legal",
  "ica",
  "tax_form",
  "state_of_operation",
  "tier_select",
  "subscription",
  "connect_setup",
  "branding",
  "review_submitted",
  "complete",
] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

const STAGE_ORDER: Record<OnboardingStage, number> = Object.fromEntries(
  ONBOARDING_STAGES.map((s, i) => [s, i]),
) as Record<OnboardingStage, number>;

export class OnboardingStageError extends Error {
  constructor(
    public readonly currentStage: OnboardingStage | null,
    public readonly requiredStage: OnboardingStage,
  ) {
    super(
      `Onboarding stage '${currentStage}' has not reached '${requiredStage}'`,
    );
    this.name = "OnboardingStageError";
  }
}

export class InvalidStageTransitionError extends Error {
  constructor(
    public readonly from: OnboardingStage | null,
    public readonly to: OnboardingStage,
  ) {
    super(`Cannot advance onboarding from '${from}' to '${to}'`);
    this.name = "InvalidStageTransitionError";
  }
}

function stageIndex(stage: OnboardingStage | null): number {
  if (stage === null) return -1;
  return STAGE_ORDER[stage] ?? -1;
}

export function isAtOrPast(
  current: OnboardingStage | null,
  target: OnboardingStage,
): boolean {
  return stageIndex(current) >= stageIndex(target);
}

export function nextStage(stage: OnboardingStage): OnboardingStage | null {
  const idx = STAGE_ORDER[stage];
  return ONBOARDING_STAGES[idx + 1] ?? null;
}

// assertStageComplete throws if the tenant's onboarding_stage hasn't reached
// the named stage. Used by stage handlers to gate access.
export async function assertStageComplete(
  tenantId: string,
  stage: OnboardingStage,
): Promise<void> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select("onboarding_stage")
    .eq("id", tenantId)
    .single();

  if (error) {
    throw new Error(`assertStageComplete: DB error: ${error.message}`);
  }

  const current = data?.onboarding_stage as OnboardingStage | null;
  if (!isAtOrPast(current, stage)) {
    throw new OnboardingStageError(current, stage);
  }
}

// progressTo advances the tenant's onboarding_stage to the next stage after
// `currentStage`. Only advances if the current DB value matches currentStage
// (optimistic guard).
// D-091 P1 #39 — CAS-guarded UPDATE. The previous version filtered the
// UPDATE on tenant_id only; a concurrent webhook + admin action could
// regress the tenant to an earlier stage because both writes saw the same
// pre-update stage value. Now the UPDATE also matches the current stage,
// so only the caller whose `current` is still authoritative succeeds.
export class StaleStageError extends Error {
  constructor(
    public readonly expected: OnboardingStage | null,
    public readonly target: OnboardingStage,
  ) {
    super(
      `Onboarding stage moved underneath progressTo/revertTo. Expected stage='${expected}', target='${target}'. Reload and retry.`,
    );
    this.name = "StaleStageError";
  }
}

/** Pure check used by both the runtime path and unit tests.
 *  Returns null if the target is a valid backwards revert from current,
 *  or an error describing why not. Public so admin handlers can validate
 *  before calling revertTo. */
export function assertValidRevertTarget(
  current: OnboardingStage | null,
  target: unknown,
): InvalidStageTransitionError | null {
  // 1. Enum membership — protects against untrusted input being cast to
  //    OnboardingStage at the call site (e.g. `body.revert_to_stage`).
  //    Use Object.hasOwn (not the `in` operator) so prototype keys like
  //    "constructor", "toString", "hasOwnProperty" don't sneak through —
  //    the `in` operator walks the prototype chain.
  if (typeof target !== "string" || !Object.hasOwn(STAGE_ORDER, target)) {
    return new InvalidStageTransitionError(current, target as OnboardingStage);
  }
  // 2. Direction — revert must be backwards. Same-stage revert is rejected
  //    too because it's an admin no-op masquerading as a state change.
  if (current === null) {
    // Reverting from null/unset is meaningless.
    return new InvalidStageTransitionError(current, target as OnboardingStage);
  }
  if (stageIndex(target as OnboardingStage) >= stageIndex(current)) {
    return new InvalidStageTransitionError(current, target as OnboardingStage);
  }
  return null;
}

export async function progressTo(
  tenantId: string,
  nextStageValue: OnboardingStage,
): Promise<void> {
  const db = createServiceRoleClient();

  // Validate: nextStageValue must be a valid forward progression from any prior stage.
  // We allow the caller to re-enter the same stage (idempotent) or advance forward.
  const { data: row, error: fetchErr } = await db
    .from("tenants")
    .select("onboarding_stage")
    .eq("id", tenantId)
    .single();

  if (fetchErr) {
    throw new Error(`progressTo: DB fetch error: ${fetchErr.message}`);
  }

  const current = row?.onboarding_stage as OnboardingStage | null;

  // Already at or past this stage — idempotent, no-op.
  if (isAtOrPast(current, nextStageValue)) return;

  // Only allow advancing exactly one stage forward (except branding can be
  // skipped from connect_setup to review_submitted).
  const nextIdx = stageIndex(nextStageValue);
  const currentIdx = stageIndex(current);

  // BYO hosts skip ica/tax_form/connect_setup (§3.1 tenant_type="byo_host").
  const ALLOWED_FORWARD_SKIPS = new Set([
    "connect_setup→review_submitted", // branding optional
    "legal→state_of_operation",        // BYO: skip ica + tax_form
    "ica→state_of_operation",          // BYO recovery
    "tax_form→state_of_operation",     // BYO recovery
    "subscription→branding",           // BYO: skip connect_setup
  ]);
  const isAllowedSkip = ALLOWED_FORWARD_SKIPS.has(`${current}→${nextStageValue}`);

  if (!isAllowedSkip && nextIdx !== currentIdx + 1) {
    throw new InvalidStageTransitionError(current, nextStageValue);
  }

  // D-091 P1 #39 — CAS update. Match the current stage as a guard against
  // concurrent writers. If 0 rows matched, someone else advanced the stage
  // between our read and write; surface as StaleStageError so the caller
  // can decide whether to retry.
  const baseQuery = db
    .from("tenants")
    .update({ onboarding_stage: nextStageValue })
    .eq("id", tenantId);
  const casQuery = current === null
    ? baseQuery.is("onboarding_stage", null)
    : baseQuery.eq("onboarding_stage", current);
  const { data: updatedRows, error: updateErr } = await casQuery.select("id");

  if (updateErr) {
    throw new Error(`progressTo: DB update error: ${updateErr.message}`);
  }
  if (!updatedRows || updatedRows.length !== 1) {
    throw new StaleStageError(current, nextStageValue);
  }
}

// revertTo is used by the admin "request more info" action to roll back a
// tenant's onboarding_stage to a prior stage.
//
// D-091 P1 #40 — validates inputs at the function boundary so callers
// can't pass untrusted JSON straight through:
//   1. Enum membership check (target must be a valid OnboardingStage)
//   2. Direction check (target must be BEFORE current)
//   3. CAS-guarded UPDATE matches current stage
export async function revertTo(
  tenantId: string,
  targetStage: OnboardingStage,
): Promise<void> {
  const db = createServiceRoleClient();

  // Read the current stage first so we can validate direction.
  const { data: row, error: fetchErr } = await db
    .from("tenants")
    .select("onboarding_stage")
    .eq("id", tenantId)
    .single();

  if (fetchErr) {
    throw new Error(`revertTo: DB fetch error: ${fetchErr.message}`);
  }

  const current = row?.onboarding_stage as OnboardingStage | null;

  const validationError = assertValidRevertTarget(current, targetStage);
  if (validationError) throw validationError;

  // CAS UPDATE — current is guaranteed non-null here by assertValidRevertTarget.
  const { data: updatedRows, error } = await db
    .from("tenants")
    .update({ onboarding_stage: targetStage })
    .eq("id", tenantId)
    .eq("onboarding_stage", current as OnboardingStage)
    .select("id");

  if (error) {
    throw new Error(`revertTo: DB update error: ${error.message}`);
  }
  if (!updatedRows || updatedRows.length !== 1) {
    throw new StaleStageError(current, targetStage);
  }
}
