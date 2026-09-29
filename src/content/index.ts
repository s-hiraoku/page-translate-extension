import type { CandidateSegment, FocusAnchor, PagePickEvent, PagePickRequest, PagePickTarget, ReadSelectionResult, ScanResult, SegmentRegion, SelectionEvent, TranslationEntry } from "../shared/types";
import { PAGE_PICK_PORT, PANEL_PRESENCE_PORT, SELECTION_PORT } from "../shared/types";
import { readCurrentSelection, type CurrentSelection } from "./selection";
import { createSelectionTooltip, type SelectionTooltip, type TooltipState } from "./selection-tooltip";
import type { Box } from "./tooltip-layout";
import { connectorPath } from "./connector";
import { createScreenTopTracker, geometryTop } from "../shared/screen-top";
import { classifyRegion, detectMainContent, isHardNoise, linkDensity, segmentKind, type MainContentInfo } from "./main-content";

const BLOCK_SELECTOR = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote",
  "td", "th", "figcaption", "dd", "dt", "[role='paragraph']", "[data-testid='tweetText']",
].join(",");
const CONTROL_SELECTOR = "a,button,[role='button'],label";
const UNSAFE_TO_REPLACE = "style,script,link,template,iframe,video,audio,canvas,object,embed,input,select,textarea";
const EXCLUDED_SELECTOR = [
  "script", "style", "noscript", "template", "svg", "canvas", "pre", "code",
  "button", "input", "textarea", "select", "[contenteditable='true']",
  "[aria-hidden='true']", "[hidden]", "[inert]", "[data-page-translate-ui]", "dialog:not([open])",
  ".sr-only", ".visually-hidden", ".screen-reader-text", "[role='tooltip']", "[role='search']",
].join(",");
const originals = new Map<string, { element: HTMLElement; html: string }>();
const pageElements = new Map<string, HTMLElement>();
const palette = ["#2368e8", "#d45e24", "#11836a", "#9b52c2", "#b23f58", "#77851b"];
/** How long to redraw every frame after focusing, so the connector follows smooth scrolling. */
const CONNECTOR_SETTLE_MS = 1200;
/** Browser zoom of this tab, provided by the service worker. */
let tabZoom = 1;
/** The connector stays until another segment is focused, the page is restored, or Esc is pressed. */
let focusOverlay: { root: HTMLElement; frame: number; dispose: () => void; retarget: (anchor: FocusAnchor) => void } | null = null;
/** Screen Y of the page viewport's top edge, learned from real pointer events. */
const viewportTop = createScreenTopTracker();

// Any pointer or wheel event carries exact screen coordinates.
for (const type of ["pointermove", "pointerdown", "pointerover", "wheel"]) {
  window.addEventListener(type, (event) => viewportTop.learn(event as MouseEvent, pageZoomFactor()), { passive: true, capture: true });
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null || !("type" in message)) return;
  // A throwing handler would close the channel without a reply, which the panel can only
  // report as "cannot run here"; send the actual error back instead.
  try {
    handlePanelMessage(message as { type: string }, sendResponse);
  } catch (error) {
    sendResponse({ error: `ページの処理中にエラーが発生しました：${error instanceof Error ? error.message : String(error)}` });
  }
});

function handlePanelMessage(message: { type: string }, sendResponse: (response: unknown) => void): void {
  const type = message.type;

  if (type === "SCAN_PAGE") {
    sendResponse(scanPage());
    return;
  }
  if (type === "APPLY_TRANSLATIONS") {
    const entries = (message as unknown as { entries: TranslationEntry[] }).entries;
    sendResponse({ applied: applyTranslations(entries) });
    return;
  }
  if (type === "PAGE_TEXT") {
    sendResponse(readPageText());
    return;
  }
  if (type === "RESTORE_PAGE") {
    restoreOriginalPage();
    sendResponse({ restored: true });
    return;
  }
  if (type === "FOCUS_SEGMENT") {
    const { segmentId, anchor, zoom, label, color, scroll } = message as unknown as {
      segmentId: string; anchor?: FocusAnchor; zoom?: number; label?: string; color?: string; scroll?: boolean;
    };
    if (typeof zoom === "number" && zoom > 0) tabZoom = zoom;
    sendResponse({ focused: focusSegment(segmentId, anchor, { label, color }, scroll !== false) });
    return;
  }
  if (type === "UPDATE_FOCUS_ANCHOR") {
    // The side panel scrolled: keep the connector's end on the card.
    const { anchor } = message as unknown as { anchor: FocusAnchor };
    focusOverlay?.retarget(anchor);
    sendResponse({ updated: focusOverlay !== null });
    return;
  }
  if (type === "READ_SELECTION") {
    // Selection translation on demand (the shortcut): the panel translates what is selected now.
    const selected = readCurrentSelection();
    if (!selected) {
      showNoticeTooltip("翻訳する文章を選択してから、もう一度実行してください。");
      sendResponse({ empty: true } satisfies ReadSelectionResult);
      return;
    }
    sendResponse({ id: showSelectionTooltip(selected), text: selected.text } satisfies ReadSelectionResult);
    return;
  }
  if (type === "SELECTION_RESULT") {
    const { id, text, note, error } = message as unknown as { id: number; text?: string; note?: string; error?: string };
    const state: TooltipState = error !== undefined ? { kind: "error", text: error } : note !== undefined ? { kind: "note", text: note } : { kind: "done", text: text ?? "" };
    const shown = selectionUi !== null && selectionUi.id === id;
    if (shown) selectionUi?.tooltip.update(state);
    sendResponse({ shown });
  }
}

const MAX_SEGMENTS = 120;
const REGION_LABELS: Partial<Record<SegmentRegion, string>> = {
  header: "ヘッダー",
  navigation: "ナビゲーション",
  sidebar: "サイドバー",
  footer: "フッター",
  comments: "コメント",
  related: "関連記事",
  share: "共有",
  ad: "広告",
  overlay: "ポップアップ",
  meta: "メタ情報",
  outside: "本文外",
};

function scanPage(): ScanResult {
  stopPagePick();
  pageElements.clear();
  const mainContent = detectMainContent();
  lastMainContent = mainContent;
  const matches = [...document.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter((element) => {
    if (element.closest(EXCLUDED_SELECTOR) || !isVisible(element)) return false;
    const text = visibleText(element);
    return text.length >= 8 && /[\p{L}\p{N}]/u.test(text);
  });
  const matchSet = new Set(matches);
  const hasMatchedDescendant = collectAncestorsWithMatches(matches, matchSet);
  const selectedBlocks = matches.filter((element) => !hasMatchedDescendant.has(element));
  const blockAncestors = collectAncestorElements(selectedBlocks);
  const fallbackCandidates = [...document.querySelectorAll<HTMLElement>("div")].filter((element) => {
    if (element.closest(EXCLUDED_SELECTOR) || blockAncestors.has(element) || matchSet.has(element) || !isVisible(element)) return false;
    const text = visibleText(element);
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
    const text = visibleText(element);
    return text.length >= 2 && text.length <= 180 && /[\p{L}\p{N}]/u.test(text);
  });
  const selected = [...selectedBlocks, ...fallbackBlocks, ...controls].sort(byDocumentOrder);

  // Classify every candidate and drop obvious site chrome before anything leaves the page.
  let excludedCount = 0;
  const hasMainRoot = mainContent.root !== null;
  let classified = selected.flatMap((element) => {
    const region = classifyRegion(element, mainContent);
    const kind = segmentKind(element);
    const density = linkDensity(element);
    const text = visibleText(element);
    if (isHardNoise(region, kind, density, hasMainRoot, text)) {
      excludedCount += 1;
      return [];
    }
    return [{ element, region, kind, density }];
  });
  if (classified.length > MAX_SEGMENTS) {
    // Keep the article first, then whatever else fits, and restore document order.
    const rank = (region: SegmentRegion) => (region === "main" ? 0 : region === "unknown" ? 1 : 2);
    const kept = [...classified].sort((left, right) => rank(left.region) - rank(right.region)).slice(0, MAX_SEGMENTS);
    excludedCount += classified.length - kept.length;
    classified = kept.sort((left, right) => byDocumentOrder(left.element, right.element));
  }

  const headingContext: string[] = [];
  let bodyIndex = 0;
  const segments = classified.map(({ element, region, kind, density }, order): CandidateSegment => {
    const text = visibleText(element);
    const id = `segment-${order + 1}`;
    const isArticleTitle = mainContent.title === element;
    if (kind === "heading") {
      if (region === "main") {
        headingContext.length = 0;
        headingContext.push(text.slice(0, 48));
      }
    } else {
      bodyIndex += 1;
    }
    const regionLabel = REGION_LABELS[region];
    const baseLabel = isArticleTitle
      ? "記事タイトル"
      : element.matches("blockquote")
        ? `引用 ${bodyIndex}`
        : element.matches("a")
          ? `リンク ${bodyIndex}`
          : element.matches("button,[role='button']")
            ? `ボタン ${bodyIndex}`
            : region === "main" && headingContext.length > 0
              ? `${headingContext.at(-1)} · ${element.tagName.toLowerCase()} ${bodyIndex}`
              : `${element.tagName === "LI" ? "リスト" : kind === "heading" ? "見出し" : "本文"} ${bodyIndex}`;
    pageElements.set(id, element);
    return {
      id,
      order,
      location: regionLabel ? `${regionLabel} · ${baseLabel}` : baseLabel,
      tagName: element.tagName.toLowerCase(),
      sourceText: text,
      sourceHtml: sanitizeTranslatedHtml(element.innerHTML),
      region,
      kind,
      linkDensity: Math.round(density * 100) / 100,
      isArticleTitle,
    };
  });

  return {
    title: document.title,
    url: location.href,
    segments,
    mainContentDetected: hasMainRoot,
    excludedCount,
  };
}

/**
 * Title and main text of the page for the writing check's DeepL context. Unlike
 * scanPage it leaves the current segments, cards and page-click mode untouched.
 */
function readPageText(): { title: string; text: string } {
  const { root } = detectMainContent();
  const text = normalizeText((root ?? document.body).innerText || "").slice(0, 4_000);
  return { title: document.title, text };
}

function byDocumentOrder(left: Node, right: Node): number {
  const relation = left.compareDocumentPosition(right);
  return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : relation & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
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
    if (entry.state !== "translated" || !entry.translatedHtml || entry.partial) continue;
    const element = pageElements.get(entry.id);
    if (!element?.isConnected) continue;
    // Replacing innerHTML would delete these and can break the whole page's styling;
    // such blocks stay translated in the panel only.
    if (element.querySelector(UNSAFE_TO_REPLACE)) continue;
    if (!originals.has(entry.id)) {
      originals.set(entry.id, { element, html: element.innerHTML });
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
  }
  originals.clear();
  clearFocusOverlay();
}

/** Ratio between screen DIPs and CSS pixels of this page (browser zoom). */
function pageZoomFactor(): number {
  return tabZoom;
}

/**
 * Converts the card's screen position into this page's viewport coordinates.
 * The side panel and the page share the same screen, so aligning in screen space
 * lets the connector end exactly at the height of the clicked card.
 */
function anchorToClientY(anchor: FocusAnchor | undefined): number | null {
  if (!anchor || !Number.isFinite(anchor.screenY)) return null;
  const zoom = pageZoomFactor();
  const top = viewportTop.top(zoom) ?? geometryTop(zoom);
  const y = (anchor.screenY - top) / zoom;
  return Number.isFinite(y) ? y : null;
}

function focusSegment(id: string, anchor?: FocusAnchor, appearance: { label?: string; color?: string } = {}, scroll = true): boolean {
  const element = pageElements.get(id);
  if (!element?.isConnected) return false;
  clearFocusOverlay();

  const margin = 16;
  const requestedY = anchorToClientY(anchor);
  let targetY = clamp(requestedY ?? window.innerHeight / 2, margin, window.innerHeight - margin);
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Bring the source next to the card: its anchor line should sit at the card's height.
  // In page-click mode the reader just clicked the source, so the page stays put.
  if (scroll) {
    if (hasScrollableAncestor(element)) {
      element.scrollIntoView({ behavior: "instant", block: "center" });
    }
    const delta = anchorY(element.getBoundingClientRect()) - targetY;
    if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: smooth ? "smooth" : "instant" });
  }

  const color = appearance.color && /^#[0-9a-f]{6}$/i.test(appearance.color)
    ? appearance.color
    : palette[(Number(id.replace("segment-", "")) - 1) % palette.length] ?? palette[0];
  const root = document.createElement("div");
  root.dataset.pageTranslateUi = "true";
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: "fixed", inset: "0", zIndex: "2147483646", pointerEvents: "none",
  });

  // Highlight box drawn over the source element (does not touch page styles).
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed", boxSizing: "border-box", borderRadius: "6px",
    border: `2px solid ${color}`, background: `${color}14`, boxShadow: `0 0 0 4px ${color}22`,
  });
  const marker = document.createElement("span");
  marker.textContent = (appearance.label ?? id.replace("segment-", "")).slice(0, 4);
  Object.assign(marker.style, {
    position: "fixed", minWidth: "1.45rem", height: "1.45rem", padding: "0 .3rem", boxSizing: "border-box",
    display: "grid", placeItems: "center", borderRadius: "999px", color: "white",
    background: color, font: "600 12px/1 system-ui, sans-serif", boxShadow: "0 1px 6px #0003",
  });

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.assign(svg.style, {
    position: "fixed", inset: "0", width: "100vw", height: "100vh", overflow: "visible",
    // A soft shadow keeps the line readable on light and dark pages alike.
    filter: "drop-shadow(0 1px 1.5px rgb(0 0 0 / .28))",
  });
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", "2.25");
  path.setAttribute("stroke-linecap", "round");
  const start = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  start.setAttribute("r", "3.5");
  start.setAttribute("fill", color);
  const end = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  end.setAttribute("r", "4.5");
  end.setAttribute("fill", "white");
  end.setAttribute("stroke", color);
  end.setAttribute("stroke-width", "2.5");
  svg.append(path, start, end);
  root.append(box, svg, marker);
  document.documentElement.append(root);

  const draw = () => {
    if (!element.isConnected) return clearFocusOverlay();
    const rect = element.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const pad = 4;
    Object.assign(box.style, {
      left: `${rect.left - pad}px`, top: `${rect.top - pad}px`,
      width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px`,
    });
    marker.style.left = `${clamp(rect.left - pad - 10, 2, viewportWidth - 28)}px`;
    marker.style.top = `${clamp(rect.top - pad - 10, 2, window.innerHeight - 26)}px`;

    const x2 = viewportWidth - 1;
    const x1 = clamp(rect.right + pad, 8, x2 - 24);
    const y1 = clamp(anchorY(rect), 8, window.innerHeight - 8);
    const y2 = targetY;
    path.setAttribute("d", connectorPath(x1, y1, x2, y2));
    start.setAttribute("cx", String(x1));
    start.setAttribute("cy", String(y1));
    end.setAttribute("cx", String(x2));
    end.setAttribute("cy", String(y2));
  };

  // Follow the source while the page settles (smooth scrolling), then redraw only when
  // something can move it: scrolling (including nested scrollers) and resizes.
  const state = { root, frame: 0, dispose: () => undefined as void, retarget: (_anchor: FocusAnchor) => undefined as void };
  const settleUntil = performance.now() + CONNECTOR_SETTLE_MS;
  const loop = () => {
    draw();
    state.frame = performance.now() < settleUntil ? requestAnimationFrame(loop) : 0;
  };
  const schedule = () => {
    if (state.frame === 0) state.frame = requestAnimationFrame(() => { state.frame = 0; draw(); });
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") clearFocusOverlay(); };
  const resize = new ResizeObserver(schedule);
  resize.observe(element);
  resize.observe(document.documentElement);
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("keydown", onKey, true);
  // Coming back to the window or tab: rendering may have been paused, and the window may have moved.
  window.addEventListener("focus", schedule);
  document.addEventListener("visibilitychange", schedule);
  state.retarget = (next) => {
    const y = anchorToClientY(next);
    if (y === null) return;
    targetY = clamp(y, margin, window.innerHeight - margin);
    schedule();
  };
  state.dispose = () => {
    resize.disconnect();
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("focus", schedule);
    document.removeEventListener("visibilitychange", schedule);
  };
  loop();
  // Draw the line in from the source toward the card.
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches && typeof path.getTotalLength === "function") {
    const length = path.getTotalLength();
    path.style.strokeDasharray = String(length);
    const reveal = path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 420, easing: "cubic-bezier(.2, .7, .2, 1)" });
    // Redraws change the length; drop the dash once the line is fully drawn.
    reveal.onfinish = () => { path.style.strokeDasharray = ""; };
    end.animate([{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "scale(1)" }], { duration: 200, delay: 320, fill: "backwards", easing: "ease-out" });
    end.style.transformBox = "fill-box";
    end.style.transformOrigin = "center";
  }
  focusOverlay = state;
  return true;
}

/**
 * Page-click mode. While the side panel holds a page-pick port open, clicking a
 * translated source element selects its card instead of activating the page.
 * Closing the panel disconnects the port, which always ends the mode.
 */
let pagePick: { port: chrome.runtime.Port; targets: Map<HTMLElement, PagePickTarget>; dispose: () => void } | null = null;

/** Side panels currently connected to this page; the connector lives only while one is open. */
let panelPorts = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PRESENCE_PORT) return;
  panelPorts += 1;
  port.onDisconnect.addListener(() => {
    panelPorts = Math.max(0, panelPorts - 1);
    if (panelPorts === 0) clearFocusOverlay();
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PAGE_PICK_PORT) return;
  port.onMessage.addListener((message: PagePickRequest) => {
    if (message?.type !== "targets" || !Array.isArray(message.targets)) return;
    if (typeof message.zoom === "number" && message.zoom > 0) tabZoom = message.zoom;
    startPagePick(port, message.targets);
  });
  port.onDisconnect.addListener(() => {
    if (pagePick?.port === port) stopPagePick();
  });
});

/** Main content of the last scan, reused to describe blocks added in page-click mode. */
let lastMainContent: MainContentInfo = { root: null, title: null };
let manualCount = 0;
const ADD_COLOR = "#8891a4";

function startPagePick(port: chrome.runtime.Port, list: PagePickTarget[]): void {
  stopPagePick();
  const targets = new Map<HTMLElement, PagePickTarget>();
  for (const target of list) {
    const element = pageElements.get(target.id);
    if (element?.isConnected && typeof target.color === "string" && /^#[0-9a-f]{6}$/i.test(target.color)) {
      targets.set(element, target);
    }
  }

  const root = document.createElement("div");
  root.dataset.pageTranslateUi = "true";
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, { position: "fixed", inset: "0", zIndex: "2147483645", pointerEvents: "none" });
  const hover = document.createElement("div");
  Object.assign(hover.style, {
    position: "fixed", display: "none", boxSizing: "border-box", borderRadius: "6px",
    border: "2px dashed", transition: "all .08s ease-out",
  });
  const hoverLabel = document.createElement("span");
  hoverLabel.textContent = "＋ 翻訳を追加";
  Object.assign(hoverLabel.style, {
    position: "absolute", top: "-11px", right: "8px", padding: "1px 7px", borderRadius: "999px",
    background: ADD_COLOR, color: "#fff", font: "600 11px/18px system-ui, sans-serif", whiteSpace: "nowrap",
  });
  hover.append(hoverLabel);
  const hint = document.createElement("div");
  hint.textContent = "ページクリック：クリックで訳文を表示・追加 ／ 文字を選択して翻訳 · Escで終了";
  Object.assign(hint.style, {
    position: "fixed", right: "12px", bottom: "12px", padding: "7px 12px", borderRadius: "999px",
    background: "#16203a", color: "#fff", font: "500 12px/1.4 system-ui, sans-serif", boxShadow: "0 4px 14px #0003",
  });
  root.append(hover, hint);
  document.documentElement.append(root);

  const style = document.createElement("style");
  style.dataset.pageTranslateUi = "true";
  style.textContent = "[data-page-translate-pick]{cursor:pointer!important}";
  document.head.append(style);
  for (const element of targets.keys()) element.dataset.pageTranslatePick = "";

  let hovered: HTMLElement | null = null;
  /** Clicks right after a handled text selection belong to that selection. */
  let ignoreClickUntil = 0;
  const findTarget = (node: EventTarget | null): HTMLElement | null => {
    let current = node instanceof Element ? node : null;
    while (current) {
      if (current instanceof HTMLElement && targets.has(current)) return current;
      current = current.parentElement;
    }
    return null;
  };
  const drawHover = () => {
    if (!hovered?.isConnected) {
      hover.style.display = "none";
      return;
    }
    const rect = hovered.getBoundingClientRect();
    const target = targets.get(hovered);
    const color = target?.color ?? ADD_COLOR;
    hoverLabel.style.display = target ? "none" : "block";
    Object.assign(hover.style, {
      display: "block", left: `${rect.left - 4}px`, top: `${rect.top - 4}px`,
      width: `${rect.width + 8}px`, height: `${rect.height + 8}px`, borderColor: color, background: `${color}0f`,
    });
  };
  const add = (element: HTMLElement, selected?: string) => {
    const segment = describeForPanel(element, selected);
    port.postMessage({ type: "added", segment, followingIds: idsAfter(element) } satisfies PagePickEvent);
  };
  const onOver = (event: PointerEvent) => {
    hovered = findTarget(event.target) ?? pickableBlock(event.target);
    drawHover();
  };
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (performance.now() < ignoreClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const element = findTarget(event.target);
    const block = element ? null : pickableBlock(event.target);
    if (!element && !block) return;
    // Keep links and page handlers from firing: this click is for the translation.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (block) return add(block);
    const target = element ? targets.get(element) : undefined;
    if (!element || !target) return;
    port.postMessage({ type: "picked", segmentId: target.id } satisfies PagePickEvent);
  };
  const onMouseUp = () => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = normalizeText(selection.toString());
    if (text.length < 2 || text.length > 5000 || !/\p{L}/u.test(text)) return;
    const block = pickableBlock(selection.getRangeAt(0).startContainer);
    if (!block) return;
    ignoreClickUntil = performance.now() + 400;
    const whole = visibleText(block);
    add(block, text === whole ? undefined : text);
    selection.removeAllRanges();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    port.postMessage({ type: "exit" } satisfies PagePickEvent);
    stopPagePick();
  };
  const onScroll = () => drawHover();
  window.addEventListener("pointerover", onOver, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

  pagePick = {
    port,
    targets,
    dispose: () => {
      window.removeEventListener("pointerover", onOver, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, { capture: true });
      for (const element of targets.keys()) delete element.dataset.pageTranslatePick;
      style.remove();
      root.remove();
    },
  };
}

/**
 * The block a click on untranslated text refers to: the closest paragraph-like
 * element, or the nearest element with a reasonable amount of text.
 */
function pickableBlock(node: EventTarget | Node | null): HTMLElement | null {
  const start = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!start || start.closest("[data-page-translate-ui], input, textarea, select, [contenteditable='true']")) return null;
  const within = (element: Element | null): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement) return false;
    const text = visibleText(element);
    return text.length >= 2 && text.length <= 5000 && /\p{L}/u.test(text);
  };
  const block = start.closest(BLOCK_SELECTOR);
  if (within(block)) return block;
  for (let element: Element | null = start; element; element = element.parentElement) {
    if (within(element)) return element;
  }
  return null;
}

/** Describes a block (or a selection inside it) for the side panel, registering it for focusing. */
function describeForPanel(element: HTMLElement, selected?: string): CandidateSegment {
  let id = selected ? undefined : [...pageElements].find(([, known]) => known === element)?.[0];
  if (!id) {
    manualCount += 1;
    id = `manual-${manualCount}`;
    pageElements.set(id, element);
  }
  const text = selected ?? visibleText(element);
  const kind = segmentKind(element);
  const tag = element.tagName.toLowerCase();
  return {
    id,
    order: -1,
    location: selected ? `選択テキスト · ${tag}` : `追加 · ${kind === "heading" ? "見出し" : kind === "control" ? "リンク・ボタン" : tag}`,
    tagName: tag,
    sourceText: text.slice(0, 12_000),
    sourceHtml: selected ? escapeHtml(text).slice(0, 20_000) : sanitizeTranslatedHtml(element.innerHTML).slice(0, 20_000),
    region: classifyRegion(element, lastMainContent),
    kind,
    linkDensity: Math.round(linkDensity(element) * 100) / 100,
    isArticleTitle: false,
    manual: true,
    partial: Boolean(selected),
  };
}

/** Known segments that come after the element in page order, so the panel can insert its card in place. */
function idsAfter(element: HTMLElement): string[] {
  const ids: string[] = [];
  for (const [id, known] of pageElements) {
    if (known !== element && element.compareDocumentPosition(known) & Node.DOCUMENT_POSITION_FOLLOWING && !element.contains(known)) ids.push(id);
  }
  return ids;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stopPagePick(): void {
  pagePick?.dispose();
  pagePick = null;
}

/** The point on the source that the connector attaches to (first line of text). */
function anchorY(rect: DOMRect): number {
  return rect.top + Math.min(rect.height / 2, 14);
}

function hasScrollableAncestor(element: HTMLElement): boolean {
  let parent = element.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) return true;
    parent = parent.parentElement;
  }
  return false;
}

function clearFocusOverlay(): void {
  if (!focusOverlay) return;
  cancelAnimationFrame(focusOverlay.frame);
  focusOverlay.dispose();
  focusOverlay.root.remove();
  focusOverlay = null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function sanitizeTranslatedHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowed = new Set(["A", "EM", "STRONG", "B", "I", "CODE", "SPAN", "BR", "SMALL", "SUB", "SUP", "MARK"]);
  // Their text is not page content (CSS, scripts, fallbacks); flattening them would leak it.
  const dropped = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION", "IFRAME", "OBJECT"]);

  const clean = (node: Node): Node[] => {
    if (node.nodeType === Node.TEXT_NODE) return [document.createTextNode(node.textContent ?? "")];
    if (!(node instanceof HTMLElement)) return [];
    if (dropped.has(node.tagName)) return [];
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

/**
 * Rendered text only. `textContent` (and `innerText` of an element that is not rendered)
 * includes <style>/<script> bodies and hidden text, e.g. CSS embedded by site builders.
 */
function visibleText(element: HTMLElement): string {
  if (element.getClientRects().length === 0) return "";
  return normalizeText(element.innerText || "");
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[\t\r ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Selection translation. The tooltip shows the translation next to the selected text and lives
 * until the reader clicks elsewhere, presses Esc, selects something else or closes the panel
 * (in selection mode). The panel does the translating; the page only reads the selection and
 * draws the tooltip.
 */
let selectionUi: { id: number; text: string; tooltip: SelectionTooltip; dispose: () => void } | null = null;
let selectionSeq = 0;
let selectionMode: { port: chrome.runtime.Port; dispose: () => void } | null = null;

function rangeBox(range: Range): Box | null {
  try {
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const first = range.getClientRects()[0];
    return first ? { left: first.left, top: first.top, right: first.right, bottom: first.bottom } : null;
  } catch {
    return null;
  }
}

function closeSelectionTooltip(): void {
  const ui = selectionUi;
  selectionUi = null;
  ui?.dispose();
  ui?.tooltip.destroy();
}

/** Shows a tooltip in its "translating" state for this selection and returns the id its answer must carry. */
function showSelectionTooltip(selected: CurrentSelection): number {
  closeSelectionTooltip();
  selectionSeq += 1;
  const id = selectionSeq;
  const tooltip = createSelectionTooltip(() => rangeBox(selected.range), closeSelectionTooltip);
  openTooltip(id, selected.text, tooltip);
  return id;
}

/** A message (for example "nothing selected") in the same tooltip, at the top of the viewport. */
function showNoticeTooltip(text: string): void {
  closeSelectionTooltip();
  selectionSeq += 1;
  const width = document.documentElement.clientWidth || window.innerWidth;
  const tooltip = createSelectionTooltip(() => ({ left: width / 2, right: width / 2, top: 24, bottom: 24 }), closeSelectionTooltip);
  tooltip.update({ kind: "note", text });
  const timer = window.setTimeout(closeSelectionTooltip, 4000);
  openTooltip(selectionSeq, "", tooltip, () => window.clearTimeout(timer));
}

function openTooltip(id: number, text: string, tooltip: SelectionTooltip, extraDispose?: () => void): void {
  let frame = 0;
  const follow = () => {
    if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; tooltip.reposition(); });
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.composedPath().includes(tooltip.host)) closeSelectionTooltip();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeSelectionTooltip();
  };
  window.addEventListener("scroll", follow, { passive: true, capture: true });
  window.addEventListener("resize", follow, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKey, true);
  selectionUi = {
    id,
    text,
    tooltip,
    dispose: () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      extraDispose?.();
    },
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SELECTION_PORT) return;
  startSelectionMode(port);
});

/** While the panel holds the selection port open, selecting text asks the panel to translate it. */
function startSelectionMode(port: chrome.runtime.Port): void {
  stopSelectionMode();
  let timer = 0;
  const check = () => {
    const selected = readCurrentSelection();
    if (!selected || selectionUi?.text === selected.text) return;
    const id = showSelectionTooltip(selected);
    port.postMessage({ type: "selected", id, text: selected.text } satisfies SelectionEvent);
  };
  const schedule = (event: Event) => {
    if (selectionUi && event.composedPath().includes(selectionUi.tooltip.host)) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(check, 120);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    // Selecting with the keyboard: Shift+arrows, or Ctrl/Cmd+A.
    if (event.shiftKey || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")) schedule(event);
  };
  window.addEventListener("mouseup", schedule, true);
  window.addEventListener("keyup", onKeyUp, true);
  port.onDisconnect.addListener(() => {
    if (selectionMode?.port === port) stopSelectionMode();
  });
  selectionMode = {
    port,
    dispose: () => {
      window.clearTimeout(timer);
      window.removeEventListener("mouseup", schedule, true);
      window.removeEventListener("keyup", onKeyUp, true);
    },
  };
}

function stopSelectionMode(): void {
  selectionMode?.dispose();
  selectionMode = null;
  closeSelectionTooltip();
}
