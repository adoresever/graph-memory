/**
 * graph-memory — 提取器测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 测试三个层面：
 * 1. parseExtract 节点验证（type 白名单、name 标准化）
 * 2. correctEdgeType 边类型自动修正（TASK→SKILL 必须 USED_SKILL 等）
 * 3. 模拟 LLM 返回各种格式的容错解析
 */

import { describe, it, expect } from "vitest";
import { Extractor } from "../src/extractor/extract.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import type { ExtractionResult, FinalizeResult } from "../src/types.ts";

// ─── Mock LLM：直接返回预设 JSON ────────────────────────────────

function mockLlm(response: string) {
  return async (_sys: string, _user: string) => response;
}

function createExtractor(response: string): Extractor {
  return new Extractor(DEFAULT_CONFIG, mockLlm(response));
}

// ═══════════════════════════════════════════════════════════════
// 核心问题：TASK→SKILL 的边类型修正
// ═══════════════════════════════════════════════════════════════

describe("边类型自动修正（核心 bug 修复）", () => {
  it("TASK→SKILL + SOLVED_BY 自动修正为 USED_SKILL", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "deploy-mcp-server", description: "部署 MCP 服务", content: "## deploy-mcp-server\n### 目标\n部署服务" },
        { type: "SKILL", name: "docker-compose-up", description: "使用 docker compose 启动服务", content: "## docker-compose-up\n### 触发条件\n需要启动容器时" },
      ],
      edges: [
        { from: "deploy-mcp-server", to: "docker-compose-up", type: "SOLVED_BY", instruction: "执行 docker compose up -d" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("USED_SKILL");
  });

  it("EVENT→SKILL + USED_SKILL 自动修正为 SOLVED_BY", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "EVENT", name: "importerror-libgl1", description: "libGL 缺失", content: "## importerror-libgl1\n### 现象\nImportError" },
        { type: "SKILL", name: "apt-install-libgl1", description: "安装 libgl1", content: "## apt-install-libgl1\n### 触发条件\nlibGL 缺失时" },
      ],
      edges: [
        { from: "importerror-libgl1", to: "apt-install-libgl1", type: "USED_SKILL", instruction: "apt install libgl1" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("SOLVED_BY");
  });

  it("正确的 TASK→SKILL + USED_SKILL 不被修改", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "extract-danmaku", description: "抓弹幕", content: "## extract-danmaku\n### 目标\n抓弹幕" },
        { type: "SKILL", name: "bili-tool-danmaku", description: "bili-tool", content: "## bili-tool-danmaku\n### 触发条件\n需要弹幕时" },
      ],
      edges: [
        { from: "extract-danmaku", to: "bili-tool-danmaku", type: "USED_SKILL", instruction: "调用 bili-tool danmaku" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("USED_SKILL");
  });

  it("正确的 EVENT→SKILL + SOLVED_BY 不被修改", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "EVENT", name: "timeout-paddleocr", description: "超时", content: "## timeout-paddleocr\n### 现象\n超时" },
        { type: "SKILL", name: "paddleocr-batch-config", description: "配置批量", content: "## paddleocr-batch-config\n### 触发条件\n超时时" },
      ],
      edges: [
        { from: "timeout-paddleocr", to: "paddleocr-batch-config", type: "SOLVED_BY", instruction: "调小 batch_size", condition: "OOM 或超时时" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("SOLVED_BY");
    expect(result.edges[0].condition).toBe("OOM 或超时时");
  });

  it("SKILL→SKILL 的合法边类型不被修改", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "conda-env-create", description: "创建环境", content: "## conda-env-create\n### 触发条件\n需要新环境时" },
        { type: "SKILL", name: "pip-install-deps", description: "安装依赖", content: "## pip-install-deps\n### 触发条件\n环境创建后" },
      ],
      edges: [
        { from: "pip-install-deps", to: "conda-env-create", type: "REQUIRES", instruction: "必须先 conda create 创建环境" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("REQUIRES");
  });
});

// ═══════════════════════════════════════════════════════════════
// 非法边方向丢弃
// ═══════════════════════════════════════════════════════════════

describe("非法方向的边被丢弃", () => {
  it("TASK→TASK 的边被丢弃", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "task-a", description: "任务A", content: "## task-a\n### 目标\nA" },
        { type: "TASK", name: "task-b", description: "任务B", content: "## task-b\n### 目标\nB" },
      ],
      edges: [
        { from: "task-a", to: "task-b", type: "REQUIRES", instruction: "A 依赖 B" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.edges).toHaveLength(0);
  });

  it("EVENT→TASK 的边被丢弃", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "EVENT", name: "some-error", description: "报错", content: "## some-error\n### 现象\n报错" },
        { type: "TASK", name: "fix-error", description: "修复", content: "## fix-error\n### 目标\n修复" },
      ],
      edges: [
        { from: "some-error", to: "fix-error", type: "SOLVED_BY", instruction: "修复报错" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    // SOLVED_BY 的 to 必须是 SKILL，不能是 TASK
    expect(result.edges).toHaveLength(0);
  });

  it("SKILL→TASK 的边被丢弃（除非能修正）", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "some-skill", description: "技能", content: "## some-skill\n### 触发条件\n需要时" },
        { type: "TASK", name: "some-task", description: "任务", content: "## some-task\n### 目标\n完成任务" },
      ],
      edges: [
        { from: "some-skill", to: "some-task", type: "REQUIRES", instruction: "技能需要任务？" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    // REQUIRES 的 to 必须是 SKILL
    expect(result.edges).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 节点验证
// ═══════════════════════════════════════════════════════════════

describe("节点验证", () => {
  it("非法 type 的节点被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "valid-skill", description: "有效", content: "## valid-skill\n### 触发条件\n..." },
        { type: "WORKFLOW", name: "invalid-workflow", description: "无效类型", content: "## invalid" },
        { type: "SOLUTION", name: "invalid-solution", description: "无效类型", content: "## invalid" },
      ],
      edges: [],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("valid-skill");
  });

  it("缺少必填字段的节点被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "has-all-fields", description: "完整", content: "## complete" },
        { type: "SKILL", name: "no-content", description: "缺 content" },
        { type: "SKILL", content: "缺 name" },
        { name: "no-type", description: "缺 type", content: "## no-type" },
      ],
      edges: [],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("has-all-fields");
  });

  it("name 自动标准化", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "Docker Port Expose", description: "端口", content: "## docker-port-expose" },
        { type: "TASK", name: "EXTRACT_PDF_TABLES", description: "提取表格", content: "## extract-pdf-tables" },
      ],
      edges: [],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes[0].name).toBe("docker-port-expose");
    expect(result.nodes[1].name).toBe("extract-pdf-tables");
  });

  it("缺少 description 时自动补空字符串", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "no-desc", content: "## no-desc\n### 触发条件\n..." },
      ],
      edges: [],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].description).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════
// 边验证
// ═══════════════════════════════════════════════════════════════

describe("边验证", () => {
  it("缺少 instruction 的边被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "task-a", description: "任务", content: "## task-a" },
        { type: "SKILL", name: "skill-a", description: "技能", content: "## skill-a" },
      ],
      edges: [
        { from: "task-a", to: "skill-a", type: "USED_SKILL" },
        { from: "task-a", to: "skill-a", type: "USED_SKILL", instruction: "" },
        { from: "task-a", to: "skill-a", type: "USED_SKILL", instruction: "有 instruction" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    // 前两条缺少/空 instruction，只保留第三条
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].instruction).toBe("有 instruction");
  });

  it("非法边类型被丢弃", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "skill-a", description: "A", content: "## skill-a" },
        { type: "SKILL", name: "skill-b", description: "B", content: "## skill-b" },
      ],
      edges: [
        { from: "skill-a", to: "skill-b", type: "DEPENDS_ON", instruction: "非法类型" },
        { from: "skill-a", to: "skill-b", type: "LEADS_TO", instruction: "非法类型" },
        { from: "skill-a", to: "skill-b", type: "REQUIRES", instruction: "合法类型" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("REQUIRES");
  });

  it("边的 from/to name 自动标准化后匹配节点", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "deploy-mcp", description: "部署", content: "## deploy-mcp" },
        { type: "SKILL", name: "docker-run", description: "运行", content: "## docker-run" },
      ],
      edges: [
        { from: "Deploy MCP", to: "Docker_Run", type: "SOLVED_BY", instruction: "docker run" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    // Deploy MCP → deploy-mcp (TASK), Docker_Run → docker-run (SKILL)
    // TASK→SKILL + SOLVED_BY → 修正为 USED_SKILL
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("USED_SKILL");
    expect(result.edges[0].from).toBe("deploy-mcp");
    expect(result.edges[0].to).toBe("docker-run");
  });
});

// ═══════════════════════════════════════════════════════════════
// LLM 输出格式容错
// ═══════════════════════════════════════════════════════════════

describe("LLM 输出格式容错", () => {
  it("处理 markdown 代码块包裹", async () => {
    const ext = createExtractor('```json\n{"nodes":[{"type":"SKILL","name":"test-skill","description":"测试","content":"## test"}],"edges":[]}\n```');

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(1);
  });

  it("处理 JSON 前有额外文字", async () => {
    const ext = createExtractor('好的，以下是提取结果：\n{"nodes":[{"type":"SKILL","name":"test-skill","description":"测试","content":"## test"}],"edges":[]}');

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(1);
  });

  it("完全无效的输出返回空结果", async () => {
    const ext = createExtractor("这不是 JSON，我不知道该怎么提取。");

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("空 JSON 返回空结果", async () => {
    const ext = createExtractor('{"nodes":[],"edges":[]}');

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 完整场景模拟
// ═══════════════════════════════════════════════════════════════

describe("完整场景模拟", () => {
  it("混合场景：TASK + EVENT + 多个 SKILL + 多种边类型", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "deploy-bilibili-mcp", description: "部署 bilibili MCP 服务", content: "## deploy-bilibili-mcp\n### 目标\n部署 MCP" },
        { type: "SKILL", name: "docker-compose-up", description: "docker compose 启动", content: "## docker-compose-up\n### 触发条件\n需要启动服务" },
        { type: "SKILL", name: "pip-install-deps", description: "安装 Python 依赖", content: "## pip-install-deps\n### 触发条件\n缺少依赖时" },
        { type: "EVENT", name: "importerror-bilibili-api", description: "缺少 bilibili-api", content: "## importerror-bilibili-api\n### 现象\nModuleNotFoundError" },
      ],
      edges: [
        // LLM 错误：TASK→SKILL 用了 SOLVED_BY
        { from: "deploy-bilibili-mcp", to: "docker-compose-up", type: "SOLVED_BY", instruction: "docker compose up -d" },
        // LLM 正确：EVENT→SKILL 用了 SOLVED_BY
        { from: "importerror-bilibili-api", to: "pip-install-deps", type: "SOLVED_BY", instruction: "pip install bilibili-api-python", condition: "ModuleNotFoundError 时" },
        // LLM 正确：SKILL→SKILL 用了 REQUIRES
        { from: "docker-compose-up", to: "pip-install-deps", type: "REQUIRES", instruction: "compose 启动前需要依赖已安装" },
      ],
    }));

    const result = await ext.extract({ messages: [], existingNames: [] });

    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);

    // 第一条边：TASK→SKILL 应该被修正为 USED_SKILL
    const taskEdge = result.edges.find(e => e.from === "deploy-bilibili-mcp");
    expect(taskEdge).toBeDefined();
    expect(taskEdge!.type).toBe("USED_SKILL");

    // 第二条边：EVENT→SKILL 保持 SOLVED_BY
    const eventEdge = result.edges.find(e => e.from === "importerror-bilibili-api");
    expect(eventEdge).toBeDefined();
    expect(eventEdge!.type).toBe("SOLVED_BY");

    // 第三条边：SKILL→SKILL 保持 REQUIRES
    const skillEdge = result.edges.find(e => e.from === "docker-compose-up");
    expect(skillEdge).toBeDefined();
    expect(skillEdge!.type).toBe("REQUIRES");
  });
});

// ═══════════════════════════════════════════════════════════════
// finalize 验证
// ═══════════════════════════════════════════════════════════════

describe("finalize 验证", () => {
  it("非法边类型在 newEdges 中被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      promotedSkills: [],
      newEdges: [
        { from: "a", to: "b", type: "USED_SKILL", instruction: "合法" },
        { from: "a", to: "b", type: "DEPENDS_ON", instruction: "非法" },
      ],
      invalidations: [],
    }));

    const result = await ext.finalize({ sessionNodes: [], graphSummary: "" });

    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0].type).toBe("USED_SKILL");
  });

  it("promotedSkills 缺少必填字段被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      promotedSkills: [
        { type: "SKILL", name: "valid-skill", description: "有效", content: "## valid" },
        { type: "SKILL", name: "no-content", description: "缺 content" },
      ],
      newEdges: [],
      invalidations: [],
    }));

    const result = await ext.finalize({ sessionNodes: [], graphSummary: "" });

    expect(result.promotedSkills).toHaveLength(1);
    expect(result.promotedSkills[0].name).toBe("valid-skill");
  });
});