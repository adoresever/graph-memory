/**
 * graph-memory — SQLite 连接回归测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";

describe("openDb", () => {
  it("configures a busy timeout on every connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-db-"));
    const db = openDb(join(dir, "graph-memory.db"));
    try {
      const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      expect(Number(row.timeout)).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("waits for a write lock held by another process instead of throwing database is locked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-db-"));
    const dbPath = join(dir, "graph-memory.db");
    const db = openDb(dbPath);

    // Child process mirrors a second host connection (e.g. another DSH
    // process sharing the same database file): it takes the write lock, holds
    // it briefly, then commits. Its event loop is its own, so it can release
    // the lock while this process' busy handler is waiting. The script lives
    // in the project root so require("@photostructure/sqlite") resolves.
    const childScript = `
      const { DatabaseSync } = require("@photostructure/sqlite");
      const file = process.argv[2];
      const db = new DatabaseSync(file);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      console.log("LOCKED");
      setTimeout(() => {
        try { db.exec("COMMIT"); } catch (e) { console.error("child commit failed:", String(e)); process.exit(1); }
        db.close();
      }, 500);
    `;
    const scriptPath = join(process.cwd(), ".gm-lock-holder.cjs");
    writeFileSync(scriptPath, childScript);

    try {
      const child = spawn(process.execPath, [scriptPath, dbPath], { stdio: ["ignore", "pipe", "pipe"] });
      const locked = new Promise<void>((resolve, reject) => {
        let settled = false;
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("LOCKED") && !settled) {
            settled = true;
            resolve();
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (!settled && code !== 0) reject(new Error(`child exited early with code ${code}`));
        });
      });

      await locked;

      // This write collides with the child's open transaction. Without a busy
      // timeout it fails instantly with SQLITE_BUSY; with one it blocks until
      // the child commits (~500ms) and then succeeds.
      const t0 = Date.now();
      db.prepare(`
        INSERT INTO gm_nodes (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at)
        VALUES (?, 'SKILL', ?, ?, ?, 'active', 1, '[]', ?, ?)
      `).run("n-busy-timeout", "busy-timeout-node", "desc", "content", Date.now(), Date.now());
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeGreaterThanOrEqual(300);
    } finally {
      db.close();
      rmSync(scriptPath, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
