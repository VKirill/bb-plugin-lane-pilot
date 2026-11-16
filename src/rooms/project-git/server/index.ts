// Public API of project-git on the server: the bootstrap handler a task preflight calls.
export { createProjectGit } from "./bootstrap";
export type { BootstrapResult, EnsureResult, ProjectGit, ProjectGitDeps, ScopeInput, ScopeResult } from "./bootstrap";
export { createProjectGitDispatch, overlappingLiveRuns } from "./dispatch-guard";
export type { FolderPool, ProjectGitDispatch, ProjectGitDispatchArgs } from "./dispatch-guard";
