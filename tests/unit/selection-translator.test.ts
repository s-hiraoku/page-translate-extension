import { describe, expect, it, vi } from "vitest";
import { CONSENT_NOTE, createSelectionTranslator } from "../../src/background/selection";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../../src/shared/types";

function setup(overrides: Partial<ExtensionSettings> = {}, consent = true) {
  const translate = vi.fn(async (text: string, targetLang: string) => ({ text: `${targetLang}:${text}` }));
  const run = createSelectionTranslator({
    settings: async () => ({ ...DEFAULT_SETTINGS, ...overrides }),
    hasConsent: async () => consent,
    translate,
  });
  return { run, translate };
}

describe("selection translator (side panel closed)", () => {
  it("translates into Japanese by default", async () => {
    const { run, translate } = setup();
    expect(await run("The tide rises twice a day.")).toEqual({ text: "JA:The tide rises twice a day." });
    expect(translate).toHaveBeenCalledWith("The tide rises twice a day.", "JA");
  });

  it("uses the chosen English variant when translating into English", async () => {
    const { run, translate } = setup({ targetLanguage: "EN", englishVariant: "EN-GB" });
    await run("潮は一日に二回満ち引きします。");
    expect(translate).toHaveBeenCalledWith("潮は一日に二回満ち引きします。", "EN-GB");
  });

  it("asks for consent instead of sending anything before it is given", async () => {
    const { run, translate } = setup({}, false);
    expect(await run("The tide rises twice a day.")).toEqual({ note: CONSENT_NOTE });
    expect(translate).not.toHaveBeenCalled();
  });

  it("says so, without calling DeepL, when the text is already in the target language", async () => {
    const { run, translate } = setup();
    expect(await run("これはすでに日本語で書かれた文章です。")).toEqual({ note: "選択した文章は、すでに日本語です。" });
    expect(translate).not.toHaveBeenCalled();
  });

  it("does not translate more than the limit", async () => {
    const { run, translate } = setup();
    const outcome = await run("a".repeat(5001));
    expect(outcome).toMatchObject({ note: expect.stringContaining("5,000") });
    expect(translate).not.toHaveBeenCalled();
  });

  it("reuses a translation it made a moment ago", async () => {
    const { run, translate } = setup();
    await run("The tide rises twice a day.");
    await run("The tide rises twice a day.");
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a translation for another target language", async () => {
    let target: ExtensionSettings["targetLanguage"] = "JA";
    const translate = vi.fn(async (text: string) => ({ text }));
    const run = createSelectionTranslator({ settings: async () => ({ ...DEFAULT_SETTINGS, targetLanguage: target }), hasConsent: async () => true, translate });
    await run("Hello there, world");
    target = "EN";
    await run("Hello there, world");
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it("turns a failure into a message for the tooltip", async () => {
    const run = createSelectionTranslator({
      settings: async () => DEFAULT_SETTINGS,
      hasConsent: async () => true,
      translate: async () => { throw new Error("DeepL APIキーが未設定です。"); },
    });
    expect(await run("The tide rises twice a day.")).toEqual({ error: "DeepL APIキーが未設定です。" });
  });

  it("translates with DeepL when the page could not use Chrome's translator", async () => {
    const { run, translate } = setup({ translationProvider: "chrome" });
    expect(await run("The tide rises twice a day.")).toEqual({ text: "JA:The tide rises twice a day." });
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
