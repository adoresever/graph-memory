/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */
import { assertGraphExtractionContract } from "./contract.js";
/** Read only visible text from a host message already selected as a Q/A pair. */
export function normalizeExtractionContent(value) {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return value
            .filter((block) => Boolean(block) && typeof block === "object")
            .filter(block => block.type === "text" && typeof block.text === "string")
            .map(block => String(block.text))
            .join("\n");
    if (typeof value !== "object")
        return String(value);
    const record = value;
    if (record.type === "text" && typeof record.text === "string") {
        return record.text;
    }
    if (record.content !== undefined)
        return normalizeExtractionContent(record.content);
    if (record.message !== undefined)
        return normalizeExtractionContent(record.message);
    return "";
}
// ─── 提取 System Prompt ─────────────────────────────────────────
const EXTRACT_SYS = `【任务】
把一个已完成的对话轮转换为一句摘要和零条或多条主语—谓词—宾语关系。

【输入】
- Current Turn 是本轮唯一事实来源，只含用户输入和最终可见回答。
- Previous Turn Summaries 仅用于消解代词、省略和“继续上一个”等指代，不能作为本轮事实重复输出。

【处理原则】
1. summary 用一句简短、自包含的话写清本轮对象、结论和最终回答明确报告的完成情况；不复述过程，不添加输入未表达的信息。
2. outcome 按最终回答选择 completed、partial、failed、informational、unknown 之一。
3. triples 只从 summary 拆分。subject 和 object 使用具体可检索短语，predicate 使用简短自然语言；没有明确关系时使用空数组，不补充、不猜测。

【输出合同】
只调用 submit_result 一次。参数对象必须且只能包含 summary、outcome、triples 三个顶层字段，三个字段都不能省略。不要输出解释或正文。

示例一：
输入：用户要求把周会改到周四；最终回答确认日程已更新。
输出：{"summary":"周会已改到周四，日程已更新。","outcome":"completed","triples":[{"subject":"周会","predicate":"改到","object":"周四"}]}

示例二：
前一轮摘要为“季度报告已完成初稿”。本轮用户说“继续这个”，最终回答说“已完成数据复核”。
输出：{"summary":"季度报告初稿已完成数据复核。","outcome":"completed","triples":[{"subject":"季度报告初稿","predicate":"完成","object":"数据复核"}]}

示例三：
输入只确认稍后继续讨论，没有新结论。
输出：{"summary":"本轮确认稍后继续讨论，未产生新结论。","outcome":"informational","triples":[]}

调用前自检：参数是否恰好包含三个顶层字段；outcome 是否属于枚举；没有关系时 triples 是否仍明确写为 []。`;
// ─── 提取 User Prompt ───────────────────────────────────────────
const EXTRACT_USER = (msgs, priorTurns) => `<Previous Turn Summaries>
${priorTurns.length ? JSON.stringify(priorTurns.map(memory => memory.summary)) : "（无）"}

<Current Turn>
${msgs}`;
// ─── Extractor ────────────────────────────────────────────────
export class Extractor {
    _cfg;
    llm;
    constructor(_cfg, llm) {
        this._cfg = _cfg;
        this.llm = llm;
    }
    async extract(params) {
        const msgs = params.messages
            .map(m => `${m.role === "user" ? "用户" : m.role === "assistant" ? "回答" : String(m.role ?? "内容")}：${normalizeExtractionContent(m.content)}`).join("\n\n---\n\n");
        const raw = await this.llm(EXTRACT_SYS, EXTRACT_USER(msgs, params.priorTurns ?? []));
        return this.parseExtract(raw);
    }
    parseExtract(raw) {
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
                turn: { summary: p.summary, outcome: p.outcome },
                triples: p.triples.map(triple => ({ ...triple })),
            };
        }
        catch (err) {
            // Extraction output can contain private conversation facts. Report the
            // contract failure without copying model output into host logs.
            throw new Error(`[graph-memory] extraction parse failed: ${err}`);
        }
    }
}
