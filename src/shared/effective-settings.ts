import type { ExtensionSettings } from "./types";

/**
 * The settings as they apply right now. Jev is used only when its key is registered (unknown counts
 * as registered, so nothing changes before the check answers), and Chrome's built-in translator only
 * where this Chrome has one: otherwise DeepL translates.
 */
export function effectiveSettings(
  settings: ExtensionSettings,
  available: { jevKey: boolean | null; chromeTranslator: boolean },
): ExtensionSettings {
  return {
    ...settings,
    useJev: settings.useJev && available.jevKey !== false,
    translationProvider: settings.translationProvider === "chrome" && !available.chromeTranslator ? "deepl" : settings.translationProvider,
  };
}
