import { describe, expect, it, vi } from "vitest";
import graphMemoryProPlugin, { isGraphMemoryCliInvocation } from "../index.ts";
import { createGraphMemoryCli } from "../src/cli.ts";

class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  actionHandler?: (options: Record<string, unknown>) => void | Promise<void>;
  helpCount = 0;

  command(name: string): FakeCommand {
    const command = new FakeCommand();
    this.children.set(name, command);
    return command;
  }

  description(): FakeCommand {
    return this;
  }

  option(): FakeCommand {
    return this;
  }

  action(handler: (options: Record<string, unknown>) => void | Promise<void>): FakeCommand {
    this.actionHandler = handler;
    return this;
  }

  outputHelp(): void {
    this.helpCount += 1;
  }
}

function metadataApi(registrationMode?: string) {
  return {
    registrationMode,
    pluginConfig: {},
    config: {},
    resolvePath: (value: string) => value,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerCli: vi.fn(),
    registerTool: vi.fn(() => {
      throw new Error("runtime tools must not load during CLI discovery");
    }),
    registerContextEngine: vi.fn(() => {
      throw new Error("context engine must not load during CLI discovery");
    }),
    registerHttpRoute: vi.fn(() => {
      throw new Error("HTTP routes must not load during CLI discovery");
    }),
    on: vi.fn(() => {
      throw new Error("runtime hooks must not load during CLI discovery");
    }),
  };
}

describe("plugin CLI lifecycle", () => {
  it("prints help for the graph-memory and auth parent commands", async () => {
    const program = new FakeCommand();
    createGraphMemoryCli({})({ program });

    const root = program.children.get("graph-memory");
    const auth = root?.children.get("auth");
    expect(root?.actionHandler).toBeTypeOf("function");
    expect(auth?.actionHandler).toBeTypeOf("function");

    await root?.actionHandler?.({});
    await auth?.actionHandler?.({});
    expect(root?.helpCount).toBe(1);
    expect(auth?.helpCount).toBe(1);
  });

  it("registers only CLI metadata in modern OpenClaw metadata mode", () => {
    const api = metadataApi("cli-metadata");
    graphMemoryProPlugin.register(api as any);
    expect(api.registerCli).toHaveBeenCalledOnce();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerContextEngine).not.toHaveBeenCalled();
    expect(api.registerHttpRoute).not.toHaveBeenCalled();
  });

  it("registers only CLI metadata in discovery/tool-discovery/setup-only modes", () => {
    for (const mode of ["discovery", "tool-discovery", "setup-only"]) {
      const api = metadataApi(mode);
      graphMemoryProPlugin.register(api as any);
      expect(api.registerCli).toHaveBeenCalledOnce();
      expect(api.registerTool).not.toHaveBeenCalled();
      expect(api.registerContextEngine).not.toHaveBeenCalled();
      expect(api.registerHttpRoute).not.toHaveBeenCalled();
      expect(api.on).not.toHaveBeenCalled();
    }
  });

  it("recognizes the plugin command for legacy OpenClaw discovery", () => {
    expect(isGraphMemoryCliInvocation(["node", "openclaw", "graph-memory", "auth", "login"])).toBe(true);
    expect(isGraphMemoryCliInvocation(["node", "openclaw", "gateway"])).toBe(false);
  });

  it("skips runtime initialization when OpenClaw executes the CLI registrar", () => {
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "graph-memory"];
    try {
      const api = metadataApi("full");
      graphMemoryProPlugin.register(api as any);
      expect(api.registerCli).toHaveBeenCalledOnce();
      expect(api.registerTool).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });
});
