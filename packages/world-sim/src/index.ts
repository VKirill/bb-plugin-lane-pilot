// Public API of @lane-pilot/world-sim: the rules of the Pixel World. Pure TypeScript, no I/O.
export { applyLanePilotSignal, SIGNAL_RULES } from "./binding";
export { STAGE_MATERIAL, STAGE_WORK, targetForPercent } from "./construction";
export { generateMap } from "./map";
export { hashString, nextRandom } from "./rng";
export { DEFAULT_SCENARIOS, listScenarios, parseScenario, registerScenario } from "./scenarios";
export { dayOf, hourOf, positionAt } from "./sim";
export { catchUp, cloneState, createWorld, parseWorld, serializeWorld, snapshot, step } from "./world";
export type { WorldOptions, WorldSnapshot } from "./world";
export * from "./types";
