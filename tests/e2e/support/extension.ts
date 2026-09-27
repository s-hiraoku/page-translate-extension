import { chromium, test as base, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";

// E2E_DIST lets the suite run against another build, e.g. an older release.
const extensionPath = process.env.E2E_DIST ?? fileURLToPath(new URL("../../../dist", import.meta.url));

/**
 * Loads the built extension (dist/) into Chromium. `send` delivers a message to the
 * content script of the active tab from the service worker, the same way the side panel does.
 */
export const test = base.extend<{
  context: BrowserContext;
  worker: Worker;
  page: Page;
  send: <T = any>(message: unknown) => Promise<T>;
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await use(worker);
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? await context.newPage());
  },
  send: async ({ worker }, use) => {
    await use((message) => worker.evaluate(async (payload) => {
      const [tab] = await chrome.tabs.query({ active: true });
      // The content script is injected at document_idle, a moment after navigation ends.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await chrome.tabs.sendMessage(tab.id!, payload);
        } catch (error) {
          if (attempt >= 50 || !String(error).includes("Receiving end does not exist")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }, message));
  },
});

export { expect } from "@playwright/test";
