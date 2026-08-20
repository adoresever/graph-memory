# Memory benchmarks

This adapter evaluates Graph Memory against the official LoCoMo and
LongMemEval-S data formats without storing provider credentials.

Two modes are intentionally reported separately:

- `native`: current `TASK / SKILL / EVENT` LLM extraction, vector indexing,
  provenance, and graph-memory storage;
- `session-index`: one traceable EVENT per source session, followed by the
  current vector store/search. This is a retrieval ceiling, not the current
  end-to-end product score.

Retrievers can be selected with `--retriever vector|fts|hybrid`. `hybrid` is
an experimental equal-weight reciprocal-rank fusion baseline; benchmark it
before considering any production change because its quality depends strongly
on the dataset and query type.

LongMemEval retrieval metrics match the official session-level definitions:
`recall_any@k`, `recall_all@k`, and `ndcg_any@k`. LoCoMo QA uses the official
category-specific token-F1/adversarial rules. A non-GPT LongMemEval judge is
reported as compatible evaluation, not an official leaderboard score.

For publishable LoCoMo F1, install `benchmarks/requirements.txt` and run
`benchmarks/score-locomo.py` on the generated JSONL. The JavaScript summary is
explicitly labeled approximate because it does not bundle NLTK's Porter stemmer.

Runtime variables are required only by the paths that use them. Pure
`session-index` + `fts` retrieval needs neither credential; vector retrieval
needs the embedding key, while native extraction or answer/judge runs need the
LLM key.

```bash
export GRAPH_MEMORY_BENCH_LLM_KEY=...
export GRAPH_MEMORY_BENCH_EMBEDDING_KEY=...
```

Example smoke runs:

```bash
npm run build
node benchmarks/run-memory-benchmark.mjs \
  --benchmark locomo --data /path/to/locomo10.json \
  --mode session-index --samples 1 --questions 10 --top-k 10 --answer

node benchmarks/run-memory-benchmark.mjs \
  --benchmark longmemeval --data /path/to/longmemeval_s_cleaned.json \
  --mode session-index --samples 10 --top-k 10 --answer --judge
```
