/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import type { GmConfig, ExtractionResult, NodeTemporal } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import { GRAPH_EXTRACTION_SCHEMA, assertGraphExtractionContract } from "./contract.ts";

/** Read only visible text from a host message already selected as a Q/A pair. */
export function normalizeExtractionContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => String(block.text))
    .join("\n");
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  if (record.content !== undefined) return normalizeExtractionContent(record.content);
  if (record.message !== undefined) return normalizeExtractionContent(record.message);
  return "";
}

// ─── 提取 System Prompt ─────────────────────────────────────────


const EXTRACT_SYS = `【角色】
你是 Graph Memory 的轮次记忆与知识图谱抽取器。你的职责是把一轮已完成的 Agent 对话压缩为一个可检索的极简摘要，再从摘要中的概念建立有证据支持的二元关系。

【任务边界】
- 抽取输入中明确表达、对后续对话可能有用的知识；不复述整段对话。
- Conversation 是本轮唯一事实证据，包含用户问题和最终可见回答。
- Existing Nodes 只用于名称复用、同一概念更新和关系端点解析，不能替代本轮证据。
- 不推测输入没有表达的人物、时间、状态、因果或关系。
- 不以节点数量或关系数量为目标，不补齐、不凑数、不为了连通图而创造关系。

【处理流程】
1. 先生成 turn：summary 用一个自包含的简短句子说明“本轮要做什么、实际做了什么、得到什么结果”；它是导航摘要，不复制过程，也不包含推理或工具轨迹。outcome 只描述对话明确报告的结果：completed=明确完成，partial=只完成一部分，failed=明确未完成，informational=仅讨论/问答而无执行成败，unknown=无法判断。sourceTurns 必须覆盖摘要依据。
2. 再从 summary 中识别语义明确、对后续对话有用的知识单元；同一概念合并表达，不同概念分别保留。具体事实仍必须能由 Conversation 直接验证。
3. 与 Existing Nodes 表示同一概念时复用其 name；否则使用稳定、可读的小写连字符名称。
4. 按知识本身分类：
   - TASK：用户任务或需要持续导航的讨论主题。
   - SKILL：已经验证、以后可复用的方法、工具、命令或操作规则。
   - EVENT：事实、偏好、约定、决策、状态、时间、标识符、错误或结果。
5. 在节点之间提取 summary 明确表达且 Conversation 支持的二元关系。一个陈述涉及多个节点时，可拆成多条有独立证据的二元关系。
6. 没有明确关系的节点可以独立存在；没有可保留知识时 nodes、edges 返回空数组，但 turn 仍必须记录本轮摘要。

【关系类型】
- RELATES：通用关系；instruction 使用本轮证据支持的自然语言谓词描述具体关系。
- SUPERSEDES：本轮的新概念或新结论替代一个既有概念。
- USED_SKILL：TASK → SKILL，任务使用了该方法。
- SOLVED_BY：EVENT → SKILL 或 SKILL → SKILL，问题或方法由该方法解决；condition 有明确触发条件时填写。
- REQUIRES、PATCHES、CONFLICTS_WITH：SKILL → SKILL，分别表示依赖、修正和冲突。
- 只有 source 和 target 都能解析为本批节点或 Existing Nodes 时才输出关系。

【时间与更新】
- operation=create：Existing Nodes 中没有同一概念。
- operation=confirm：本轮再次确认既有概念。
- operation=revise：本轮修订既有同名概念。
- 同名概念的变化用 revise；不同名称的替代用 SUPERSEDES；明确失效且没有替代节点时用 invalidations。
- temporal 只填写输入明确提供的时间与状态；没有明确时间信息时返回 {}。
- sourceTurns 列出支持该节点的真实 t 编号。

【输出要求】
- 调用结构化工具一次，参数必须完整符合下面的 JSON Schema；不要输出解释文字。
- 所有 required 字段必须出现，不增加未定义字段。
- turn、nodes、edges、invalidations 都必须出现；没有节点、关系或失效项时，对应数组返回 []。
- 不确定的知识不输出；格式错误不能用省略字段代替。

【示例：存在明确关系】
{"turn":{"summary":"用户要求部署服务，最终回答确认已使用 Docker 完成部署。","outcome":"completed","sourceTurns":[1]},"nodes":[{"type":"TASK","name":"deploy-service","description":"部署服务","content":"用户要求完成服务部署","operation":"create","temporal":{},"sourceTurns":[1]},{"type":"SKILL","name":"docker-deployment","description":"使用 Docker 部署服务","content":"最终回答确认使用 Docker 完成部署","operation":"create","temporal":{},"sourceTurns":[1]}],"edges":[{"from":"deploy-service","to":"docker-deployment","type":"USED_SKILL","instruction":"部署任务使用 Docker 方法"}],"invalidations":[]}

【示例：没有明确关系】
{"turn":{"summary":"用户说明其当前界面主题偏好为深色。","outcome":"informational","sourceTurns":[1]},"nodes":[{"type":"EVENT","name":"user-theme-preference","description":"用户的界面主题偏好","content":"用户偏好深色主题","operation":"create","temporal":{"state":"current"},"sourceTurns":[1]}],"edges":[],"invalidations":[]}

【输出 Schema】
${JSON.stringify(GRAPH_EXTRACTION_SCHEMA)}`;

// ─── 提取 User Prompt ───────────────────────────────────────────

export interface ExistingExtractionNode {
  type: string;
  name: string;
  description: string;
  content: string;
  temporal?: NodeTemporal;
  updatedAt?: number;
}

const EXTRACT_USER = (
  msgs: string,
  existing: string,
  existingNodes: ExistingExtractionNode[],
) =>
`<Existing Nodes>
${existingNodes.length ? JSON.stringify(existingNodes) : existing || "（无）"}

<Conversation>
${msgs}`;

// ─── Extractor ────────────────────────────────────────────────

export class Extractor {
  constructor(private _cfg: GmConfig, private llm: CompleteFn) {}

  async extract(params: {
    messages: any[];
    existingNames: string[];
    existingNodes?: ExistingExtractionNode[];
  }): Promise<ExtractionResult> {
    const msgs = params.messages
      .map(m => `[${(m.role ?? "?").toUpperCase()} t=${m.turn_index ?? 0}${
        Number.isFinite(Number(m.created_at)) ? ` recordedAt=${new Date(Number(m.created_at)).toISOString()}` : ""
      }]\n${
        normalizeExtractionContent(m.content)
      }`).join("\n\n---\n\n");

    const raw = await this.llm(
      EXTRACT_SYS,
      EXTRACT_USER(msgs, params.existingNames.join(", "), params.existingNodes ?? []),
    );

    return this.parseExtract(raw);
  }

  private parseExtract(raw: string): ExtractionResult {
    try {
      // Graph extraction is a data contract, not an invitation for the host
      // to guess missing fields, normalize names, or repair a model claim.
      // Every host must emit exactly one JSON object matching the schema.
      const p = JSON.parse(raw.trim());
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        throw new TypeError("extraction root must be a JSON object");
      }
      assertGraphExtractionContract(p);
      // The provider schema is the only extraction gate. A plugin must not
      // infer, rewrite, or reject the model's graph semantics from node types,
      // wording, lifecycle claims, or relation direction.
      return {
        turn: {
          ...p.turn,
          sourceTurns: [...p.turn.sourceTurns],
        },
        nodes: p.nodes.map(node => ({ ...node, temporal: { ...node.temporal }, sourceTurns: [...node.sourceTurns] })),
        edges: p.edges.map(edge => ({ ...edge })),
        invalidations: p.invalidations.map(item => ({ ...item })),
      };
    } catch (err) {
      // Extraction output can contain private conversation facts. Report the
      // contract failure without copying model output into host logs.
      throw new Error(`[graph-memory] extraction parse failed: ${err}`);
    }
  }

}
