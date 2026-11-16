import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/build-once.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
