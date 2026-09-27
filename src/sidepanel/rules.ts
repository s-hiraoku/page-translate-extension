import type { CandidateSegment, TargetLanguage } from "../shared/types";

/**
 * Text rules the side panel applies to scanned segments before and after Jev.
 * Kept free of DOM and extension APIs so they can be unit-tested.
 */

/**
 * Text that is already written in the target language needs no translation; drop it
 * before it reaches Jev so it never shows up as a card. Only the Japanese check is
 * reliable enough to run locally (Latin script is shared by many source languages).
 */
export function isInTargetLanguage(text: string, target: TargetLanguage): boolean {
  if (target !== "JA") return false;
  const japanese = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  return japanese > 0 && latin / (japanese + latin) < 0.3;
}

/**
 * A readable sentence of the main content, still in the source language. Jev "skip"
 * decisions on such text are overridden (translated and flagged) because they are more
 * likely a misjudged page type than site chrome.
 */
export function isMainProse(segment: CandidateSegment, target: TargetLanguage): boolean {
  if (segment.region !== "main" || segment.kind === "heading" || segment.kind === "control") return false;
  const text = segment.sourceText;
  if (text.length < 60 || segment.linkDensity >= 0.5 || !/[.!?。！？]/.test(text)) return false;
  // Code and CSS (braces, semicolons, parentheses) are not prose, whatever Jev missed.
  if ((text.match(/[{}();=<>[\]]/g) ?? []).length / text.length > 0.03) return false;
  const japanese = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const letters = japanese + latin;
  if (letters === 0) return false;
  // Only override when the text is clearly in the other language of the pair.
  return target === "JA" ? latin / letters > 0.7 : japanese / letters > 0.3;
}
