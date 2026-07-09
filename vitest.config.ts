import { defineConfig } from "vitest/config";
import path from "path";
import fs from "fs";

// jsdom tests need react and react-dom to resolve from the same pnpm virtual
// store instance so hooks work. @testing-library/react lives in the pnpm
// virtual store and loads react-dom from its co-located peer dep directory.
// Pointing all react/react-dom aliases at that same directory prevents the
// "invalid hook call" error caused by dual React instances.
//
// Derived from @testing-library/react's real path so the version string is
// never hardcoded — remains correct across React upgrades.
const testingLibReal = fs.realpathSync(require.resolve("@testing-library/react"));
// Up from @testing-library/react/dist/index.js → @testing-library/react → node_modules (virtual)
const virtualNodeModules = path.join(path.dirname(testingLibReal), "..", "..", "..");
const reactDir = fs.realpathSync(path.join(virtualNodeModules, "react"));
const reactDomDir = fs.realpathSync(path.join(virtualNodeModules, "react-dom"));

// `server-only` (the #1524 poison-pill) throws on import unless the bundler
// sets the `react-server` resolve condition, which Next.js does at build time
// but vitest does not. Point the bare specifier at the package's own no-op
// `empty.js` — the exact file the `react-server` condition resolves to — so
// server-exclusive modules remain importable in the node/jsdom test env.
// Resolved from apps/main (where the dep lives; not hoisted to root).
const serverOnlyEmpty = path.join(
  path.dirname(require.resolve("server-only", { paths: [path.resolve(__dirname, "apps/main")] })),
  "empty.js",
);

export default defineConfig({
  // apps/main tsconfig uses "jsx": "preserve" (Next.js handles it at build time).
  // Vitest uses esbuild and must be told to use the automatic JSX runtime so
  // .tsx files don't require an explicit React import at the top of each file.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: reactDir,
  },
  resolve: {
    alias: {
      // Mirror the apps/main tsconfig path alias so test files that import
      // src code via @/ work without needing Next.js's own resolver.
      "@": path.resolve(__dirname, "apps/main/src"),
      // Resolve the local contracts workspace package (not symlinked into
      // root node_modules — pnpm keeps it in packages/).
      "@atc/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
      // Ensure react and react-dom resolve from the same pnpm virtual store
      // instance (required for jsdom tests; no-op for node-environment tests).
      react: reactDir,
      "react-dom": reactDomDir,
      "react-dom/server": path.join(reactDomDir, "server"),
      "react-dom/client": path.join(reactDomDir, "client"),
      "server-only": serverOnlyEmpty,
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "apps/main/test/**/*.test.ts", "apps/main/test/**/*.test.tsx"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["scripts/**/*.ts"],
    },
  },
});
