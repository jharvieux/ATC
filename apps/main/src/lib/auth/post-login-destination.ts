// Pure routing logic for "where does a freshly-authenticated user go?"
//
// Before this existed, every successful sign-in landed on `/` — which is a
// near-empty placeholder with just a logo. End customers, tenant agents,
// and platform admins all stared at the same blank page and had to know
// which deep URL to type next.
//
// Kept pure (no DB / Request access) so it can be unit-tested and reused
// from anywhere — the request-side adapter is in resolve-post-login.ts.

import { type OnboardingStage } from "@/lib/onboarding/state-machine";
import type { UserRole } from "./permission-grants";

export type PostLoginRole = UserRole;

/**
 * Discriminated union so the type can't represent nonsense (e.g.
 * "admin with role=viewer", which used to be passed as `{ role: "viewer",
 * isPlatformAdmin: true }` from the resolver). When `isPlatformAdmin` is
 * true, the role/stage fields are irrelevant and not even allowed.
 */
export type PostLoginInputs =
  | { isPlatformAdmin: true }
  | {
      isPlatformAdmin: false;
      role: PostLoginRole;
      /**
       * The tenant's onboarding_stage. `null` for a brand-new tenant whose
       * tenants row exists but hasn't started any stage; `"complete"` for
       * fully-onboarded tenants. `undefined` for users that aren't tenant
       * staff (e.g. end customers on the platform tenant).
       */
      tenantOnboardingStage?: OnboardingStage | null;
    };

/**
 * Map onboarding_stage values to the path that stage's UI lives at. The
 * stage names use snake_case (matching the SQL enum); the URLs use
 * kebab-case (matching Next.js conventions), so this is the translation
 * layer between them. Used when sending an onboarding-incomplete tenant
 * to the next pending step.
 *
 * Sources: lib/onboarding/state-machine.ts (ONBOARDING_STAGES enum)
 *          app/(onboarding)/onboarding/[stage]/page.tsx (per-stage routes)
 */
const STAGE_TO_URL: Record<Exclude<OnboardingStage, "complete">, string> = {
  signup: "/onboarding/profile",
  profile: "/onboarding/profile",
  legal: "/onboarding/legal",
  ica: "/onboarding/ica",
  tax_form: "/onboarding/tax-form",
  state_of_operation: "/onboarding/state-of-operation",
  tier_select: "/onboarding/tier-select",
  subscription: "/onboarding/subscription",
  connect_setup: "/onboarding/connect",
  branding: "/onboarding/branding",
  review_submitted: "/onboarding/review-submitted",
};

/**
 * Compute the post-login destination. Pure function.
 *
 * Order matters — earlier conditions take precedence:
 *   1. Platform admin → /admin. A platform admin may also be a tenant
 *      member; admin work is the dominant reason they log in. They can
 *      navigate from /admin to anything else.
 *   2. Tenant staff with incomplete onboarding → next pending stage.
 *      Customers don't have onboarding stages.
 *   3. Tenant staff fully onboarded → /crm/contacts (tenant home;
 *      most-used tenant page per existing tenant-admin nav).
 *   4. Viewer (end customer) → /chat.
 */
export function postLoginDestination(inputs: PostLoginInputs): string {
  if (inputs.isPlatformAdmin) return "/admin";

  const stage = inputs.tenantOnboardingStage;
  if (stage && stage !== "complete") {
    return STAGE_TO_URL[stage];
  }

  if (inputs.role === "tenant_owner" || inputs.role === "agent") {
    return "/crm/contacts";
  }

  return "/chat";
}
