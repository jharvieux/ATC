# Strawman: host-fee `tiered` + `minimum_commission_threshold` (#1247)

**Status:** proposal — needs spec-owner sign-off before implementation.
**Owner to confirm:** §12.6 / §14 money rules.
**Context:** §12.6 defines the `host_booking_fee_configs` / `tenant_host_fee_overrides`
columns (`tiered_rules JSONB`, `minimum_commission_threshold NUMERIC(12,2)`) but
not their *semantics*. The resolver `resolveHostFeeCents(fee, grossCommissionCents)`
in `apps/main/src/app/api/bookings/[id]/submit/route.ts` handles `none`/`flat`/`percent`
(fixed in #1190) and silently returns `$0` for `tiered`, and never applies the
threshold. This doc proposes concrete semantics for the spec owner to accept/edit.
Nothing below is implemented — it's a strawman to react to.

Per §12.6, the host fee is *"deducted from gross commission BEFORE the platform's
share."* So the resolver's existing `percent` basis is **gross commission**, and
this strawman keeps that basis for tiers and the threshold (consistency).

---

## 1. `tiered_rules` JSONB — proposed shape

```jsonc
{
  "basis": "gross_commission",      // fixed for now (matches percent); see Q2
  "mode": "flat_per_bracket",       // "flat_per_bracket" | "marginal"; see Q3
  "tiers": [
    { "up_to_cents": 50000,  "flat_fee_cents": 2500 },        // ≤ $500  → $25 flat
    { "up_to_cents": 200000, "percent_of_commission": 0.05 }, // ≤ $2000 → 5%
    { "up_to_cents": null,   "percent_of_commission": 0.03 }  // > $2000 → 3%
  ]
}
```

**Field rules (proposed):**
- `tiers` is ordered ascending by `up_to_cents`. The **matching tier** is the first
  whose `up_to_cents >= grossCommissionCents`; the final tier MUST have
  `up_to_cents: null` ("and above") so every amount matches exactly one tier.
- Each tier carries **exactly one** of `flat_fee_cents` or `percent_of_commission`
  (validate at write time; reject both/neither).
- `up_to_cents` is an inclusive upper bound, in cents (consistent with the rest of
  the money path, which is bigint cents).
- `percent_of_commission` is a 0–1 rate (matches the existing `percent` column /
  `toRate`).

**Resolution (`mode: "flat_per_bracket"` — recommended):** the single matching
tier's rule applies to the *whole* gross commission. Simplest; matches a plain
"find the bracket, apply its rule" reading.

**Alternative (`mode: "marginal"`):** like tax brackets — each slice of the
commission is charged at its own tier's rate, summed. More complex; only build if
the spec owner says host agreements actually work this way. The `mode` field lets
us support both without a schema change, but **we should ship only one to start.**

---

## 2. `minimum_commission_threshold` — proposed rule

Three candidate semantics. **Recommendation: Option A** (simplest; reads as "don't
levy a host fee on tiny commissions").

| Option | Rule | Example: gross $30, computed fee $25, threshold $50 |
|---|---|---|
| **A (recommended)** | Fee applies only when `gross_commission >= threshold`; else fee = **0**. | gross $30 < $50 → **fee 0**, net $30 |
| B | Fee is **capped** so `net = gross − fee` never drops below `threshold`. | fee capped to $0 (since $30 − $25 = $5 < $50, and gross is already < threshold) → net $30 |
| C | `net` is **floored** at `threshold` regardless of the computed fee. | net floored to $50 — but gross is only $30, so this is incoherent when gross < threshold |

Option A is unambiguous in every case. B and C get strange when `gross < threshold`
(C can floor net *above* gross). If the intent is a net-protection floor rather than
a "skip small commissions" gate, we need the spec owner to define behavior when
`gross < threshold`.

---

## 3. Worked examples (Option A + flat_per_bracket, gross-commission basis)

Using the schema in §1. Money is half-away-from-zero per §14, cents (bigint).

| Gross commission | Matching tier | Raw fee | Threshold $50 (Option A) | Host fee charged |
|---|---|---|---|---|
| $400 (40000¢) | `≤ $500` flat | $25 | gross ≥ $50 → apply | **$25** |
| $40 (4000¢)  | `≤ $500` flat | $25 | gross < $50 → skip | **$0** |
| $1500 (150000¢) | `≤ $2000` 5% | $75 | apply | **$75** |
| $5000 (500000¢) | `> $2000` 3% | $150 | apply | **$150** |

(Threshold is checked against **gross commission**, not the post-fee net, under
Option A.)

---

## 4. Implementation notes (once semantics are signed off)

- **The SELECT must be widened.** Today `feeConfig`/`feeOverride` are fetched with
  only `id, fee_type, flat_fee_amount, percent_of_commission`. Add `tiered_rules`
  and `minimum_commission_threshold` to both `.select(...)` calls — the
  static-column-reader guard (#1160) will otherwise be moot because the columns
  aren't read at all yet.
- **Validate `tiered_rules` on read** (it's free-form JSONB): a Zod schema for the
  shape above; a malformed config should **fail loud**, not silently resolve `$0`
  (that was the original #1190-class bug).
- `resolveHostFeeCents` stays a **pure function** (`fee`, `grossCommissionCents`) →
  easy to unit-test; add the threshold as a final clamp step after the type switch.
- Use the money lib (`dollarsToCents` is already used for `flat`; `multiplyRate` /
  `toRate` for percent) — no inline arithmetic.
- **Tests:** worked-example tests mirroring the §14.3 flat/percent tests added in
  #1190 — one per tier boundary (just-below / at / just-above each `up_to_cents`),
  plus the threshold gate (gross just below / at / above), plus malformed
  `tiered_rules` → fail-loud.

---

## 5. Decisions needed from the spec owner

- **Q1.** `tiered_rules` shape as in §1 — OK, or different fields? Can a tier be both
  flat + percent, or always exactly one (proposed: exactly one)?
- **Q2.** Basis = **gross commission** (proposed), or fare/booking total?
- **Q3.** `mode` = **flat_per_bracket** (proposed) or **marginal**? (Ship one first.)
- **Q4.** `minimum_commission_threshold` = **Option A** (proposed), B, or C? If B/C,
  define behavior when `gross < threshold`.
- **Q5.** Does the threshold compare against **gross** commission (proposed, Option A)
  or the **post-fee net**?

Once Q1–Q5 are answered, this is a ~1-file resolver change + a Zod validator + tests
(no migration — the columns already exist).
