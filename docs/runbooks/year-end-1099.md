# Year-End 1099-NEC Runbook

**Spec reference:** §14.11 — 1099-NEC for sub-host subcontractors.

**Who:** Platform operator / finance admin.

**When:** January of each year (IRS deadline: January 31 for electronic delivery).

---

## Overview

Stripe Connect Express automatically files 1099-NEC forms for connected accounts that
received ≥ $600 in payouts during the calendar year. The platform does NOT need to
generate or mail 1099s manually for sub-hosts paid via Stripe Connect.

---

## Annual checklist

1. **Confirm Stripe 1099 filing is enabled.**
   - Log into Stripe Dashboard → Connect → Tax forms.
   - Verify that 1099-NEC filing is enabled for your platform.
   - Stripe files electronically with the IRS; sub-hosts receive their form via
     their Stripe Express dashboard or by mail if paper delivery is configured.

2. **Identify sub-hosts at the $600 threshold.**
   - In Stripe Dashboard → Reports → Payouts, filter to the prior calendar year.
   - Alternatively, run a DB query:
     ```sql
     SELECT
       t.id AS tenant_id,
       t.display_name,
       t.stripe_connect_account_id,
       SUM(pr.amount_cents) / 100.0 AS total_paid_usd
     FROM payout_records pr
     JOIN tenants t ON pr.tenant_id = t.id
     WHERE pr.status = 'paid'
       AND pr.settled_at BETWEEN '<YYYY>-01-01' AND '<YYYY>-12-31'
     GROUP BY t.id, t.display_name, t.stripe_connect_account_id
     HAVING SUM(pr.amount_cents) >= 60000  -- $600 in cents
     ORDER BY total_paid_usd DESC;
     ```

3. **Verify Stripe has filed for all threshold accounts.**
   - In Stripe Dashboard, check "Tax forms" for each Connect account above $600.
   - If a Connect account is missing a form, contact Stripe support.

4. **Log completion to MEMORY.md.**
   - Add an entry: `1099-NEC for <YYYY>: <N> sub-hosts at or above $600 threshold. Stripe filing confirmed YYYY-MM-DD.`

---

## Notes

- **BYO-host tenants** do not receive commission payouts via Stripe Connect (they are
  paid by their own host agency, not by this platform). No 1099 action needed for them.
- **Platform-level employees** (if any) receive W-2, not 1099-NEC. Out of scope for this runbook.
- If your platform operates in states with lower 1099 reporting thresholds (some states
  require $0 threshold for electronic payments), consult your accountant.
