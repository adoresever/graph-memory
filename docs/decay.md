# Memory Decay — 柔性评分模型

graph-memory-pro 的衰减机制采用**三因子加权评分 + tier 双向转换**，参考 [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) 的设计并映射到本仓库的图模型信号。

- **decay 评分只调整 `tier`**（`core` / `working` / `peripheral`）；tier 转换本身不改变 `status`。`status=deprecated` 有且仅有三个来源：手动弃用（`gm_update mode=deprecate` / REST DELETE / finalize invalidations，统一走断联+标记，见 §3.5）、merge 败者，以及遗忘曲线自动弃用（`autoDeprecate`，阶段一，见 §3.5）。
- 每次 `gm_maintain` 或 `session_end` 维护的第 0 步执行：扫描所有 active 节点 → 评分 → tier 转换 → 写回 `decayScore` / `tier` / `decayComputedAt`（→ 自动弃用判定 → 过期硬删，见 §3.5）。
- 评分结果可通过 `gm_stats` / CRUD API 查看；外层搜索目前**不读 decayScore 排序**（已由 PageRank + tier 隐含分层）。

---

## 1. 评分公式

```
composite = wR · recency + wF · frequency + wI · intrinsic
```

三个权重默认 `0.4 / 0.3 / 0.3`，**推荐**和为 1。运行时若和≠1 会自动按比例归一化（`wR' = wR / (wR+wF+wI)`），保证 `composite ∈ [0,1]`，避免用户覆盖单个权重导致评分越界。归一化在 `scoreNode()` 内进行，原始 `cfg.*Weight` 值不被修改。

### 1.1 Recency（时间衰减，权重 0.4）

Weibull 拉伸指数：

```
recency = exp( −λ · daysSinceLastAccess^β )

λ = ln(2) / effectiveHL
effectiveHL = recencyHalfLifeDays · exp( importanceModulation · importance )
```

- **半衰期调制**：重要记忆（高 `importance`）的 `effectiveHL` 更大 → 衰减更慢。对应艾宾浩斯曲线"重要事件保留更久"。
- **tier-β**：曲线形状随 tier 变化，反馈式调整衰减速度：

  | tier | β | 效果 |
  |---|---|---|
  | `core` | 0.8 | 尾部衰减缓（核心知识保得久） |
  | `working` | 1.0 | 标准指数衰减 |
  | `peripheral` | 1.3 | 加速衰减（边缘知识更快被遗忘） |

### 1.2 Frequency（访问频率，权重 0.3）

```
frequency = base · ( 0.5 + 0.5 · recentnessBonus )

base = 1 − exp( −validatedCount / 5 )
recentnessBonus = exp( −avgAccessGapDays / 30 )   # 仅当 validatedCount > 1
avgAccessGapDays = ( lastAccessedAt − createdAt ) / ( validatedCount − 1 )
```

- 用 `validatedCount`（LLM 重新提取的次数）替代 lancedb-pro 的 `accessCount`（manual recall 触发的次数）。前者是更强的"重新确认"信号。
- `validatedCount ≤ 1` 时跳过 `recentnessBonus`，只返回 `base`（无法算平均间隔）。

### 1.3 Intrinsic（内在价值，权重 0.3）

```
intrinsic = importance · confidence

importance = pagerank / maxPagerank       # 每次扫描时按当前批次归一化到 [0,1]
confidence = 1 − 1 / ( 1 + validatedCount )  # 饱和函数，收敛到 1
```

---

## 2. 字段映射（lancedb-pro → graph-memory-pro）

| lancedb-pro 字段 | 本仓库替代 | 说明 |
|---|---|---|
| `accessCount` | `validatedCount` | LLM 重新提取次数（强信号，原为 manual recall 触发） |
| `lastAccessedAt` | `lastAccessedAt` | 由 `upsertNode` 在任意写入路径刷新（重新提取、`gm_record`、`gm_update`、CRUD POST）。`mergeNodes` 故意不刷新（合并 ≠ 用户重新激活） |
| `importance` | `pagerank / maxPagerank` | 图结构重要性，每次扫描归一化 |
| `confidence` | `1 − 1/(1+validatedCount)` | 饱和置信度 |
| `tier` | `tier`（新增字段） | 与 `status` 正交 |

---

## 3. Tier 双向转换

| 转换 | 条件 |
|---|---|
| **core → working** | `composite < peripheralCompositeThreshold` **AND** `count < workingAccessThreshold` |
| **working → peripheral** | `composite < peripheralCompositeThreshold` **OR**（`ageDays > peripheralAgeDays` **AND** `count < workingAccessThreshold`） |
| **peripheral → working** | `count >= workingAccessThreshold` **AND** `composite >= workingCompositeThreshold` |
| **working → core** | `count >= coreAccessThreshold` **AND** `composite >= coreCompositeThreshold` **AND** `importance >= coreImportanceThreshold` |

- 新节点默认 `tier = "working"`。
- tier 转换本身只写 `tier` / `updatedAt`，不改 `status`、不影响搜索过滤；被降至 `peripheral` 的节点仍可被搜索到（直到满足 §3.5 的自动弃用条件）。
- 不存在的"core→peripheral"和"peripheral→core"由两次相邻转换实现（经过 working）。

### 3.5 节点生命周期：自动弃用与到期硬删（两阶段）

tier 转换之上，`applyDecay` 还承担两阶段生命周期的**阶段一**；**阶段二**（硬删）由 `runMaintenance` 在 decay 步之后执行。

```
active ──遗忘曲线──▶ peripheral（仍可搜索）
                        │  tier=peripheral + composite < peripheralCompositeThreshold
                        │  + 距 lastAccessedAt ≥ autoDeprecateAfterDays（阶段一）
                        ▼
      自动弃用：切断所有边 + status='deprecated'（deprecatedBy='decay'，
      描述加 [DEPRECATED] 前缀）—— 全路径不可召回
                        │
        ┌───────────────┴────────────────┐
        ▼ 重新提取/编辑命中（复活）        ▼ deprecatedAt + purgeAfterDays（阶段二）
   恢复 active、剥前缀              DETACH DELETE 硬删（向量随节点移除，
   清 deprecatedAt/By               释放存储；适用于所有 deprecated 节点）
```

要点：

- **阶段一判定**（`shouldAutoDeprecate`，三条件同时满足）：`tier=peripheral`（本轮 tier 转换后的层级，刚降到 peripheral 的老节点即刻参与）**AND** `composite < peripheralCompositeThreshold`（高 intrinsic 价值节点受保护）**AND** 距最近访问（`lastAccessedAt` → `updatedAt` → `createdAt` 回退链）≥ `autoDeprecateAfterDays`。`autoDeprecate: false` 或 `enabled: false` 时整体停用。
- **手动弃用 = 一次性断联**：所有人工路径（`gm_update mode=deprecate`、finalize invalidations、REST `DELETE /nodes/:id`）统一走 `deprecateNodeAndDisconnectById`——切断所有边 + `[DEPRECATED]` 前缀 + `deprecatedBy='manual'`。由于所有召回路径都过滤 `status='active'` 且边已切断，手动弃用等效删除（不存在独立的 `gm_update mode=delete`，也没有 status-only 的轻量弃用路径）。
- **复活**：`deprecatedBy='decay'` 的节点被同名知识重新提取（`upsertNode`）或手动编辑（`updateNode`）命中时，自动恢复 `active`、剥离 `[DEPRECATED]` 前缀、清除 `deprecatedAt`/`deprecatedBy`。手动弃用（`deprecatedBy='manual'`）与 merge 败者（`deprecatedBy='merge'`）**不复活**——人工/合并语义判定优先于遗忘曲线。
- **阶段二硬删**：所有 `deprecated` 节点（含 manual/merge/存量数据），自 `deprecatedAt` 起超过 `purgeAfterDays` 天后 `DETACH DELETE`（`coalesce(n.deprecatedAt, n.updatedAt)` 中的 updatedAt 回退仅是防御性兜底）。`embedding`/`contentHash` 向量属性随节点一并移除，向量索引项同步消失。`purgeAfterDays: 0` 表示永不硬删。此步不受 `enabled` 总开关约束（手动弃用的节点也需要到期清理）。
- **存量兼容**：升级前已 deprecated 的节点没有 `deprecatedBy`，一律按 `manual` 处理（不参与复活）。启动时（`initSchema`）幂等补写：为缺 `deprecatedAt` 的 deprecated 节点一次性钉死 `deprecatedAt = coalesce(updatedAt, createdAt)` 快照——否则 manual/merge 弃用节点被重新提取命中时 `upsertNode` 会 bump `updatedAt`（不复活但刷新时间戳），purge 期限被无限推后（永远删不掉）。

---

## 4. 默认值与调参指南

### 4.1 默认配置

```json
{
  "decay": {
    "enabled": true,
    "recencyHalfLifeDays": 30,
    "recencyWeight": 0.4,
    "importanceModulation": 1.5,
    "frequencyWeight": 0.3,
    "intrinsicWeight": 0.3,
    "betaCore": 0.8,
    "betaWorking": 1.0,
    "betaPeripheral": 1.3,
    "coreAccessThreshold": 10,
    "coreCompositeThreshold": 0.7,
    "coreImportanceThreshold": 0.8,
    "peripheralCompositeThreshold": 0.15,
    "peripheralAgeDays": 60,
    "workingAccessThreshold": 3,
    "workingCompositeThreshold": 0.4,
    "autoDeprecate": true,
    "autoDeprecateAfterDays": 30,
    "purgeAfterDays": 60
  }
}
```

### 4.2 数值来源

| 参数 | 默认值 | 来源 |
|---|---|---|
| `recencyHalfLifeDays` | 30 | 艾宾浩斯曲线 ~25% 保留率拐点；同时与 lancedb-pro 的 `recencyHalfLifeDays` + `ACCESS_DECAY_HALF_LIFE_DAYS` 一致 |
| `importanceModulation` | 1.5 | lancedb-pro：`effectiveHL = 30 · exp(1.5 · importance)`，importance=1 时半衰期延长到 ~134 天 |
| `betaCore/Working/Peripheral` | 0.8 / 1.0 / 1.3 | lancedb-pro Weibull 形状参数 |
| 7 个 tier 转换阈值 | — | lancedb-pro `tier-manager` 默认值 |
| `recencyWeight / frequencyWeight / intrinsicWeight` | 0.4 / 0.3 / 0.3 | lancedb-pro 三因子权重，和为 1 |
| `validatedCount` 分母 | 5 | lancedb-pro 的 `1 − exp(−count/5)` 基础频率项（未改） |
| `autoDeprecateAfterDays` | 30 | 遗忘终态缓冲：peripheral 降级后再经历一个半衰期量级的静默期才弃用，避免误伤短暂边缘化的重要知识 |
| `purgeAfterDays` | 60 | 弃用后两个月的"反悔窗口"，之后硬删释放存储；设 0 关闭硬删 |

### 4.3 常见调参场景

| 想要的效果 | 调整方向 |
|---|---|
| 记忆整体保留更久 | 调高 `recencyHalfLifeDays`（如 60）或调低 `peripheralCompositeThreshold`（更难降级） |
| 更激进遗忘 | 调低 `recencyHalfLifeDays`（如 14）或调高 `peripheralCompositeThreshold` |
| 重要知识显著保得久 | 调高 `importanceModulation`（半衰期调制更强） |
| 核心知识不易降级 | 调低 `betaCore`（更缓的尾部）或调高 `coreCompositeThreshold`（更难升 core，留在 working 也保得久） |
| 单次曝光更易遗忘 | 调高 `workingAccessThreshold`（promote 到 working 需要更多确认） |
| 只降级、永不自动弃用 | `"autoDeprecate": false` |
| 弃用后保留更久再硬删 | 调高 `purgeAfterDays`（如 180），或设 0 永不硬删 |
| 永久禁用衰减（含自动弃用） | `"enabled": false` |

### 4.4 与原布尔阈值方案的对照（向后兼容）

旧版本（`maxAgeDays` + `minCalls`）的布尔规则已被这套柔性评分取代。原默认值 `maxAgeDays=30, minCalls=2` 在新模型下大致对应于：

- 一个 `validatedCount=1`、`tier=working`、低 pagerank 的节点，约 30 天后 `recency` 跌破 0.15 → `composite` 跌破 `peripheralCompositeThreshold` → demote 到 `peripheral`。
- 关键差别：新模型先降 tier 不直接弃用，节点仍可搜索（只是 decayScore 较低）；只有再经历 `autoDeprecateAfterDays` 静默期后才会按 §3.5 自动弃用（默认开启，可关闭），彻底断联则要到弃用时刻。

---

## 5. 数据库字段

| 字段 | 类型 | 写入者 | 说明 |
|---|---|---|---|
| `tier` | string | `applyDecay` / `upsertNode`（创建时初始化为 `working`） | `core` / `working` / `peripheral` |
| `lastAccessedAt` | int (epoch ms) | `upsertNode`（重新提取时） | decay 评分的时间基准 |
| `decayScore` | float (0~1) | `applyDecay` | 最近一次评分结果 |
| `decayComputedAt` | int (epoch ms) | `applyDecay` | 评分时间戳 |
| `deprecatedAt` | int (epoch ms) | `deprecateNodeAndDisconnectById` / `mergeNodes` / `autoDeprecateNodes`（已弃用节点重复弃用时保留原值，不重置时钟） | 弃用时刻；阶段二硬删倒计时基准，缺失时回退 `updatedAt` |
| `deprecatedBy` | string | 同上 | `decay`（可复活）/ `manual` / `merge`（不复活）；缺失按 `manual` 处理 |

旧节点缺这些字段时：
- `tier` 缺失 → 评分按 `working` 处理；首次 `applyDecay` 时自动写入 `working`
- `lastAccessedAt` 缺失 → 回退到 `updatedAt` / `createdAt`
- `decayScore` / `decayComputedAt` 缺失 → 在首次 `applyDecay` 前为 undefined，不影响评分

**Backfill 时机**：新字段在第一次 `applyDecay` 运行时为每个 active 节点批量写入。如果部署初始用 `decay.enabled=false`，字段会一直缺失直到切换为 `true` 后的第一次维护周期。在切换前的窗口期，对 raw DB 直接做 `tier` 过滤查询会返回 null/missing 而非 `"working"`——目前搜索路径不读 `tier`，但自定义查询需要留意。

---

## 6. 实现位置

| 文件 | 内容 |
|---|---|
| `src/graph/decay.ts` | 评分函数 + tier 决策 + 自动弃用决策（`shouldAutoDeprecate`）+ `applyDecay()` 批处理 |
| `src/types.ts` | `DecayConfig` 接口、`NodeTier` / `DeprecatedBy` 类型、`GmNode` 新字段、`DEFAULT_CONFIG.decay` |
| `src/store/store.ts` | `toNode` 字段映射、`upsertNode` 初始化 `tier` / `lastAccessedAt`、复活逻辑（`upsertNode`/`updateNode`）、`autoDeprecateNodes()`、`purgeDeprecatedNodes()` |
| `src/graph/maintenance.ts` | 调用入口（step 0 评分/弃用 + step 0.5 硬删） |
| `test/decay.test.ts` | 评分函数 + tier 决策 + 自动弃用决策纯函数单元测试 |
| `test/integration.neo4j.test.ts` | 自动弃用 / 硬删 / 复活的集成测试（`NEO4J_INTEGRATION=1`） |
| `openclaw.plugin.json` | 用户可见的配置 schema |
