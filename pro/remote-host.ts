import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {
  GraphMemoryProHostApi,
  GraphNodeDetail,
  GraphNodeId,
  GraphSnapshot,
  GraphSnapshotRequest,
} from "./types.ts";

type RemoteInitializer = (this: GraphMemoryProRemoteService) => void;
const remoteInitializers: RemoteInitializer[] = [];

/** DSH Typert service exposing only bounded, read-only graph operations. */
export class GraphMemoryProRemoteService extends TypertRemoteService {
  readonly #api: GraphMemoryProHostApi;

  constructor(ctx: unknown, api: GraphMemoryProHostApi) {
    super(ctx, "graphMemoryPro");
    this.#api = api;
    for (const initialize of remoteInitializers) initialize.call(this);
  }

  /** Return one validated, bounded graph projection. */
  snapshot(request: GraphSnapshotRequest): GraphSnapshot {
    return this.#api.getSnapshot(request);
  }

  /** Return bounded content for one selected opaque node id. */
  detail(id: GraphNodeId): GraphNodeDetail | null {
    return this.#api.getNodeDetail(id);
  }
}

function markRemote(method: "snapshot" | "detail"): void {
  Remote(method)(GraphMemoryProRemoteService.prototype[method] as (...args: any[]) => any, {
    name: method,
    private: false,
    static: false,
    addInitializer(initializer: RemoteInitializer) {
      remoteInitializers.push(initializer);
    },
  } as unknown as ClassMethodDecoratorContext);
}

markRemote("snapshot");
markRemote("detail");
