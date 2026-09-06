/**
 * graph-memory-pro — trivial 轮次本地预筛（LLM 成本控制）
 *
 * 在 extractTurnKnowledge 进入 LLM 前判断该轮是否"不可能产出知识"：
 * 命中则直接 markExtracted(producedKnowledge=false)，省掉一次完整 completion。
 *
 * 判定（保守取向，宁可漏判 trivial 也不误杀知识轮）：
 *   1. 用户输入清洗后为空；
 *   2. 清洗后命中无意义词表（内置 + cfg.extract.trivialPrompts，精确匹配）；
 *   3. 清洗后长度 ≤ trivialMaxChars（默认 5）且不含技术词
 *      （连续 ≥3 位字母数字，如 pnpm/jwt/k8s——这类短输入仍走 LLM）。
 *
 * 判定"文本"只取 user 角色（工具结果与 assistant 回复的内容不参与），但轮内只要
 * 存在工具劳动（tool/toolResult 角色，见 turnHasToolWork）就不判 trivial——
 * "继续"触发的一轮真实修复劳动恰是图谱最该吸收的知识。
 */

/** 清洗：去空白与中西文标点，转小写。用于词表精确匹配与长度计量。 */
export function normalizeTrivialText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

/**
 * 内置无意义词表：纯推进/确认/致谢类输入，语义上不可能携带可提取三元组。
 * 匹配前同样经过 normalizeTrivialText（"继续。" → "继续"，"OK!" → "ok"）。
 */
export const BUILTIN_TRIVIAL_PROMPTS: readonly string[] = [
  // 推进类
  "继续", "请继续", "接着", "接着来", "往下", "继续吧", "goon", "goahead",
  "continue", "resume", "next", "proceed", "keepgoing",
  // 确认类
  "ok", "okay", "好", "好的", "好吧", "可以", "行", "嗯",
  "嗯嗯", "对", "是的", "没问题", "明白", "知道了", "懂了", "收到", "gotit",
  "understood", "yes", "yeah", "yep", "sure",
  // 致谢类
  "谢谢", "多谢", "感谢", "辛苦了", "thanks", "thankyou", "thx", "tnx",
];

/** 连续 ≥3 位字母数字视为技术词（pnpm/jwt/k8s/csv…），短输入含技术词时不判 trivial。 */
const TECH_TOKEN_RE = /[a-z0-9]{3,}/;

export interface TrivialFilterOptions {
  /** 长度阈值；默认 5。 */
  maxChars?: number;
  /** 追加词表（与内置合并，匹配前统一 normalize）。 */
  extraPrompts?: string[];
}

/** 该轮是否应跳过 LLM 提取（本地零成本判定）。 */
export function shouldSkipTurnExtraction(userText: string, opts?: TrivialFilterOptions): boolean {
  const normalized = normalizeTrivialText(userText ?? "");
  if (!normalized) return true;

  const stoplist = new Set(BUILTIN_TRIVIAL_PROMPTS);
  for (const p of opts?.extraPrompts ?? []) {
    const n = normalizeTrivialText(p);
    if (n) stoplist.add(n);
  }
  if (stoplist.has(normalized)) return true;

  const maxChars = opts?.maxChars ?? 5;
  if (normalized.length <= maxChars && !TECH_TOKEN_RE.test(normalized)) return true;

  return false;
}

/**
 * 轮内是否含工具劳动（tool / toolResult 角色）。这类轮即使 user 文本命中
 * trivial 词表也不应跳过提取："继续"触发的一轮真实修复劳动恰是可提取知识，
 * 且 per-turn 路径没有自动补提触发点——extracted 一旦标记，只有手动重置
 * + `graph-memory extract` 才能回挖。
 */
export function turnHasToolWork(messages: readonly unknown[]): boolean {
  return (messages ?? []).some((m) => {
    if (!m || typeof m !== "object") return false;
    const role = (m as { role?: unknown }).role;
    return role === "tool" || role === "toolResult";
  });
}
