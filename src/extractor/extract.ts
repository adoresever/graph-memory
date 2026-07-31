/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import type { GmConfig, ExtractionResult, FinalizeResult } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";

// ─── 节点/边合法值 ──────────────────────────────────────────────

const VALID_NODE_TYPES = new Set(["TASK", "SKILL", "EVENT"]);
const VALID_EDGE_TYPES = new Set(["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH"]);

/** 边类型 → 合法的 from 节点类型 */
const EDGE_FROM_CONSTRAINT: Record<string, Set<string>> = {
  USED_SKILL:     new Set(["TASK"]),
  SOLVED_BY:      new Set(["EVENT", "SKILL"]),
  REQUIRES:       new Set(["SKILL"]),
  PATCHES:        new Set(["SKILL"]),
  CONFLICTS_WITH: new Set(["SKILL"]),
};

/** 边类型 → 合法的 to 节点类型 */
const EDGE_TO_CONSTRAINT: Record<string, Set<string>> = {
  USED_SKILL:     new Set(["SKILL"]),
  SOLVED_BY:      new Set(["SKILL"]),
  REQUIRES:       new Set(["SKILL"]),
  PATCHES:        new Set(["SKILL"]),
  CONFLICTS_WITH: new Set(["SKILL"]),
};

// ─── 提取 System Prompt ─────────────────────────────────────────

const EXTRACT_SYS = `你是 graph-memory 知识图谱提取引擎，从 AI Agent 对话中提取可复用的结构化知识三元组（节点 + 关系）。
提取的知识将在未来对话中被召回，帮助 Agent 避免重复犯错、复用已验证方案。
输出严格 JSON：{"nodes":[...],"edges":[...]}，不包含任何额外文字。

1. 节点提取：
   1.1 从对话中识别三类知识节点：
       - TASK：用户要求 Agent 完成的具体任务，有明确的目标和结果
       - SKILL：可复用的操作技能，有具体工具/命令/API，有明确触发条件，步骤可直接执行
       - EVENT：一次性的报错或异常，记录现象、原因和解决方法
   1.2 每个节点必须包含 4 个字段，缺一不可：
       - type：节点类型，只允许 TASK / SKILL / EVENT
       - name：全小写连字符命名，确保整个提取过程命名一致
       - description：一句话说明什么场景触发
       - content：纯文本格式的知识内容（见 1.4 的模板，不要 markdown）
   1.3 name 命名规范：
       - TASK：动词-对象格式，如 deploy-bilibili-mcp、extract-pdf-tables
       - SKILL：工具-操作格式，如 conda-env-create、docker-port-expose
       - EVENT：现象-工具格式，如 importerror-libgl1、timeout-paddleocr
       - 已有节点列表会提供，相同事物必须复用已有 name，不得创建重复节点
   1.4 content 模板（按 type 选用）：
       TASK → "目标: ...\n步骤: 1. ... 2. ...\n结果: ..."
       SKILL → "触发条件: ...\n步骤: 1. ... 2. ...\n常见错误: ... → ..."
       EVENT → "现象: ...\n原因: ...\n解决方法: ..."

2. 关系提取：
   2.1 识别节点之间直接、明确的关系，只允许以下 5 种边类型。
   2.2 每条边必须包含 from、to、type、instruction 四个字段，缺一不可。
   2.3 边类型定义与方向约束（严格遵守，不得混用）：

       USED_SKILL
         方向：TASK → SKILL（且仅限此方向）
         含义：任务执行过程中使用了该技能
         instruction：写第几步用的、怎么调用的、传了什么参数
         判定：from 节点是 TASK，to 节点是 SKILL

       SOLVED_BY
         方向：EVENT → SKILL 或 SKILL → SKILL
         含义：该报错/问题被该技能解决
         instruction：写具体执行了什么命令/操作来解决
         condition（必填）：写什么错误或条件触发了这个解决方案
         判定：from 节点是 EVENT 或 SKILL，to 节点是 SKILL
         注意：TASK 节点不能作为 SOLVED_BY 的 from，TASK 使用技能必须用 USED_SKILL

       REQUIRES
         方向：SKILL → SKILL
         含义：执行该技能前必须先完成另一个技能
         instruction：写为什么依赖、怎么判断前置条件是否已满足

       PATCHES
         方向：SKILL → SKILL（新 → 旧）
         含义：新技能修正/替代了旧技能的做法
         instruction：写旧方案有什么问题、新方案改了什么

       CONFLICTS_WITH
         方向：SKILL ↔ SKILL（双向）
         含义：两个技能在同一场景互斥
         instruction：写冲突的具体表现、应该选哪个

   2.4 关系方向选择决策树（按此顺序判定）：
       a. from 是 TASK，to 是 SKILL → 必须用 USED_SKILL
       b. from 是 EVENT，to 是 SKILL → 必须用 SOLVED_BY
       c. from 和 to 都是 SKILL → 根据语义选 SOLVED_BY / REQUIRES / PATCHES / CONFLICTS_WITH
       d. 不存在其他合法组合，不符合以上任何一条的关系不要提取

3. 提取原则（宁多勿漏）：
   3.1 用户的每一个有实际信息的请求都应该尝试提取，类型判断规则：
       - 用户要求做某件事（执行、查询、部署、安装、对比、分析、总结） → TASK
       - 对话中产生了可复用的操作步骤或方法 → SKILL
       - 出现报错、异常、失败 → EVENT
       - 用户提出备选方案或替代路径 → SKILL
       - 用户追问原因（"为什么连不上""怎么获取的"） → 如果有结论就补充到已有节点，没有就提取新 EVENT
   3.2 唯一不提取的情况：纯闲聊（"你好""谢谢"）、完全重复已有节点的内容
   3.3 判断标准：对话结束后如果有人问"我们刚才聊了什么"，你提取的节点应该能完整回答
   3.4 用户纠正 AI 的错误时，旧做法和新做法都要提取，用 PATCHES 边关联
   3.5 已有节点列表会提供（Existing Nodes），相同事物复用已有 name，不重复创建

4. 输出规范：
   4.1 只返回 JSON，格式为 {"nodes":[...],"edges":[...]}
   4.2 禁止 markdown 代码块包裹，禁止解释文字，禁止额外字段
   4.3 没有知识产出时返回 {"nodes":[],"edges":[]}
   4.4 每条 edge 的 instruction 必须写具体可执行的内容，不能为空或写"见上文"

示例 1（TASK + SKILL + USED_SKILL 边）：

信号：[{"type":"task_completed","turnIndex":8,"data":{"snippet":"弹幕抓取完成，共 2341 条"}}]

对话摘要：用户要求抓取B站弹幕，Agent 使用 bili-tool 的 danmaku 子命令完成。

输出：
{"nodes":[{"type":"TASK","name":"extract-bilibili-danmaku","description":"从B站视频中批量抓取弹幕数据","content":"目标: 从指定B站视频抓取全部弹幕\\n步骤: 1. 获取视频BV号 2. 调用 bili-tool danmaku --bv BVxxx 3. 输出JSON格式弹幕列表\\n结果: 成功抓取2341条弹幕"},{"type":"SKILL","name":"bili-tool-danmaku","description":"使用 bili-tool 抓取B站视频弹幕","content":"触发条件: 需要抓取B站视频弹幕时\\n步骤: 1. pip install bilibili-api-python 2. python bili_tool.py danmaku --bv BVxxx --output danmaku.json\\n常见错误: cookie过期 → 重新获取SESSDATA"}],"edges":[{"from":"extract-bilibili-danmaku","to":"bili-tool-danmaku","type":"USED_SKILL","instruction":"第 2 步调用 bili-tool danmaku 子命令，传入 --bv 和 --output 参数"}]}

示例 2（EVENT + SKILL + SOLVED_BY 边）：

信号：[{"type":"tool_error","turnIndex":3,"data":{"snippet":"ImportError: libGL.so.1"}}]

对话摘要：执行 PaddleOCR 时报 libGL 缺失，通过 apt 安装解决。

输出：
{"nodes":[{"type":"EVENT","name":"importerror-libgl1","description":"导入 cv2/paddleocr 时报 libGL.so.1 缺失","content":"现象: ImportError: libGL.so.1: cannot open shared object file\\n原因: OpenCV依赖系统级libGL库 conda/pip不自动安装\\n解决方法: apt install -y libgl1-mesa-glx"},{"type":"SKILL","name":"apt-install-libgl1","description":"安装 libgl1 解决 OpenCV 系统依赖缺失","content":"触发条件: ImportError: libGL.so.1\\n步骤: 1. sudo apt update 2. sudo apt install -y libgl1-mesa-glx\\n常见错误: Permission denied → 加sudo"}],"edges":[{"from":"importerror-libgl1","to":"apt-install-libgl1","type":"SOLVED_BY","instruction":"执行 sudo apt install -y libgl1-mesa-glx","condition":"报 ImportError: libGL.so.1 时"}]}`;

// ─── 提取 User Prompt ───────────────────────────────────────────

const EXTRACT_USER = (msgs: string, existing: string) =>
`<Existing Nodes>
${existing || "（无）"}

<Conversation>
${msgs}`;

// ─── 整理 System Prompt ─────────────────────────────────────────

const FINALIZE_SYS = `你是图谱节点整理引擎，对本次对话产生的节点做 session 结束前的最终审查。
审查本次对话所有节点，执行以下三项操作，输出严格 JSON。

1. EVENT 升级为 SKILL：
   1.1 如果某个 EVENT 节点具有通用复用价值（不限于特定场景），将其升级为 SKILL
   1.2 升级时需要：改名为 SKILL 命名规范（工具-操作）、完善 content 为 SKILL 模板格式
   1.3 写入 promotedSkills 数组

2. 补充遗漏关系：
   2.1 整体回顾所有节点，发现单次提取时难以察觉的跨节点关系
   2.2 关系类型只允许：USED_SKILL、SOLVED_BY、REQUIRES、PATCHES、CONFLICTS_WITH
   2.3 严格遵守方向约束：TASK→SKILL 用 USED_SKILL，EVENT→SKILL 用 SOLVED_BY
   2.4 写入 newEdges 数组

3. 标记失效节点：
   3.1 因本次对话中的新发现而失效的旧节点，将其 node_id 写入 invalidations 数组

没有需要处理的项返回空数组。只返回 JSON，禁止额外文字。
格式：{"promotedSkills":[{"type":"SKILL","name":"...","description":"...","content":"..."}],"newEdges":[{"from":"...","to":"...","type":"...","instruction":"..."}],"invalidations":["node-id"]}`;

// ─── 整理 User Prompt ───────────────────────────────────────────

const FINALIZE_USER = (nodes: any[], summary: string) =>
`<Session Nodes>
${JSON.stringify(nodes.map(n => ({
  id: n.id, type: n.type, name: n.name,
  description: n.description, v: n.validatedCount
})), null, 2)}

<Graph Summary>
${summary}`;

// ─── 名称标准化（与 store.ts 一致）────────────────────────────

export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── 边类型自动修正 ─────────────────────────────────────────────

/**
 * 根据 from/to 节点类型修正 LLM 输出的边类型
 *
 * 修正规则：
 *   TASK → SKILL + 任何非 USED_SKILL → 修正为 USED_SKILL
 *   EVENT → SKILL + 任何非 SOLVED_BY → 修正为 SOLVED_BY
 *   方向约束不满足 → 丢弃该边
 */
function correctEdgeType(
  edge: { from: string; to: string; type: string; instruction: string; condition?: string },
  nameToType: Map<string, string>,
): typeof edge | null {
  const fromType = nameToType.get(normalizeName(edge.from));
  const toType = nameToType.get(normalizeName(edge.to));

  // 无法确定节点类型时原样返回
  if (!fromType || !toType) return edge;

  let type = edge.type;

  // TASK → SKILL 必须是 USED_SKILL
  if (fromType === "TASK" && toType === "SKILL" && type !== "USED_SKILL") {
    type = "USED_SKILL";
  }

  // EVENT → SKILL 必须是 SOLVED_BY
  if (fromType === "EVENT" && toType === "SKILL" && type !== "SOLVED_BY") {
    type = "SOLVED_BY";
  }

  // 验证修正后的类型是否合法
  if (!VALID_EDGE_TYPES.has(type)) {
    return null;
  }

  // 验证方向约束
  const fromOk = EDGE_FROM_CONSTRAINT[type]?.has(fromType) ?? false;
  const toOk = EDGE_TO_CONSTRAINT[type]?.has(toType) ?? false;
  if (!fromOk || !toOk) {
    return null;
  }

  return { ...edge, type };
}

// ─── Extractor ────────────────────────────────────────────────

export class Extractor {
  constructor(private _cfg: GmConfig, private llm: CompleteFn) {}

  async extract(params: {
    messages: any[];
    existingNames: string[];
  }): Promise<ExtractionResult> {
    const msgs = params.messages
      .map(m => `[${(m.role ?? "?").toUpperCase()} t=${m.turn_index ?? 0}]\n${
        String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 800)
      }`).join("\n\n---\n\n");

    const raw = await this.llm(
      EXTRACT_SYS,
      EXTRACT_USER(msgs, params.existingNames.join(", ")),
    );

    return this.parseExtract(raw);
  }

  async finalize(params: { sessionNodes: any[]; graphSummary: string }): Promise<FinalizeResult> {
    const raw = await this.llm(FINALIZE_SYS, FINALIZE_USER(params.sessionNodes, params.graphSummary));
    return this.parseFinalize(raw, params.sessionNodes);
  }

  private parseExtract(raw: string): ExtractionResult {
    try {
      const json = extractJson(raw);
      const p = JSON.parse(json);

      // ── 节点验证 ──
      const nodes = (p.nodes ?? []).filter((n: any) => {
        if (!n.name || !n.type || !n.content) return false;
        if (!VALID_NODE_TYPES.has(n.type)) return false;
        if (!n.description) n.description = "";
        n.name = normalizeName(n.name);
        return true;
      });

      // ── 构建 name→type 索引 ──
      const nameToType = new Map<string, string>();
      for (const n of nodes) nameToType.set(n.name, n.type);

      // ── 边验证 + 自动修正 ──
      const edges = (p.edges ?? [])
        .filter((e: any) => e.from && e.to && e.type && e.instruction)
        .map((e: any) => {
          e.from = normalizeName(e.from);
          e.to = normalizeName(e.to);
          return correctEdgeType(e, nameToType);
        })
        .filter((e: any) => e !== null);

      return { nodes, edges };
    } catch {
      return { nodes: [], edges: [] };
    }
  }

  private parseFinalize(raw: string, sessionNodes?: any[]): FinalizeResult {
    try {
      const json = extractJson(raw);
      const p = JSON.parse(json);

      // 构建 name→type 索引（从 sessionNodes + promotedSkills）
      const nameToType = new Map<string, string>();
      if (sessionNodes) {
        for (const n of sessionNodes) {
          if (n.name && n.type) nameToType.set(normalizeName(n.name), n.type);
        }
      }
      const promotedSkills = (p.promotedSkills ?? []).filter((n: any) => n.name && n.content);
      for (const n of promotedSkills) {
        nameToType.set(normalizeName(n.name), n.type ?? "SKILL");
      }

      // newEdges 做方向约束校验
      const newEdges = (p.newEdges ?? [])
        .filter((e: any) => e.from && e.to && e.type && VALID_EDGE_TYPES.has(e.type))
        .map((e: any) => {
          e.from = normalizeName(e.from);
          e.to = normalizeName(e.to);
          return correctEdgeType(e, nameToType);
        })
        .filter((e: any) => e !== null);

      return {
        promotedSkills,
        newEdges,
        invalidations: p.invalidations ?? [],
      };
    } catch { return { promotedSkills: [], newEdges: [], invalidations: [] }; }
  }
}

// ─── JSON 提取 ───────────────────────────────────────────────

function extractJson(raw: string): string {
  let s = raw.trim();
  // 清理 <think>...</think> 思维链标签（兼容 MiniMax 等模型）
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<think>[\s\S]*/gi, "");  // 未闭合的 <think>
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
  s = s.trim();
  if (s.startsWith("{") && s.endsWith("}")) return s;
  if (s.startsWith("[") && s.endsWith("]")) return s;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}
