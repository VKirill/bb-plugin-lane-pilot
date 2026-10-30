// Public API of bench/server: what other rooms import. Everything else in this room is private.
export { BENCH_USAGE, runBenchCli } from "../cli";
export { benchRpc } from "./rpc";
export { createPluginBench } from "./plugin-ports";
export type { BenchApi } from "../service";
// The accepted tasks a bench set is drawn from, and the commit that merged one: read by the checker scorecard (src/rooms/checkers).
export { loadCandidates } from "../candidates";
export { findSolutionCommit } from "../warmup";
export type { Candidate } from "../types";
export type { HostPort } from "../ports";
export { mountBenchNightly, mountBenchSweep, mountBenchWeekly, weekArm } from "./weekly";
export { mountServiceModelRecheck } from "./service-pin";
// The wall (src/rooms/wall) shows the bench arm of a version and starts the night one.
export { benchArmStatus } from "../reliability";
export { nightArm, prepareCheckoutCommand } from "../runner";
export { isLiveProject, liveStability, renderLiveStability } from "../live-rate";
export { DEFAULT_VALIDATOR, judgeValidator } from "../validator";
export type { LiveAttempt, LiveStability } from "../live-rate";
