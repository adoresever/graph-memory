/**
 * trivial 轮次本地预筛单测 — LLM 成本控制的第一道闸
 *
 * 判定语义（保守取向）：
 *   1. 清洗后为空 → 跳过
 *   2. 命中无意义词表（内置 + extra，含标点/大小写容忍）→ 跳过
 *   3. 清洗后 ≤ maxChars（默认 5）且无技术词（连续 ≥3 位字母数字）→ 跳过
 *   4. 其余（正常提问 / 短但含技术词 / 长文本）→ 不跳过
 */

import { describe, it, expect } from "vitest";
import {
  normalizeTrivialText, shouldSkipTurnExtraction, turnHasToolWork, BUILTIN_TRIVIAL_PROMPTS,
} from "../src/extractor/turn-filter.ts";
import { turnUserText } from "../index.ts";

describe("normalizeTrivialText", () => {
  it("去空白与中西文标点、转小写", () => {
    expect(normalizeTrivialText("  继续。！！ ")).toBe("继续");
    expect(normalizeTrivialText("OK!")).toBe("ok");
    expect(normalizeTrivialText("Resume, please")).toBe("resumeplease");
  });
});

describe("shouldSkipTurnExtraction — 词表命中", () => {
  it.each([
    "继续", "请继续", "继续。", "继续吧", "好的！", "ok", "OK", "resume",
    "continue", "谢谢", "thanks", "got it", "知道了",
  ])("%s → 跳过", (input) => {
    expect(shouldSkipTurnExtraction(input)).toBe(true);
  });

  it("额外词表生效且同样容忍标点", () => {
    expect(shouldSkipTurnExtraction("下一页。", { extraPrompts: ["下一页"] })).toBe(true);
    expect(shouldSkipTurnExtraction("下一页", { extraPrompts: ["下一页"] })).toBe(true);
  });

  it("内置表可被 extra 扩展且不被覆盖", () => {
    expect(BUILTIN_TRIVIAL_PROMPTS).toContain("继续");
    expect(shouldSkipTurnExtraction("继续")).toBe(true);
    // 不在词表且超长阈值的正常词 → 不跳过
    expect(shouldSkipTurnExtraction("下一页部署 nginx")).toBe(false);
  });
});

describe("shouldSkipTurnExtraction — 短文本阈值", () => {
  it("≤5 字纯文本（无技术词）→ 跳过", () => {
    expect(shouldSkipTurnExtraction("是的呢")).toBe(true);
    expect(shouldSkipTurnExtraction("嗯嗯嗯嗯嗯")).toBe(true);   // 恰好 5
    expect(shouldSkipTurnExtraction("嗯嗯嗯嗯嗯嗯")).toBe(false); // 6 字，宁可多提取
  });

  it("短但含技术词（连续 ≥3 位字母数字）→ 不跳过", () => {
    expect(shouldSkipTurnExtraction("用pnpm")).toBe(false);
    expect(shouldSkipTurnExtraction("试jwt")).toBe(false);
    expect(shouldSkipTurnExtraction("k8s呢")).toBe(false);
  });

  it("空输入 → 跳过（无可提取内容）", () => {
    expect(shouldSkipTurnExtraction("")).toBe(true);
    expect(shouldSkipTurnExtraction("  。！？ ")).toBe(true);
  });

  it("正常提问不跳过", () => {
    expect(shouldSkipTurnExtraction("帮我把 neo4j 的索引重建一下")).toBe(false);
    expect(shouldSkipTurnExtraction("这个报错怎么修")).toBe(false);
    expect(shouldSkipTurnExtraction("why does the build fail")).toBe(false);
  });

  it("自定义阈值", () => {
    expect(shouldSkipTurnExtraction("嗯嗯嗯嗯嗯嗯", { maxChars: 6 })).toBe(true);
    expect(shouldSkipTurnExtraction("嗯嗯嗯", { maxChars: 2 })).toBe(false);
  });
});

describe("turnUserText — 轮级 user 文本聚合", () => {
  it("只取 user 角色，剥离 OpenClaw 元数据", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "```json\n{\"Sender\":\"meta\"}\n```\n继续" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "好的，我继续处理部署任务" }] },
      { role: "user", content: [{ type: "text", text: "" }] },
    ];
    const text = turnUserText(messages);
    expect(text.trim()).toBe("继续");
    // 元数据剥离后应命中词表 → 该轮会被本地预筛跳过
    expect(shouldSkipTurnExtraction(text)).toBe(true);
  });

  it("string content 同样支持", () => {
    expect(turnUserText([{ role: "user", content: "怎么修这个报错" }])).toBe("怎么修这个报错");
  });

  it("非 user 消息不参与", () => {
    expect(turnUserText([{ role: "assistant", content: "继续" }])).toBe("");
    expect(shouldSkipTurnExtraction(turnUserText([{ role: "assistant", content: "继续" }]))).toBe(true);
  });
});

describe("turnHasToolWork — 工具劳动守卫（trivial 预筛的误杀保险）", () => {
  it("含 tool / toolResult 角色 → true", () => {
    expect(turnHasToolWork([
      { role: "user", content: "继续" },
      { role: "assistant", content: [{ type: "toolUse", id: "t1", name: "fix" }] },
      { role: "tool", content: "patched" },
    ])).toBe(true);
    expect(turnHasToolWork([
      { role: "user", content: "继续" },
      { role: "toolResult", content: [{ type: "text", text: "done" }] },
    ])).toBe(true);
  });

  it("纯 user/assistant 对话 → false", () => {
    expect(turnHasToolWork([
      { role: "user", content: "继续" },
      { role: "assistant", content: "好的" },
    ])).toBe(false);
    expect(turnHasToolWork([])).toBe(false);
  });

  it("畸形消息不炸", () => {
    expect(turnHasToolWork([null, undefined, "str", 42, { role: 123 }, {}])).toBe(false);
  });

  it("组合语义：user 文本命中词表 + 轮内有工具劳动 → 整轮照常提取", () => {
    const messages = [
      { role: "user", content: "继续" },
      { role: "assistant", content: [{ type: "toolUse", id: "t1", name: "bash" }] },
      { role: "toolResult", content: "bug fixed, tests green" },
    ];
    // 单独看 user 文本命中词表……
    expect(shouldSkipTurnExtraction(turnUserText(messages))).toBe(true);
    // ……但轮内有工具劳动，预筛必须让路
    expect(turnHasToolWork(messages)).toBe(true);
  });
});
