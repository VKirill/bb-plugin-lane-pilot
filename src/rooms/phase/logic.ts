/**
 * The phase on rails (SMA map: Phase graph, Phase control work, Phase controls). Matvey Maslov, 2026-10-22: «the driver is the model in the
 * harness, the rails are code; it cannot go where there are no rails», «above the orchestrator there is a machine that drives the route and
 * at the turns switches on the orchestrator». This file is that route: the stages, the gates each stage must pass in code, the returns
 * the graph allows, the acceptance lines and the one next action the driver asks of the PM. No I/O here: server/driver.ts feeds it facts.
 * Split into the modules under ./logic/; this door re-exports every name as before.
 */

export * from "./logic/record";
export * from "./logic/observation";
export * from "./logic/signatures";
export * from "./logic/gates";
export * from "./logic/words";
export * from "./logic/words-policy";
export * from "./logic/design";
export * from "./logic/waves";
export * from "./logic/verdict";
export * from "./logic/acceptance";
export * from "./logic/next-action";
export * from "./logic/returns";
export * from "./logic/book";
