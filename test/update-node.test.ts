import { describe, it, expect } from "vitest";
import { applyNodePatch } from "../src/store/store.ts";
import type { GmNode } from "../src/types.ts";

const baseNode: Pick<GmNode, "description" | "content"> = {
  description: "旧描述",
  content: "旧内容",
};

describe("applyNodePatch (#57 updateNode 字段合并语义)", () => {
  it("空 patch 保留原值", () => {
    expect(applyNodePatch(baseNode, {})).toEqual({ description: "旧描述", content: "旧内容" });
  });

  it("只更新 description，保留 content", () => {
    expect(applyNodePatch(baseNode, { description: "新描述" }))
      .toEqual({ description: "新描述", content: "旧内容" });
  });

  it("只更新 content，保留 description", () => {
    expect(applyNodePatch(baseNode, { content: "新内容" }))
      .toEqual({ description: "旧描述", content: "新内容" });
  });

  it("同时更新 description 和 content", () => {
    expect(applyNodePatch(baseNode, { description: "新描述", content: "新内容" }))
      .toEqual({ description: "新描述", content: "新内容" });
  });

  it("空字符串 patch 字段会覆盖原值（?? 语义：仅 undefined 保留原值）", () => {
    expect(applyNodePatch(baseNode, { description: "" }))
      .toEqual({ description: "", content: "旧内容" });
  });

  it("显式 undefined 等价于不传该字段", () => {
    expect(applyNodePatch(baseNode, { description: undefined, content: "新" }))
      .toEqual({ description: "旧描述", content: "新" });
  });
});
