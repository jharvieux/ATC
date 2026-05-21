const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");
const importPlugin = require("eslint-plugin-import");
const atcPlugin = require("./eslint-plugin");

/** @type {import("eslint").Linter.FlatConfig[]} */
const config = [
  {
    ignores: ["node_modules/**", ".next/**", "dist/**", "coverage/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
      atc: atcPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
      },
    },
    rules: {
      ...tsPlugin.configs["recommended"].rules,
      // Spec §5.4.4 — service-role-client.ts may only be imported by the
      // two named files; platformAdmin* functions must use the audit wrapper.
      "atc/no-direct-service-role-import": "error",
      "atc/platform-admin-functions-must-use-audit-wrapper": "error",
    },
  },
];

module.exports = config;
