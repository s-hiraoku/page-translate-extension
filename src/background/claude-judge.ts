import Anthropic from "@anthropic-ai/sdk";
import type { CandidateSegment, Decision, TargetLanguage } from "../shared/types";

/**
 * Claude as the judge of which scanned candidates are the page's content. Jev is asked one
 * candidate at a time, in batches of 16 that never see each other, so a list item cannot be
 * judged by the heading above it and a page is never seen whole. Claude gets the whole page
 * in reading order in one request and decides every candidate with that context.
 */

export const CLAUDE_MODEL = "claude-opus-5-5";
/** Each candidate's text is cut to this many characters: the verdict never needs more. */
const TEXT_LIMIT = 600;

export type ClaudeDecision = { id: string; decision: Decision; confidence: number };
export type PageInfo = { pageTitle: string; mainContentDetected: boolean; articleTitle: string };

const SYSTEM_PROMPT = [
  "You decide which parts of a web page a reader wants translated. A browser extension scanned the page into text candidates, listed in reading order. Some are the page's content; others are site chrome.",
  "",
  "Translate: everything a reader came to the page for. On an article page: the title, headings, paragraphs, list items, quotes, figure captions and table cells of the article. On a home or portal page: section headings, featured summaries, news items, facts and descriptions in every content section, even though they link elsewhere. On a landing or product page: headlines, taglines, feature names and descriptions, and body copy, however short.",
  "Skip: site chrome and peripheral material: navigation, menus, breadcrumbs, pagination, site headers and footers, sidebars and widgets, lists of related or recommended articles, ads, share or follow prompts, cookie and newsletter notices, comment sections, bylines, dates, tag lists, read-time and other metadata, author bio boxes, and standalone link or button labels. Also skip code, identifiers, URLs, numbers alone, a proper or product name alone, and text already written in the target language.",
  "Review: only text that is plausibly content but genuinely ambiguous, such as mixed-language text. It is translated and flagged for the reader.",
  "",
  "Judge each candidate with the page around it: what type of page this is, which section it sits in, and what comes before and after it. The structural fields are evidence, not rules: region says where the scanner thinks the candidate sits ('main' is inside the detected article container, 'unknown' means no container was found), link_density is the share of its text that is link text. When the evidence and the text disagree, the text decides. When unsure whether readable prose is content, translate it: a missed paragraph costs the reader more than an extra card.",
  "",
  "Return one decision for every candidate, by its n.",
].join("\n");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          decision: { type: "string", enum: ["translate", "skip", "review"] },
        },
        required: ["n", "decision"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
} as const;

/** The page as Claude reads it: candidates numbered from 1 in reading order. */
export function buildPageMessage(segments: CandidateSegment[], targetLanguage: TargetLanguage, page: PageInfo): string {
  return JSON.stringify({
    target_language: targetLanguage === "JA" ? "Japanese" : "English",
    page_title: page.pageTitle.slice(0, 200),
    article_title: page.articleTitle.slice(0, 200),
    main_content_detected: page.mainContentDetected,
    candidates: [...segments].sort((a, b) => a.order - b.order).map((segment) => ({
      n: segments.indexOf(segment) + 1,
      element: segment.tagName,
      kind: segment.kind,
      region: segment.region,
      is_article_title: segment.isArticleTitle,
      link_density: Math.round(segment.linkDensity * 100) / 100,
      text: segment.sourceText.length > TEXT_LIMIT ? `${segment.sourceText.slice(0, TEXT_LIMIT)}…` : segment.sourceText,
    })),
  });
}

/**
 * Claude's answer as decisions by segment id. A candidate it left out is translated and flagged
 * ("review"), as with Jev, so no content goes missing because of a short answer.
 */
export function readDecisions(segments: CandidateSegment[], answer: string): ClaudeDecision[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new Error("Claudeから読み取れない判定が返されました。");
  }
  const byNumber = new Map<number, Decision>();
  const list = typeof parsed === "object" && parsed !== null ? (parsed as { decisions?: unknown }).decisions : undefined;
  if (Array.isArray(list)) {
    for (const item of list as Array<{ n?: unknown; decision?: unknown }>) {
      if (typeof item?.n === "number" && (item.decision === "translate" || item.decision === "skip" || item.decision === "review")) {
        byNumber.set(item.n, item.decision);
      }
    }
  }
  return segments.map((segment, index) => {
    const decision = byNumber.get(index + 1) ?? "review";
    return { id: segment.id, decision, confidence: decision === "review" ? 0.5 : 0.9 };
  });
}

export async function judgeWithClaude(
  apiKey: string,
  segments: CandidateSegment[],
  targetLanguage: TargetLanguage,
  page: PageInfo,
): Promise<ClaudeDecision[]> {
  // The key is the reader's own and stays in this extension's service worker; it never reaches a page.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 90_000, maxRetries: 1 });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16_000,
      // Sorting a page's text is a light task: low effort keeps the wait short.
      output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPageMessage(segments, targetLanguage, page) }],
    });
  } catch (caught) {
    throw new Error(claudeErrorMessage(caught));
  }
  if (response.stop_reason === "refusal") throw new Error("Claudeがこのページの判定を断りました。設定で判定を「Jev」か「使わない」に変えてお試しください。");
  if (response.stop_reason === "max_tokens") throw new Error("Claudeの判定が途中で終わりました。もう一度お試しください。");
  const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
  return readDecisions(segments, text);
}

function claudeErrorMessage(caught: unknown): string {
  if (caught instanceof Anthropic.AuthenticationError) return "ClaudeのAPIキーが正しくありません。設定画面で登録し直してください。";
  if (caught instanceof Anthropic.PermissionDeniedError) return "このClaudeのAPIキーでは判定できません (HTTP 403)。キーの権限を確認してください。";
  if (caught instanceof Anthropic.RateLimitError) return "Claude APIの利用上限に達しました。しばらく待ってからお試しください。";
  if (caught instanceof Anthropic.APIConnectionTimeoutError) return "Claudeの判定が時間内に終わりませんでした。もう一度お試しください。";
  if (caught instanceof Anthropic.APIConnectionError) return "Claude APIに接続できませんでした。ネットワークを確認してください。";
  if (caught instanceof Anthropic.APIError) return `Claude APIエラー (HTTP ${caught.status ?? "?"}): ${caught.message.slice(0, 240)}`;
  return caught instanceof Error ? caught.message : "Claudeでの判定に失敗しました。";
}
