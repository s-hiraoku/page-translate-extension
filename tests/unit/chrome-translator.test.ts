import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROME_TRANSLATOR_NEEDS_CLICK,
  CHROME_TRANSLATOR_UNSUPPORTED,
  chromeTranslatorSupported,
  languagePair,
  progressPercent,
  resetChromeTranslators,
  setDownloadProgressListener,
  textToHtml,
  translateWithChrome,
} from "../../src/shared/chrome-translator";

const global = globalThis as { Translator?: unknown };

function installTranslator(availability: string, create?: (options: { monitor?: (m: EventTarget) => void; sourceLanguage: string; targetLanguage: string }) => Promise<unknown>) {
  const factory = {
    availability: vi.fn(async () => availability),
    create: vi.fn(create ?? (async (options) => ({ translate: async (text: string) => `${options.targetLanguage}:${text}` }))),
  };
  global.Translator = factory;
  return factory;
}

afterEach(() => {
  delete global.Translator;
  resetChromeTranslators();
  setDownloadProgressListener(null);
});

describe("chrome translator", () => {
  it("is supported only where Chrome provides the API", () => {
    expect(chromeTranslatorSupported()).toBe(false);
    installTranslator("available");
    expect(chromeTranslatorSupported()).toBe(true);
  });

  it("translates English to Japanese and back", () => {
    expect(languagePair("JA")).toEqual({ sourceLanguage: "en", targetLanguage: "ja" });
    expect(languagePair("EN")).toEqual({ sourceLanguage: "ja", targetLanguage: "en" });
  });

  it("translates each text and creates the translator once", async () => {
    const factory = installTranslator("available");
    expect(await translateWithChrome(["a", "b"], "JA")).toEqual(["ja:a", "ja:b"]);
    expect(await translateWithChrome(["c"], "JA")).toEqual(["ja:c"]);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it("says so when Chrome has no translator", async () => {
    await expect(translateWithChrome(["a"], "JA")).rejects.toThrow(CHROME_TRANSLATOR_UNSUPPORTED);
  });

  it("says so when the language pair is unavailable", async () => {
    installTranslator("unavailable");
    await expect(translateWithChrome(["a"], "JA")).rejects.toThrow("英語と日本語の翻訳モデル");
  });

  it("asks for a click when the model needs downloading and there was none, and tries again next time", async () => {
    const factory = installTranslator("downloadable", async () => { throw new DOMException("no activation", "NotAllowedError"); });
    await expect(translateWithChrome(["a"], "JA")).rejects.toThrow(CHROME_TRANSLATOR_NEEDS_CLICK);
    factory.create.mockImplementation(async () => ({ translate: async (text: string) => `ok:${text}` }));
    expect(await translateWithChrome(["a"], "JA")).toEqual(["ok:a"]);
  });

  it("reports the model download in percent", async () => {
    const seen: number[] = [];
    setDownloadProgressListener((percent) => seen.push(percent));
    installTranslator("downloadable", async (options) => {
      const monitor = new EventTarget();
      options.monitor?.(monitor);
      for (const loaded of [0, 0.42, 1]) monitor.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded, total: 1 }));
      return { translate: async (text: string) => text };
    });
    await translateWithChrome(["a"], "JA");
    expect(seen).toEqual([0, 42, 100]);
  });

  it("gives up, instead of hanging, when Chrome never answers whether the model is there", async () => {
    vi.useFakeTimers();
    global.Translator = { availability: () => new Promise(() => undefined), create: vi.fn() };
    const pending = translateWithChrome(["a"], "JA");
    const assertion = expect(pending).rejects.toThrow("準備ができませんでした");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  it("turns plain text into safe HTML", () => {
    expect(textToHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(progressPercent(2, 4)).toBe(50);
  });
});
