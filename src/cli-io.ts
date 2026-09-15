/**
 * graph-memory-pro CLI — 共享终端 IO（log / 确认提示）。
 * extract 与 reembed 子命令共用；确认提示以环境变量名参数化——
 * 非交互 stdin 且该环境变量未设置时返回空串（视为拒绝），与两命令原语义一致。
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export function defaultLog(msg: string): void {
  console.log(msg);
}

export function makeDefaultPrompt(confirmEnvVar: string): (question: string) => Promise<string> {
  return async (question: string): Promise<string> => {
    if (!process.stdin.isTTY && process.env[confirmEnvVar] === undefined) {
      return "";
    }
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
