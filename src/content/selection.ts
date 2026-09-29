import { SELECTION_MAX_CHARS } from "../shared/types";

/**
 * Tidies selected text for translation: no-break spaces and runs of blanks become one space
 * and blank lines are collapsed, but line breaks between blocks are kept so DeepL sees paragraphs.
 */
export function normalizeSelectionText(raw: string): string {
  return raw
    .replace(/[ \t ​]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text worth sending to DeepL: something to read, not a stray click, and not more than we translate. */
export function isTranslatableSelection(text: string): boolean {
  return text.length >= 2 && text.length <= SELECTION_MAX_CHARS && /\p{L}/u.test(text);
}

const IGNORED = "[data-page-translate-ui], input, textarea, select, [contenteditable=''], [contenteditable='true']";

/** A selection made inside the extension's own UI or a form field is left alone. */
export function isIgnoredNode(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element === null || element.closest(IGNORED) !== null;
}

export interface CurrentSelection {
  text: string;
  range: Range;
}

/** The reader's current selection if it is translatable text of the page. */
export function readCurrentSelection(doc: Document = document): CurrentSelection | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (isIgnoredNode(range.startContainer) || isIgnoredNode(range.endContainer) || isIgnoredNode(range.commonAncestorContainer)) return null;
  const text = normalizeSelectionText(selection.toString());
  return isTranslatableSelection(text) ? { text, range: range.cloneRange() } : null;
}
