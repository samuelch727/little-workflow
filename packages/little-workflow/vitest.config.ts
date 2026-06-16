import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/dist/**", "**/node_modules/**"],
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 4,
  },
});
