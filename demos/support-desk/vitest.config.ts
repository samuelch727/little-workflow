import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before every test FILE's imports — the only hook early enough to satisfy the
    // module-level `supportModel()` in `agents/support/agent.ts`. See the file itself for why
    // the suite would otherwise depend on a developer's `.env.local` and on a local littleDB.
    setupFiles: ["./tests/support/hermetic-env.ts"],
  },
});
