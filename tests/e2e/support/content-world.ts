import type { Page } from "@playwright/test";

export type MockTranslator = "available" | "downloadable-needs-click" | "unavailable" | "none";

/**
 * Replaces Chrome's Translator API inside the extension's content-script world (its isolated world),
 * where the page cannot reach. Playwright's Chromium has the API but no model, so its availability()
 * never settles; tests decide what the translator does. "[Chrome <lang>] <text>" is the translation.
 */
export async function mockTranslatorInContentScript(page: Page, mode: MockTranslator): Promise<void> {
  await evaluateInContentScript(page, `(() => {
    const mode = ${JSON.stringify(mode)};
    if (mode === "none") { globalThis.Translator = undefined; return; }
    globalThis.__translateCalls = 0;
    globalThis.Translator = {
      availability: async () => (mode === "unavailable" ? "unavailable" : mode === "available" ? "available" : "downloadable"),
      create: async (options) => {
        if (mode === "downloadable-needs-click") throw new DOMException("needs a click", "NotAllowedError");
        return { translate: async (text) => { globalThis.__translateCalls += 1; return "[Chrome " + options.targetLanguage + "] " + text; } };
      },
    };
  })()`);
}

/** How many texts the mocked translator was asked to translate. */
export async function contentTranslateCalls(page: Page): Promise<number> {
  return Number(await evaluateInContentScript(page, "globalThis.__translateCalls ?? 0"));
}

/** Evaluates an expression in the extension's content-script world on this page. */
export async function evaluateInContentScript(page: Page, expression: string): Promise<unknown> {
  const cdp = await page.context().newCDPSession(page);
  const contexts: Array<{ id: number; name: string; auxData?: { type?: string; isDefault?: boolean } }> = [];
  cdp.on("Runtime.executionContextCreated", (event: { context: (typeof contexts)[number] }) => contexts.push(event.context));
  // Enabling replays the contexts that already exist.
  await cdp.send("Runtime.enable");
  const isolated = contexts.find((context) => context.auxData?.type === "isolated" && context.name === "Page Translate");
  if (!isolated) throw new Error("The content script's world was not found; is the extension loaded on this page?");
  const result = await cdp.send("Runtime.evaluate", { expression, contextId: isolated.id, returnByValue: true }) as { result: { value?: unknown } };
  await cdp.detach();
  return result.result.value;
}
