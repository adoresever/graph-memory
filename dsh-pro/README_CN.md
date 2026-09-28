# graph-memory-pro-dsh

Graph Memory Pro 的 DeepSeek Harness Web 插件包。它不是独立桌面产品：Host 读取 Community 插件的 SQLite，Client 通过 Typert Remote 获取受限的 `GraphSnapshot`，并在 DSH 侧边栏注册一个只读图谱入口。

## 当前能力

- 侧边栏显示 `Graph Memory` 入口。
- 弹出只读快照视图，支持关键词搜索和刷新。
- 展示节点总数、关系总数以及 TASK / SKILL / EVENT 卡片。
- Remote 对请求与响应执行严格 JSON 校验。
- 浏览器不获得数据库路径、连接、SQL、Cypher、凭据或会话标识。

当前版本不包含 3D、拖拽写入和节点编辑。这些交互需要独立的权限、确认、Session 事件与撤销设计。

## 本地安装

先安装并激活 Community 插件：

```bash
dsh plugin --profile web add git+https://github.com/adoresever/graph-memory.git
```

再安装 Pro bundle：

```bash
dsh plugin --profile web add /absolute/path/to/graph-memory/dsh-pro
dsh web
```

两个插件默认共用 `~/.dsh/graph-memory/graph-memory.db`。
