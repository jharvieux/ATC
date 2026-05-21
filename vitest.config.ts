import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the apps/main tsconfig path alias so test files that import
      // src code via @/ work without needing Next.js's own resolver.
      "@": path.resolve(__dirname, "apps/main/src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["scripts/**/*.ts"],
    },
  },
});
