import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type {
  CandidateSegment,
  Decision,
  DeepLEndpoint,
  DeepLPlan,
  DisplayMode,
  ExtensionMessage,
  ExtensionSettings,
  FocusAnchor,
  PagePickEvent,
  PanelCommand,
  PagePickRequest,
  ProviderStatus,
  ScanResult,
  SegmentState,
  TargetLanguage,
  ThemePreference,
  TranslationEntry,
} from "../shared/types";
import { DATA_USE_CONSENT_KEY, DATA_USE_CONSENT_VERSION, DEFAULT_SETTINGS, PAGE_PICK_PORT, PANEL_COMMAND_KEY, PANEL_PRESENCE_PORT, SETTINGS_KEY, isPanelCommand } from "../shared/types";
import { Composer } from "./Composer";
import { Icon, type IconName } from "./Icon";
import { isInTargetLanguage, isMainProse } from "./rules";
import { applyTheme, cachedTheme } from "./theme";

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

const shortcutRows: Array<{ command: PanelCommand; label: string; short: string }> = [
  { command: "translate-page", label: "このページを翻訳", short: "翻訳" },
  { command: "toggle-page-pick", label: "ページクリックのオン・オフ", short: "ページクリック" },
];

function withShortcut(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label}（${shortcut}）` : label;
}

const colors = ["#2c5cf0", "#e0702a", "#0f8a6c", "#9150c8", "#c23d5f", "#6f8517"];

/** Screen Y of the side panel viewport's top edge, learned from pointer events. */
let panelScreenTop: number | null = null;
window.addEventListener("pointermove", (event) => { panelScreenTop = event.screenY - event.clientY; }, { passive: true });
window.addEventListener("pointerdown", (event) => { panelScreenTop = event.screenY - event.clientY; }, { passive: true });

export function SidePanel() {
  const [settings, setSettings] = useState<ExtensionSettings>(() => ({ ...DEFAULT_SETTINGS, theme: cachedTheme() }));
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [pageTitle, setPageTitle] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("ページを開いて「翻訳を開始」を押してください。");
  const [error, setError] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typesafeApiKey, setTypesafeApiKey] = useState("");
  const [deeplApiKey, setDeeplApiKey] = useState("");
  const [savingKeys, setSavingKeys] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolver = useRef<((agreed: boolean) => void) | null>(null);
  const [view, setView] = useState<"translate" | "compose">("translate");
  /** Candidates the page scan or the local language check dropped before Jev saw them. */
  const [droppedCount, setDroppedCount] = useState(0);
  /** Page-click mode: clicking translated text on the page selects its card. */
  const [pagePick, setPagePick] = useState(false);
  /** Current keyboard shortcuts by command name; "" when the reader has none assigned. */
  const [shortcuts, setShortcuts] = useState<Partial<Record<PanelCommand, string>>>({});

  // Keep the page connector attached to the selected card while the panel scrolls or resizes.
  useEffect(() => {
    if (!selectedId) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const card = document.querySelector<HTMLElement>(`[data-entry-id="${selectedId}"]`);
      const anchor = card ? anchorFor(card, panelScreenTop) : undefined;
      if (anchor) void sendMessage({ type: "UPDATE_FOCUS_ANCHOR", anchor }).catch(() => undefined);
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [selectedId]);

  useEffect(() => {
    void chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
      if (stored[SETTINGS_KEY]) {
        setSettings({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<ExtensionSettings>) });
      }
    });
  }, []);

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

  const pickable = useMemo(
    () => visibleEntries.flatMap((entry, index) => entry.state === "translated" ? [{ id: entry.id, label: String(index + 1), color: entryColor(index) }] : []),
    [visibleEntries],
  );
  const pickableKey = pickable.map((target) => target.id).join(",");
  const visibleRef = useRef(visibleEntries);
  visibleRef.current = visibleEntries;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** Bumped by every new scan so late results from the previous list are dropped. */
  const generationRef = useRef(0);
  // A finished scan (which also means data-use consent was given) enables page-click mode,
  // even when it left no visible cards: that is when adding one by hand matters most.
  const scanned = !busy && pageUrl !== "";

  // While page-click mode is on, hold a port to the tab. The page reports clicks on
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
      port = chrome.tabs.connect(tab.id, { name: PAGE_PICK_PORT });
      port.onMessage.addListener((message: PagePickEvent) => {
        if (message.type === "exit") setPagePick(false);
        else if (message.type === "picked") void revealPicked(message.segmentId, message.anchor);
        else if (message.type === "added") void addFromPage(message.segment, message.followingIds, message.anchor);
      });
      port.onDisconnect.addListener(() => {
        if (cancelled) return;
        setPagePick(false);
        setError("ページとの接続が切れたため、ページクリックを終了しました。");
      });
      port.postMessage({ type: "targets", targets: pickable, zoom } satisfies PagePickRequest);
    })().catch((caught: unknown) => {
      setPagePick(false);
      setError(errorMessage(caught));
    });
    return () => {
      cancelled = true;
      port?.disconnect();
    };
    // pickableKey captures every change to the targets.
  }, [pagePick, pickableKey]);

  /**
   * Text without a translated card was clicked or selected on the page: add a card in
   * page order (or reuse the hidden one), translate it with DeepL and link it.
   */
  async function addFromPage(segment: CandidateSegment, followingIds: string[], anchor: FocusAnchor | null): Promise<void> {
    const generation = generationRef.current;
    const existing = entriesRef.current.find((entry) => entry.id === segment.id);
    if (existing && (existing.state === "translated" || existing.reason === ADDING)) {
      await revealPicked(existing.id, anchor);
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
    await revealPicked(entry.id, anchor);

    try {
      // This runs from the port listener, so read the current settings through the ref.
      const result = await sendMessage<TranslationResult>({
        type: "TRANSLATE_SEGMENTS",
        segments: [entry],
        targetLanguage: settingsRef.current.targetLanguage,
      });
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

  /** A source was clicked on the page: line its card up with it and draw the connector. */
  async function revealPicked(segmentId: string, anchor: FocusAnchor | null): Promise<void> {
    const index = visibleRef.current.findIndex((entry) => entry.id === segmentId);
    if (index < 0) return;
    setSelectedId(segmentId);
    setError("");
    const card = document.querySelector<HTMLElement>(`[data-entry-id="${segmentId}"]`);
    if (!card) return;
    if (anchor && panelScreenTop !== null) {
      const cardY = card.getBoundingClientRect().top + Math.min(card.offsetHeight / 2, 22);
      window.scrollBy({ top: cardY - (anchor.screenY - panelScreenTop), behavior: "instant" });
    } else {
      card.scrollIntoView({ block: "center", behavior: "instant" });
    }
    await holdPresence();
    await sendMessage({
      type: "FOCUS_SEGMENT",
      segmentId,
      anchor: anchorFor(card, panelScreenTop),
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

  async function answerConsent(agreed: boolean): Promise<void> {
    if (agreed) await chrome.storage.local.set({ [DATA_USE_CONSENT_KEY]: DATA_USE_CONSENT_VERSION });
    setConsentOpen(false);
    consentResolver.current?.(agreed);
    consentResolver.current = null;
  }

  /** Resolves true once the page was scanned, so page-click mode can start. */
  async function startTranslation(): Promise<boolean> {
    return await ensureConsent() ? runTranslation() : false;
  }

  commandRef.current = (command) => void runCommand(command);
  async function runCommand(command: PanelCommand): Promise<void> {
    setSettingsOpen(false);
    setView("translate");
    if (busy || consentOpen) return;
    if (command === "translate-page") {
      await startTranslation();
    } else if (scanned) {
      setPagePick((on) => !on);
    } else if (await startTranslation()) {
      setPagePick(true);
    }
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

  async function runTranslation(): Promise<boolean> {
    generationRef.current += 1;
    const generation = generationRef.current;
    let scannedPage = false;
    setBusy(true);
    setError("");
    setEntries([]);
    setDroppedCount(0);
    setSelectedId(null);
    setPagePick(false);
    setStatus("ページの文章を調べています…");
    try {
      await sendMessage({ type: "RESTORE_PAGE" }).catch(() => undefined);
      const page = await sendMessage<ScanResult>({ type: "SCAN_ACTIVE_TAB" });
      setPageTitle(page.title);
      setPageUrl(new URL(page.url).hostname);
      scannedPage = true;
      const candidates = page.segments.filter((segment) => !isInTargetLanguage(segment.sourceText, settings.targetLanguage));
      setDroppedCount(page.excludedCount + page.segments.length - candidates.length);
      if (candidates.length === 0) {
        setStatus("翻訳が必要な本文が見つかりませんでした。");
        return generation === generationRef.current;
      }

      // Without Jev, everything the local filters kept is translated. Comparing the two
      // settings on the same page shows exactly what Jev removes.
      let decisions: DecisionResult["decisions"];
      if (settings.useJev) {
        setStatus(`本文の${candidates.length}件をJevが確認しています…`);
        ({ decisions } = await sendMessage<DecisionResult>({
          type: "CLASSIFY_CANDIDATES",
          segments: candidates,
          targetLanguage: settings.targetLanguage,
          pageTitle: page.title,
          mainContentDetected: page.mainContentDetected,
        }));
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
      setEntries(next);
      const pending = next.filter((entry) => entry.state === "pending");
      if (pending.length > 0) {
        setStatus(`${pending.length}件を翻訳しています…`);
        try {
          const translated = await requestTranslations(pending);
          for (const result of translated) {
            const entry = next.find((item) => item.id === result.id);
            if (entry) Object.assign(entry, result, { state: "translated", reason: undefined });
          }
        } catch (caught) {
          const message = errorMessage(caught);
          setError(message);
          for (const entry of pending) {
            const current = next.find((item) => item.id === entry.id);
            if (current) Object.assign(current, { state: "review", reason: "翻訳に失敗しました。再試行できます。" });
          }
        }
      }

      const finalEntries = [...next];
      setEntries(finalEntries);
      const shown = finalEntries.filter((entry) => entry.state !== "skipped").length;
      const mode = settings.useJev ? "" : "（Jevなし）";
      setStatus(shown > 0 ? `本文の${shown}件を表示しています。${mode}` : `翻訳が必要な本文が見つかりませんでした。${mode}`);
      if (settings.displayMode === "inline") await applyInline(finalEntries);
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus("処理を完了できませんでした。");
    } finally {
      setBusy(false);
    }
    return scannedPage && generation === generationRef.current;
  }

  async function requestTranslations(segments: CandidateSegment[]): Promise<Array<TranslationEntry & { translatedText: string; translatedHtml: string; state: "translated" }>> {
    const result = await sendMessage<TranslationResult>({
      type: "TRANSLATE_SEGMENTS",
      segments,
      targetLanguage: settings.targetLanguage,
    });
    return result.translations.map((translation) => {
      const source = segments.find((segment) => segment.id === translation.id);
      if (!source) throw new Error("翻訳結果と文章の対応が取れませんでした。");
      return { ...source, ...translation, state: "translated" as const };
    });
  }

  async function translateOne(entry: TranslationEntry): Promise<void> {
    setError("");
    setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, state: "error", reason: "翻訳中…" } : item));
    try {
      const [translated] = await requestTranslations([entry]);
      const next = entries.map((item) => item.id === entry.id ? translated : item);
      setEntries(next);
      if (settings.displayMode === "inline") await applyInline(next);
    } catch (caught) {
      setError(errorMessage(caught));
      setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, state: "review", reason: "翻訳に失敗しました。" } : item));
    }
  }

  async function changeMode(mode: DisplayMode): Promise<void> {
    const next = { ...settings, displayMode: mode };
    await persistSettings(next);
    if (mode === "inline") await applyInline(entries);
    else await sendMessage({ type: "RESTORE_PAGE" }).catch((caught: unknown) => setError(errorMessage(caught)));
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
    try {
      await holdPresence();
      const result = await sendMessage<{ focused: boolean }>({
        type: "FOCUS_SEGMENT",
        segmentId: entry.id,
        anchor,
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
    if (!typesafeApiKey.trim() && !deeplApiKey.trim()) {
      setError("保存するAPIキーを入力してください。");
      return;
    }
    setSavingKeys(true);
    setError("");
    try {
      const result = await sendMessage<ProviderStatus>({ type: "SAVE_PROVIDER_KEYS", typesafeApiKey, deeplApiKey });
      setProviderStatus(result);
      setTypesafeApiKey("");
      setDeeplApiKey("");
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
      setStatus("保存中のAPIキーを削除しました。");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const progress = visibleEntries.length > 0 ? translatedCount / visibleEntries.length : 0;

  return (
    <main className="panel-shell">
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
          onClick={() => { const open = !settingsOpen; setSettingsOpen(open); if (open) { void checkProviders(); void loadShortcuts(); } }}
        >
          <Icon name="settings" />
        </button>
      </header>

      {settingsOpen ? (
        <section className="settings-page" aria-labelledby="settings-title">
          <button className="text-button settings-back" type="button" onClick={() => setSettingsOpen(false)}>
            <Icon name="back" />翻訳画面に戻る
          </button>
          <p className="eyebrow">Settings</p>
          <h2 id="settings-title">設定</h2>
          <p className="settings-intro">表示テーマと、翻訳に使うサービスを設定します。翻訳にはDeepLを使います。翻訳する本文の判定にTypeSafe Jevを使うかどうかも選べます。</p>

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

          <h3 className="settings-section">キーボードショートカット</h3>
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
          <p className="field-hint">Chromeの拡張機能のショートカット設定で変更できます。ほかの拡張機能と重なっているキーは割り当てられず「未設定」になります。</p>

          <h3 className="settings-section" id="jev-label">翻訳する本文の判定</h3>
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
          <p className="field-hint">
            {settings.useJev
              ? "ページ側のルールで除いた残りをJevが確認し、本文だけを翻訳します。"
              : "Jevを使わず、ページ側のルールで除いた残りをすべて翻訳します。JevのAPIキーは不要です。"}
          </p>

          <h3 className="settings-section">翻訳サービス</h3>
          <div className={`provider-card ${settings.useJev ? "" : "unused"}`}>
            <div className="provider-card-heading">
              <div><h3>TypeSafe Jev</h3><p>{settings.useJev ? "ページから翻訳する本文を選びます。" : "現在は使わない設定です。"}</p></div>
              <span className={`badge ${providerStatus?.providers.jev ? "ready" : "missing"}`}>{providerStatus?.providers.jev ? "登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="typesafe-api-key">APIキー</label>
            <input id="typesafe-api-key" className="field" type="password" autoComplete="new-password" spellCheck={false} value={typesafeApiKey} onChange={(event) => setTypesafeApiKey(event.target.value)} placeholder={providerStatus?.providers.jev ? "登録済み · 変更時だけ入力" : "TypeSafe JevのAPIキー"} />
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
          <button className="text-button danger block" type="button" onClick={() => void clearProviderKeys()} disabled={!providerStatus?.providers.jev && !providerStatus?.providers.deepl}>
            <Icon name="trash" />保存中のAPIキーを削除
          </button>
          <p className="note"><Icon name="shield" />キーはメモリ上に保持し、ページ側には渡しません。Chromeを終了または拡張機能を再読み込みすると消えるため、次回は再入力してください。問い合わせ時はTypeSafe JevまたはDeepLへ直接送信します。</p>
        </section>
      ) : (
        <>
          <div className="view-tabs" role="tablist" aria-label="機能">
            <button type="button" role="tab" aria-selected={view === "translate"} className={view === "translate" ? "active" : ""} onClick={() => setView("translate")}>
              <Icon name="split" />ページ翻訳
            </button>
            <button type="button" role="tab" aria-selected={view === "compose"} className={view === "compose" ? "active" : ""} onClick={() => setView("compose")}>
              <Icon name="pen" />英作文
            </button>
          </div>
          {/* Kept mounted so drafts survive switching tabs. */}
          <div className="compose-view" hidden={view !== "compose"}>
            <Composer settings={settings} deeplPlan={providerStatus?.deeplPlan ?? null} persistSettings={persistSettings} ensureConsent={ensureConsent} getPageContext={getPageContext} sendMessage={sendMessage} />
          </div>
          {view === "translate" && (<>
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
            </button>

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
            </div>
          </section>

          {error && <div className="error-banner" role="alert"><Icon name="alert" />{error}</div>}

          {visibleEntries.length > 0 || scanned ? (
            <section className="results-section" aria-labelledby="results-title">
              <div className="results-heading">
                <h2 id="results-title">翻訳箇所</h2>
                <span className="count">{visibleEntries.length}</span>
                <button
                  type="button"
                  className={`pick-toggle ${pagePick ? "active" : ""}`}
                  aria-pressed={pagePick}
                  title={withShortcut("ページ上の本文をクリックして、対応する訳文を表示します", shortcuts["toggle-page-pick"])}
                  onClick={() => setPagePick((on) => !on)}
                >
                  <Icon name="pointer" />ページクリック
                </button>
              </div>
              {pagePick && (
                <p className="pick-note" role="status"><span className="live-dot" aria-hidden="true" />本文をクリックで訳文を表示。翻訳されていない箇所はクリックか文字の選択で追加して翻訳します。Escで終了</p>
              )}
              {hiddenCount > 0 && (
                <p className="hidden-note"><Icon name="eyeOff" />本文外・翻訳対象外の{hiddenCount}件は表示していません</p>
              )}
              {visibleEntries.length === 0 && !pagePick && (
                <p className="hidden-note">表示できる翻訳箇所はありません。「ページクリック」で本文を選ぶと追加できます。</p>
              )}
              <ol className="entry-list">
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
                        {entry.state === "translated" ? (
                          <span className="entry-translation">{entry.translatedText}</span>
                        ) : (
                          <span className="entry-review">{entry.reason ?? "判定を確認してください。"}</span>
                        )}
                        <span className="entry-source" lang={settings.targetLanguage === "JA" ? "en" : "ja"}>{entry.sourceText}</span>
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
                <li><span>2</span>{settings.useJev ? "Jevが翻訳対象を判定" : "ルールで本文を選別"}</li>
                <li><span>3</span>DeepLで翻訳</li>
              </ol>
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
            <span className="privacy"><Icon name="shield" />{settings.useJev ? "翻訳時は本文候補をJevへ、選ばれた文章をDeepLへ送信" : "翻訳時は本文をDeepLへ送信（Jevは不使用）"}</span>
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
            <p id="consent-description">ページを翻訳すると、このページから抽出した文章とページタイトルがTypeSafe Jevに送られ、翻訳対象として選ばれた文章がDeepLに送られます（設定でJevを使わない場合は、抽出した文章をDeepLにだけ送ります）。英作文チェックでは、入力した英文と日本語、文脈として使う場合はページのタイトルと本文がDeepLに送られます。APIキーも認証のため各サービスへ送信します。</p>
            <p>送信先はTypeSafe JevとDeepLです。Page Translateの開発者が運営するサーバーには送信しません。個人情報や機密情報を含む文章を翻訳する場合は、利用するAPIプランの条件を確認してください。</p>
            <p className="provider-policy-links"><a href="https://typesafe.ai/legal/privacy-policy" target="_blank" rel="noreferrer">TypeSafeのプライバシー情報</a> · <a href="https://www.deepl.com/en/privacy" target="_blank" rel="noreferrer">DeepLのプライバシー情報</a></p>
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
  return anchorFor(card, event.detail > 0 ? event.screenY - event.clientY : panelScreenTop);
}

function anchorFor(card: HTMLElement, panelTop: number | null): FocusAnchor | undefined {
  if (panelTop === null) return undefined;
  const rect = card.getBoundingClientRect();
  // Once the card leaves the panel, pin the connector to the nearest edge.
  const y = rect.top + Math.min(rect.height / 2, 22);
  return { screenY: panelTop + Math.min(Math.max(y, 8), window.innerHeight - 8) };
}

const ADDING = "翻訳しています…";

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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
