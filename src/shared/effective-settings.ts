import { DEFAULT_SETTINGS, type ExtensionSettings } from "./types";

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

/**
 * What to store when the extension is installed or updated, or null to leave the settings alone. A new
 * install gets the defaults (Chrome's built-in translator). Someone who used the extension before that
 * default existed keeps DeepL, so their translations do not change under them.
 */
export function settingsOnInstall(stored: Partial<ExtensionSettings> | undefined): ExtensionSettings | Partial<ExtensionSettings> | null {
  if (!stored) return DEFAULT_SETTINGS;
  if (stored.translationProvider === undefined) return { ...stored, translationProvider: "deepl" };
  return null;
}
