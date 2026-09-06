/**
 * graph-memory-pro CLI — `openclaw graph-memory auth login`
 *
 * 触发 OpenAI Codex PKCE OAuth 登录，将会话写入 oauthPath，
 * 并把 llm.provider 切到 "oauth"（写回 openclaw.json）。
 *
 * 移植自 memory-lancedb-pro 的 cli.ts（auth login 段），但适配 graph-memory-pro 的
 * 显式 provider 路由（写 llm.provider 而非 llm.auth），且不引入 commander 依赖——
 * `program` 实例由 OpenClaw host 运行时注入，本模块只依赖其鸭子类型形状。
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  performOAuthLogin,
  normalizeOauthModel,
  getDefaultOauthModelForProvider,
  getOAuthProviderLabel,
  isOauthModelSupported,
  listOAuthProviders,
  normalizeOAuthProviderId,
  type OAuthProviderId,
} from "./engine/oauth.ts";
import type { ReasoningEffort } from "./engine/llm.ts";
import { runBackfillExtraction } from "./cli-extract.ts";
import { runReembed } from "./cli-reembed.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./types.ts";

// ─── 最小 Commander 鸭子类型（避免引入 commander 依赖） ───────────
// host 运行时注入真正的 commander.Command 实例，结构兼容此接口即可。

export interface CliCommand {
  command(name: string): CliCommand;
  description(text: string): CliCommand;
  option(flags: string, description?: string, defaultValue?: unknown): CliCommand;
  action(handler: (options: Record<string, unknown>) => void | Promise<void>): CliCommand;
  outputHelp(): void;
}

export interface GraphMemoryCliRegistrarContext {
  program: CliCommand;
}

export interface GraphMemoryCliDeps {
  pluginId?: string;
  pluginConfig?: Record<string, unknown> | undefined;
  resolveConfigPath?: (input: string) => string;
  defaultModel?: string;
  oauthTestHooks?: {
    openUrl?: (url: string) => void | Promise<void>;
    authorizeUrl?: (url: string) => void | Promise<void>;
  };
}

// ─── 默认值 ─────────────────────────────────────────────────────

const DEFAULT_PLUGIN_ID = "graph-memory-pro";
const DEFAULT_OAUTH_PATH = path.join(homedir(), ".openclaw", ".graph-memory-pro", "oauth.json");
const DEFAULT_CONFIG_PATH = path.join(homedir(), ".openclaw", "openclaw.json");
const DEFAULT_TIMEOUT_SECONDS = 120;

// ─── 配置文件读写（最小实现） ───────────────────────────────────

interface OpenClawPluginEntry {
  enabled?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface OpenClawPluginsConfig {
  entries?: Record<string, OpenClawPluginEntry | undefined>;
  [key: string]: unknown;
}

export interface OpenClawConfigRoot {
  plugins?: OpenClawPluginsConfig;
  [key: string]: unknown;
}

async function loadOpenClawConfig(configPath: string): Promise<OpenClawConfigRoot> {
  if (!existsSync(configPath)) {
    return { plugins: {} };
  }
  const raw = await readFile(configPath, "utf8");
  try {
    const parsed = JSON.parse(raw) as OpenClawConfigRoot;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { plugins: {} };
    }
    if (!parsed.plugins || typeof parsed.plugins !== "object") {
      parsed.plugins = {};
    }
    return parsed;
  } catch {
    throw new Error(`[graph-memory-pro] Failed to parse OpenClaw config at ${configPath}`);
  }
}

async function saveOpenClawConfig(configPath: string, config: OpenClawConfigRoot): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.graph-memory-${process.pid}.tmp`;
  let mode = 0o600;
  try {
    mode = (await stat(configPath)).mode & 0o777;
  } catch {}
  await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode,
  });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, configPath);
}

/** Return plugins.entries[pluginId].config, preserving the rest of openclaw.json. */
export function ensurePluginConfigRoot(
  config: OpenClawConfigRoot,
  pluginId: string,
): Record<string, unknown> {
  if (!isPlainObject(config.plugins)) config.plugins = {};
  if (!isPlainObject(config.plugins.entries)) config.plugins.entries = {};

  const entries = config.plugins.entries;
  if (!isPlainObject(entries[pluginId])) {
    entries[pluginId] = { enabled: true, config: {} };
  }
  const entry = entries[pluginId] as OpenClawPluginEntry;
  if (!isPlainObject(entry.config)) entry.config = {};
  return entry.config;
}

// ─── Provider / model 选择（简化版，当前仅支持 openai-codex） ────

interface ProviderSelection {
  providerId: OAuthProviderId;
  source: "flag" | "config" | "default";
}

function resolveProviderSelection(
  currentProvider: string | undefined,
  flagValue: string | undefined,
): ProviderSelection {
  if (flagValue && typeof flagValue === "string" && flagValue.trim()) {
    return { providerId: normalizeOAuthProviderId(flagValue), source: "flag" };
  }
  if (currentProvider && typeof currentProvider === "string" && currentProvider.trim()) {
    try {
      return { providerId: normalizeOAuthProviderId(currentProvider), source: "config" };
    } catch {
      // 当前配置的 provider 名无效，回退到默认
    }
  }
  return { providerId: normalizeOAuthProviderId(undefined), source: "default" };
}

interface ModelSelection {
  model: string;
  source: "flag" | "config" | "default";
}

function pickOauthModel(
  providerId: OAuthProviderId,
  currentModel: string | undefined,
  flagModel: string | undefined,
): ModelSelection {
  if (flagModel && typeof flagModel === "string" && flagModel.trim()) {
    return { model: flagModel.trim(), source: "flag" };
  }
  if (currentModel && typeof currentModel === "string" && currentModel.trim()) {
    return { model: currentModel.trim(), source: "config" };
  }
  return { model: getDefaultOauthModelForProvider(providerId), source: "default" };
}

// ─── OAuth 会话文件备份目录 ─────────────────────────────────────
// 切到 oauth 前把旧 llm 配置备份到 oauthPath 同目录，便于用户回退。

async function backupLegacyLlmConfig(oauthPath: string, legacyLlm: unknown): Promise<void> {
  if (!legacyLlm || typeof legacyLlm !== "object") return;
  const backupPath = path.join(path.dirname(oauthPath), "llm-config.backup.json");
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(
    backupPath,
    JSON.stringify({ backedUpAt: new Date().toISOString(), llm: legacyLlm }, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(backupPath, 0o600);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOauthLlmConfig(llm: unknown): boolean {
  return isPlainObject(llm) && llm.provider === "oauth";
}

export function applyOAuthConfig(
  config: OpenClawConfigRoot,
  pluginId: string,
  oauth: {
    providerId: OAuthProviderId;
    oauthPath: string;
    model: string;
    reasoningEffort: ReasoningEffort;
  },
): { existingLlm: Record<string, unknown>; wasOauthMode: boolean } {
  const pluginConfig = ensurePluginConfigRoot(config, pluginId);
  const hadLlmConfig = isPlainObject(pluginConfig.llm);
  const existingLlm: Record<string, unknown> = hadLlmConfig
    ? { ...(pluginConfig.llm as Record<string, unknown>) }
    : {};
  const wasOauthMode = isOauthLlmConfig(existingLlm);

  pluginConfig.llm = {
    ...existingLlm,
    provider: "oauth",
    oauthProvider: oauth.providerId,
    oauthPath: oauth.oauthPath,
    model: oauth.model,
    reasoningEffort: oauth.reasoningEffort,
  };

  return { existingLlm, wasOauthMode };
}

// ─── CLI 工厂 ───────────────────────────────────────────────────

export function createGraphMemoryCli(deps: GraphMemoryCliDeps) {
  return ({ program }: GraphMemoryCliRegistrarContext): void => {
    const pluginId = deps.pluginId || DEFAULT_PLUGIN_ID;

    const root = program
      .command("graph-memory")
      .description("graph-memory-pro: Neo4j 知识图谱记忆引擎管理命令")
      .action(() => {
        root.outputHelp();
      });

    const auth = root
      .command("auth")
      .description("管理用于 LLM 智能抽取的 OAuth 认证")
      .action(() => {
        auth.outputHelp();
      });

    auth
      .command("login")
      .description(
        "通过浏览器登录 ChatGPT/Codex，写入 OAuth 会话文件，并把 graph-memory-pro 切换到 llm.provider=oauth",
      )
      .option("--config <path>", "OpenClaw 配置文件路径", DEFAULT_CONFIG_PATH)
      .option(
        "--provider <provider>",
        "OAuth 提供商（目前仅支持 openai-codex）",
        undefined,
      )
      .option("--model <model>", "保存到 llm.model 的模型名（覆盖默认值）", undefined)
      .option(
        "--effort <level>",
        "推理模型思考强度：low / medium / high（默认沿用现有配置，否则 medium）",
        undefined,
      )
      .option(
        "--oauth-path <path>",
        `OAuth 会话文件路径（默认 ${DEFAULT_OAUTH_PATH}）`,
        DEFAULT_OAUTH_PATH,
      )
      .option(
        "--timeout <seconds>",
        "OAuth 回调等待超时（秒）",
        String(DEFAULT_TIMEOUT_SECONDS),
      )
      .option("--no-browser", "不自动打开浏览器，只打印授权 URL")
      .action(async (options: Record<string, unknown>) => {
        try {
          // ── 解析选项 ──
          const configFlag = typeof options.config === "string" ? options.config : DEFAULT_CONFIG_PATH;
          const configPath = deps.resolveConfigPath
            ? deps.resolveConfigPath(configFlag)
            : path.resolve(configFlag);

          const oauthPathFlag = typeof options.oauthPath === "string" ? options.oauthPath : DEFAULT_OAUTH_PATH;
          const oauthPath = path.resolve(oauthPathFlag);

          const timeoutSeconds = parseInt(String(options.timeout ?? DEFAULT_TIMEOUT_SECONDS), 10);
          const timeoutMs = Math.max(15_000, Math.min((isNaN(timeoutSeconds) ? DEFAULT_TIMEOUT_SECONDS : timeoutSeconds) * 1000, 900_000));

          // ── 当前 pluginConfig.llm（从 deps 拿，若 register 时注入了） ──
          const currentLlm = isPlainObject(deps.pluginConfig) && isPlainObject(deps.pluginConfig.llm)
            ? deps.pluginConfig.llm
            : undefined;
          const currentProvider = typeof currentLlm?.oauthProvider === "string" ? currentLlm.oauthProvider : undefined;
          const currentModel = typeof currentLlm?.model === "string" ? currentLlm.model : undefined;
          const currentEffort = typeof currentLlm?.reasoningEffort === "string" ? currentLlm.reasoningEffort : undefined;

          // ── 校验并解析 reasoningEffort（CLI flag > 当前配置 > 默认 medium） ──
          const effortFlag = typeof options.effort === "string"
            ? options.effort.trim().toLowerCase()
            : (currentEffort?.trim().toLowerCase() || "medium");
          if (effortFlag !== "low" && effortFlag !== "medium" && effortFlag !== "high") {
            throw new Error(`--effort 仅支持 low / medium / high，收到：${effortFlag || "(空)"}`);
          }
          const reasoningEffort: ReasoningEffort = effortFlag;

          // ── 选择 provider / model ──
          const selectedProvider = resolveProviderSelection(
            currentProvider,
            typeof options.provider === "string" ? options.provider : undefined,
          );
          const selectedModel = pickOauthModel(
            selectedProvider.providerId,
            currentModel,
            typeof options.model === "string" ? options.model : undefined,
          );
          const oauthModel = normalizeOauthModel(selectedModel.model);

          if (!isOauthModelSupported(selectedProvider.providerId, selectedModel.model)) {
            throw new Error(
              `模型 "${selectedModel.model}" 不被 provider ${selectedProvider.providerId} 支持。` +
              `请检查拼写，或省略 --model 使用默认值 ${getDefaultOauthModelForProvider(selectedProvider.providerId)}。`,
            );
          }

          // ── 用户可见的 provider 列表（仅一个时跳过提示） ──
          const providers = listOAuthProviders();
          if (providers.length > 1) {
            console.log(
              `可用 provider: ${providers.map((p) => `${p.id} (${p.label})`).join(", ")}`,
            );
          }

          console.log(`配置文件: ${configPath}`);
          console.log(
            `Provider: ${getOAuthProviderLabel(selectedProvider.providerId)} (${selectedProvider.providerId}, ${selectedProvider.source})`,
          );
          console.log(`OAuth 文件: ${oauthPath}`);
          console.log(`Model: ${oauthModel} (${selectedModel.source})`);
          console.log(`思考强度: ${reasoningEffort}${currentEffort && currentEffort !== reasoningEffort ? ` (原配置: ${currentEffort})` : ""}`);

          // ── 触发 PKCE 流程（model 不传：performOAuthLogin 不消费它，
          //     仅在登录成功后由下面的 config writeback 写回 llm.model） ──
          const { session } = await performOAuthLogin({
            authPath: oauthPath,
            timeoutMs,
            noBrowser: options.browser === false,
            providerId: selectedProvider.providerId,
            onOpenUrl: deps.oauthTestHooks?.openUrl,
            onAuthorizeUrl: async (url: string) => {
              console.log(`授权 URL: ${url}`);
              await deps.oauthTestHooks?.authorizeUrl?.(url);
            },
          });

          // ── 写回 openclaw.json，切换到 oauth provider ──
          const openclawConfig = await loadOpenClawConfig(configPath);
          const { existingLlm, wasOauthMode } = applyOAuthConfig(openclawConfig, pluginId, {
            providerId: selectedProvider.providerId,
            oauthPath,
            model: oauthModel,
            reasoningEffort,
          });

          if (!wasOauthMode && Object.keys(existingLlm).length > 0) {
            await backupLegacyLlmConfig(oauthPath, existingLlm);
          }

          await saveOpenClawConfig(configPath, openclawConfig);

          console.log(`OAuth 登录完成，账号 ${session.accountId}。`);
          console.log(
            `已更新 ${pluginId} 配置：llm.provider=oauth, llm.oauthProvider=${selectedProvider.providerId}, llm.oauthPath=${oauthPath}, llm.model=${oauthModel}, llm.reasoningEffort=${reasoningEffort}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("OAuth 登录失败：", message);
          throw new Error(`[graph-memory-pro] OAuth login failed: ${message}`);
        }
      });

    root
      .command("extract")
      .description(
        "扫描 Neo4j 中未提取的会话消息，按 compact 流程批量补提知识图谱，并同步节点 embedding",
      )
      .option("--yes", "跳过确认提示，直接执行提取", false)
      .option("--dry-run", "只列出待提取会话，不调用 LLM", false)
      .option("--limit <n>", "每个会话每批最多提取的消息条数（默认 compactTurnCount * 3）", undefined)
      .option("--session <id>", "仅提取指定 sessionId（默认全部含未提取消息的会话）", undefined)
      .option("--model <model>", "本次提取使用的 LLM 模型（覆盖配置中的 llm.model / agents.defaults.model）", undefined)
      .action(async (options: Record<string, unknown>) => {
        try {
          const rawCfg = isPlainObject(deps.pluginConfig)
            ? (deps.pluginConfig as Record<string, unknown>)
            : {};
          const cfg: GmConfig = {
            ...DEFAULT_CONFIG,
            ...(rawCfg as Partial<GmConfig>),
          };
          if (isPlainObject(rawCfg.neo4j)) {
            cfg.neo4j = { ...DEFAULT_CONFIG.neo4j, ...(rawCfg.neo4j as any) };
          }

          const cfgLlm = isPlainObject(rawCfg.llm) ? (rawCfg.llm as any) : undefined;
          const flagModel = typeof options.model === "string" && options.model.trim()
            ? options.model.trim()
            : undefined;
          const effectiveModel = flagModel ?? cfgLlm?.model ?? deps.defaultModel ?? "";

          const limitFlag = typeof options.limit === "string"
            ? Number.parseInt(options.limit, 10)
            : (typeof options.limit === "number" ? options.limit : undefined);

          await runBackfillExtraction({
            cfg,
            effectiveModel,
            options: {
              yes: options.yes === true,
              dryRun: options.dryRun === true,
              session: typeof options.session === "string" ? options.session : undefined,
              limit: limitFlag !== undefined && Number.isFinite(limitFlag) && limitFlag > 0
                ? Math.floor(limitFlag)
                : undefined,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[graph-memory-pro] extract 失败：", message);
          throw new Error(`[graph-memory-pro] extract failed: ${message}`);
        }
      });

    root
      .command("reembed")
      .description(
        "清除现有向量并用当前 embedding 模型批量重建（换 embedding 模型后必须执行，否则旧向量静默失效）",
      )
      .option("--yes", "跳过确认提示，直接执行", false)
      .option("--dry-run", "只报告向量覆盖情况与维度对照，不写入", false)
      .option("--batch <n>", "每次 embedding 请求携带的文本条数（默认 32，上限 256）", undefined)
      .option(
        "--recreate-index",
        "向量索引维度与当前模型输出不符时，删除索引并按 embedding.dimensions 重建",
        false,
      )
      .action(async (options: Record<string, unknown>) => {
        try {
          const rawCfg = isPlainObject(deps.pluginConfig)
            ? (deps.pluginConfig as Record<string, unknown>)
            : {};
          const cfg: GmConfig = {
            ...DEFAULT_CONFIG,
            ...(rawCfg as Partial<GmConfig>),
          };
          if (isPlainObject(rawCfg.neo4j)) {
            cfg.neo4j = { ...DEFAULT_CONFIG.neo4j, ...(rawCfg.neo4j as any) };
          }
          if (isPlainObject(rawCfg.embedding)) {
            cfg.embedding = { ...(rawCfg.embedding as any) };
          }

          const batchFlag = typeof options.batch === "string"
            ? Number.parseInt(options.batch, 10)
            : (typeof options.batch === "number" ? options.batch : undefined);

          await runReembed({
            cfg,
            options: {
              yes: options.yes === true,
              dryRun: options.dryRun === true,
              recreateIndex: options.recreateIndex === true,
              batch: batchFlag !== undefined && Number.isFinite(batchFlag) && batchFlag > 0
                ? Math.floor(batchFlag)
                : undefined,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[graph-memory-pro] reembed 失败：", message);
          throw new Error(`[graph-memory-pro] reembed failed: ${message}`);
        }
      });
  };
}
