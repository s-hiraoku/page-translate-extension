import { defineConfig } from "vitest/config";

// Unit tests only: they import source modules directly and run in Node, so they
// must not load the crx plugin from vite.config.ts.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
