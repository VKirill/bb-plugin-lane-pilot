// Public API of project-git on the server: the bootstrap handler a task preflight calls.
export { createProjectGit } from "./services/bootstrap";
export type { BootstrapResult, EnsureResult, ProjectGit, ProjectGitDeps, ScopeInput, ScopeResult } from "./services/bootstrap";
export { createProjectGitDispatch } from "./services/dispatch-guard";
export type { FolderPool, ProjectGitDispatch, ProjectGitDispatchArgs } from "./services/dispatch-guard";
export { overlappingLiveRuns } from "./repositories/live-runs-repository";
export { getBootstrapRecord, type Kv } from "./repositories/bootstrap-repository";
export { room } from "./room";
