export type TargetLanguage = "JA" | "EN";
export type DisplayMode = "source-panel" | "inline";
export type ThemePreference = "system" | "light" | "dark";
export type Decision = "translate" | "skip" | "review";
export type SegmentState = "pending" | "translated" | "review" | "skipped" | "error";
export type DeepLPlan = "free" | "pro";
/** Which DeepL server to use. "auto" decides from the key: free-plan keys end in ":fx". */
export type DeepLEndpoint = "auto" | "free" | "pro";

export function resolveDeepLPlan(endpoint: DeepLEndpoint, apiKey: string): DeepLPlan {
  if (endpoint !== "auto") return endpoint;
  return apiKey.trim().endsWith(":fx") ? "free" : "pro";
}

/** Where a segment sits on the page, as estimated by the content script. */
export type SegmentRegion =
  | "main"
  | "outside"
  | "unknown"
  | "header"
  | "navigation"
  | "sidebar"
  | "footer"
  | "comments"
  | "related"
  | "share"
  | "ad"
  | "overlay"
  | "meta";
export type SegmentKind = "heading" | "paragraph" | "list-item" | "quote" | "caption" | "table-cell" | "control" | "block";

export interface CandidateSegment {
  id: string;
  order: number;
  location: string;
  tagName: string;
  sourceText: string;
  sourceHtml: string;
  region: SegmentRegion;
  kind: SegmentKind;
  /** Share of the text that is link text (0–1). */
  linkDensity: number;
  isArticleTitle: boolean;
  /** Added by the reader in page-click mode rather than by the page scan. */
  manual?: boolean;
  /** A selected part of the element's text; never written back into the page. */
  partial?: boolean;
}

export interface ScanResult {
  title: string;
  url: string;
  segments: CandidateSegment[];
  /** Whether a main article region could be identified. */
  mainContentDetected: boolean;
  /** Candidates dropped locally as site chrome (navigation, ads, footers…). */
  excludedCount: number;
}

/** Vertical position of the clicked card, in screen coordinates (DIP). */
export interface FocusAnchor {
  screenY: number;
}

export interface TranslationEntry extends CandidateSegment {
  state: SegmentState;
  translatedText?: string;
  translatedHtml?: string;
  reason?: string;
  /** Jev answered "review": translated automatically, flagged in the panel. */
  uncertain?: boolean;
}

export interface ExtensionSettings {
  targetLanguage: TargetLanguage;
  displayMode: DisplayMode;
  /** Replaces the former API Free / API Pro choice (`deeplPlan`), which is no longer read. */
  deeplEndpoint: DeepLEndpoint;
  theme: ThemePreference;
  /** Ask TypeSafe Jev which candidates to translate. Off: every candidate left by the local filters is translated. */
  useJev: boolean;
  /** Writing check: English variant, DeepL Write style, and whether the open page is used as context. */
  englishVariant: EnglishVariant;
  writingStyle: WritingStyle;
  /**
   * Use the open page as DeepL context when putting the reader's Japanese into English.
   * Replaces `composeUsePage` (on by default, and also applied to the back-translation,
   * where it bent the meaning toward the page's topic), which is no longer read.
   */
  composePageContext: boolean;
  /** Keep a page's translation on this device for a few hours and reuse it. */
  cacheEnabled: boolean;
  /** How long a cached translation is reused, in hours. */
  cacheTtlHours: number;
}

export const SETTINGS_KEY = "pageTranslateSettings";
export const PROVIDER_KEYS_KEY = "pageTranslateProviderKeys";
export const DATA_USE_CONSENT_KEY = "pageTranslateDataUseConsentVersion";
/** 2: the English writing check also sends the reader's own text to DeepL. */
export const DATA_USE_CONSENT_VERSION = 2;
export const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLanguage: "JA",
  displayMode: "source-panel",
  deeplEndpoint: "auto",
  theme: "system",
  useJev: true,
  englishVariant: "EN-US",
  writingStyle: "default",
  composePageContext: false,
  cacheEnabled: true,
  cacheTtlHours: 3,
};

export type ExtensionMessage =
  | { type: "OPEN_SIDE_PANEL" }
  | { type: "CHECK_PROVIDERS" }
  | { type: "SAVE_PROVIDER_KEYS"; typesafeApiKey: string; deeplApiKey: string }
  | { type: "CLEAR_PROVIDER_KEYS" }
  | { type: "SCAN_ACTIVE_TAB" }
  | { type: "CLASSIFY_CANDIDATES"; segments: CandidateSegment[]; targetLanguage: TargetLanguage; pageTitle?: string; mainContentDetected?: boolean }
  | { type: "TRANSLATE_SEGMENTS"; segments: CandidateSegment[]; targetLanguage: TargetLanguage }
  | { type: "APPLY_TRANSLATIONS"; entries: TranslationEntry[] }
  | { type: "RESTORE_PAGE" }
  | { type: "FOCUS_SEGMENT"; segmentId: string; anchor?: FocusAnchor; label?: string; color?: string; scroll?: boolean }
  | { type: "UPDATE_FOCUS_ANCHOR"; anchor: FocusAnchor }
  | { type: "PAGE_TEXT" }
  | { type: "READ_SELECTION" }
  | { type: "TRANSLATE_SELECTION"; text: string; targetLang: ComposeLanguage }
  | { type: "SELECTION_RESULT"; id: number; text?: string; note?: string; error?: string }
  | { type: "COMPOSE_TRANSLATE"; text: string; targetLang: ComposeLanguage; context?: string }
  | { type: "COMPOSE_REPHRASE"; text: string; targetLang: EnglishVariant; style: WritingStyle };

/** English variants DeepL writes; the writing check compares against one of them. */
export type EnglishVariant = "EN-US" | "EN-GB";
export type ComposeLanguage = EnglishVariant | "JA";
/** DeepL Write `writing_style` values offered in the panel. */
export type WritingStyle = "default" | "simple" | "business" | "casual" | "academic";

/** Keyboard shortcuts (manifest `commands`) the side panel carries out. */
export const PANEL_COMMANDS = ["translate-page", "toggle-page-pick", "translate-selection"] as const;
export type PanelCommand = (typeof PANEL_COMMANDS)[number];
/**
 * chrome.storage.session key where the service worker leaves the latest shortcut for the
 * side panel. Storage (not a message) also reaches a panel the shortcut has just opened.
 */
export const PANEL_COMMAND_KEY = "pageTranslatePanelCommand";

export interface PanelCommandRequest {
  id: string;
  command: PanelCommand;
  windowId: number;
  /** Date.now() when the shortcut was pressed; stale requests are ignored. */
  at: number;
}

export function isPanelCommand(value: unknown): value is PanelCommand {
  return (PANEL_COMMANDS as readonly unknown[]).includes(value);
}

/** Port name for page-click mode: the side panel connects to the tab while the mode is on. */
export const PAGE_PICK_PORT = "page-pick";
/** Held open by the side panel while it shows a connector in a tab; closing the panel drops it. */
export const PANEL_PRESENCE_PORT = "panel-presence";

export interface PagePickTarget {
  id: string;
  label: string;
  color: string;
}

/** Side panel → page over the page-pick port. */
export type PagePickRequest = { type: "targets"; targets: PagePickTarget[]; zoom: number };

/** Page → side panel over the page-pick port. */
export type PagePickEvent =
  | { type: "picked"; segmentId: string }
  /** Text that is not a translated card yet. `followingIds` are known segments after it, in page order. */
  | { type: "added"; segment: CandidateSegment; followingIds: string[] }
  | { type: "exit" };

/** Port name for selection translation: the side panel connects to the tab while the mode is on. */
export const SELECTION_PORT = "selection-translate";

/** Longest selection that is translated (DeepL characters are billed). */
export const SELECTION_MAX_CHARS = 5000;

/** Page → side panel over the selection port: the reader selected this text. `id` ties the answer to its tooltip. */
export type SelectionEvent = { type: "selected"; id: number; text: string };

/** What the page returns for READ_SELECTION. `empty` means nothing translatable was selected (the page says so itself). */
export type ReadSelectionResult = { empty: true } | { empty?: false; id: number; text: string };

export interface RuntimeError {
  error: string;
}

export interface ProviderStatus {
  providers: { jev: boolean; deepl: boolean };
  /** DeepL plan the registered key is used with (after "auto" detection); null without a key. */
  deeplPlan: DeepLPlan | null;
}
