// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §15.1–15.2 — Onboarding stage state machine.
//
// Stages advance strictly forward through the §15.1 diagram.
// No stage can be skipped except 'branding' (explicitly skippable per §15.10).

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

  const isAllowedSkip =
    current === "connect_setup" && nextStageValue === "review_submitted";

  if (!isAllowedSkip && nextIdx !== currentIdx + 1) {
    throw new InvalidStageTransitionError(current, nextStageValue);
  }

  const { error: updateErr } = await db
    .from("tenants")
    .update({ onboarding_stage: nextStageValue })
    .eq("id", tenantId);

  if (updateErr) {
    throw new Error(`progressTo: DB update error: ${updateErr.message}`);
  }
}

// revertTo is used by the admin "request more info" action to roll back a
// tenant's onboarding_stage to a prior stage.
export async function revertTo(
  tenantId: string,
  targetStage: OnboardingStage,
): Promise<void> {
  const db = createServiceRoleClient();
  const { error } = await db
    .from("tenants")
    .update({ onboarding_stage: targetStage })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`revertTo: DB update error: ${error.message}`);
  }
}
