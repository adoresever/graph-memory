import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { StoryModelClient } from "../runtime/model-client.ts";
import type { StoryThread } from "../types.ts";

type StoryEntityRecord = {
  id: string;
  kind: string;
  name: string;
  payload: unknown;
};

type StoryRelationRecord = {
  id: string;
  fromId: string;
  relation: string;
  toId: string;
  visibility: string;
  intensity: number;
};

type StoryNarrativeSignalRecord = {
  id: string;
  kind: string;
  subjectId: string;
  relatedId?: string;
  weight: number;
  status: string;
  payloadJson: string;
};

type StoryChapterRecord = {
  id: string;
  claimsJson: string;
};

export interface StoryWorldSnapshot {
  entities: StoryEntityRecord[];
  relations: StoryRelationRecord[];
  activeThreads: StoryThread[];
  narrativeSignals: StoryNarrativeSignalRecord[];
}

export interface StoryClaim {
  subjectId: string;
  predicate: "OWNS" | "LOCATED_IN" | "ALLY_OF" | "ENEMY_OF" | "INJURED" | "DEAD";
  objectId?: string;
  valueText?: string;
  evidenceSpan: string;
}

export async function extractChapterClaims(
  model: StoryModelClient,
  prose: string,
): Promise<StoryClaim[]> {
  const claims = await model.extractClaims(prose);
  return claims
    .filter((claim): claim is StoryClaim => isStoryClaim(claim))
    .map((claim) => ({
      subjectId: claim.subjectId,
      predicate: claim.predicate,
      objectId: claim.objectId,
      valueText: claim.valueText,
      evidenceSpan: claim.evidenceSpan,
    }));
}

export function buildStoryWorldSnapshot(db: DatabaseSyncInstance): StoryWorldSnapshot {
  return {
    entities: listAllStoryEntities(db),
    relations: listAllStoryRelations(db),
    activeThreads: listTrackedThreads(db),
    narrativeSignals: listAllNarrativeSignals(db),
  };
}

export function validateChapterClaims(world: StoryWorldSnapshot, claims: StoryClaim[]) {
  return claims.filter((claim) => contradictsWorld(world, claim));
}

export function validateRecentChapters(db: DatabaseSyncInstance) {
  const world = buildStoryWorldSnapshot(db);
  const chapters = listRecentStoryChapters(db, 5);
  return chapters.flatMap((chapter) =>
    validateChapterClaims(world, parseClaimsJson(chapter.claimsJson))
  );
}

function contradictsWorld(world: StoryWorldSnapshot, claim: StoryClaim): boolean {
  const relationPredicates = new Set<StoryClaim["predicate"]>([
    "OWNS",
    "LOCATED_IN",
    "ALLY_OF",
    "ENEMY_OF",
  ]);
  if (!relationPredicates.has(claim.predicate) || !claim.objectId) {
    return false;
  }

  const known = world.relations.filter((relation) =>
    relation.fromId === claim.subjectId && relation.relation === claim.predicate
  );
  if (known.length === 0) {
    return false;
  }
  return known.every((relation) => relation.toId !== claim.objectId);
}

function listAllStoryEntities(db: DatabaseSyncInstance): StoryEntityRecord[] {
  const rows = db.prepare(`
    SELECT id, kind, name, payload
    FROM story_entities
    WHERE status = 'active'
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ id: string; kind: string; name: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    payload: parseJsonUnknown(row.payload),
  }));
}

function listAllStoryRelations(db: DatabaseSyncInstance): StoryRelationRecord[] {
  const rows = db.prepare(`
    SELECT id, from_id, relation, to_id, visibility, intensity
    FROM story_relations
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{
    id: string;
    from_id: string;
    relation: string;
    to_id: string;
    visibility: string;
    intensity: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    fromId: row.from_id,
    relation: row.relation,
    toId: row.to_id,
    visibility: row.visibility,
    intensity: row.intensity,
  }));
}

function listTrackedThreads(db: DatabaseSyncInstance): StoryThread[] {
  const rows = db.prepare(`
    SELECT payload
    FROM story_entities
    WHERE kind = 'thread' AND status = 'active'
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ payload: string }>;
  return rows.flatMap((row) => {
    const parsed = parseJsonUnknown(row.payload);
    if (
      parsed
      && typeof parsed === "object"
      && typeof (parsed as Partial<StoryThread>).id === "string"
      && typeof (parsed as Partial<StoryThread>).name === "string"
      && typeof (parsed as Partial<StoryThread>).status === "string"
    ) {
      return [parsed as StoryThread];
    }
    return [];
  });
}

function listAllNarrativeSignals(db: DatabaseSyncInstance): StoryNarrativeSignalRecord[] {
  const rows = db.prepare(`
    SELECT id, kind, subject_id, related_id, weight, status, payload_json
    FROM story_narrative_signals
    WHERE status = 'active'
    ORDER BY updated_at DESC, id ASC
  `).all() as Array<{
    id: string;
    kind: string;
    subject_id: string;
    related_id: string | null;
    weight: number;
    status: string;
    payload_json: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    relatedId: row.related_id ?? undefined,
    weight: row.weight,
    status: row.status,
    payloadJson: row.payload_json,
  }));
}

function listRecentStoryChapters(db: DatabaseSyncInstance, limit: number): StoryChapterRecord[] {
  const rows = db.prepare(`
    SELECT id, claims_json
    FROM story_chapters
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<{ id: string; claims_json: string }>;
  return rows.map((row) => ({
    id: row.id,
    claimsJson: row.claims_json,
  }));
}

function parseClaimsJson(rawClaims: string): StoryClaim[] {
  const parsed = parseJsonUnknown(rawClaims);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is StoryClaim => isStoryClaim(item));
}

function isStoryClaim(value: unknown): value is StoryClaim {
  const validPredicates = new Set<StoryClaim["predicate"]>([
    "OWNS",
    "LOCATED_IN",
    "ALLY_OF",
    "ENEMY_OF",
    "INJURED",
    "DEAD",
  ]);
  return Boolean(
    value
      && typeof value === "object"
      && typeof (value as StoryClaim).subjectId === "string"
      && typeof (value as StoryClaim).predicate === "string"
      && validPredicates.has((value as StoryClaim).predicate)
      && typeof (value as StoryClaim).evidenceSpan === "string",
  );
}

function parseJsonUnknown(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
