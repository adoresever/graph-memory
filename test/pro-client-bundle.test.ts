import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface LoadedClient {
  id: string;
  factory: (require: (id: string) => unknown) => {
    inject: string[];
    apply(ctx: any): Promise<() => Promise<void>>;
  };
}

describe("DSH Pro client bundle", () => {
  it("mounts strict Remote descriptors and registers the sidebar entry", async () => {
    let loaded: LoadedClient | undefined;
    runInNewContext(readFileSync(new URL("../dsh-pro/client.js", import.meta.url), "utf8"), {
      window: { __ModuleLoader__: { load: (entry: LoadedClient) => { loaded = entry; } } },
    });
    expect(loaded?.id).toBe("graph-memory-pro-dsh");

    const react = {
      Fragment: "fragment",
      createElement: (...args: unknown[]) => ({ args }),
      useState: (initial: unknown) => [initial, () => {}],
      useCallback: (callback: unknown) => callback,
      useEffect: () => {},
    };
    const plugin = loaded!.factory((id) => {
      if (id === "react") return react;
      throw new Error(`unexpected client external ${id}`);
    });
    const mounted: any[] = [];
    const registered: any[] = [];
    const disposeRemote = vi.fn(async () => {});
    const disposeSlot = vi.fn();
    const ctx = {
      remote: {
        $mount: async (contribution: unknown) => { mounted.push(contribution); return disposeRemote; },
      },
      slots: {
        inject: (name: string, setup: () => unknown) => {
          expect(name).toBe("sidebar.footer.action");
          setup();
          return disposeSlot;
        },
        register: (options: unknown, component: unknown) => {
          registered.push({ options, component });
          return () => {};
        },
      },
    };

    const dispose = await plugin.apply(ctx);
    expect(plugin.inject).toEqual(["slots", "remote"]);
    expect(mounted[0].descriptors.map((descriptor: any) => descriptor.method)).toEqual(["snapshot", "detail"]);
    expect(() => mounted[0].descriptors[0].parameters[0].codec.schema.parse({ maxNodes: 1001 }))
      .toThrow(/maxNodes/);
    expect(registered[0].options).toMatchObject({
      name: "sidebar.footer.action",
      id: "graph-memory-pro",
    });
    await dispose();
    expect(disposeSlot).toHaveBeenCalledOnce();
    expect(disposeRemote).toHaveBeenCalledOnce();
  });
});
