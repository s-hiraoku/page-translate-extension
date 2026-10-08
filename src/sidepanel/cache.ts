import type { Decision, TargetLanguage, TranslationProvider } from "../shared/types";

/**
 * Translation cache. A page's translation is kept on this device for a few hours so that
 * opening the same page again needs no Jev or DeepL request. It lives in extension storage
 * only and is never sent anywhere.
 *
 * Everything here is free of extension APIs so it can be unit-tested; the side panel reads
 * and writes the store with chrome.storage.local.
 */

export const CACHE_KEY = "pageTranslateCache";
/** Choices offered in Settings; the first is the default. */
export const CACHE_TTL_HOURS = [3, 1, 24] as const;
export type CacheTtlHours = (typeof CACHE_TTL_HOURS)[number];

/** chrome.storage.local holds about 10 MB in all; the cache stays well below that. */
export const CACHE_MAX_PAGES = 30;
export const CACHE_MAX_CHARS = 3_000_000;

export interface CachedTranslation {
  /** Translated text. */
  t: string;
  /** Translated HTML; omitted when it equals the text. */
  h?: string;
}

/** What is remembered about one page, in one target language and Jev setting. */
export interface CachedPage {
  /** When the decisions were made; the entry expires this long after. */
  savedAt: number;
  /** Last time it was used, for dropping the least recently used pages. */
  usedAt: number;
  /** Text hashes of the candidates, in page order: equal lists mean the page has not changed. */
  hashes: string[];
  /** Jev's (or the local) verdict per text hash. */
  decisions: Record<string, { d: Decision; c: number }>;
  translations: Record<string, CachedTranslation>;
}

export interface CacheStore {
  version: 1;
  pages: Record<string, CachedPage>;
}

export function emptyCache(): CacheStore {
  return { version: 1, pages: {} };
}

/** Accepts whatever storage returned; anything unrecognized starts an empty cache. */
export function readCache(value: unknown): CacheStore {
  const store = value as Partial<CacheStore> | undefined;
  if (!store || store.version !== 1 || typeof store.pages !== "object" || store.pages === null) return emptyCache();
  return { version: 1, pages: { ...store.pages } };
}

export { normalizePageUrl } from "../shared/page-url";
import { normalizePageUrl } from "../shared/page-url";

/** Results depend on the language and on whether Jev chose the text, so each combination has its own entry. */
export function pageCacheKey(url: string, target: TargetLanguage, useJev: boolean, provider: TranslationProvider = "deepl"): string {
  // DeepL keeps the key it had before other translators existed, so its cache stays valid.
  return `${normalizePageUrl(url)}|${target}|${useJev ? "jev" : "nojev"}${provider === "deepl" ? "" : `|${provider}`}`;
}

/** The store without one translator's pages (Claude's, after the glossary changed). */
export function withoutProvider(store: CacheStore, provider: TranslationProvider): CacheStore {
  const suffix = `|${provider}`;
  return { version: 1, pages: Object.fromEntries(Object.entries(store.pages).filter(([key]) => !key.endsWith(suffix))) };
}

/** Short stable hash of a text (SHA-256, first 16 hex digits). */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isFresh(page: CachedPage, ttlHours: number, now: number): boolean {
  return now - page.savedAt < ttlHours * 3_600_000 && now >= page.savedAt - 60_000;
}

/** The page's entry if it exists and has not expired. */
export function findPage(store: CacheStore, key: string, ttlHours: number, now: number): CachedPage | null {
  const page = store.pages[key];
  return page && isFresh(page, ttlHours, now) ? page : null;
}

/** True when the page still has exactly the candidates it had when it was saved. */
export function isUnchanged(page: CachedPage, hashes: string[]): boolean {
  return page.hashes.length === hashes.length && page.hashes.every((hash, index) => hash === hashes[index]);
}

/**
 * The entry for a page after a translation run. Translations of texts still on the page are
 * carried over, so an update that changed one paragraph keeps the others.
 */
export function buildPage(
  hashes: string[],
  decisions: CachedPage["decisions"],
  translations: CachedPage["translations"],
  now: number,
): CachedPage {
  const onPage = new Set(hashes);
  return {
    savedAt: now,
    usedAt: now,
    hashes,
    decisions: Object.fromEntries(Object.entries(decisions).filter(([hash]) => onPage.has(hash))),
    translations: Object.fromEntries(Object.entries(translations).filter(([hash]) => onPage.has(hash))),
  };
}

function size(page: CachedPage): number {
  let total = page.hashes.length * 18;
  for (const { t, h } of Object.values(page.translations)) total += t.length + (h?.length ?? 0) + 24;
  return total + Object.keys(page.decisions).length * 40;
}

/** Drops expired entries, then the least recently used ones until the limits hold. */
export function prune(store: CacheStore, ttlHours: number, now: number): CacheStore {
  const pages = Object.entries(store.pages).filter(([, page]) => isFresh(page, ttlHours, now));
  pages.sort(([, a], [, b]) => b.usedAt - a.usedAt);
  const kept: Array<[string, CachedPage]> = [];
  let chars = 0;
  for (const entry of pages) {
    const next = chars + size(entry[1]);
    if (kept.length >= CACHE_MAX_PAGES || next > CACHE_MAX_CHARS) continue;
    kept.push(entry);
    chars = next;
  }
  return { version: 1, pages: Object.fromEntries(kept) };
}

/** Number of pages and an approximate size in characters, for Settings. */
export function describeCache(store: CacheStore): { pages: number; chars: number } {
  const pages = Object.values(store.pages);
  return { pages: pages.length, chars: pages.reduce((sum, page) => sum + size(page), 0) };
}

/** "たった今", "5分前", "2時間前": how long ago something was saved. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 || hours >= 6 ? `${hours}時間前` : `${hours}時間${rest}分前`;
}
