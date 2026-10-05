import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_MODEL, buildPageMessage, judgeWithClaude, readDecisions } from "../../src/background/claude-judge";
import type { CandidateSegment } from "../../src/shared/types";

function segment(id: string, order: number, sourceText: string, overrides: Partial<CandidateSegment> = {}): CandidateSegment {
  return { id, order, location: "", tagName: "p", sourceText, sourceHtml: sourceText, region: "main", kind: "paragraph", linkDensity: 0, isArticleTitle: false, ...overrides };
}

const page = { pageTitle: "Calm interfaces", mainContentDetected: true, articleTitle: "Designing calm interfaces" };
const segments = [
  segment("a", 0, "Designing calm interfaces", { kind: "heading", tagName: "h1", isArticleTitle: true }),
  segment("b", 1, "Most dashboards fail because every element competes for attention at once."),
  segment("c", 2, "Subscribe to our newsletter", { region: "outside", linkDensity: 0.333 }),
];

describe("buildPageMessage", () => {
  it("lists every candidate in reading order with its number, structure and text", () => {
    const message = JSON.parse(buildPageMessage([segments[2]!, segments[0]!, segments[1]!], "JA", page));
    expect(message.target_language).toBe("Japanese");
    expect(message.candidates.map((item: { n: number }) => item.n)).toEqual([2, 3, 1]);
    expect(message.candidates[2]).toMatchObject({ n: 1, region: "outside", link_density: 0.33, text: "Subscribe to our newsletter" });
  });

  it("shortens very long text", () => {
    const message = JSON.parse(buildPageMessage([segment("x", 0, "word ".repeat(400))], "EN", page));
    expect(message.candidates[0].text.length).toBe(601);
  });
});

describe("readDecisions", () => {
  it("maps decisions back to segment ids", () => {
    const decisions = readDecisions(segments, JSON.stringify({ decisions: [{ n: 1, decision: "translate" }, { n: 2, decision: "translate" }, { n: 3, decision: "skip" }] }));
    expect(decisions.map((item) => [item.id, item.decision])).toEqual([["a", "translate"], ["b", "translate"], ["c", "skip"]]);
  });

  it("translates and flags a candidate left out of the answer", () => {
    const decisions = readDecisions(segments, JSON.stringify({ decisions: [{ n: 1, decision: "translate" }, { n: 9, decision: "skip" }] }));
    expect(decisions.map((item) => item.decision)).toEqual(["translate", "review", "review"]);
  });

  it("rejects an answer that is not JSON", () => {
    expect(() => readDecisions(segments, "not json")).toThrow("Claude");
  });
});

describe("judgeWithClaude", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks Claude once for the whole page and reads its structured answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: CLAUDE_MODEL, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify({ decisions: [{ n: 1, decision: "translate" }, { n: 2, decision: "translate" }, { n: 3, decision: "skip" }] }) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const decisions = await judgeWithClaude("sk-test", segments, "JA", page);
    expect(decisions.map((item) => item.decision)).toEqual(["translate", "translate", "skip"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-test");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(CLAUDE_MODEL);
    expect(body.output_config.format.type).toBe("json_schema");
    expect(JSON.parse(body.messages[0].content).candidates).toHaveLength(3);
  });

  it("explains a rejected key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(judgeWithClaude("bad", segments, "JA", page)).rejects.toThrow("ClaudeのAPIキーが正しくありません");
  });

  it("says so when Claude declines the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "msg_2", type: "message", role: "assistant", model: CLAUDE_MODEL, stop_reason: "refusal", stop_sequence: null, content: [], usage: { input_tokens: 1, output_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(judgeWithClaude("sk-test", segments, "JA", page)).rejects.toThrow("断りました");
  });
});
