"use strict";

// ESLint plugin entry. Imports the rule modules from @atc/config and
// re-exports them under the canonical eslint-plugin-X naming convention
// so apps can reference them as `plugins: ["atc"]` in legacy .eslintrc
// configs. The single source of truth for the rule code stays under
// packages/config/eslint-rules/.
//
// Spec refs: §5.4.4, §14.0.4, §26.3a

const noDirectServiceRoleImport = require("../config/eslint-rules/no-direct-service-role-import");
const platformAdminFunctionsMustUseAuditWrapper = require("../config/eslint-rules/platform-admin-functions-must-use-audit-wrapper");
const noMoneyMath = require("../config/eslint-rules/no-money-math");
// BP26 (§26.3a) — service-role discipline rules.
const noDirectServiceRoleEnvImport = require("../config/eslint-rules/no-direct-service-role-env-import");
const noAdHocTenantIdString = require("../config/eslint-rules/no-ad-hoc-tenant-id-string");
const noDirectAnthropicOrOpenaiImport = require("../config/eslint-rules/no-direct-anthropic-or-openai-import");
// BP31 (§32.7.1) — GitHub Octokit discipline.
const noDirectOctokitImport = require("../config/eslint-rules/no-direct-octokit-import");
// D-091 — slop-reduction + anti-pattern rules.
const noOrphanTodo = require("../config/eslint-rules/no-orphan-todo");
const noNarratingComments = require("../config/eslint-rules/no-narrating-comments");
const noUncheckedSupabaseMutation = require("../config/eslint-rules/no-unchecked-supabase-mutation");
const noCredentialsInUrl = require("../config/eslint-rules/no-credentials-in-url");
const noFailOpenOnResourceError = require("../config/eslint-rules/no-fail-open-on-resource-error");

module.exports = {
  rules: {
    "no-direct-service-role-import": noDirectServiceRoleImport,
    "platform-admin-functions-must-use-audit-wrapper":
      platformAdminFunctionsMustUseAuditWrapper,
    "no-money-math": noMoneyMath,
    // BP26
    "no-direct-service-role-env-import": noDirectServiceRoleEnvImport,
    "no-ad-hoc-tenant-id-string": noAdHocTenantIdString,
    "no-direct-anthropic-or-openai-import": noDirectAnthropicOrOpenaiImport,
    // BP31
    "no-direct-octokit-import": noDirectOctokitImport,
    // D-091 — slop reduction
    "no-orphan-todo": noOrphanTodo,
    "no-narrating-comments": noNarratingComments,
    // D-091 — anti-pattern rules (post Greptile audit)
    "no-unchecked-supabase-mutation": noUncheckedSupabaseMutation,
    "no-credentials-in-url": noCredentialsInUrl,
    "no-fail-open-on-resource-error": noFailOpenOnResourceError,
  },
};
