import { useEffect, useMemo, useState } from "react";
import type {
  CandidateSegment,
  Decision,
  DisplayMode,
  ExtensionMessage,
  ExtensionSettings,
  SegmentState,
  TargetLanguage,
  TranslationEntry,
} from "../shared/types";
import { DATA_USE_CONSENT_KEY, DATA_USE_CONSENT_VERSION, DEFAULT_SETTINGS, SETTINGS_KEY } from "../shared/types";

interface ScanResult {
  title: string;
  url: string;
  segments: CandidateSegment[];
}

interface DecisionResult {
  decisions: Array<{ id: string; decision: Decision; confidence: number }>;
}

interface TranslationResult {
  translations: Array<{ id: string; translatedText: string; translatedHtml: string }>;
}

interface ProviderStatus {
  providers: { jev: boolean; deepl: boolean };
}

const colors = ["#2368e8", "#d45e24", "#11836a", "#9b52c2", "#b23f58", "#77851b"];

export function SidePanel() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [pageTitle, setPageTitle] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("ページを開いて「翻訳を開始」を押してください。");
  const [error, setError] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typesafeApiKey, setTypesafeApiKey] = useState("");
  const [deeplApiKey, setDeeplApiKey] = useState("");
  const [savingKeys, setSavingKeys] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
      if (stored[SETTINGS_KEY]) {
        setSettings({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<ExtensionSettings>) });
      }
    });
  }, []);

  const translatedCount = useMemo(() => entries.filter((entry) => entry.state === "translated").length, [entries]);

  async function persistSettings(next: ExtensionSettings): Promise<void> {
    setSettings(next);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  }

  async function startTranslation(): Promise<void> {
    const consent = await chrome.storage.local.get(DATA_USE_CONSENT_KEY);
    if (consent[DATA_USE_CONSENT_KEY] !== DATA_USE_CONSENT_VERSION) {
      setConsentOpen(true);
      return;
    }
    await runTranslation();
  }

  async function agreeAndTranslate(): Promise<void> {
    await chrome.storage.local.set({ [DATA_USE_CONSENT_KEY]: DATA_USE_CONSENT_VERSION });
    setConsentOpen(false);
    await runTranslation();
  }

  async function runTranslation(): Promise<void> {
    setBusy(true);
    setError("");
    setEntries([]);
    setSelectedId(null);
    setStatus("ページの文章を調べています…");
    try {
      await sendMessage({ type: "RESTORE_PAGE" }).catch(() => undefined);
      const page = await sendMessage<ScanResult>({ type: "SCAN_ACTIVE_TAB" });
      setPageTitle(page.title);
      setPageUrl(new URL(page.url).hostname);
      if (page.segments.length === 0) {
        setStatus("翻訳できる文章が見つかりませんでした。");
        return;
      }

      setStatus(`${page.segments.length}件の候補をJevが確認しています…`);
      const classifications = await sendMessage<DecisionResult>({
        type: "CLASSIFY_CANDIDATES",
        segments: page.segments,
        targetLanguage: settings.targetLanguage,
        pageTitle: page.title,
      });
      const byId = new Map(classifications.decisions.map((decision) => [decision.id, decision]));
      const next: TranslationEntry[] = page.segments.map((segment) => {
        const decision = byId.get(segment.id);
        const state: SegmentState = decision?.decision === "skip" ? "skipped" : decision?.decision === "translate" ? "pending" : "review";
        return {
          ...segment,
          state,
          reason: state === "review" ? "Jevの判定を確認してください。" : undefined,
        };
      });
      setEntries(next);
      const candidates = next.filter((entry) => entry.state === "pending");
      if (candidates.length > 0) {
        setStatus(`${candidates.length}件を翻訳しています…`);
        try {
          const translated = await requestTranslations(candidates);
          for (const result of translated) {
            const entry = next.find((item) => item.id === result.id);
            if (entry) Object.assign(entry, result, { state: "translated", reason: undefined });
          }
        } catch (caught) {
          const message = errorMessage(caught);
          setError(message);
          for (const entry of candidates) {
            const current = next.find((item) => item.id === entry.id);
            if (current) Object.assign(current, { state: "review", reason: "翻訳に失敗しました。再試行できます。" });
          }
        }
      }

      const finalEntries = [...next];
      setEntries(finalEntries);
      setStatus(`${finalEntries.filter((entry) => entry.state !== "skipped").length}件を確認できます。`);
      if (settings.displayMode === "inline") await applyInline(finalEntries);
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus("処理を完了できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function requestTranslations(segments: CandidateSegment[]): Promise<Array<TranslationEntry & { translatedText: string; translatedHtml: string; state: "translated" }>> {
    const result = await sendMessage<TranslationResult>({
      type: "TRANSLATE_SEGMENTS",
      segments,
      targetLanguage: settings.targetLanguage,
    });
    return result.translations.map((translation) => {
      const source = segments.find((segment) => segment.id === translation.id);
      if (!source) throw new Error("翻訳結果と文章の対応が取れませんでした。");
      return { ...source, ...translation, state: "translated" as const };
    });
  }

  async function translateOne(entry: TranslationEntry): Promise<void> {
    setError("");
    setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, state: "error", reason: "翻訳中…" } : item));
    try {
      const [translated] = await requestTranslations([entry]);
      const next = entries.map((item) => item.id === entry.id ? translated : item);
      setEntries(next);
      if (settings.displayMode === "inline") await applyInline(next);
    } catch (caught) {
      setError(errorMessage(caught));
      setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, state: "review", reason: "翻訳に失敗しました。" } : item));
    }
  }

  async function changeMode(mode: DisplayMode): Promise<void> {
    const next = { ...settings, displayMode: mode };
    await persistSettings(next);
    if (mode === "inline") await applyInline(entries);
    else await sendMessage({ type: "RESTORE_PAGE" }).catch((caught: unknown) => setError(errorMessage(caught)));
  }

  async function applyInline(current: TranslationEntry[]): Promise<void> {
    const ready = current.filter((entry) => entry.state === "translated");
    if (ready.length === 0) return;
    const result = await sendMessage<{ applied: number }>({ type: "APPLY_TRANSLATIONS", entries: ready });
    setStatus(`ページ内に${result.applied}件を表示しています。`);
  }

  async function focusEntry(entry: TranslationEntry): Promise<void> {
    setSelectedId(entry.id);
    try {
      await sendMessage({ type: "FOCUS_SEGMENT", segmentId: entry.id });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function checkProviders(): Promise<void> {
    setError("");
    try {
      const result = await sendMessage<ProviderStatus>({ type: "CHECK_PROVIDERS" });
      setProviderStatus(result);
    } catch (caught) {
      setProviderStatus(null);
      setError(errorMessage(caught));
    }
  }

  async function saveProviderKeys(): Promise<void> {
    if (!typesafeApiKey.trim() && !deeplApiKey.trim()) {
      setError("保存するAPIキーを入力してください。");
      return;
    }
    setSavingKeys(true);
    setError("");
    try {
      const result = await sendMessage<ProviderStatus>({ type: "SAVE_PROVIDER_KEYS", typesafeApiKey, deeplApiKey });
      setProviderStatus(result);
      setTypesafeApiKey("");
      setDeeplApiKey("");
      setStatus("APIキーをこのChromeセッション中だけ保存しました。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingKeys(false);
    }
  }

  async function clearProviderKeys(): Promise<void> {
    setError("");
    try {
      const result = await sendMessage<ProviderStatus>({ type: "CLEAR_PROVIDER_KEYS" });
      setProviderStatus(result);
      setTypesafeApiKey("");
      setDeeplApiKey("");
      setStatus("保存中のAPIキーを削除しました。");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div className="brand-mark" aria-hidden="true">P<span>↔</span>T</div>
        <div className="brand-copy">
          <p className="eyebrow">PAGE TRANSLATE</p>
          <h1>ページ翻訳</h1>
        </div>
        <button className="icon-button settings-trigger" type="button" aria-label={settingsOpen ? "翻訳画面に戻る" : "接続設定を開く"} onClick={() => { const open = !settingsOpen; setSettingsOpen(open); if (open) void checkProviders(); }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/><path d="m19.4 13.5 1.1.8-1.4 2.4-1.3-.5a7.8 7.8 0 0 1-1.6.9l-.2 1.4h-2.8l-.2-1.4a7.8 7.8 0 0 1-1.6-.9l-1.3.5-1.4-2.4 1.1-.8a7.4 7.4 0 0 1 0-1.9l-1.1-.8 1.4-2.4 1.3.5a7.8 7.8 0 0 1 1.6-.9l.2-1.4h2.8l.2 1.4a7.8 7.8 0 0 1 1.6.9l1.3-.5 1.4 2.4-1.1.8a7.4 7.4 0 0 1 0 1.9Z"/></svg>
        </button>
      </header>

      {settingsOpen ? (
        <section className="settings-page" aria-labelledby="settings-title">
          <button className="settings-back" type="button" onClick={() => setSettingsOpen(false)}>← 翻訳画面に戻る</button>
          <p className="eyebrow">TRANSLATION SERVICES</p>
          <h2 id="settings-title">接続設定</h2>
          <p className="settings-intro">翻訳対象の判定にTypeSafe Jev、翻訳にDeepLを使います。それぞれのAPIキーを登録してください。</p>

          <div className="provider-card">
            <div className="provider-card-heading">
              <div><h3>TypeSafe Jev</h3><p>ページから翻訳する文章を選びます。</p></div>
              <span className={`provider-badge ${providerStatus?.providers.jev ? "ready" : "missing"}`}>{providerStatus?.providers.jev ? "キー登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="typesafe-api-key">APIキー</label>
            <input id="typesafe-api-key" className="secret-input" type="password" autoComplete="new-password" spellCheck={false} value={typesafeApiKey} onChange={(event) => setTypesafeApiKey(event.target.value)} placeholder={providerStatus?.providers.jev ? "登録済み · 変更時だけ入力" : "TypeSafe JevのAPIキー"} />
          </div>

          <div className="provider-card">
            <div className="provider-card-heading">
              <div><h3>DeepL</h3><p>Jevが選んだ文章を翻訳します。</p></div>
              <span className={`provider-badge ${providerStatus?.providers.deepl ? "ready" : "missing"}`}>{providerStatus?.providers.deepl ? "キー登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="deepl-plan">DeepL APIプラン</label>
            <select id="deepl-plan" className="secret-input" value={settings.deeplPlan} onChange={(event) => void persistSettings({ ...settings, deeplPlan: event.target.value === "pro" ? "pro" : "free" })}>
              <option value="free">API Free</option>
              <option value="pro">API Pro</option>
            </select>
            <label className="field-label" htmlFor="deepl-api-key">APIキー</label>
            <input id="deepl-api-key" className="secret-input" type="password" autoComplete="new-password" spellCheck={false} value={deeplApiKey} onChange={(event) => setDeeplApiKey(event.target.value)} placeholder={providerStatus?.providers.deepl ? "登録済み · 変更時だけ入力" : "DeepL APIキー"} />
          </div>

          {error && <div className="error-banner" role="alert"><span aria-hidden="true">!</span>{error}</div>}
          <button className="secondary-action save-keys" type="button" onClick={() => void saveProviderKeys()} disabled={savingKeys}>
            {savingKeys ? "保存しています…" : "APIキーを保存"}
          </button>
          <button className="clear-keys" type="button" onClick={() => void clearProviderKeys()} disabled={!providerStatus?.providers.jev && !providerStatus?.providers.deepl}>保存中のAPIキーを削除</button>
          <p className="settings-note">キーはメモリ上に保持し、ページ側には渡しません。Chromeを終了または拡張機能を再読み込みすると消えるため、次回は再入力してください。問い合わせ時はTypeSafe JevまたはDeepLへ直接送信します。</p>
        </section>
      ) : (
        <>
      <div className="page-context">
        <span className="context-dot" />
        <div>
          <strong title={pageTitle || "現在のページ"}>{pageTitle || "現在のページ"}</strong>
          <small>{pageUrl || "タブを選択してスキャン"}</small>
        </div>
        <label className="language-control">
          <span className="sr-only">翻訳先</span>
          <select
            value={settings.targetLanguage}
            onChange={(event) => void persistSettings({ ...settings, targetLanguage: event.target.value as TargetLanguage })}
          >
            <option value="JA">日本語</option>
            <option value="EN">English</option>
          </select>
        </label>
      </div>

      <div className="mode-switch" role="group" aria-label="翻訳の表示方法">
        <button type="button" className={settings.displayMode === "source-panel" ? "active" : ""} aria-pressed={settings.displayMode === "source-panel"} onClick={() => void changeMode("source-panel")}>
          <span className="mode-icon">原</span><span>原文＋訳文</span>
        </button>
        <button type="button" className={settings.displayMode === "inline" ? "active" : ""} aria-pressed={settings.displayMode === "inline"} onClick={() => void changeMode("inline")}>
          <span className="mode-icon">訳</span><span>ページ内</span>
        </button>
      </div>

      <button className="primary-action" type="button" onClick={() => void startTranslation()} disabled={busy}>
        <span aria-hidden="true">{busy ? "◌" : "文"}</span>
        {busy ? "翻訳しています…" : "このページを翻訳"}
        {!busy && <kbd>↵</kbd>}
      </button>
      <p className="privacy-note">翻訳時は候補の文章をJevへ送り、選ばれた文章をDeepLへ送信します。</p>

      <div className="progress-line" role="status" aria-live="polite">
        <span className={busy ? "status-pulse" : "status-dot"} />
        <span>{status}</span>
        {entries.length > 0 && <b>{translatedCount}/{entries.length}</b>}
      </div>

      {error && <div className="error-banner" role="alert"><span aria-hidden="true">!</span>{error}</div>}

      {entries.length > 0 ? (
        <section className="results-section" aria-labelledby="results-title">
          <div className="results-heading">
            <div><p className="eyebrow">LINKED SEGMENTS</p><h2 id="results-title">翻訳箇所</h2></div>
            <span className="result-count">{entries.length} 件</span>
          </div>
          <ol className="entry-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <article className={`entry-card ${selectedId === entry.id ? "selected" : ""} ${entry.state}`} style={{ "--entry-color": colors[entry.order % colors.length] } as React.CSSProperties}>
                  <button className="entry-main" type="button" onClick={() => void focusEntry(entry)} aria-label={`${entry.location}の原文位置へ移動`}>
                    <span className="entry-topline">
                      <span className="entry-number">{String(entry.order + 1).padStart(2, "0")}</span>
                      <span className="entry-location">{entry.location}</span>
                      <span className={`entry-state ${entry.state}`}>{stateLabel(entry.state)}</span>
                    </span>
                    <span className="entry-source">{entry.sourceText}</span>
                    {entry.state === "translated" ? (
                      <span className="entry-translation">{entry.translatedText}</span>
                    ) : entry.state === "skipped" ? (
                      <span className="entry-muted">翻訳対象外</span>
                    ) : (
                      <span className="entry-review">{entry.reason ?? "判定を確認してください。"}</span>
                    )}
                  </button>
                  {entry.state === "review" && (
                    <button className="review-action" type="button" onClick={() => void translateOne(entry)}>この文章を翻訳</button>
                  )}
                </article>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <section className="empty-state">
          <div className="empty-glyph" aria-hidden="true"><span>原文</span><i>↔</i><span>訳文</span></div>
          <h2>ページの文章を、位置ごとに翻訳</h2>
          <p>翻訳箇所を選ぶと、元の文章へ移動して短いコネクタで対応を示します。</p>
          <div className="empty-steps"><span>01 <b>文章を抽出</b></span><span>02 <b>Jevが判定</b></span><span>03 <b>DeepLで翻訳</b></span></div>
        </section>
      )}

      <footer className="panel-footer">
        {settings.displayMode === "inline" && translatedCount > 0 && (
          <button type="button" className="restore-button" onClick={() => void sendMessage({ type: "RESTORE_PAGE" }).then(() => setStatus("原文に戻しました。")).catch((caught: unknown) => setError(errorMessage(caught)))}>
            ↶ 原文に戻す
          </button>
        )}
        <span>翻訳先：{settings.targetLanguage === "JA" ? "日本語" : "English"}</span>
      </footer>

        </>
      )}
      {consentOpen && (
        <div className="consent-backdrop">
          <section className="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title" aria-describedby="consent-description">
            <p className="eyebrow">PAGE TRANSLATE · DATA USE</p>
            <h2 id="consent-title">ページの文章を外部サービスへ送信します</h2>
            <p id="consent-description">翻訳を始めると、このページから抽出した文章とページタイトルがTypeSafe Jevに送られ、翻訳対象として選ばれた文章がDeepLに送られます。APIキーも認証のため各サービスへ送信します。</p>
            <p>送信先はTypeSafe JevとDeepLです。Page Translateの開発者が運営するサーバーには送信しません。個人情報や機密情報を含む文章を翻訳する場合は、利用するAPIプランの条件を確認してください。</p>
            <p className="provider-policy-links"><a href="https://typesafe.ai/legal/privacy-policy" target="_blank" rel="noreferrer">TypeSafeのプライバシー情報</a> · <a href="https://www.deepl.com/en/privacy" target="_blank" rel="noreferrer">DeepLのプライバシー情報</a></p>
            <div className="consent-actions">
              <button className="consent-cancel" type="button" onClick={() => setConsentOpen(false)}>キャンセル</button>
              <button className="consent-accept" type="button" onClick={() => void agreeAndTranslate()}>同意して翻訳を始める</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

async function sendMessage<T = unknown>(message: ExtensionMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as T | { error?: string };
  if (typeof response === "object" && response !== null && "error" in response && response.error) {
    throw new Error(response.error);
  }
  return response as T;
}

function stateLabel(state: SegmentState): string {
  switch (state) {
    case "pending": return "翻訳待ち";
    case "translated": return "翻訳済み";
    case "review": return "要確認";
    case "skipped": return "対象外";
    case "error": return "失敗";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "処理に失敗しました。";
}
