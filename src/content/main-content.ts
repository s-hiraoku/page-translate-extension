import type { SegmentKind, SegmentRegion } from "../shared/types";

/**
 * Lightweight main-content detection (Readability-style scoring).
 *
 * The goal is not to extract a clean article, but to tell apart the element that
 * holds the page's primary article from site chrome (navigation, sidebars,
 * footers, ads, related-article lists...). The result is used both to drop obvious
 * noise before anything is sent to Jev and to give Jev structural evidence for the
 * remaining candidates.
 */

const NOISE_TOKENS = [
  "nav", "navbar", "navigation", "menu", "breadcrumb", "breadcrumbs", "sidebar", "side", "widget",
  "related", "recommend", "recommended", "recommendation", "popular", "ranking", "trending",
  "share", "sharing", "social", "sns", "follow", "ad", "ads", "advert", "advertisement", "promo",
  "sponsor", "sponsored", "banner", "cookie", "consent", "gdpr", "newsletter", "subscribe", "signup",
  "footer", "masthead", "toolbar", "pagination", "pager", "comment", "comments", "disqus", "popup",
  "modal", "dialog", "outbrain", "taboola",
];
const POSITIVE_PATTERN = /article|post|entry|content|story|main|body|text|blog|prose|markdown|rich-?text/i;
const NOISE_SET = new Set(NOISE_TOKENS);
const MIN_MAIN_TEXT = 400;

export interface MainContentInfo {
  root: HTMLElement | null;
  title: HTMLElement | null;
}

export function detectMainContent(doc: Document = document): MainContentInfo {
  const scores = new Map<HTMLElement, number>();
  const addScore = (element: HTMLElement | null, value: number) => {
    if (!element || element === doc.body || element === doc.documentElement) return;
    if (!scores.has(element)) scores.set(element, initialScore(element));
    scores.set(element, (scores.get(element) ?? 0) + value);
  };

  for (const paragraph of doc.querySelectorAll<HTMLElement>("p, pre, blockquote, li, td, [role='paragraph']")) {
    if (paragraph.closest("nav, footer, aside, [role='navigation'], [role='contentinfo'], [role='complementary']")) continue;
    if (paragraph.matches("li, td") && paragraph.querySelector("p")) continue;
    const text = normalize(paragraph.textContent ?? "");
    if (text.length < 25) continue;
    // Japanese text has few commas and packs more meaning per character.
    const commas = (text.match(/[,、，]/g) ?? []).length;
    const weight = paragraph.matches("li, td") ? 0.5 : 1;
    const score = weight * (1 + commas + Math.min(Math.floor(text.length / 100), 3));
    addScore(paragraph.parentElement, score);
    addScore(paragraph.parentElement?.parentElement ?? null, score / 2);
    addScore(paragraph.parentElement?.parentElement?.parentElement ?? null, score / 4);
  }

  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const [element, score] of scores) {
    if (!isRendered(element)) continue;
    const adjusted = score * (1 - linkDensity(element));
    if (adjusted > bestScore) {
      best = element;
      bestScore = adjusted;
    }
  }

  if (!best || normalize(best.textContent ?? "").length < MIN_MAIN_TEXT) {
    const semantic = doc.querySelector<HTMLElement>("[itemprop='articleBody'], article, main, [role='main']");
    best = semantic && normalize(semantic.textContent ?? "").length >= MIN_MAIN_TEXT ? semantic : null;
  }
  if (best) best = expandToSemanticContainer(best);

  return { root: best, title: findTitle(doc, best) };
}

/**
 * The best-scoring element is often an inner "body" wrapper. Grow it to the closest
 * article/main ancestor when that ancestor does not pull in much extra material, so
 * that headings and lead paragraphs next to the body stay inside the main region.
 */
function expandToSemanticContainer(root: HTMLElement): HTMLElement {
  const rootLength = normalize(root.textContent ?? "").length;
  let current = root;
  let parent = root.parentElement;
  while (parent && parent !== document.body) {
    const parentLength = normalize(parent.textContent ?? "").length;
    if (parentLength > rootLength * 1.6 + 600 || linkDensity(parent) > 0.4) break;
    if (parent.matches("article, main, [role='main'], [itemprop='articleBody']")) return parent;
    if (hasNoiseHint(parent)) break;
    current = parent;
    parent = parent.parentElement;
  }
  // No semantic container nearby: keep the scored element plus close wrappers only.
  return current === root ? root : root.closest<HTMLElement>("article, main, [role='main']") ?? root;
}

function findTitle(doc: Document, root: HTMLElement | null): HTMLElement | null {
  const headings = [...doc.querySelectorAll<HTMLElement>("h1")].filter(
    (heading) => isRendered(heading) && !heading.closest("nav, footer, aside, [role='navigation']"),
  );
  if (headings.length === 0) return null;
  const inRoot = root ? headings.find((heading) => root.contains(heading)) : undefined;
  if (inRoot) return inRoot;
  const title = normalize(doc.title).toLowerCase();
  const byTitle = headings.find((heading) => {
    const text = normalize(heading.textContent ?? "").toLowerCase();
    return text.length >= 4 && title.includes(text.slice(0, 40));
  });
  if (byTitle) return byTitle;
  // Otherwise the last h1 before the main content (site logos usually come first).
  if (root) {
    const before = headings.filter((heading) => heading.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (before.length > 0) return before.at(-1) ?? null;
  }
  return headings[0] ?? null;
}

export function classifyRegion(element: HTMLElement, info: MainContentInfo): SegmentRegion {
  if (info.title && (info.title === element || info.title.contains(element))) return "main";
  const inRoot = info.root?.contains(element) ?? false;
  let node: HTMLElement | null = element;
  while (node && node !== info.root && node !== document.body) {
    const region = landmarkRegion(node, inRoot);
    if (region) return region;
    node = node.parentElement;
  }
  if (inRoot) return "main";
  return info.root ? "outside" : "unknown";
}

function landmarkRegion(node: HTMLElement, inRoot: boolean): SegmentRegion | null {
  const role = node.getAttribute("role");
  const tag = node.tagName;
  if (tag === "NAV" || role === "navigation" || role === "menu" || role === "menubar") return "navigation";
  if (tag === "ASIDE" || role === "complementary") return "sidebar";
  if (role === "contentinfo" || (tag === "FOOTER" && !inRoot)) return "footer";
  if (role === "banner" || (tag === "HEADER" && !inRoot)) return "header";
  if (role === "dialog" || role === "alertdialog") return "overlay";
  const tokens = classTokens(node);
  if (tokens.some((token) => token === "comment" || token === "comments" || token === "disqus")) return "comments";
  if (tokens.some((token) => ["ad", "ads", "advert", "advertisement", "sponsor", "sponsored", "promo", "outbrain", "taboola"].includes(token))) return "ad";
  if (tokens.some((token) => ["cookie", "consent", "gdpr", "popup", "modal", "dialog", "newsletter", "subscribe", "signup"].includes(token))) return "overlay";
  if (tokens.some((token) => ["related", "recommend", "recommended", "recommendation", "popular", "ranking", "trending"].includes(token))) return "related";
  if (tokens.some((token) => ["share", "sharing", "social", "sns", "follow"].includes(token))) return "share";
  if (tokens.some((token) => ["nav", "navbar", "navigation", "menu", "breadcrumb", "breadcrumbs", "pagination", "pager", "toolbar"].includes(token))) return "navigation";
  if (tokens.some((token) => ["sidebar", "widget"].includes(token))) return "sidebar";
  if (!inRoot && tokens.some((token) => token === "footer")) return "footer";
  if (!inRoot && tokens.some((token) => token === "masthead" || token === "header")) return "header";
  return null;
}

export function segmentKind(element: HTMLElement): SegmentKind {
  if (element.matches("h1,h2,h3,h4,h5,h6")) return "heading";
  if (element.matches("a,button,[role='button'],label")) return "control";
  if (element.matches("li,dd,dt")) return "list-item";
  if (element.matches("blockquote")) return "quote";
  if (element.matches("figcaption")) return "caption";
  if (element.matches("td,th")) return "table-cell";
  if (element.matches("p,[role='paragraph'],[data-testid='tweetText']")) return "paragraph";
  return "block";
}

export function linkDensity(element: HTMLElement): number {
  const total = normalize(element.textContent ?? "").length;
  if (total === 0) return 0;
  if (element.tagName === "A") return 1;
  let linked = 0;
  for (const anchor of element.querySelectorAll("a")) linked += normalize(anchor.textContent ?? "").length;
  return Math.min(1, linked / total);
}

/** Regions that are site chrome rather than content; never worth a Jev query. */
export function isHardNoise(region: SegmentRegion, kind: SegmentKind, density: number, hasMainRoot: boolean): boolean {
  if (region === "navigation" || region === "ad" || region === "overlay" || region === "share") return true;
  if (!hasMainRoot) return (region === "footer" || region === "header") && (kind === "control" || density > 0.3);
  if (region === "main") return false;
  if (kind === "control") return true;
  if (region === "footer" || region === "header" || region === "related" || region === "sidebar" || region === "comments") return true;
  // Link lists (e.g. "latest posts") outside the article.
  return density > 0.5;
}

function initialScore(element: HTMLElement): number {
  let score = 0;
  switch (element.tagName) {
    case "ARTICLE": score += 10; break;
    case "MAIN": score += 6; break;
    case "SECTION": case "DIV": score += 2; break;
    case "FORM": case "UL": case "OL": case "TABLE": score -= 3; break;
    case "ASIDE": case "NAV": case "FOOTER": case "HEADER": score -= 10; break;
  }
  if (element.getAttribute("itemprop") === "articleBody") score += 20;
  const hint = `${element.id} ${typeof element.className === "string" ? element.className : ""}`;
  if (POSITIVE_PATTERN.test(hint)) score += 15;
  if (hasNoiseHint(element)) score -= 25;
  return score;
}

function hasNoiseHint(element: HTMLElement): boolean {
  return classTokens(element).some((token) => NOISE_SET.has(token));
}

function classTokens(element: HTMLElement): string[] {
  const className = typeof element.className === "string" ? element.className : "";
  return `${element.id} ${className}`
    .split(/[\s_-]+|(?<=[a-z])(?=[A-Z])/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

function isRendered(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
