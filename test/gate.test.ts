/**
 * graph-memory — extraction gating tests
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { classifyExtractionBatch, isImmediateExtraction, messageTextForExtraction } from "../src/extractor/gate.ts";
import { Extractor } from "../src/extractor/extract.ts";

function row(role: string, text: string, turn = 1): any {
  return {
    role,
    turn_index: turn,
    content: JSON.stringify({ role, content: [{ type: "text", text }] }),
  };
}

describe("extraction gating", () => {
  it("skips only trivial acknowledgements", () => {
    const decision = classifyExtractionBatch(
      [row("user", "好的"), row("assistant", "收到")],
      DEFAULT_CONFIG,
    );

    expect(decision.action).toBe("skip");
  });

  it("defers low-signal messages below batch thresholds", () => {
    const decision = classifyExtractionBatch(
      [
        row("user", "我们后面再看一下这个插件的成本问题"),
        row("assistant", "可以，我先记住这个方向。", 2),
      ],
      DEFAULT_CONFIG,
    );

    expect(decision.action).toBe("defer");
  });

  it("extracts once enough meaningful messages are pending", () => {
    const messages = Array.from({ length: DEFAULT_CONFIG.extractBatchMinMessages }, (_, i) =>
      row(i % 2 === 0 ? "user" : "assistant", `关于插件优化的第 ${i} 条有效上下文`, i + 1),
    );

    const decision = classifyExtractionBatch(messages, DEFAULT_CONFIG);
    expect(decision.action).toBe("extract");
    expect(isImmediateExtraction(decision)).toBe(false);
  });

  it("extracts immediately on errors and corrections", () => {
    const errorDecision = classifyExtractionBatch(
      [row("toolResult", "Exit code: 1\nError: failed to connect")],
      DEFAULT_CONFIG,
    );
    expect(errorDecision.action).toBe("extract");
    expect(isImmediateExtraction(errorDecision)).toBe(true);

    const correctionDecision = classifyExtractionBatch(
      [row("user", "不对，这里应该改成批量抽取")],
      DEFAULT_CONFIG,
    );
    expect(correctionDecision.action).toBe("extract");
    expect(isImmediateExtraction(correctionDecision)).toBe(true);
  });

  it("force flush extracts meaningful pending messages", () => {
    const decision = classifyExtractionBatch(
      [row("user", "这个会话里有一个需要保留的实现思路")],
      DEFAULT_CONFIG,
      true,
    );

    expect(decision.action).toBe("extract");
  });

  it("normalizes stored OpenClaw message JSON to plain text", () => {
    const message = row("user", "Sender (untrusted metadata):\n```json\n{\"x\":1}\n```\n真正内容");
    expect(messageTextForExtraction(message)).toBe("真正内容");
  });
});

describe("Extractor prompt controls", () => {
  it("caps per-message prompt text and requests bounded JSON output", async () => {
    let seenUser = "";
    let seenOptions: any;
    const cfg = {
      ...DEFAULT_CONFIG,
      extractMaxMessageChars: 10,
      extractOutputMaxTokens: 321,
    };
    const ext = new Extractor(cfg, async (_system, user, options) => {
      seenUser = user;
      seenOptions = options;
      return '{"nodes":[],"edges":[]}';
    });

    await ext.extract({
      messages: [row("user", "abcdefghijklmnopqrstuvwxyz")],
      existingNames: [],
    });

    expect(seenUser).toContain("abcdefghij");
    expect(seenUser).not.toContain("klmnop");
    expect(seenOptions).toMatchObject({ json: true, maxTokens: 321 });
  });
});
