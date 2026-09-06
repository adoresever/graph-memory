# graph-memory-pro

面向 OpenClaw 的 Neo4j 知识图谱上下文引擎。它从对话中提取 `TASK`、`SKILL`、`EVENT` 三元组，跨会话召回关联经验，并通过 GDS PageRank、社区检测和向量去重维护图谱。

本仓库是 Windows `v2.0.0` 发布包的 Linux 可移植版本。它使用 Neo4j，不再使用 graph-memory v1.x 的 SQLite 后端。

## 功能

- Neo4j 标签：`Task`、`Skill`、`Event`、`Community`、`GmMessage`
- 五种关系：`USED_SKILL`、`SOLVED_BY`、`REQUIRES`、`PATCHES`、`CONFLICTS_WITH`
- 使用 GDS 个性化 PageRank 进行召回，使用全局 PageRank 进行维护
- 使用 Neo4j 向量索引实现语义召回和重复节点检测
- 使用 APOC 动态创建关系、合并节点
- 基于社区摘要的泛化召回
- 提供受 Gateway 鉴权保护的 CRUD API：`/graph-memory-pro/api/`

## 前置条件

- OpenClaw
- Node.js 20+
- 使用 Linux 安装器时需要 Java 17+
- Neo4j 5.24.2 与 APOC 5.24.2
- 推荐 GDS 2.12.0；缺少 GDS 时 PageRank 会降级为基础排序

## Linux 一键安装

在仓库根目录运行：

```bash
bash setup-graph-memory-pro.sh
```

脚本会在 `~/.graph-memory-pro/neo4j` 安装用户级 Neo4j，配置 APOC/GDS，安装或注册当前本地插件，写入 `~/.openclaw/openclaw.json`，并在可用时重启 gateway。

常用参数：

```bash
bash setup-graph-memory-pro.sh --dry-run
bash setup-graph-memory-pro.sh --skip-neo4j --neo4j-uri bolt://localhost:7687 --neo4j-password '你的密码'
bash setup-graph-memory-pro.sh --uninstall
```

安装器默认只监听 `127.0.0.1`，Bolt 端口为 `7687`。

## 手动配置

安装插件后，在 `~/.openclaw/openclaw.json` 中配置（**修改配置后需重启网关生效**：插件内置防重复注册守卫，宿主未 dispose 的二次 `register()` 会复用现有引擎，新配置不会热加载）：

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "graph-memory-pro"
    },
    "entries": {
      "graph-memory-pro": {
        "enabled": true,
        "config": {
          "neo4j": {
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "你的 Neo4j 密码"
          },
          "llm": {
            "provider": "openai",
            "apiKey": "你的 LLM API Key",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "你的 Embedding API Key",
            "baseURL": "https://api.openai.com/v1",
            "model": "text-embedding-v4",
            "dimensions": 1024
          }
        }
      }
    }
  }
}
```

Anthropic 直连（Claude）——去掉 `baseURL`，切换 `provider`：

```json
"llm": {
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "model": "claude-3-5-sonnet-20241022"
}
```

`embedding` 可选。设置时，`dimensions` 必须与 Neo4j 向量索引维度一致。新数据库会在插件启动时按配置创建索引；更换维度后需要重建向量索引或 Neo4j 数据库。

### 记忆衰减（遗忘曲线）

每个维护周期对全部 active 节点做三因子加权评分（recency + frequency + intrinsic），并在三个 tier 之间双向转换：`core` / `working` / `peripheral`。遗忘曲线之上还有两段生命周期（默认开启，可通过 `decay` 配置）：**自动弃用**——`peripheral` 层且 composite 持续低于 `peripheralCompositeThreshold`、超过 `autoDeprecateAfterDays`（30）天未访问的节点会被切断所有边并标记 `deprecated`；若同名知识之后被重新提取或编辑，节点自动复活回 `active`。**到期清理**——所有 `deprecated` 节点（含手动弃用与合并产物）自弃用起超过 `purgeAfterDays`（60）天后硬删（`DETACH DELETE`，向量随节点移除）以释放存储。

完整公式、字段映射、默认值依据与调参指南见 **[`docs/decay.md`](docs/decay.md)**。

最小配置（所有字段可选，默认值如下）：

```json
"decay": { "enabled": true }
```

常用覆盖——完整参数见 `docs/decay.md` §4：

```json
"decay": {
  "enabled": true,
  "recencyHalfLifeDays": 30,
  "peripheralCompositeThreshold": 0.15,
  "workingAccessThreshold": 3
}
```

### cron 会话行为控制

OpenClaw 定时任务创建的会话可以独立配置图谱行为。host 把 cron 标记放在 **sessionKey** 上（`sessionId` 是随机 UUID），实际形状为 `cron:<jobId>`、`agent:<agentId>:cron:<jobId>` 或 `agent:<agentId>:cron:<jobId>:run:<runId>`：

```json
"cron": {
  "enabled": true,
  "extract": true,
  "finalizeAndMaintain": true
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否在 cron 会话内启用图谱功能（召回注入 + 消息入库）。关闭后 cron 会话不自动召回、不自动入库；`gm_*` 工具仍可手动调用（作为显式逃生通道）。 |
| `extract` | `true` | 是否在 cron 会话内触发知识提取（afterTurn / compact 的 LLM 三元组提取）。关闭后消息仍入库缓冲，之后可用 `openclaw graph-memory extract` 手动回填。 |
| `finalizeAndMaintain` | `true` | cron 会话结束时是否执行 finalize（EVENT→SKILL 晋升）和图维护（decay / PageRank / 社区检测）。定时任务频繁时可关闭，避免每次会话结束都跑全局维护。 |

三个选项**默认全部开启**：cron 会话默认使用图谱，需按需显式关闭。`enabled=false` 是总开关：即使 `extract`/`finalizeAndMaintain` 设为 `true` 也不生效。非 cron 会话不受这些选项影响。三个子项均可省略，未写的字段取默认值 `true`。

注意：若 cron 任务显式设置了自定义 `sessionKey`，host 不再附加 `cron` 段，此类会话无法被识别，将按普通会话处理。

### 原始消息保留（messageRetention，opt-in）

上下文压缩只改变模型可见面，**不构成删除持久证据的授权**——默认 `keep=all` 永不删除任何原始消息（GmMessage），零开销。需要控制库体积时可显式开启有界清理，挂在图维护链尾部，每个维护周期最多处理 `batchSize` 行：

```json
"messageRetention": {
  "keep": "referenced",
  "batchSize": 500,
  "dryRun": false
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `keep` | `"all"` | `all`=全部保留（默认，零行为变化）；`referenced`=只删"已提取完成且实际产出知识"的消息；`recent`=在 `referenced` 基础上叠加时间窗保护（需至少配一个窗口参数）。 |
| `recentTurns` | `0` | `keep=recent`：每 session 保留最近 N 轮真实用户发言（该轮及其后的全部消息保留）。无 user 消息的 session 完全保护。 |
| `retentionDays` | `0` | `keep=recent`：保留最近 N 天内入库的消息。 |
| `batchSize` | `500` | 单个维护周期最多处理的行数（1~10000），保证维护链工作有界。 |
| `dryRun` | `false` | `true` 时只报告候选集不删除——**启用清理前建议先跑一轮 `dryRun` 验证候选集**。 |

删除语义（fail-closed）：

- 只有 `extracted=true` **且** `producedKnowledge=true`（该轮 LLM 提取实际产出节点/边）的消息才会进入候选。
- LLM 空提取（成功返回零节点零边）的轮次标记 `producedKnowledge=false`，原始证据保留在库中。此类轮次不会自动重提；如需用更好的 prompt/模型重挖，需手动将这些行的 `extracted` 重置为 `false`，再运行 `openclaw graph-memory extract` 回填。
- 未提取消息、以及标记机制上线前的遗留行（无 `producedKnowledge` 属性）一律不删。
- 保留步骤自身失败（非法策略 fail-closed 不删 / Neo4j 故障）不影响维护链的其他步骤，下一周期自动重试。

### 更换 embedding 模型后的重嵌入

embedding 向量与模型绑定——旧模型产出的向量与新模型不可比（维度不同时去重与向量搜索直接失效），
且向量只写不删、没有自动迁移。更改 `embedding.model` / `embedding.dimensions` 后请执行：

```bash
openclaw graph-memory reembed --dry-run   # 只报告维度对照与向量覆盖情况，不写入
openclaw graph-memory reembed             # 清空全部向量并按批重建
```

该命令清空所有 `MemoryNode.embedding`（连同 `contentHash`，避免运行时 `syncEmbed`
被旧文本 hash 短路），然后用当前模型按批重建全部活跃节点与社区摘要向量（`--batch <n>`，
默认 32；批失败自动退化为逐条请求）。若向量索引维度与当前模型不符，命令会中止——加
`--recreate-index` 删除并按新维度重建 `gm_node_embedding` / `gm_community_embedding`。
失败条目保持无向量，修复端点后重跑本命令即可增量补齐。

### OAuth 登录（实验性）

```bash
openclaw graph-memory auth login
```

命令通过浏览器完成登录，将令牌以 `0600` 权限保存到
`~/.openclaw/.graph-memory-pro/oauth.json`，并原子更新
`plugins.entries.graph-memory-pro.config.llm`。原有非 OAuth LLM 配置会备份到同目录的
`llm-config.backup.json`。此路径依赖 Codex/ChatGPT 的 OAuth 与后端协议，不属于稳定的公开 OpenAI API 合约；生产环境优先使用 API Key 配置。

## 数据流

```text
对话消息 -> GmMessage 节点 -> LLM 提取三元组
  -> Task / Skill / Event 节点和类型化关系
  -> embedding -> 向量召回 + 社区扩展 + GDS PPR
  -> XML 上下文注入

会话结束 -> 衰减（遗忘曲线）-> 去重 -> 全局 PageRank -> 社区 -> 社区摘要
```

## 验证

```bash
openclaw gateway --verbose
```

启动日志应包含：

```text
[graph-memory-pro] Neo4j schema initialized
[graph-memory-pro] ready | neo4j=bolt://localhost:7687
```

使用安装器自带的 Cypher Shell 查看图谱：

```bash
~/.graph-memory-pro/neo4j/bin/cypher-shell -u neo4j -p '你的密码' \
  "MATCH (n:Task|Skill|Event) RETURN n.type, n.name, n.pagerank ORDER BY n.pagerank DESC LIMIT 10"
```

## Agent 工具

| 工具 | 说明 |
| --- | --- |
| `gm_search` | 按查询召回图谱知识 |
| `gm_record` | 手动记录知识节点 |
| `gm_update` | 按精确节点名称更新 / 弃用已有节点（不存在则报错）。`mode=update`（默认）refine description/content；`mode=deprecate` 标记 `[DEPRECATED]` 并切断所有关系，节点不再可被召回（等效删除；维护链在 `purgeAfterDays` 天后物理清理）。`mode=delete` 已移除，由 deprecate 取代 |
| `gm_link` | 手动在两个已存在节点之间建立或细化关系边（按白名单校验类型+方向；from+to+type 已存在时仅更新 instruction） |
| `gm_unlink` | 按名称删除两节点之间的关系边；可选 type 过滤，不传则删除 from→to 之间所有边 |
| `gm_merge` | 合并两个同类型重复节点：keep 吸收 content/validatedCount/sessions + 去重边迁移；merge 节点被软删除（deprecated） |
| `gm_stats` | 查看节点、关系、社区和 PageRank 统计 |
| `gm_maintain` | 执行衰减评分、去重、PageRank 和社区维护 |

## 开发

```bash
npm install
npm run build
npm test
```

`npm run typecheck` 检查源码和测试类型；`npm run build` 将安装时使用的 JavaScript 运行入口输出到 `dist/`。OpenClaw 在源码工作区使用 TypeScript 入口，在安装包中优先使用构建后的入口。

### 集成测试

存储层 / Cypher / 图算法的变更由集成测试覆盖，需要带 APOC 和 GDS 的 Neo4j 实例：

```bash
# 本地运行：先启动 Neo4j 5.24.2 + APOC + GDS，然后
NEO4J_INTEGRATION=1 npm test
```

CI 通过 Docker Neo4j 服务容器运行这些测试——详见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。修改存储层或 Cypher 行为时，请在 `test/integration.*.test.ts` 下补充集成测试；单元测试仅覆盖纯逻辑。

## 许可证

MIT
