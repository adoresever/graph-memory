import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import {
  listActiveThreadsForEvents,
  listEventsForPov,
  listNarrativeSignals,
  listRelationshipsForPov,
} from "../../store/store.ts";

export function buildRecallPacket(db: DatabaseSyncInstance, params: {
  povId: string;
  eventIds: string[];
}) {
  return {
    relatedEvents: listEventsForPov(db, params.povId, params.eventIds),
    relationships: listRelationshipsForPov(db, params.povId),
    threads: listActiveThreadsForEvents(db, params.povId, params.eventIds),
    unresolvedSecrets: listNarrativeSignals(db, "secret", params.povId),
    activeTensions: listNarrativeSignals(db, "tension", params.povId),
    payoffCandidates: listNarrativeSignals(db, "payoff-candidate", params.povId),
  };
}
