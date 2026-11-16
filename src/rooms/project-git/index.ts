// Public API of project-git: the pure rules of the private Git bootstrap.
export { BASELINE_LIMITS, IGNORE_PATTERNS, SECRET_CONTENT_PATTERNS, isWithin, repoNameFor, sameRemote, scopeQuestion, verifyReadback } from "./logic";
export type { BootstrapRecord, BootstrapStage, GitProbe, GitProbeState, RepoReadback, ScopeChoice } from "./logic";
