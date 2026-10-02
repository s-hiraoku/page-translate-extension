import { describe, expect, it } from "vitest";
import { effectiveSettings, settingsOnInstall } from "../../src/shared/effective-settings";
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

describe("settingsOnInstall", () => {
  it("gives a new install the defaults, with Chrome's translator", () => {
    expect(settingsOnInstall(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps DeepL for someone who used the extension before Chrome's translator was the default", () => {
    expect(settingsOnInstall({ targetLanguage: "EN", useJev: true })).toEqual({ targetLanguage: "EN", useJev: true, translationProvider: "deepl" });
  });

  it("leaves a choice already made alone", () => {
    expect(settingsOnInstall({ translationProvider: "chrome" })).toBeNull();
    expect(settingsOnInstall({ translationProvider: "deepl" })).toBeNull();
  });
});
