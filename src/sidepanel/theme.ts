import type { ThemePreference } from "../shared/types";

const CACHE_KEY = "pageTranslateTheme";

/** "system" leaves the colors to prefers-color-scheme; light/dark override it. */
export function applyTheme(theme: ThemePreference): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Storage can be unavailable; the stored setting is applied once it loads.
  }
}

export function cachedTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(CACHE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Fall through to the OS preference.
  }
  return "system";
}
