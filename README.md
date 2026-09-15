# graph-memory-pro

Neo4j-backed knowledge graph context engine for OpenClaw. It extracts `TASK`, `SKILL`, and `EVENT` triples from conversations, recalls related knowledge across sessions, and maintains the graph with GDS PageRank, community detection, and vector deduplication.

This repository is the Linux-portable counterpart of the Windows `v2.0.0` release. It uses Neo4j rather than the SQLite implementation from graph-memory v1.x.

## Features

- Neo4j labels: `Task`, `Skill`, `Event`, `Community`, and `GmMessage`
- Typed relationships: `USED_SKILL`, `SOLVED_BY`, `REQUIRES`, `PATCHES`, `CONFLICTS_WITH`
- GDS Personalized PageRank for recall and global PageRank for maintenance
- Neo4j vector indexes for semantic recall and duplicate detection
- APOC-backed dynamic relationship creation and node merge
- Community-level recall with LLM-generated summaries
- Gateway-authenticated CRUD API at `/graph-memory-pro/api/`

## Requirements

- OpenClaw
- Node.js 20+
- Java 17+ when using the bundled Linux setup
- Neo4j 5.24.2 with APOC 5.24.2
- GDS 2.12.0 is strongly recommended for PageRank; without it, ranking falls back to a basic order

## Release Line

This branch is the **v2.0 desktop-2.0 release line** (Neo4j backend), separate from the v1.x mainline (SQLite). The supported SQLite-to-Neo4j migration workflow is documented in [`migrate/Migrate.md`](migrate/Migrate.md).

## Linux Quick Start

Run the setup script from this repository on Linux:

```bash
bash setup-graph-memory-pro.sh
```

The script installs a user-local Neo4j distribution in `~/.graph-memory-pro/neo4j`, configures APOC and GDS, installs or registers this local plugin, writes `~/.openclaw/openclaw.json`, and restarts the gateway when possible.

Useful modes:

```bash
bash setup-graph-memory-pro.sh --dry-run
bash setup-graph-memory-pro.sh --skip-neo4j --neo4j-uri bolt://localhost:7687 --neo4j-password 'your-password'
bash setup-graph-memory-pro.sh --skip-autostart      # 不配置开机自启
bash setup-graph-memory-pro.sh --assume-deps         # 跳过 curl/tar/jq/java 依赖检查
bash setup-graph-memory-pro.sh --uninstall           # 还原配置 + 清理自启 + 停止 Neo4j
```

Neo4j binds to `127.0.0.1` and uses Bolt port `7687` by default.

### Boot autostart (no sudo)

The installer configures Neo4j to start at boot with a 3-tier no-sudo fallback:

1. **systemd --user unit** (`~/.config/systemd/user/graph-memory-pro-neo4j.service`) — preferred, adds `systemctl --user` management. Best-effort `loginctl enable-linger` for boot-time start.
2. **cron `@reboot`** — always configured as a backup so Neo4j starts even when linger is unavailable.
3. **shell rc hook** (`~/.bashrc` / `~/.zshrc` idempotent `pgrep` guard) — last resort when systemd and cron are both unavailable.

`--uninstall` cleans up all three. Only Java and jq system installs may need `sudo` (the script suggests `sdkman!` and a static `jq` binary as no-sudo alternatives).

## Manual Configuration

Install the local plugin, then make it the OpenClaw context engine (**restart the gateway after changing config**: the plugin guards against duplicate `register()` — a second registration without `dispose()` reuses the active engine, so new config is never hot-reloaded):

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
            "password": "your-neo4j-password"
          },
          "llm": {
            "provider": "openai",
            "apiKey": "your-llm-api-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "your-embedding-api-key",
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

Anthropic direct (Claude) — drop `baseURL`, switch `provider`:

```json
"llm": {
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "model": "claude-3-5-sonnet-20241022"
}
```

`embedding` is optional. When present, `dimensions` must match the Neo4j vector index dimension. For a fresh database, the plugin creates matching indexes during startup. If you change dimensions later, recreate the vector indexes or the Neo4j database.

### Memory decay (forgetting curve)

Each maintenance cycle scores every active node with a three-factor weighted model (recency + frequency + intrinsic) and bidirectionally transitions nodes across three tiers: `core` / `working` / `peripheral`. Two lifecycle stages sit on top of the forgetting curve (both on by default, configurable via `decay`): **auto-deprecation** — a `peripheral` node whose composite stays below `peripheralCompositeThreshold` and which has not been accessed for `autoDeprecateAfterDays` (30) days gets its edges severed and is marked `deprecated`; if the same knowledge is extracted or edited again, the node automatically revives to `active`. **purge** — any `deprecated` node (manual deprecation and merge losers included) is hard-deleted (`DETACH DELETE`, vectors included) after `purgeAfterDays` (60) days to reclaim storage.

The full formula, field mapping from the reference implementation, default-value rationale, and tuning guide live in **[`docs/decay.md`](docs/decay.md)**.

Minimal config (all fields optional, defaults shown):

```json
"decay": { "enabled": true }
```

Common overrides — for fuller control see `docs/decay.md` §4:

```json
"decay": {
  "enabled": true,
  "recencyHalfLifeDays": 30,
  "peripheralCompositeThreshold": 0.15,
  "workingAccessThreshold": 3
}
```

### Cron sessions

Sessions created by OpenClaw scheduled tasks can be configured independently of normal sessions. The host places the cron marker on the **sessionKey** (`sessionId` is a random UUID); real shapes are `cron:<jobId>`, `agent:<agentId>:cron:<jobId>`, or `agent:<agentId>:cron:<jobId>:run:<runId>`:

```json
"cron": {
  "enabled": true,
  "extract": true,
  "finalizeAndMaintain": true
}
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable graph functionality inside cron sessions (recall injection + message buffering). When `false`, cron sessions skip automatic recall and message persistence; the `gm_*` tools remain available for explicit calls (manual escape hatch). |
| `extract` | `true` | Trigger knowledge extraction (LLM triples) in cron sessions via `afterTurn` / `commitTurn` / `compact`. When `false`, messages are still buffered and can be backfilled later with `openclaw graph-memory extract`. |
| `finalizeAndMaintain` | `true` | Run finalize (EVENT→SKILL promotion) and graph maintenance (decay / PageRank / communities) when a cron session ends. Disable when frequent cron runs make end-of-session global maintenance too costly. |

All three options default to **`true`**: cron sessions behave like normal sessions (recall, buffering, extraction, and end-of-session maintenance all enabled) unless explicitly disabled. `enabled: false` is the master switch — even with `extract` / `finalizeAndMaintain` set to `true`, nothing runs. Non-cron sessions are never affected by these options.

All three sub-options are optional; omitted fields keep the default `true` (e.g. with `"cron": { "extract": false }` only extraction is disabled — recall, buffering, and end-of-session maintenance stay on).

Caveat: when a cron job sets an explicit custom `sessionKey`, the host does not append the `cron` segment — such sessions cannot be detected and are treated as normal sessions.

### Knowledge extraction (extract, LLM cost control)

By default every turn triggers an immediate LLM extraction (`per-turn` mode), with a local pre-filter that skips trivial turns (empty input, filler words, or ultra-short input without technical tokens — turns containing tool work are never skipped) without calling the LLM. Chatty sessions can switch to batched extraction to cut LLM call volume to ~1/N:

```json
"extract": {
  "mode": "batched",
  "trivialMaxChars": 5
}
```

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `"per-turn"` | `per-turn` = extract immediately after each turn (`afterTurn` / `commitTurn`), so knowledge is queryable mid-session; `batched` = no per-turn LLM calls — unextracted messages accumulate and are batch-extracted once they reach `compactTurnCount * 3` messages, with the tail batch flushed at session end. Trade-off: mid-session recall cannot see the latest turns' knowledge until the next batch (or session end) runs. |
| `trivialMaxChars` | `5` | Local pre-filter threshold (`per-turn` path only): if the user text, after stripping whitespace/punctuation, is at or under this length **and** contains no technical tokens (3+ alphanumeric run, e.g. `pnpm`/`jwt`), the turn is marked extracted without an LLM call. Trivially-skipped turns are marked `producedKnowledge=false`, so retention never deletes their raw evidence. |
| `trivialPrompts` | — | Extra filler words merged with the built-in stoplist (exact match after cleaning + lowercasing, e.g. `"继续"`, `"resume"`). |

### Context compaction (delegating mode)

This engine runs in OpenClaw's **delegating mode** (`ownsCompaction: false`): `/compact`, near-limit auto-compaction, and overflow-recovery compaction all delegate window reduction to OpenClaw's built-in summarization pipeline (the same bridge the legacy engine uses, `delegateCompactionToRuntime` from `openclaw/plugin-sdk/core`). When a compaction fires, the engine additionally kicks off a **fire-and-forget** extraction of any unextracted messages (the `GmMessage` backlog — host compaction only rewrites the transcript, never the graph store), so knowledge is preserved into the graph without blocking compaction or the next user message.

`assemble()` declares `promptAuthority: "preassembly_may_overflow"`: the host keeps its generic pre-prompt overflow precheck active and takes the maximum of the assembled estimate and the unwindowed session-history estimate when deciding whether to preemptively compact — the recent-turn window alone can never hide an overflow that would fail the turn. Requires OpenClaw 2026.6+ (older hosts fall back to extraction-only compaction with a warning; the host's own in-attempt auto-compaction still runs).

### Raw message retention (messageRetention, opt-in)

Context compaction only changes what the model sees — it is **not authorization to delete persistent evidence**. The default `keep=all` never deletes any raw message (GmMessage) at zero overhead. To bound database growth, opt into bounded pruning; it runs at the tail of the graph maintenance chain and processes at most `batchSize` rows per cycle:

```json
"messageRetention": {
  "keep": "referenced",
  "batchSize": 500,
  "dryRun": false
}
```

| Option | Default | Description |
| --- | --- | --- |
| `keep` | `"all"` | `all` = keep everything (default, zero behavior change); `referenced` = delete only messages that were extracted **and** actually produced knowledge; `recent` = `referenced` plus a time-window guard (requires at least one window option). |
| `recentTurns` | `0` | `keep=recent`: keep the newest N real user turns per session (that turn and everything after it). Sessions with no user messages are fully protected. |
| `retentionDays` | `0` | `keep=recent`: keep messages ingested within the last N days. |
| `batchSize` | `500` | Maximum rows processed per maintenance cycle (1–10000), keeping the chain bounded. |
| `dryRun` | `false` | `true` reports the candidate set without deleting — **run one `dryRun` cycle to validate candidates before enabling pruning**. |

Deletion semantics (fail-closed):

- Only messages with `extracted=true` **and** `producedKnowledge=true` (the extraction actually produced nodes/edges) enter the candidate set.
- Turns skipped by the trivial pre-filter, and turns where the LLM returned zero nodes and zero edges, are marked `producedKnowledge=false` — the raw evidence stays in the database. Such turns are never re-extracted automatically; to re-mine them with a better prompt/model, manually reset their `extracted` flag to `false` and re-run `openclaw graph-memory extract`.
- Unextracted messages and legacy rows (extracted before this flag existed, no `producedKnowledge` property) are never deleted.
- A failure in the retention step itself (invalid policy fails closed with zero deletions / Neo4j error) never invalidates the other maintenance steps; it retries next cycle.

### Re-embedding after switching embedding models

Embedding vectors are model-specific — vectors produced by the old model are not comparable
(different dimensions break dedup and vector search outright), and vectors are write-once with
no automatic migration. After changing `embedding.model` / `embedding.dimensions`, run:

```bash
openclaw graph-memory reembed --dry-run   # report dimension match + vector coverage, no writes
openclaw graph-memory reembed             # void all vectors and rebuild them in batches
```

The command voids every `MemoryNode.embedding` (and its `contentHash`, so the runtime
`syncEmbed` hash guard cannot short-circuit), then re-embeds all active nodes and community
summaries with the current model using batched requests (`--batch <n>`, default 32; failed
batches automatically fall back to per-item requests). If the vector index dimensions no longer
match the configured model, the run aborts — add `--recreate-index` to drop and recreate
`gm_node_embedding` / `gm_community_embedding` with the new dimensions. Items that fail stay
vectorless and are picked up by a re-run.

### OAuth login (experimental)

```bash
openclaw graph-memory auth login
```

The command completes login in a browser, stores tokens at
`~/.openclaw/.graph-memory-pro/oauth.json` with mode `0600`, and atomically updates
`plugins.entries.graph-memory-pro.config.llm`. A previous non-OAuth LLM configuration is backed up as
`llm-config.backup.json` in the same directory. This path depends on Codex/ChatGPT OAuth and backend protocols rather than the stable public OpenAI API contract; prefer API-key configuration for production deployments.

## Data Flow

```text
conversation messages -> GmMessage nodes -> LLM triple extraction
  -> Task / Skill / Event nodes + typed relationships
  -> embeddings -> vector recall + community expansion + GDS PPR
  -> XML context injection

session end -> decay (forgetting curve) -> purge expired deprecated -> dedup -> global PageRank -> communities -> summaries
  -> message retention (opt-in)
```

## Verify

Start OpenClaw with verbose logging:

```bash
openclaw gateway --verbose
```

Expected messages include:

```text
[graph-memory-pro] Neo4j schema initialized
[graph-memory-pro] ready | neo4j=bolt://localhost:7687
```

Inspect the graph with the bundled Cypher shell:

```bash
~/.graph-memory-pro/neo4j/bin/cypher-shell -u neo4j -p 'your-password' \
  "MATCH (n:Task|Skill|Event) RETURN n.type, n.name, n.pagerank ORDER BY n.pagerank DESC LIMIT 10"
```

## Agent Tools

| Tool | Description |
| --- | --- |
| `gm_search` | Recall graph knowledge for a query |
| `gm_record` | Add a knowledge node manually |
| `gm_update` | Update or deprecate an existing node by exact name. `mode=update` (default) refines description/content; `mode=deprecate` marks `[DEPRECATED]`, removes all relationships, and makes the node unreachable from recall (equivalent to deletion; physically purged by maintenance after `purgeAfterDays`). `mode=delete` was removed — deprecate replaces it (throws if not found) |
| `gm_link` | Manually create or refine an edge between two existing nodes (validates type + direction against the whitelist; idempotent on from+to+type) |
| `gm_unlink` | Remove edges between two nodes by name; optional `type` filter, otherwise all from→to edges |
| `gm_merge` | Merge two same-type duplicate nodes: keep absorbs content/validatedCount/sessions + dedup-aware edge migration; merge is soft-deleted |
| `gm_stats` | Show node, relationship, community, and PageRank statistics |
| `gm_maintain` | Run decay scoring, deduplication, PageRank, and community maintenance |

## Development

```bash
npm install
npm run build     # compiles to dist/
npm test          # unit tests only (no Neo4j required)
```

### Integration tests

Storage / Cypher / graph-algorithm changes are covered by integration tests that need a live Neo4j with APOC and GDS:

```bash
# 本地跑：先启动 Neo4j 5.24.2 + APOC + GDS，然后
NEO4J_INTEGRATION=1 npm test
```

CI runs them via a Docker Neo4j service container — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

`npm run typecheck` validates source and test types. `npm run build` emits the installed runtime to `dist/`; OpenClaw uses the source entry for a checkout and the built entry for an installed package. Add integration tests under `test/integration.*.test.ts` whenever you change storage or Cypher behavior; unit tests cover pure logic only.

## License

MIT
