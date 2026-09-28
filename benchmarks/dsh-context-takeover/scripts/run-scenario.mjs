#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {delimiter, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const benchmarkRoot = resolve(import.meta.dirname, '..');
const dshRepo = resolve(process.env.BENCHMARK_DSH_REPO ?? '');
const dshHome = resolve(process.env.BENCHMARK_DSH_HOME ?? '');
const workspace = resolve(process.env.BENCHMARK_WORKSPACE ?? '');
const runId = process.env.BENCHMARK_RUN_ID;
const provider = process.env.BENCHMARK_PROVIDER;
const model = process.env.BENCHMARK_MODEL;
const profile = process.env.BENCHMARK_PROFILE ?? 'sdk';
const patchList = (process.env.BENCHMARK_PATCHES ?? '').split(delimiter).filter(Boolean).map(resolve);

const required = {BENCHMARK_DSH_REPO:dshRepo, BENCHMARK_DSH_HOME:dshHome, BENCHMARK_WORKSPACE:workspace};
for (const [name, path] of Object.entries(required)) {
  if (!process.env[name] || !existsSync(path)) throw new Error(`${name} must point to an existing path`);
}
if (!runId || !provider || !model) {
  throw new Error('BENCHMARK_RUN_ID, BENCHMARK_PROVIDER, and BENCHMARK_MODEL are required');
}
for (const patch of patchList) {
  if (!existsSync(patch)) throw new Error(`patch not found: ${patch}`);
}

const runRoot = resolve(benchmarkRoot, 'runs', runId);
if (existsSync(runRoot)) throw new Error(`run directory already exists: ${runRoot}`);
mkdirSync(runRoot, {recursive: true});
const usagePath = resolve(runRoot, 'usage.jsonl');
const scenario = JSON.parse(readFileSync(resolve(benchmarkRoot, 'scenario-20.json'), 'utf8'));
const sdkPath = resolve(dshRepo, 'packages/sdk/client/lib/index.js');
const dshBin = resolve(dshRepo, 'apps/cli/lib/bin.js');
const {DeepSeekHarness} = await import(pathToFileURL(sdkPath).href);
const sha256 = value => createHash('sha256').update(value).digest('hex');

const harness = new DeepSeekHarness({
  dshBin,
  profile,
  patches: patchList,
  dshHome,
  cwd: workspace,
  provider,
  model,
  initializeTimeoutMs: 120000,
  env: {...process.env, DSH_USAGE_TAP_FILE: usagePath},
});

const manifest = {
  schemaVersion: 1,
  scenario: scenario.id,
  startedAt: new Date().toISOString(),
  provider,
  model,
  profile,
  turns: [],
};

try {
  const session = harness.session(`graph-memory-benchmark-${runId}`);
  for (const turn of scenario.turns) {
    const startedAt = Date.now();
    let finalResponse = null;
    let error = null;
    try {
      const response = await session.run(`[BENCHMARK_TURN=${turn.id}]\n${turn.prompt}`);
      finalResponse = response?.finalResponse ?? null;
    } catch (caught) {
      error = String(caught?.stack ?? caught);
    }
    manifest.turns.push({
      id: turn.id,
      durationMs: Date.now() - startedAt,
      responseSha256: finalResponse ? sha256(finalResponse) : null,
      responseBytes: finalResponse ? Buffer.byteLength(finalResponse) : 0,
      error,
    });
    writeFileSync(resolve(runRoot, 'manifest.partial.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (error) throw new Error(`${turn.id} failed; see manifest.partial.json`);
  }
  manifest.completedAt = new Date().toISOString();
  writeFileSync(resolve(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await harness.close().catch(() => {});
}

console.log(JSON.stringify({runId, turns: manifest.turns.length, usagePath}));
