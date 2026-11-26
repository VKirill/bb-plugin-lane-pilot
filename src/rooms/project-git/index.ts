// Public API of project-git: the pure rules of the private Git bootstrap.
export { BASELINE_LIMITS, IGNORE_PATTERNS, isWithin, namesOperation, pythonSecretSources, repoDescription, repoNameFor, sameRemote, scopeQuestion, verifyReadback } from "./models/bootstrap";
export type { BootstrapRecord, BootstrapStage, GitProbe, GitProbeState, RepoReadback, SavedScope, ScopeChoice } from "./models/bootstrap";
