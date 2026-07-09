"use strict";

// ESLint plugin exposing the project's custom rules under the "atc" name.
// Apps depend on `@atc/config` as a devDependency and reference the plugin
// in their .eslintrc as `plugins: ["atc"]`.
//
// Spec refs: §5.4.4, §14.0.4, §26.3a

const noDirectServiceRoleImport = require("./eslint-rules/no-direct-service-role-import");
const platformAdminFunctionsMustUseAuditWrapper = require("./eslint-rules/platform-admin-functions-must-use-audit-wrapper");
const noMoneyMath = require("./eslint-rules/no-money-math");
// BP26 (§26.3a) — service-role discipline rules.
const noDirectServiceRoleEnvImport = require("./eslint-rules/no-direct-service-role-env-import");
const noAdHocTenantIdString = require("./eslint-rules/no-ad-hoc-tenant-id-string");
const noDirectAnthropicOrOpenaiImport = require("./eslint-rules/no-direct-anthropic-or-openai-import");
// D-091 — slop-reduction + anti-pattern rules.
const noOrphanTodo = require("./eslint-rules/no-orphan-todo");
const noNarratingComments = require("./eslint-rules/no-narrating-comments");
const noUncheckedSupabaseMutation = require("./eslint-rules/no-unchecked-supabase-mutation");
const noCredentialsInUrl = require("./eslint-rules/no-credentials-in-url");
const noFailOpenOnResourceError = require("./eslint-rules/no-fail-open-on-resource-error");
// Shift-left guard batch (#1613) — audit-write, escapeHtml, and rag client-factory discipline.
const noDirectAuditLogWrite = require("./eslint-rules/no-direct-audit-log-write");
const noLocalEscapeHtml = require("./eslint-rules/no-local-escape-html");
const noInlineSupabaseClient = require("./eslint-rules/no-inline-supabase-client");
const noSecretShapedPublicEnv = require("./eslint-rules/no-secret-shaped-public-env");

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
    // D-091 — slop reduction
    "no-orphan-todo": noOrphanTodo,
    "no-narrating-comments": noNarratingComments,
    // D-091 — anti-pattern rules
    "no-unchecked-supabase-mutation": noUncheckedSupabaseMutation,
    "no-credentials-in-url": noCredentialsInUrl,
    "no-fail-open-on-resource-error": noFailOpenOnResourceError,
    // Shift-left guard batch (#1613)
    "no-direct-audit-log-write": noDirectAuditLogWrite,
    "no-local-escape-html": noLocalEscapeHtml,
    "no-inline-supabase-client": noInlineSupabaseClient,
    "no-secret-shaped-public-env": noSecretShapedPublicEnv,
  },
};
