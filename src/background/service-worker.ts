import type {
  ExtensionMessage,
  RuntimeError,
} from "../shared/types";
import { DEFAULT_SETTINGS, PANEL_COMMAND_KEY, PROVIDER_KEYS_KEY, SETTINGS_KEY, isPanelCommand, type PanelCommandRequest } from "../shared/types";
import { classifyCandidates, clearProviderKeys, providerStatus, rephraseText, saveProviderKeys, translateSegments, translateText } from "./providers";

const storageReady = restrictStorageToExtensionPages();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void storageReady.then(() => chrome.storage.local.get(SETTINGS_KEY)).then((stored) => {
    if (!stored[SETTINGS_KEY]) {
      return chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    }
    return undefined;
  });
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Keyboard shortcuts: open the side panel, then leave the command for it in session storage.
chrome.commands.onCommand.addListener((command, tab) => {
  if (!isPanelCommand(command) || tab?.windowId === undefined) return;
  const windowId = tab.windowId;
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
