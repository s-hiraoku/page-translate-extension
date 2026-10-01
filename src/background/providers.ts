import type { CandidateSegment, ComposeLanguage, DeepLPlan, Decision, EnglishVariant, TargetLanguage, WritingStyle } from "../shared/types";
import { PROVIDER_KEYS_KEY, SETTINGS_KEY, DEFAULT_SETTINGS, resolveDeepLPlan, type ExtensionSettings, type ProviderStatus } from "../shared/types";

type ProviderKeys = { typesafeApiKey: string; deeplApiKey: string };
type DecisionResult = { decisions: Array<{ id: string; decision: Decision; confidence: number }> };
type TranslationResult = { translations: Array<{ id: string; translatedText: string; translatedHtml: string }> };

const EMPTY_KEYS: ProviderKeys = { typesafeApiKey: "", deeplApiKey: "" };

export async function providerStatus(): Promise<ProviderStatus> {
  const [keys, settings] = await Promise.all([readProviderKeys(), readSettings()]);
  return {
    providers: { jev: Boolean(keys.typesafeApiKey), deepl: Boolean(keys.deeplApiKey) },
    deeplPlan: keys.deeplApiKey ? resolveDeepLPlan(settings.deeplEndpoint, keys.deeplApiKey) : null,
  };
}

export async function saveProviderKeys(typesafeApiKey: string, deeplApiKey: string): Promise<ProviderStatus> {
  const current = await readProviderKeys();
  const next = {
    typesafeApiKey: typesafeApiKey.trim() || current.typesafeApiKey,
    deeplApiKey: deeplApiKey.trim() || current.deeplApiKey,
  };
  if (!typesafeApiKey.trim() && !deeplApiKey.trim()) throw new Error("保存するAPIキーを入力してください。");
  await chrome.storage.session.set({ [PROVIDER_KEYS_KEY]: next });
  return providerStatus();
}

export async function clearProviderKeys(): Promise<ProviderStatus> {
  await chrome.storage.session.remove(PROVIDER_KEYS_KEY);
  return providerStatus();
}

/**
 * What to tell the reader when page translation (with Jev) lacks a key. DeepL does the translating,
 * so it comes first; Jev only picks the text and can be turned off.
 */
export function missingKeyMessage(registered: { jev: boolean; deepl: boolean }, needsDeepl = true): string | null {
  if (!needsDeepl) {
    return registered.jev ? null : "TypeSafe JevのAPIキーが未登録です。設定画面で登録するか、「翻訳する本文の判定」で「Jevを使わない」を選んでください。";
  }
  if (!registered.deepl) {
    return registered.jev
      ? "設定画面でDeepLのAPIキーを登録してください。翻訳にはDeepLのキーが必要です。"
      : "設定画面でDeepLのAPIキーを登録してください。翻訳にはDeepLのキーが必要です。TypeSafe Jevのキーがない場合は、設定の「翻訳する本文の判定」で「Jevを使わない」を選べば、DeepLのキーだけで翻訳できます。";
  }
  if (!registered.jev) {
    return "TypeSafe JevのAPIキーが未登録です。設定画面で登録するか、「翻訳する本文の判定」で「Jevを使わない」を選んでください（DeepLのキーだけで翻訳できます）。";
  }
  return null;
}

export async function classifyCandidates(
  segments: CandidateSegment[],
  targetLanguage: TargetLanguage,
  pageTitle = "",
  pageInfo: { mainContentDetected: boolean; articleTitle: string } = { mainContentDetected: false, articleTitle: "" },
): Promise<DecisionResult> {
  const [keys, settings] = await Promise.all([readProviderKeys(), readSettings()]);
  // With Chrome's built-in translator, DeepL is not part of page translation.
  const missing = missingKeyMessage({ jev: Boolean(keys.typesafeApiKey), deepl: Boolean(keys.deeplApiKey) }, settings.translationProvider !== "chrome");
  if (missing) throw new Error(missing);
  const { typesafeApiKey } = keys;
  validateSegments(segments);

  // Not every page is a single article. Landing pages are short headlines and taglines;
  // home/portal pages (e.g. the Wikipedia Main Page) are several sections of summaries
  // and news items. Asking Jev for "the main article" there skips or questions them all.
  const pageKind = classifyPage(segments);
  const task = {
    article: "Select the page's main article content for translation. Site chrome and peripheral content must be skipped.",
    portal: "This is a home or portal page made of several content sections. Select the content of every section for translation: section headings, featured summaries, news items, facts and descriptions written as sentences. Site chrome and bare link lists must be skipped.",
    landing: "This is a landing or product page without a long article. Select its visible content for translation: headlines, taglines, feature names and descriptions, and body copy. Site chrome must be skipped.",
  }[pageKind];

  const decisions: DecisionResult["decisions"] = [];
  for (const batch of batchByCountAndSize(segments, 16, 22_000, (item) => item.sourceText.length)) {
    const state = {
      target_language: targetLanguage === "JA" ? "Japanese" : "English",
      page_title: pageTitle.slice(0, 200),
      task,
      page_kind: pageKind,
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
        `Decide whether candidate ${index + 1} (id ${segment.id}) is content of this page that a reader would want translated into the target language.`,
        "Translate the article title, its headings, and body text (paragraphs, list items, quotes, figure captions, table cells).",
        "On a landing or product page (page_kind 'landing'), short headlines, taglines and feature labels such as 'Fewer Collisions' or 'Makes every drive easier' are content: translate them; being short is not a reason for review.",
        "On a home or portal page (page_kind 'portal'), summaries of featured articles, news items, 'did you know' facts and 'on this day' entries in region 'main' are content even though they link to other pages: translate them.",
        "Skip site chrome and peripheral content: navigation, menus, headers/footers, sidebars, related or recommended article lists outside region 'main' or made only of link titles, ads, share/follow prompts, cookie or newsletter notices, comment sections, bylines/dates/tag lists/read-time metadata, author bio boxes, and standalone link or button labels.",
        "Also skip code, identifiers, URLs, proper names or product names alone (e.g. 'Model Y'), numbers alone, and text already written in the target language.",
        "Use region, is_article_title, kind and link_density as structural evidence (region 'main' and low link_density strongly suggest article content; high link_density suggests link lists), but let the text itself decide when the evidence conflicts.",
        "Choose review only when the text is genuinely ambiguous, e.g. mixed-language. When unsure between translate and skip for readable natural-language text, choose translate.",
      ].join(" "),
      criteria: {
        translate: "Page content a reader came for (article text; or section headings, summaries and items on portal and landing pages) in a language other than the target language.",
        skip: "Site chrome (navigation, sidebar, footer, bare link lists, ads, prompts, metadata, controls), code/identifiers, names alone, or text already in the target language.",
        review: "Plausibly content but ambiguous: mixed-language or context-dependent text where automatic inclusion could change meaning.",
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
      // An unsure "skip" may hide content, so it becomes review (translated and flagged).
      // An unsure "translate" stays translate.
      decisions.push({ id: segment.id, decision: decision === "skip" && confidence < 0.62 ? "review" : decision, confidence });
    });
  }
  return { decisions };
}

export async function translateSegments(
  segments: CandidateSegment[],
  targetLanguage: TargetLanguage,
): Promise<TranslationResult> {
  const { key, host } = await deeplAccess();
  validateSegments(segments);
  const translations: TranslationResult["translations"] = [];

  for (const batch of batchByCountAndSize(segments, 35, 100_000, (item) => new TextEncoder().encode(item.sourceHtml).byteLength)) {
    const response = await fetch(`${host}/v2/translate`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
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

/**
 * article: one long text with its own paragraphs; portal: many sections headed by
 * h2/h3 whose text is mostly list items and short summaries; landing: little prose.
 */
export function classifyPage(segments: CandidateSegment[]): "article" | "portal" | "landing" {
  const main = segments.filter((segment) => segment.region === "main" || segment.region === "unknown");
  const prose = main.filter((segment) => segment.kind !== "heading" && segment.sourceText.length >= 60);
  if (prose.length < 3) return "landing";
  const paragraphs = prose.filter((segment) => segment.kind === "paragraph" && segment.sourceText.length >= 120).length;
  const sections = main.filter((segment) => segment.kind === "heading" && !segment.isArticleTitle).length;
  // Articles are mostly paragraphs; portals are mostly items spread over several sections.
  return sections >= 4 && paragraphs < prose.length / 2 ? "portal" : "article";
}

async function readProviderKeys(): Promise<ProviderKeys> {
  const result = await chrome.storage.session.get(PROVIDER_KEYS_KEY);
  const raw = result[PROVIDER_KEYS_KEY] as Partial<ProviderKeys> | undefined;
  return {
    typesafeApiKey: typeof raw?.typesafeApiKey === "string" ? raw.typesafeApiKey : EMPTY_KEYS.typesafeApiKey,
    deeplApiKey: typeof raw?.deeplApiKey === "string" ? raw.deeplApiKey : EMPTY_KEYS.deeplApiKey,
  };
}

/** Plain-text translation for the writing check; `context` steers wording and is not translated. */
export async function translateText(text: string, targetLang: ComposeLanguage, context = ""): Promise<{ text: string }> {
  const { key, host } = await deeplAccess();
  validateComposeText(text);
  const response = await fetch(`${host}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: [text],
      target_lang: targetLang,
      ...(context.trim() ? { context: context.slice(0, 4_000) } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await readJson<{ translations?: Array<{ text?: string }> }>(response, "DeepL");
  const translated = result.translations?.[0]?.text;
  if (typeof translated !== "string") throw new Error("DeepLから翻訳結果を受け取れませんでした。");
  return { text: translated };
}

/**
 * DeepL Write (`/v2/write/rephrase`) fixes spelling and grammar and may rewrite for
 * clarity. It is available with paid-plan keys only (not free-plan keys ending in ":fx").
 */
export async function rephraseText(text: string, targetLang: EnglishVariant, style: WritingStyle): Promise<{ text: string }> {
  const { key, host, plan } = await deeplAccess();
  if (plan !== "pro") throw new Error("DeepL Writeの添削は有料プランのキーでのみ使えます。");
  validateComposeText(text);
  const response = await fetch(`${host}/v2/write/rephrase`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: [text],
      target_lang: targetLang.toLowerCase(),
      ...(style === "default" ? {} : { writing_style: `prefer_${style}` }),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await readJson<{ improvements?: Array<{ text?: string }> }>(response, "DeepL Write");
  const improved = result.improvements?.[0]?.text;
  if (typeof improved !== "string") throw new Error("DeepL Writeから添削結果を受け取れませんでした。");
  return { text: improved };
}

/** Key, server and plan for DeepL requests: free-plan keys must use api-free.deepl.com. */
async function deeplAccess(): Promise<{ key: string; host: string; plan: DeepLPlan }> {
  const [keys, settings] = await Promise.all([readProviderKeys(), readSettings()]);
  if (!keys.deeplApiKey) throw new Error("設定画面でDeepLのAPIキーを登録してください。");
  const plan = resolveDeepLPlan(settings.deeplEndpoint, keys.deeplApiKey);
  return { key: keys.deeplApiKey, host: plan === "pro" ? "https://api.deepl.com" : "https://api-free.deepl.com", plan };
}

async function readSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined) };
}

function validateComposeText(text: string): void {
  if (!text.trim()) throw new Error("文章を入力してください。");
  if (text.length > 5_000) throw new Error("一度に確認できるのは5,000文字までです。");
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
