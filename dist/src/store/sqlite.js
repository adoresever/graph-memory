/**
 * SQLite runtime boundary shared by every Graph Memory host.
 *
 * DSH and OpenClaw both require modern Node.js releases, so using Node's
 * built-in SQLite implementation keeps the storage API host-neutral and
 * avoids executing third-party native build scripts during plugin install.
 */
import { createRequire } from "node:module";
// Vitest 1/Vite 5 predates node:sqlite and does not recognize it as a built-in
// module. Loading it through Node's own resolver keeps this boundary usable by
// both production ESM and the existing test toolchain without an alias shim.
const sqlite = createRequire(import.meta.url)("node:sqlite");
export const DatabaseSync = sqlite.DatabaseSync;
