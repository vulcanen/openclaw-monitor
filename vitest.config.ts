import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    isolate: false,
    testTimeout: 10_000,
  },
});
