import { useState } from "react";
import type { DeepLPlan, EnglishVariant, ExtensionMessage, ExtensionSettings, WritingStyle } from "../shared/types";
import { diffWords, hasChanges, type DiffPart } from "./diff";
import { Icon } from "./Icon";

interface ComposerProps {
  settings: ExtensionSettings;
  /** Plan of the registered DeepL key; DeepL Write needs a paid plan. */
  deeplPlan: DeepLPlan | null;
  persistSettings: (next: ExtensionSettings) => Promise<void>;
  /** Resolves true once the reader has agreed to send text to the translation services. */
  ensureConsent: () => Promise<boolean>;
  /** Text of the open page, used as DeepL context so wording fits what the reader is replying to. */
  getPageContext: () => Promise<string>;
  sendMessage: <T>(message: ExtensionMessage) => Promise<T>;
}

type Outcome = { text: string } | { error: string } | { unavailable: string };
type ComposeMode = "check" | "translate";

/** Checking the reader's own English against what they meant. */
interface CheckResult {
  kind: "check";
  english: string;
  intended: string;
  meaning: Outcome;
  model?: Outcome;
  polished: Outcome;
  usedPage: boolean;
}

/** Putting the reader's Japanese into English, with a back-translation to confirm it. */
interface TranslateResult {
  kind: "translate";
  intended: string;
  english: Outcome;
  back?: Outcome;
  polished?: Outcome;
  usedPage: boolean;
}

const styleOptions: Array<{ value: WritingStyle; label: string }> = [
  { value: "default", label: "おまかせ" },
  { value: "simple", label: "やさしく" },
  { value: "casual", label: "カジュアル" },
  { value: "business", label: "ビジネス" },
  { value: "academic", label: "学術的" },
];

const modeOptions: Array<{ value: ComposeMode; label: string }> = [
  { value: "check", label: "英文をチェック" },
  { value: "translate", label: "日本語から英訳" },
];

/**
 * English writing help. "Check" compares the reader's own English with what it conveys
 * (back-translation), with DeepL's translation of what they meant, and with DeepL Write's
 * correction. "Translate" turns what they meant into English and translates it back so
 * they can confirm it says what they intended.
 *
 * Back-translations never get the page as context: they must show what the English says
 * on its own, not what it would mean on the page's topic.
 */
export function Composer({ settings, deeplPlan, persistSettings, ensureConsent, getPageContext, sendMessage }: ComposerProps) {
  const [mode, setMode] = useState<ComposeMode>("check");
  const [english, setEnglish] = useState("");
  const [japanese, setJapanese] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | TranslateResult | null>(null);
  const [error, setError] = useState("");
  const isPro = deeplPlan === "pro";

  const run = (message: ExtensionMessage): Promise<Outcome> =>
    sendMessage<{ text?: unknown }>(message).then(
      (value): Outcome => typeof value?.text === "string" ? { text: value.text } : { error: "結果を受け取れませんでした。" },
      (caught: unknown) => ({ error: caught instanceof Error ? caught.message : "確認に失敗しました。" }),
    );
  const writeUnavailable = (): Outcome => ({
    unavailable: deeplPlan === "free"
      ? "DeepL Writeの添削は有料プランのキーで使えます。登録中のキーは無料プラン用のため、添削は表示しません。"
      : "DeepL Writeの添削は有料プランのキーで使えます。",
  });
  const pageContext = async (): Promise<string> => settings.composePageContext ? getPageContext().catch(() => "") : "";

  async function check(): Promise<void> {
    const draft = english.trim();
    if (!draft) {
      setError("確認したい英文を入力してください。");
      return;
    }
    if (!(await ensureConsent())) return;
    setBusy(true);
    setError("");
    try {
      const intended = japanese.trim();
      const context = intended ? await pageContext() : "";
      const [meaning, model, polished] = await Promise.all([
        run({ type: "COMPOSE_TRANSLATE", text: draft, targetLang: "JA" }),
        intended ? run({ type: "COMPOSE_TRANSLATE", text: intended, targetLang: settings.englishVariant, context }) : Promise.resolve(undefined),
        isPro
          ? run({ type: "COMPOSE_REPHRASE", text: draft, targetLang: settings.englishVariant, style: settings.writingStyle })
          : Promise.resolve(writeUnavailable()),
      ]);
      setResult({ kind: "check", english: draft, intended, meaning, model, polished, usedPage: Boolean(context) });
    } finally {
      setBusy(false);
    }
  }

  async function translate(): Promise<void> {
    const intended = japanese.trim();
    if (!intended) {
      setError("英語にしたい日本語を入力してください。");
      return;
    }
    if (!(await ensureConsent())) return;
    setBusy(true);
    setError("");
    try {
      const context = await pageContext();
      const translated = await run({ type: "COMPOSE_TRANSLATE", text: intended, targetLang: settings.englishVariant, context });
      if (!("text" in translated)) {
        setResult({ kind: "translate", intended, english: translated, usedPage: Boolean(context) });
        return;
      }
      const [back, polished] = await Promise.all([
        run({ type: "COMPOSE_TRANSLATE", text: translated.text, targetLang: "JA" }),
        isPro
          ? run({ type: "COMPOSE_REPHRASE", text: translated.text, targetLang: settings.englishVariant, style: settings.writingStyle })
          : Promise.resolve(writeUnavailable()),
      ]);
      setResult({ kind: "translate", intended, english: translated, back, polished, usedPage: Boolean(context) });
    } finally {
      setBusy(false);
    }
  }

  function changeMode(next: ComposeMode): void {
    setMode(next);
    setResult(null);
    setError("");
  }

  const translatedEnglish = result?.kind === "translate" && "text" in result.english ? result.english.text : undefined;

  return (
    <section className="composer" aria-labelledby="composer-title">
      <div className="composer-intro">
        <h2 id="composer-title">英作文</h2>
        <p>{mode === "check"
          ? "自分で書いた英文が伝わるかを確かめ、DeepLの英訳や添削と見比べます。"
          : "言いたいことを日本語で書くと英語にします。日本語に訳し戻して、意図どおりか確かめられます。"}</p>
      </div>

      <div className="mode-switch compose-mode" role="radiogroup" aria-label="英作文の使い方">
        {modeOptions.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={mode === option.value} className={mode === option.value ? "active" : ""} onClick={() => changeMode(option.value)}>
            {option.label}
          </button>
        ))}
      </div>

      {mode === "check" && (
        <>
          <label className="field-label" htmlFor="compose-english">自分の英文</label>
          <textarea
            id="compose-english"
            className="field compose-area"
            lang="en"
            spellCheck
            rows={6}
            maxLength={5000}
            value={english}
            placeholder="I want to ask about the release schedule of next version."
            onChange={(event) => setEnglish(event.target.value)}
          />
          <div className="field-meta">{english.length.toLocaleString()} / 5,000</div>
        </>
      )}

      <label className="field-label" htmlFor="compose-japanese">{mode === "check" ? "言いたいこと（日本語・任意）" : "言いたいこと（日本語）"}</label>
      <textarea
        id="compose-japanese"
        className={`field compose-area ${mode === "check" ? "short" : ""}`}
        lang="ja"
        rows={mode === "check" ? 3 : 6}
        maxLength={5000}
        value={japanese}
        placeholder="次のバージョンのリリース予定について質問したいです。"
        onChange={(event) => setJapanese(event.target.value)}
      />
      {mode === "check"
        ? <p className="field-hint">書くと、DeepLのお手本の英訳と自分の英文を比べられます。</p>
        : <div className="field-meta">{japanese.length.toLocaleString()} / 5,000</div>}

      <div className="compose-options">
        <label className="compose-option">
          <span>英語</span>
          <select className="field" value={settings.englishVariant} onChange={(event) => void persistSettings({ ...settings, englishVariant: event.target.value as EnglishVariant })}>
            <option value="EN-US">アメリカ英語</option>
            <option value="EN-GB">イギリス英語</option>
          </select>
        </label>
        {isPro && (
          <label className="compose-option">
            <span>{mode === "check" ? "添削の文体" : "整える文体"}</span>
            <select className="field" value={settings.writingStyle} onChange={(event) => void persistSettings({ ...settings, writingStyle: event.target.value as WritingStyle })}>
              {styleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.composePageContext} onChange={(event) => void persistSettings({ ...settings, composePageContext: event.target.checked })} />
        <span>日本語を英訳するとき、開いているページを文脈として使う<small>ページの話題に合った英訳になりやすくなります。ページの本文もDeepLへ送信されます。訳し戻しには使いません。</small></span>
      </label>

      <button className="button primary block" type="button" onClick={() => void (mode === "check" ? check() : translate())} disabled={busy} aria-busy={busy}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="translate" />}
        {busy ? (mode === "check" ? "確認しています…" : "英訳しています…") : (mode === "check" ? "英文をチェック" : "英語にする")}
      </button>
      {error && <div className="error-banner compose-error" role="alert"><Icon name="alert" />{error}</div>}

      {result?.kind === "check" && (
        <div className="compose-results" aria-live="polite">
          <ResultCard title="伝わる意味" note="あなたの英文をそのまま日本語に訳し戻しました。言いたいことと同じか確認してください。" outcome={result.meaning} lang="ja" intended={result.intended} />
          {result.model && (
            <ResultCard title="お手本の英訳" note="「言いたいこと」をDeepLが英訳しました。あなたの英文との違いを色で示します。" outcome={result.model} lang="en" compareTo={result.english} />
          )}
          <ResultCard title="DeepL Writeの添削" note="綴りや文法を直し、読みやすく整えた英文です。" outcome={result.polished} lang="en" compareTo={result.english} />
          <p className="compose-legend">
            <del>赤の取り消し線</del>はあなたの英文から変わった部分、<ins>緑</ins>は提案です。
            {result.usedPage && " お手本の英訳にはページを文脈として使いました。"}
          </p>
        </div>
      )}

      {result?.kind === "translate" && (
        <div className="compose-results" aria-live="polite">
          <ResultCard title="英訳" note="言いたいことをDeepLが英訳しました。" outcome={result.english} lang="en" copyable />
          {result.back && (
            <ResultCard title="訳し戻し" note="英訳をそのまま日本語に戻しました。言いたいことと同じか確認してください。" outcome={result.back} lang="ja" intended={result.intended} />
          )}
          {result.polished && translatedEnglish !== undefined && (
            <ResultCard title="DeepL Writeで整えた英文" note="英訳を選んだ文体で整えました。英訳との違いを色で示します。" outcome={result.polished} lang="en" compareTo={translatedEnglish} />
          )}
          {result.usedPage && <p className="compose-legend">英訳にはページを文脈として使いました。</p>}
        </div>
      )}
      <p className="note"><Icon name="shield" />入力した英文と日本語はDeepLへ直接送信されます。拡張機能には保存しません。</p>
    </section>
  );
}

function ResultCard({ title, note, outcome, lang, compareTo, intended, copyable = false }: {
  title: string;
  note: string;
  outcome: Outcome;
  lang: string;
  /** Text the result is diffed against (the reader's English, or the translation). */
  compareTo?: string;
  /** What the reader meant, shown next to a back-translation for comparison. */
  intended?: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const text = "text" in outcome ? outcome.text : "";
  const parts: DiffPart[] | null = compareTo !== undefined && text ? diffWords(compareTo, text) : null;
  const unchanged = parts !== null && !hasChanges(parts);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="compose-card">
      <header>
        <h3>{title}</h3>
        {text && (compareTo !== undefined || copyable) && (
          <button className="text-button" type="button" onClick={() => void copy()}>{copied ? "コピーしました" : "コピー"}</button>
        )}
      </header>
      <p className="compose-card-note">{note}</p>
      {intended && (
        <p className="compose-intended" lang="ja"><span>言いたいこと</span>{intended}</p>
      )}
      {"error" in outcome && <p className="compose-card-error">{outcome.error}</p>}
      {"unavailable" in outcome && <p className="compose-card-muted">{outcome.unavailable}</p>}
      {text && (
        unchanged ? (
          <p className="compose-text" lang={lang}>{text}<span className="badge ready compose-same">あなたの英文と同じです</span></p>
        ) : parts ? (
          <p className="compose-text" lang={lang}>
            {parts.map((part, index) => part.kind === "same"
              ? <span key={index}>{part.text}</span>
              : part.kind === "removed" ? <del key={index}>{part.text}</del> : <ins key={index}>{part.text}</ins>)}
          </p>
        ) : (
          <p className="compose-text" lang={lang}>{text}</p>
        )
      )}
    </article>
  );
}
