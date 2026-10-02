import type {
  ExtensionMessage,
  ReadSelectionResult,
  RuntimeError,
  SelectionAutoChanged,
} from "../shared/types";
import { DATA_USE_CONSENT_KEY, DATA_USE_CONSENT_VERSION, DEFAULT_SETTINGS, PANEL_COMMAND_KEY, PROVIDER_KEYS_KEY, SETTINGS_KEY, isPanelCommand, type ExtensionSettings, type PanelCommandRequest } from "../shared/types";
import { CONSENT_NOTE, createSelectionTranslator, type SelectionOutcome } from "./selection";
import { settingsOnInstall } from "../shared/effective-settings";
import { classifyCandidates, clearProviderKeys, providerStatus, rephraseText, saveProviderKeys, translateSegments, translateText } from "./providers";

const storageReady = restrictStorageToExtensionPages();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void storageReady.then(() => chrome.storage.local.get(SETTINGS_KEY)).then((stored) => {
    const next = settingsOnInstall(stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined);
    return next ? chrome.storage.local.set({ [SETTINGS_KEY]: next }) : undefined;
  });
  void createMenus();
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Translating a selection needs neither the side panel nor its page connection: the page reports
// the selection (or the shortcut / context menu asks for it) and the tooltip shows the answer.
const translateSelection = createSelectionTranslator({
  settings: readSettings,
  hasConsent,
  translate: translateText,
});

/** Whether the data-use consent is on record, as last seen; null until read. Lets a shortcut open the panel before any await. */
let consentKnown: boolean | null = null;

async function hasConsent(): Promise<boolean> {
  await storageReady;
  const stored = await chrome.storage.local.get(DATA_USE_CONSENT_KEY);
  consentKnown = stored[DATA_USE_CONSENT_KEY] === DATA_USE_CONSENT_VERSION;
  return consentKnown;
}

async function readSettings(): Promise<ExtensionSettings> {
  await storageReady;
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined) };
  chromeTranslatorChosen = settings.translationProvider === "chrome";
  return settings;
}

/**
 * Whether Chrome's built-in translator is chosen, as last seen. It cannot run here (not in service
 * workers): the page translates selections itself, and no data-use consent is needed for that.
 */
let chromeTranslatorChosen = false;
void readSettings().catch(() => undefined);

async function sendToTab<T = unknown>(tabId: number, message: object): Promise<T> {
  return await chrome.tabs.sendMessage(tabId, message) as T;
}

async function deliverSelection(tabId: number, id: number, text: string): Promise<void> {
  const outcome: SelectionOutcome = await translateSelection(text);
  await sendToTab(tabId, { type: "SELECTION_RESULT", id, ...outcome }).catch(() => undefined);
}

/**
 * The shortcut and the context menu: translate what is selected in this tab now, once, with no
 * panel. Without the reader's consent nothing is sent: the panel is opened to ask (Chrome allows
 * that only right after the key press, so it may refuse, and then the tooltip says what to do).
 */
async function translateSelectionOnce(tabId: number, windowId: number | undefined): Promise<void> {
  // Chrome's translator runs in the page. A page without one (an older Chrome) falls back to DeepL.
  if (chromeTranslatorChosen) {
    const { targetLanguage } = await readSettings();
    const local = await sendToTab<{ handled?: boolean }>(tabId, { type: "TRANSLATE_SELECTION_LOCALLY", targetLanguage }).catch(() => null);
    if (local?.handled) return;
  }
  const read = await sendToTab<ReadSelectionResult>(tabId, { type: "READ_SELECTION" }).catch(() => null);
  if (!read || read.empty) return;
  if (await hasConsent()) {
    await deliverSelection(tabId, read.id, read.text);
    return;
  }
  const opened = windowId !== undefined && await openPanelFor("translate-selection", windowId);
  if (!opened) await sendToTab(tabId, { type: "SELECTION_RESULT", id: read.id, note: CONSENT_NOTE }).catch(() => undefined);
}

/** Opens the side panel in this window and leaves the command for it. Resolves false if Chrome refuses. */
async function openPanelFor(command: PanelCommandRequest["command"], windowId: number): Promise<boolean> {
  // Open before any await: the shortcut counts as a user gesture only until then.
  const opened = await chrome.sidePanel.open({ windowId }).then(() => true, () => false);
  if (!opened) return false;
  const request: PanelCommandRequest = { id: crypto.randomUUID(), command, windowId, at: Date.now() };
  await storageReady.then(() => chrome.storage.session.set({ [PANEL_COMMAND_KEY]: request }));
  return true;
}

const MENU_TRANSLATE = "translate-selection";
const MENU_AUTO = "selection-auto";

async function createMenus(): Promise<void> {
  const settings = await readSettings();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_TRANSLATE, title: "選択範囲を翻訳", contexts: ["selection"] });
  chrome.contextMenus.create({ id: MENU_AUTO, title: "選択したら自動で翻訳", type: "checkbox", checked: settings.selectionAutoTranslate, contexts: ["page", "selection"] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_TRANSLATE && tab?.id !== undefined) {
    void translateSelectionOnce(tab.id, tab.windowId);
  } else if (info.menuItemId === MENU_AUTO) {
    void readSettings().then((settings) => chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, selectionAutoTranslate: info.checked === true } }));
  }
});

// Settings or consent changed (from the panel or the menu): keep the menu and every open page in step.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const consent = changes[DATA_USE_CONSENT_KEY];
  if (consent) consentKnown = consent.newValue === DATA_USE_CONSENT_VERSION;
  const settings = changes[SETTINGS_KEY];
  if (!settings) return;
  chromeTranslatorChosen = (settings.newValue as Partial<ExtensionSettings> | undefined)?.translationProvider === "chrome";
  const before = (settings.oldValue as Partial<ExtensionSettings> | undefined)?.selectionAutoTranslate === true;
  const after = (settings.newValue as Partial<ExtensionSettings> | undefined)?.selectionAutoTranslate === true;
  if (before === after) return;
  void chrome.contextMenus.update(MENU_AUTO, { checked: after }).catch(() => undefined);
  void chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) void sendToTab(tab.id, { type: "SELECTION_AUTO_CHANGED", enabled: after } satisfies SelectionAutoChanged).catch(() => undefined);
    }
  });
});

// Keyboard shortcuts: open the side panel, then leave the command for it in session storage.
chrome.commands.onCommand.addListener((command, tab) => {
  if (!isPanelCommand(command) || tab?.windowId === undefined) return;
  const windowId = tab.windowId;
  // Selection translation runs without the panel, unless DeepL needs consent and the panel has to ask.
  if (command === "translate-selection" && tab.id !== undefined && (consentKnown !== false || chromeTranslatorChosen)) {
    void translateSelectionOnce(tab.id, windowId);
    return;
  }
  // Open before any await: the shortcut counts as a user gesture only until then.
  chrome.sidePanel.open({ windowId }).catch(() => undefined);
  const request: PanelCommandRequest = { id: crypto.randomUUID(), command, windowId, at: Date.now() };
  void storageReady.then(() => chrome.storage.session.set({ [PANEL_COMMAND_KEY]: request }));
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  if (!isExtensionMessage(rawMessage)) return;

  void handleMessage(rawMessage, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ error: error instanceof Error ? error.message : "Request failed." } satisfies RuntimeError);
    });
  return true;
});

async function handleMessage(message: ExtensionMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await storageReady;
  switch (message.type) {
    case "CHECK_PROVIDERS":
      requireExtensionPage(sender);
      return providerStatus();
    case "SAVE_PROVIDER_KEYS":
      requireExtensionPage(sender);
      return saveProviderKeys(message.typesafeApiKey, message.deeplApiKey);
    case "CLEAR_PROVIDER_KEYS":
      requireExtensionPage(sender);
      return clearProviderKeys();
    case "SCAN_ACTIVE_TAB":
      return sendToActiveTab({ type: "SCAN_PAGE" });
    case "FOCUS_SEGMENT":
      return sendToActiveTab(message, (tabId) => chrome.tabs.getZoom(tabId).catch(() => 1).then((zoom) => ({ ...message, zoom })));
    case "PAGE_TEXT":
      requireExtensionPage(sender);
      return sendToActiveTab({ type: "PAGE_TEXT" });
    case "APPLY_TRANSLATIONS":
    case "RESTORE_PAGE":
    case "UPDATE_FOCUS_ANCHOR":
      return sendToActiveTab(message);
    case "CLASSIFY_CANDIDATES":
      return classifyCandidates(message.segments, message.targetLanguage, message.pageTitle, {
        mainContentDetected: message.mainContentDetected ?? false,
        articleTitle: message.segments.find((segment) => segment.isArticleTitle)?.sourceText ?? "",
      });
    case "TRANSLATE_SEGMENTS":
      return translateSegments(message.segments, message.targetLanguage);
    // The writing check sends the reader's own text: only the side panel may ask for it.
    case "COMPOSE_TRANSLATE":
      requireExtensionPage(sender);
      return translateText(message.text, message.targetLang, message.context);
    case "COMPOSE_REPHRASE":
      requireExtensionPage(sender);
      return rephraseText(message.text, message.targetLang, message.style);
    // Selection translation reads the page's selection and sends it to DeepL: only the side panel may ask.
    case "READ_SELECTION":
      requireExtensionPage(sender);
      return sendToActiveTab({ type: "READ_SELECTION" });
    case "TRANSLATE_SELECTION":
      requireExtensionPage(sender);
      return translateText(message.text, message.targetLang);
    case "SELECTION_RESULT":
      requireExtensionPage(sender);
      return sendToActiveTab(message);
    // A page reports a selection while "translate as I select" is on. Only content scripts send this, and only then.
    case "SELECTION_FROM_PAGE": {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.id !== chrome.runtime.id || !(await readSettings()).selectionAutoTranslate) return { ok: false };
      await deliverSelection(tabId, message.id, message.text);
      return { ok: true };
    }
    case "GET_SELECTION_AUTO": {
      // The page also learns who translates: with Chrome's translator it translates by itself.
      const settings = await readSettings();
      return { enabled: sender.tab !== undefined && settings.selectionAutoTranslate, provider: settings.translationProvider, targetLanguage: settings.targetLanguage };
    }
    case "OPEN_SIDE_PANEL":
      return undefined;
  }
}

async function restrictStorageToExtensionPages(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  const [session, local] = await Promise.all([
    chrome.storage.session.get(PROVIDER_KEYS_KEY),
    chrome.storage.local.get(PROVIDER_KEYS_KEY),
  ]);
  if (!session[PROVIDER_KEYS_KEY] && local[PROVIDER_KEYS_KEY]) {
    await chrome.storage.session.set({ [PROVIDER_KEYS_KEY]: local[PROVIDER_KEYS_KEY] });
  }
  await chrome.storage.local.remove(PROVIDER_KEYS_KEY);
}

function requireExtensionPage(sender: chrome.runtime.MessageSender): void {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
    throw new Error("この操作は拡張機能の設定画面から実行してください。");
  }
}

async function sendToActiveTab(
  message: object,
  enrich?: (tabId: number) => Promise<object>,
): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new Error("アクティブなタブが見つかりません。");
  const payload = enrich ? await enrich(tab.id) : message;
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    // Usually the tab was open before the extension was installed, updated or reloaded, so
    // it has no content script yet; chrome:// and Web Store pages never get one.
    throw new Error("このページと接続できませんでした。ページを再読み込みしてから、もう一度お試しください。chrome:// やChromeウェブストアなどのページでは使えません。");
  }
}

function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return typeof value === "object" && value !== null && "type" in value;
}
