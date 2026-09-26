import type { CandidateSegment, TranslationEntry } from "../shared/types";

const BLOCK_SELECTOR = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote",
  "td", "th", "figcaption", "dd", "dt", "[role='paragraph']", "[data-testid='tweetText']",
].join(",");
const CONTROL_SELECTOR = "a,button,[role='button'],label";
const EXCLUDED_SELECTOR = [
  "script", "style", "noscript", "template", "svg", "canvas", "pre", "code",
  "button", "input", "textarea", "select", "[contenteditable='true']",
  "[aria-hidden='true']", "[data-page-translate-ui]",
].join(",");
const originals = new Map<string, { element: HTMLElement; html: string; outline: string; outlineOffset: string }>();
const pageElements = new Map<string, HTMLElement>();
const palette = ["#2368e8", "#d45e24", "#11836a", "#9b52c2", "#b23f58", "#77851b"];
let connectorLayer: SVGSVGElement | null = null;
let marker: HTMLSpanElement | null = null;
let connectorTimer = 0;
let connectorUpdate: (() => void) | null = null;

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null || !("type" in message)) return;
  const type = (message as { type: string }).type;

  if (type === "SCAN_PAGE") {
    const segments = scanPage();
    sendResponse({ title: document.title, url: location.href, segments });
    return;
  }
  if (type === "APPLY_TRANSLATIONS") {
    const entries = (message as unknown as { entries: TranslationEntry[] }).entries;
    sendResponse({ applied: applyTranslations(entries) });
    return;
  }
  if (type === "RESTORE_PAGE") {
    restoreOriginalPage();
    sendResponse({ restored: true });
    return;
  }
  if (type === "FOCUS_SEGMENT") {
    const segmentId = (message as unknown as { segmentId: string }).segmentId;
    sendResponse({ focused: focusSegment(segmentId) });
  }
});

function scanPage(): CandidateSegment[] {
  pageElements.clear();
  const matches = [...document.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter((element) => {
    if (element.closest(EXCLUDED_SELECTOR) || !isVisible(element)) return false;
    const text = normalizeText(element.innerText || element.textContent || "");
    return text.length >= 8 && /[\p{L}\p{N}]/u.test(text);
  });
  const matchSet = new Set(matches);
  const hasMatchedDescendant = collectAncestorsWithMatches(matches, matchSet);
  const selectedBlocks = matches.filter((element) => !hasMatchedDescendant.has(element));
  const blockAncestors = collectAncestorElements(selectedBlocks);
  const fallbackCandidates = [...document.querySelectorAll<HTMLElement>("div")].filter((element) => {
    if (element.closest(EXCLUDED_SELECTOR) || blockAncestors.has(element) || matchSet.has(element) || !isVisible(element)) return false;
    const text = normalizeText(element.innerText || element.textContent || "");
    return text.length >= 8 && text.length <= 12_000 && /[\p{L}\p{N}]/u.test(text);
  });
  const fallbackSet = new Set(fallbackCandidates);
  const hasFallbackDescendant = collectAncestorsWithMatches(fallbackCandidates, fallbackSet);
  const fallbackBlocks = fallbackCandidates.filter((element) => !hasFallbackDescendant.has(element));
  const fallbackBlockSet = new Set(fallbackBlocks);
  const structuralBlockSet = new Set(selectedBlocks);
  const controls = [...document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].filter((element) => {
    if (element.closest(EXCLUDED_SELECTOR) || !isVisible(element)) return false;
    if (hasAncestorFromSet(element, structuralBlockSet) || hasAncestorFromSet(element, fallbackBlockSet)) return false;
    const text = normalizeText(element.innerText || element.textContent || "");
    return text.length >= 2 && text.length <= 180 && /[\p{L}\p{N}]/u.test(text);
  });
  const selected = [...selectedBlocks, ...fallbackBlocks, ...controls].sort((left, right) => {
    const relation = left.compareDocumentPosition(right);
    return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : relation & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  });

  const headingContext: string[] = [];
  let bodyIndex = 0;
  return selected.map((element, order) => {
    const text = normalizeText(element.innerText || element.textContent || "");
    const id = `segment-${order + 1}`;
    if (element.matches("h1,h2,h3,h4,h5,h6")) {
      headingContext.length = 0;
      headingContext.push(text.slice(0, 48));
    } else {
      bodyIndex += 1;
    }
    const locationLabel = element.matches("h1")
      ? "記事タイトル"
      : element.matches("blockquote")
        ? `引用 ${bodyIndex}`
        : element.matches("a")
          ? `リンク ${bodyIndex}`
          : element.matches("button,[role='button']")
            ? `ボタン ${bodyIndex}`
        : headingContext.length > 0
          ? `${headingContext.at(-1)} · ${element.tagName.toLowerCase()} ${bodyIndex}`
          : `${element.tagName === "LI" ? "リスト" : "本文"} ${bodyIndex}`;
    pageElements.set(id, element);
    return {
      id,
      order,
      location: locationLabel,
      tagName: element.tagName.toLowerCase(),
      sourceText: text,
      sourceHtml: sanitizeTranslatedHtml(element.innerHTML),
    };
  });
}

function collectAncestorsWithMatches<T extends HTMLElement>(elements: T[], matched: Set<T>): Set<T> {
  const parents = new Set<T>();
  for (const element of elements) {
    let parent = element.parentElement;
    while (parent) {
      if (matched.has(parent as T)) parents.add(parent as T);
      parent = parent.parentElement;
    }
  }
  return parents;
}

function collectAncestorElements(elements: HTMLElement[]): Set<HTMLElement> {
  const ancestors = new Set<HTMLElement>();
  for (const element of elements) {
    let parent = element.parentElement;
    while (parent) {
      ancestors.add(parent);
      parent = parent.parentElement;
    }
  }
  return ancestors;
}

function hasAncestorFromSet(element: HTMLElement, candidates: Set<HTMLElement>): boolean {
  let parent = element.parentElement;
  while (parent) {
    if (candidates.has(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function applyTranslations(entries: TranslationEntry[]): number {
  let applied = 0;
  for (const entry of entries) {
    if (entry.state !== "translated" || !entry.translatedHtml) continue;
    const element = pageElements.get(entry.id);
    if (!element?.isConnected) continue;
    if (!originals.has(entry.id)) {
      originals.set(entry.id, {
        element,
        html: element.innerHTML,
        outline: element.style.outline,
        outlineOffset: element.style.outlineOffset,
      });
    }
    element.innerHTML = sanitizeTranslatedHtml(entry.translatedHtml);
    applied += 1;
  }
  return applied;
}

function restoreOriginalPage(): void {
  for (const saved of originals.values()) {
    if (!saved.element.isConnected) continue;
    saved.element.innerHTML = saved.html;
    saved.element.style.outline = saved.outline;
    saved.element.style.outlineOffset = saved.outlineOffset;
  }
  originals.clear();
  clearConnector();
}

function focusSegment(id: string): boolean {
  const element = pageElements.get(id);
  if (!element?.isConnected) return false;
  element.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    block: "center",
  });
  clearTimeout(connectorTimer);
  clearConnector();

  const color = palette[(Number(id.replace("segment-", "")) - 1) % palette.length] ?? palette[0];
  marker = document.createElement("span");
  marker.dataset.pageTranslateUi = "true";
  marker.textContent = id.replace("segment-", "");
  Object.assign(marker.style, {
    position: "fixed", zIndex: "2147483647", width: "1.45rem", height: "1.45rem",
    display: "grid", placeItems: "center", borderRadius: "50%", color: "white",
    background: color, font: "600 0.75rem/1 system-ui", boxShadow: "0 1px 6px #0003",
    pointerEvents: "none",
  });
  document.documentElement.append(marker);

  connectorLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  connectorLayer.dataset.pageTranslateUi = "true";
  connectorLayer.setAttribute("aria-hidden", "true");
  Object.assign(connectorLayer.style, {
    position: "fixed", inset: "0", width: "100vw", height: "100vh",
    zIndex: "2147483646", overflow: "visible", pointerEvents: "none",
  });
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", "2.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-dasharray", "5 5");
  connectorLayer.append(path);
  document.documentElement.append(connectorLayer);

  const update = () => {
    const rect = element.getBoundingClientRect();
    const x1 = Math.max(8, Math.min(window.innerWidth - 12, rect.right));
    const y1 = Math.max(8, Math.min(window.innerHeight - 12, rect.top + Math.min(rect.height / 2, 26)));
    const x2 = window.innerWidth - 3;
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + 42} ${y1}, ${x2 - 42} ${y1}, ${x2} ${y1}`);
    if (marker) {
      marker.style.left = `${Math.max(4, x1 - 12)}px`;
      marker.style.top = `${y1 - 12}px`;
    }
  };
  requestAnimationFrame(update);
  connectorUpdate = update;
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });
  connectorTimer = window.setTimeout(clearConnector, 1800);
  return true;
}

function clearConnector(): void {
  if (connectorUpdate) {
    window.removeEventListener("scroll", connectorUpdate);
    window.removeEventListener("resize", connectorUpdate);
  }
  connectorUpdate = null;
  connectorLayer?.remove();
  marker?.remove();
  connectorLayer = null;
  marker = null;
}

function sanitizeTranslatedHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowed = new Set(["A", "EM", "STRONG", "B", "I", "CODE", "SPAN", "BR", "SMALL", "SUB", "SUP", "MARK"]);

  const clean = (node: Node): Node[] => {
    if (node.nodeType === Node.TEXT_NODE) return [document.createTextNode(node.textContent ?? "")];
    if (!(node instanceof HTMLElement)) return [];
    if (!allowed.has(node.tagName)) return [...node.childNodes].flatMap(clean);

    const safe = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (href) {
        try {
          const url = new URL(href, location.href);
          if (["http:", "https:", "mailto:"].includes(url.protocol) || href.startsWith("#")) safe.setAttribute("href", url.href);
        } catch {
          // Invalid links are kept as plain text.
        }
      }
      const title = node.getAttribute("title");
      if (title) safe.setAttribute("title", title.slice(0, 200));
    }
    for (const child of node.childNodes) safe.append(...clean(child));
    return [safe];
  };

  const root = document.createElement("div");
  for (const child of template.content.childNodes) root.append(...clean(child));
  return root.innerHTML;
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[\t\r ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
