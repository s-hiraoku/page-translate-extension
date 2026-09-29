// Query parameters that only say where a visitor came from; they never change the article.
const TRACKING = /^(utm_.+|fbclid|gclid|dclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|ref_url|cmpid|s_cid|spm)$/i;

/**
 * The address a page is remembered under: without the fragment or tracking parameters, so
 * `/post?utm_source=x#comments` and `/post` are the same page. Other parameters are kept,
 * sorted, since many sites choose the article with them.
 */
export function normalizePageUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hash = "";
  const kept = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING.test(name));
  kept.sort(([a], [b]) => a.localeCompare(b));
  parsed.search = "";
  for (const [name, value] of kept) parsed.searchParams.append(name, value);
  return parsed.toString();
}
