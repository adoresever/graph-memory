import { afterEach, describe, expect, it, vi } from "vitest";

import { createCompleteFn } from "../src/engine/llm.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local LLM configuration", () => {
  it("supports baseUrl without an API key", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "submit_graph_extraction",
          arguments: '{"turn":{"summary":"answer","outcome":"informational","sourceTurns":[1]},"nodes":[],"edges":[],"invalidations":[]}',
        },
      }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const complete = createCompleteFn("", "fallback", {
      baseUrl: "http://127.0.0.1:8080/v1/",
      model: "local-model",
    });

    await expect(complete("system", "user")).resolves.toBe('{"turn":{"summary":"answer","outcome":"informational","sourceTurns":[1]},"nodes":[],"edges":[],"invalidations":[]}');
    expect(requests[0].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(requests[0].headers.has("Authorization")).toBe(false);
    expect(requests[0].body).toMatchObject({ model: "local-model" });
    expect(requests[0].body).toMatchObject({
      tools: [{ function: { name: "submit_graph_extraction" } }],
      tool_choice: { function: { name: "submit_graph_extraction" } },
    });
  });
});
