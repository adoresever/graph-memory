# Graph Memory

![DeepSeek Harness + OpenClaw → Graph Memory](docs/images/brand/graph-memory-hosts-banner.png)

<p align="center">
  <strong>为 AI Agent 提供可检索、可追溯、跨会话的长期记忆</strong><br>
  一个宿主无关的图记忆内核，原生接入 DeepSeek Harness，并继续兼容 OpenClaw。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#核心优势">核心优势</a> ·
  <a href="#图记忆架构">图架构</a> ·
  <a href="#安装到-deepseek-harness">DSH 安装</a> ·
  <a href="#graph-memory-pro如何作为-dsh-插件集成">Pro 插件</a> ·
  <a href="docs/DSH_NATIVE_PLAN.md">技术报告</a>
</p>

Graph Memory 不是聊天记录归档器，也不是把所有历史重新塞回上下文。它把对话中的任务、技能、事件和因果关系沉淀为类型化知识图谱，在新问题出现时只召回相关的局部子图。

## 核心优势

### 一套内核，两个原生宿主入口

- **DeepSeek Harness**：通过 Cordis 生命周期接入 Session、Tool、Agent Loop、Prompt Assembly、LLM 与 Credentials；不修改 DSH 核心源码。
- **OpenClaw**：保留原有 Context Engine 插件入口、配置方式和数据能力。
- **共享内核**：抽取、SQLite 存储、FTS5、向量检索、社区发现、PageRank 和上下文组装不绑定单一宿主。

### 把历史变成可复用知识

- 跨 Session 召回，宿主重启后仍然保留。
- `TASK`、`SKILL`、`EVENT` 三类节点表达目标、方法、结果、错误与决策。
- `USED_SKILL`、`SOLVED_BY`、`REQUIRES`、`PATCHES`、`CONFLICTS_WITH` 五类关系保留因果和依赖。
- 节点关联原始会话证据，能够解释“这条记忆从哪里来、为什么被召回”。

### 只把相关知识送进上下文

- 默认原样保留最近 5 个真实用户轮次，可通过 `freshTurnCount` 配置。
- 通过每个 Agent 的 DSH 公共 CompactionEngine，把更早的模型表面历史替换为滚动 checkpoint；持久化原始事件不删除。
- checkpoint、知识节点与精确原消息来源建立关联，召回时可以回溯原文。
- 精确路径：向量 / FTS5 → 社区扩展 → 图遍历 → 个性化 PageRank。
- 泛化路径：查询向量 → 社区摘要 → 社区成员 → 图排序。
- 只注入与本轮问题相关的跨会话局部图，并受 `recallTokenBudget`（默认 4096）约束。
- 自动注入使用高精度语义门槛（`autoRecallMinScore`，默认 0.6），且不会在无关查询下退化为任意社区代表节点；显式 `gm_search` 仍保留宽召回。
- 召回内容被标记为不可信参考材料，不能覆盖当前用户指令。

### 本地优先，向量能力可选

- Community 默认使用 SQLite，无需部署独立图数据库。
- 未配置 Embedding 时自动使用 FTS5，不阻断对话。
- 支持 OpenAI-compatible Embedding 接口，可接 DashScope、OpenAI 或本地服务。
- `gm_status` 显示数据库、节点、边、检索模式、向量覆盖率和维度。

### 限定场景下的 Token 实测

旧版 OpenClaw 入口曾在“安装 bilibili-mcp → 登录 → 查询”的 7 轮连续任务中进行对照测试：

<p align="center">
  <img src="docs/images/token-comparison.png" alt="7 轮任务 Token 对照" width="82%">
</p>

| 轮次 | 无 Graph Memory | 有 Graph Memory |
|---|---:|---:|
| R1 | 14,957 | 14,957 |
| R4 | 81,632 | 29,175 |
| R7 | **95,187** | **23,977** |

该场景第 7 轮减少约 **75%** Token。它是一个特定工作流的对照结果，不代表所有任务都有固定压缩比例；核心机制是用相关知识子图替代无差别历史回放。

## 项目发展

Graph Memory 的方向没有因为新宿主而推倒重来。项目正在从“OpenClaw 上的记忆插件”，发展为“可被不同 Agent Harness 原生加载的图记忆内核”。

| 阶段 | 交付内容 | 状态 |
|---|---|---|
| OpenClaw 起点 | Context Engine、跨会话图记忆、双路径召回 | 保持兼容 |
| Community 图引擎 | SQLite、FTS5、向量、图排序、溯源 | 可使用 |
| DeepSeek Harness | Cordis 适配器、原生工具、自动召回、Credentials | 已完成并实测 |
| Graph Memory Pro | 可视化图工作台、受控拖拽、Neo4j 可选适配器 | Pro Lite 只读 Host + Client 已实现；2D/3D 与拖拽待实现 |

2026 年 3 月 15 日，项目负责人在清华科技园举办的 CLAW 蜕壳计划活动中分享了 Graph Memory 的架构思路。以下为项目负责人提供的现场材料与[新浪财经活动报道](https://cj.sina.com.cn/articles/view/7984421895/1dbe89c0700101nnpq)。

<p align="center">
  <img src="docs/images/history/tsinghua-sharing.jpg" alt="Graph Memory 技术分享现场" width="47%">
  <img src="docs/images/history/sina-report.jpg" alt="新浪财经活动报道截图" width="28%">
</p>

- [开源版跨会话记忆演示](https://www.bilibili.com/video/BV1xUcZzfEaB/)
- [Graph Memory Pro 技术分享](https://www.bilibili.com/video/BV1KwwzzGEvD/)

下图是既有 OpenClaw / ClawX 阶段的 Pro 图谱原型，用于说明已经验证过的图交互方向；它不是当前 DSH 版本已经交付的前端。

<p align="center">
  <img src="docs/images/graph-ui.png" alt="Graph Memory Pro 既有图谱原型" width="92%">
</p>

相关名称与现场信息仅用于项目履历记录，不表示清华大学、新浪财经、DeepSeek 或 OpenClaw 对本项目提供官方背书。

## 图记忆架构

### 类型化知识图谱

```text
TASK   ──USED_SKILL──▶ SKILL
TASK   ──SOLVED_BY───▶ EVENT
SKILL  ──REQUIRES────▶ SKILL
EVENT  ──PATCHES─────▶ SKILL
SKILL  ──CONFLICTS_WITH──▶ SKILL
```

- **TASK**：做过什么，包含目标、过程和结果。
- **SKILL**：经过验证、可以复用的方法或能力。
- **EVENT**：错误、修复、决策、变化和关键事实。
- **Episodic provenance**：图节点关联原始 user / assistant 片段，保留形成知识时的语境。

### 双路径召回

```mermaid
flowchart LR
  Q[当前问题] --> EXACT[精确路径]
  Q --> GENERAL[泛化路径]
  EXACT --> SEARCH[向量 / FTS5]
  SEARCH --> EXPAND[社区扩展 + 图遍历]
  GENERAL --> SUMMARY[社区摘要匹配]
  SUMMARY --> MEMBERS[社区成员]
  EXPAND --> PPR[个性化 PageRank]
  MEMBERS --> PPR
  PPR --> CONTEXT[去重后的局部知识上下文]
```

同一张图会根据当前问题产生不同排名。查询 Docker 时，Docker 相关技能靠前；查询 Conda 时，环境管理相关技能靠前。对几千节点规模的图，图排序可以在本地完成。

### 宿主数据流

```mermaid
flowchart LR
  USER[用户消息] --> SESSION[宿主 Session Events]
  SESSION --> ADAPTER[Host Adapter]
  ADAPTER --> EXTRACT[结构化抽取]
  EXTRACT --> GRAPH[(SQLite / FTS5 / Vectors)]
  USER --> RECALL[语义 + 全文召回]
  GRAPH --> RECALL
  RECALL --> RANK[社区扩展 + PPR]
  RANK --> PROMPT[Prompt Assembly]
  PROMPT --> LOOP[Agent Loop]
  CREDS[Host Credentials] --> ADAPTER
  TOOLS[gm_* Tools] --> ADAPTER
```

```text
graph-memory/
├── dsh.ts                 # DeepSeek Harness / Cordis 适配器
├── index.ts               # OpenClaw 适配器
├── cordis.patch.yml       # DSH Bundle 安装入口
└── src/
    ├── extractor/         # 对话 → TASK / SKILL / EVENT
    ├── recaller/          # 向量、FTS5、社区扩展与召回
    ├── graph/             # PageRank、社区检测、去重
    ├── store/             # SQLite schema 与查询
    ├── format/            # 安全上下文组装
    └── engine/            # LLM / Embedding provider
```

## DeepSeek Harness 原生适配状态

| 能力 | 状态 | 说明 |
|---|---|---|
| Cordis 原生加载 | **已完成** | 使用插件生命周期，无需 fork DSH |
| 滚动上下文接管 | **已完成** | 最近 N 轮可配置，更早表面历史替换为 checkpoint |
| 跨会话自动召回 | **已完成** | 在 Prompt Assembly 阶段注入相关记忆 |
| 显式记录与搜索 | **已完成** | `gm_record`、`gm_search` |
| 向量回填与模型迁移 | **已完成** | 追踪模型、维度与 fingerprint |
| 插件状态可见 | **已完成** | 设置页 Plugin Inventory 显示 active |
| Pro 可视化工作台 | **实验版可用** | 独立 DSH Client Plugin，当前为只读卡片式快照 |

当前 beta：`1.6.0-beta.9`。本机验收宿主为 DeepSeek Harness `0.1.0-rc.8`。验收已覆盖无安装脚本的 Git 与 tarball 安装、Web profile 原生加载、通过 Agent 公共 compaction 服务执行的可配置最近 5 轮滚动压缩、精确原文溯源、token 预算、高精度自动召回、FTS5 降级，以及 Pro Lite Host、Typed Remote 和 Client bundle 边界；130 项自动化测试通过。真实模型验收还完成了滚动 checkpoint 替换、`text-embedding-v4` 1024 维向量写入，以及不调用记忆工具的跨项目自动召回。

<p align="center">
  <strong>插件已启用：graph-memory/dsh 在 DSH 插件列表中处于 active</strong><br>
  <img src="docs/images/dsh/plugin-inventory-active.png" alt="DSH 插件列表中的 Graph Memory" width="88%">
</p>

<p align="center">
  <strong>跨会话语义召回：新 Session 召回上一 Session 的知识</strong><br>
  <img src="docs/images/dsh/vector-cross-session-recall.png" alt="DSH 跨会话向量召回" width="88%">
</p>

## 安装到 DeepSeek Harness

前置条件：Node.js `22.13+`。当前 beta 尚未发布到 npm，但仓库已经包含预构建运行产物，可以直接安装且不需要授权安装脚本：

```bash
npx @deepseek-ai/dsh plugin --profile web add git+https://github.com/adoresever/graph-memory.git
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

也可以从 checkout 构建并安装 tarball：

```bash
git clone https://github.com/adoresever/graph-memory.git
cd graph-memory
npm install
npm test
npm pack
npx @deepseek-ai/dsh plugin --profile web add /absolute/path/to/graph-memory-1.6.0-beta.9.tgz
```

安装后，在 **设置 → 插件 → 插件列表 → graph-memory/dsh** 中确认状态为“已启用”。默认数据库路径：

```text
$DSH_HOME/graph-memory/graph-memory.db
# 未设置 DSH_HOME 时通常为：
~/.dsh/graph-memory/graph-memory.db
```

### 配置向量检索

不要把 API key 发送到聊天框。DSH 配置只保存凭据引用，真实密钥由 Credentials 服务解析。DashScope 示例：

```bash
export GRAPH_MEMORY_EMBEDDING_API_KEY='replace-with-your-key'
export GRAPH_MEMORY_EMBEDDING_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1'
export GRAPH_MEMORY_EMBEDDING_MODEL='text-embedding-v4'
export GRAPH_MEMORY_EMBEDDING_DIMENSIONS='1024'
dsh web
```

未配置 Embedding 时会自动使用 FTS5。

<p align="center">
  <img src="docs/images/dsh/vector-status.png" alt="Graph Memory 向量状态" width="78%">
</p>

### DSH 原生工具

| 工具 | 作用 |
|---|---|
| `gm_status` | 查看插件、数据库、抽取、召回和向量状态 |
| `gm_search` | 主动搜索长期知识图谱 |
| `gm_record` | 确定性记录 TASK、SKILL 或 EVENT |
| `gm_stats` | 查看节点、边、类型与社区统计 |

自动召回不要求模型主动调用 `gm_search`；适配器会在 Prompt Assembly 阶段检索并注入相关记忆。

## Graph Memory Pro：如何作为 DSH 插件集成

### 结论

**旧 `desktop-2.0` Pro 不能直接安装到 DSH，但新的 Pro Lite 已经作为独立 DSH 插件实现最小可用闭环。** 旧分支是 OpenClaw + Neo4j 实现，绑定 `openclaw/plugin-sdk`、OpenClaw Gateway Route 和旧 ClawX 交互方向。新实现位于 `dsh-pro/`：Host 读取 Community SQLite，Typed Remote 只提供受限快照，Client 在 DSH Web 侧边栏注册只读入口。Neo4j、GDS、APOC 和旧 CRUD 后端仍可在后续作为可选适配器迁移。

目标不是再做一个独立产品，而是把 Pro 作为 Graph Memory 的可选增强插件：

```mermaid
flowchart LR
  CORE[Graph Memory Core] --> STORE[GraphStore]
  STORE --> SQLITE[SQLite 默认]
  STORE --> NEO[Neo4j 可选]
  CORE --> HOST[DSH Host Plugin]
  HOST --> API[Typed Remote API]
  API --> CLIENT[DSH Client Plugin]
  CLIENT --> WORKBENCH[对话 / 图谱分屏]
  WORKBENCH --> DRAG[受控拖拽到上下文]
```

### 推荐包结构

```text
graph-memory                         # Community：当前原生 Host Plugin
graph-memory-pro-dsh                # Pro Lite：Host + Client Plugin（本地 beta）
@adoresever/graph-memory-store-neo4j # 可选大图存储适配器（待实现）
```

第一版优先做 **Pro Lite**：继续读取现有 SQLite 图数据，只增加 DSH 图谱工作台。这样用户不需要安装 Neo4j。Neo4j 作为可选适配器，面向更大图谱、GDS 与复杂分析。**这是规划中的目标架构；现有 `desktop-2.0` Pro 仍是 Neo4j-only，尚未实现 SQLite / Neo4j 可切换的 `GraphStore`。**

### 当前本地安装方式

当前 npm 上的 `graph-memory@1.5.8` 仍是 OpenClaw 包，新的 Community beta 与 `graph-memory-pro-dsh` 尚未发布到 npm。Community 可以直接从 GitHub 安装，Pro Lite 仍从 checkout 安装：

```bash
dsh plugin --profile web add \
  git+https://github.com/adoresever/graph-memory.git

dsh plugin --profile web add \
  /absolute/path/to/graph-memory/dsh-pro

dsh web
```

两个插件默认共用 `~/.dsh/graph-memory/graph-memory.db`。当前入口提供受限 SQLite `GraphSnapshot`、`gm_graph_snapshot`、`gm_graph_node`、Typed Remote，以及侧边栏只读快照/搜索界面；尚无 2D/3D renderer、完整分屏、拖拽写入和节点编辑。

### 必须改造的四层

1. **Core contract**：SQLite `GraphSnapshot` 与受限节点详情已经落地；Neo4j provider 和统一可写契约待实现。
2. **Host Plugin**：Pro Lite Host、两个受限工具和只读 Typed Remote 已落地；可写动作与更细权限策略待实现。
3. **Client Plugin**：DSH 侧栏入口、卡片式快照、搜索与刷新已落地；2D/3D 图谱和对话分屏待实现。
4. **受控上下文操作**：拖拽只提交节点 ID 与动作意图；Host 校验后把内容写入可见、可撤销的 Session Context。

旧 Pro 的 `/graph-memory-pro/neo4j-config` 会把连接信息返回浏览器，这是已经在新实现中消除的安全问题。当前 Pro Lite 的浏览器只获取经过严格校验和裁剪的 `GraphSnapshot`，不会接收数据库路径、Session ID、Bolt 密码、SQL 或任意 Cypher。后续可写动作也必须保持这条 Host 权限边界。

## OpenClaw 兼容

OpenClaw 用户继续使用原入口：

```bash
openclaw plugins install graph-memory
openclaw plugins enable graph-memory
openclaw gateway restart
```

还必须在 `~/.openclaw/openclaw.json` 激活 Context Engine，否则插件可能显示已安装，但不会进入完整的消息摄取与抽取管线：

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "graph-memory"
    },
    "entries": {
      "graph-memory": {
        "enabled": true
      }
    }
  }
}
```

现有 Context Engine 配置和数据能力继续保留。DSH 是新增的原生宿主入口，不要求 OpenClaw 用户迁移或放弃现有工作流。

## 开发与验证

```bash
npm install
npm test
npm run build
npm pack
```

发布前必须确认：测试与 TypeScript 构建通过；tarball 包含 `dist/dsh.js` 与 `cordis.patch.yml`；仓库不存在 API key、本地数据库和环境文件；文档不把 Pro 路线图写成已完成功能。

## 当前限制

- 自动抽取依赖辅助模型输出稳定性；关键知识在 beta 阶段建议使用 `gm_record`。
- DSH 版暂未提供 `gm_update` 和 `gm_maintain`，这两个工具目前属于 OpenClaw 入口。
- Pro Lite 目前只有只读卡片式 Client；2D/3D、分屏和受控拖拽尚未实现。
- npm registry 发布尚未完成，当前使用 GitHub 源码 tarball 安装。

## 隐私与安全

- 数据默认保存在本机 SQLite。
- API key 通过宿主凭据或环境变量注入，不写入数据库和 Cordis patch。
- 召回历史只作为参考；当前用户指令始终拥有更高优先级。
- 曾出现在聊天、日志或截图中的密钥应立即轮换。

## 许可证

[MIT](LICENSE) © 2026 adoresever

素材来源、Logo 与商标说明见 [docs/ATTRIBUTIONS.md](docs/ATTRIBUTIONS.md)。
