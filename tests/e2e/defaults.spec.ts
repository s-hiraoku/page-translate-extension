import { expect, test } from "./support/extension";

test("a new install translates with Chrome's built-in translator, so no key is needed", async ({ driver }) => {
  await expect.poll(() => driver.evaluate(async () => {
    const stored = await chrome.storage.local.get("pageTranslateSettings");
    return (stored.pageTranslateSettings as { translationProvider?: string } | undefined)?.translationProvider;
  })).toBe("chrome");
});
