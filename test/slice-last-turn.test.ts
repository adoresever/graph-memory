import { describe, it, expect } from "vitest";
import { sliceLastTurn, extractAssistantText, extractUserText } from "../index.ts";

describe("sliceLastTurn (#5 旧轮裁剪，降 token)", () => {
  it("空消息返回空", () => {
    expect(sliceLastTurn([])).toEqual({ messages: [], tokens: 0, dropped: 0 });
  });

  it("无 user 消息则丢弃全部", () => {
    const result = sliceLastTurn([{ role: "assistant", content: "hi" }]);
    expect(result.messages).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("单轮：user + assistant 完整保留", () => {
    const result = sliceLastTurn([
      { role: "user", content: "what is X?" },
      { role: "assistant", content: "X is..." },
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.dropped).toBe(0);
  });

  it("多轮：最后一轮完整，旧轮只留 user+assistant 纯文本（剥离 tool_use/tool）", () => {
    const result = sliceLastTurn([
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "text", text: "a1" }, { type: "tool_use", id: "t1", name: "n", input: {} }] },
      { role: "tool", content: "tool result 1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
    expect(result.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // 旧轮 assistant 的 tool_use 被剥离，content 降级为提取出的纯文本
    expect(result.messages[1].content).toBe("a1");
    // 旧轮的 tool 消息被丢弃
    expect(result.messages.some(m => m.role === "tool")).toBe(false);
  });

  it("超长 tool_result 被截断（>6000 字符）", () => {
    const longContent = "x".repeat(10000);
    const result = sliceLastTurn([
      { role: "user", content: "q" },
      { role: "tool", content: longContent },
    ]);
    const toolMsg = result.messages.find(m => m.role === "tool")!;
    expect(toolMsg.content.length).toBeLessThan(longContent.length);
    expect(toolMsg.content).toContain("[truncated");
  });

  it("短 tool_result 不截断", () => {
    const result = sliceLastTurn([
      { role: "user", content: "q" },
      { role: "tool", content: "short result" },
    ]);
    expect(result.messages.find(m => m.role === "tool")!.content).toBe("short result");
  });
});

describe("extractAssistantText", () => {
  it("string content 直接返回", () => {
    expect(extractAssistantText({ content: "hello" })).toBe("hello");
  });

  it("数组 content 拼接所有 text block，跳过 tool_use", () => {
    const msg = { content: [{ type: "text", text: "line1" }, { type: "tool_use", id: "x", name: "n", input: {} }, { type: "text", text: "line2" }] };
    expect(extractAssistantText(msg)).toBe("line1\nline2");
  });

  it("跳过缺 text 的畸形 block", () => {
    expect(extractAssistantText({ content: [{ type: "text" }, { type: "text", text: "ok" }] })).toBe("ok");
  });

  it("空数组返回空字符串", () => {
    expect(extractAssistantText({ content: [] })).toBe("");
  });
});

describe("extractUserText", () => {
  it("去掉 Sender metadata + ```json``` 块", () => {
    const msg = { content: "Sender (untrusted metadata)\n```json\n{x:1}\n```\nreal question" };
    expect(extractUserText(msg)).toBe("real question");
  });

  it("去掉命令前缀", () => {
    expect(extractUserText({ content: "/ask what is X" })).toBe("what is X");
  });

  it("去掉时间戳前缀", () => {
    expect(extractUserText({ content: "[2026-07-31 10:30] hello" })).toBe("hello");
  });

  it("数组 content 提取 text", () => {
    const msg = { content: [{ type: "text", text: "hello user" }] };
    expect(extractUserText(msg)).toBe("hello user");
  });
});
