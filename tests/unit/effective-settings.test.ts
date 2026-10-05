import { describe, expect, it } from "vitest";
import { effectiveSettings, normalizeSettings, settingsOnInstall, type AvailableProviders } from "../../src/shared/effective-settings";
import { DEFAULT_SETTINGS, type ContentJudge } from "../../src/shared/types";

const judgeWith = (contentJudge: ContentJudge, keys: Partial<AvailableProviders>) =>
  effectiveSettings({ ...DEFAULT_SETTINGS, contentJudge }, { claudeKey: null, jevKey: null, chromeTranslator: true, ...keys }).contentJudge;

describe("effectiveSettings", () => {
  it("uses Claude when its key is registered", () => {
    expect(judgeWith("claude", { claudeKey: true, jevKey: true })).toBe("claude");
    expect(judgeWith("claude", { claudeKey: true, jevKey: false })).toBe("claude");
  });

  it("falls back to Jev, then to no judge, while Claude's key is missing", () => {
    expect(judgeWith("claude", { claudeKey: false, jevKey: true })).toBe("jev");
    expect(judgeWith("claude", { claudeKey: false, jevKey: false })).toBe("off");
  });

  it("uses Jev only when its key is registered", () => {
    expect(judgeWith("jev", { claudeKey: true, jevKey: true })).toBe("jev");
    expect(judgeWith("jev", { claudeKey: true, jevKey: false })).toBe("off");
    expect(judgeWith("off", { claudeKey: true, jevKey: true })).toBe("off");
  });

  it("keeps the chosen judge while the key check has not answered", () => {
    expect(judgeWith("claude", {})).toBe("claude");
    expect(judgeWith("jev", {})).toBe("jev");
  });

  it("falls back to DeepL where Chrome has no built-in translator", () => {
    const available = { claudeKey: null, jevKey: null };
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, translationProvider: "chrome" }, { ...available, chromeTranslator: false }).translationProvider).toBe("deepl");
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, translationProvider: "chrome" }, { ...available, chromeTranslator: true }).translationProvider).toBe("chrome");
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, translationProvider: "deepl" }, { ...available, chromeTranslator: true }).translationProvider).toBe("deepl");
  });

  it("translates with Chrome by default, so a new install needs no key", () => {
    expect(DEFAULT_SETTINGS.translationProvider).toBe("chrome");
  });
});

describe("normalizeSettings", () => {
  it("carries an old Jev choice over: on becomes Claude (Jev until its key is added), off stays off", () => {
    expect(normalizeSettings({ useJev: true }).contentJudge).toBe("claude");
    expect(normalizeSettings({ useJev: false }).contentJudge).toBe("off");
    expect(normalizeSettings({ useJev: false })).not.toHaveProperty("useJev");
  });

  it("keeps a judge already chosen", () => {
    expect(normalizeSettings({ useJev: true, contentJudge: "jev" }).contentJudge).toBe("jev");
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("settingsOnInstall", () => {
  it("gives a new install the defaults, with Chrome's translator and Claude", () => {
    expect(settingsOnInstall(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.contentJudge).toBe("claude");
  });

  it("keeps DeepL for someone who used the extension before Chrome's translator was the default", () => {
    expect(settingsOnInstall({ targetLanguage: "EN", useJev: true })).toEqual({ targetLanguage: "EN", translationProvider: "deepl", contentJudge: "claude" });
  });

  it("turns an old Jev choice into a judge", () => {
    expect(settingsOnInstall({ translationProvider: "chrome", useJev: false })).toEqual({ translationProvider: "chrome", contentJudge: "off" });
  });

  it("leaves a choice already made alone", () => {
    expect(settingsOnInstall({ translationProvider: "chrome", contentJudge: "jev" })).toBeNull();
    expect(settingsOnInstall({ translationProvider: "deepl", contentJudge: "off" })).toBeNull();
  });
});
