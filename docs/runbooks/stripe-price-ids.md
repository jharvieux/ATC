# Stripe price-ID hygiene per environment

**Owner:** platform operator
**Spec refs:** §28.7, §28.22 (first call-out), §3.3
**Audience:** anyone provisioning a Vercel project or rotating Stripe keys

## The risk

Stripe issues two parallel sets of `price_*` identifiers: one in **test mode**
and one in **live mode**. The shape of the IDs is identical (`price_...`) — there
is **no runtime check** that catches a test-mode ID accidentally deployed to the
live-mode environment, or vice versa.

If a live-mode `STRIPE_SECRET_KEY` is paired with test-mode price IDs (or any
mismatched combination), checkout fails for every real customer with a generic
"price not found" error — usually noticed only after the first paid signup.

## The rule

Each deploy environment owns a **complete, non-overlapping** set of price IDs
matched to its `STRIPE_SECRET_KEY` mode:

| Environment | Key mode | Price IDs |
|---|---|---|
| Local dev | `sk_test_…` | test-mode `price_…` |
| Vercel **dev** | `sk_test_…` | test-mode `price_…` |
| Vercel **staging** | `sk_test_…` | test-mode `price_…` |
| Vercel **production** | `sk_live_…` | live-mode `price_…` |

Vercel env vars are scoped per-environment; this rule is enforced **procedurally**
because the runtime check can verify only the `STRIPE_SECRET_KEY` prefix
(`sk_test_` vs `sk_live_`), not whether a given `price_…` ID matches.

## Setup checklist (new environment)

For each environment (test or live), in the **Stripe dashboard**:

1. Confirm you're in the right mode (test-mode toggle, top-right).
2. Create **one price** per tier × billing-period combination. Spec §3.3 and
   §28.7 list the 16 prices currently expected (8 BYO + 8 Sub-Host).
3. For the seat add-ons, configure as a **Stripe tiered price** with the §3.3
   ladder (e.g., BYO Agency: $59 for users 2–4, $49 for 5–10, $39 for 11+).
4. Copy each `price_…` ID into the matching Vercel env var **scoped to the
   right environment** (Vercel → Settings → Environment Variables → choose
   Production / Preview / Development).
5. Trigger a redeploy of that environment so the new vars take effect.
6. Smoke test: create a checkout session against each tier; confirm the
   Stripe receipt lands in the correct mode (test vs live).

## Naming convention (code-side)

The schema in `apps/main/src/lib/env.ts` keeps the existing convention:

```
STRIPE_PRICE_<TIER>_<BILLING_PERIOD>      # e.g., STRIPE_PRICE_BYO_PROFESSIONAL_MONTHLY
STRIPE_PRICE_<TIER>_AGENCY_SEATS_<PERIOD> # additional-seat tiered price
```

> **Spec drift waiver** — §28.7 spells the names as `STRIPE_PRICE_BYO_PRO_*` and
> `STRIPE_PRICE_*_AGENCY_SEAT_*` (singular). Code keeps `_PROFESSIONAL_` and
> `_SEATS_` per operator decision (MEMORY D-062). The spec will be amended.

## Verification

The boot-time Zod schema asserts `STRIPE_SECRET_KEY.startsWith("sk_test_")` or
`startsWith("sk_live_")` per §28.22. There is **no automated guard** that the
paired `STRIPE_PRICE_*` IDs are from the matching mode — this runbook is the
procedural safety net. Always smoke-test checkout in each environment after
rotating any Stripe variable.

## Rotation impact

When you rotate `STRIPE_SECRET_KEY`:

- **Within the same mode** (e.g., `sk_live_OLD` → `sk_live_NEW`): no price-ID
  changes required.
- **Switching modes** (e.g., promoting a project from test to live): every
  `STRIPE_PRICE_*` ID must also be replaced with its live-mode counterpart.

See `docs/runbooks/secret-rotation.md` for the broader rotation flow.
