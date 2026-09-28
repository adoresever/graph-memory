import { SqliteGraphSnapshotStore } from "./sqlite.ts";
import { GraphMemoryProRemoteService } from "./remote-host.ts";
import type { GraphMemoryProHostApi, GraphNodeId, GraphSnapshotRequest } from "./types.ts";

export const name = "graph-memory-pro-dsh";
export const inject = ["tools"];
export const GRAPH_MEMORY_PRO_SERVICE = "graphMemoryPro";

export interface Config {
  dbPath?: string;
  defaultNodeLimit?: number;
  maxNodeLimit?: number;
  maxEdgeLimit?: number;
  overviewTextLimit?: number;
  detailContentLimit?: number;
  modelToolsEnabled?: boolean;
  remoteEnabled?: boolean;
}

interface DshContext {
  logger: {
    info(message: unknown, ...args: unknown[]): void;
  };
  tools: {
    register(definition: Record<string, unknown>): () => void;
  };
  provide(name: string, value: unknown): () => void;
  effect(register: () => (() => void | Promise<void>), label?: string): () => void;
}

function jsonOutput(title: string) {
  return {
    schema: { type: "string" },
    render: (_args: unknown, value: string) => [{ type: "text", text: value }],
    presentationMeta: () => ({ title }),
  };
}

/** Mount the bounded Pro graph-read service beside the Community memory plugin. */
export function apply(ctx: DshContext, input: Config = {}): void {
  const dbPath = input.dbPath ?? "~/.dsh/graph-memory/graph-memory.db";
  const store = new SqliteGraphSnapshotStore({
    dbPath,
    defaultNodeLimit: input.defaultNodeLimit,
    maxNodeLimit: input.maxNodeLimit,
    maxEdgeLimit: input.maxEdgeLimit,
    overviewTextLimit: input.overviewTextLimit,
    detailContentLimit: input.detailContentLimit,
  });
  const service: GraphMemoryProHostApi = {
    getSnapshot: (request) => store.getSnapshot(request),
    getNodeDetail: (id) => store.getNodeDetail(id),
  };

  if (input.remoteEnabled ?? true) {
    new GraphMemoryProRemoteService(ctx, service);
  } else {
    ctx.effect(() => ctx.provide(GRAPH_MEMORY_PRO_SERVICE, service), "graph-memory-pro.service");
  }
  ctx.effect(() => () => { store.close(); }, "graph-memory-pro.close");

  if (input.modelToolsEnabled ?? true) {
    ctx.tools.register({
      name: "gm_graph_snapshot",
      description: "Return a bounded Graph Memory projection for graph visualization.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keywords used to select graph nodes" },
          nodeTypes: {
            type: "array",
            items: { type: "string", enum: ["TASK", "SKILL", "EVENT"] },
          },
          maxNodes: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      output: jsonOutput("Graph Memory graph snapshot"),
      execute: async (args: GraphSnapshotRequest) => JSON.stringify(service.getSnapshot(args)),
    });

    ctx.tools.register({
      name: "gm_graph_node",
      description: "Load the content of one Graph Memory node selected by its opaque id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
        additionalProperties: false,
      },
      output: jsonOutput("Graph Memory node detail"),
      execute: async (args: { id: string }) => JSON.stringify(
        service.getNodeDetail(args.id as GraphNodeId),
      ),
    });
  }

  ctx.logger.info(`[graph-memory-pro] DSH Pro Lite host active at ${dbPath}`);
}
