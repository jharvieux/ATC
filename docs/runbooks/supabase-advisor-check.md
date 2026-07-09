# Supabase Security Advisor CI check

Weekly guard that polls the Supabase Security Advisor for the `atc-main` and
`atc-rag` projects and fails (opening a tracked issue) on any WARN+ finding not
in the accepted-risk baseline. Closes the gap where project/platform config
(leaked-password protection, SECURITY DEFINER RPC exposure, extensions in
`public`, RLS-without-policy) had no CI coverage — only the SQL layer did.

Issue: #1635.

## Moving parts

| Piece | Path |
| --- | --- |
| Workflow (weekly + manual) | `.github/workflows/supabase-advisor-check.yml` |
| Check script | `scripts/check-supabase-advisors.ts` |
| Project config | `.github/supabase-advisor-config.json` |
| Accepted-risk baseline | `scripts/supabase-advisor-baseline.txt` |

The check calls the Management API endpoint (experimental)
`GET https://api.supabase.com/v1/projects/{ref}/advisors/security` per project,
keeps only `WARN`/`ERROR` lints, drops any whose `<project-name>:<cache_key>` is
in the baseline, and exits non-zero if any remain. On failure the workflow opens
(or comments on) a single `supabase-advisor`-labelled issue.

## Operator action required (one-time)

The check needs a Supabase Management API token. **No such secret exists in CI
today** — until it is added, the job fails loud with an instruction to add it.

1. Create a Supabase Personal Access Token (Supabase dashboard → Account →
   Access Tokens) scoped to at least `database:read` + `advisors_read`.
2. Add it as a repository Actions secret named **`SUPABASE_ACCESS_TOKEN`**.

Project refs are already in `.github/supabase-advisor-config.json` (they are
semi-public — they appear in each project's URL/anon key). No secret needed for
those.

## Responding to a finding

When the tracked issue appears, for each listed finding either:

- **Fix it** (preferred). E.g. the currently-open
  `auth_leaked_password_protection` on `atc-main` is fixed by enabling
  "Leaked password protection" in the Auth settings — a dashboard toggle, so per
  CLAUDE.md it needs operator approval, not an agent flipping it.
- **Accept it** — add the `baseline key` line printed in the output to
  `scripts/supabase-advisor-baseline.txt` with an inline reason. Only do this
  when the finding is genuinely intentional.

## Currently baselined (accepted) findings

- `atc-main` — 3× `authenticated_security_definer_function_executable`
  (`auth_user_can_access_conversation`, `auth_user_in_tenant`,
  `tenant_is_active`): intentional RLS-policy helper functions (#1369).
- `atc-rag` — `extension_in_public` (`vector`): pgvector in `public` is the
  Supabase default; moving it is disruptive and low-risk here.

`auth_leaked_password_protection` (atc-main) is intentionally **not** baselined —
it is actionable and will surface until enabled.
