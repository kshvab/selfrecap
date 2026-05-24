import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Surgery tests mutate temp copies on disk; keep them isolated per-file.
    pool: "forks",
  },
});
