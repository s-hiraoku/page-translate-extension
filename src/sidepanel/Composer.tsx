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

interface CheckResult {
  english: string;
  meaning: Outcome;
  model?: Outcome;
  polished: Outcome;
  usedPage: boolean;
}

const styleOptions: Array<{ value: WritingStyle; label: string }> = [
  { value: "default", label: "おまかせ" },
  { value: "simple", label: "やさしく" },
  { value: "casual", label: "カジュアル" },
  { value: "business", label: "ビジネス" },
  { value: "academic", label: "学術的" },
];

/**
 * Writing check for the reader's own English: what it conveys (back-translation),
 * how DeepL would say the intended Japanese (model answer), and DeepL Write's
 * correction, each compared word by word with what the reader wrote.
 */
export function Composer({ settings, deeplPlan, persistSettings, ensureConsent, getPageContext, sendMessage }: ComposerProps) {
  const [english, setEnglish] = useState("");
  const [japanese, setJapanese] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState("");
  const isPro = deeplPlan === "pro";

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
      const context = settings.composeUsePage ? await getPageContext().catch(() => "") : "";
      const intended = japanese.trim();
      const run = (message: ExtensionMessage): Promise<Outcome> =>
        sendMessage<{ text?: unknown }>(message).then(
          (value): Outcome => typeof value?.text === "string" ? { text: value.text } : { error: "結果を受け取れませんでした。" },
          (caught: unknown) => ({ error: caught instanceof Error ? caught.message : "確認に失敗しました。" }),
        );
      const [meaning, model, polished] = await Promise.all([
        run({ type: "COMPOSE_TRANSLATE", text: draft, targetLang: "JA", context }),
        intended ? run({ type: "COMPOSE_TRANSLATE", text: intended, targetLang: settings.englishVariant, context }) : Promise.resolve(undefined),
        isPro
          ? run({ type: "COMPOSE_REPHRASE", text: draft, targetLang: settings.englishVariant, style: settings.writingStyle })
          : Promise.resolve<Outcome>({
            unavailable: deeplPlan === "free"
              ? "DeepL Writeの添削は有料プランのキーで使えます。登録中のキーは無料プラン用のため、添削は表示しません。"
              : "DeepL Writeの添削は有料プランのキーで使えます。",
          }),
      ]);
      setResult({ english: draft, meaning, model, polished, usedPage: Boolean(context) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="composer" aria-labelledby="composer-title">
      <div className="composer-intro">
        <h2 id="composer-title">英作文チェック</h2>
        <p>自分で書いた英文が伝わるかを確かめ、DeepLの英訳や添削と見比べます。</p>
      </div>

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

      <label className="field-label" htmlFor="compose-japanese">言いたいこと（日本語・任意）</label>
      <textarea
        id="compose-japanese"
        className="field compose-area short"
        lang="ja"
        rows={3}
        maxLength={5000}
        value={japanese}
        placeholder="次のバージョンのリリース予定について質問したいです。"
        onChange={(event) => setJapanese(event.target.value)}
      />
      <p className="field-hint">書くと、DeepLのお手本の英訳と自分の英文を比べられます。</p>

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
            <span>添削の文体</span>
            <select className="field" value={settings.writingStyle} onChange={(event) => void persistSettings({ ...settings, writingStyle: event.target.value as WritingStyle })}>
              {styleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.composeUsePage} onChange={(event) => void persistSettings({ ...settings, composeUsePage: event.target.checked })} />
        <span>開いているページを文脈として使う<small>ページの話題に合った訳になりやすくなります。ページの本文もDeepLへ送信されます。</small></span>
      </label>

      <button className="button primary block" type="button" onClick={() => void check()} disabled={busy} aria-busy={busy}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="translate" />}
        {busy ? "確認しています…" : "英文をチェック"}
      </button>
      {error && <div className="error-banner compose-error" role="alert"><Icon name="alert" />{error}</div>}

      {result && (
        <div className="compose-results" aria-live="polite">
          <ResultCard title="伝わる意味" note="あなたの英文を日本語に訳し戻しました。意図どおりか確認してください。" outcome={result.meaning} lang="ja" />
          {result.model && (
            <ResultCard title="お手本の英訳" note="「言いたいこと」をDeepLが英訳しました。あなたの英文との違いを色で示します。" outcome={result.model} lang="en" compareTo={result.english} />
          )}
          <ResultCard title="DeepL Writeの添削" note="綴りや文法を直し、読みやすく整えた英文です。" outcome={result.polished} lang="en" compareTo={result.english} />
          <p className="compose-legend">
            <del>赤の取り消し線</del>はあなたの英文から変わった部分、<ins>緑</ins>は提案です。
            {result.usedPage && " ページを文脈として使いました。"}
          </p>
        </div>
      )}
      <p className="note"><Icon name="shield" />入力した英文と日本語はDeepLへ直接送信されます。拡張機能には保存しません。</p>
    </section>
  );
}

function ResultCard({ title, note, outcome, lang, compareTo }: { title: string; note: string; outcome: Outcome; lang: string; compareTo?: string }) {
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
        {text && compareTo !== undefined && (
          <button className="text-button" type="button" onClick={() => void copy()}>{copied ? "コピーしました" : "コピー"}</button>
        )}
      </header>
      <p className="compose-card-note">{note}</p>
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
