import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type {
  CandidateSegment,
  Decision,
  DisplayMode,
  ExtensionMessage,
  ExtensionSettings,
  FocusAnchor,
  ScanResult,
  SegmentState,
  TargetLanguage,
  TranslationEntry,
} from "../shared/types";
import { DATA_USE_CONSENT_KEY, DATA_USE_CONSENT_VERSION, DEFAULT_SETTINGS, SETTINGS_KEY } from "../shared/types";
import { Icon } from "./Icon";

interface DecisionResult {
  decisions: Array<{ id: string; decision: Decision; confidence: number }>;
}

interface TranslationResult {
  translations: Array<{ id: string; translatedText: string; translatedHtml: string }>;
}

interface ProviderStatus {
  providers: { jev: boolean; deepl: boolean };
}

const colors = ["#2c5cf0", "#e0702a", "#0f8a6c", "#9150c8", "#c23d5f", "#6f8517"];

/** Screen Y of the side panel viewport's top edge, learned from pointer events. */
let panelScreenTop: number | null = null;
window.addEventListener("pointermove", (event) => { panelScreenTop = event.screenY - event.clientY; }, { passive: true });
window.addEventListener("pointerdown", (event) => { panelScreenTop = event.screenY - event.clientY; }, { passive: true });

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
  /** Candidates the page scan or the local language check dropped before Jev saw them. */
  const [droppedCount, setDroppedCount] = useState(0);

  // Keep the page connector attached to the selected card while the panel scrolls or resizes.
  useEffect(() => {
    if (!selectedId) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const card = document.querySelector<HTMLElement>(`[data-entry-id="${selectedId}"]`);
      const anchor = card ? anchorFor(card, panelScreenTop) : undefined;
      if (anchor) void sendMessage({ type: "UPDATE_FOCUS_ANCHOR", anchor }).catch(() => undefined);
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [selectedId]);

  useEffect(() => {
    void chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
      if (stored[SETTINGS_KEY]) {
        setSettings({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<ExtensionSettings>) });
      }
    });
  }, []);

  // Jev's "skip" decisions are not part of the article: they never appear in the list.
  const visibleEntries = useMemo(() => entries.filter((entry) => entry.state !== "skipped"), [entries]);
  const hiddenCount = droppedCount + entries.length - visibleEntries.length;
  const translatedCount = useMemo(() => visibleEntries.filter((entry) => entry.state === "translated").length, [visibleEntries]);

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
    setDroppedCount(0);
    setSelectedId(null);
    setStatus("ページの文章を調べています…");
    try {
      await sendMessage({ type: "RESTORE_PAGE" }).catch(() => undefined);
      const page = await sendMessage<ScanResult>({ type: "SCAN_ACTIVE_TAB" });
      setPageTitle(page.title);
      setPageUrl(new URL(page.url).hostname);
      const candidates = page.segments.filter((segment) => !isInTargetLanguage(segment.sourceText, settings.targetLanguage));
      setDroppedCount(page.excludedCount + page.segments.length - candidates.length);
      if (candidates.length === 0) {
        setStatus("翻訳が必要な本文が見つかりませんでした。");
        return;
      }

      setStatus(`本文の${candidates.length}件をJevが確認しています…`);
      const classifications = await sendMessage<DecisionResult>({
        type: "CLASSIFY_CANDIDATES",
        segments: candidates,
        targetLanguage: settings.targetLanguage,
        pageTitle: page.title,
        mainContentDetected: page.mainContentDetected,
      });
      const byId = new Map(classifications.decisions.map((decision) => [decision.id, decision]));
      const next: TranslationEntry[] = candidates.map((segment) => {
        const decision = byId.get(segment.id);
        const state: SegmentState = decision?.decision === "skip" ? "skipped" : decision?.decision === "translate" ? "pending" : "review";
        return {
          ...segment,
          state,
          reason: state === "review" ? "Jevの判定を確認してください。" : undefined,
        };
      });
      setEntries(next);
      const pending = next.filter((entry) => entry.state === "pending");
      if (pending.length > 0) {
        setStatus(`${pending.length}件を翻訳しています…`);
        try {
          const translated = await requestTranslations(pending);
          for (const result of translated) {
            const entry = next.find((item) => item.id === result.id);
            if (entry) Object.assign(entry, result, { state: "translated", reason: undefined });
          }
        } catch (caught) {
          const message = errorMessage(caught);
          setError(message);
          for (const entry of pending) {
            const current = next.find((item) => item.id === entry.id);
            if (current) Object.assign(current, { state: "review", reason: "翻訳に失敗しました。再試行できます。" });
          }
        }
      }

      const finalEntries = [...next];
      setEntries(finalEntries);
      const shown = finalEntries.filter((entry) => entry.state !== "skipped").length;
      setStatus(shown > 0 ? `本文の${shown}件を表示しています。` : "翻訳が必要な本文が見つかりませんでした。");
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

  async function focusEntry(entry: TranslationEntry, index: number, event: ReactMouseEvent<HTMLElement>): Promise<void> {
    setSelectedId(entry.id);
    setError("");
    try {
      const result = await sendMessage<{ focused: boolean }>({
        type: "FOCUS_SEGMENT",
        segmentId: entry.id,
        anchor: cardAnchor(event),
        label: String(index + 1),
        color: entryColor(index),
      });
      if (!result?.focused) setError("ページが変わったため原文の位置が見つかりません。もう一度翻訳してください。");
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

  const progress = visibleEntries.length > 0 ? translatedCount / visibleEntries.length : 0;

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <img className="brand-mark" src="/icons/icon48.png" alt="" width="32" height="32" />
        <div className="brand-copy">
          <p className="eyebrow">Page Translate</p>
          <h1>ページ翻訳</h1>
        </div>
        <button
          className={`icon-button ${settingsOpen ? "active" : ""}`}
          type="button"
          aria-label={settingsOpen ? "翻訳画面に戻る" : "接続設定を開く"}
          aria-pressed={settingsOpen}
          onClick={() => { const open = !settingsOpen; setSettingsOpen(open); if (open) void checkProviders(); }}
        >
          <Icon name="settings" />
        </button>
      </header>

      {settingsOpen ? (
        <section className="settings-page" aria-labelledby="settings-title">
          <button className="text-button settings-back" type="button" onClick={() => setSettingsOpen(false)}>
            <Icon name="back" />翻訳画面に戻る
          </button>
          <p className="eyebrow">Translation services</p>
          <h2 id="settings-title">接続設定</h2>
          <p className="settings-intro">翻訳対象の判定にTypeSafe Jev、翻訳にDeepLを使います。それぞれのAPIキーを登録してください。</p>

          <div className="provider-card">
            <div className="provider-card-heading">
              <div><h3>TypeSafe Jev</h3><p>ページから翻訳する本文を選びます。</p></div>
              <span className={`badge ${providerStatus?.providers.jev ? "ready" : "missing"}`}>{providerStatus?.providers.jev ? "登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="typesafe-api-key">APIキー</label>
            <input id="typesafe-api-key" className="field" type="password" autoComplete="new-password" spellCheck={false} value={typesafeApiKey} onChange={(event) => setTypesafeApiKey(event.target.value)} placeholder={providerStatus?.providers.jev ? "登録済み · 変更時だけ入力" : "TypeSafe JevのAPIキー"} />
          </div>

          <div className="provider-card">
            <div className="provider-card-heading">
              <div><h3>DeepL</h3><p>Jevが選んだ本文を翻訳します。</p></div>
              <span className={`badge ${providerStatus?.providers.deepl ? "ready" : "missing"}`}>{providerStatus?.providers.deepl ? "登録済み" : "未設定"}</span>
            </div>
            <label className="field-label" htmlFor="deepl-plan">APIプラン</label>
            <select id="deepl-plan" className="field" value={settings.deeplPlan} onChange={(event) => void persistSettings({ ...settings, deeplPlan: event.target.value === "pro" ? "pro" : "free" })}>
              <option value="free">API Free</option>
              <option value="pro">API Pro</option>
            </select>
            <label className="field-label" htmlFor="deepl-api-key">APIキー</label>
            <input id="deepl-api-key" className="field" type="password" autoComplete="new-password" spellCheck={false} value={deeplApiKey} onChange={(event) => setDeeplApiKey(event.target.value)} placeholder={providerStatus?.providers.deepl ? "登録済み · 変更時だけ入力" : "DeepL APIキー"} />
          </div>

          {error && <div className="error-banner" role="alert"><Icon name="alert" />{error}</div>}
          <button className="button primary block" type="button" onClick={() => void saveProviderKeys()} disabled={savingKeys}>
            <Icon name="key" />{savingKeys ? "保存しています…" : "APIキーを保存"}
          </button>
          <button className="text-button danger block" type="button" onClick={() => void clearProviderKeys()} disabled={!providerStatus?.providers.jev && !providerStatus?.providers.deepl}>
            <Icon name="trash" />保存中のAPIキーを削除
          </button>
          <p className="note"><Icon name="shield" />キーはメモリ上に保持し、ページ側には渡しません。Chromeを終了または拡張機能を再読み込みすると消えるため、次回は再入力してください。問い合わせ時はTypeSafe JevまたはDeepLへ直接送信します。</p>
        </section>
      ) : (
        <>
          <section className="controls">
            <div className="page-context">
              <span className="favicon-dot" aria-hidden="true">{pageUrl ? pageUrl.replace(/^www\./, "").slice(0, 1).toUpperCase() : <Icon name="inline" />}</span>
              <div className="page-context-text">
                <strong title={pageTitle || "現在のページ"}>{pageTitle || "現在のページ"}</strong>
                <small>{pageUrl || "タブを選んで翻訳を開始"}</small>
              </div>
              <label className="language-control">
                <span className="sr-only">翻訳先</span>
                <select
                  value={settings.targetLanguage}
                  onChange={(event) => void persistSettings({ ...settings, targetLanguage: event.target.value as TargetLanguage })}
                >
                  <option value="JA">日本語へ</option>
                  <option value="EN">英語へ</option>
                </select>
              </label>
            </div>

            <div className="mode-switch" role="group" aria-label="翻訳の表示方法">
              <button type="button" className={settings.displayMode === "source-panel" ? "active" : ""} aria-pressed={settings.displayMode === "source-panel"} onClick={() => void changeMode("source-panel")}>
                <Icon name="split" />原文＋訳文
              </button>
              <button type="button" className={settings.displayMode === "inline" ? "active" : ""} aria-pressed={settings.displayMode === "inline"} onClick={() => void changeMode("inline")}>
                <Icon name="inline" />ページ内
              </button>
            </div>

            <button className="button primary block translate-button" type="button" onClick={() => void startTranslation()} disabled={busy} aria-busy={busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="translate" />}
              {busy ? "翻訳しています…" : "このページを翻訳"}
            </button>

            <div className="status" role="status" aria-live="polite">
              <div className="status-row">
                <span className={`status-dot ${busy ? "busy" : entries.length > 0 ? "done" : ""}`} aria-hidden="true" />
                <span className="status-text">{status}</span>
                {visibleEntries.length > 0 && <b>{translatedCount}/{visibleEntries.length}</b>}
              </div>
              {(busy || visibleEntries.length > 0) && (
                <div className={`progress ${busy && visibleEntries.length === 0 ? "indeterminate" : ""}`} aria-hidden="true">
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
            </div>
          </section>

          {error && <div className="error-banner" role="alert"><Icon name="alert" />{error}</div>}

          {visibleEntries.length > 0 ? (
            <section className="results-section" aria-labelledby="results-title">
              <div className="results-heading">
                <h2 id="results-title">翻訳箇所</h2>
                <span className="count">{visibleEntries.length}</span>
              </div>
              {hiddenCount > 0 && (
                <p className="hidden-note"><Icon name="eyeOff" />本文外・翻訳対象外の{hiddenCount}件は表示していません</p>
              )}
              <ol className="entry-list">
                {visibleEntries.map((entry, index) => (
                  <li key={entry.id}>
                    <article data-entry-id={entry.id} className={`entry-card ${selectedId === entry.id ? "selected" : ""} ${entry.state}`} style={{ "--entry-color": entryColor(index) } as React.CSSProperties}>
                      <button className="entry-main" type="button" onClick={(event) => void focusEntry(entry, index, event)} aria-label={`${index + 1}番目：${entry.location}の原文位置へ移動`}>
                        <span className="entry-topline">
                          <span className="entry-number">{index + 1}</span>
                          <span className="entry-location">{entry.location}</span>
                          {entry.state !== "translated" && <span className={`badge ${entry.state}`}>{stateLabel(entry.state)}</span>}
                        </span>
                        {entry.state === "translated" ? (
                          <span className="entry-translation">{entry.translatedText}</span>
                        ) : (
                          <span className="entry-review">{entry.reason ?? "判定を確認してください。"}</span>
                        )}
                        <span className="entry-source" lang={settings.targetLanguage === "JA" ? "en" : "ja"}>{entry.sourceText}</span>
                      </button>
                      {entry.state === "review" && (
                        <button className="review-action" type="button" onClick={() => void translateOne(entry)}>
                          <Icon name="translate" />この文章を翻訳
                        </button>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <section className="empty-state">
              <div className="empty-illustration" aria-hidden="true">
                <span className="sheet source"><i /><i /><i /></span>
                <svg className="empty-connector" viewBox="0 0 56 40"><path d="M2 10 C 28 10, 28 30, 54 30" /><circle cx="2" cy="10" r="2.5" /><circle cx="54" cy="30" r="3.5" /></svg>
                <span className="sheet target"><i /><i /></span>
              </div>
              <h2>本文だけを、原文の位置と結んで翻訳</h2>
              <p>ナビゲーションや広告などを除いた本文を翻訳します。訳文を選ぶと、原文の位置までコネクタで結びます。</p>
              <ol className="steps">
                <li><span>1</span>本文を抽出</li>
                <li><span>2</span>Jevが翻訳対象を判定</li>
                <li><span>3</span>DeepLで翻訳</li>
              </ol>
            </section>
          )}

          <footer className="panel-footer">
            <span className="privacy"><Icon name="shield" />翻訳時は本文候補をJevへ、選ばれた文章をDeepLへ送信</span>
            {settings.displayMode === "inline" && translatedCount > 0 && (
              <button type="button" className="text-button" onClick={() => void sendMessage({ type: "RESTORE_PAGE" }).then(() => setStatus("原文に戻しました。")).catch((caught: unknown) => setError(errorMessage(caught)))}>
                <Icon name="restore" />原文に戻す
              </button>
            )}
          </footer>
        </>
      )}
      {consentOpen && (
        <div className="consent-backdrop">
          <section className="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title" aria-describedby="consent-description">
            <span className="consent-icon" aria-hidden="true"><Icon name="shield" /></span>
            <p className="eyebrow">Data use</p>
            <h2 id="consent-title">ページの文章を外部サービスへ送信します</h2>
            <p id="consent-description">翻訳を始めると、このページから抽出した文章とページタイトルがTypeSafe Jevに送られ、翻訳対象として選ばれた文章がDeepLに送られます。APIキーも認証のため各サービスへ送信します。</p>
            <p>送信先はTypeSafe JevとDeepLです。Page Translateの開発者が運営するサーバーには送信しません。個人情報や機密情報を含む文章を翻訳する場合は、利用するAPIプランの条件を確認してください。</p>
            <p className="provider-policy-links"><a href="https://typesafe.ai/legal/privacy-policy" target="_blank" rel="noreferrer">TypeSafeのプライバシー情報</a> · <a href="https://www.deepl.com/en/privacy" target="_blank" rel="noreferrer">DeepLのプライバシー情報</a></p>
            <div className="consent-actions">
              <button className="button secondary" type="button" onClick={() => setConsentOpen(false)}>キャンセル</button>
              <button className="button primary" type="button" onClick={() => void agreeAndTranslate()}>同意して翻訳を始める</button>
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

/**
 * Screen position of the clicked card's first line. The content script aligns the
 * source text and the end of the connector to this height.
 */
function cardAnchor(event: ReactMouseEvent<HTMLElement>): FocusAnchor | undefined {
  const card = event.currentTarget.closest<HTMLElement>(".entry-card") ?? event.currentTarget;
  // Real clicks carry screen coordinates; keyboard activation reports 0/0.
  return anchorFor(card, event.detail > 0 ? event.screenY - event.clientY : panelScreenTop);
}

function anchorFor(card: HTMLElement, panelTop: number | null): FocusAnchor | undefined {
  if (panelTop === null) return undefined;
  const rect = card.getBoundingClientRect();
  // Once the card leaves the panel, pin the connector to the nearest edge.
  const y = rect.top + Math.min(rect.height / 2, 22);
  return { screenY: panelTop + Math.min(Math.max(y, 8), window.innerHeight - 8) };
}

function entryColor(index: number): string {
  return colors[index % colors.length] ?? colors[0];
}

/**
 * Text that is already written in the target language needs no translation; drop it
 * before it reaches Jev so it never shows up as a card. Only the Japanese check is
 * reliable enough to run locally (Latin script is shared by many source languages).
 */
function isInTargetLanguage(text: string, target: TargetLanguage): boolean {
  if (target !== "JA") return false;
  const japanese = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  return japanese > 0 && latin / (japanese + latin) < 0.3;
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
