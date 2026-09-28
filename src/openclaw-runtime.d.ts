// index.ts imports OpenClawPluginApi as a type only. This local declaration
// keeps a DSH-only source checkout buildable when the optional OpenClaw peer is
// absent. OpenClaw supplies the real runtime module when it loads dist/index.js.
declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    readonly pluginConfig?: unknown;
    readonly config: unknown;
    readonly logger: {
      info(message: unknown, ...args: unknown[]): void;
      warn(message: unknown, ...args: unknown[]): void;
      error(message: unknown, ...args: unknown[]): void;
    };
    registerContextEngine(name: string, factory: () => unknown): void;
    on(event: string, listener: (...args: any[]) => any): void;
    registerTool(factory: (...args: any[]) => unknown, options?: { name?: string }): void;
  }
}
