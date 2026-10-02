import type { TargetLanguage } from "../shared/types";

/**
 * Chrome's built-in Translator API (desktop Chrome 138 and later). The model runs on this device:
 * nothing is sent anywhere and no API key is needed. It is not available in service workers, so the
 * side panel and the page (content script) call it. The first use downloads a language model, which Chrome only starts right after
 * the reader clicked something (transient user activation); later uses need no click.
 */
export type TranslatorAvailability = "unavailable" | "downloadable" | "downloading" | "available";

interface TranslatorInstance {
  translate(text: string): Promise<string>;
}

interface TranslatorFactory {
  availability(options: LanguagePair): Promise<TranslatorAvailability>;
  create(options: LanguagePair & { monitor?: (monitor: EventTarget) => void }): Promise<TranslatorInstance>;
}

interface LanguagePair {
  sourceLanguage: string;
  targetLanguage: string;
}

export const CHROME_TRANSLATOR_UNSUPPORTED = "このChromeでは内蔵の翻訳を使えません。パソコン版のChrome 138以降が必要です。";
export const CHROME_TRANSLATOR_NEEDS_CLICK = "Chrome内蔵の翻訳を初めて使うときは、翻訳モデルのダウンロードが必要です。パネルの「このページを翻訳」を押すか、ページの文章を選び直して始めてください。";
export const CHROME_TRANSLATOR_BLOCKED = "このページでは、Chrome内蔵の翻訳を使えません。";
const PAIR_UNAVAILABLE = "このChromeでは、英語と日本語の翻訳モデルを使えません。設定で翻訳サービスをDeepLに切り替えてください。";

function factory(): TranslatorFactory | null {
  return (globalThis as { Translator?: TranslatorFactory }).Translator ?? null;
}

export function chromeTranslatorSupported(): boolean {
  return factory() !== null;
}

/** The extension translates between English and Japanese: the target decides the source. */
export function languagePair(target: TargetLanguage): LanguagePair {
  return target === "JA" ? { sourceLanguage: "en", targetLanguage: "ja" } : { sourceLanguage: "ja", targetLanguage: "en" };
}

/** Plain text as HTML for the in-page display (Chrome's translator returns text, without markup). */
export function textToHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Download progress as a whole percentage; the event reports a fraction (0–1) of `total`. */
export function progressPercent(loaded: number, total = 1): number {
  return Math.max(0, Math.min(100, Math.round((loaded / (total || 1)) * 100)));
}

const AVAILABILITY_TIMEOUT_MS = 10_000;
const NOT_READY = "Chrome内蔵の翻訳の準備ができませんでした。しばらくしてからもう一度お試しいただくか、設定で翻訳サービスをDeepLに切り替えてください。";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(NOT_READY)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

const translators = new Map<string, Promise<TranslatorInstance>>();
let onDownloadProgress: ((percent: number) => void) | null = null;

/** Reports the model download (first use only) to whoever asked last. */
export function setDownloadProgressListener(listener: ((percent: number) => void) | null): void {
  onDownloadProgress = listener;
}

/**
 * The translator for this direction, created once per panel. Call it straight from a click handler
 * the first time, so Chrome may download the model.
 */
export function getChromeTranslator(target: TargetLanguage): Promise<TranslatorInstance> {
  const pair = languagePair(target);
  const key = `${pair.sourceLanguage}>${pair.targetLanguage}`;
  const known = translators.get(key);
  if (known) return known;
  const created = (async () => {
    const api = factory();
    if (!api) throw new Error(CHROME_TRANSLATOR_UNSUPPORTED);
    // A Chrome without the model service can leave this pending forever; do not hang the panel.
    let availability: TranslatorAvailability;
    try {
      availability = await withTimeout(api.availability(pair), AVAILABILITY_TIMEOUT_MS);
    } catch (caught) {
      // A page whose Permissions-Policy turns the translator off (or a cross-origin frame).
      if (caught instanceof DOMException && caught.name === "NotAllowedError") throw new Error(CHROME_TRANSLATOR_BLOCKED);
      throw caught;
    }
    if (availability === "unavailable") throw new Error(PAIR_UNAVAILABLE);
    try {
      return await api.create({
        ...pair,
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            const { loaded, total } = event as ProgressEvent;
            onDownloadProgress?.(progressPercent(loaded, total));
          });
        },
      });
    } catch (caught) {
      // Downloading needs a recent click; a shortcut or a page selection does not count.
      if (caught instanceof DOMException && caught.name === "NotAllowedError") throw new Error(CHROME_TRANSLATOR_NEEDS_CLICK);
      throw caught;
    }
  })();
  translators.set(key, created);
  created.catch(() => translators.delete(key));
  return created;
}

/** Translates each text in turn with Chrome's built-in translator. */
export async function translateWithChrome(texts: string[], target: TargetLanguage): Promise<string[]> {
  const translator = await getChromeTranslator(target);
  const results: string[] = [];
  for (const text of texts) results.push(await translator.translate(text));
  return results;
}

/** For tests: forget the translators made so far. */
export function resetChromeTranslators(): void {
  translators.clear();
}
