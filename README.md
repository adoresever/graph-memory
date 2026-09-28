# Graph Memory

<p align="center">
  <img src="docs/images/brand/graph-memory-hosts-banner.png" alt="Graph Memory for DeepSeek Harness, compatible with OpenClaw" width="100%">
</p>

<p align="center">
  <strong>Bound the context. Keep the memory.</strong><br>
  A native DeepSeek Harness memory plugin that keeps recent conversation turns, archives older history, and recalls exact source-backed knowledge when it matters.
</p>

<p align="center">
  <a href="README_CN.md">中文</a> ·
  <a href="https://www.dsh.so/artifact/graph-memory">dsh.so</a> ·
  <a href="benchmarks/dsh-context-takeover/README.md">20-turn benchmark</a> ·
  <a href="docs/TURN_MEMORY_NAVIGATION_UPGRADE_CN.md">Upgrade guide</a>
</p>

<p align="center">
  <a href="https://www.dsh.so/artifact/graph-memory"><img src="https://www.dsh.so/badge/graph-memory.svg" alt="dsh.so security badge"></a>
  <a href="https://www.dsh.so/artifact/graph-memory"><img src="https://www.dsh.so/badge/install/graph-memory.svg" alt="dsh.so install badge"></a>
</p>

## The problem it solves

<p align="center">
  <img src="docs/images/context-memory-illustration.webp" alt="Long agent history becomes graph navigation plus a compact recent-turn context" width="100%">
</p>

Graph Memory owns the **model-visible historical surface** without deleting DSH's event log. By default it keeps the newest five completed user turns, removes completed reasoning/tool traces from future requests, and recalls relevant older or cross-session source Q/A automatically.

## The 1.6 turn-memory navigation upgrade

| Before | Now |
|---|---|
| Extract TASK / SKILL / EVENT directly from messages | Create one self-contained turn summary, then derive SPO from that same sentence |
| Graph nodes could become the factual payload | Summary, SPO, and communities only navigate; original question and final answer remain the evidence |
| Old memories from the active session could be filtered wholesale | Exclude only sources still visible in the fresh window; archived same-session and cross-session recall share one path |
| Community expansion could pull a whole neighborhood | Local LPA narrows candidates, query-time PPR ranks them, and only matched Q/A is recovered |
| DSH retained complete tool and reasoning traces | Completed turns retain question + final answer; older prefixes collapse to one fixed marker |

Writing one completed turn costs exactly **one auxiliary LLM call**. Community detection and PPR are local. There are no hard-coded node/edge counts, semantic direction gates, or JSON repair that turns invalid output into accepted data. [Read the complete design, source map, and porting sequence →](docs/TURN_MEMORY_NAVIGATION_UPGRADE_CN.md)

## Measured first

<p align="center">
  <img src="docs/images/dsh-context-takeover-chart.svg" alt="DSH 20-turn first-request context comparison" width="100%">
</p>

| Real 20-turn GLM-5.2 run | Historical native DSH baseline | Latest Graph Memory | Change |
|---|---:|---:|---:|
| T20 first request | 56,998 tokens | **11,008 tokens** | **−80.69%** |
| T20 model-visible messages | 171 | **21** | **−87.72%** |
| T01–T20 first-request context | 532,451 tokens | **165,896 tokens** | **−68.84%** |
| All measured tokens¹ | 2,487,776 | **2,327,728** | **−6.43%** |

<sub>¹ The latest candidate includes 166 main-agent requests, 20 turn extractions, and 41 embedding requests; the historical baseline made 77 main requests. DSH commits and nondeterministic tool loops differ, so this is not a simultaneous strict A/B. First-request context is the direct takeover metric; the full bill remains visible.</sub>

**20/20** scenario turns passed · **20/20** structured extractions succeeded · **0** quarantined · **20** turn summaries · **92** SPO triples · **30** communities · **20** summary vectors. T11, T19, and T20 automatically recalled out-of-window memory with exact source question and final answer.

[Read the Markdown benchmark, per-turn data, method, and limits →](benchmarks/dsh-context-takeover/README.md)

## Memory survives the context window

<p align="center">
  <img src="docs/images/dsh/plugin-inventory-active.png" alt="Graph Memory active in DSH" width="48%">
  <img src="docs/images/dsh/vector-cross-session-recall.png" alt="Cross-session recall in a fresh DSH session" width="48%">
</p>

The graph is a **navigation layer**, not a replacement for evidence. `TASK`, `SKILL`, and `EVENT` nodes point back to the original user question and final visible answer; recalled context includes those exact source messages.

## Install on DeepSeek Harness

Node.js `22.13+` · no DSH fork · until npm `1.6` is published, install the pinned GitHub release:

```bash
npx @deepseek-ai/dsh plugin --profile web add github:adoresever/graph-memory#v1.6.0-beta.16
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

The npm registry still serves the old `1.5.8`; do not use it to validate DSH. Switch to `npx @deepseek-ai/dsh plugin --profile web add graph-memory` only after `npm view graph-memory version` reports `1.6.0-beta.16` or newer.

Confirm that `graph-memory/dsh` is active under **Settings → Plugins**. The default database is `$DSH_HOME/graph-memory/graph-memory.db`, normally `~/.dsh/graph-memory/graph-memory.db`.

## What ships

| Capability | Implementation |
|---|---|
| Context takeover | Configurable newest-N completed turns; one archive marker replaces the older model surface |
| Lightweight extraction | Only the user question and final answer; strict structured tool contract; no reasoning/tool transcript ingestion |
| Query-first recall | Vector Top-K with FTS5 fallback; exact source Q/A travels with graph hits |
| Durable memory | Local SQLite, stable provenance, cross-session and cross-project recall |
| Failure behavior | Invalid extraction is quarantined; foreground conversation continues; bad data is not repaired or persisted |
| Host support | Native DSH/Cordis adapter; maintained OpenClaw Context Engine adapter |

<details>
<summary><strong>Optional embeddings</strong></summary>

Graph Memory supports OpenAI-compatible embedding endpoints. Without embeddings it falls back to FTS5 and does not block conversation.

```bash
export GRAPH_MEMORY_EMBEDDING_API_KEY='replace-with-your-key'
export GRAPH_MEMORY_EMBEDDING_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1'
export GRAPH_MEMORY_EMBEDDING_MODEL='text-embedding-v4'
export GRAPH_MEMORY_EMBEDDING_DIMENSIONS='1024'
dsh web
```

</details>

<details>
<summary><strong>DSH tools and extraction route</strong></summary>

| Tool | Purpose |
|---|---|
| `gm_status` | Store, extraction, recall, vector, and retention state |
| `gm_search` | Explicit graph-memory search |
| `gm_record` | Deterministically persist a `TASK`, `SKILL`, or `EVENT` |
| `gm_stats` | Graph and retention receipts |
| `gm_maintain` | One bounded maintenance tick |
| `gm_retry_extraction` | Explicitly retry quarantined extraction |

Automatic recall needs no tool call. Extraction may use a dedicated model via `GRAPH_MEMORY_LLM_PROVIDER` and `GRAPH_MEMORY_LLM_MODEL`; optional reasoning and output controls are `GRAPH_MEMORY_LLM_REASONING_EFFORT` and `GRAPH_MEMORY_LLM_MAX_TOKENS`.

</details>

<details>
<summary><strong>OpenClaw compatibility</strong></summary>

```bash
openclaw plugins install graph-memory
openclaw plugins enable graph-memory
openclaw gateway restart
```

Activate the Context Engine slot in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": { "contextEngine": "graph-memory" },
    "entries": { "graph-memory": { "enabled": true } }
  }
}
```

<p align="center">
  <img src="docs/images/token-comparison.png" alt="Earlier OpenClaw seven-turn token comparison" width="76%">
</p>

</details>

<details>
<summary><strong>Graph Memory Pro</strong></summary>

The repository also contains an experimental read-only DSH Pro Lite Host + Client plugin backed by Community SQLite. The 2D/3D graph workbench, split view, and controlled drag-to-context remain planned. See [`dsh-pro/README_CN.md`](dsh-pro/README_CN.md).

</details>

## Verification and limits

Current beta `1.6.0-beta.16` passes **138/138 automated tests**, both TypeScript builds, npm package verification, and a real 20-turn run against the latest DSH source.

- Structured extraction still depends on model contract compliance: the latest run succeeded 20/20 times; any future failure stays quarantined and never blocks the foreground conversation.
- Recall is bounded by configurable Top-K. Focused probes succeeded; one broad multi-topic query can require a larger Top-K or separate questions.
- The published run is an engineering workload, not a universal LoCoMo/LongMemEval score.
- The design, source-code map, and porting sequence for the summary + SPO navigation + exact-Q/A upgrade are documented in the [Chinese upgrade guide](docs/TURN_MEMORY_NAVIGATION_UPGRADE_CN.md).

Reproduce it from [`benchmarks/dsh-context-takeover/`](benchmarks/dsh-context-takeover/). Raw conversations, provider responses, local paths, and credentials are excluded.

## Development

```bash
npm install
npm test
npm run build
npm run verify:package
```

[MIT](LICENSE) © 2026 adoresever · [Asset and trademark notes](docs/ATTRIBUTIONS.md)
