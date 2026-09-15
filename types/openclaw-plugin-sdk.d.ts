// Ambient stub for the `openclaw/plugin-sdk` module.
// graph-memory-pro imports types from this module at compile-time, but the
// real implementation is supplied by the OpenClaw host at runtime. This stub
// provides the minimal type surface we actually use so that `tsc --noEmit`
// passes in CI without depending on the openclaw npm package being installed.
// Keep the real openclaw package in peerDependencies for runtime resolution.

// `openclaw/plugin-sdk/core` — delegating-compaction bridge (OpenClaw 2026.6+).
// Signature mirrors host src/context-engine/{delegate,types}.ts: params are the
// engine compact() params passed through verbatim (sessionId/sessionKey/
// sessionTarget/runtimeContext/force/currentTokenCount/...), and the returned
// CompactResult is what engine compact() should return to the host.
declare module "openclaw/plugin-sdk/core" {
  export interface CompactResult {
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
      summary?: string;
      firstKeptEntryId?: string;
      tokensBefore: number;
      tokensAfter?: number;
      details?: unknown;
      sessionId?: string;
      sessionTarget?: unknown;
      sessionFile?: string;
    };
  }

  export function delegateCompactionToRuntime(
    params: Record<string, unknown>,
  ): Promise<CompactResult>;
}

declare module "openclaw/plugin-sdk" {
  import type { IncomingMessage, ServerResponse } from "http";

  export interface OpenClawPluginHttpRouteHandler {
    (req: IncomingMessage, res: ServerResponse):
      | Promise<boolean | void>
      | boolean
      | void;
  }

  export interface OpenClawPluginHttpRouteParams {
    path: string;
    handler: OpenClawPluginHttpRouteHandler;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }

  /** Minimal commander-compatible surface; the real instance is injected by host. */
  export interface OpenClawPluginCliCommand {
    command(name: string): OpenClawPluginCliCommand;
    description(text: string): OpenClawPluginCliCommand;
    option(flags: string, description?: string, defaultValue?: unknown): OpenClawPluginCliCommand;
    action(handler: (options: Record<string, unknown>) => void | Promise<void>): OpenClawPluginCliCommand;
    outputHelp(): void;
  }

  export interface OpenClawPluginCliContext {
    program: OpenClawPluginCliCommand;
    parentPath: readonly string[];
    config: any;
    workspaceDir?: string;
    logger: OpenClawPluginLogger;
  }

  export type OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => void | Promise<void>;

  export interface OpenClawPluginCliRegistrationOptions {
    parentPath?: readonly string[];
    commands?: readonly string[];
  }

  export interface OpenClawPluginLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }

  // Internal hook system (colon event names, e.g. "session:patch"). Distinct
  // from the typed runner behind api.on(...): underscore names registered here
  // are never invoked. Host dispatch awaits handlers sequentially, swallows
  // handler errors into its own log, and applies no timeout.
  export interface OpenClawInternalHookEvent {
    type: "command" | "session" | "agent" | "gateway" | "message";
    action: string;
    sessionKey: string;
    context: Record<string, unknown>;
    timestamp: Date;
    messages: string[];
  }

  export interface OpenClawPluginHookOptions {
    /** Required: registration name ("hook registration missing name" otherwise). */
    name?: string;
    [key: string]: unknown;
  }

  export interface OpenClawPluginApi {
    logger: OpenClawPluginLogger;
    config: any;
    pluginConfig: unknown;
    registrationMode?: "full" | "discovery" | "tool-discovery" | "setup-only" | "setup-runtime" | "cli-metadata";
    resolvePath(path: string): string;
    on(event: string, handler: (...args: any[]) => any): void;
    registerHook?(
      events: string | string[],
      handler: (event: OpenClawInternalHookEvent) => Promise<void> | void,
      opts?: OpenClawPluginHookOptions,
    ): void;
    registerContextEngine(id: string, factory: (...args: any[]) => any): void;
    registerTool(...args: any[]): void;
    registerHttpRoute(params: OpenClawPluginHttpRouteParams): void;
    registerCli?(
      registrar: OpenClawPluginCliRegistrar,
      opts?: OpenClawPluginCliRegistrationOptions,
    ): void;
    [key: string]: any;
  }
}
