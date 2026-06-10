import { defineConfig } from "vitest/config";
import path from "path";

// jsdom tests need react and react-dom to resolve from the same pnpm virtual
// store instance so hooks work. Without this alias vitest picks up a stale
// copy of react from the main checkout's flat node_modules while react-dom
// resolves from the worktree's .pnpm store — triggering "invalid hook call".
const REACT_RESOLVE = path.resolve(
  __dirname,
  "node_modules/.pnpm/react@18.3.1/node_modules/react",
);
const REACT_DOM_RESOLVE = path.resolve(
  __dirname,
  "node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom",
);

export default defineConfig({
  // apps/main tsconfig uses "jsx": "preserve" (Next.js handles it at build time).
  // Vitest uses esbuild and must be told to use the automatic JSX runtime so
  // .tsx files don't require an explicit React import at the top of each file.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: REACT_RESOLVE,
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
      react: REACT_RESOLVE,
      "react-dom": REACT_DOM_RESOLVE,
      "react-dom/server": path.join(REACT_DOM_RESOLVE, "server"),
      "react-dom/client": path.join(REACT_DOM_RESOLVE, "client"),
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
