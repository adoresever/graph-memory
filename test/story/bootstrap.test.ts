import { describe, expect, it } from "vitest";
import { loadStoryConfig } from "../../src/story/config.ts";

describe("loadStoryConfig", () => {
  it("loads anthropic-compatible runtime settings from env", () => {
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_MODEL = "MiniMax-M2.7";
    process.env.NOVEL_LLM_API_KEY = "test-key";

    const cfg = loadStoryConfig();
    expect(cfg.llm.mode).toBe("anthropic-compatible");
    expect(cfg.llm.baseURL).toContain("minimaxi");
    expect(cfg.llm.model).toBe("MiniMax-M2.7");
  });
});
