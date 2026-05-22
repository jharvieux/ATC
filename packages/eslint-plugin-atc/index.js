"use strict";

// ESLint plugin entry. Imports the rule modules from @atc/config and
// re-exports them under the canonical eslint-plugin-X naming convention
// so apps can reference them as `plugins: ["atc"]` in legacy .eslintrc
// configs. The single source of truth for the rule code stays under
// packages/config/eslint-rules/.
//
// Spec ref: §5.4.4

const noDirectServiceRoleImport = require("../config/eslint-rules/no-direct-service-role-import");
const platformAdminFunctionsMustUseAuditWrapper = require("../config/eslint-rules/platform-admin-functions-must-use-audit-wrapper");
const noMoneyMath = require("../config/eslint-rules/no-money-math");

module.exports = {
  rules: {
    "no-direct-service-role-import": noDirectServiceRoleImport,
    "platform-admin-functions-must-use-audit-wrapper":
      platformAdminFunctionsMustUseAuditWrapper,
    "no-money-math": noMoneyMath,
  },
};
