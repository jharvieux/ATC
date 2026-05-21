const { FlatCompat } = require("@eslint/eslintrc");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");
const importPlugin = require("eslint-plugin-import");

const compat = new FlatCompat();

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
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
      },
    },
    rules: {
      ...tsPlugin.configs["recommended"].rules,
      // Path restrictions — specific rules added per Build Prompt 03
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            // Populated in Build Prompt 03 with service-role import restrictions
          ],
        },
      ],
    },
  },
];

module.exports = config;
