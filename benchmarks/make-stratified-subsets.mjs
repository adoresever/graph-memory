#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function evenlySpaced(items, count) {
  if (count >= items.length) return [...items];
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * items.length / count)]);
}

function grouped(items, key) {
  const result = new Map();
  for (const item of items) {
    const value = key(item);
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(item);
  }
  return result;
}

const [locomoInput, longmemInput, locomoOutput, longmemOutput] = process.argv.slice(2);
if (!longmemOutput) {
  throw new Error("usage: make-stratified-subsets.mjs LOCOMO LONGMEM LOCOMO_OUT LONGMEM_OUT");
}

const locomo = JSON.parse(readFileSync(locomoInput, "utf8"));
const locomoFlat = locomo.flatMap((sample) => sample.qa.map((qa) => ({ sample_id: sample.sample_id, qa })));
const locomoSelected = new Set(
  [...grouped(locomoFlat, (entry) => String(entry.qa.category)).values()]
    .flatMap((entries) => evenlySpaced(entries, 20)),
);
const locomoSubset = locomo.map((sample) => ({
  ...sample,
  qa: sample.qa.filter((qa) => [...locomoSelected].some((entry) => entry.sample_id === sample.sample_id && entry.qa === qa)),
}));
writeFileSync(locomoOutput, `${JSON.stringify(locomoSubset)}\n`);

const longmem = JSON.parse(readFileSync(longmemInput, "utf8"));
const answerable = longmem.filter((item) => !item.question_id.endsWith("_abs"));
const groups = grouped(answerable, (item) => item.question_type);
const targets = new Map();
let allocated = 0;
for (const [key, entries] of groups) {
  const count = Math.floor(entries.length / answerable.length * 100);
  targets.set(key, count);
  allocated += count;
}
for (const [key] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  if (allocated >= 100) break;
  targets.set(key, targets.get(key) + 1);
  allocated += 1;
}
const longmemSubset = [...groups].flatMap(([key, entries]) => evenlySpaced(entries, targets.get(key)));
writeFileSync(longmemOutput, `${JSON.stringify(longmemSubset)}\n`);

console.log(JSON.stringify({
  locomo: Object.fromEntries([...grouped(locomoSubset.flatMap((sample) => sample.qa), (qa) => qa.category)].map(([key, entries]) => [key, entries.length])),
  longmemeval: Object.fromEntries([...grouped(longmemSubset, (item) => item.question_type)].map(([key, entries]) => [key, entries.length])),
}, null, 2));
