import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apply, GRAPH_MEMORY_PRO_SERVICE } from "../pro/dsh.ts";
import type { GraphMemoryProHostApi } from "../pro/types.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DSH Pro Lite host", () => {
  it("provides a typed service, registers bounded tools, and disposes its store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-memory-pro-dsh-"));
    cleanup.push(dir);
    const tools: Array<Record<string, any>> = [];
    const services = new Map<string, unknown>();
    const disposers: Array<() => void | Promise<void>> = [];
    const ctx = {
      logger: { info: () => {} },
      tools: { register: (tool: Record<string, unknown>) => { tools.push(tool); return () => {}; } },
      provide: (name: string, value: unknown) => {
        services.set(name, value);
        return () => { services.delete(name); };
      },
      effect: (register: () => () => void | Promise<void>) => {
        disposers.push(register());
        return () => {};
      },
    };

    apply(ctx, { dbPath: join(dir, "memory.db"), remoteEnabled: false });
    expect(tools.map((tool) => tool.name)).toEqual(["gm_graph_snapshot", "gm_graph_node"]);
    const service = services.get(GRAPH_MEMORY_PRO_SERVICE) as GraphMemoryProHostApi;
    expect(service.getSnapshot().nodes).toEqual([]);
    for (const dispose of disposers.reverse()) await dispose();
    expect(services.has(GRAPH_MEMORY_PRO_SERVICE)).toBe(false);
    expect(() => service.getSnapshot()).toThrow(/closed/);
  });
});
