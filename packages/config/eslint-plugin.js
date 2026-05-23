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
  },
};
