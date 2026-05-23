# Data breach response runbook

> **Compliance owner:** Platform admin + legal counsel.
> **Spec refs:** §25.9 (notification SLAs), §26.10 (response process).
> **Last reviewed:** TODO(operator).

## SLAs

| Recipient | Window from discovery | Channel |
|---|---|---|
| Tenant admins of affected tenants | 24 hours | `sendBreachNotifications` (BreachNotificationTenantAdmin) |
| Affected end users | 72 hours | `sendBreachNotifications` (BreachNotificationUser) |
| California AG (if CA residents affected ≥ 500) | Per Cal. Civ. Code §1798.82 | Submit via OAG website |
| Other state AGs | Per state law | Counsel determines |
| Public disclosure | When required by state/federal law | Counsel determines |

## Severity rubric

| Severity | Confirmed/Suspected | Data class | Volume |
|---|---|---|---|
| critical | confirmed | sensitive (financial, government ID, passwords) | any |
| high | confirmed | PII (email, phone, DOB) | > 100 records |
| medium | suspected, OR confirmed PII < 100 records | PII | n/a |
| low | suspected, no confirmed PII exposure | n/a | n/a |

## Seven-step process (§26.10)

1. **Detect.** Alert source: monitoring, third-party notification, internal report, customer report.
2. **Triage.** On-call engineer + legal counsel jointly assign severity, scope, data classes, customer counts.
3. **Contain.** Stop ongoing exposure (rotate keys, revoke tokens, isolate compromised resources). Do NOT delete evidence.
4. **Investigate.** Forensics. Capture forensics snapshots into `forensics_log` (BP25 capture; BP26 decrypt path). Engage outside counsel if severity ≥ high.
5. **Notify.** Trigger `sendBreachNotifications` with the assembled `affected_users` + `affected_tenant_admins` lists. Tenant admins within 24h, users within 72h.
6. **Remediate.** Patch the root cause. Document the fix in this runbook's incident log.
7. **Post-mortem.** Within 30 days. Public post-mortem if customer-facing impact occurred.

## Decision tree

```
Detected event
  ├─ Confirmed PII exposure?
  │   ├─ Yes → severity ≥ high
  │   │   ├─ Affected count > 500 CA residents? → notify California AG
  │   │   └─ Notify users within 72h, tenant admins within 24h
  │   └─ No → severity = low (still log + investigate)
  └─ Suspected only?
      ├─ Investigating actively → severity = medium until confirmed/cleared
      └─ Cleared after investigation → close + post-mortem
```

## Contact list (operator to populate)

| Role | Name | Email | Phone |
|---|---|---|---|
| Outside counsel (privacy) | TODO | TODO | TODO |
| Outside counsel (litigation) | TODO | TODO | TODO |
| On-call engineer (primary) | TODO | TODO | TODO |
| On-call engineer (backup) | TODO | TODO | TODO |
| Executive escalation | TODO | TODO | TODO |
| California AG (notification portal) | https://oag.ca.gov/privacy/databreach/reporting | N/A | N/A |
| Cyber insurance contact | TODO | TODO | TODO |

## Templates

- User-facing: `apps/main/src/emails/BreachNotificationUser.tsx`
- Tenant-admin-facing: `apps/main/src/emails/BreachNotificationTenantAdmin.tsx`
- Both extend BrandedLayout (§16.8) so the footer carries CAN-SPAM compliant addresses.
- **Wording is `TODO(legal-counsel)`.** Same attorney engagement as the ICA chunk-license clause (D-049 / D-050 / D-051).

## Helper API

```ts
import { sendBreachNotifications } from "@/lib/email/send-breach-notifications";

await sendBreachNotifications({
  db,
  severity: "high",
  affected_users: [...],
  affected_tenant_admins: [...],
  tenant_records: { /* ... */ },
  summary_for_user: { /* ... */ },
  summary_for_admin: { /* ... */ },
  platform_unsubscribe_url: "https://app.ai-travelconcierge.com/email/unsubscribe?token=...",
});
```

## Incident log (chronological, newest on top)

TODO(operator): record each incident with discovery date, severity, scope, root cause, remediation.
