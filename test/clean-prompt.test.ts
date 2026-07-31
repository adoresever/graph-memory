import { describe, it, expect } from "vitest";
import { cleanPrompt } from "../index.ts";

describe("cleanPrompt", () => {
  it("普通 prompt 原样返回", () => {
    expect(cleanPrompt("Hello world")).toBe("Hello world");
  });

  it("去除 /command 前缀", () => {
    expect(cleanPrompt("/ask what is X")).toBe("what is X");
  });

  it("去除 [timestamp] 前缀", () => {
    expect(cleanPrompt("[2026-07-31 10:30] Hello")).toBe("Hello");
  });

  it("去除 Sender metadata + ```json``` 包装，保留真实 prompt", () => {
    const input = [
      "Sender (untrusted metadata)",
      "```json",
      '{"role":"system"}',
      "```",
      "Actual prompt content",
    ].join("\n");
    expect(cleanPrompt(input)).toBe("Actual prompt content");
  });

  it("Sender metadata 无 json 块时按行过滤", () => {
    const input = [
      "Sender (untrusted metadata)",
      "Some real line",
      "Actual",
    ].join("\n");
    expect(cleanPrompt(input)).toBe("Some real line\nActual");
  });
});
