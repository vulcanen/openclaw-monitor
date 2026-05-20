// CLI-metadata shim — DO NOT EDIT BY HAND.
//
// Host 2026.5.18 probes `<pluginRoot>/cli-metadata.{ts,js,mjs,cjs}` before
// the main entry to learn what root CLI commands a plugin owns. The probe
// runs against the *package root*, so this file must live next to
// package.json and openclaw.plugin.json — it cannot live inside dist/.
//
// The actual source is `src/cli-metadata.ts`, compiled to
// `dist/cli-metadata.js`. This shim is a static ESM re-export so we don't
// need an extra build step to keep root + dist in sync.
//
// Why it exists at all: see rules/host-contract.md decision #58.
export { default } from "./dist/cli-metadata.js";
