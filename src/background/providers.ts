import type { CandidateSegment, DeepLPlan, Decision, TargetLanguage } from "../shared/types";
import { PROVIDER_KEYS_KEY, SETTINGS_KEY, DEFAULT_SETTINGS, type ExtensionSettings } from "../shared/types";

type ProviderKeys = { typesafeApiKey: string; deeplApiKey: string };
type DecisionResult = { decisions: Array<{ id: string; decision: Decision; confidence: number }> };
type TranslationResult = { translations: Array<{ id: string; translatedText: string; translatedHtml: string }> };

const EMPTY_KEYS: ProviderKeys = { typesafeApiKey: "", deeplApiKey: "" };

export async function providerStatus(): Promise<{ providers: { jev: boolean; deepl: boolean } }> {
  const keys = await readProviderKeys();
  return { providers: { jev: Boolean(keys.typesafeApiKey), deepl: Boolean(keys.deeplApiKey) } };
}

export async function saveProviderKeys(typesafeApiKey: string, deeplApiKey: string): Promise<{ providers: { jev: boolean; deepl: boolean } }> {
  const current = await readProviderKeys();
  const next = {
    typesafeApiKey: typesafeApiKey.trim() || current.typesafeApiKey,
    deeplApiKey: deeplApiKey.trim() || current.deeplApiKey,
  };
  if (!typesafeApiKey.trim() && !deeplApiKey.trim()) throw new Error("保存するAPIキーを入力してください。");
  await chrome.storage.session.set({ [PROVIDER_KEYS_KEY]: next });
  return providerStatus();
}

export async function clearProviderKeys(): Promise<{ providers: { jev: boolean; deepl: boolean } }> {
  await chrome.storage.session.remove(PROVIDER_KEYS_KEY);
  return providerStatus();
}

export async function classifyCandidates(
  segments: CandidateSegment[],
  targetLanguage: TargetLanguage,
  pageTitle = "",
  pageInfo: { mainContentDetected: boolean; articleTitle: string } = { mainContentDetected: false, articleTitle: "" },
): Promise<DecisionResult> {
  const { typesafeApiKey } = await readProviderKeys();
  if (!typesafeApiKey) throw new Error("設定画面でTypeSafe JevのAPIキーを登録してください。");
  validateSegments(segments);

  const decisions: DecisionResult["decisions"] = [];
  for (const batch of batchByCountAndSize(segments, 16, 22_000, (item) => item.sourceText.length)) {
    const state = {
      target_language: targetLanguage === "JA" ? "Japanese" : "English",
      page_title: pageTitle.slice(0, 200),
      task: "Select only the page's main article content for translation. Site chrome and peripheral content must be skipped.",
      main_content_detected: pageInfo.mainContentDetected,
      article_title: pageInfo.articleTitle.slice(0, 200),
      region_legend: {
        main: "inside the detected main article container",
        outside: "outside the main article container (not a known landmark)",
        unknown: "main article container could not be detected",
        header: "site header / masthead", navigation: "menus, breadcrumbs, pagination", sidebar: "sidebar or widget",
        footer: "site footer", comments: "user comment area", related: "related / recommended / popular article lists",
        share: "share or follow prompts", ad: "advertising", overlay: "cookie banner, newsletter prompt, modal",
      },
      candidates: batch.map((segment) => ({
        id: segment.id,
        location: segment.location,
        element: segment.tagName,
        kind: segment.kind,
        region: segment.region,
        is_article_title: segment.isArticleTitle,
        link_density: segment.linkDensity,
        text: segment.sourceText,
      })),
    };
    const questions = Object.fromEntries(batch.map((segment, index) => [`candidate_${index + 1}`, {
      type: "choice",
      instructions: [
        `Decide whether candidate ${index + 1} (id ${segment.id}) belongs to the main article of this page and should be translated into the target language.`,
        "Translate the article title, its headings, and body text (paragraphs, list items, quotes, figure captions, table cells) that a reader of the article would want translated.",
        "Skip site chrome and peripheral content: navigation, menus, headers/footers, sidebars, related or recommended article lists, ads, share/follow prompts, cookie or newsletter notices, comment sections, bylines/dates/tag lists/read-time metadata, author bio boxes, and standalone link or button labels.",
        "Also skip code, identifiers, URLs, proper names alone, and text already written in the target language.",
        "Use region, is_article_title, kind and link_density as structural evidence (region 'main' and low link_density strongly suggest article content; high link_density suggests link lists), but let the text itself decide when the evidence conflicts.",
        "Choose review only when the text is genuinely ambiguous, e.g. mixed-language or context-dependent.",
      ].join(" "),
      criteria: {
        translate: "Part of the main article: title, heading or body text in a language other than the target language.",
        skip: "Not part of the main article (navigation, sidebar, footer, related links, ads, prompts, metadata, controls), or code/identifiers, or already in the target language.",
        review: "Plausibly article content but ambiguous: mixed-language or context-dependent text where automatic inclusion could change meaning.",
      },
    }]));

    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${typesafeApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions }),
      signal: AbortSignal.timeout(45_000),
    });
    const result = await readJson<{ answers?: Record<string, { choice?: string; confidence?: number }> }>(response, "Jev");
    batch.forEach((segment, index) => {
      const answer = result.answers?.[`candidate_${index + 1}`];
      const choice = answer?.choice;
      const confidence = Number(answer?.confidence ?? 0);
      const decision: Decision = choice === "translate" || choice === "skip" || choice === "review" ? choice : "review";
      decisions.push({ id: segment.id, decision: confidence < 0.62 ? "review" : decision, confidence });
    });
  }
  return { decisions };
}

export async function translateSegments(
  segments: CandidateSegment[],
  targetLanguage: TargetLanguage,
): Promise<TranslationResult> {
  const [keys, storedSettings] = await Promise.all([
    readProviderKeys(),
    chrome.storage.local.get(SETTINGS_KEY),
  ]);
  if (!keys.deeplApiKey) throw new Error("設定画面でDeepLのAPIキーを登録してください。");
  validateSegments(segments);

  const settings = { ...DEFAULT_SETTINGS, ...(storedSettings[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined) };
  const plan: DeepLPlan = settings.deeplPlan === "pro" ? "pro" : "free";
  const host = plan === "pro" ? "https://api.deepl.com" : "https://api-free.deepl.com";
  const translations: TranslationResult["translations"] = [];

  for (const batch of batchByCountAndSize(segments, 35, 100_000, (item) => new TextEncoder().encode(item.sourceHtml).byteLength)) {
    const response = await fetch(`${host}/v2/translate`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${keys.deeplApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: batch.map((segment) => segment.sourceHtml),
        target_lang: targetLanguage,
        context: batch.map((segment) => segment.sourceText).join("\n\n").slice(0, 3_000),
        tag_handling: "html",
        tag_handling_version: "v2",
        ignore_tags: "code",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await readJson<{ translations?: Array<{ text?: string }> }>(response, "DeepL");
    if (!Array.isArray(result.translations) || result.translations.length !== batch.length) {
      throw new Error("DeepLから返された翻訳数が一致しません。");
    }
    batch.forEach((segment, index) => {
      const translatedHtml = result.translations?.[index]?.text ?? "";
      translations.push({ id: segment.id, translatedHtml, translatedText: htmlToText(translatedHtml) });
    });
  }
  return { translations };
}

async function readProviderKeys(): Promise<ProviderKeys> {
  const result = await chrome.storage.session.get(PROVIDER_KEYS_KEY);
  const raw = result[PROVIDER_KEYS_KEY] as Partial<ProviderKeys> | undefined;
  return {
    typesafeApiKey: typeof raw?.typesafeApiKey === "string" ? raw.typesafeApiKey : EMPTY_KEYS.typesafeApiKey,
    deeplApiKey: typeof raw?.deeplApiKey === "string" ? raw.deeplApiKey : EMPTY_KEYS.deeplApiKey,
  };
}

async function readJson<T>(response: Response, provider: string): Promise<T> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(`${provider} APIから読み取れない応答が返されました (HTTP ${response.status})。`);
  }
  if (!response.ok) {
    const message = isRecord(result) && typeof result.message === "string" ? result.message.slice(0, 240) : "リクエストが拒否されました。";
    throw new Error(`${provider} APIエラー (HTTP ${response.status}): ${message}`);
  }
  return result as T;
}

function validateSegments(segments: CandidateSegment[]): void {
  if (segments.length > 120) throw new Error("一度に処理できる文章は120件までです。");
  for (const segment of segments) {
    if (segment.sourceText.length > 12_000 || segment.sourceHtml.length > 20_000) {
      throw new Error("長い文章は個別に確認してください。");
    }
  }
}

function batchByCountAndSize<T>(items: T[], maxCount: number, maxSize: number, sizeOf: (item: T) => number): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = sizeOf(item);
    if (batch.length > 0 && (batch.length >= maxCount || size + itemSize > maxSize)) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(item);
    size += itemSize;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|blockquote|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
