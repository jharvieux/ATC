# Service-role discipline exceptions

Per §26.3a / §26.11, the platform enforces four ESLint rules to keep the service-role pattern intact:

- `atc/no-direct-service-role-import` — allowlist of file paths permitted to import `service-role-client`
- `atc/no-direct-service-role-env-import` — `SUPABASE_SERVICE_ROLE_KEY` only readable in `service-role-client.ts` and `env.ts`
- `atc/no-direct-anthropic-or-openai-import` — `@anthropic-ai/sdk` / `openai` only importable under `src/lib/ai/**`
- `atc/no-ad-hoc-tenant-id-string` — heuristic warning on function signatures taking `tenant_id: string` while issuing DB queries

When one of these rules fires legitimately, an engineer:

1. Adds `// eslint-disable-next-line <rule>` immediately before the line.
2. Appends an entry to the table below.
3. Files a follow-up ticket if the exception should be eliminated.

Quarterly review by the platform super-admin per §26.11.

## Exception log

| Date       | File                                              | Rule                                | Reason                                                                 | Reviewer |
| ---------- | ------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- | -------- |
| _example_  | apps/main/src/scripts/one-off-backfill.ts         | no-direct-service-role-import       | One-off CLI backfill outside any request context. Removed after run.   | _name_   |

(empty — populate as exceptions arise)

## BP26 staged severity

Two of the new BP26 rules ship at severity `off` initially because the
existing codebase has legitimate prior call sites that would all need
either migration or explicit `eslint-disable` markers in this PR. The
rules are registered + tested + ready to flip; the follow-on PRs do
the sweep.

| Rule                                             | Current severity | Flips to error when                                                                 |
| ------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------- |
| `atc/no-direct-anthropic-or-openai-import`       | `off`            | BP27 ships `lib/ai/call-wrapper.ts` and sweeps existing Anthropic / OpenAI imports. |
| `atc/no-ad-hoc-tenant-id-string`                 | `off`            | A follow-on sweep PR audits each `tenant_id: string` parameter and adds disables.   |

The other four atc/* rules remain at `error`. See MEMORY D-059.
