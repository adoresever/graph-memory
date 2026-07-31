import { describe, it, expect } from "vitest";
import { normalizeName as normalize } from "../src/store/store.ts";
import { normalizeName as normalizeNameExtract } from "../src/extractor/extract.ts";

describe("normalizeName", () => {
  it("小写化", () => {
    expect(normalize("Docker")).toBe("docker");
  });

  it("空格转连字符", () => {
    expect(normalize("Docker Build")).toBe("docker-build");
  });

  it("下划线转连字符", () => {
    expect(normalize("api_key")).toBe("api-key");
  });

  it("大写 + 下划线", () => {
    expect(normalize("API_KEY")).toBe("api-key");
  });

  it("移除非字母数字字符（保留连字符）", () => {
    expect(normalize("React 18!")).toBe("react-18");
  });

  it("保留中文（U+4E00–U+9FFF）", () => {
    expect(normalize("数据库迁移")).toBe("数据库迁移");
  });

  it("中英混合", () => {
    expect(normalize("Docker 镜像构建")).toBe("docker-镜像构建");
  });

  it("合并多个连续空白/下划线为单个连字符", () => {
    expect(normalize("Docker   Build")).toBe("docker-build");
    expect(normalize("a___b")).toBe("a-b");
  });

  it("合并已存在的多个连字符", () => {
    expect(normalize("a--b")).toBe("a-b");
  });

  it("去除首尾连字符", () => {
    expect(normalize("-leading")).toBe("leading");
    expect(normalize("trailing-")).toBe("trailing");
  });

  it("去除首尾空白", () => {
    expect(normalize("  spaced  ")).toBe("spaced");
  });

  it("空字符串", () => {
    expect(normalize("")).toBe("");
  });
});

describe("normalizeName 跨文件一致性（store.ts 与 extract.ts 必须相同）", () => {
  const corpus = [
    "Docker Build",
    "API_KEY",
    "React 18!",
    "数据库迁移",
    "  mixed_Case Name!  ",
    "a---b__c   d",
    "",
    "已经-标准化",
    "Neovis 3D 可视化",
  ];

  for (const input of corpus) {
    it(`相同输入相同输出: ${JSON.stringify(input)}`, () => {
      expect(normalizeNameExtract(input)).toBe(normalize(input));
    });
  }
});
