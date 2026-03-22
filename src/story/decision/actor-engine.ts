import type { StoryCharacter } from "../types.ts";
import type { StoryAction } from "../runtime/model-client.ts";
import type { StoryBelief, StoryNarrativeSignal } from "../../store/store.ts";

type ScoredStoryAction = StoryAction & { score: number };

export interface ActorDecisionModel {
  rerankActorActions(actions: StoryAction[], context: ActorDecisionInput): Promise<StoryAction[]>;
}

export interface ActorDecisionInput {
  actor: StoryCharacter;
  beliefs: StoryBelief[];
  worldSignals: StoryNarrativeSignal[];
  model: ActorDecisionModel;
}

export async function rankActorActions(input: ActorDecisionInput): Promise<StoryAction[]> {
  const scored = buildCandidateActions(input)
    .map((action) => scoreAction(action, input))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const reranked = await input.model.rerankActorActions(scored, input);
  return reranked.slice(0, 2);
}

function buildCandidateActions(input: ActorDecisionInput): StoryAction[] {
  return [
    {
      id: `${input.actor.id}:seek-artifact`,
      type: "seek-artifact",
      summary: `${input.actor.name} pursues artifact clues tied to immediate opportunities.`,
    },
    {
      id: `${input.actor.id}:conceal-bloodline`,
      type: "conceal-bloodline",
      summary: `${input.actor.name} avoids exposure while preserving survival options.`,
    },
    {
      id: `${input.actor.id}:train-breakthrough`,
      type: "train-breakthrough",
      summary: `${input.actor.name} focuses on cultivation and internal preparation.`,
    },
  ];
}

function scoreAction(action: StoryAction, input: ActorDecisionInput): ScoredStoryAction {
  const desires = new Set(input.actor.coreDesires);
  const goals = new Set(input.actor.shortTermGoals);
  const beliefs = input.beliefs.filter((belief) => belief.actorId === input.actor.id && belief.actorKind === "character");
  const signals = input.worldSignals;
  const artifactBeliefWeight = beliefs
    .filter((belief) => belief.predicate.includes("ARTIFACT") || belief.subjectId.startsWith("a-"))
    .reduce((total, belief) => total + belief.confidence, 0);
  const realmOpeningWeight = signals
    .filter((signal) => signal.kind.includes("realm-opening"))
    .reduce((total, signal) => total + (signal.weight ?? 1), 0);
  const secretPressureWeight = signals
    .filter((signal) => signal.kind.includes("secret"))
    .reduce((total, signal) => total + (signal.weight ?? 1), 0);

  let score = 0;
  if (action.type === "seek-artifact") {
    if (desires.has("ascend")) score += 2;
    score += artifactBeliefWeight * 2;
    score += realmOpeningWeight * 1.5;
  } else if (action.type === "conceal-bloodline") {
    if (goals.has("hide-bloodline")) score += 2.5;
    if (desires.has("survive")) score += 1.5;
    score += secretPressureWeight;
  } else if (action.type === "train-breakthrough") {
    if (desires.has("ascend")) score += 1.5;
    if (desires.has("survive")) score += 0.5;
  }

  return { ...action, score };
}
