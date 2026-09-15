/**
 * finalize 阶梯触发 + 社区摘要 top-k 稳定签名 单测（LLM 成本控制）
 */

import { describe, it, expect } from "vitest";
import { shouldRunFinalize } from "../src/extractor/extract.ts";
import {
  buildCommunityMemberSignature, buildTopKMemberSignature, COMMUNITY_SIGNATURE_TOP_K,
} from "../src/graph/community.ts";

describe("shouldRunFinalize — finalize 阶梯触发", () => {
  it("空会话 / ≤2 节点 → 跳过", () => {
    expect(shouldRunFinalize([])).toBe(false);
    expect(shouldRunFinalize([{ type: "TASK" }])).toBe(false);
    expect(shouldRunFinalize([{ type: "TASK" }, { type: "SKILL" }])).toBe(false);
  });

  it("无 EVENT 节点 → 跳过（promotedSkills 无提升对象）", () => {
    expect(shouldRunFinalize([
      { type: "TASK" }, { type: "SKILL" }, { type: "SKILL" },
    ])).toBe(false);
  });

  it("≥3 节点且含 EVENT → 触发", () => {
    expect(shouldRunFinalize([
      { type: "TASK" }, { type: "SKILL" }, { type: "EVENT" },
    ])).toBe(true);
  });
});

describe("buildTopKMemberSignature — top-k 稳定签名", () => {
  const members = [
    { id: "a", validatedCount: 10 },
    { id: "b", validatedCount: 8 },
    { id: "c", validatedCount: 7 },
    { id: "d", validatedCount: 2 }, // 低频成员
    { id: "e", validatedCount: 1 }, // 低频成员
  ];

  it("低频成员进出不改变签名（社区边界抖动免疫）", () => {
    // k=3：签名由 validatedCount 前三名（a/b/c）决定
    const base = buildTopKMemberSignature(members, 3);
    const withNoise = buildTopKMemberSignature([
      ...members,
      { id: "f", validatedCount: 1 },
    ], 3);
    const withoutLow = buildTopKMemberSignature(members.slice(0, 3), 3);
    expect(withNoise).toBe(base);
    expect(withoutLow).toBe(base);
  });

  it("高价值成员变化 → 签名变化（语义主体变了要重摘要）", () => {
    const base = buildTopKMemberSignature(members, 3);
    const promoted = buildTopKMemberSignature([
      ...members,
      { id: "g", validatedCount: 50 },
    ], 3);
    expect(promoted).not.toBe(base);
  });

  it("成员数 ≤ k 时与全量签名一致（退化为旧语义）", () => {
    const small = [
      { id: "x", validatedCount: 3 },
      { id: "y", validatedCount: 5 },
    ];
    const topk = buildTopKMemberSignature(small, COMMUNITY_SIGNATURE_TOP_K);
    const full = buildCommunityMemberSignature(small.map((m) => m.id));
    expect(topk).toBe(full);
  });

  it("validatedCount 并列时按 id 字典序决胜负（确定性）", () => {
    const s1 = buildTopKMemberSignature([
      { id: "a", validatedCount: 5 },
      { id: "b", validatedCount: 5 },
    ]);
    const s2 = buildTopKMemberSignature([
      { id: "b", validatedCount: 5 },
      { id: "a", validatedCount: 5 },
    ]);
    expect(s1).toBe(s2);
  });
});
