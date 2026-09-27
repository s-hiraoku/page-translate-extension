import type { Page } from "@playwright/test";

/**
 * Stand-in for the chrome.* APIs so the built side panel runs in a normal tab.
 * Every message the panel sends is recorded in window.__sent; tests can replace
 * a reply with window.__override(type, handler) and drive page-click mode with
 * window.__emit(event) once the panel has connected its page-pick port.
 */
export interface MockOptions {
  /** Consent version already stored; null means the reader has not agreed yet. */
  consent?: number | null;
  deeplPlan?: "free" | "pro" | null;
  /** Stored settings merged over the defaults (e.g. { useJev: false }). */
  settings?: Record<string, unknown>;
}

export const SEGMENTS = [
  { id: "segment-1", order: 0, location: "記事タイトル", tagName: "h1", sourceText: "Designing calm interfaces for dense information", region: "main", kind: "heading", isArticleTitle: true },
  { id: "segment-2", order: 1, location: "本文 1", tagName: "p", sourceText: "Most dashboards fail not because they show too little, but because every element competes for attention at once.", region: "main", kind: "paragraph" },
  { id: "segment-3", order: 2, location: "本文外 · 本文 2", tagName: "p", sourceText: "Subscribe to our newsletter", region: "outside", kind: "paragraph" },
  { id: "segment-4", order: 3, location: "本文 3", tagName: "p", sourceText: "Start by grouping related controls, then remove anything the reader does not need right now.", region: "main", kind: "paragraph" },
  { id: "segment-5", order: 4, location: "本文 4", tagName: "li", sourceText: "Use whitespace as structure (mixed 日本語 text)", region: "main", kind: "list-item" },
  { id: "segment-6", order: 5, location: "本文 5", tagName: "p", sourceText: "これはすでに日本語の文章なので翻訳は不要です。", region: "main", kind: "paragraph" },
].map((segment) => ({ sourceHtml: segment.sourceText, linkDensity: 0, isArticleTitle: false, ...segment }));

export async function installChromeMock(page: Page, options: MockOptions = {}): Promise<void> {
  await page.addInitScript(({ segments, consent, deeplPlan, settings }) => {
    type Message = { type: string; [key: string]: unknown };
    type Handler = (message: Message) => unknown;
    const w = window as unknown as Record<string, unknown>;
    const store: Record<string, unknown> = {};
    if (consent != null) store.pageTranslateDataUseConsentVersion = consent;
    if (settings) store.pageTranslateSettings = settings;
    const sent: Message[] = [];
    const overrides = new Map<string, Handler>();
    w.__sent = sent;
    w.__override = (type: string, handler: Handler) => overrides.set(type, handler);

    const translations: Record<string, string> = {
      "segment-1": "情報量の多い画面のための、落ち着いたインターフェース設計",
      "segment-2": "ほとんどのダッシュボードが失敗するのは、すべての要素が同時に注意を奪い合うからです。",
      "segment-4": "まず関連する操作をまとめ、読み手がいま必要としないものを取り除きます。",
    };
    const defaults: Record<string, Handler> = {
      SCAN_ACTIVE_TAB: () => ({ title: "Designing calm interfaces", url: "https://journal.example.com/calm", segments, mainContentDetected: true, excludedCount: 14 }),
      CLASSIFY_CANDIDATES: (m) => ({
        decisions: (m.segments as Array<{ id: string }>).map((s) => ({
          id: s.id,
          decision: s.id === "segment-3" ? "skip" : s.id === "segment-5" ? "review" : "translate",
          confidence: 0.9,
        })),
      }),
      TRANSLATE_SEGMENTS: (m) => ({
        translations: (m.segments as Array<{ id: string }>).map((s) => ({ id: s.id, translatedText: translations[s.id] ?? `訳:${s.id}`, translatedHtml: translations[s.id] ?? `訳:${s.id}` })),
      }),
      CHECK_PROVIDERS: () => ({ providers: { jev: true, deepl: true }, deeplPlan }),
      FOCUS_SEGMENT: () => ({ focused: true }),
      PAGE_TEXT: () => ({ title: "Release notes", text: "We plan to ship version 2.0 next month." }),
      COMPOSE_TRANSLATE: (m) => m.targetLang === "JA"
        ? { text: "次のバージョンのリリース予定について尋ねたいです。" }
        : { text: "I would like to ask about the release schedule for the next version." },
      COMPOSE_REPHRASE: () => ({ text: "I want to ask about the release schedule for the next version." }),
    };

    const port = (name: string) => {
      const listeners: Array<(message: unknown) => void> = [];
      const portObject = {
        name,
        onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
        onDisconnect: { addListener: () => undefined },
        postMessage: (message: unknown) => { if (name === "page-pick") w.__pickTargets = message; },
        disconnect: () => { w.__disconnected = ((w.__disconnected as number) ?? 0) + 1; },
      };
      if (name === "page-pick") w.__emit = (message: unknown) => listeners.forEach((listener) => listener(message));
      return portObject;
    };

    w.chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (values: Record<string, unknown>) => { Object.assign(store, values); },
          remove: async (key: string) => { delete store[key]; },
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
      runtime: {
        lastError: undefined,
        sendMessage: async (message: Message) => {
          sent.push(message);
          const handler = overrides.get(message.type) ?? defaults[message.type];
          return handler ? handler(message) : { ok: true };
        },
      },
      tabs: {
        query: async () => [{ id: 7 }],
        getZoom: async () => 1,
        connect: (_tabId: number, info?: { name?: string }) => port(info?.name ?? ""),
      },
    };
  }, { segments: SEGMENTS, consent: options.consent === undefined ? 2 : options.consent, deeplPlan: options.deeplPlan === undefined ? "free" : options.deeplPlan, settings: options.settings ?? null });
}

/** Message types the panel has sent so far, in order. */
export function sentTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as { __sent: Array<{ type: string }> }).__sent).map((m) => m.type));
}
