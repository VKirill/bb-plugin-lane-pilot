import { z } from "zod";

const changedFile = z.object({ path:z.string(), status:z.string().min(1).max(2) }).strict();

/** Git worktrees, merges and the integration gates that run in a checkout on the host. */
export const gitHostMethods = {
  gitOwnershipBase: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), baseRef:z.string().min(1).max(240).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","invalid-ref","failed"]), branch:z.string().nullable(), headSha:z.string().nullable(), baseRef:z.string().nullable(), baseSha:z.string().nullable(), compareCommitted:z.boolean(), reason:z.string().nullable() }).strict(),
  },
  gitPrepareWorktree: {
    // ownsBarrier + the task contract: tracked files outside owns_paths become read-only for the attempt (additive; an older host ignores them and locks nothing).
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/"),
      ownsBarrier:z.boolean().optional(), ownsPaths:z.array(z.string().max(300)).max(200).optional(), neverTouch:z.array(z.string().max(300)).max(200).optional() }).strict(),
    output: z.object({ hostId:z.string(), linked:z.array(z.string()), locked:z.number().int().optional() }).strict(),
  },
  gitWorktreeSnapshot: {
    input: z.object({ requestedHostId:z.string().min(1), worktreePath:z.string().startsWith("/"), name:z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["clean","saved","missing","failed"]), path:z.string().nullable(), dirty:z.number().int(), ahead:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  gitRemoveWorktree: {
    // `release`: return the work first (save the uncommitted edits and unmerged commits as a patch) and keep the worktree when that fails (additive; an older host ignores it).
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/"), release:z.boolean().optional() }).strict(),
    output: z.object({ hostId:z.string(), removed:z.boolean(),
      saved:z.object({ status:z.enum(["clean","saved","missing","failed"]), path:z.string().nullable(), dirty:z.number().int(), ahead:z.number().int(), reason:z.string().nullable() }).strict().optional() }).strict(),
  },
  gitWorktreeState: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","missing","failed"]), head:z.string().nullable(), base:z.string().nullable(), dirty:z.number().int(), ahead:z.number().int(),
      changed:z.array(changedFile).max(5000), reason:z.string().nullable() }).strict(),
  },
  gitMergeInfo: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), commit:z.string().regex(/^[a-f0-9]{40,64}$/).optional(), attemptId:z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["found","missing","failed"]), commit:z.string().nullable(), base:z.string().nullable(), subject:z.string().nullable(),
      changed:z.array(changedFile).max(5000), inMain:z.boolean(), reason:z.string().nullable() }).strict(),
  },
  gitRevertCommits: {
    input: z.object({ requestedHostId:z.string().min(1), worktreePath:z.string().startsWith("/"), commits:z.array(z.string().regex(/^[a-f0-9]{40,64}$/)).min(1).max(20) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["reverted","conflict","empty","failed"]), commits:z.array(z.string()), conflicts:z.array(z.string()),
      later:z.array(z.object({ sha:z.string(), subject:z.string(), files:z.array(z.string()) }).strict()), reason:z.string().nullable() }).strict(),
  },
  worktreeJanitor: {
    // The hourly sweep over ~/.lane-pilot/worktrees: copies the hub no longer protects (no open attempt or pass), older than
    // grace, clean and fully merged go; a copy with edits or unique commits stays and is reported. Lane Pilot's own tmp prefixes too.
    input: z.object({ requestedHostId: z.string().min(1), protectedPaths: z.array(z.string().startsWith("/")).max(20000), graceMs: z.number().int().min(0).optional() }).strict(),
    output: z.object({ hostId: z.string(), removed: z.array(z.string()), freedBytes: z.number(),
      kept: z.array(z.object({ path: z.string(), reason: z.string(), ageMs: z.number(), bytes: z.number() }).strict()).max(500),
      tmpRemoved: z.array(z.string()).max(2000), tmpFreedBytes: z.number(), errors: z.array(z.string()).max(200) }).strict(),
  },
  gitSyncWorktree: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/"), keepConflicts:z.boolean().optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["synced","up-to-date","dirty","conflict","failed"]), head:z.string().nullable(), reason:z.string().nullable(), conflicts:z.array(z.string()).optional() }).strict(),
  },
  gitCreateWorktree: {
    // `commit`: start from it instead of HEAD; `taskId`: the task the branch belongs to; `baseSha` in the answer: the commit the worktree started from (additive; an older host ignores the first two and omits the third).
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), name:z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), commit:z.string().regex(/^[a-f0-9]{7,64}$/).optional(),
      taskId:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","failed"]), path:z.string().nullable(), branch:z.string().nullable(), reason:z.string().nullable(), baseSha:z.string().nullable().optional() }).strict(),
  },
  gitIntegrate: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/"), message:z.string().min(1).max(500), removeWorktree:z.boolean().optional(),
      committedOnly:z.boolean().optional(), bookkeeping:z.array(z.string().max(300)).max(100).optional(),
      // The task's owns_paths: a bookkeeping file it owns keeps the attempt's version in the merge (additive; an older host ignores it).
      ownsPaths:z.array(z.string().max(300)).max(200).optional(),
      // A phase candidate lands only when main, under the base lock, is already in it: the merge is then the verified tree (additive).
      baseInHead:z.boolean().optional(),
      // The worktree head the merge must find under the base lock (the verified candidate commit); another head refuses (additive).
      expectedHead:z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
      // The task's checks, run in the attempt's worktree when it was replayed on a moved main, before the merge (additive).
      replayChecks:z.object({ workspacePath:z.string().startsWith("/"), backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),
        commands:z.array(z.object({ command:z.string().min(1).max(32_000), cwd:z.string().startsWith("/"), timeoutSec:z.number().int().min(1).max(7200).optional() }).strict()).min(1).max(20) }).strict().optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["merged","up-to-date","conflict","failed","busy"]), commit:z.string().nullable(), conflicts:z.array(z.string()), reason:z.string().nullable(), holder:z.string().nullable().optional(), rebased:z.boolean().optional(),
      checks:z.array(z.object({ command:z.string(), exitCode:z.number().int(), stdout:z.string(), stderr:z.string() }).strict()).optional(),
      rebuilt:z.array(z.object({ dir:z.string(), ok:z.boolean(), detail:z.string().nullable() }).strict()).optional(),
      // With «merged»: main before the merge and what the merge changed there, deletions included (additive; an older host omits them).
      base:z.string().nullable().optional(), changed:z.array(changedFile).max(5000).optional() }).strict(),
  },
  gitRevertPaths: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), paths:z.array(z.string().min(1)).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), reverted:z.array(z.string()), failed:z.array(z.string()) }).strict(),
  },
  gitUndoCheckWrites: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), keep:z.array(z.string().max(1000)).max(20_000),
      ownsPaths:z.array(z.string().max(300)).max(200), neverTouch:z.array(z.string().max(300)).max(200), bookkeeping:z.array(z.string().max(300)).max(100).optional() }).strict(),
    output: z.object({ hostId:z.string(), reverted:z.array(z.string()), failed:z.array(z.string()) }).strict(),
  },
  gitOwnershipChanges: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), baseSha:z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), compareCommitted:z.boolean(), unfiltered:z.boolean().optional(), bookkeeping:z.array(z.string().max(300)).max(100).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), headSha:z.string().nullable(), paths:z.array(z.string()), reason:z.string().nullable() }).strict(),
  },
  // (2026-10-29) runCli (lane-ctl / run-controller) is gone. The integration gate runs on the project's host.
  gateRun: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), command:z.string().min(1).max(32_000), timeoutSec:z.number().int().min(1).max(7200) }).strict(),
    output: z.object({ hostId:z.string(), exitCode:z.number().int(), stdout:z.string(), stderr:z.string(), head:z.string().nullable() }).strict(),
  },
  gateBisect: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), command:z.string().min(1).max(32_000),
      goodSha:z.string().regex(/^[a-f0-9]{7,64}$/), badSha:z.string().regex(/^[a-f0-9]{7,64}$/), timeoutSec:z.number().int().min(1).max(7200) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["found", "none", "failed"]), commit:z.string().nullable(), reason:z.string().nullable() }).strict(),
  },
  // Which merged commit can have broken which failing test: changed paths per commit, the workspace of each failing test, and a
  // run of the failing test files on the base the batch started from (failing there too = pre-existing, nobody's to blame).
  gateAttribute: {
    input: z.object({
      requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), baseSha:z.string().regex(/^[a-f0-9]{7,64}(\^1)?$/).nullable(),
      commits:z.array(z.string().regex(/^[a-f0-9]{7,64}$/)).max(200),
      failing:z.array(z.object({ file:z.string().min(1).max(500), workspacePackage:z.string().max(200).nullable() }).strict()).max(300),
      timeoutSec:z.number().int().min(1).max(7200),
    }).strict(),
    output: z.object({
      hostId:z.string(),
      commits:z.record(z.string(), z.object({ paths:z.array(z.string()), workspaces:z.array(z.string()) }).strict()),
      failing:z.array(z.object({ workspaceDir:z.string().nullable(), path:z.string().nullable(), preexisting:z.boolean().nullable() }).strict()),
      baseline:z.object({ status:z.enum(["ran", "skipped", "failed"]), reason:z.string().nullable() }).strict(),
    }).strict(),
  },
};
