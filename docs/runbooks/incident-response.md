# Incident response

> Spec ref: §26.7. Adjacent: `breach-response.md` (§25.9 / §26.10).

## Priority matrix

| Priority | When to use | First response | Containment target | Page |
|---|---|---|---|---|
| **P0 — Active customer harm** | Hate-speech AI response live in production; confirmed payment fraud; data exfiltration in progress. | < 15 min | < 1h | Primary oncall + executive escalation. |
| **P1 — Imminent harm or major business impact** | Cross-tenant data leak detected; sustained AI cost surge eating tenant revenue; auth provider outage. | < 1h | < 4h | Primary oncall. |
| **P2 — Degraded service** | Vendor outage (Anthropic / Stripe / Resend down) with fallback engaged; elevated error rate. | Within business hours | < 24h | Open incident; queue for current business hour. |
| **P3 — Operational toil or low-impact bug** | Single-tenant misconfig; non-critical analytics gap. | Next business day | Next sprint | Queue for triage. |

## Process per priority

### P0
1. **Page** primary oncall (PagerDuty/Opsgenie or phone tree from the contact list below).
2. **Declare** in `#incidents` channel.
3. **Contain** immediately — pull the trigger on §10.6 AI kill switch if the harm is AI-driven; freeze writes via the maintenance flag if the harm is data-write driven.
4. **Engage** legal counsel within 1h if customer data or commission disputes are implicated.
5. **Declare a security incident** (`POST /api/admin/security-incident/declare`) if confirmed data exposure — this writes a `security_incidents` row and triggers a forensics snapshot.
6. **Notify** per §25.9 breach SLAs (`docs/runbooks/breach-response.md`) if PII is implicated: tenant admins ≤ 24h, end users ≤ 72h.
7. **Post-mortem** within 14 days; public if customer-facing.

### P1
1. Page primary oncall.
2. Declare in `#incidents`.
3. Contain within 4h; engage counsel within 4h if data class is sensitive.
4. Post-mortem within 30 days.

### P2
1. Open incident in tracking system.
2. Investigate during business hours.
3. If vendor outage: confirm vendor-health registry reflects the state; verify degraded-mode fallbacks are active; communicate via status page once impact is sustained > 15 min.

### P3
1. Triage at next sprint planning.

## When to declare a security incident

Declare via the API (`POST /api/admin/security-incident/declare`) if **any** of:
- Confirmed unauthorized access to data.
- Confirmed credential compromise (any key in the `APP_ENCRYPTION_KEY_*` or `FORENSICS_ENCRYPTION_KEY_*` series).
- Confirmed cross-tenant RLS bypass detected by the §26.6 monitor.
- Confirmed PII exfiltration.
- Active compromise indicators (suspicious DB activity, anomalous AI cost spike attributable to abuse).

Declaration writes a `security_incidents` row AND captures a forensics snapshot of audit_log around the incident window. The incident commander coordinates from there.

## Oncall rotation (operator-filled template)

| Week | Primary | Backup |
|---|---|---|
| _example_ | _name_ | _name_ |

## Contact list (operator-filled)

See `docs/runbooks/breach-response.md` for the canonical list (counsel, oncall engineer, executive escalation, California AG).

## Related materials

- Breach response (§25.9 / §26.10): `docs/runbooks/breach-response.md`
- Forensics manual access (§26.5a): `docs/runbooks/forensics-manual-access.md`
- Four-layer auth: `docs/architecture/four-layer-auth.md`
- Service-role exceptions log: `docs/exceptions-service-role.md`
- Staging PII risk acceptance (§25.10): `docs/runbooks/staging-pii-risk-acceptance.md`
