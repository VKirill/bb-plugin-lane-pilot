/**
 * Which model a generic workflow agent step runs on: the function moved to packages/models (agent-model.ts) so that every wrapper that
 * spawns a model thread (memory, docs, QA, errand, repair, council...) asks the same one (core/server/spawn-model.ts). Re-exported here
 * for the callers that always imported it from the workflow room.
 */
export {
  AUTHOR_ROWS, AUTHOR_ROW_IDS, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_REASONING, ROLE_LEAST_TIER, pmAuthorOf, resolveAgentModel,
} from "@lane-pilot/models";
export type { AgentModel, AgentModelInput, AgentModelSource } from "@lane-pilot/models";
