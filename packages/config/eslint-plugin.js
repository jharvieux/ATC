"use strict";

// Lightweight ESLint plugin re-exporting the two custom rules from
// `./eslint-rules/`. Apps depend on `@atc/config` as a devDependency and
// reference the plugin under the name "atc" in their eslint config.
//
// Spec ref: §5.4.4

const noDirectServiceRoleImport = require("./eslint-rules/no-direct-service-role-import");
const platformAdminFunctionsMustUseAuditWrapper = require("./eslint-rules/platform-admin-functions-must-use-audit-wrapper");

module.exports = {
  rules: {
    "no-direct-service-role-import": noDirectServiceRoleImport,
    "platform-admin-functions-must-use-audit-wrapper":
      platformAdminFunctionsMustUseAuditWrapper,
  },
};
