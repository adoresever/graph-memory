import type { StoryFaction } from "../types.ts";
import type {
  StoryAction,
  StoryModelClient,
  FactionDecisionInput as RuntimeFactionDecisionInput,
} from "../runtime/model-client.ts";
import type { StoryBelief, StoryNarrativeSignal } from "../../store/store.ts";

type ScoredStoryAction = StoryAction & { score: number };

export interface FactionEngineInput {
  faction: StoryFaction;
  beliefs: StoryBelief[];
  worldSignals: StoryNarrativeSignal[];
  model: Pick<StoryModelClient, "rerankFactionActions">;
}

export async function rankFactionActions(input: FactionEngineInput): Promise<StoryAction[]> {
  const scored = buildFactionCandidates(input)
    .map((action) => scoreFactionAction(action, input))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const reranked = await input.model.rerankFactionActions(scored, buildFactionRerankContext(input));
  return reranked.slice(0, 2);
}

function buildFactionCandidates(input: FactionEngineInput): StoryAction[] {
  return [
    {
      id: `${input.faction.id}:purge-rival-line`,
      type: "purge-rival-line",
      summary: `${input.faction.name} acts against lineage challengers before they consolidate.`,
    },
    {
      id: `${input.faction.id}:fortify-secret-realm`,
      type: "fortify-secret-realm",
      summary: `${input.faction.name} secures secret realm entry points and guardians.`,
    },
    {
      id: `${input.faction.id}:mediate-inheritance-dispute`,
      type: "mediate-inheritance-dispute",
      summary: `${input.faction.name} stabilizes internal factions to prevent open fracture.`,
    },
  ];
}

function scoreFactionAction(action: StoryAction, input: FactionEngineInput): ScoredStoryAction {
  const agenda = new Set(input.faction.agenda);
  const constraints = new Set(input.faction.constraints);
  const beliefs = input.beliefs.filter((belief) => belief.actorId === input.faction.id && belief.actorKind === "faction");
  const signals = input.worldSignals;
  const rivalLineageBeliefWeight = beliefs
    .filter((belief) => belief.predicate.includes("RIVAL_LINEAGE") || belief.predicate.includes("RIVAL"))
    .reduce((total, belief) => total + belief.confidence, 0);
  const inheritanceRumorWeight = signals
    .filter((signal) => signal.kind.includes("inheritance-rumor"))
    .reduce((total, signal) => total + (signal.weight ?? 1), 0);
  const realmPressureWeight = signals
    .filter((signal) => signal.kind.includes("realm"))
    .reduce((total, signal) => total + (signal.weight ?? 1), 0);

  let score = 0;
  if (action.type === "purge-rival-line") {
    if (agenda.has("preserve-orthodoxy")) score += 2;
    if (constraints.has("inheritance-dispute")) score += 1;
    score += rivalLineageBeliefWeight * 2;
    score += inheritanceRumorWeight * 2;
  } else if (action.type === "fortify-secret-realm") {
    if (agenda.has("control-secret-realm")) score += 2.5;
    score += realmPressureWeight;
  } else if (action.type === "mediate-inheritance-dispute") {
    if (constraints.has("inheritance-dispute")) score += 2;
    if (agenda.has("preserve-orthodoxy")) score += 1;
  }

  return { ...action, score };
}

function buildFactionRerankContext(input: FactionEngineInput): RuntimeFactionDecisionInput {
  const beliefHints = input.beliefs
    .filter((belief) => belief.actorId === input.faction.id && belief.actorKind === "faction")
    .map((belief) => `${belief.predicate}:${belief.objectId}`)
    .slice(0, 3)
    .join(", ");
  const stakes = [
    ...input.faction.agenda.slice(0, 2),
    ...input.faction.constraints.slice(0, 2),
    ...input.worldSignals.map((signal) => signal.kind).slice(0, 2),
  ];

  return {
    factionId: input.faction.id,
    prompt: `agenda=${input.faction.agenda.join("|")} constraints=${input.faction.constraints.join("|")} beliefs=${beliefHints}`,
    stakes,
  };
}
