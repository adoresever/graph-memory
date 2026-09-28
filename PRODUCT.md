# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and agent builders evaluating or installing Graph Memory for DeepSeek Harness or OpenClaw. They need to understand the mechanism, measured token effect, memory fidelity, and operating limits quickly.

## Product Purpose

Graph Memory is a conversation-memory plugin. It owns the model-facing historical context, retains a configurable recent-turn window, archives older surface history, and recalls question-relevant knowledge plus exact source messages across turns, sessions, and projects.

## Positioning

Graph Memory combines context takeover with durable, source-backed recall. It is not only an external knowledge base and not only a lossy conversation summarizer.

## Operating Context

- Primary host: DeepSeek Harness.
- Compatible host: OpenClaw.
- Storage: local SQLite graph, message provenance, revisions, and vectors.
- Retrieval: query-first vector ranking with FTS fallback; graph nodes navigate to exact source Q/A.
- Evaluation: a reproducible 20-turn coding-agent scenario using real model and embedding APIs.

## Capabilities and Constraints

- Keeps the newest configurable number of completed user turns on the model surface.
- Removes completed reasoning and tool traces from future model context while preserving DSH's immutable event log.
- Extracts only the user's question and the final visible answer into a strict structured graph contract.
- Automatically recalls memory before the foreground model request; the agent does not need to call a memory tool.
- Supports cross-session and cross-project recall.
- Current measured structured-extraction success is 19/20; invalid output is quarantined.
- A single multi-topic query is bounded by configurable `recallMaxNodes`; split queries or a larger Top-K may be needed.
- Benchmark claims must separate context-size evidence from model tool-path variance.

## Brand Commitments

- Product name: Graph Memory.
- DeepSeek Harness must be visually primary; OpenClaw is a compatibility host.
- Use existing project and host assets. Do not invent substitute logos.
- Public copy should be concise, technical, and evidence-led.

## Evidence on Hand

- `docs/images/brand/graph-memory-hosts-banner.png`
- `docs/images/deepseek-harness-wordmark.svg`
- `docs/images/brand/openclaw-wordmark.svg`
- `README.md` and `README_CN.md`
- `benchmarks/dsh-context-takeover/README.md`
- V72 20-turn manifest and three cross-session recall probe results in the benchmark job directory.
- Local automated verification: 20 test files, 123 passing tests, both TypeScript builds, npm dry-run package.

## Product Principles

- Context must stay bounded as conversations grow.
- Compression must not destroy retrievable source evidence.
- Retrieval relevance outranks graph centrality.
- Bad structured extraction fails closed; foreground conversation fails open.
- Every public metric must be reproducible and scoped to what it actually measures.

## Accessibility & Inclusion

The public report must remain readable and navigable on desktop and mobile, support keyboard focus, reduced motion, and high-contrast data encoding that does not depend on color alone.
