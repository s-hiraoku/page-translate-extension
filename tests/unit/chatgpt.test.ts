import { describe, expect, it } from "vitest";
import { authorizeUrl, chatgptErrorMessage, pkceChallenge, readCallback, readIdToken, readModels, readResponseStream } from "../../src/background/chatgpt";
import { CHATGPT_REDIRECT_URI } from "../../src/shared/types";

const sse = (...events: object[]) => events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("authorizeUrl", () => {
  it("registers a client on the first sign-in, with the app's name and the plan scope", () => {
    const url = new URL(authorizeUrl({ registration: { hostId: "urn:uuid:1" }, state: "s", nonce: "n", challenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("Page Translate");
    expect(url.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:1");
    expect(url.searchParams.get("redirect_uri")).toBe(CHATGPT_REDIRECT_URI);
    expect(url.searchParams.get("scope")?.split(" ")).toContain("chatgpt.tokens.use.direct");
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("reuses the registered client later, without the name hint", () => {
    const url = new URL(authorizeUrl({ registration: { hostId: "urn:uuid:1", clientId: "client-9" }, state: "s", nonce: "n", challenge: "c" }));
    expect(url.searchParams.get("client_id")).toBe("client-9");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
  });
});

describe("pkceChallenge", () => {
  it("is the base64url SHA-256 of the verifier (RFC 7636 example)", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("readCallback", () => {
  it("reads the code, the issued client and the scopes", () => {
    const result = readCallback(`${CHATGPT_REDIRECT_URI}?code=abc&scope=chatgpt.tokens.use.direct+email+openid&state=s1&client_id=client-1`, "s1");
    expect(result).toEqual({ code: "abc", clientId: "client-1", scopes: ["chatgpt.tokens.use.direct", "email", "openid"] });
  });

  it("refuses an answer to another sign-in", () => {
    expect(() => readCallback(`${CHATGPT_REDIRECT_URI}?code=abc&state=other`, "s1")).toThrow("確認できませんでした");
  });

  it("says when the reader declined", () => {
    expect(() => readCallback(`${CHATGPT_REDIRECT_URI}?error=access_denied&state=s1`, "s1")).toThrow("キャンセル");
  });
});

describe("readIdToken", () => {
  const expected = { clientId: "client-1", nonce: "n1", now: 1_000_000_000_000 };
  const valid = { iss: "https://auth.openai.com", aud: "client-1", nonce: "n1", exp: 1_000_000_100, email: "a@example.com" };

  it("returns the account when the token was issued for this client and sign-in", () => {
    expect(readIdToken(jwt(valid), expected)).toEqual({ email: "a@example.com" });
    expect(readIdToken(jwt({ ...valid, aud: ["x", "client-1"] }), expected)).toEqual({ email: "a@example.com" });
  });

  it("refuses another issuer, audience or nonce, and an expired token", () => {
    for (const claims of [{ iss: "https://evil.example" }, { aud: "client-2" }, { nonce: "n2" }, { exp: 999_999_000 }]) {
      expect(() => readIdToken(jwt({ ...valid, ...claims }), expected)).toThrow();
    }
    expect(() => readIdToken("not-a-token", expected)).toThrow();
  });
});

describe("readResponseStream", () => {
  it("takes the text of the completed response", () => {
    const stream = sse(
      { type: "response.output_text.delta", delta: '{"text":' },
      { type: "response.output_text.delta", delta: '"こんにちは"}' },
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: '{"text":"こんにちは"}' }] }] } },
    );
    expect(readResponseStream(stream)).toBe('{"text":"こんにちは"}');
  });

  it("falls back to the streamed text when the completed event has no output", () => {
    expect(readResponseStream(sse({ type: "response.output_text.delta", delta: "{}" }, { type: "response.completed", response: {} }))).toBe("{}");
  });

  it("explains a plan limit that arrives mid-stream", () => {
    const stream = sse({ type: "response.output_text.delta", delta: "{" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } });
    expect(() => readResponseStream(stream)).toThrow("利用上限");
  });

  it("fails when the stream ends without response.completed", () => {
    expect(() => readResponseStream(sse({ type: "response.output_text.delta", delta: "{" }))).toThrow("途切れました");
  });
});

describe("chatgptErrorMessage", () => {
  it("names the plan errors", () => {
    expect(chatgptErrorMessage(403, JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible" } }))).toContain("プランを使った翻訳ができません");
    expect(chatgptErrorMessage(429, "")).toContain("利用上限");
    expect(chatgptErrorMessage(401, JSON.stringify({ detail: "bad" }))).toContain("もう一度ログイン");
  });
});

describe("readModels", () => {
  it("keeps the models meant to be listed, in order", () => {
    const result = { models: [
      { slug: "gpt-a", display_name: "GPT A", visibility: "list" },
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
      { slug: "gpt-b", visibility: "list" },
    ] };
    expect(readModels(result)).toEqual([{ slug: "gpt-a", name: "GPT A" }, { slug: "gpt-b", name: "gpt-b" }]);
    expect(readModels({})).toEqual([]);
  });
});
