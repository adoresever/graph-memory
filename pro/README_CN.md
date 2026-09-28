# Graph Memory Pro Lite：DSH 插件化第一阶段

这一目录不是新的桌面产品，而是 Graph Memory 面向 DeepSeek Harness 的可选 Pro 插件层。它与 Community 插件共用 SQLite 数据库，通过 Host 侧服务输出有上限的图快照，为后续分屏画布和受控拖拽提供稳定接口。

## 当前已经实现

- `SqliteGraphSnapshotStore` 直接读取 Community 插件维护的节点与边，不要求 Neo4j。
- `GraphMemoryProHostApi` 只暴露 `getSnapshot()` 和 `getNodeDetail()`，不暴露数据库连接、SQL、Cypher 或凭据。
- 图快照限制节点数、边数和文本长度；概览不返回记忆正文和会话标识。
- `graph-memory/pro/dsh` 提供 DSH Host 插件，并注册 `gm_graph_snapshot`、`gm_graph_node` 两个可测试入口。
- `GraphMemoryProRemoteService` 通过 Typert 暴露只读 `snapshot/detail`，Client 不能绕过 Host 直接查询数据库。
- `dsh-pro/` 是独立的 `graph-memory-pro-dsh` bundle，在 DSH Web 侧边栏注册只读快照视图。
- Cordis disposer 会同时撤销 Host 服务并关闭它拥有的 SQLite 连接。

## 本地试运行

先安装当前 Graph Memory bundle，使 DSH profile 可以解析 `graph-memory` 包：

```bash
dsh plugin --profile web add git+https://github.com/adoresever/graph-memory.git
```

然后用 Pro Lite overlay 启动：

```bash
dsh --profile web \
  --patch ~/.dsh/profiles/web/node_modules/graph-memory/cordis.pro-lite.patch.yml
```

Community 插件使用 Node 内置 SQLite，不需要授权第三方原生构建脚本。开发源码也可以直接把 `--patch` 指向仓库中的 `cordis.pro-lite.patch.yml`。

Community 插件和 Pro Lite 默认读取同一个文件：

```text
~/.dsh/graph-memory/graph-memory.db
```

启动后可在模型工具列表中看到：

- `gm_graph_snapshot`：按关键词、节点类型和数量上限读取图投影。
- `gm_graph_node`：用户选中一个节点后，按 opaque id 读取受限正文。

## 与旧 Pro 的关系

旧 `desktop-2.0` 分支将 OpenClaw SDK、HTTP CRUD、Neo4j、GDS 和 Neovis 绑定为一个整体。本阶段只迁移宿主无关的图数据能力，不迁移以下实现：

- 不把 Neo4j URI、用户名或密码返回浏览器。
- 不允许前端提交任意 SQL 或 Cypher。
- 不要求用户为基础图谱安装数据库服务。
- 不把 OpenClaw HTTP route 当作 DSH Client API。

Neo4j 后续可实现为 `GraphSnapshotStore` 的可选 provider。无论选择 SQLite 还是 Neo4j，DSH Client 只消费相同的 `GraphSnapshot`。

## 下一阶段

1. 将当前卡片式快照升级成可缩放的 2D/3D 图谱，但继续消费同一个 `GraphSnapshot`。
2. 拖拽只传递节点 id 和动作意图，由 Host 校验后写入可见、可撤销的 session context。
3. 发布独立 bundle，使远程安装命令成为：

```bash
dsh plugin --profile web add graph-memory-pro-dsh
```

独立 bundle 已在 `dsh-pro/` 中实现并通过本地安装验证，但尚未发布到 npm。
