/**
 * graph-memory-pro — token 估算
 *
 * 统一的字符→token 粗估换算（约 3 字符 = 1 token，中英混合文本的经验值）。
 * 全仓库所有 token 估算必须经由本模块，避免系数多处漂移。
 */

export const CHARS_PER_TOKEN = 3;

/** 按字符数粗估 token 数（向上取整） */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
