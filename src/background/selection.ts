import { SELECTION_MAX_CHARS, type ComposeLanguage, type ExtensionSettings } from "../shared/types";
import { isInTargetLanguage } from "../sidepanel/rules";

/** What a selection turns into: the translation, a plain notice, or an error to show in the tooltip. */
export type SelectionOutcome = { text: string } | { note: string } | { error: string };

export interface SelectionDeps {
  settings(): Promise<ExtensionSettings>;
  hasConsent(): Promise<boolean>;
  translate(text: string, targetLang: ComposeLanguage): Promise<{ text: string }>;
}

/** Chrome's built-in translator cannot run in the service worker, which translates here. */
export const CHROME_PANEL_ONLY_NOTE = "Chrome内蔵の翻訳（試験的）は、いまはサイドパネルを開いているときだけ使えます。パネルの「選択範囲翻訳」ボタンを使ってください。";
export const CONSENT_NOTE = "初めて使うときは、拡張機能のアイコンからパネルを開き、データ送信への同意をしてください。";
const CACHE_LIMIT = 50;

/**
 * Translates a selected passage without the side panel: checks consent, skips text already in the
 * target language, reuses what it translated a moment ago, and turns failures into a message.
 */
export function createSelectionTranslator(deps: SelectionDeps) {
  // Newest last; a Map iterates in insertion order, so the oldest goes first.
  const cache = new Map<string, string>();

  return async function translateSelection(text: string): Promise<SelectionOutcome> {
    try {
      if (text.length > SELECTION_MAX_CHARS) return { note: `一度に翻訳できるのは${SELECTION_MAX_CHARS.toLocaleString("ja-JP")}文字までです。` };
      const settings = await deps.settings();
      if (settings.translationProvider === "chrome") return { note: CHROME_PANEL_ONLY_NOTE };
      if (!(await deps.hasConsent())) return { note: CONSENT_NOTE };
      if (isInTargetLanguage(text, settings.targetLanguage)) {
        return { note: `選択した文章は、すでに${settings.targetLanguage === "JA" ? "日本語" : "英語"}です。` };
      }
      const targetLang: ComposeLanguage = settings.targetLanguage === "JA" ? "JA" : settings.englishVariant;
      const key = `${targetLang}\n${text}`;
      const known = cache.get(key);
      if (known !== undefined) return { text: known };
      const result = await deps.translate(text, targetLang);
      cache.set(key, result.text);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      return { text: result.text };
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : "翻訳できませんでした。" };
    }
  };
}
