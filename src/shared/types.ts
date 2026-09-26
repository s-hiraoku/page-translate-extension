export type TargetLanguage = "JA" | "EN";
export type DisplayMode = "source-panel" | "inline";
export type Decision = "translate" | "skip" | "review";
export type SegmentState = "pending" | "translated" | "review" | "skipped" | "error";
export type DeepLPlan = "free" | "pro";

export interface CandidateSegment {
  id: string;
  order: number;
  location: string;
  tagName: string;
  sourceText: string;
  sourceHtml: string;
}

export interface TranslationEntry extends CandidateSegment {
  state: SegmentState;
  translatedText?: string;
  translatedHtml?: string;
  reason?: string;
}

export interface ExtensionSettings {
  targetLanguage: TargetLanguage;
  displayMode: DisplayMode;
  deeplPlan: DeepLPlan;
}

export const SETTINGS_KEY = "pageTranslateSettings";
export const PROVIDER_KEYS_KEY = "pageTranslateProviderKeys";
export const DATA_USE_CONSENT_KEY = "pageTranslateDataUseConsentVersion";
export const DATA_USE_CONSENT_VERSION = 1;
export const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLanguage: "JA",
  displayMode: "source-panel",
  deeplPlan: "free",
};

export type ExtensionMessage =
  | { type: "OPEN_SIDE_PANEL" }
  | { type: "CHECK_PROVIDERS" }
  | { type: "SAVE_PROVIDER_KEYS"; typesafeApiKey: string; deeplApiKey: string }
  | { type: "CLEAR_PROVIDER_KEYS" }
  | { type: "SCAN_ACTIVE_TAB" }
  | { type: "CLASSIFY_CANDIDATES"; segments: CandidateSegment[]; targetLanguage: TargetLanguage; pageTitle?: string }
  | { type: "TRANSLATE_SEGMENTS"; segments: CandidateSegment[]; targetLanguage: TargetLanguage }
  | { type: "APPLY_TRANSLATIONS"; entries: TranslationEntry[] }
  | { type: "RESTORE_PAGE" }
  | { type: "FOCUS_SEGMENT"; segmentId: string };

export interface RuntimeError {
  error: string;
}

export interface ProviderStatus {
  providers: { jev: boolean; deepl: boolean };
}
