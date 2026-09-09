# 轮次记忆导航升级与移植指南

本文记录 Graph Memory `1.6.0-beta.15` 的“轮次摘要 + SPO 导航 + 精确问答事实源”升级。目标是让另一个基于旧版 Graph Memory 的项目能够按明确边界移植，而不是复制一批相互依赖、来源不明的补丁。

## 一句话定义

每个已完成对话轮只做一次结构化抽取：把“用户问题 + 最终可见回答”压成一句自包含摘要、一个结果状态和零条或多条 SPO；摘要与图只负责导航，召回最终返回的是原始问题与最终回答。

## 设计边界

这套系统只有两层记忆：

| 层 | 保存什么 | 用来做什么 | 能否作为最终证据 |
|---|---|---|---|
| 导航层 | 一句摘要、结果状态、SPO、摘要向量、社区标签 | 快速定位相关轮次 | 否，只是索引 |
| 事实层 | 原始用户问题、最终可见回答及来源关系 | 给模型恢复真实上下文 | 是 |

“最近 N 轮”是宿主的工作上下文窗口，不是第三层记忆。DSH 的不可变事件日志仍完整保存；Graph Memory 只替换模型下一次请求看到的历史表面。

以下内容不会进入轮次记忆：

- 模型 reasoning / thinking；
- 中间 assistant 草稿；
- tool call 参数和 tool result；
- UI 预览截断文本；
- 插件自己生成的召回快照。

这些事件可以继续留在宿主的不可变日志中，用于审计，但不应重复交给抽取模型或后续主模型。

## 完整数据流

```text
DSH turn/end
  │
  ├─ 从不可变事件日志选出：首个真实 user + 最后一个可见 assistant
  │
  ├─ 后台串行队列：每个完整轮次调用一次抽取模型
  │      └─ submit_result({ summary, outcome, triples })
  │
  ├─ 运行时 Schema 校验
  │      ├─ 合法：原子写入轮次摘要、来源关系和 SPO
  │      └─ 非法：隔离本轮；不猜、不补、不污染图谱
  │
  ├─ 异步写入摘要向量
  └─ 本地 LPA 更新导航社区（零 LLM 调用）

下一轮 user query
  │
  ├─ 摘要向量 Top-K；不可用时使用严格词法回退
  ├─ 查询词项 / 摘要命中结果 → 导航种子
  ├─ 社区缩小候选集 → 查询时 Personalized PageRank
  ├─ Reciprocal-rank 融合摘要路线和图路线
  └─ 命中 turn memory → 回溯并注入精确原始 Q/A
```

## 一、抽取合同：一次调用同时得到摘要和导航

### 1. Provider-facing Schema

代码位置：[`src/extractor/contract.ts`](../src/extractor/contract.ts)

提供给模型的结构必须保持扁平，并且三个顶层字段全部必填：

```ts
const schema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  outcome: Type.String({
    enum: ["completed", "partial", "failed", "informational", "unknown"],
  }),
  triples: Type.Array(Type.Object({
    subject: Type.String({ minLength: 1 }),
    predicate: Type.String({ minLength: 1 }),
    object: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
```

不要把模型输出设计成“摘要调用一次、三元组再调用一次”。SPO 必须只从同一次调用生成的摘要拆分，否则成本翻倍，两个结果还可能互相矛盾。

### 2. 提示词原则

代码位置：[`src/extractor/extract.ts`](../src/extractor/extract.ts)

- `Current Turn` 是唯一事实来源；
- `Previous Turn Summaries` 只帮助理解“继续这个”“按刚才的方案”等指代；
- 摘要写清对象、结论和最终回答明确报告的状态；
- SPO 只来自该摘要；没有明确关系时 `triples: []` 合法；
- 不限制节点数、边数或文字长度，不用程序判断关系方向是否“合理”；
- 模型必须调用一次 `submit_result`，运行时只接受工具参数。

### 3. 结构化输出适配

代码位置：[`src/engine/llm.ts`](../src/engine/llm.ts) 和 [`dsh.ts`](../dsh.ts)

OpenAI-compatible 路线使用 `tools` + 强制 `tool_choice`；Anthropic 路线使用 `tool_use`；DSH 路线通过 `ctx.llm.stream` 注册同一个 ToolSchema。三条路线最终都只返回工具参数字符串，再交给同一解析器。

解析器只做两件事：

1. `JSON.parse`；
2. TypeBox `Value.Check` 验证字段合同。

不要增加 JSON repair、默认字段、语义门禁、自动造边或模型二次修正。坏数据不能伪装成成功数据。

## 二、事实入库：摘要可替换，来源不可丢

### 1. 数据表

代码位置：[`src/store/db.ts`](../src/store/db.ts) 的 `m15_turn_memories` 与 `m16_navigation_triples`。

| 表 | 关键内容 |
|---|---|
| `gm_turn_memories` | 每轮摘要、outcome、session、时间 |
| `gm_turn_memory_sources` | 轮次记忆到原始 `gm_messages` 的有序来源关系 |
| `gm_turn_vectors` | 摘要 embedding 和内容哈希 |
| `gm_navigation_terms` | 规范化后的 subject/object、展示文本、社区 ID |
| `gm_navigation_triples` | memory → subject — predicate → object |

数据库迁移必须追加在现有 `steps` 数组末尾；不要改写已发布 migration 的编号或内容。旧数据库打开时会按 `_migrations` 自动增量升级。

### 2. 稳定身份和去重

代码位置：[`src/store/store.ts`](../src/store/store.ts)

- turn memory ID 由 `sessionId + 排序后的 source message IDs` 做 SHA-256，重放同一轮不会复制记忆；
- term ID 由规范化词项做 SHA-256，相同实体跨轮次复用同一导航节点；
- triple ID 由 `memoryId + subjectId + predicate + objectId` 生成；
- `replaceNavigationTriples()` 在一个 SQLite 事务中替换某轮全部 SPO；失败则整体回滚；
- 只做空白规范化，不重写模型的 subject、predicate、object 语义。

### 3. 原始证据关系

每个 turn memory 必须同时链接用户问题和最终回答。不能只保存摘要，也不能把工具日志链接为事实源。召回时由 `getTurnMemorySourceMessages()` 按 `source_order` 恢复原始 Q/A。

## 三、本地图算法：社区用于缩小范围，PPR 用于当前问题

### 1. Label Propagation

代码位置：[`src/graph/community.ts`](../src/graph/community.ts)

导航图把 subject/object 视作节点、SPO 视作无向关联，在后台抽取成功后运行确定性的 Label Propagation：

- 不调用模型；
- 不要求预设社区数量；
- 默认最多迭代节点数次；
- 相同票数按标签字典序决定，保证相同数据得到相同结果；
- 社区只作为查询候选范围，绝不把整个社区内容全部注入上下文。

### 2. Personalized PageRank

代码位置：[`src/graph/pagerank.ts`](../src/graph/pagerank.ts)

查询时先找具体词项种子，再在其社区中执行 PPR。图结构按具体 SQLite connection 存在 `WeakMap` 中；SPO 事务成功后显式 `invalidateGraphCache(db)`。不要使用全进程单例加固定秒数 TTL，否则多个 profile 可能读到彼此的图，刚写入的数据也可能暂时不可见。

重复出现的真实 SPO 会形成重复邻接贡献，代表多轮证据强度；插件不另造一个不可解释的“模型置信度”。

## 四、召回：两条路线汇合到原始问答

代码位置：[`src/recaller/recall.ts`](../src/recaller/recall.ts) 与 [`src/store/store.ts`](../src/store/store.ts)

召回分为两条独立路线：

1. **摘要路线**：query embedding 与 `gm_turn_vectors` 做 cosine Top-K；没有 embedding 时使用完整短语词法回退。
2. **图路线**：查询直接包含的具体词项优先成为种子；没有字面种子时，才使用摘要命中轮次的 SPO 端点；社区给出候选词项，PPR 排序后映射回 turn memory。

两条路线的原始分数不可直接相加，因为 cosine 与 PageRank 不在同一量纲。当前使用 reciprocal-rank fusion：同一轮同时被两条路线支持时自然上升，摘要直接命中在平分时优先。

选中一个 memory 后：

- 导航图只发送最能解释本次路线的 SPO；
- 摘要作为检索说明；
- 原始用户问题和最终回答作为最终证据；
- 当前最近窗口中已经完整可见的 source message 不重复注入。

## 五、DSH 上下文接管：只改模型表面，不改宿主源码

代码位置：[`src/format/dsh-turn-projection.ts`](../src/format/dsh-turn-projection.ts)、[`src/format/dsh-compaction.ts`](../src/format/dsh-compaction.ts)、[`src/format/dsh-recall.ts`](../src/format/dsh-recall.ts) 和 [`dsh.ts`](../dsh.ts)。

### 1. 完成轮次投影

收到 `turn/end` 后，从 DSH 的 `snapshotEvents()` 读取本轮：

- 第一个 `source.kind === "user"` 的 `user/message`；
- 最后一个含可见 text block 的 `assistant/message`。

两端之间的 reasoning、assistant 中间步骤和 tool 事件通过 DSH 公共 `surfaceOp` 替换为常量标记，但原始事件仍保留在不可变日志中。

### 2. 滚动历史窗口

在 concrete Agent scope 的 `agent/pre-step` 前置监听器中：

- 默认保留最近 `freshTurnCount = 5` 个已完成用户轮次；
- system head 永不进入替换范围，以保持宿主不变量和稳定前缀缓存；
- 旧历史表面替换为一个固定归档标记；旧标记会在下一次替换时一同折叠，不会线性累积；
- DSH 的字段名必须是 `surfaceOp: { op: "replace", startSeq, endSeq }`，不是 `start/end`；
- 使用 `tokenMeter.measure()` 记录 shadow price，不自行按字符估 Token；
- 整个替换不调用 LLM。

### 3. 自动召回插入顺序

只在 `step === 1`、有真实用户 query 时召回。历史快照必须插在当前用户消息之前，避免历史文本成为比当前请求更“新”的指令；同时明确标注 recalled memory 是不可信历史参考，当前用户指令始终优先。

适配其他宿主前必须确认它同时提供：

1. 不可变事件/消息事实源；
2. 可单独修改的 model-visible surface；
3. 在模型请求前插入 recall 的生命周期钩子；
4. 不修改宿主核心代码即可调用的 replace/shadow API。

缺少其中任何一项时，可以移植记忆与召回，但不能声称安全接管上下文。

## 六、并发与失败语义

代码位置：[`dsh.ts`](../dsh.ts) 的 `extractChain`、`scheduleExtract()`、`drainTurn()`。

- 每个 session 只有一条串行 Promise chain，防止同一会话乱序写入；
- 不存在两个抽取 worker 同时消费同一轮；
- 每个 live `turn/end` 只调度该轮，不在每轮重新扫描全部历史；
- shutdown 中止留下 pending，下一次显式恢复路径可继续处理；
- 结构合同失败只隔离该轮，并记录不含私人模型输出的错误；
- 抽取、embedding、社区维护失败都不能阻塞或拒绝前台 Agent 对话。

## 七、移植顺序

如果另一个项目与本仓库有共同 Git 历史，优先在独立分支上移植本次发布 tag；发生冲突时仍按下面顺序人工核对，不要只解决到“可以编译”。

1. **备份数据库和配置**：复制 SQLite 主文件及 WAL/SHM；记录旧 migration 最大版本。
2. **移植类型与 migration**：`src/types.ts`、`src/store/db.ts`。
3. **移植存储原语**：turn memory、source、vector、navigation term/triple 的 store 函数。
4. **移植统一抽取合同**：`contract.ts`、`extract.ts`、各 provider 的强制 tool call。
5. **接入宿主完成轮次投影**：保证输入严格等于 user question + final visible answer。
6. **接入异步写入链**：先写 summary/source/SPO 事务，再失效缓存、更新社区、异步 embedding。
7. **移植摘要与图双路召回**：向量/词法、种子、社区、PPR、rank fusion。
8. **移植上下文组装**：摘要和 SPO 是导航，精确 Q/A 是证据；排除最近窗口已可见来源。
9. **最后接入宿主 surface takeover**：先验证字段合同，再启用最近 N 轮替换和工具轨迹投影。
10. **构建并提交生成物**：仓库发布 DSH 时必须包含已构建 `dist/dsh.js`，用户安装阶段不得执行 build/prepare。

## 八、必须通过的验证

### 数据合同

- 三个顶层字段缺一则失败；
- outcome 不在枚举则失败；
- triple 缺 subject/predicate/object 则失败；
- `triples: []` 成功；
- 多余字段失败；
- 非工具正文不能当作结构化结果。

### 轮次采集

- 一轮多次工具调用只保存一个用户问题和最后可见回答；
- reasoning/tool block 不进入抽取输入；
- 插件 recall 快照不被当成新用户事实；
- 同一 turn 重放不产生重复 memory。

### 导航与召回

- 摘要近义查询可通过向量命中；
- 具体实体/属性可通过导航词项 + PPR 命中；
- 相同词项跨轮次去重；
- 社区缩小候选集但不整包注入；
- 命中 memory 后返回原始 Q/A；
- 当前最近窗口中的 Q/A 不重复发送；
- 无关问题不因为 Top-K 永远有“最近邻”而污染上下文。

### DSH 接管

- system head 保留；
- `startSeq/endSeq` 的 replace 确实改变 surface；
- 最近 N 个已完成 Q/A 仍完整可见；
- 完成轮次的中间工具轨迹不再重复发送；
- 第 N+1 个旧轮次可通过自动 recall 恢复；
- 原始事件日志数量和内容未被删除；
- 插件失败时前台对话继续。

### 发布包

```bash
npm test -- --run
npm run build
npm run build:dsh
npm run verify:package
npm pack --dry-run
```

还应在一个全新 DSH profile 中完成：npm 安装、`--dump-config`、启动、两轮对话、状态检查、跨 session 召回。

## 九、不要移植的旧做法

- 把 TASK/SKILL/EVENT 当作唯一记忆事实体；
- 把完整 reasoning/tool trace 交给抽取模型；
- 摘要和图谱分两次 LLM 调用；
- 固定字符截断、固定“最多节点/边”或自算 Token 预算；
- 依据节点类型或关系方向做程序语义门禁；
- 自动 JSON repair 或失败后循环调用模型；
- 因为当前 session 就过滤掉全部同会话旧记忆；
- 命中一个社区后把整个社区全部塞入提示词；
- 用全进程图缓存让不同数据库/profile 共用状态；
- 修改 DSH 源码或删除 DSH 不可变事件来实现压缩。

## 十、移植完成的判定

只有同时满足以下条件，另一个项目才算完成升级：

- 每个完整轮次最多一次抽取 LLM 调用；
- 入库内容是摘要/outcome/SPO，且每条 memory 可追溯到完整原始 Q/A；
- 社区与 PPR 全部本地运行；
- 最近 N 轮窗口真实限制模型可见历史；
- 窗口外同会话记忆与跨会话记忆都能自动召回；
- 召回返回精确来源，而不是只返回摘要或图节点；
- 不摄入 reasoning/tool trace；
- 不修改宿主核心；
- 单元测试、构建、包验证和真实宿主运行全部通过。

