import { chromium, expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// E2E_DIST lets the suite run against another build, e.g. an older release.
const extensionPath = resolve(process.env.E2E_DIST ?? fileURLToPath(new URL("../../../dist", import.meta.url)));
/** Chrome's id for an unpacked extension: SHA-256 of its path, hex digits mapped to a-p. */
const extensionId = [...createHash("sha256").update(extensionPath).digest("hex").slice(0, 32)]
  .map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");

/**
 * Loads the built extension (dist/) into Chromium.
 *
 * `driver` is an extension page (the side panel opened in its own tab), so it has the
 * chrome.tabs API the side panel uses to reach the content script. It stands in for the
 * service worker, which Playwright does not always attach to. `evaluateInExtension` runs a
 * function there with the id of the tab showing `page` (tests use that single page); `send`
 * messages that tab's content script.
 */
export const test = base.extend<{
  context: BrowserContext;
  page: Page;
  driver: Page;
  evaluateInExtension: <R, A = undefined>(fn: (tabId: number, arg: A) => R | Promise<R>, arg?: A) => Promise<R>;
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
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? await context.newPage());
  },
  driver: async ({ context }, use) => {
    const driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await expect.poll(() => driver.evaluate(() => typeof chrome?.tabs?.sendMessage === "function")).toBe(true);
    await use(driver);
  },
  evaluateInExtension: async ({ driver }, use) => {
    await use(async (fn, arg) => {
      // The extension has no permission to read tab URLs; `page` is the only tab besides the driver.
      const tabIds = await driver.evaluate(async () => {
        const own = (await chrome.tabs.getCurrent())?.id;
        return (await chrome.tabs.query({})).flatMap((tab) => tab.id !== undefined && tab.id !== own ? [tab.id] : []);
      });
      if (tabIds.length !== 1) throw new Error(`Expected one page tab besides the driver, found ${tabIds.length}`);
      const [tabId] = tabIds;
      const source = `(${fn.toString()})(${tabId}, ${JSON.stringify(arg ?? null)})`;
      return driver.evaluate(source) as Promise<any>;
    });
  },
  send: async ({ evaluateInExtension }, use) => {
    await use((message) => evaluateInExtension(async (tabId, payload) => {
      // The content script is injected at document_idle, a moment after navigation ends.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await chrome.tabs.sendMessage(tabId, payload);
        } catch (error) {
          if (attempt >= 50 || !String(error).includes("Receiving end does not exist")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }, message));
  },
});

export { expect };
