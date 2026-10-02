import { describe, expect, it } from "vitest";
import {
  CACHE_MAX_PAGES,
  buildPage,
  describeCache,
  emptyCache,
  findPage,
  formatAge,
  hashText,
  isUnchanged,
  normalizePageUrl,
  pageCacheKey,
  prune,
  readCache,
  type CacheStore,
  type CachedPage,
} from "../../src/sidepanel/cache";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function page(overrides: Partial<CachedPage> = {}): CachedPage {
  return { savedAt: NOW, usedAt: NOW, hashes: ["a", "b"], decisions: { a: { d: "translate", c: 0.9 }, b: { d: "skip", c: 0.9 } }, translations: { a: { t: "あ" } }, ...overrides };
}

describe("normalizePageUrl", () => {
  it("ignores the fragment", () => {
    expect(normalizePageUrl("https://example.com/post#comments")).toBe("https://example.com/post");
  });

  it("drops tracking parameters and keeps the ones that choose the article", () => {
    expect(normalizePageUrl("https://example.com/read?id=42&utm_source=x&fbclid=abc&ref=home")).toBe("https://example.com/read?id=42");
  });

  it("treats the same parameters in another order as the same page", () => {
    expect(normalizePageUrl("https://example.com/?b=2&a=1")).toBe(normalizePageUrl("https://example.com/?a=1&b=2"));
  });

  it("keeps different articles apart", () => {
    expect(normalizePageUrl("https://example.com/read?id=1")).not.toBe(normalizePageUrl("https://example.com/read?id=2"));
  });

  it("returns something usable for input that is not a URL", () => {
    expect(normalizePageUrl("not a url")).toBe("not a url");
  });
});

describe("pageCacheKey", () => {
  it("keeps DeepL's key as before and gives Chrome's translator its own", () => {
    const deepl = pageCacheKey("https://example.com/a", "JA", true);
    expect(pageCacheKey("https://example.com/a", "JA", true, "deepl")).toBe(deepl);
    expect(pageCacheKey("https://example.com/a", "JA", true, "chrome")).not.toBe(deepl);
  });

  it("separates target language and the Jev setting", () => {
    const base = pageCacheKey("https://example.com/a", "JA", true);
    expect(pageCacheKey("https://example.com/a", "EN", true)).not.toBe(base);
    expect(pageCacheKey("https://example.com/a", "JA", false)).not.toBe(base);
    expect(pageCacheKey("https://example.com/a#x?utm_medium=y", "JA", true)).toBe(base);
  });
});

describe("hashText", () => {
  it("is stable and distinguishes texts", async () => {
    expect(await hashText("Hello")).toBe(await hashText("Hello"));
    expect(await hashText("Hello")).not.toBe(await hashText("Hello."));
    expect(await hashText("Hello")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("findPage", () => {
  const store: CacheStore = { version: 1, pages: { k: page() } };

  it("finds a page within the lifetime", () => {
    expect(findPage(store, "k", 3, NOW + 2 * HOUR)).not.toBeNull();
  });

  it("does not return an expired page", () => {
    expect(findPage(store, "k", 3, NOW + 3 * HOUR)).toBeNull();
    expect(findPage(store, "k", 1, NOW + 2 * HOUR)).toBeNull();
  });

  it("does not return a page saved in the future (clock changed)", () => {
    expect(findPage(store, "k", 3, NOW - 2 * HOUR)).toBeNull();
  });

  it("returns null for an unknown page", () => {
    expect(findPage(store, "other", 3, NOW)).toBeNull();
  });
});

describe("isUnchanged", () => {
  it("is true only for the same texts in the same order", () => {
    expect(isUnchanged(page(), ["a", "b"])).toBe(true);
    expect(isUnchanged(page(), ["b", "a"])).toBe(false);
    expect(isUnchanged(page(), ["a", "b", "c"])).toBe(false);
    expect(isUnchanged(page(), ["a"])).toBe(false);
    expect(isUnchanged(page(), ["a", "x"])).toBe(false);
  });
});

describe("buildPage", () => {
  it("keeps only what is still on the page", () => {
    const built = buildPage(["a", "c"], { a: { d: "translate", c: 1 }, b: { d: "skip", c: 1 }, c: { d: "translate", c: 1 } }, { a: { t: "あ" }, b: { t: "い" }, c: { t: "う" } }, NOW);
    expect(Object.keys(built.decisions).sort()).toEqual(["a", "c"]);
    expect(Object.keys(built.translations).sort()).toEqual(["a", "c"]);
    expect(built).toMatchObject({ savedAt: NOW, usedAt: NOW, hashes: ["a", "c"] });
  });
});

describe("prune", () => {
  it("drops expired pages", () => {
    const store: CacheStore = { version: 1, pages: { old: page({ savedAt: NOW - 4 * HOUR }), fresh: page() } };
    expect(Object.keys(prune(store, 3, NOW).pages)).toEqual(["fresh"]);
  });

  it("keeps the most recently used pages when there are too many", () => {
    const pages: Record<string, CachedPage> = {};
    for (let i = 0; i < CACHE_MAX_PAGES + 5; i += 1) pages[`p${i}`] = page({ usedAt: NOW + i });
    const kept = Object.keys(prune({ version: 1, pages }, 3, NOW + 1000).pages);
    expect(kept).toHaveLength(CACHE_MAX_PAGES);
    expect(kept).toContain(`p${CACHE_MAX_PAGES + 4}`);
    expect(kept).not.toContain("p0");
  });

  it("drops the least recently used pages when the text is too large", () => {
    const big = "あ".repeat(1_200_000);
    const store: CacheStore = { version: 1, pages: {
      a: page({ usedAt: NOW, translations: { a: { t: big } } }),
      b: page({ usedAt: NOW + 1, translations: { a: { t: big } } }),
      c: page({ usedAt: NOW + 2, translations: { a: { t: big } } }),
    } };
    expect(Object.keys(prune(store, 3, NOW + 5).pages).sort()).toEqual(["b", "c"]);
  });
});

describe("readCache", () => {
  it("starts empty for missing or unknown data", () => {
    expect(readCache(undefined)).toEqual(emptyCache());
    expect(readCache({ version: 2, pages: {} })).toEqual(emptyCache());
    expect(readCache("nope")).toEqual(emptyCache());
    expect(readCache({ version: 1, pages: null })).toEqual(emptyCache());
  });

  it("returns a stored cache", () => {
    const store: CacheStore = { version: 1, pages: { k: page() } };
    expect(readCache(store)).toEqual(store);
  });
});

describe("describeCache", () => {
  it("counts pages and their approximate size", () => {
    expect(describeCache(emptyCache())).toEqual({ pages: 0, chars: 0 });
    const described = describeCache({ version: 1, pages: { k: page() } });
    expect(described.pages).toBe(1);
    expect(described.chars).toBeGreaterThan(0);
  });
});

describe("formatAge", () => {
  it.each([
    [10_000, "たった今"],
    [5 * 60_000, "5分前"],
    [59 * 60_000, "59分前"],
    [60 * 60_000, "1時間前"],
    [95 * 60_000, "1時間35分前"],
    [7 * HOUR + 20 * 60_000, "7時間前"],
    [-5000, "たった今"],
  ])("%i ms -> %s", (ms, label) => {
    expect(formatAge(ms)).toBe(label);
  });
});
