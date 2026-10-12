import { glossaryFor, parseGlossary, type GlossaryEntry } from "./glossary";

/**
 * The reader's dictionary: reference material Claude follows when it translates, kept as one text
 * the reader can read, edit and copy. It has three sections:
 *
 *   ## 訳し方の方針      how to translate: register, sentence endings, what stays in English
 *   ## 用語              "term = translation", one per line
 *   ## 例文              a source passage and its model translation, "原文:" then "訳文:"
 *
 * Text before any section heading is read as terms, so a glossary written before the dictionary
 * had sections still works.
 */

export type DictionarySection = "style" | "terms" | "examples";

export interface DictionaryExample {
  source: string;
  translation: string;
}

export interface Dictionary {
  style: string[];
  terms: GlossaryEntry[];
  examples: DictionaryExample[];
}

/** One message of the consultation before a dictionary is built. */
export type DictionaryTurn = { role: "reader" | "claude"; text: string };

/** What Claude suggests adding to (or, after a fix, changing in) the dictionary. */
export type DictionaryChanges = Dictionary;

export const SECTION_HEADINGS: Record<DictionarySection, string> = {
  style: "## 訳し方の方針",
  terms: "## 用語",
  examples: "## 例文",
};

/** The examples sent with a passage, and how much of the dictionary is sent at most (characters). */
const EXAMPLE_COUNT = 6;
const EXAMPLE_CHARS = 6_000;
const STYLE_CHARS = 3_000;
/** Examples sent when none is close to the passage, so Claude still sees the voice to write in. */
const ANCHOR_COUNT = 2;

function sectionOf(line: string): DictionarySection | null {
  const match = /^##\s*(.+?)\s*$/.exec(line.trim());
  if (!match) return null;
  const name = match[1]!;
  if (/方針|スタイル|style/i.test(name)) return "style";
  if (/例文|example/i.test(name)) return "examples";
  if (/用語|term|glossary/i.test(name)) return "terms";
  return null;
}

/** Each line of the text with the section it belongs to (null for a section heading). */
function classify(text: string): Array<{ line: string; section: DictionarySection | null }> {
  let current: DictionarySection = "terms";
  return text.split(/\r?\n/).map((line) => {
    const heading = sectionOf(line);
    if (heading) {
      current = heading;
      return { line, section: null };
    }
    return { line, section: current };
  });
}

const SOURCE_LABEL = /^(?:原文|source)\s*[:：]\s*/i;
const TRANSLATION_LABEL = /^(?:訳文|translation)\s*[:：]\s*/i;

export function parseDictionary(text: string): Dictionary {
  const style: string[] = [];
  const termLines: string[] = [];
  const examples: DictionaryExample[] = [];
  let example: { source: string; translation: string; field: "source" | "translation" } | null = null;
  const finish = () => {
    if (example && example.source.trim() && example.translation.trim()) examples.push({ source: example.source.trim(), translation: example.translation.trim() });
    example = null;
  };
  for (const { line, section } of classify(text)) {
    const trimmed = line.trim();
    if (section !== "examples") finish();
    if (section === null || !trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("##"))) continue;
    if (section === "terms") termLines.push(trimmed);
    else if (section === "style") style.push(trimmed.replace(/^(?:[-*・]\s*)/, ""));
    else if (SOURCE_LABEL.test(trimmed)) {
      finish();
      example = { source: trimmed.replace(SOURCE_LABEL, ""), translation: "", field: "source" };
    } else if (TRANSLATION_LABEL.test(trimmed) && example) {
      example.field = "translation";
      example.translation = trimmed.replace(TRANSLATION_LABEL, "");
    } else if (example) {
      // A passage may run over several lines.
      example[example.field] += `\n${trimmed}`;
    }
  }
  finish();
  return { style: style.filter(Boolean), terms: parseGlossary(termLines.join("\n")), examples };
}

export function isEmptyDictionary(dictionary: Dictionary): boolean {
  return dictionary.style.length === 0 && dictionary.terms.length === 0 && dictionary.examples.length === 0;
}

/** "方針 3件・用語 40語・例文 12件", or "" for an empty dictionary. */
export function describeDictionary(dictionary: Dictionary): string {
  const parts = [
    dictionary.style.length > 0 ? `方針 ${dictionary.style.length}件` : "",
    dictionary.terms.length > 0 ? `用語 ${dictionary.terms.length}語` : "",
    dictionary.examples.length > 0 ? `例文 ${dictionary.examples.length}件` : "",
  ].filter(Boolean);
  return parts.join("・");
}

/** The words of a text for comparing it with an example: Latin words, and pairs of Japanese characters. */
function features(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []) result.add(word);
  for (const run of text.match(/[぀-ヿ一-鿿]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index++) result.add(run.slice(index, index + 2));
  }
  return result;
}

/**
 * The examples closest to a text, closest first: those sharing the most words with it. When none
 * shares a word, the first few examples are returned, so the voice to write in is still shown.
 */
export function relevantExamples(examples: DictionaryExample[], text: string, count = EXAMPLE_COUNT, maxChars = EXAMPLE_CHARS): DictionaryExample[] {
  if (examples.length === 0) return [];
  const wanted = features(text);
  const scored = examples.map((example, index) => {
    const own = features(`${example.source}\n${example.translation}`);
    let shared = 0;
    for (const feature of own) if (wanted.has(feature)) shared += 1;
    // Long examples share more words by chance: weigh by their size.
    return { example, index, score: shared / Math.sqrt(own.size || 1) };
  });
  const close = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = close.length > 0 ? close.slice(0, count) : scored.slice(0, ANCHOR_COUNT);
  const result: DictionaryExample[] = [];
  let size = 0;
  for (const { example } of chosen) {
    const length = example.source.length + example.translation.length;
    if (result.length > 0 && size + length > maxChars) break;
    result.push(example);
    size += length;
  }
  return result;
}

/** What the translation of a text gets from the dictionary; null when nothing applies. */
export type DictionaryPayload = { style?: string[]; terms?: GlossaryEntry[]; examples?: DictionaryExample[] };

/**
 * The parts of the dictionary sent with a text: the whole style guide, the terms the text uses,
 * and the examples closest to it. `reverseFirst` as in glossaryFor.
 */
export function dictionaryFor(dictionary: Dictionary, text: string, reverseFirst = false): DictionaryPayload | null {
  const style: string[] = [];
  let size = 0;
  for (const rule of dictionary.style) {
    if (size + rule.length > STYLE_CHARS) break;
    style.push(rule);
    size += rule.length;
  }
  const terms = glossaryFor(dictionary.terms, text, reverseFirst);
  const examples = relevantExamples(dictionary.examples, text);
  if (style.length === 0 && terms.length === 0 && examples.length === 0) return null;
  return {
    ...(style.length > 0 ? { style } : {}),
    ...(terms.length > 0 ? { terms } : {}),
    ...(examples.length > 0 ? { examples } : {}),
  };
}

/** One line, so it reads back as the same rule, term or passage. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function exampleLines(example: DictionaryExample): string[] {
  return [`原文: ${oneLine(example.source)}`, `訳文: ${oneLine(example.translation)}`, ""];
}

/** The text with `lines` added at the end of a section (created at the end of the text if missing). */
function appendToSection(text: string, section: DictionarySection, lines: string[]): string {
  const body = lines.slice();
  while (body.length > 0 && !body[body.length - 1]!.trim()) body.pop();
  if (body.length === 0) return text;
  const all = text.split(/\r?\n/);
  const rows = classify(text);
  const headingIndex = rows.findIndex((row) => row.section === null && sectionOf(row.line) === section);
  let start: number;
  if (headingIndex >= 0) start = headingIndex + 1;
  // Terms written before any heading (a glossary from before sections) are the terms section.
  else if (section === "terms" && rows.some((row) => row.section === "terms" && row.line.trim())) start = 0;
  else {
    const base = text.replace(/\s+$/, "");
    return `${base}${base ? "\n\n" : ""}${SECTION_HEADINGS[section]}\n${body.join("\n")}\n`;
  }
  // The section runs until the next heading; the lines go after its last non-empty line.
  let end = start;
  while (end < rows.length && rows[end]!.section !== null) end += 1;
  let last = end;
  while (last > start && !all[last - 1]!.trim()) last -= 1;
  const gap = section !== "style" && last > start ? [""] : [];
  const tail = all.slice(end);
  return [...all.slice(0, last), ...gap, ...body, ...(tail.length > 0 ? ["", ...tail] : [])].join("\n").replace(/\n*$/, "\n");
}

/**
 * The dictionary text with Claude's suggestions written in. A term already in the dictionary is
 * replaced when `replace` is set (a fix the reader asked for) and left as it is otherwise (the
 * reader's own line wins over a suggestion); an example with the same source replaces the old one
 * likewise; a rule already there is not repeated. `note` marks where the new lines came from.
 * Also returns how many changed.
 */
export function applyDictionaryChanges(text: string, changes: DictionaryChanges, replace: boolean, note: string): { text: string; changed: number } {
  const current = parseDictionary(text);
  let changed = 0;

  // Terms: replace in place, or collect the new ones.
  const pending = new Map<string, GlossaryEntry>();
  for (const entry of changes.terms) pending.set(entry.term.toLowerCase(), { term: oneLine(entry.term), translation: oneLine(entry.translation) });
  const rows = classify(text);
  const examplesToReplace = new Map<string, DictionaryExample>();
  for (const example of changes.examples) examplesToReplace.set(oneLine(example.source).toLowerCase(), example);
  const knownSources = new Set(current.examples.map((example) => oneLine(example.source).toLowerCase()));
  const lines: string[] = [];
  let replacingTranslation = false;
  for (const { line, section } of rows) {
    if (section === "terms") {
      const [existing] = parseGlossary(line);
      const update = existing ? pending.get(existing.term.toLowerCase()) : undefined;
      if (existing && update) {
        pending.delete(existing.term.toLowerCase());
        if (replace && existing.translation !== update.translation) {
          changed += 1;
          lines.push(`${existing.term} = ${update.translation}`);
          continue;
        }
      }
    }
    if (section === "examples" && replace) {
      const trimmed = line.trim();
      if (SOURCE_LABEL.test(trimmed)) {
        const update = examplesToReplace.get(oneLine(trimmed.replace(SOURCE_LABEL, "")).toLowerCase());
        replacingTranslation = Boolean(update);
        if (update) {
          lines.push(line);
          lines.push(`訳文: ${oneLine(update.translation)}`);
          examplesToReplace.delete(oneLine(update.source).toLowerCase());
          changed += 1;
          continue;
        }
      } else if (replacingTranslation) {
        // The old translation (and its continuation lines) is dropped for the new one.
        if (!trimmed) {
          replacingTranslation = false;
          lines.push(line);
        }
        continue;
      }
    } else replacingTranslation = false;
    lines.push(line);
  }
  let next = lines.join("\n");

  const knownRules = new Set(current.style.map((rule) => rule.toLowerCase()));
  const rules = [...new Set(changes.style.map(oneLine).filter((rule) => rule && !knownRules.has(rule.toLowerCase())))];
  const terms = [...pending.values()].filter((entry) => entry.term && entry.translation);
  const examples = changes.examples.filter((example) => {
    const key = oneLine(example.source).toLowerCase();
    return oneLine(example.source) && oneLine(example.translation) && !knownSources.has(key);
  });
  changed += rules.length + terms.length + examples.length;

  next = appendToSection(next, "style", rules.map((rule) => `- ${rule}`));
  next = appendToSection(next, "terms", terms.length > 0 ? [`# ${note}`, ...terms.map((entry) => `${entry.term} = ${entry.translation}`)] : []);
  next = appendToSection(next, "examples", examples.flatMap(exampleLines));
  return { text: next, changed };
}

