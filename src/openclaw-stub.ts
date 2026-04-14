// Stub for openclaw/plugin-sdk to allow tsc build without the peer dependency
export interface OpenClawPluginApi {
  pluginConfig?: unknown;
  config?: unknown;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
  };
  on: (event: string, handler: (...args: any[]) => any) => void;
  registerContextEngine: (name: string, factory: () => any) => void;
  registerTool: (factory: (ctx: any) => any, meta?: { name?: string }) => void;
}
