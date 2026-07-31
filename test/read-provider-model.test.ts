import { describe, it, expect } from "vitest";
import { readProviderModel } from "../index.ts";

describe("readProviderModel", () => {
  describe("#48 修复：无 model 配置时不再回退硬编码 claude-haiku", () => {
    it("null 配置返回空 provider/model", () => {
      expect(readProviderModel(null)).toEqual({ provider: "", model: "" });
    });

    it("undefined 配置返回空", () => {
      expect(readProviderModel(undefined)).toEqual({ provider: "", model: "" });
    });

    it("空对象返回空", () => {
      expect(readProviderModel({})).toEqual({ provider: "", model: "" });
    });

    it("model 为空字符串返回空", () => {
      expect(readProviderModel({ agents: { defaults: { model: "" } } }))
        .toEqual({ provider: "", model: "" });
    });

    it("缺少 agents.defaults.model 返回空", () => {
      expect(readProviderModel({ agents: {} })).toEqual({ provider: "", model: "" });
    });
  });

  describe("provider/model 字符串解析", () => {
    it("带 / 的字符串拆分为 provider + model", () => {
      expect(readProviderModel({ agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } } }))
        .toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    });

    it("多个 / 时 provider 取第一段，model 保留剩余", () => {
      expect(readProviderModel({ agents: { defaults: { model: "openai/gpt-4/mini" } } }))
        .toEqual({ provider: "openai", model: "gpt-4/mini" });
    });

    it("无 / 的裸 model 默认 provider=anthropic", () => {
      expect(readProviderModel({ agents: { defaults: { model: "claude-sonnet-4-5" } } }))
        .toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    });

    it("去除首尾空白", () => {
      expect(readProviderModel({ agents: { defaults: { model: "  anthropic/claude-x  " } } }))
        .toEqual({ provider: "anthropic", model: "claude-x" });
    });
  });

  describe("对象形式 { primary } 解析", () => {
    it("从 model.primary 取值", () => {
      expect(readProviderModel({ agents: { defaults: { model: { primary: "anthropic/claude-opus-4" } } } }))
        .toEqual({ provider: "anthropic", model: "claude-opus-4" });
    });

    it("primary 为空字符串回退到空结果", () => {
      expect(readProviderModel({ agents: { defaults: { model: { primary: "" } } } }))
        .toEqual({ provider: "", model: "" });
    });
  });
});
