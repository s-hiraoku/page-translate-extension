import { describe, expect, it } from "vitest";
import { effectiveSettings } from "../../src/shared/effective-settings";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("effectiveSettings", () => {
  it("uses Jev only when its key is registered", () => {
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, useJev: true }, { jevKey: true, chromeTranslator: true }).useJev).toBe(true);
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, useJev: true }, { jevKey: false, chromeTranslator: true }).useJev).toBe(false);
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, useJev: false }, { jevKey: true, chromeTranslator: true }).useJev).toBe(false);
  });

  it("keeps the Jev setting while the key check has not answered", () => {
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, useJev: true }, { jevKey: null, chromeTranslator: true }).useJev).toBe(true);
  });

  it("falls back to DeepL where Chrome has no built-in translator", () => {
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, translationProvider: "chrome" }, { jevKey: null, chromeTranslator: false }).translationProvider).toBe("deepl");
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, translationProvider: "chrome" }, { jevKey: null, chromeTranslator: true }).translationProvider).toBe("chrome");
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, translationProvider: "deepl" }, { jevKey: null, chromeTranslator: true }).translationProvider).toBe("deepl");
  });

  it("translates with Chrome by default, so a new install needs no key", () => {
    expect(DEFAULT_SETTINGS.translationProvider).toBe("chrome");
  });
});
