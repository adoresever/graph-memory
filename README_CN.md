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

安装插件后，在 `~/.openclaw/openclaw.json` 中配置：

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

`embedding` 可选。设置时，`dimensions` 必须与 Neo4j 向量索引维度一致。新数据库会在插件启动时按配置创建索引；更换维度后需要重建向量索引或 Neo4j 数据库。

## 数据流

```text
对话消息 -> GmMessage 节点 -> LLM 提取三元组
  -> Task / Skill / Event 节点和类型化关系
  -> embedding -> 向量召回 + 社区扩展 + GDS PPR
  -> XML 上下文注入

会话结束 -> 去重 -> 全局 PageRank -> 社区 -> 社区摘要
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
| `gm_update` | 按精确节点名称更新已有节点的描述和/或内容（不存在则报错） |
| `gm_stats` | 查看节点、关系、社区和 PageRank 统计 |
| `gm_maintain` | 执行去重、PageRank 和社区维护 |

## 开发

```bash
npm install
npm run build
npm test
```

`npm run build` 只进行 TypeScript 类型检查。当前移植版没有 live-Neo4j 集成测试；修改存储层或 Cypher 前应补充针对 Neo4j 的集成测试。

## 许可证

MIT
