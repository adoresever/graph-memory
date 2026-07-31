import { describe, it, expect } from "vitest";
import { normalizeMessageContent } from "../index.ts";

describe("normalizeMessageContent (#3 防 OpenClaw content.filter() 崩溃)", () => {
  it("string content 包装为 text block 数组", () => {
    const result = normalizeMessageContent([{ role: "user", content: "hello" }]);
    expect(result[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("null content 包装为空 text block", () => {
    const result = normalizeMessageContent([{ role: "assistant", content: null }]);
    expect(result[0].content).toEqual([{ type: "text", text: "" }]);
  });

  it("undefined content 包装为空 text block", () => {
    const result = normalizeMessageContent([{ role: "assistant", content: undefined }]);
    expect(result[0].content).toEqual([{ type: "text", text: "" }]);
  });

  it("畸形 block {type:'text'} 缺 text 补 text:''", () => {
    const result = normalizeMessageContent([{ role: "assistant", content: [{ type: "text" }] }]);
    expect(result[0].content).toEqual([{ type: "text", text: "" }]);
  });

  it("已规范的数组 content 深度等价", () => {
    const input = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }];
    expect(normalizeMessageContent(input)).toEqual(input);
  });

  it("非对象 msg 原样返回", () => {
    expect(normalizeMessageContent([null, undefined, "x"] as any)).toEqual([null, undefined, "x"]);
  });

  it("不修改原对象（返回新引用）", () => {
    const input = [{ role: "user", content: "hello" }];
    const result = normalizeMessageContent(input);
    expect(result).not.toBe(input);
    expect(input[0].content).toBe("hello");
  });
});
