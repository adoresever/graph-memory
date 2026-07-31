#!/usr/bin/env python3
"""
graph-memory v1.x (SQLite) → v2.0 (Neo4j) 迁移脚本

读取 SQLite 备份快照，写入 Neo4j：
  gm_nodes      → (:MemoryNode:Task|Skill|Event)        180 行
  gm_edges      → APOC 类型化关系                         118 行
  gm_communities→ (:Community)                            72 行
  gm_vectors    → n.embedding (Float32 BLOB → float[])   173 行
  gm_messages   → (:GmMessage)            [可选, --messages]  25308 行

用法:
  python3 migrate.py <snapshot.db> <neo4j-uri> <user> <password> [--messages] [--reset]
  python3 migrate.py ~/graph-memory.db.bak-xxx bolt://localhost:7687 neo4j graphmemory
  python3 migrate.py snapshot.db bolt://localhost:7687 neo4j pw --reset   # 先清空旧数据

幂等：用 MERGE，可重复运行。
"""
import sys, os, json, struct, sqlite3
from neo4j import GraphDatabase

NODE_TYPE_TO_LABEL = {"TASK": "Task", "SKILL": "Skill", "EVENT": "Event"}
BATCH = 500


def read_table(conn, table):
    conn.row_factory = sqlite3.Row
    return conn.execute(f'SELECT * FROM "{table}"').fetchall()


def init_schema(session):
    """与 src/store/db.ts initSchema 一致的约束 + 向量索引。"""
    for label in ["Task", "Skill", "Event"]:
        ln = label.lower()
        session.run(f"CREATE CONSTRAINT {ln}_id IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE")
        session.run(f"CREATE CONSTRAINT {ln}_name IF NOT EXISTS FOR (n:{label}) REQUIRE n.name IS UNIQUE")
        session.run(f"CREATE INDEX {ln}_status IF NOT EXISTS FOR (n:{label}) ON (n.status)")
        session.run(f"CREATE INDEX {ln}_community IF NOT EXISTS FOR (n:{label}) ON (n.communityId)")
    session.run("CREATE CONSTRAINT community_id IF NOT EXISTS FOR (c:Community) REQUIRE c.id IS UNIQUE")
    session.run("CREATE CONSTRAINT gm_msg_id IF NOT EXISTS FOR (m:GmMessage) REQUIRE m.id IS UNIQUE")
    session.run("CREATE INDEX gm_msg_session IF NOT EXISTS FOR (m:GmMessage) ON (m.sessionId, m.turnIndex)")
    session.run("MATCH (n:Task|Skill|Event) SET n:MemoryNode")
    session.run("""
      CREATE VECTOR INDEX gm_node_embedding IF NOT EXISTS
      FOR (n:MemoryNode) ON (n.embedding)
      OPTIONS {indexConfig: {`vector.dimensions`: 1024, `vector.similarity_function`: 'cosine'}}
    """)
    session.run("""
      CREATE VECTOR INDEX gm_community_embedding IF NOT EXISTS
      FOR (c:Community) ON (c.embedding)
      OPTIONS {indexConfig: {`vector.dimensions`: 1024, `vector.similarity_function`: 'cosine'}}
    """)


def reset(session):
    """清空旧的图谱数据（迁移前用，确保干净）。"""
    session.run("MATCH (n:MemoryNode) DETACH DELETE n")
    session.run("MATCH (c:Community) DELETE c")
    session.run("MATCH (m:GmMessage) DELETE m")


def migrate_nodes(session, rows):
    done = 0
    for r in rows:
        label = NODE_TYPE_TO_LABEL.get(r["type"], "Skill")
        try:
            sessions = json.loads(r["source_sessions"]) if r["source_sessions"] else []
        except (json.JSONDecodeError, TypeError):
            sessions = []
        session.run(f"""
            MERGE (n:MemoryNode:{label} {{id: $id}})
            SET n.type = $type, n.name = $name, n.description = $description,
                n.content = $content, n.status = $status,
                n.validatedCount = $validatedCount, n.sourceSessions = $sessions,
                n.communityId = $communityId, n.pagerank = $pagerank,
                n.createdAt = $createdAt, n.updatedAt = $updatedAt
        """, {
            "id": r["id"], "type": r["type"], "name": r["name"],
            "description": r["description"], "content": r["content"],
            "status": r["status"], "validatedCount": r["validated_count"],
            "sessions": sessions, "communityId": r["community_id"],
            "pagerank": r["pagerank"], "createdAt": r["created_at"], "updatedAt": r["updated_at"],
        })
        done += 1
    return done


def migrate_edges(session, rows):
    done = skipped = 0
    for r in rows:
        # 两个端点都必须已存在（节点迁移后）
        result = session.run("""
            MATCH (from:MemoryNode {id: $fromId}), (to:MemoryNode {id: $toId})
            CALL apoc.create.relationship(from, $type, {
                id: $id, instruction: $instruction, condition: $condition,
                sessionId: $sessionId, createdAt: $createdAt
            }, to) YIELD rel
            RETURN count(rel) AS c
        """, {
            "fromId": r["from_id"], "toId": r["to_id"], "type": r["type"],
            "id": r["id"], "instruction": r["instruction"], "condition": r["condition"],
            "sessionId": r["session_id"], "createdAt": r["created_at"],
        }).single()
        if result and result["c"] > 0:
            done += 1
        else:
            skipped += 1
    return done, skipped


def decode_embedding(blob):
    if not blob:
        return None
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


def migrate_communities(session, rows):
    done = 0
    for r in rows:
        session.run("""
            MERGE (c:Community {id: $id})
            SET c.summary = $summary, c.nodeCount = $nodeCount,
                c.createdAt = $createdAt, c.updatedAt = $updatedAt
        """, {
            "id": r["id"], "summary": r["summary"], "nodeCount": r["node_count"],
            "createdAt": r["created_at"], "updatedAt": r["updated_at"],
        })
        done += 1
    return done


def migrate_vectors(session, rows):
    done = skipped = 0
    for r in rows:
        vec = decode_embedding(r["embedding"])
        if vec is None:
            skipped += 1
            continue
        result = session.run(
            "MATCH (n:MemoryNode {id: $id}) SET n.embedding = $vec RETURN count(n) AS c",
            {"id": r["node_id"], "vec": vec},
        ).single()
        if result and result["c"] > 0:
            done += 1
        else:
            skipped += 1
    return done, skipped


def migrate_messages(session, conn, total):
    done = 0
    conn.row_factory = sqlite3.Row
    # 流式分批读取，避免 25k 行一次性加载
    cursor = conn.execute("SELECT * FROM gm_messages")
    batch = []
    while True:
        rows = cursor.fetchmany(BATCH)
        if not rows:
            break
        payload = []
        for r in rows:
            payload.append({
                "id": r["id"], "sessionId": r["session_id"], "turnIndex": r["turn_index"],
                "role": r["role"], "content": r["content"], "extracted": bool(r["extracted"]),
                "createdAt": r["created_at"],
            })
        session.run("""
            UNWIND $rows AS row
            MERGE (m:GmMessage {id: row.id})
            SET m.sessionId = row.sessionId, m.turnIndex = row.turnIndex,
                m.role = row.role, m.content = row.content,
                m.extracted = row.extracted, m.createdAt = row.createdAt
        """, {"rows": payload})
        done += len(payload)
    return done


def verify(session):
    checks = {
        "nodes(Task|Skill|Event)": "MATCH (n:Task|Skill|Event) RETURN count(n)",
        "MemoryNode": "MATCH (n:MemoryNode) RETURN count(n)",
        "edges": "MATCH ()-[r]->() WHERE type(r) IN ['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH'] RETURN count(r)",
        "Community": "MATCH (c:Community) RETURN count(c)",
        "nodes w/ embedding": "MATCH (n:MemoryNode) WHERE n.embedding IS NOT NULL RETURN count(n)",
    }
    return {k: session.run(q).single()[0] for k, q in checks.items()}


def main():
    args = sys.argv[1:]
    do_messages = "--messages" in args
    do_reset = "--reset" in args
    args = [a for a in args if not a.startswith("--")]
    if len(args) < 4:
        print(__doc__); sys.exit(1)

    sqlite_path, uri, user, password = args[0], args[1], args[2], args[3]
    print(f"SQLite: {sqlite_path}")
    print(f"Neo4j:  {uri} (user={user})")
    print(f"Options: messages={do_messages} reset={do_reset}")

    sql = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    driver = GraphDatabase.driver(uri, auth=(user, password))

    with driver.session() as s:
        print("\n[1/7] init schema (constraints + vector indexes)...")
        init_schema(s)

        if do_reset:
            print("[2/7] reset (clearing existing graph data)...")
            reset(s)
        else:
            print("[2/7] skip reset")

        nodes = read_table(sql, "gm_nodes")
        print(f"[3/7] migrate {len(nodes)} nodes...")
        n = migrate_nodes(s, nodes)
        print(f"      -> {n} nodes merged")

        edges = read_table(sql, "gm_edges")
        print(f"[4/7] migrate {len(edges)} edges (APOC)...")
        done, skipped = migrate_edges(s, edges)
        print(f"      -> {done} edges created, {skipped} skipped (missing endpoint)")

        comms = read_table(sql, "gm_communities")
        print(f"[5/7] migrate {len(comms)} communities...")
        nc = migrate_communities(s, comms)
        print(f"      -> {nc} communities merged")

        vecs = read_table(sql, "gm_vectors")
        print(f"[6/7] migrate {len(vecs)} vectors (Float32 decode)...")
        vd, vs = migrate_vectors(s, vecs)
        print(f"      -> {vd} embeddings set, {vs} skipped")

        if do_messages:
            total = sql.execute("SELECT COUNT(*) FROM gm_messages").fetchone()[0]
            print(f"[7/7] migrate {total} messages (optional)...")
            nm = migrate_messages(s, sql, total)
            print(f"      -> {nm} messages merged")
        else:
            print("[7/7] skip messages (use --messages to include)")

        print("\n=== verification ===")
        for k, v in verify(s).items():
            print(f"  {k}: {v}")

    driver.close()
    sql.close()
    print("\nMIGRATION_DONE")


if __name__ == "__main__":
    main()
