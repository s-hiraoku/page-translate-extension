import { defineConfig } from "@playwright/test";

const port = 4173;

// Run `npm run build` first (npm run test:e2e does): the tests load dist/ as the extension.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/support/server.mjs",
    url: `http://127.0.0.1:${port}/fixtures/article.html`,
    env: { PORT: String(port) },
    reuseExistingServer: !process.env.CI,
  },
});
