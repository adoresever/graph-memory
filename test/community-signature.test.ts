/**
 * buildCommunityMemberSignature — 社区成员签名纯逻辑
 * 移植自上游 v1.x "reuse unchanged community summaries"（commit 1fdec04）
 */

import { describe, it, expect } from "vitest";
import { buildCommunityMemberSignature } from "../src/graph/community.ts";

describe("buildCommunityMemberSignature", () => {
  it("成员顺序不影响签名（排序后哈希）", () => {
    expect(buildCommunityMemberSignature(["a", "b", "c"]))
      .toBe(buildCommunityMemberSignature(["c", "a", "b"]));
  });

  it("相同成员恒生成相同签名", () => {
    expect(buildCommunityMemberSignature(["x", "y"]))
      .toBe(buildCommunityMemberSignature(["x", "y"]));
  });

  it("成员构成不同则签名不同", () => {
    expect(buildCommunityMemberSignature(["a", "b"]))
      .not.toBe(buildCommunityMemberSignature(["a", "c"]));
    expect(buildCommunityMemberSignature(["a", "b"]))
      .not.toBe(buildCommunityMemberSignature(["a", "b", "c"]));
  });

  it("输出为 40 位小写 hex（sha1）", () => {
    expect(buildCommunityMemberSignature(["a"])).toMatch(/^[0-9a-f]{40}$/);
  });

  it("不修改入参数组", () => {
    const input = ["b", "a"];
    buildCommunityMemberSignature(input);
    expect(input).toEqual(["b", "a"]);
  });
});
