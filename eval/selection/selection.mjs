// Cases, judge call and grader of the body-text selection eval (see README.md).
// Imported by run-eval.mjs and check.mjs; run under bun, which loads the extension's TypeScript.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCandidates, classifyWithClaude } from '../../src/background/providers.ts';
import { isInTargetLanguage, isMainProse } from '../../src/sidepanel/rules.ts';

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cases');
export const TARGET = 'JA';
export const JUDGES = ['none', 'jev', 'claude', 'oracle', 'skip-all'];

// The extension reads its keys and settings from chrome.storage. Stand in for it:
// keys from the environment, and Chrome's translator so DeepL is not required.
globalThis.chrome = {
  storage: {
    session: { get: async () => ({ pageTranslateProviderKeys: {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '', typesafeApiKey: process.env.TYPESAFE_API_KEY ?? '', deeplApiKey: '' } }) },
    local: { get: async () => ({ pageTranslateSettings: { translationProvider: 'chrome' } }) },
  },
};
// The extension never sees a base URL override: neither does the eval.
delete process.env.ANTHROPIC_BASE_URL;

// Every request a judge makes, recorded per case for the transcript (keys left out).
const exchanges = new AsyncLocalStorage();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const log = exchanges.getStore();
  const response = await realFetch(input, init);
  if (log) {
    const url = typeof input === 'string' ? input : input.url;
    const body = await response.clone().json().catch(() => null);
    log.push({ url: url.replace(/\?.*$/, ''), request: init?.body ? JSON.parse(String(init.body)) : null, status: response.status, response: body });
  }
  return response;
};

/** Cases are cases/<id>/ with candidates.json (from prepare.mjs scan) and labels.json (every candidate labeled). */
export async function loadCases() {
  const cases = [];
  for (const id of readdirSync(CASES_DIR).sort()) {
    const dir = join(CASES_DIR, id);
    if (!existsSync(join(dir, 'candidates.json'))) continue;
    const info = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
    const scan = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'));
    const labels = new Map(JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')).map((entry) => [entry.text, entry.label]));
    const segments = scan.segments.filter((segment) => !isInTargetLanguage(segment.sourceText, TARGET));
    const unlabeled = segments.filter((segment) => !['content', 'chrome', 'either'].includes(labels.get(segment.sourceText)));
    if (unlabeled.length) throw new Error(`${id}: ${unlabeled.length} candidates have no label in labels.json`);
    cases.push({
      id, prompt: `${info.url}\n${segments.length} candidates`, scan, segments, labels,
      tags: [info.source?.startsWith('e2e') ? 'fixture' : (info.tags?.[0] ?? 'page'), ...(info.tags?.slice(1) ?? [])],
      meta: { url: info.url, note: info.note },
    });
  }
  return cases;
}

/** Runs the chosen judge through the extension's own code, then applies the side panel's rule for what is shown. */
export async function runCase(input, ctx) {
  const { segments, scan } = input;
  const page = { mainContentDetected: scan.mainContentDetected, articleTitle: segments.find((s) => s.isArticleTitle)?.sourceText ?? '' };
  const log = [];
  let decisions;
  await exchanges.run(log, async () => {
    if (ctx.judge === 'jev') decisions = (await classifyCandidates(segments, TARGET, scan.title, page)).decisions;
    else if (ctx.judge === 'claude') decisions = (await classifyWithClaude(segments, TARGET, scan.title, page)).decisions;
    else decisions = segments.map((s) => ({
      id: s.id, confidence: 1,
      decision: ctx.judge === 'none' ? 'translate' : ctx.judge === 'skip-all' ? 'skip' : input.labels.get(s.sourceText) === 'chrome' ? 'skip' : 'translate',
    }));
  });
  const byId = new Map(decisions.map((d) => [d.id, d]));
  // Same as the side panel: "review" is translated, and a "skip" on main prose is overridden.
  const output = segments.map((s) => {
    const decision = byId.get(s.id)?.decision ?? 'review';
    return { id: s.id, decision, shown: decision !== 'skip' || isMainProse(s, TARGET) };
  });
  const claudeCalls = log.filter((e) => e.url.includes('api.anthropic.com'));
  const usage = claudeCalls.reduce((sum, e) => {
    for (const [k, v] of Object.entries(e.response?.usage ?? {})) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v;
    return sum;
  }, {});
  const transcript = [
    { role: 'user', content: segments.map((s, i) => `${i + 1}. [${s.region} · ${s.kind} · links ${Math.round(s.linkDensity * 100)}%] ${s.sourceText}`).join('\n') },
    ...log.flatMap((e) => [
      { role: 'tool_call', name: `POST ${e.url}`, content: JSON.stringify(e.request, null, 2) },
      { role: 'tool_result', content: JSON.stringify({ status: e.status, body: e.response }, null, 2) },
    ]),
    { role: 'assistant', content: output.map((o, i) => `${i + 1}. ${o.shown ? 'shown' : 'hidden'} (${o.decision}) · label ${input.labels.get(segments[i].sourceText)}`).join('\n') },
  ];
  return {
    output, transcript,
    model: claudeCalls.at(-1)?.response?.model ?? (ctx.judge === 'jev' ? 'jev-latest' : `rules-${ctx.judge}`),
    usage: claudeCalls.length ? usage : undefined,
    stop_reason: claudeCalls.at(-1)?.response?.stop_reason ?? 'end_turn',
    api_calls: log.length,
  };
}

/**
 * recall: share of content candidates shown (the reader's complaint is missed text).
 * specificity: share of chrome candidates hidden (1 when the page has none).
 * precision: share of shown, labeled candidates that are content. "either" is not scored.
 */
export async function gradeCase(input, run) {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  const missed = [], leaked = [];
  run.output.forEach((o, i) => {
    const text = input.segments[i].sourceText;
    const label = input.labels.get(text);
    if (label === 'content') { if (o.shown) tp++; else { fn++; missed.push(text.slice(0, 80)); } }
    if (label === 'chrome') { if (!o.shown) tn++; else { fp++; leaked.push(text.slice(0, 80)); } }
  });
  return {
    grade: {
      recall: tp + fn ? tp / (tp + fn) : 1,
      specificity: tn + fp ? tn / (tn + fp) : 1,
      precision: tp + fp ? tp / (tp + fp) : 1,
      content_missed: fn,
      chrome_shown: fp,
    },
    explanation: {
      recall: missed.length ? `missed: ${missed.join(' | ')}` : 'no content missed',
      specificity: leaked.length ? `shown: ${leaked.join(' | ')}` : 'no chrome shown',
    },
  };
}

/** Side-channel perf fields beyond the built-ins (latency_s etc.). */
export function perfFrom(run) { return { api_calls: run.api_calls }; }

