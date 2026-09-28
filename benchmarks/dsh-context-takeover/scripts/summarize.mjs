#!/usr/bin/env node
import {readFileSync} from 'node:fs';

const [baselinePath, graphMemoryPath] = process.argv.slice(2);
if (!baselinePath || !graphMemoryPath) {
  throw new Error('usage: summarize.mjs baseline-usage.jsonl graph-memory-usage.jsonl');
}

const readRows = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const value = (row, key) => Number(row?.usage?.[key] ?? 0);
const total = rows => rows.reduce((sum, row) => sum + value(row, 'totalTokens'), 0);
const firstByTurn = rows => {
  const groups = new Map();
  for (const row of rows) {
    if (!row.benchmarkTurn) continue;
    if (!groups.has(row.benchmarkTurn)) groups.set(row.benchmarkTurn, []);
    groups.get(row.benchmarkTurn).push(row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([, turnRows]) => turnRows.find(row => row.kind === 'conversation'))
    .filter(Boolean);
};

const baselineRows = readRows(baselinePath);
const gmRows = readRows(graphMemoryPath);
const baselineFirst = firstByTurn(baselineRows);
const gmFirst = firstByTurn(gmRows);
if (baselineFirst.length !== gmFirst.length) {
  throw new Error(`turn mismatch: baseline=${baselineFirst.length}, graphMemory=${gmFirst.length}`);
}
if (!baselineFirst.length) {
  throw new Error('no [BENCHMARK_TURN=Txx] markers found; use run-scenario.mjs or prefix each turn manually');
}

const firstTotal = rows => rows.reduce((sum, row) => sum + value(row, 'totalTokens'), 0);
const baselineFirstTotal = firstTotal(baselineFirst);
const gmFirstTotal = firstTotal(gmFirst);
const change = (before, after) => Number((((after / before) - 1) * 100).toFixed(2));
const result = {
  turns: baselineFirst.length,
  firstRequest: {
    baselineTokens: baselineFirstTotal,
    graphMemoryTokens: gmFirstTotal,
    changePercent: change(baselineFirstTotal, gmFirstTotal),
    perTurn: baselineFirst.map((row, index) => ({
      turn: index + 1,
      baselineTokens: value(row, 'totalTokens'),
      graphMemoryTokens: value(gmFirst[index], 'totalTokens'),
      baselineMessages: row.messageCount,
      graphMemoryMessages: gmFirst[index].messageCount,
    })),
  },
  allRequests: {
    baselineRequests: baselineRows.length,
    graphMemoryRequests: gmRows.length,
    baselineTokens: total(baselineRows),
    graphMemoryTokens: total(gmRows),
    changePercent: change(total(baselineRows), total(gmRows)),
  },
};

console.log(JSON.stringify(result, null, 2));
