import { CHATGPT_REDIRECT_URI, type ChatGPTAccount } from "../shared/types";
import type { JsonSchema, Translator } from "./claude";

/**
 * ChatGPT as the translator, through "Sign in with ChatGPT": the reader signs in with their ChatGPT
 * account and translations count against their ChatGPT plan instead of an API key's billing.
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * OpenAI's sign-in returns to a loopback address (127.0.0.1). An extension cannot listen there, so
 * the sign-in runs in a tab and the service worker reads the code from the tab's address as the
 * browser heads there; nothing has to answer on that port.
 */

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const API = "https://api.openai.com/v1";
/** Lets the response draw on the reader's ChatGPT plan. Without it the sign-in only identifies them. */
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** What the reader sees on OpenAI's consent screen as the app's name. */
const APP_NAME = "Page Translate";

/** Kept across restarts: which host this is, and the client OpenAI registered for it. Neither is a secret. */
const REGISTRATION_KEY = "pageTranslateChatGPTRegistration";
/** The signed-in session. Like the API keys, it lives in memory only and ends when Chrome closes. */
const SESSION_KEY = "pageTranslateChatGPTSession";

type Registration = { hostId: string; clientId?: string };
type Session = {
  email: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Date.now() after which the access token is refreshed first. */
  refreshAt: number;
  models: ChatGPTAccount["models"];
};
type TokenResponse = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown; scope?: unknown };

export async function chatgptAccount(): Promise<ChatGPTAccount | null> {
  const session = await readSession();
  return session ? { email: session.email, models: session.models } : null;
}

/** Opens OpenAI's sign-in in a tab, waits for the reader to finish there, and keeps the session. */
export async function signInChatGPT(): Promise<ChatGPTAccount> {
  const registration = await readRegistration();
  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(48);
  const url = authorizeUrl({ registration, state, nonce, challenge: await pkceChallenge(verifier) });
  const callback = await waitForCallback(url);
  const result = readCallback(callback, state);
  // OpenAI registered a client for this host on the first sign-in: keep it before anything can fail.
  const clientId = result.clientId ?? registration.clientId;
  if (!clientId) throw new Error("ChatGPTのログイン結果を読み取れませんでした。もう一度お試しください。");
  if (clientId !== registration.clientId) await chrome.storage.local.set({ [REGISTRATION_KEY]: { ...registration, clientId } satisfies Registration });

  const tokens = await requestTokens({ grant_type: "authorization_code", client_id: clientId, code: result.code, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT_URI, resource: API });
  const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/) : result.scopes;
  if (!scopes.includes(PLAN_SCOPE)) throw new Error("ChatGPTのプランで翻訳する許可がありませんでした。もう一度ログインして、プランの利用を許可してください。");
  const claims = readIdToken(tokens.id_token, { clientId, nonce, now: Date.now() });
  const session = sessionFrom(tokens, clientId, claims.email);
  session.models = await listModels(session.accessToken);
  await chrome.storage.session.set({ [SESSION_KEY]: session });
  return { email: session.email, models: session.models };
}

/** Ends the session at OpenAI (best effort) and forgets it here. */
export async function signOutChatGPT(): Promise<void> {
  const session = await readSession();
  await chrome.storage.session.remove(SESSION_KEY);
  if (!session) return;
  try {
    const config = await (await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })).json() as { revocation_endpoint?: unknown };
    if (typeof config.revocation_endpoint !== "string") return;
    await fetch(config.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: session.refreshToken, token_type_hint: "refresh_token", client_id: session.clientId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Signed out here either way; the reader can also disconnect the app in ChatGPT's settings.
  }
}

/** ChatGPT as a translator, with the model chosen in Settings (or the account's first). */
export async function chatgptTranslator(model: string): Promise<Translator> {
  const session = await readSession();
  if (!session) throw new Error(NOT_SIGNED_IN);
  const slug = session.models.some((item) => item.slug === model) ? model : session.models[0]?.slug;
  if (!slug) throw new Error("このChatGPTアカウントで使えるモデルが見つかりませんでした。");
  return { name: "ChatGPT", ask: (system, schema, content) => askChatGPT(slug, system, schema, content) };
}

const NOT_SIGNED_IN = "設定画面で「ChatGPTでログイン」を押してください。ChatGPTで翻訳するにはログインが必要です。";

async function askChatGPT(model: string, system: string, schema: JsonSchema, content: string): Promise<string> {
  const body = JSON.stringify({
    model,
    instructions: system,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", name: schema.name, schema: schema.schema, strict: true } },
    // Required for plan usage: nothing is kept on OpenAI's side, and the answer streams back.
    store: false,
    stream: true,
  });
  const send = async (token: string) => {
    try {
      return await fetch(`${API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (caught) {
      throw new Error(caught instanceof DOMException && caught.name === "TimeoutError"
        ? "ChatGPTの翻訳が時間内に終わりませんでした。もう一度お試しください。"
        : "ChatGPTに接続できませんでした。ネットワークを確認してください。");
    }
  };
  let response = await send(await accessToken());
  // The access token can expire or be revoked between the check and the request: refresh once.
  if (response.status === 401) response = await send(await accessToken(true));
  const text = await response.text();
  if (!response.ok) throw new Error(chatgptErrorMessage(response.status, text));
  return readResponseStream(text);
}

/** The text a streamed Responses answer carries. Only a stream that reached response.completed counts. */
export function readResponseStream(stream: string): string {
  let text = "";
  for (const event of parseEvents(stream)) {
    const type = event.type;
    if (type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
    else if (type === "response.completed") return outputText(event.response) ?? text;
    else if (type === "response.failed" || type === "error") {
      const error = (type === "error" ? event : (event.response as { error?: unknown } | undefined)?.error) as { code?: unknown; message?: unknown } | undefined;
      throw new Error(planErrorMessage(typeof error?.code === "string" ? error.code : "", typeof error?.message === "string" ? error.message : ""));
    } else if (type === "response.incomplete") {
      throw new Error("ChatGPTの翻訳が途中で終わりました。もう一度お試しください。");
    }
  }
  throw new Error("ChatGPTの翻訳が途中で途切れました。もう一度お試しください。");
}

function parseEvents(stream: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of stream.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as unknown;
      if (typeof event === "object" && event !== null) events.push(event as Record<string, unknown>);
    } catch {
      // A line that is not JSON carries nothing to read.
    }
  }
  return events;
}

function outputText(response: unknown): string | null {
  const output = (response as { output?: unknown } | undefined)?.output;
  if (!Array.isArray(output)) return null;
  const parts = output.flatMap((item: { type?: unknown; content?: unknown }) => item?.type === "message" && Array.isArray(item.content)
    ? (item.content as Array<{ type?: unknown; text?: unknown }>).flatMap((part) => part?.type === "output_text" && typeof part.text === "string" ? [part.text] : [])
    : []);
  return parts.length > 0 ? parts.join("") : null;
}

export function chatgptErrorMessage(status: number, body: string): string {
  let code = "";
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
    if (typeof parsed.error?.code === "string") code = parsed.error.code;
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
    else if (typeof parsed.detail === "string") message = parsed.detail;
  } catch {
    // Not JSON: the status says enough.
  }
  if (code) return planErrorMessage(code, message);
  if (status === 401) return "ChatGPTのログインを確認できませんでした。設定画面でもう一度ログインしてください。";
  if (status === 403) return "このアカウントや地域では、ChatGPTのプランで翻訳できません (HTTP 403)。";
  if (status === 429) return "ChatGPTのプランの利用上限に達しました。ChatGPTの設定の「使用状況」を確認してください。";
  if (status === 503) return "ChatGPTのプランが一時的に使えません。しばらく待ってからお試しください。";
  return `ChatGPTエラー (HTTP ${status})${message ? `: ${message.slice(0, 240)}` : ""}`;
}

function planErrorMessage(code: string, message: string): string {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return "ChatGPTのプランの利用上限に達しました。ChatGPTの設定の「使用状況」を確認してください。";
    case "subscription_sharing_user_not_eligible":
      return "このChatGPTアカウントやワークスペースでは、プランを使った翻訳ができません。";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "ChatGPTのプランの状態を確認できませんでした。しばらく待ってからお試しください。";
    case "subscription_sharing_invalid_user":
      return "ChatGPTとの接続が切れました。設定画面でもう一度ログインしてください。";
    case "subscription_sharing_unsupported_capability":
      return "ChatGPTのプランでは、このモデルや機能を使えません。設定でモデルを変えてお試しください。";
    default:
      return `ChatGPTエラー${code ? ` (${code})` : ""}${message ? `: ${message.slice(0, 240)}` : ""}`;
  }
}

/** A valid access token, refreshed when it is about to expire (or `force`d). */
async function accessToken(force = false): Promise<string> {
  const session = await readSession();
  if (!session) throw new Error(NOT_SIGNED_IN);
  if (!force && Date.now() < session.refreshAt) return session.accessToken;
  // Refresh tokens rotate: two refreshes at once would spend the same one twice.
  refreshing ??= refresh(session.accessToken).finally(() => { refreshing = null; });
  return refreshing;
}
let refreshing: Promise<string> | null = null;

async function refresh(staleToken: string): Promise<string> {
  const session = await readSession();
  if (!session) throw new Error(NOT_SIGNED_IN);
  // Another request refreshed after this one read the session: its token is the current one.
  if (session.accessToken !== staleToken) return session.accessToken;
  let tokens: TokenResponse;
  try {
    tokens = await requestTokens({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refreshToken, resource: API });
  } catch (caught) {
    if (caught instanceof SignInExpired) await chrome.storage.session.remove(SESSION_KEY);
    throw caught;
  }
  const next = { ...sessionFrom(tokens, session.clientId, session.email), refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : session.refreshToken, models: session.models };
  await chrome.storage.session.set({ [SESSION_KEY]: next });
  return next.accessToken;
}

class SignInExpired extends Error {}

async function requestTokens(form: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("ChatGPTのログインサーバーに接続できませんでした。ネットワークを確認してください。");
  }
  const result = await response.json().catch(() => ({})) as TokenResponse & { error?: unknown };
  if (response.ok && typeof result.access_token === "string") return result;
  const error = typeof result.error === "string" ? result.error : "";
  // The code or the refresh token can no longer be used: only a new sign-in helps.
  if (/invalid_grant|token_expired|refresh_token|invalid_refresh_token/.test(error)) throw new SignInExpired("ChatGPTへのログインの期限が切れました。設定画面でもう一度ログインしてください。");
  throw new Error(`ChatGPTにログインできませんでした (HTTP ${response.status}${error ? `, ${error}` : ""})。`);
}

function sessionFrom(tokens: TokenResponse, clientId: string, email: string): Session {
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new Error("ChatGPTからログイン情報を受け取れませんでした。");
  const lifetime = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600;
  return { email, clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, refreshAt: Date.now() + Math.max(lifetime - 120, 60) * 1000, models: [] };
}

async function listModels(token: string): Promise<ChatGPTAccount["models"]> {
  const response = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(chatgptErrorMessage(response.status, await response.text()));
  return readModels(await response.json());
}

/** The models the account offers for display (`visibility: "list"`), in OpenAI's order. */
export function readModels(result: unknown): ChatGPTAccount["models"] {
  const list = (result as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: { slug?: unknown; display_name?: unknown; visibility?: unknown }) =>
    typeof item?.slug === "string" && item.visibility === "list"
      ? [{ slug: item.slug, name: typeof item.display_name === "string" && item.display_name ? item.display_name : item.slug }]
      : []);
}

export function authorizeUrl({ registration, state, nonce, challenge }: { registration: Registration; state: string; nonce: string; challenge: string }): string {
  const params = new URLSearchParams({
    // The first sign-in registers a client for this host; later ones reuse it.
    client_id: registration.clientId ?? "dynamic_agent_client",
    ...(registration.clientId ? {} : { agent_name_hint: APP_NAME }),
    ext_agent_host_id: registration.hostId,
    response_type: "code",
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: SCOPE,
    resource: API,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** The code (and, on the first sign-in, the client OpenAI registered) from the address the sign-in returned to. */
export function readCallback(url: string, state: string): { code: string; clientId?: string; scopes: string[] } {
  const params = new URL(url).searchParams;
  if (params.get("state") !== state) throw new Error("ChatGPTのログイン結果を確認できませんでした。もう一度お試しください。");
  const error = params.get("error");
  if (error) throw new Error(error === "access_denied" ? "ChatGPTへのログインがキャンセルされました。" : `ChatGPTにログインできませんでした (${error})。`);
  const code = params.get("code");
  if (!code) throw new Error("ChatGPTのログイン結果を読み取れませんでした。もう一度お試しください。");
  return { code, clientId: params.get("client_id") ?? undefined, scopes: (params.get("scope") ?? "").split(/[\s+]+/).filter(Boolean) };
}

/**
 * The account in the ID token, after checking it was issued by OpenAI for this client and this sign-in.
 * It comes straight from OpenAI's token endpoint over HTTPS, so its signature is not checked again here.
 */
export function readIdToken(token: unknown, expected: { clientId: string; nonce: string; now: number }): { email: string } {
  const invalid = () => new Error("ChatGPTのログイン結果を確認できませんでした。もう一度お試しください。");
  if (typeof token !== "string") throw invalid();
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown; nonce?: unknown; email?: unknown };
  try {
    claims = JSON.parse(base64UrlDecode(token.split(".")[1] ?? "")) as typeof claims;
  } catch {
    throw invalid();
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audience.includes(expected.clientId) || claims.nonce !== expected.nonce) throw invalid();
  if (typeof claims.exp !== "number" || claims.exp * 1000 < expected.now) throw invalid();
  return { email: typeof claims.email === "string" ? claims.email : "" };
}

/** Opens the sign-in in a tab and resolves with the loopback address it is sent to; the tab is then closed. */
function waitForCallback(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let tabId: number | undefined;
    const finish = (done: () => void) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      done();
    };
    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      const address = change.url ?? tab.url ?? "";
      if (id !== tabId || !address.startsWith(CHATGPT_REDIRECT_URI)) return;
      finish(() => resolve(address));
      void chrome.tabs.remove(id).catch(() => undefined);
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(() => reject(new Error("ChatGPTへのログインがキャンセルされました。")));
    };
    const timer = setTimeout(() => finish(() => reject(new Error("ChatGPTへのログインが時間内に終わりませんでした。もう一度お試しください。"))), 10 * 60_000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.create({ url }).then((tab) => { tabId = tab.id; }, (caught: unknown) => finish(() => reject(caught)));
  });
}

async function readRegistration(): Promise<Registration> {
  const stored = (await chrome.storage.local.get(REGISTRATION_KEY))[REGISTRATION_KEY] as Partial<Registration> | undefined;
  if (typeof stored?.hostId === "string") return { hostId: stored.hostId, clientId: typeof stored.clientId === "string" ? stored.clientId : undefined };
  // Chosen once per install and kept: OpenAI tells hosts apart by it. It identifies, it does not authenticate.
  const registration: Registration = { hostId: `urn:uuid:${crypto.randomUUID()}` };
  await chrome.storage.local.set({ [REGISTRATION_KEY]: registration });
  return registration;
}

async function readSession(): Promise<Session | null> {
  const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as Session | undefined;
  return stored && typeof stored.accessToken === "string" ? stored : null;
}

function randomString(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): string {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
