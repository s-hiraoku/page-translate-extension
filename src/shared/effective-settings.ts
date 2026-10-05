import { DEFAULT_SETTINGS, type ContentJudge, type ExtensionSettings } from "./types";

/** Which API keys are registered; null while the check has not answered (counted as registered). */
export interface AvailableProviders {
  claudeKey: boolean | null;
  jevKey: boolean | null;
  chromeTranslator: boolean;
}

/**
 * The settings as they apply right now. Claude judges only with its key: without it Jev does, and
 * without Jev's key nobody does (unknown counts as registered, so nothing changes before the check
 * answers). Chrome's built-in translator only where this Chrome has one: otherwise DeepL translates.
 */
export function effectiveSettings(settings: ExtensionSettings, available: AvailableProviders): ExtensionSettings {
  return {
    ...settings,
    contentJudge: effectiveJudge(settings.contentJudge, available),
    translationProvider: settings.translationProvider === "chrome" && !available.chromeTranslator ? "deepl" : settings.translationProvider,
  };
}

function effectiveJudge(judge: ContentJudge, available: AvailableProviders): ContentJudge {
  if (judge === "claude" && available.claudeKey !== false) return "claude";
  if (judge !== "off" && available.jevKey !== false) return "jev";
  return "off";
}

/** Stored settings, which may still carry `useJev` from before the judge could be Claude. */
export type StoredSettings = Partial<ExtensionSettings> & { useJev?: unknown };

/**
 * The stored settings over the defaults. An old `useJev: false` stays "no judge"; `useJev: true`
 * becomes Claude, which keeps using Jev until a Claude key is registered.
 */
export function normalizeSettings(stored: StoredSettings | undefined): ExtensionSettings {
  const { useJev, ...rest } = stored ?? {};
  const contentJudge: ContentJudge = rest.contentJudge === "claude" || rest.contentJudge === "jev" || rest.contentJudge === "off"
    ? rest.contentJudge
    : useJev === false ? "off" : DEFAULT_SETTINGS.contentJudge;
  return { ...DEFAULT_SETTINGS, ...rest, contentJudge };
}

/**
 * What to store when the extension is installed or updated, or null to leave the settings alone. A new
 * install gets the defaults (Chrome's built-in translator). Someone who used the extension before that
 * default existed keeps DeepL, so their translations do not change under them. An old `useJev` becomes
 * `contentJudge`.
 */
export function settingsOnInstall(stored: StoredSettings | undefined): ExtensionSettings | StoredSettings | null {
  if (!stored) return DEFAULT_SETTINGS;
  let next: StoredSettings | null = null;
  if (stored.translationProvider === undefined) next = { ...stored, translationProvider: "deepl" };
  if (stored.contentJudge === undefined) {
    const { useJev: _useJev, ...rest } = next ?? stored;
    next = { ...rest, contentJudge: normalizeSettings(stored).contentJudge };
  }
  return next;
}
