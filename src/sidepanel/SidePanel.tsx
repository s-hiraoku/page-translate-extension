import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type {
  CandidateSegment,
  Decision,
  DeepLEndpoint,
  ComposeLanguage,
  DeepLPlan,
  DisplayMode,
  ExtensionMessage,
  ExtensionSettings,
  FocusAnchor,
  PagePickEvent,
  PageWatchEvent,
  PanelCommand,
  PagePickRequest,
  ProviderStatus,
  ReadSelectionResult,
  ScanResult,
  SegmentState,
  SelectionEvent,
  TargetLanguage,
  ThemePreference,
  TranslationEntry,
} from "../shared/types";
import { CLAUDE_CONTEXT_CHARS, DATA_USE_CONSENT_KEY, DATA_USE_CONSENT_VERSION, DEFAULT_SETTINGS, PAGE_PICK_PORT, PAGE_WATCH_PORT, PANEL_COMMAND_KEY, PANEL_PRESENCE_PORT, SELECTION_PORT, SETTINGS_KEY, isPanelCommand } from "../shared/types";
import { Composer } from "./Composer";
import { Icon, type IconName } from "./Icon";
import {
  CACHE_KEY,
  CACHE_TTL_HOURS,
  buildPage,
  describeCache,
  emptyCache,
  findPage,
  formatAge,
  hashText,
  isUnchanged,
  pageCacheKey,
  prune,
  readCache,
  type CacheStore,
  type CachedPage,
} from "./cache";
import { isInTargetLanguage, isMainProse } from "./rules";
import { effectiveSettings } from "../shared/effective-settings";
import { chromeTranslatorSupported, getChromeTranslator, setDownloadProgressListener, textToHtml, translateWithChrome } from "../shared/chrome-translator";
import { applyTheme, cachedTheme } from "./theme";
import { createScreenTopTracker } from "../shared/screen-top";

interface DecisionResult {
  decisions: Array<{ id: string; decision: Decision; confidence: number }>;
}

interface TranslationResult {
  translations: Array<{ id: string; translatedText: string; translatedHtml: string }>;
}


const themeOptions: Array<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: "system", label: "システム", icon: "monitor" },
  { value: "light", label: "ライト", icon: "sun" },
  { value: "dark", label: "ダーク", icon: "moon" },
];

const jevOptions: Array<{ value: boolean; label: string }> = [
  { value: true, label: "Jevを使う" },
  { value: false, label: "Jevを使わない" },
];

const COMPOSE_NEEDS_DEEPL = "英作文機能を使うには、設定でDeepLのAPIキーを登録してください。";
const INITIAL_STATUS = "ページを開いて「このページを翻訳」を押してください。";
/** The user guide (GitHub Pages, built from docs/). */
const GUIDE_URL = "https://s-hiraoku.github.io/page-translate-extension/";

/** Which of the two modes that react to selecting text on the page is on. One value, so both can never be. */
type PickMode = "off" | "page-click" | "selection";

const shortcutRows: Array<{ command: PanelCommand; label: string; short: string }> = [
  { command: "translate-page", label: "このページを翻訳", short: "翻訳" },
  { command: "toggle-page-pick", label: "ページ選択のオン・オフ", short: "ページ選択" },
  { command: "translate-selection", label: "選択した文章を翻訳", short: "選択翻訳" },
];

function withShortcut(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label}（${shortcut}）` : label;
}

const colors = ["#2c5cf0", "#e0702a", "#0f8a6c", "#9150c8", "#c23d5f", "#6f8517"];

/** Screen Y of the side panel viewport's top edge, learned from pointer events and kept right when the window moves. */
const panelTop = createScreenTopTracker();
// Any pointer or wheel event carries exact screen coordinates.
for (const type of ["pointermove", "pointerdown", "pointerover", "wheel"]) {
  window.addEventListener(type, (event) => panelTop.learn(event as MouseEvent), { passive: true });
}

export function SidePanel() {
  const [settings, setSettings] = useState<ExtensionSettings>(() => ({ ...DEFAULT_SETTINGS, theme: cachedTheme() }));
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [pageTitle, setPageTitle] = useState("");
  /** The title as of the latest scan, for requests made before React re-renders (Claude reads it as context). */
  const pageTitleRef = useRef("");
  /** The text of every passage this page translates (cached ones too), as context for Claude. */
  const pageTextRef = useRef("");
  const [pageUrl, setPageUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [error, setError] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typesafeApiKey, setTypesafeApiKey] = useState("");
  const [deeplApiKey, setDeeplApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [savingKeys, setSavingKeys] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolver = useRef<((agreed: boolean) => void) | null>(null);
  const [view, setView] = useState<"translate" | "compose">("translate");
  /** Shown after the reader tries the writing tab without a DeepL key. */
  const [composeHint, setComposeHint] = useState(false);
  /** Candidates the page scan or the local language check dropped before Jev saw them. */
  const [droppedCount, setDroppedCount] = useState(0);
  /**
   * Page select mode (clicking or resting on translated text on the page selects its card) or selection
   * translation (selecting text shows its translation in a tooltip). Both react to selecting
   * text, so turning one on turns the other off in the same step.
   */
  const [pickMode, setPickMode] = useState<PickMode>("off");
  const pagePick = pickMode === "page-click";
  const selectionMode = pickMode === "selection";
  const setPagePick = (value: boolean | ((on: boolean) => boolean)) => setPickMode((current) => {
    const on = typeof value === "function" ? value(current === "page-click") : value;
    return on ? "page-click" : current === "page-click" ? "off" : current;
  });
  const setSelectionMode = (value: boolean | ((on: boolean) => boolean)) => setPickMode((current) => {
    const on = typeof value === "function" ? value(current === "selection") : value;
    return on ? "selection" : current === "selection" ? "off" : current;
  });
  /** Tab whose page the results on screen belong to; the panel watches it for navigation. */
  const [watchTabId, setWatchTabId] = useState<number | null>(null);
  // The tab the results and modes belong to; switching to another tab in this window clears them.
  const boundTabRef = useRef<number | null>(null);
  const panelTopRef = useRef<HTMLDivElement | null>(null);
  // With "in the page" display the translations are on the page already, so the list starts folded
  // when a translation begins from an empty panel. It only folds in that mode.
  const [listFolded, setListFolded] = useState(false);
  // Which settings explanations are unfolded; they start folded each time the settings open.
  const [openHelp, setOpenHelp] = useState<ReadonlySet<string>>(() => new Set());
  const help: HelpState = {
    isOpen: (id) => openHelp.has(id),
    toggle: (id) => setOpenHelp((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    }),
  };

  // The results heading sticks right under the fixed controls, whose height changes with notes and modes.
  useEffect(() => {
    const top = panelTopRef.current;
    if (!top) return;
    const update = () => document.documentElement.style.setProperty("--panel-top-height", `${top.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(top);
    return () => observer.disconnect();
  }, []);
  /** Set once the stored settings are read, so nothing acts on the defaults in the meantime. */
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  /** What the last run took from the translation cache, shown under the status. */
  const [cacheNote, setCacheNote] = useState<{ savedAt: number; reused: number; total: number; unchanged: boolean } | null>(null);
  /** Pages and size of the translation cache, shown in Settings. */
  const [cacheInfo, setCacheInfo] = useState({ pages: 0, chars: 0 });
  /** Current keyboard shortcuts by command name; "" when the reader has none assigned. */
  const [shortcuts, setShortcuts] = useState<Partial<Record<PanelCommand, string>>>({});

  // Keep the page connector attached to the selected card while the panel scrolls or resizes.
  useEffect(() => {
    if (!selectedId) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const card = document.querySelector<HTMLElement>(`[data-entry-id="${selectedId}"]`);
      const anchor = card ? anchorFor(card, panelTop.top()) : undefined;
      if (anchor) void sendMessage({ type: "UPDATE_FOCUS_ANCHOR", anchor }).catch(() => undefined);
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(update); };
    const onVisible = () => { if (document.visibilityState === "visible") schedule(); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    // Coming back to Chrome or to this tab: the card may have moved (or the window with it) while
    // scroll updates went nowhere, so line the connector up again.
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", onVisible);
    chrome.tabs.onActivated?.addListener(schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisible);
      chrome.tabs.onActivated?.removeListener(schedule);
    };
  }, [selectedId]);

  useEffect(() => {
    void chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
      if (stored[SETTINGS_KEY]) {
        setSettings({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<ExtensionSettings>) });
      }
      setSettingsLoaded(true);
    }, () => setSettingsLoaded(true));
  }, []);

  // Expired translations go when the panel opens or the lifetime changes, and turning the cache off
  // deletes it, so nothing stays on the device longer than the reader chose.
  useEffect(() => {
    if (!settingsLoaded) return;
    void (async () => {
      if (!settings.cacheEnabled) {
        await chrome.storage.local.remove(CACHE_KEY);
        return;
      }
      const store = await loadCacheStore();
      const pruned = prune(store, settings.cacheTtlHours, Date.now());
      if (Object.keys(pruned.pages).length !== Object.keys(store.pages).length) await chrome.storage.local.set({ [CACHE_KEY]: pruned });
    })().catch(() => undefined);
  }, [settingsLoaded, settings.cacheEnabled, settings.cacheTtlHours]);

  // Shortcuts can change in chrome://extensions/shortcuts while the panel is open.
  useEffect(() => {
    void loadShortcuts();
    const onFocus = () => void loadShortcuts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Keyboard shortcuts arrive through session storage (see the service worker), which
  // also reaches this panel when the shortcut itself opened it.
  const commandRef = useRef<(command: PanelCommand) => void>(() => undefined);
  useEffect(() => {
    let windowId: number | undefined;
    const handled = new Set<string>();
    const take = (value: unknown) => {
      const request = value as { id?: unknown; command?: unknown; windowId?: unknown; at?: unknown } | undefined;
      if (!request || typeof request.id !== "string" || !isPanelCommand(request.command)) return;
      if (windowId === undefined || request.windowId !== windowId || handled.has(request.id)) return;
      if (typeof request.at !== "number" || Date.now() - request.at > 10_000) return;
      handled.add(request.id);
      void chrome.storage.session.remove(PANEL_COMMAND_KEY).catch(() => undefined);
      commandRef.current(request.command);
    };
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes[PANEL_COMMAND_KEY]?.newValue) take(changes[PANEL_COMMAND_KEY].newValue);
      // The context menu switches "translate as I select" from outside the panel.
      const changed = area === "local" ? changes[SETTINGS_KEY]?.newValue as Partial<ExtensionSettings> | undefined : undefined;
      if (changed && typeof changed.selectionAutoTranslate === "boolean") {
        const enabled = changed.selectionAutoTranslate;
        setSettings((current) => current.selectionAutoTranslate === enabled ? current : { ...current, selectionAutoTranslate: enabled });
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    void chrome.windows.getCurrent()
      .then((current) => { windowId = current.id; return chrome.storage.session.get(PANEL_COMMAND_KEY); })
      .then((stored) => take(stored[PANEL_COMMAND_KEY]))
      .catch(() => undefined);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Jev's "skip" decisions are not part of the article: they never appear in the list.
  const visibleEntries = useMemo(() => entries.filter((entry) => entry.state !== "skipped"), [entries]);
  const hiddenCount = droppedCount + entries.length - visibleEntries.length;
  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  // The writing check needs the DeepL plan (DeepL Write is paid-only) before Settings is opened.
  useEffect(() => {
    void sendMessage<ProviderStatus>({ type: "CHECK_PROVIDERS" }).then(setProviderStatus, () => undefined);
  }, []);

  // The writing check runs on DeepL only. Until the key check answers, the tab stays as it is
  // (no flicker); without a key it is shown locked, and a reader on it (the key was just removed)
  // goes back to page translation.
  const composeLocked = providerStatus !== null && !providerStatus.providers.deepl;
  useEffect(() => {
    if (composeLocked && view === "compose") setView("translate");
    if (!composeLocked) setComposeHint(false);
  }, [composeLocked, view]);

  const pickable = useMemo(
    () => visibleEntries.flatMap((entry, index) => entry.state === "translated" ? [{ id: entry.id, label: String(index + 1), color: entryColor(index) }] : []),
    [visibleEntries],
  );
  const pickableKey = pickable.map((target) => target.id).join(",");
  const visibleRef = useRef(visibleEntries);
  visibleRef.current = visibleEntries;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const chromeSupported = useMemo(() => chromeTranslatorSupported(), []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const providerStatusRef = useRef(providerStatus);
  providerStatusRef.current = providerStatus;
  /**
   * The settings as they apply now: Jev only with its key, Chrome's translator only where this Chrome
   * has one (else DeepL). Actions read this; the settings screen shows what the reader chose.
   */
  const currentSettings = (): ExtensionSettings => effectiveSettings(settingsRef.current, {
    jevKey: providerStatusRef.current ? providerStatusRef.current.providers.jev : null,
    chromeTranslator: chromeSupported,
  });
  const applied = effectiveSettings(settings, { jevKey: providerStatus ? providerStatus.providers.jev : null, chromeTranslator: chromeSupported });
  /** Bumped by every new scan so late results from the previous list are dropped. */
  const generationRef = useRef(0);
  // A finished scan (which also means data-use consent was given) enables page select mode,
  // even when it left no visible cards: that is when adding one by hand matters most.
  const scanned = !busy && pageUrl !== "";

  const resetToStartRef = useRef<() => void>(() => undefined);
  // Ports the modes hold to the page, so closing the panel can end them at once.
  const modePorts = useRef(new Set<chrome.runtime.Port>());
  useEffect(() => {
    // The panel is going away (closed, or its page unloaded): end both modes. The page ends
    // them too when the ports drop; this makes sure of it, and of the tooltip.
    const onHide = () => {
      for (const port of modePorts.current) port.disconnect();
      modePorts.current.clear();
      setPickMode("off");
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // Watch the page the results belong to. It reports a navigation inside the page, and a full
  // navigation, a reload or a closed tab drops the port; either way the results are of a page
  // that is gone, so the panel returns to its start screen.
  useEffect(() => {
    if (watchTabId === null) return;
    let port: chrome.runtime.Port | null = null;
    let cancelled = false;
    try {
      port = chrome.tabs.connect(watchTabId, { name: PAGE_WATCH_PORT });
      port.onMessage.addListener((message: PageWatchEvent) => {
        if (message.type === "navigated") resetToStartRef.current();
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!cancelled) resetToStartRef.current();
      });
    } catch {
      // No content script in that tab: there is nothing to watch.
    }
    return () => {
      cancelled = true;
      port?.disconnect();
    };
  }, [watchTabId]);

  // Switching to another tab leaves the page the results belong to, so start over. Only tabs of this
  // panel's own window count: activations in other windows say nothing about this one.
  useEffect(() => {
    let windowId: number | undefined;
    void chrome.windows.getCurrent().then((current) => { windowId = current.id; }).catch(() => undefined);
    const onActivated = (info?: { tabId?: number; windowId?: number }) => {
      const bound = boundTabRef.current;
      if (bound === null || info?.tabId === undefined || info.tabId === bound) return;
      if (windowId !== undefined && info.windowId !== undefined && info.windowId !== windowId) return;
      resetToStartRef.current();
    };
    chrome.tabs.onActivated?.addListener(onActivated);
    return () => chrome.tabs.onActivated?.removeListener(onActivated);
  }, []);

  // While selection translation is on, hold a port to the tab: it reports each selection, and the
  // translation goes back to the page's tooltip. Closing the panel drops the port and ends the mode.
  const translateSelectedRef = useRef<(id: number, text: string) => void>(() => undefined);
  useEffect(() => {
    if (!selectionMode) return;
    let port: chrome.runtime.Port | null = null;
    let cancelled = false;
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (cancelled || tab?.id === undefined) return;
      boundTabRef.current = tab.id;
      port = chrome.tabs.connect(tab.id, { name: SELECTION_PORT });
      const held = port;
      modePorts.current.add(held);
      port.onMessage.addListener((message: SelectionEvent) => {
        if (message.type === "selected") translateSelectedRef.current(message.id, message.text);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        modePorts.current.delete(held);
        if (cancelled) return;
        setSelectionMode(false);
        reportDroppedPort("ページとの接続が切れたため、選択範囲翻訳を終了しました。");
      });
    })().catch((caught: unknown) => {
      setSelectionMode(false);
      setError(errorMessage(caught));
    });
    return () => {
      cancelled = true;
      if (port) modePorts.current.delete(port);
      port?.disconnect();
    };
  }, [selectionMode]);

  // While page select mode is on, hold a port to the tab. The page reports clicks on
  // translated text through it; closing the panel drops the port and ends the mode.
  useEffect(() => {
    if (!pagePick) return;
    let port: chrome.runtime.Port | null = null;
    let cancelled = false;
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (cancelled || tab?.id === undefined) return;
      const zoom = await chrome.tabs.getZoom(tab.id).catch(() => 1);
      if (cancelled) return;
      boundTabRef.current = tab.id;
      port = chrome.tabs.connect(tab.id, { name: PAGE_PICK_PORT });
      const held = port;
      modePorts.current.add(held);
      port.onMessage.addListener((message: PagePickEvent) => {
        if (message.type === "exit") setPagePick(false);
        else if (message.type === "picked") void revealPicked(message.segmentId);
        else if (message.type === "added") void addFromPage(message.segment, message.followingIds);
      });
      port.onDisconnect.addListener(() => {
        modePorts.current.delete(held);
        if (cancelled) return;
        setPagePick(false);
        reportDroppedPort("ページとの接続が切れたため、ページ選択を終了しました。");
      });
      port.postMessage({ type: "targets", targets: pickable, zoom, trigger: settings.pageSelectTrigger } satisfies PagePickRequest);
    })().catch((caught: unknown) => {
      setPagePick(false);
      setError(errorMessage(caught));
    });
    return () => {
      cancelled = true;
      if (port) modePorts.current.delete(port);
      port?.disconnect();
    };
    // pickableKey captures every change to the targets.
  }, [pagePick, pickableKey, settings.pageSelectTrigger]);

  /**
   * Text without a translated card was clicked or selected on the page: add a card in
   * page order (or reuse the hidden one), translate it with DeepL and link it.
   */
  async function addFromPage(segment: CandidateSegment, followingIds: string[]): Promise<void> {
    const generation = generationRef.current;
    const existing = entriesRef.current.find((entry) => entry.id === segment.id);
    if (existing && (existing.state === "translated" || existing.reason === ADDING)) {
      await revealPicked(existing.id);
      return;
    }
    const entry: TranslationEntry = { ...segment, state: "pending", reason: ADDING, uncertain: false };
    const following = new Set(followingIds);
    const current = entriesRef.current;
    let next: TranslationEntry[];
    if (existing) {
      next = current.map((item) => item.id === entry.id ? entry : item);
    } else {
      const at = current.findIndex((item) => following.has(item.id));
      next = at < 0 ? [...current, entry] : [...current.slice(0, at), entry, ...current.slice(at)];
    }
    entriesRef.current = next;
    setEntries(next);
    setError("");
    await nextPaint();
    await revealPicked(entry.id);

    try {
      // This runs from the port listener, so read the current settings through the ref.
      const result = await translateSegmentsWith([entry], currentSettings());
      // A new scan reuses segment ids; never let this result land on its cards.
      if (generation !== generationRef.current) return;
      const translation = result.translations.find((item) => item.id === entry.id);
      if (!translation) throw new Error("翻訳結果と文章の対応が取れませんでした。");
      const done = entriesRef.current.map((item) => item.id === entry.id ? { ...entry, ...translation, state: "translated" as const, reason: undefined } : item);
      entriesRef.current = done;
      setEntries(done);
      if (settingsRef.current.displayMode === "inline" && !entry.partial) await applyInline(done);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(caught));
      setEntries((items) => items.map((item) => item.id === entry.id ? { ...item, state: "review", reason: "翻訳に失敗しました。再試行できます。" } : item));
    }
  }

  /** A source was clicked on the page: bring its card to the middle of the list and draw the connector. */
  async function revealPicked(segmentId: string): Promise<void> {
    const index = visibleRef.current.findIndex((entry) => entry.id === segmentId);
    if (index < 0) return;
    setListFolded(false);
    setSelectedId(segmentId);
    setError("");
    // Wait for the selection to render, so the connector-follow effect sees the scroll.
    await nextPaint();
    const card = document.querySelector<HTMLElement>(`[data-entry-id="${segmentId}"]`);
    if (!card) return;
    // Glide the card to the middle of the list; the connector follows it while it moves.
    const delta = scrollCardIntoView(card, true);
    // Without a known panel position the connector aims at the page's middle, which is
    // where the centered card is too.
    const current = anchorFor(card, panelTop.top());
    await holdPresence();
    await sendMessage({
      type: "FOCUS_SEGMENT",
      segmentId,
      anchor: current && { screenY: current.screenY - delta },
      label: String(index + 1),
      color: entryColor(index),
      scroll: false,
    }).catch((caught: unknown) => setError(errorMessage(caught)));
  }

  const translatedCount = useMemo(() => visibleEntries.filter((entry) => entry.state === "translated").length, [visibleEntries]);

  async function persistSettings(next: ExtensionSettings): Promise<void> {
    setSettings(next);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  }

  /**
   * Resolves true once the current data-use consent is on record, asking for it first
   * if needed. Page translation and the writing check both go through here.
   */
  async function ensureConsent(): Promise<boolean> {
    const consent = await chrome.storage.local.get(DATA_USE_CONSENT_KEY);
    if (consent[DATA_USE_CONSENT_KEY] === DATA_USE_CONSENT_VERSION) return true;
    consentResolver.current?.(false);
    setConsentOpen(true);
    return new Promise((resolve) => { consentResolver.current = resolve; });
  }

  /** Turning "translate as I select" on sends the reader's selections to DeepL, so it needs the consent first. */
  async function changeSelectionAuto(enabled: boolean): Promise<void> {
    if (enabled && !(await ensureConsent())) return;
    await persistSettings({ ...settingsRef.current, selectionAutoTranslate: enabled });
  }

  async function answerConsent(agreed: boolean): Promise<void> {
    if (agreed) await chrome.storage.local.set({ [DATA_USE_CONSENT_KEY]: DATA_USE_CONSENT_VERSION });
    setConsentOpen(false);
    consentResolver.current?.(agreed);
    consentResolver.current = null;
  }

  /**
   * Back to the start screen: the page these results belong to was left (navigated away, reloaded,
   * changed its route or closed). Results still on their way from that page are dropped.
   */
  function resetToStart(): void {
    generationRef.current += 1;
    entriesRef.current = [];
    setEntries([]);
    setBusy(false);
    setError("");
    setStatus(INITIAL_STATUS);
    setPageTitle("");
    pageTitleRef.current = "";
    pageTextRef.current = "";
    setPageUrl("");
    setSelectedId(null);
    setListFolded(false);
    setDroppedCount(0);
    setCacheNote(null);
    setPickMode("off");
    setWatchTabId(null);
    boundTabRef.current = null;
    // Lets every page this panel drew on remove its connector and tooltip.
    dropPresence();
  }
  resetToStartRef.current = resetToStart;

  /**
   * A mode's port dropped: say so, unless the page just went away (then the panel is back at its
   * start screen and there is nothing to explain).
   */
  function reportDroppedPort(message: string): void {
    const generation = generationRef.current;
    window.setTimeout(() => { if (generation === generationRef.current) setError(message); }, 250);
  }

  /** Resolves true once the page was scanned, so page select mode can start. */
  async function startTranslation(fresh = false): Promise<boolean> {
    // Straight from the click: the first use of Chrome's translator downloads its model, which
    // Chrome allows only right after a click. The translator is kept for the rest of the run.
    prepareChromeTranslator();
    // Whether Jev's key is registered decides whether Jev is used: know it before going on.
    if (!providerStatusRef.current) {
      const status = await sendMessage<ProviderStatus>({ type: "CHECK_PROVIDERS" }).catch(() => null);
      providerStatusRef.current = status;
      setProviderStatus(status);
    }
    return await consentForPage() ? runTranslation(fresh) : false;
  }

  /** Starts creating Chrome's translator while the click still counts; errors show up when it is used. */
  function prepareChromeTranslator(): void {
    if (currentSettings().translationProvider !== "chrome") return;
    setDownloadProgressListener((percent) => setStatus(`Chromeの翻訳モデルをダウンロードしています… ${percent}%`));
    getChromeTranslator(currentSettings().targetLanguage).catch(() => undefined);
  }

  /** Page translation sends text out unless Chrome translates and Jev is off: then nothing leaves this device. */
  async function consentForPage(): Promise<boolean> {
    const current = currentSettings();
    return current.translationProvider === "chrome" && !current.useJev ? true : ensureConsent();
  }

  /** Selection translation sends the text to DeepL or Claude; Chrome's translator keeps it on this device. */
  async function consentForSelection(): Promise<boolean> {
    return currentSettings().translationProvider === "chrome" ? true : ensureConsent();
  }

  commandRef.current = (command) => void runCommand(command);
  async function runCommand(command: PanelCommand): Promise<void> {
    setSettingsOpen(false);
    setView("translate");
    if (command === "translate-selection") {
      if (!consentOpen) await translateCurrentSelection();
      return;
    }
    if (busy || consentOpen) return;
    if (command === "translate-page") {
      await startTranslation();
    } else if (scanned) {
      setPagePick((on) => !on);
    } else if (await startTranslation()) {
      setPagePick(true);
    }
  }

  /** Translations of selections already made, so selecting the same text again costs nothing. */
  const selectionCache = useRef(new Map<string, string>());
  translateSelectedRef.current = (id, text) => void translateSelected(id, text);

  /** Translates selected text and hands the result to the page's tooltip (`id` names the tooltip). */
  async function translateSelected(id: number, text: string): Promise<void> {
    const current = currentSettings();
    const report = (result: { text?: string; note?: string; error?: string; by?: string }) =>
      sendMessage({ type: "SELECTION_RESULT", id, ...result }).catch(() => undefined);
    if (isInTargetLanguage(text, current.targetLanguage)) {
      await report({ note: `選択した文章は、すでに${current.targetLanguage === "JA" ? "日本語" : "英語"}です。` });
      return;
    }
    const targetLang: ComposeLanguage = current.targetLanguage === "JA" ? "JA" : current.englishVariant;
    const by = current.translationProvider === "chrome" ? "Chrome" : undefined;
    const key = `${current.translationProvider}\n${targetLang}\n${text}`;
    const known = selectionCache.current.get(key);
    if (known !== undefined) {
      await report({ text: known, by });
      return;
    }
    try {
      const result = current.translationProvider === "chrome"
        ? { text: (await translateWithChrome([text], current.targetLanguage))[0] ?? "" }
        : await sendMessage<{ text: string }>({ type: "TRANSLATE_SELECTION", text, targetLang });
      selectionCache.current.set(key, result.text);
      // Keep the newest 50; a Map iterates in insertion order.
      if (selectionCache.current.size > 50) selectionCache.current.delete(selectionCache.current.keys().next().value as string);
      await report({ text: result.text, by });
    } catch (caught) {
      await report({ error: errorMessage(caught) });
    }
  }

  /** The shortcut: translate whatever is selected on the page right now, once. */
  async function translateCurrentSelection(): Promise<void> {
    try {
      // While the panel is connected, closing it also removes the tooltip it leaves in the page.
      await holdPresence();
      const read = await sendMessage<ReadSelectionResult>({ type: "READ_SELECTION" });
      if (read.empty) return;
      if (!(await consentForSelection())) {
        await sendMessage({ type: "SELECTION_RESULT", id: read.id, note: "データ送信に同意されなかったため、翻訳しませんでした。" }).catch(() => undefined);
        return;
      }
      await translateSelected(read.id, read.text);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function toggleSelectionMode(): Promise<void> {
    if (selectionMode) {
      setSelectionMode(false);
      return;
    }
    setError("");
    prepareChromeTranslator();
    if (await consentForSelection()) setSelectionMode(true);
  }

  async function loadShortcuts(): Promise<void> {
    const commands = await chrome.commands.getAll().catch(() => []);
    setShortcuts(Object.fromEntries(commands.flatMap((command) => isPanelCommand(command.name) ? [[command.name, command.shortcut ?? ""]] : [])));
  }

  /** Title and main text of the open page, as DeepL context for the writing check. */
  async function getPageContext(): Promise<string> {
    const page = await sendMessage<{ title: string; text: string }>({ type: "PAGE_TEXT" });
    return [page.title, page.text].filter(Boolean).join("\n\n");
  }

  /** With `fresh`, the cache is ignored (but still updated): translate the page again from scratch. */
  async function runTranslation(fresh = false): Promise<boolean> {
    const settings = currentSettings();
    generationRef.current += 1;
    const generation = generationRef.current;
    let scannedPage = false;
    // True once a newer run started or the panel went back to its start screen: this run's results are not wanted.
    const stale = () => generation !== generationRef.current;
    setBusy(true);
    setError("");
    // A list the reader was already reading stays open; otherwise "in the page" shows the translations only there.
    const listShowing = entriesRef.current.length > 0;
    setListFolded((folded) => settings.displayMode === "inline" && (folded || !listShowing));
    setEntries([]);
    setDroppedCount(0);
    setSelectedId(null);
    // The results are cleared, so the modes that work on them end too, and the old page loses its connector.
    setPickMode("off");
    dropPresence();
    setCacheNote(null);
    setStatus("ページの文章を調べています…");
    try {
      await sendMessage({ type: "RESTORE_PAGE" }).catch(() => undefined);
      const page = await sendMessage<ScanResult>({ type: "SCAN_ACTIVE_TAB" });
      if (stale()) return false;
      const [scannedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      if (stale()) return false;
      boundTabRef.current = scannedTab?.id ?? null;
      setWatchTabId(scannedTab?.id ?? null);
      setPageTitle(page.title);
      pageTitleRef.current = page.title;
      setPageUrl(new URL(page.url).hostname);
      scannedPage = true;
      const candidates = page.segments.filter((segment) => !isInTargetLanguage(segment.sourceText, settings.targetLanguage));
      setDroppedCount(page.excludedCount + page.segments.length - candidates.length);
      if (candidates.length === 0) {
        setStatus("翻訳が必要な本文が見つかりませんでした。");
        return generation === generationRef.current;
      }

      // A page seen a few hours ago: if its text is the same, take Jev's verdicts and the translations
      // from the cache and call nothing. If it changed, Jev looks at the whole page again (its
      // verdicts depend on the page as a whole), but translations of unchanged texts are still reused.
      const useCache = settings.cacheEnabled;
      const hashes = useCache ? await Promise.all(candidates.map((segment) => hashText(segment.sourceText))) : [];
      const cacheKey = pageCacheKey(page.url, settings.targetLanguage, settings.useJev, settings.translationProvider);
      const store = useCache ? await loadCacheStore() : emptyCache();
      if (stale()) return false;
      const cached = useCache && !fresh ? findPage(store, cacheKey, settings.cacheTtlHours, Date.now()) : null;
      const unchanged = cached !== null && isUnchanged(cached, hashes);

      // Without Jev, everything the local filters kept is translated. Comparing the two
      // settings on the same page shows exactly what Jev removes.
      let decisions: DecisionResult["decisions"];
      if (cached && unchanged) {
        decisions = candidates.map((segment, index) => {
          const known = cached.decisions[hashes[index] as string];
          return { id: segment.id, decision: known?.d ?? "translate", confidence: known?.c ?? 1 };
        });
      } else if (settings.useJev) {
        setStatus(`本文の${candidates.length}件をJevが確認しています…`);
        ({ decisions } = await sendMessage<DecisionResult>({
          type: "CLASSIFY_CANDIDATES",
          segments: candidates,
          targetLanguage: settings.targetLanguage,
          pageTitle: page.title,
          mainContentDetected: page.mainContentDetected,
        }));
        if (stale()) return false;
      } else {
        decisions = candidates.map((segment) => ({ id: segment.id, decision: "translate" as const, confidence: 1 }));
      }
      const byId = new Map(decisions.map((decision) => [decision.id, decision]));
      const next: TranslationEntry[] = candidates.map((segment) => {
        const decision = byId.get(segment.id);
        // Jev's "review" means plausible content: translate it too, and flag it on the card.
        // A "skip" on a readable sentence of the main content, still in the source
        // language, is more likely a misjudged page type than chrome: translate and flag it.
        const skipped = decision?.decision === "skip" && !isMainProse(segment, settings.targetLanguage);
        const state: SegmentState = skipped ? "skipped" : "pending";
        return { ...segment, state, uncertain: decision?.decision !== "translate" && state === "pending" };
      });
      const hashById = new Map(candidates.map((segment, index) => [segment.id, hashes[index] ?? ""]));
      const pending = next.filter((entry) => entry.state === "pending");
      pageTextRef.current = pending.map((entry) => entry.sourceText).join("\n").slice(0, CLAUDE_CONTEXT_CHARS);
      const toTranslate: TranslationEntry[] = [];
      let reused = 0;
      for (const entry of pending) {
        const hit = cached?.translations[hashById.get(entry.id) ?? ""];
        if (hit) {
          Object.assign(entry, { translatedText: hit.t, translatedHtml: hit.h ?? hit.t, state: "translated", reason: undefined });
          reused += 1;
        } else {
          toTranslate.push(entry);
        }
      }
      setEntries(next);
      if (cached && reused > 0) setCacheNote({ savedAt: cached.savedAt, reused, total: pending.length, unchanged });
      if (toTranslate.length > 0) {
        setStatus(`${toTranslate.length}件を翻訳しています…`);
        try {
          const translated = await requestTranslations(toTranslate);
          if (stale()) return false;
          for (const result of translated) {
            const entry = next.find((item) => item.id === result.id);
            if (entry) Object.assign(entry, result, { state: "translated", reason: undefined });
          }
        } catch (caught) {
          if (stale()) return false;
          const message = errorMessage(caught);
          setError(message);
          for (const entry of toTranslate) {
            const current = next.find((item) => item.id === entry.id);
            if (current) Object.assign(current, { state: "review", reason: "翻訳に失敗しました。再試行できます。" });
          }
        }
      }

      if (useCache && !stale()) {
        await saveToCache(cacheKey, cached, unchanged, hashes, candidates, byId, next).catch(() => undefined);
      }
      if (stale()) return false;

      const finalEntries = [...next];
      setEntries(finalEntries);
      const shown = finalEntries.filter((entry) => entry.state !== "skipped").length;
      const mode = settings.useJev ? "" : "（Jevなし）";
      setStatus(shown > 0 ? `本文の${shown}件を表示しています。${mode}` : `翻訳が必要な本文が見つかりませんでした。${mode}`);
      if (settings.displayMode === "inline") await applyInline(finalEntries);
    } catch (caught) {
      if (!stale()) {
        setError(errorMessage(caught));
        setStatus("処理を完了できませんでした。");
      }
    } finally {
      if (!stale()) setBusy(false);
    }
    return scannedPage && !stale();
  }

  async function loadCacheStore(): Promise<CacheStore> {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    return readCache(stored[CACHE_KEY]);
  }

  /**
   * Remembers this run for the page. When nothing changed only the last-used time moves (the
   * lifetime keeps counting from the first translation); otherwise the page is saved anew.
   */
  async function saveToCache(
    key: string,
    cached: CachedPage | null,
    unchanged: boolean,
    hashes: string[],
    candidates: CandidateSegment[],
    byId: Map<string, { decision: Decision; confidence: number }>,
    entries: TranslationEntry[],
  ): Promise<void> {
    const now = Date.now();
    const decisions: CachedPage["decisions"] = {};
    const translations: CachedPage["translations"] = { ...(cached?.translations ?? {}) };
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    candidates.forEach((segment, index) => {
      const hash = hashes[index] as string;
      const decision = byId.get(segment.id);
      decisions[hash] = { d: decision?.decision ?? "translate", c: decision?.confidence ?? 1 };
      const entry = entryById.get(segment.id);
      if (entry?.state === "translated" && entry.translatedText !== undefined) {
        translations[hash] = { t: entry.translatedText, ...(entry.translatedHtml && entry.translatedHtml !== entry.translatedText ? { h: entry.translatedHtml } : {}) };
      }
    });
    const page = buildPage(hashes, decisions, translations, now);
    if (cached && unchanged) page.savedAt = cached.savedAt;
    // Read again: another panel may have saved a different page while this one was translating.
    const latest = await loadCacheStore();
    latest.pages[key] = page;
    await chrome.storage.local.set({ [CACHE_KEY]: prune(latest, settingsRef.current.cacheTtlHours, now) });
  }

  async function refreshCacheInfo(): Promise<void> {
    setCacheInfo(describeCache(await loadCacheStore().catch(() => emptyCache())));
  }

  async function clearCache(): Promise<void> {
    await chrome.storage.local.remove(CACHE_KEY);
    setCacheInfo({ pages: 0, chars: 0 });
    setCacheNote(null);
  }

  /** Translates with the chosen service: DeepL or Claude through the service worker, or Chrome's translator right here. */
  async function translateSegmentsWith(segments: CandidateSegment[], current: ExtensionSettings): Promise<TranslationResult> {
    if (current.translationProvider !== "chrome") {
      return sendMessage<TranslationResult>({ type: "TRANSLATE_SEGMENTS", segments, targetLanguage: current.targetLanguage, pageTitle: pageTitleRef.current, pageText: pageTextRef.current || undefined });
    }
    setDownloadProgressListener((percent) => setStatus(`Chromeの翻訳モデルをダウンロードしています… ${percent}%`));
    const texts = await translateWithChrome(segments.map((segment) => segment.sourceText), current.targetLanguage);
    return { translations: segments.map((segment, index) => ({ id: segment.id, translatedText: texts[index] ?? "", translatedHtml: textToHtml(texts[index] ?? "") })) };
  }

  async function requestTranslations(segments: CandidateSegment[]): Promise<Array<TranslationEntry & { translatedText: string; translatedHtml: string; state: "translated" }>> {
    const result = await translateSegmentsWith(segments, currentSettings());
    return result.translations.map((translation) => {
      const source = segments.find((segment) => segment.id === translation.id);
      if (!source) throw new Error("翻訳結果と文章の対応が取れませんでした。");
      return { ...source, ...translation, state: "translated" as const };
    });
  }

  async function translateOne(entry: TranslationEntry): Promise<void> {
    const generation = generationRef.current;
    setError("");
    setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, state: "error", reason: "翻訳中…" } : item));
    try {
      const [translated] = await requestTranslations([entry]);
      // The page was left (or translated again) meanwhile: this card no longer exists.
      if (generation !== generationRef.current) return;
      const next = entries.map((item) => item.id === entry.id ? translated : item);
      setEntries(next);
      if (settings.displayMode === "inline") await applyInline(next);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(caught));
      setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, state: "review", reason: "翻訳に失敗しました。" } : item));
    }
  }

  async function changeMode(mode: DisplayMode): Promise<void> {
    const next = { ...settings, displayMode: mode };
    await persistSettings(next);
    if (mode === "inline") await applyInline(entries);
    else {
      setListFolded(false);
      await sendMessage({ type: "RESTORE_PAGE" }).catch((caught: unknown) => setError(errorMessage(caught)));
    }
  }

  async function applyInline(current: TranslationEntry[]): Promise<void> {
    const ready = current.filter((entry) => entry.state === "translated" && !entry.partial);
    if (ready.length === 0) return;
    const result = await sendMessage<{ applied: number }>({ type: "APPLY_TRANSLATIONS", entries: ready });
    setStatus(`ページ内に${result.applied}件を表示しています。`);
  }

  async function focusEntry(entry: TranslationEntry, index: number, event: ReactMouseEvent<HTMLElement>): Promise<void> {
    setSelectedId(entry.id);
    setError("");
    // Read the click position now: React clears event.currentTarget once this handler awaits.
    const anchor = cardAnchor(event);
    // A card cut off at the top or bottom glides into the middle first; the page then
    // lines the source up with where the card ends up.
    const card = event.currentTarget.closest<HTMLElement>(".entry-card");
    const delta = card ? scrollCardIntoView(card, false) : 0;
    try {
      await holdPresence();
      const result = await sendMessage<{ focused: boolean }>({
        type: "FOCUS_SEGMENT",
        segmentId: entry.id,
        anchor: anchor && { screenY: anchor.screenY - delta },
        label: String(index + 1),
        color: entryColor(index),
      });
      if (!result?.focused) setError("ページが変わったため原文の位置が見つかりません。もう一度翻訳してください。");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function changeDeepLEndpoint(endpoint: DeepLEndpoint): Promise<void> {
    await persistSettings({ ...settings, deeplEndpoint: endpoint });
    await checkProviders();
  }

  async function checkProviders(): Promise<void> {
    setError("");
    try {
      const result = await sendMessage<ProviderStatus>({ type: "CHECK_PROVIDERS" });
      setProviderStatus(result);
    } catch (caught) {
      setProviderStatus(null);
      setError(errorMessage(caught));
    }
  }

  async function saveProviderKeys(): Promise<void> {
    if (!typesafeApiKey.trim() && !deeplApiKey.trim() && !anthropicApiKey.trim()) {
      setError("保存するAPIキーを入力してください。");
      return;
    }
    setSavingKeys(true);
    setError("");
    try {
      const result = await sendMessage<ProviderStatus>({ type: "SAVE_PROVIDER_KEYS", keys: { typesafeApiKey, deeplApiKey, anthropicApiKey } });
      setProviderStatus(result);
      setTypesafeApiKey("");
      setDeeplApiKey("");
      setAnthropicApiKey("");
      setStatus("APIキーをこのChromeセッション中だけ保存しました。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingKeys(false);
    }
  }

  async function clearProviderKeys(): Promise<void> {
    setError("");
    try {
      const result = await sendMessage<ProviderStatus>({ type: "CLEAR_PROVIDER_KEYS" });
      setProviderStatus(result);
      setTypesafeApiKey("");
      setDeeplApiKey("");
      setAnthropicApiKey("");
      setStatus("保存中のAPIキーを削除しました。");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const folded = listFolded && settings.displayMode === "inline";
  const sourceLang = settings.targetLanguage === "JA" ? "en" : "ja";
  const progress = visibleEntries.length > 0 ? translatedCount / visibleEntries.length : 0;

  return (
    <main className="panel-shell">
      {/* Everything up to the status line stays put while the results scroll. */}
      <div className="panel-top" ref={panelTopRef}>
      <header className="panel-header">
        <img className="brand-mark" src="/icons/icon48.png" alt="" width="32" height="32" />
        <div className="brand-copy">
          <p className="eyebrow">Page Translate</p>
          <h1>ページ翻訳</h1>
        </div>
        <button
          className={`icon-button ${settingsOpen ? "active" : ""}`}
          type="button"
          aria-label={settingsOpen ? "翻訳画面に戻る" : "設定を開く"}
          aria-pressed={settingsOpen}
          onClick={() => { const open = !settingsOpen; setSettingsOpen(open); if (open) { setOpenHelp(new Set()); void checkProviders(); void loadShortcuts(); void refreshCacheInfo(); } }}
        >
          <Icon name="settings" />
        </button>
      </header>

      {!settingsOpen && (
        <>
          <div className="view-tabs" role="tablist" aria-label="機能">
            <button type="button" role="tab" aria-selected={view === "translate"} className={view === "translate" ? "active" : ""} onClick={() => setView("translate")}>
              <Icon name="split" />ページ翻訳
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "compose"}
              aria-disabled={composeLocked}
              className={`${view === "compose" ? "active" : ""} ${composeLocked ? "locked" : ""}`}
              title={composeLocked ? COMPOSE_NEEDS_DEEPL : undefined}
              onClick={() => (composeLocked ? setComposeHint(true) : setView("compose"))}
            >
              <Icon name="pen" />英作文
            </button>
          </div>
          {composeLocked && composeHint && (
            <p className="compose-lock-note" role="status">
              {COMPOSE_NEEDS_DEEPL}
              <button type="button" className="text-button" onClick={() => { setComposeHint(false); setSettingsOpen(true); }}><Icon name="key" />設定を開く</button>
            </p>
          )}
          {view === "translate" && (
          <section className="controls">
            <div className="page-context">
              <span className="favicon-dot" aria-hidden="true">{pageUrl ? pageUrl.replace(/^www\./, "").slice(0, 1).toUpperCase() : <Icon name="inline" />}</span>
              <div className="page-context-text">
                <strong title={pageTitle || "現在のページ"}>{pageTitle || "現在のページ"}</strong>
                <small>{pageUrl || "タブを選んで翻訳を開始"}</small>
              </div>
              <label className="language-control">
                <span className="sr-only">翻訳先</span>
                <select
                  value={settings.targetLanguage}
                  onChange={(event) => void persistSettings({ ...settings, targetLanguage: event.target.value as TargetLanguage })}
                >
                  <option value="JA">日本語へ</option>
                  <option value="EN">英語へ</option>
                </select>
              </label>
            </div>

            <div className="mode-switch" role="group" aria-label="翻訳の表示方法">
              <button type="button" className={settings.displayMode === "source-panel" ? "active" : ""} aria-pressed={settings.displayMode === "source-panel"} onClick={() => void changeMode("source-panel")}>
                <Icon name="split" />原文＋訳文
              </button>
              <button type="button" className={settings.displayMode === "inline" ? "active" : ""} aria-pressed={settings.displayMode === "inline"} onClick={() => void changeMode("inline")}>
                <Icon name="inline" />ページ内
              </button>
            </div>

            <button className="button primary block translate-button" type="button" onClick={() => void startTranslation()} disabled={busy} aria-busy={busy} title={withShortcut("このページを翻訳", shortcuts["translate-page"])}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="translate" />}
              {busy ? "翻訳しています…" : "このページを翻訳"}
              {!busy && shortcuts["translate-page"] && <kbd className="button-kbd">{shortcuts["translate-page"]}</kbd>}
            </button>

            <div className="tool-row">
              <button
                type="button"
                className={`pick-toggle ${pagePick ? "active" : ""}`}
                aria-pressed={pagePick}
                disabled={!scanned}
                title={scanned ? withShortcut(settings.pageSelectTrigger === "hover" ? "ページ上の本文にマウスを乗せて、対応する訳文を表示します" : "ページ上の本文をクリックして、対応する訳文を表示します", shortcuts["toggle-page-pick"]) : "先に「このページを翻訳」を実行してください"}
                onClick={() => setPagePick((on) => !on)}
              >
                <Icon name="pointer" />ページ選択
                {shortcuts["toggle-page-pick"] && <kbd className="button-kbd">{shortcuts["toggle-page-pick"]}</kbd>}
              </button>
              <button
                type="button"
                className={`pick-toggle selection-toggle ${selectionMode ? "active" : ""}`}
                aria-pressed={selectionMode}
                title={withShortcut("ページ上で選んだ文章を、その場で翻訳します（ショートカットは選択中の文章を1回だけ翻訳）", shortcuts["translate-selection"])}
                onClick={() => void toggleSelectionMode()}
              >
                <Icon name="selection" />選択範囲翻訳
                {shortcuts["translate-selection"] && <kbd className="button-kbd">{shortcuts["translate-selection"]}</kbd>}
              </button>
            </div>
            {selectionMode && (
              <p className="pick-note" role="status"><span className="live-dot" aria-hidden="true" />ページ上で文章を選ぶと、その場に訳を表示します。パネルを閉じるとオフになります</p>
            )}

          </section>
          )}
        </>
      )}
      </div>

      {settingsOpen ? (
        <section className="settings-page" aria-labelledby="settings-title">
          <button className="text-button settings-back" type="button" onClick={() => setSettingsOpen(false)}>
            <Icon name="back" />翻訳画面に戻る
          </button>
          <p className="eyebrow">Settings</p>
          <h2 id="settings-title">設定</h2>

          <h3 className="settings-section" id="theme-label">表示テーマ</h3>
          <div className="mode-switch theme-switch" role="radiogroup" aria-labelledby="theme-label">
            {themeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.theme === option.value}
                className={settings.theme === option.value ? "active" : ""}
                onClick={() => void persistSettings({ ...settings, theme: option.value })}
              >
                <Icon name={option.icon} />{option.label}
              </button>
            ))}
          </div>

          <SettingHeading id="shortcut-label" label="キーボードショートカット" help={help}>
            Chromeの拡張機能のショートカット設定で変更できます。ほかの拡張機能と重なっているキーは割り当てられず「未設定」になります。
          </SettingHeading>
          <dl className="shortcut-list">
            {shortcutRows.map((row) => (
              <div key={row.command}>
                <dt>{row.label}</dt>
                <dd>{shortcuts[row.command] ? <kbd>{shortcuts[row.command]}</kbd> : <span className="badge missing">未設定</span>}</dd>
              </div>
            ))}
          </dl>
          <button className="text-button" type="button" onClick={() => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}>
            <Icon name="settings" />ショートカットを変更
          </button>

          <SettingHeading id="provider-label" label="翻訳に使うサービス" help={help}>
            <b>Chrome内蔵</b>：Chromeに内蔵の翻訳で、この端末の中で翻訳します。APIキーは不要で、文章は外部へ送りません（Jevを使う場合、本文候補はJevへ送ります）。初回は翻訳モデルのダウンロードがあります。ページ内表示では、リンクなどの書式が外れます。パソコン版のChrome 138以降で使えます。<br />
            <b>DeepL</b>：DeepLで翻訳します。DeepLのAPIキーが必要です。<br />
            <b>Claude</b>：AnthropicのClaudeが、ページ全体の流れを見て翻訳します。用語や文体がそろいやすい一方、DeepLより時間がかかります。ClaudeのAPIキーが必要です（Claude Maxなどのプランに付く月額APIクレジットも使えます）。<br />
            英作文は、どれを選んでもDeepLを使います。
          </SettingHeading>
          <div className="mode-switch" role="radiogroup" aria-labelledby="provider-label">
            {([
              { value: "deepl", label: "DeepL" },
              { value: "claude", label: "Claude" },
              { value: "chrome", label: "Chrome内蔵" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={applied.translationProvider === option.value}
                className={applied.translationProvider === option.value ? "active" : ""}
                disabled={option.value === "chrome" && !chromeSupported}
                onClick={() => void persistSettings({ ...settings, translationProvider: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          {!chromeSupported && (
            <p className="setting-alert"><Icon name="alert" />このChromeでは内蔵の翻訳を使えないため、DeepLで翻訳します（パソコン版のChrome 138以降が必要です）。</p>
          )}

          <SettingHeading id="jev-label" label="翻訳する本文の判定" help={help}>
            <b>Jevを使う</b>：ページ側のルールで除いた残りをTypeSafe Jevが確認し、本文だけを翻訳します。JevのAPIキーが必要です。<br />
            <b>Jevを使わない</b>：ページ側のルールで除いた残りをすべて翻訳します。
          </SettingHeading>
          <div className="mode-switch" role="radiogroup" aria-labelledby="jev-label">
            {jevOptions.map((option) => (
              <button
                key={String(option.value)}
                type="button"
                role="radio"
                aria-checked={settings.useJev === option.value}
                className={settings.useJev === option.value ? "active" : ""}
                onClick={() => void persistSettings({ ...settings, useJev: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          {settings.useJev && providerStatus && !providerStatus.providers.jev && (
            <p className="setting-alert"><Icon name="alert" />JevのAPIキーが未登録のため、いまはJevを使わずに翻訳します。</p>
          )}

          <SettingHeading id="selection-auto-label" label="選択したら自動で翻訳" help={help}>
            オンにすると、パネルを閉じていても、ページで文章を選ぶだけで、その場のツールチップに翻訳を表示します。翻訳画面の「選択範囲翻訳」ボタンは、パネルを開いているあいだだけ動く別のスイッチで、どちらかがオンなら翻訳します。ページ上の右クリックメニューからも切り替えられます。拡張機能を更新した直後は、開いていたページを再読み込みしてください。
          </SettingHeading>
          <div className="mode-switch" role="radiogroup" aria-labelledby="selection-auto-label">
            {([true, false] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                role="radio"
                aria-checked={settings.selectionAutoTranslate === value}
                className={settings.selectionAutoTranslate === value ? "active" : ""}
                onClick={() => void changeSelectionAuto(value)}
              >
                {value ? "オン" : "オフ"}
              </button>
            ))}
          </div>

          <SettingHeading id="page-select-label" label="ページ選択の操作" help={help}>
            <b>クリック</b>：「ページ選択」がオンのとき、本文をクリックすると対応する訳文のカードを表示します。翻訳されていない箇所も、クリックで追加して翻訳できます。<br />
            <b>マウスを乗せる</b>：本文にマウスを少し乗せるだけでカードを表示します。クリックはページにそのまま届くので、リンクも押せます。翻訳されていない箇所は、文字を選択して追加します。
          </SettingHeading>
          <div className="mode-switch" role="radiogroup" aria-labelledby="page-select-label">
            {([["click", "クリック"], ["hover", "マウスを乗せる"]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={settings.pageSelectTrigger === value}
                className={settings.pageSelectTrigger === value ? "active" : ""}
                onClick={() => void persistSettings({ ...settingsRef.current, pageSelectTrigger: value })}
              >
                {label}
              </button>
            ))}
          </div>

          <SettingHeading id="cache-label" label="翻訳のキャッシュ" help={help}>
            <b>保存する</b>：翻訳したページの結果を、この端末の拡張機能の中だけに保存し、同じページを開いたときに再利用します。ページの本文が変わっていた部分は翻訳し直します。外部へは送信しません。<br />
            <b>保存しない</b>：翻訳結果を保存せず、保存済みの内容も削除します。
          </SettingHeading>
          <div className="mode-switch" role="radiogroup" aria-labelledby="cache-label">
            {([true, false] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                role="radio"
                aria-checked={settings.cacheEnabled === value}
                className={settings.cacheEnabled === value ? "active" : ""}
                onClick={() => void persistSettings({ ...settings, cacheEnabled: value })}
              >
                {value ? "保存する" : "保存しない"}
              </button>
            ))}
          </div>
          {settings.cacheEnabled && (
            <>
              <label className="field-label" htmlFor="cache-ttl">保存する時間</label>
              <select id="cache-ttl" className="field" value={settings.cacheTtlHours} onChange={(event) => void persistSettings({ ...settings, cacheTtlHours: Number(event.target.value) })}>
                {[...CACHE_TTL_HOURS].sort((a, b) => a - b).map((hours) => <option key={hours} value={hours}>{hours}時間</option>)}
              </select>
            </>
          )}
          {settings.cacheEnabled && (
            <button className="text-button" type="button" onClick={() => void clearCache()} disabled={cacheInfo.pages === 0}>
              <Icon name="trash" />キャッシュを削除（{cacheInfo.pages}ページ）
            </button>
          )}

          <h3 className="settings-section">翻訳サービス</h3>
          <div className={`provider-card ${settings.useJev ? "" : "unused"}`}>
            <div className="provider-card-heading">
              <div><h3>TypeSafe Jev</h3><p>{settings.useJev ? "ページから翻訳する本文を選びます。" : "現在は使わない設定です。"}</p></div>
              <span className={`badge ${providerStatus?.providers.jev ? "ready" : "missing"}`}>{providerStatus?.providers.jev ? "登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="typesafe-api-key">APIキー</label>
            <input id="typesafe-api-key" className="field" type="password" autoComplete="new-password" spellCheck={false} value={typesafeApiKey} onChange={(event) => setTypesafeApiKey(event.target.value)} placeholder={providerStatus?.providers.jev ? "登録済み · 変更時だけ入力" : "TypeSafe JevのAPIキー"} />
          </div>

          <div className={`provider-card ${applied.translationProvider === "claude" ? "" : "unused"}`}>
            <div className="provider-card-heading">
              <div><h3>Claude</h3><p>{applied.translationProvider === "claude" ? "ページの本文を翻訳します。" : "翻訳サービスでClaudeを選ぶと使います。"}</p></div>
              <span className={`badge ${providerStatus?.providers.claude ? "ready" : "missing"}`}>{providerStatus?.providers.claude ? "登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="anthropic-api-key">APIキー</label>
            <input id="anthropic-api-key" className="field" type="password" autoComplete="new-password" spellCheck={false} value={anthropicApiKey} onChange={(event) => setAnthropicApiKey(event.target.value)} placeholder={providerStatus?.providers.claude ? "登録済み · 変更時だけ入力" : "ClaudeのAPIキー（sk-ant-…）"} />
            <p className="field-hint">Claude Consoleで作ったAPIキーです。Claude Max・Teamプランの月額APIクレジットは、Consoleの組織に受け取るとこのキーで使えます。</p>
          </div>

          <div className="provider-card">
            <div className="provider-card-heading">
              <div><h3>DeepL</h3><p>{settings.useJev ? "Jevが選んだ本文を翻訳します。" : "本文を翻訳します。"}</p></div>
              <span className={`badge ${providerStatus?.providers.deepl ? "ready" : "missing"}`}>{providerStatus?.providers.deepl ? "登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="deepl-endpoint">接続先</label>
            <select id="deepl-endpoint" className="field" value={settings.deeplEndpoint} onChange={(event) => void changeDeepLEndpoint(event.target.value as DeepLEndpoint)}>
              <option value="auto">自動（キーから判定）</option>
              <option value="free">無料プラン（api-free.deepl.com）</option>
              <option value="pro">有料プラン（api.deepl.com）</option>
            </select>
            <p className="field-hint">{deeplEndpointHint(settings.deeplEndpoint, providerStatus?.deeplPlan ?? null)}</p>
            <label className="field-label" htmlFor="deepl-api-key">APIキー</label>
            <input id="deepl-api-key" className="field" type="password" autoComplete="new-password" spellCheck={false} value={deeplApiKey} onChange={(event) => setDeeplApiKey(event.target.value)} placeholder={providerStatus?.providers.deepl ? "登録済み · 変更時だけ入力" : "DeepL APIキー"} />
          </div>

          {error && <div className="error-banner" role="alert"><Icon name="alert" />{error}</div>}
          <button className="button primary block" type="button" onClick={() => void saveProviderKeys()} disabled={savingKeys}>
            <Icon name="key" />{savingKeys ? "保存しています…" : "APIキーを保存"}
          </button>
          <button className="text-button danger block" type="button" onClick={() => void clearProviderKeys()} disabled={!providerStatus?.providers.jev && !providerStatus?.providers.deepl && !providerStatus?.providers.claude}>
            <Icon name="trash" />保存中のAPIキーを削除
          </button>
          <p className="note"><Icon name="shield" />キーはメモリ上に保持し、ページ側には渡しません。Chromeを終了または拡張機能を再読み込みすると消えるため、次回は再入力してください。問い合わせ時はTypeSafe Jev、DeepL、Claude（Anthropic）へ直接送信します。</p>
        </section>
      ) : (
        <>
          {/* Kept mounted so drafts survive switching tabs. */}
          <div className="compose-view" hidden={view !== "compose"}>
            <Composer settings={settings} deeplPlan={providerStatus?.deeplPlan ?? null} persistSettings={persistSettings} ensureConsent={ensureConsent} getPageContext={getPageContext} sendMessage={sendMessage} />
          </div>
          {view === "translate" && (<>
          <section className="status-area">
            <div className="status" role="status" aria-live="polite">
              <div className="status-row">
                <span className={`status-dot ${busy ? "busy" : entries.length > 0 ? "done" : ""}`} aria-hidden="true" />
                <span className="status-text">{status}</span>
                {visibleEntries.length > 0 && <b>{translatedCount}/{visibleEntries.length}</b>}
              </div>
              {(busy || visibleEntries.length > 0) && (
                <div className={`progress ${busy && visibleEntries.length === 0 ? "indeterminate" : ""}`} aria-hidden="true">
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              {cacheNote && !busy && (
                <p className="cache-note">
                  <Icon name="restore" />
                  <span>
                    {cacheNote.unchanged
                      ? `${formatAge(Date.now() - cacheNote.savedAt)}の翻訳を再利用しました（翻訳サービスは呼んでいません）。`
                      : `ページが更新されていました。変わっていない${cacheNote.reused}件は${formatAge(Date.now() - cacheNote.savedAt)}の翻訳を再利用し、${cacheNote.total - cacheNote.reused}件を翻訳しました。`}
                  </span>
                  <button type="button" className="text-button" onClick={() => void startTranslation(true)}>再翻訳</button>
                </p>
              )}
            </div>
          </section>

          {error && <div className="error-banner" role="alert"><Icon name="alert" />{error}</div>}

          {visibleEntries.length > 0 || scanned ? (
            <section className="results-section" aria-labelledby="results-title">
              <div className="results-heading">
                <h2 id="results-title">翻訳箇所</h2>
                <span className="count">{visibleEntries.length}</span>
                {settings.displayMode === "inline" && visibleEntries.length > 0 && (
                  <button type="button" className="text-button list-toggle" aria-expanded={!folded} aria-controls="entry-list" onClick={() => setListFolded(!folded)}>
                    {folded ? "一覧を表示" : "一覧を畳む"}
                  </button>
                )}
              </div>
              {folded && visibleEntries.length > 0 && (
                <p className="hidden-note folded-note"><Icon name="inline" />訳文はページ内に表示しています。原文と並べて見たいときは「一覧を表示」を押してください。</p>
              )}
              {pagePick && (
                <p className="pick-note" role="status"><span className="live-dot" aria-hidden="true" />{settings.pageSelectTrigger === "hover"
                  ? "本文にマウスを乗せると訳文を表示。翻訳されていない箇所は文字の選択で追加して翻訳します。Escで終了"
                  : "本文をクリックで訳文を表示。翻訳されていない箇所はクリックか文字の選択で追加して翻訳します。Escで終了"}</p>
              )}
              {hiddenCount > 0 && !folded && (
                <p className="hidden-note"><Icon name="eyeOff" />本文外・翻訳対象外の{hiddenCount}件は表示していません</p>
              )}
              {visibleEntries.length === 0 && !pagePick && (
                <p className="hidden-note">表示できる翻訳箇所はありません。「ページ選択」で本文を選ぶと追加できます。</p>
              )}
              <ol className="entry-list" id="entry-list" hidden={folded}>
                {visibleEntries.map((entry, index) => (
                  <li key={entry.id}>
                    <article data-entry-id={entry.id} className={`entry-card ${selectedId === entry.id ? "selected" : ""} ${entry.state}`} style={{ "--entry-color": entryColor(index) } as React.CSSProperties}>
                      <button className="entry-main" type="button" onClick={(event) => void focusEntry(entry, index, event)} aria-label={`${index + 1}番目：${entry.location}の原文位置へ移動`}>
                        <span className="entry-topline">
                          <span className="entry-number">{index + 1}</span>
                          <span className="entry-location">{entry.location}</span>
                          {entry.state !== "translated" && <span className={`badge ${entry.state}`}>{stateLabel(entry.state)}</span>}
                          {entry.state === "translated" && entry.uncertain && (
                            <span className="badge review" title="Jevの判定があいまいだったため、自動で翻訳しました">要確認</span>
                          )}
                        </span>
                        {entry.state !== "translated" ? (<>
                          <span className="entry-review">{entry.reason ?? "判定を確認してください。"}</span>
                          <span className="entry-source entry-sub" lang={sourceLang}>{entry.sourceText}</span>
                        </>) : settings.displayMode === "inline" ? (<>
                          {/* The page shows the translation already, so the card leads with the original. */}
                          <span className="entry-source entry-lead" lang={sourceLang}>{entry.sourceText}</span>
                          <span className="entry-translation entry-sub">{entry.translatedText}</span>
                        </>) : (<>
                          <span className="entry-translation entry-lead">{entry.translatedText}</span>
                          <span className="entry-source entry-sub" lang={sourceLang}>{entry.sourceText}</span>
                        </>)}
                      </button>
                      {entry.state === "review" && (
                        <button className="review-action" type="button" onClick={() => void translateOne(entry)}>
                          <Icon name="translate" />この文章を翻訳
                        </button>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <section className="empty-state">
              <div className="empty-illustration" aria-hidden="true">
                <span className="sheet source"><i /><i /><i /></span>
                <svg className="empty-connector" viewBox="0 0 56 40"><path d="M2 10 C 28 10, 28 30, 54 30" /><circle cx="2" cy="10" r="2.5" /><circle cx="54" cy="30" r="3.5" /></svg>
                <span className="sheet target"><i /><i /></span>
              </div>
              <h2>本文だけを、原文の位置と結んで翻訳</h2>
              <p>ナビゲーションや広告などを除いた本文を翻訳します。訳文を選ぶと、原文の位置までコネクタで結びます。</p>
              <ol className="steps">
                <li><span>1</span>本文を抽出</li>
                <li><span>2</span>{applied.useJev ? "Jevが翻訳対象を判定" : "ルールで本文を選別"}</li>
                <li><span>3</span>{applied.translationProvider === "chrome" ? "Chromeで翻訳" : applied.translationProvider === "claude" ? "Claudeで翻訳" : "DeepLで翻訳"}</li>
              </ol>
              {applied.translationProvider === "deepl" && providerStatus && !providerStatus.providers.deepl && (
                <p className="setup-hint">
                  はじめに、DeepLのAPIキーを登録してください（TypeSafe Jevは、設定でオフにすれば不要です）。
                  <button type="button" className="text-button" onClick={() => setSettingsOpen(true)}><Icon name="key" />設定でAPIキーを登録</button>
                </p>
              )}
              {applied.translationProvider === "claude" && providerStatus && !providerStatus.providers.claude && (
                <p className="setup-hint">
                  はじめに、ClaudeのAPIキーを登録してください。
                  <button type="button" className="text-button" onClick={() => setSettingsOpen(true)}><Icon name="key" />設定でAPIキーを登録</button>
                </p>
              )}
              {(shortcuts["translate-page"] || shortcuts["toggle-page-pick"]) && (
                <p className="shortcut-hint">
                  {shortcutRows.filter((row) => shortcuts[row.command]).map((row) => (
                    <span key={row.command}>{row.short} <kbd>{shortcuts[row.command]}</kbd></span>
                  ))}
                </p>
              )}
            </section>
          )}

          <footer className="panel-footer">
            <span className="privacy"><Icon name="shield" />{privacySummary(applied)}</span>
            <a className="text-button" href={GUIDE_URL} target="_blank" rel="noreferrer">使い方</a>
            {settings.displayMode === "inline" && translatedCount > 0 && (
              <button type="button" className="text-button" onClick={() => void sendMessage({ type: "RESTORE_PAGE" }).then(() => setStatus("原文に戻しました。")).catch((caught: unknown) => setError(errorMessage(caught)))}>
                <Icon name="restore" />原文に戻す
              </button>
            )}
          </footer>
          </>)}
        </>
      )}
      {consentOpen && (
        <div className="consent-backdrop">
          <section className="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title" aria-describedby="consent-description">
            <span className="consent-icon" aria-hidden="true"><Icon name="shield" /></span>
            <p className="eyebrow">Data use</p>
            <h2 id="consent-title">文章を外部サービスへ送信します</h2>
            <p id="consent-description">ページを翻訳すると、このページから抽出した文章とページタイトルがTypeSafe Jevに送られ、翻訳対象として選ばれた文章が、設定で選んだ翻訳サービス（DeepLまたはClaude）に送られます（設定でJevを使わない場合は、抽出した文章を翻訳サービスにだけ送ります）。Claudeには、ページタイトルと、文脈としてページの本文の一部（最大4,000文字）も送ります。翻訳サービスが「Chrome内蔵」のときは、翻訳はこの端末の中で行い、DeepLやClaudeには送りません。選択範囲翻訳では、選んだ文章がDeepLまたはClaudeにだけ送られます（Chrome内蔵では送りません）。英作文チェックでは、入力した英文と日本語、文脈として使う場合はページのタイトルと本文がDeepLに送られます。APIキーも認証のため各サービスへ送信します。</p>
            <p>送信先はTypeSafe Jev、DeepL、Claude（Anthropic）です。Page Translateの開発者が運営するサーバーには送信しません。個人情報や機密情報を含む文章を翻訳する場合は、利用するAPIプランの条件を確認してください。</p>
            <p className="provider-policy-links"><a href="https://typesafe.ai/legal/privacy-policy" target="_blank" rel="noreferrer">TypeSafeのプライバシー情報</a> · <a href="https://www.deepl.com/en/privacy" target="_blank" rel="noreferrer">DeepLのプライバシー情報</a> · <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noreferrer">Anthropicのプライバシー情報</a></p>
            <div className="consent-actions">
              <button className="button secondary" type="button" onClick={() => void answerConsent(false)}>キャンセル</button>
              <button className="button primary" type="button" onClick={() => void answerConsent(true)}>同意して続ける</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

/** Ports to tabs where this panel has drawn a connector, keyed by tab id. */
const presencePorts = new Map<number, chrome.runtime.Port>();

/**
 * Keeps a port open to the active tab. When the side panel closes the port drops and
 * the page removes its connector; there is no other signal that the panel went away.
 */
async function holdPresence(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const tabId = tab?.id;
  if (tabId === undefined || presencePorts.has(tabId)) return;
  try {
    const port = chrome.tabs.connect(tabId, { name: PANEL_PRESENCE_PORT });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      presencePorts.delete(tabId);
    });
    presencePorts.set(tabId, port);
  } catch {
    // Pages without the content script have no connector to clean up.
  }
}

/** Lets go of every page: each one takes its connector and selection tooltip away. */
function dropPresence(): void {
  for (const port of presencePorts.values()) {
    try { port.disconnect(); } catch { /* already gone */ }
  }
  presencePorts.clear();
}

/** One line, at the foot of the panel, on where page text goes when translating. */
function privacySummary(settings: ExtensionSettings): string {
  if (settings.translationProvider === "chrome") {
    return settings.useJev ? "翻訳時は本文候補をJevへ送信。翻訳はこの端末の中で行います" : "翻訳はこの端末の中で行い、外部へは送信しません";
  }
  const translator = settings.translationProvider === "claude" ? "Claude" : "DeepL";
  return settings.useJev ? `翻訳時は本文候補をJevへ、選ばれた文章を${translator}へ送信` : `翻訳時は本文を${translator}へ送信（Jevは不使用）`;
}

async function sendMessage<T = unknown>(message: ExtensionMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as T | { error?: string };
  if (typeof response === "object" && response !== null && "error" in response && response.error) {
    throw new Error(response.error);
  }
  return response as T;
}

/**
 * Screen position of the clicked card's first line. The content script aligns the
 * source text and the end of the connector to this height.
 */
function cardAnchor(event: ReactMouseEvent<HTMLElement>): FocusAnchor | undefined {
  const card = event.currentTarget.closest<HTMLElement>(".entry-card") ?? event.currentTarget;
  // Real clicks carry screen coordinates; keyboard activation reports 0/0.
  return anchorFor(card, event.detail > 0 ? event.screenY - event.clientY : panelTop.top());
}

function anchorFor(card: HTMLElement, panelTop: number | null): FocusAnchor | undefined {
  if (panelTop === null) return undefined;
  const rect = card.getBoundingClientRect();
  // Once the card leaves the panel, pin the connector to the nearest edge.
  const y = rect.top + Math.min(rect.height / 2, 22);
  return { screenY: panelTop + Math.min(Math.max(y, 8), window.innerHeight - 8) };
}

/**
 * Scrolls the panel so the card sits in the middle of the list area (between the sticky
 * heading and the footer), smoothly unless the reader prefers reduced motion. With
 * `always` false, a card already fully in view stays put. Returns how far the card will
 * move up, so callers can aim the connector at its final position.
 */
function scrollCardIntoView(card: HTMLElement, always: boolean): number {
  const heading = document.querySelector<HTMLElement>(".results-heading");
  // The heading sticks while the list scrolls; measure where it will be, not where it is.
  const top = (heading ? parseFloat(getComputedStyle(heading).top) + heading.offsetHeight : 0) + 10;
  const bottom = (document.querySelector(".panel-footer")?.getBoundingClientRect().top ?? window.innerHeight) - 10;
  const rect = card.getBoundingClientRect();
  if (!always && rect.top >= top && rect.bottom <= bottom) return 0;
  const offset = rect.height > bottom - top ? rect.top - top : rect.top + rect.height / 2 - (top + bottom) / 2;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const target = Math.min(Math.max(window.scrollY + offset, 0), Math.max(max, 0));
  const delta = target - window.scrollY;
  if (Math.abs(delta) < 1) return 0;
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: target, behavior: smooth ? "smooth" : "instant" });
  return delta;
}

const ADDING = "翻訳しています…";

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

type HelpState = { isOpen: (id: string) => boolean; toggle: (id: string) => void };

/** A settings heading whose explanation stays folded until the reader asks for it with the ⓘ button. */
function SettingHeading({ id, label, help, children }: { id: string; label: string; help: HelpState; children: React.ReactNode }) {
  const open = help.isOpen(id);
  return (
    <>
      <div className="settings-heading">
        <h3 className="settings-section" id={id}>{label}</h3>
        <button
          type="button"
          className={`help-toggle ${open ? "active" : ""}`}
          aria-expanded={open}
          aria-controls={`${id}-help`}
          aria-label={`${label}の説明`}
          title={open ? "説明を閉じる" : "説明を表示"}
          onClick={() => help.toggle(id)}
        >
          <Icon name="info" />
        </button>
      </div>
      <p className="field-hint help-text" id={`${id}-help`} hidden={!open}>{children}</p>
    </>
  );
}

function deeplEndpointHint(endpoint: DeepLEndpoint, plan: DeepLPlan | null): string {
  if (plan === null) return "キーを登録すると、使う接続先をここに表示します。";
  const server = plan === "free" ? "無料プランの接続先（api-free.deepl.com）" : "有料プランの接続先（api.deepl.com）";
  if (endpoint !== "auto") return `${server}を使います。`;
  return plan === "free"
    ? `キーの末尾が「:fx」なので無料プラン用と判定し、${server}を使います。`
    : `キーの末尾が「:fx」ではないので有料プラン用と判定し、${server}を使います。`;
}

function entryColor(index: number): string {
  return colors[index % colors.length] ?? colors[0];
}

function stateLabel(state: SegmentState): string {
  switch (state) {
    case "pending": return "翻訳待ち";
    case "translated": return "翻訳済み";
    case "review": return "要確認";
    case "skipped": return "対象外";
    case "error": return "失敗";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "処理に失敗しました。";
}
