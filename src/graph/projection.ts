import type { Session } from "neo4j-driver";
import { EDGE_TYPES } from "../types.ts";

/** 知识边类型白名单（事实源 types.ts 的 EDGE_TYPES，勿另维护字面量副本） */
const KNOWLEDGE_REL_TYPES: readonly string[] = [...EDGE_TYPES];

export async function getExistingActiveRelTypes(session: Session): Promise<string[]> {
  const result = await session.run(`
    MATCH (:MemoryNode {status: 'active'})-[r]->(:MemoryNode {status: 'active'})
    WHERE type(r) IN $types
    RETURN DISTINCT type(r) AS type
  `, { types: KNOWLEDGE_REL_TYPES });
  return result.records.map(record => record.get("type"));
}

export async function projectActiveGraph(
  session: Session,
  graphName: string,
  relationshipTypes: readonly string[],
): Promise<void> {
  await session.run(`
    MATCH (source:MemoryNode {status: 'active'})
    OPTIONAL MATCH (source)-[relationship]->(target:MemoryNode {status: 'active'})
    WHERE relationship IS NULL OR type(relationship) IN $relationshipTypes
    WITH gds.graph.project(
      $graphName,
      source,
      target,
      {},
      { undirectedRelationshipTypes: ['*'] }
    ) AS graph
    RETURN graph.graphName AS graphName
  `, { graphName, relationshipTypes });
}
