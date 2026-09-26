export type TargetLanguage = "JA" | "EN";
export type DisplayMode = "source-panel" | "inline";
export type ThemePreference = "system" | "light" | "dark";
export type Decision = "translate" | "skip" | "review";
export type SegmentState = "pending" | "translated" | "review" | "skipped" | "error";
export type DeepLPlan = "free" | "pro";

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
  deeplPlan: DeepLPlan;
  theme: ThemePreference;
}

export const SETTINGS_KEY = "pageTranslateSettings";
export const PROVIDER_KEYS_KEY = "pageTranslateProviderKeys";
export const DATA_USE_CONSENT_KEY = "pageTranslateDataUseConsentVersion";
export const DATA_USE_CONSENT_VERSION = 1;
export const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLanguage: "JA",
  displayMode: "source-panel",
  deeplPlan: "free",
  theme: "system",
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
  | { type: "UPDATE_FOCUS_ANCHOR"; anchor: FocusAnchor };

/** Port name for page-click mode: the side panel connects to the tab while the mode is on. */
export const PAGE_PICK_PORT = "page-pick";

export interface PagePickTarget {
  id: string;
  label: string;
  color: string;
}

/** Side panel → page over the page-pick port. */
export type PagePickRequest = { type: "targets"; targets: PagePickTarget[]; zoom: number };

/** Page → side panel over the page-pick port. */
export type PagePickEvent =
  | { type: "picked"; segmentId: string; anchor: FocusAnchor | null }
  | { type: "exit" };

export interface RuntimeError {
  error: string;
}

export interface ProviderStatus {
  providers: { jev: boolean; deepl: boolean };
}
