# graph-memory v1.x (SQLite) → graph-memory-pro v2.0 (Neo4j) 迁移指南

将旧版 graph-memory（SQLite + FTS5）的知识图谱迁移到 graph-memory-pro v2.0（Neo4j 5 + APOC + GDS）。

## 迁移内容

| SQLite 表 | → Neo4j | 说明 |
|-----------|---------|------|
| `gm_nodes` | `(:MemoryNode:Task\|Skill\|Event)` | 知识节点（TASK/SKILL/EVENT），含 pagerank、communityId、sourceSessions |
| `gm_edges` | 类型化关系（APOC） | USED_SKILL / SOLVED_BY / REQUIRES / PATCHES / CONFLICTS_WITH |
| `gm_communities` | `(:Community)` | 社区摘要 + embedding |
| `gm_vectors` | `n.embedding` 属性 | Float32 BLOB → float[]，接入 `gm_node_embedding` 向量索引 |
| `gm_messages` | `(:GmMessage)` | **默认跳过**（25k 条原始对话，知识已提取）；可选 `--messages` 迁移 |

FTS5 表、`gm_signals`（空）、`_migrations` 不迁移。

## 前置条件

- **Java 17+**（Neo4j 必需，唯一需要 sudo 的步骤）：
  ```bash
  sudo apt update && sudo apt install -y openjdk-17-jre-headless
  ```
- v2.0 源码（本仓库）
- WSL Ubuntu 内能访问旧 DB：`~/.openclaw/graph-memory.db`

---

## 快速路径（一键）

```bash
cd /mnt/d/TEMP/graph-memory   # 或 v2.0 源码所在路径
bash migrate/install-wsl.sh
```

runbook 自动完成：备份 → 安装 Neo4j（tmux console 模式）→ 注册插件 → 复制配置 → 禁用旧插件 → 迁移。跑完只需重启 gateway。

环境变量：
- `NEO4J_PASS=xxx` — Neo4j 密码（默认 `graphmemory`）
- `SKIP_MIGRATE=1` — 只装不迁移

---

## 手动步骤（逐项）

### 1. 备份 SQLite（在线一致性快照，WAL 合并）

```bash
python3 migrate/backup.py
# → ~/graph-memory.db.bak-YYYYMMDD-HHMMSS（含全部表校验）
```

### 2. 安装 Neo4j + 注册插件

用官方 setup 脚本（非交互）。Neo4j 制品可预先下载放到 `~/.graph-memory-pro/staging/` 绕过代理（见下方排障）：

```bash
bash setup-graph-memory-pro.sh --non-interactive --neo4j-password graphmemory --no-restart
```

**关键**：WSL 里 `neo4j start` 的 daemon 会在会话退出时被立即 shutdown。必须用 **tmux console 模式**保活：

```bash
tmux new-session -d -s neo4j \
  '~/.graph-memory-pro/neo4j/bin/neo4j console > /tmp/neo4j.log 2>&1'
# 等 Bolt 就绪
~/.graph-memory-pro/neo4j/bin/cypher-shell -u neo4j -p graphmemory "RETURN 1"
```

### 3. 配置 openclaw.json

复制旧插件的 llm/embedding 配置到新插件 + 禁用旧插件：

```bash
python3 migrate/patch_config.py                    # 复制 llm/embedding
# 禁用旧插件（手动或一行 jq）
python3 -c "import json,os; p=os.path.expanduser('~/.openclaw/openclaw.json'); c=json.load(open(p)); c['plugins']['entries']['graph-memory']['enabled']=False; json.dump(c,open(p,'w'),indent=2,ensure_ascii=False)"
```

确认 `contextEngine` slot 指向 `graph-memory-pro`，`openclaw.plugin.json` 声明了 `contracts.tools`（否则新版 OpenClaw 拒绝注册工具）。

### 4. 迁移

```bash
cd ~/graph-memory-pro
# uv 避开 PEP 668 externally-managed-environment
curl -LsSf https://astral.sh/uv/install.sh | sh   # 首次
~/.local/bin/uv venv && ~/.local/bin/uv pip install neo4j
.venv/bin/python migrate/migrate.py ~/graph-memory.db.bak-YYYYMMDD-HHMMSS \
  bolt://localhost:7687 neo4j graphmemory --reset
```

`--reset` 清空 Neo4j 旧数据后干净导入（首次迁移用）。重跑迁移**务必带 `--reset`**（边用 APOC create，不带会叠加）。

### 5. 重启 gateway

```bash
~/.npm-global/bin/openclaw gateway restart
~/.npm-global/bin/openclaw gateway --verbose 2>&1 | grep graph-memory-pro
# 应见 [graph-memory-pro] ready | neo4j=bolt://localhost:7687
```

---

## 可选：提取未提取消息

旧 DB 可能有大量 `extracted=0` 的消息（知识尚未提取成节点）。可选地先用旧版提取器补提取，再迁移：

```bash
cd ~/.openclaw/extensions/graph-memory   # 旧插件目录（有 node_modules）
cp /mnt/d/TEMP/graph-memory/migrate/extract_unextracted.ts .
npx tsx extract_unextracted.ts
```

脚本用 deepseek 并发提取（BATCH=6 消息/call，20 路并发），结果写回 SQLite 备份，之后正常迁移即可带上新节点。

- 自动跳过退化的 `memory-reflection-cli*` 会话（"continue" 死循环噪声）
- 幂等：每批 `markExtracted`，崩溃可重跑续
- 提取完重跑第 4 步迁移（带 `--reset`）

---

## 排障

### `下载失败: dist.neo4j.org/...`

WSL 走代理时大文件下载中断。解法：Windows 浏览器下载制品，放到 `migrate/staging/`，runbook 的 `dl()` 会优先用本地暂存：

```
migrate/staging/neo4j.tar.gz                         (128MB, neo4j-community-5.24.2-unix.tar.gz)
migrate/staging/apoc-5.24.2-core.jar
migrate/staging/neo4j-graph-data-science-2.12.0.jar  (可选；GitHub 下不到就 --skip-gds)
```

### `Neo4j Server shutdown initiated by request`（启动即停）

WSL 会话退出杀 daemon。解法：用 tmux console 模式（见第 2 步），不要用 `neo4j start`。WSL 重启后需重开 tmux 会话。

### `externally-managed-environment` (PEP 668)

系统 Python 禁止 pip 装包。解法：用 `uv`（`curl -LsSf https://astral.sh/uv/install.sh | sh`）建 venv，不用 pip。

### `plugin must declare contracts.tools before registering agent tools`

新版 OpenClaw 要求 `openclaw.plugin.json` 声明 `contracts.tools`（工具名字符串数组，精确匹配）。已在 v2.0 源码修好；若自行改了工具名记得同步更新清单。

### 边数量翻倍（236 而非 118）

迁移不带 `--reset` 重跑导致（边用 APOC create 叠加）。解法：带 `--reset` 重跑。

---

## 文件说明

```
migrate/
├── Migrate.md              本文档
├── backup.py               SQLite 在线备份（WAL 合并，一致性快照）
├── migrate.py              核心转换脚本（SQLite → Neo4j）
├── extract_unextracted.ts  可选：批量提取未提取消息（旧插件 deepseek 并发）
├── patch_config.py         迁移后：复制 llm/embedding 配置到新插件
└── install-wsl.sh          WSL 一键安装 + 迁移 runbook
```

## migrate.py 用法

```
python3 migrate.py <snapshot.db> <neo4j-uri> <user> <password> [--messages] [--reset]
```

| 参数 | 作用 |
|------|------|
| `--reset` | 导入前清空 Neo4j 图谱数据（首次迁移 + 重跑必带） |
| `--messages` | 同时迁移 gm_messages（25k 条 GmMessage，默认跳过） |

幂等性：节点/社区用 MERGE（可重复）；**边用 APOC create（不幂等，重跑带 `--reset`）**。
