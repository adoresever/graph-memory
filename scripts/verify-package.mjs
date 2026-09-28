import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const installLifecycles = ["preinstall", "install", "postinstall", "prepare"];

for (const lifecycle of installLifecycles) {
  if (manifest.scripts?.[lifecycle]) {
    throw new Error(`package must not execute ${lifecycle} on a user's machine`);
  }
}

for (const dependency of Object.keys(manifest.dependencies ?? {})) {
  const dependencyManifest = JSON.parse(
    readFileSync(new URL(`../node_modules/${dependency}/package.json`, import.meta.url), "utf8"),
  );
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (dependencyManifest.scripts?.[lifecycle]) {
      throw new Error(`runtime dependency ${dependency} executes ${lifecycle} during install`);
    }
  }
}

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
const [report] = JSON.parse(output);
const packedFiles = new Set(report.files.map((entry) => entry.path));
for (const required of [
  "dist/index.js",
  "dist/dsh.js",
  "dist/src/store/sqlite.js",
  "index.ts",
  "dsh.ts",
  "tsconfig.json",
  "tsconfig.dsh.json",
]) {
  if (!packedFiles.has(required)) {
    throw new Error(`packed artifact is missing ${required}`);
  }
}

const generatedChanges = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", "dist"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
).trim();
if (generatedChanges) {
  throw new Error(`committed dist is stale:\n${generatedChanges}`);
}

process.stdout.write(`verified ${report.files.length} packed files with no install-time scripts\n`);
