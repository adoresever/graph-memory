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
bash setup-graph-memory-pro.sh --uninstall
```

Neo4j binds to `127.0.0.1` and uses Bolt port `7687` by default.

## Manual Configuration

Install the local plugin, then make it the OpenClaw context engine:

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

`embedding` is optional. When present, `dimensions` must match the Neo4j vector index dimension. For a fresh database, the plugin creates matching indexes during startup. If you change dimensions later, recreate the vector indexes or the Neo4j database.

## Data Flow

```text
conversation messages -> GmMessage nodes -> LLM triple extraction
  -> Task / Skill / Event nodes + typed relationships
  -> embeddings -> vector recall + community expansion + GDS PPR
  -> XML context injection

session end -> dedup -> global PageRank -> communities -> summaries
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
| `gm_update` | Update an existing node's description and/or content by exact name (throws if not found) |
| `gm_stats` | Show node, relationship, community, and PageRank statistics |
| `gm_maintain` | Run deduplication, PageRank, and community maintenance |

## Development

```bash
npm install
npm run build
npm test
```

`npm run build` performs TypeScript typechecking only. The current port has no live-Neo4j integration suite; add integration tests against Neo4j before changing storage or Cypher behavior.

## License

MIT
