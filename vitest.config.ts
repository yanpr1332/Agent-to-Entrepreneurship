import { defineConfig } from "vitest/config";

/**
 * Keep native SQLite migration tests reliable on Windows CI.
 * The default worker count can start one process per test file; concurrent
 * SQLite backups and filesystem cleanup can starve migration tests.
 */
export default defineConfig({
  test: {
    maxWorkers: process.env.CI ? 4 : undefined,
  },
});
