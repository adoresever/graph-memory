/**
 * Cheap extraction gating for high-frequency context engines.
 *
 * The goal is to keep all messages persisted, but avoid spending LLM calls on
 * acknowledgements, heartbeats, and low-signal fragments until there is enough
 * pending material to batch.
 */

import type { GmConfig } from "../types.ts";

export type ExtractionDecision =
  | { action: "extract"; reason: string }
  | { action: "defer"; reason: string }
  | { action: "skip"; reason: string };

export function isImmediateExtraction(decision: ExtractionDecision): boolean {
  return decision.action === "extract" && decision.reason === "immediate signal";
}

const ACK_RE = /^(好|好的|嗯|嗯嗯|OK|ok|收到|明白|继续|谢谢|谢了|辛苦了|可以|是的|对|没事|不用|先这样|hello|hi|你好|再见)[。！!,.，\s]*$/i;
const ERROR_RE = /(error|failed|failure|exception|traceback|stack trace|exit code:\s*[1-9]|npm err|pnpm err|timeout|timed out|denied|not found|报错|错误|异常|失败|超时|拒绝访问|找不到|崩溃)/i;
const CORRECTION_RE = /(不对|不是|错了|纠正|应该是|改成|别|不要|撤销|回退|重新来|漏了)/i;
const COMPLETION_RE = /(已完成|完成了|修复了|新增了|更新了|已修改|已创建|已删除|测试通过|验证通过|run tests|tests passed|修复|实现|部署成功)/i;

function safeJsonParse(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block: any) => {
      if (!block || typeof block !== "object") return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function messageTextForExtraction(message: any): string {
  if (!message || typeof message !== "object") return "";

  let payload: any = message;
  if (typeof message.content === "string") {
    const parsed = safeJsonParse(message.content);
    if (parsed && typeof parsed === "object") payload = parsed;
  }

  const text = textFromContent(payload.content ?? message.content);
  return text
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, "")
    .replace(/^\/\w+\s+/, "")
    .trim();
}

function roleOf(message: any): string {
  if (!message || typeof message !== "object") return "";
  if (typeof message.role === "string") return message.role;
  if (typeof message.content === "string") {
    const parsed = safeJsonParse(message.content);
    if (parsed && typeof parsed.role === "string") return parsed.role;
  }
  return "";
}

function hasImmediateSignal(message: any, text: string): boolean {
  const role = roleOf(message);
  if (ERROR_RE.test(text)) return true;
  if (CORRECTION_RE.test(text)) return true;
  if (role === "assistant" && COMPLETION_RE.test(text)) return true;
  if ((role === "tool" || role === "toolResult") && ERROR_RE.test(text)) return true;
  return false;
}

function isTrivial(message: any, cfg: GmConfig): boolean {
  const role = roleOf(message);
  if (role !== "user" && role !== "assistant") return false;

  const text = messageTextForExtraction(message);
  if (!text) return true;
  if (hasImmediateSignal(message, text)) return false;

  const maxChars = cfg.extractTrivialMaxChars;
  return text.length <= maxChars && (ACK_RE.test(text) || text.length <= 8);
}

export function classifyExtractionBatch(
  messages: any[],
  cfg: GmConfig,
  force = false,
): ExtractionDecision {
  if (!messages.length) return { action: "defer", reason: "no pending messages" };

  const texts = messages.map(messageTextForExtraction);
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  const meaningful = messages.filter((m) => !isTrivial(m, cfg));

  if (!meaningful.length) {
    return { action: "skip", reason: "only trivial messages" };
  }

  if (messages.some((m, i) => hasImmediateSignal(m, texts[i] ?? ""))) {
    return { action: "extract", reason: "immediate signal" };
  }

  if (force) {
    return { action: "extract", reason: "forced flush" };
  }

  if (meaningful.length >= cfg.extractBatchMinMessages) {
    return { action: "extract", reason: "message batch threshold" };
  }

  if (totalChars >= cfg.extractBatchMinChars) {
    return { action: "extract", reason: "character batch threshold" };
  }

  return { action: "defer", reason: "waiting for batch" };
}
