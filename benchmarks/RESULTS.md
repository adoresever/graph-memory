# Preliminary LoCoMo and LongMemEval results

Run date: 2026-08-20. Base commit: `2c20ed9` (`origin/main`).

These are reproducible engineering results, not leaderboard submissions. The
100-question subsets are deterministic and stratified, but smaller than the
official test sets. `session-index` stores each source session as one EVENT and
therefore measures the current store/retriever's ceiling. It bypasses Graph
Memory's current `TASK / SKILL / EVENT` extraction policy.

## Retrieval

`Rall@k` is the fraction of questions for which all annotated evidence sessions
appear in the top-k. LongMemEval eligibility follows its official retrieval
filter (answerable questions with a user-side `has_answer` target). LoCoMo has
99 eligible questions because one selected annotation has no parseable session.

| Dataset | Retriever | Eligible | Rall@5 | Rall@10 | Any@5 | nDCG@5 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| LoCoMo balanced-100 | vector | 99 | 41.4% | 49.5% | 54.5% | 38.9% |
| LoCoMo balanced-100 | FTS | 99 | **70.7%** | **80.8%** | **78.8%** | **69.1%** |
| LoCoMo balanced-100 | equal RRF | 99 | 55.6% | 68.7% | 72.7% | 54.2% |
| LongMemEval-S stratified-100 | vector | 90 | **74.4%** | **87.8%** | **93.3%** | **81.2%** |
| LongMemEval-S stratified-100 | FTS | 90 | 48.9% | 56.7% | 77.8% | 59.2% |
| LongMemEval-S stratified-100 | equal RRF | 90 | 62.2% | 73.3% | 92.2% | 73.0% |

The best-of-vector-or-FTS oracle reaches 78.8% / 84.8% Rall@5/@10 on
LoCoMo and 83.3% / 92.2% on LongMemEval. This shows useful complementary
signal, but the equal-weight fusion baseline does not find it. A query-aware
router or tuned fusion is required before changing the production retriever.

LongMemEval vector Rall@5 by type: knowledge update 68.8%, multi-session
76.9%, preference 66.7%, single-session user 76.9%, and temporal reasoning
75.0%. FTS is strongest for single-session user (100%) and knowledge update
(81.3%), but weak for temporal reasoning (25.0%) and preference (16.7%).

## End-to-end smoke checks

- LoCoMo, session-index + vector + GLM-5.2: official NLTK scorer F1 `0.6131`
  on only 10 questions. The sample contains just categories 1-3, so it is not a
  representative LoCoMo score.
- LongMemEval-S, session-index + vector + GLM-5.2 answers +
  Deepseek-v4-flash judge: `7/10`. All ten were early single-session-user
  questions, and the official benchmark uses a GPT judge, so this is only a
  provider-compatibility smoke check.
- LoCoMo native extraction smoke: 19 extraction calls over one conversation
  produced zero memory nodes, giving Rall@5 and Rall@10 of zero on 10 questions.
  The extractor is designed for operational TASK/SKILL/EVENT memory and drops
  the personal facts and preferences that these benchmarks ask about.

## Reproducibility and cost

- LoCoMo official data SHA-256:
  `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`
- LongMemEval-S cleaned data SHA-256:
  `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
- LoCoMo balanced subset: 20 questions from each of categories 1-5.
- LongMemEval subset: natural proportional stratification across six question
  types; 90 of 100 rows are eligible for official retrieval scoring.
- Embeddings: DashScope `text-embedding-v4`, 1024 dimensions. Answer model:
  `GLM-5.2`. Compatibility judge: `Deepseek-v4-flash`.
- Downloads occupy about 342 MB for official data and the two shallow benchmark
  repositories. Local Node/Python dependencies add about 135 MB. No model
  weights are downloaded.
- Observed retrieval-only wall time per 100 questions: LoCoMo FTS 0.5 s,
  LoCoMo vector/RRF about 95-100 s, LongMemEval FTS 5.5 s, and LongMemEval
  vector/RRF about 8-9 minutes.

For a publishable claim, run all 1,986 LoCoMo questions with the official
scorer and all 500 LongMemEval-S questions with the official evaluator/judge,
then repeat across multiple runs or report confidence intervals.
