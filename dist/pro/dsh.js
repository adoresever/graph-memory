import { SqliteGraphSnapshotStore } from "./sqlite.js";
import { GraphMemoryProRemoteService } from "./remote-host.js";
export const name = "graph-memory-pro-dsh";
export const inject = ["tools"];
export const GRAPH_MEMORY_PRO_SERVICE = "graphMemoryPro";
function jsonOutput(title) {
    return {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
        presentationMeta: () => ({ title }),
    };
}
/** Mount the bounded Pro graph-read service beside the Community memory plugin. */
export function apply(ctx, input = {}) {
    const dbPath = input.dbPath ?? "~/.dsh/graph-memory/graph-memory.db";
    const store = new SqliteGraphSnapshotStore({
        dbPath,
        defaultNodeLimit: input.defaultNodeLimit,
        maxNodeLimit: input.maxNodeLimit,
        maxEdgeLimit: input.maxEdgeLimit,
        overviewTextLimit: input.overviewTextLimit,
        detailContentLimit: input.detailContentLimit,
    });
    const service = {
        getSnapshot: (request) => store.getSnapshot(request),
        getNodeDetail: (id) => store.getNodeDetail(id),
    };
    if (input.remoteEnabled ?? true) {
        new GraphMemoryProRemoteService(ctx, service);
    }
    else {
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
            execute: async (args) => JSON.stringify(service.getSnapshot(args)),
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
            execute: async (args) => JSON.stringify(service.getNodeDetail(args.id)),
        });
    }
    ctx.logger.info(`[graph-memory-pro] DSH Pro Lite host active at ${dbPath}`);
}
