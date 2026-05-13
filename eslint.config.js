// ESLint flat-config (eslint 9+). Two layers:
//   1. Backend (src/**, vitest tests) — Node module, type-checked rules.
//   2. UI (ui/src/**) — React, hooks rules, same type-checked rules.
// Pick a restrained rule set deliberately. Going strict-everywhere on a
// mature codebase generates a wall of warnings nobody triages; the rules
// below are the ones that would have caught real past bugs (see CLAUDE.md
// decisions #22 / #37 / #41 — all classic floating-promise / async
// races that ESLint's typed rules detect statically).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "ui/dist/**",
      "node_modules/**",
      "ui/node_modules/**",
      "**/*.d.ts",
      "openclaw-version-check.json",
    ],
  },

  // ── Backend (src/**) ────────────────────────────────────────────────
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // Use a dedicated tsconfig that includes test files. The main
        // tsconfig excludes `*.test.ts` (they shouldn't compile to dist),
        // but ESLint's typed rules need to see them.
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    rules: {
      // Floating promises are the #1 source of "silent task died" bugs in
      // this codebase (alerts engine, daily-cost flush, retention timer).
      // CLAUDE.md decision #37 documents the alert engine reentrancy fix
      // that this rule would have caught at PR review time.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Plugin code routinely casts host events into plugin-private shapes
      // (decision #25: `event.type as string` for llm.tokens.recorded).
      // We allow `unknown` and a few well-commented casts but ban bare any.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "off", // too noisy on host event payloads
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",

      // Project convention: best-effort empty catches are documented inline
      // (search "// best-effort" / "// ignore" comments). Allow them.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // tsconfig already catches noUnusedLocals/Parameters; let TS handle it
      // so the error surfaces in editor and CI typecheck consistently.
      "@typescript-eslint/no-unused-vars": "off",

      // Allow `_unused` parameter prefix convention for handler signatures
      // (`_req`, `_ctx`) — tsconfig also accepts this via noUnusedParameters.
      "no-unused-vars": "off",

      // Enforce `import type` for type-only imports. Keeps runtime bundle
      // size down and makes the actual runtime dependencies obvious.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],

      // Project widely uses `?.` and `??` already; require the modern form.
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "off", // would flag every `|| ""` for defaults

      // String concatenation in error messages is common and fine; don't
      // force template literals.
      "prefer-template": "off",

      // Allow `void promise` to explicitly discard a fire-and-forget.
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],

      // tsconfig has `exactOptionalPropertyTypes`; let TS catch missing-vs-undefined
      // distinctions and turn this rule off so we don't double-report.
      "@typescript-eslint/no-non-null-assertion": "warn",

      // OpenClaw plugin SDK contract: HTTP route handlers MUST return
      // `Promise<boolean>` (see `OpenClawPluginHttpRouteHandler`). The
      // synchronous handlers we ship are wrapped with `async` to satisfy
      // the type even though they don't await internally. Disable the
      // rule globally; it would generate noise on every route handler
      // without catching real bugs.
      "@typescript-eslint/require-await": "off",
    },
  },

  // ── UI (ui/src/**) ──────────────────────────────────────────────────
  {
    files: ["ui/src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Same justifications as backend block above
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // SSE / fetch reader explicitly returns undefined from async flows
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/require-await": "off",
    },
  },

  // ── Test files: relax type-checked rules that fight test ergonomics ──
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off", // top-level await in describe blocks
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
