#!/usr/bin/env python3
"""Consistent online backup of graph-memory.db via sqlite3 backup() API.
Merges WAL into a single clean file — safe even while OpenClaw is running."""
import sqlite3, os, time, shutil

src = os.path.expanduser("~/.openclaw/graph-memory.db")
ts = time.strftime("%Y%m%d-%H%M%S")
dst = os.path.expanduser(f"~/graph-memory.db.bak-{ts}")

src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
dst_conn = sqlite3.connect(dst)
src_conn.backup(dst_conn)   # consistent snapshot, WAL merged
dst_conn.close()
src_conn.close()

sz = os.path.getsize(dst)
print(f"BACKUP_OK: {dst} ({sz/1024/1024:.1f} MB)")

# sanity: verify the backup opens + has the tables
v = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
for t in ["gm_nodes", "gm_edges", "gm_communities", "gm_messages", "gm_vectors"]:
    c = v.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    print(f"  {t}: {c}")
v.close()
