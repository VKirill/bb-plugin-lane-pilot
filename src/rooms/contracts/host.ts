import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { anamnesisHostMethods } from "../anamnesis";
import { HOST_JOB_KINDS, HOST_JOB_MAX_SEC, coexistenceInventory, coexistenceManager, coexistenceOperation, coexistenceOperationResult, hostBaseFields, hostBaseInput, hostJobId, hostJobRef, installReceiptSchema, secretNameSchema } from "@lane-pilot/contracts";

const changedFile = z.object({ path:z.string(), status:z.string().min(1).max(2) }).strict();

export const hostContract = defineRpcContract({
  nativeInstall: {
    input: z.object({ requestedHostId: z.string().min(1), action: z.enum(["install", "enable", "disable", "remove", "status"]) }).strict(),
    output: z.object({ status: z.enum(["absent", "prepared", "enabled", "disabled"]), sourceSha: z.string().nullable(), ownedFiles: z.number(), preservedFiles: z.number() }).strict(),
  },
  gitOwnershipBase: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), baseRef:z.string().min(1).max(240).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","invalid-ref","failed"]), branch:z.string().nullable(), headSha:z.string().nullable(), baseRef:z.string().nullable(), baseSha:z.string().nullable(), compareCommitted:z.boolean(), reason:z.string().nullable() }).strict(),
  },
  gitPrepareWorktree: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), linked:z.array(z.string()) }).strict(),
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
  gitSyncWorktree: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/"), keepConflicts:z.boolean().optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["synced","up-to-date","dirty","conflict","failed"]), head:z.string().nullable(), reason:z.string().nullable(), conflicts:z.array(z.string()).optional() }).strict(),
  },
  jobStart: {
    // `key`: one logical job; a second start with the same key returns the first job (additive; an older host ignores it).
    input: z.object({ requestedHostId:z.string().min(1), kind:z.enum(HOST_JOB_KINDS), input:z.record(z.string(), z.unknown()), timeoutSec:z.number().int().min(10).max(HOST_JOB_MAX_SEC), key:z.string().min(1).max(200).optional() }).strict(),
    output: z.object({ hostId:z.string(), jobId:hostJobId }).strict(),
  },
  jobStatus: {
    input: hostJobRef,
    output: z.object({
      hostId:z.string(), jobId:hostJobId, state:z.enum(["running", "succeeded", "failed", "cancelled", "lost"]),
      progress:z.object({ startedAt:z.number(), updatedAt:z.number(), elapsedSec:z.number().int().nonnegative(), lastLine:z.string() }).strict(),
      result:z.unknown().optional(), error:z.string().nullable(),
    }).strict(),
  },
  jobCancel: {
    input: hostJobRef,
    output: z.object({ hostId:z.string(), jobId:hostJobId, cancelled:z.boolean() }).strict(),
  },
  stabilityDrill: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), checks:z.array(z.object({ name:z.string(), ok:z.boolean(), detail:z.string().nullable() }).strict()) }).strict(),
  },
  ...anamnesisHostMethods,
  diskFree: {
    // `machine`: also answer with the host's load, CPU count and memory, for the reading taken before a check (additive; an older host rejects the flag, and the caller then has no reading).
    input: z.object({ requestedHostId:z.string().min(1), path:z.string().startsWith("/"), machine:z.boolean().optional() }).strict(),
    output: z.object({ hostId:z.string(), path:z.string(), freeBytes:z.number().nonnegative(), totalBytes:z.number().nonnegative(),
      machine:z.object({ load1:z.number().nonnegative().nullable(), cpuCount:z.number().int().positive().nullable(), memFreeBytes:z.number().nonnegative().nullable(), memTotalBytes:z.number().nonnegative().nullable() }).strict().optional() }).strict(),
  },
  gitCreateWorktree: {
    // `commit`: start from it instead of HEAD; `baseSha` in the answer: the commit the worktree started from (both additive; an older host ignores the first and omits the second).
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), name:z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), commit:z.string().regex(/^[a-f0-9]{7,64}$/).optional() }).strict(),
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
  gitDocsScope: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), sinceEpochMs:z.number().int().nonnegative(), base:z.string().min(1).max(200).optional(),
      docsDir:z.string().min(1).max(240).regex(/^(?!\/)(?!.*\.\.)[^\0]+$/).optional(), exclude:z.array(z.string().min(1).max(240)).max(50).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), isRepoRoot:z.boolean(), hasDocs:z.boolean(), changed:z.array(z.string()), dirty:z.array(z.string()), base:z.string().nullable(),
      workspaces:z.array(z.object({ path:z.string(), name:z.string(), codeFiles:z.number().int() })), localDate:z.string(), localHour:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  docsWorthinessFacts: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), trackedFiles:z.number().int(), codeFiles:z.number().int(), testFiles:z.number().int(),
      contentFiles:z.number().int(), languages:z.array(z.object({ ext:z.string(), files:z.number().int() })), commits30d:z.number().int(), manifests:z.array(z.string()),
      deploy:z.boolean(), docsPages:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  docsAnchors: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), title:z.string() })).max(500),
      prefix:z.string().max(240).optional(), exclude:z.array(z.string()).max(500).optional(),
      workspaces:z.array(z.object({ path:z.string(), name:z.string(), docsDir:z.string().nullable() })).max(500).optional() }).strict(),
    output: z.object({ hostId:z.string(), briefPath:z.string(), anchors:z.number().int(), jev:z.enum(["ok","partial","disabled"]), productFiles:z.array(z.string()),
      core:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })), tables:z.array(z.string()), deploy:z.boolean() }).strict(),
  },
  docsFlows: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), workspaces:z.array(z.object({ path:z.string(), name:z.string() })).max(500),
      keep:z.array(z.string()).max(200).optional() }).strict(),
    output: z.object({ hostId:z.string(), briefPath:z.string(), jev:z.enum(["ok","partial","disabled"]), routes:z.number().int(),
      flows:z.array(z.object({ name:z.string(), slug:z.string(), entries:z.number().int(), modules:z.array(z.string()), briefPath:z.string(), files:z.array(z.string()),
        calls:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })) })) }).strict(),
  },
  docsDepth: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500),
      core:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), findings:z.array(z.object({ path:z.string(), rule:z.string(), detail:z.string() })) }).strict(),
  },
  docsVerifyCitations: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500),
      related:z.array(z.object({ path:z.string(), content:z.string() })).max(500).optional() }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), checked:z.number().int(), findings:z.array(z.object({ path:z.string(), rule:z.string(), detail:z.string() })),
      pageStats:z.array(z.object({ path:z.string(), checked:z.number().int(), supported:z.number().int(), partial:z.number().int() })) }).strict(),
  },
  docsStaleness: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), base:z.string().min(1), changed:z.array(z.string()).max(5000), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500) }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), refresh:z.array(z.string()), reasons:z.array(z.object({ path:z.string(), section:z.string(), p:z.number() })) }).strict(),
  },
  docsLineCounts: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), files:z.array(z.string()).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), counts:z.record(z.string(), z.number().int().nullable()) }).strict(),
  },
  gitCommitDocs: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), paths:z.array(z.string()).max(2000), message:z.string().min(1).max(500) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["committed","nothing","failed"]), commit:z.string().nullable(), reason:z.string().nullable() }).strict(),
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
  openCodeLimitProbe: {
    input: z.object({ requestedHostId:z.string().min(1), sessionId:z.string().regex(/^ses_[A-Za-z0-9]{1,80}$/), sinceMs:z.number().int().nonnegative() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["limit","none"]), providerId:z.string().nullable(), model:z.string().nullable(), resetAt:z.number().nullable(), reason:z.string().nullable() }).strict(),
  },
  readOpenCodeTelemetry: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), relativePath:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), relativePath:z.string(), size:z.number().int().nonnegative().max(262144), sha256:z.string().regex(/^[a-f0-9]{64}$/), content:z.string().max(262144) }).strict(),
  },
  readBoundedFile: {
    input: z.object({
      requestedHostId: z.string().min(1),
      projectCwd: z.string().startsWith("/"),
      relativePath: z.string().min(1).max(1024),
      offset: z.number().int().min(0).max(100000),
      maxLines: z.number().int().min(1).max(2000),
    }).strict(),
    output: z.object({
      schemaVersion: z.literal(1),
      hostId: z.string().min(1),
      path: z.string().min(1),
      content: z.string().max(262144),
      contentEncoding: z.literal("utf8"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
      totalLines: z.number().int().nonnegative(),
      offset: z.number().int().min(0),
      maxLines: z.number().int().min(1),
      lineStart: z.number().int().min(1),
      lineEnd: z.number().int().min(0),
      truncated: z.boolean(),
      returnedBytes: z.number().int().nonnegative().max(262144),
    }).strict(),
  },
  listDocsPages: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"),
      roots:z.array(z.string().min(1).max(240).regex(/^(?!\/)(?!.*\.\.)[^\0]+$/)).max(500).optional(), skipOversized:z.boolean().optional() }).strict(),
    output: z.object({hostId:z.string(), oversized:z.array(z.string()).optional(), pages:z.array(z.object({path:z.string(),modifiedAt:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),content:z.string()}).strict())}).strict(),
  },
  listWorkflowFiles: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), files:z.array(z.object({ path:z.string(), content:z.string() }).strict()) }).strict(),
  },
  applyOnboardingPages: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), confirmed:z.literal(true),
      previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(8_000)}).strict()).min(1).max(8),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
  },
  writeDocsPages: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(40_000)}).strict()).min(1).max(100),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
  },
  /** SMA «Permit channel»: the permit tickets writers filed on this machine (~/.agents/permits/<session>/<ticket>.ticket.json) and not yet answered. */
  listPermitTickets: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), tickets:z.array(z.object({ session:z.string(), ticket:z.string(), category:z.string(), command:z.string(), cwd:z.string(), at:z.number() }).strict()) }).strict(),
  },
  /** SMA «Approve or deny the call»: the PM's answer to a permit ticket, written next to it; a grant is used once by the same command. */
  answerPermit: {
    input: z.object({ requestedHostId:z.string().min(1), session:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), ticket:z.string().regex(/^[a-f0-9]{16}$/), decision:z.enum(["allow","deny"]), why:z.string().max(600) }).strict(),
    output: z.object({ hostId:z.string(), written:z.boolean() }).strict(),
  },
  /** SMA «Five hours and seven days»: the subscription windows this machine's statusline last read (~/.agents/statusline/last_usage.json). */
  readUsageWindows: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), at:z.string().nullable(), windows:z.record(z.string(), z.object({ utilization:z.number(), resetsAt:z.string().nullable() }).strict()) }).strict(),
  },
  /** SMA «Close exactly that line»: sets `status: done` in `.agents/todos/items/<id>/meta.yaml`, only when the file has exactly one status line. */
  closeBacklogItem: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/), note:z.string().max(300).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["closed","already","refused"]), reason:z.string().nullable() }).strict(),
  },
  /** SMA «Is the check command runnable»: which of the named programs the machine finds on PATH (with the user's tool bins). */
  whichPrograms: {
    input: z.object({ requestedHostId:z.string().min(1), cwd:z.string().startsWith("/"), programs:z.array(z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/)).max(40) }).strict(),
    output: z.object({ hostId:z.string(), found:z.record(z.string(), z.boolean()) }).strict(),
  },
  /** The file names in each folder (sorted, at most 500 per folder), for the contract lint's tests next to owned code; a folder that is not there has none. */
  listFolders: {
    input: z.object({ requestedHostId:z.string().min(1), paths:z.array(z.string().startsWith("/")).max(64) }).strict(),
    output: z.object({ hostId:z.string(), entries:z.array(z.object({ path:z.string(), names:z.array(z.string()), truncated:z.boolean() }).strict()) }).strict(),
  },
  /** The phase book and the phase's documents, written only under the project's `.agents/phases/<phase-id>/`, and the marks in `.agents/planning/STATE.md` / `ROADMAP.md` (src/rooms/phase). */
  writePhaseBook: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(400_000)}).strict()).min(1).max(10),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
  },
  /** A forge draft from the project's own helpers: written only under `.agents/forge/<kind>s/<name>/`, never over one that exists (src/rooms/front). */
  writeForgeDraft: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(60_000)}).strict()).min(1).max(1),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
  },
  /** An enabled forge draft: a skill or a role written only to the project's `.claude/skills/<name>/SKILL.md` or `.claude/agents/<name>.md` (src/rooms/forge). */
  writeForgeEnabled: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(60_000)}).strict()).min(1).max(1),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
  },
  /** The Workflow architect publishes a chain into `<project>/.lane-pilot/workflows/<id>.json`; the write is compare-and-swap on the file's hash. */
  writeWorkflowFile: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), id:z.string().regex(/^[a-z][a-z0-9.-]{0,47}$/),
      content:z.string().min(2).max(400_000), expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict(),
    output:z.object({hostId:z.string(), status:z.enum(["applied","conflict"]), path:z.string(), beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(), afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(), reason:z.string().nullable()}).strict(),
  },
  coexistenceInventory: {
    input: z.object({ requestedHostId: z.string().min(1), projectId: z.string().min(1), targetSha: z.string().optional() }).strict(),
    output: coexistenceInventory,
  },
  coexistenceOperation: {
    input: z.object({
      requestedHostId: z.string().min(1), projectId: z.string().min(1), operation: coexistenceOperation,
      manager: coexistenceManager, path: z.string().startsWith("/"), expectedSha256: z.string().nullable().optional(),
      snapshotId: z.string().nullable().optional(), targetSha: z.string().nullable().optional(), confirmExternalOps: z.literal(false).optional(),
    }).strict(),
    output: coexistenceOperationResult,
  },
  detect: {
    input: z.object({ ...hostBaseFields, workspacePath: z.string().startsWith("/") }).strict(),
    output: z.object({
      hostId: z.string(),
      laneStack: z.object({ present: z.boolean(), version: z.string().nullable(), sourceSha: z.string().nullable() }),
      openCode: z.object({ present: z.boolean(), version: z.string().nullable() }),
      workspace: z.object({ path: z.string(), present: z.boolean() }),
      targetSha: z.string(),
      matchesTarget: z.boolean(),
      scenario: z.enum(["S1", "S2", "S3"]),
    }).strict(),
  },
  snapshotDryRun: {
    input: z.object({ requestedHostId: z.string().min(1), paths: z.array(z.string().startsWith("/")).max(128) }).strict(),
    output: z.object({
      hostId: z.string(),
      entries: z.array(z.object({
        path: z.string(),
        kind: z.enum(["missing", "file", "directory", "symlink", "other"]),
        sha256: z.string().nullable(),
        symlinkTarget: z.string().nullable(),
        /** What a symlink points at once followed (stat); absent from an older host. */
        targetKind: z.enum(["missing", "file", "directory", "other"]).optional(),
      }).strict()),
    }).strict(),
  },
  snapshot: {
    input: hostBaseInput,
    output: installReceiptSchema,
  },
  install: {
    input: z.object({
      ...hostBaseFields,
      installSettings: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
    output: installReceiptSchema,
  },
  rollback: {
    input: z.object({ ...hostBaseFields, snapshotPath: z.string().startsWith("/") }).strict(),
    output: installReceiptSchema,
  },
  importConfig: {
    input: hostBaseInput,
    output: installReceiptSchema.extend({
      imported: z.object({
        routingProfile: z.object({ path: z.string(), text: z.string(), sha256: z.string() }).nullable(),
        nightShift: z.object({ path: z.string(), text: z.string(), sha256: z.string() }).nullable(),
      }).strict(),
    }).strict(),
  },
  connectOpencode: {
    input: hostBaseInput,
    output: installReceiptSchema,
  },
  runCli: {
    input: z.object({
      requestedHostId: z.string().min(1),
      binary: z.enum(["run-controller", "lane-ctl"]),
      argv: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      cwd: z.string().startsWith("/"),
      timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(),
      binaryPath: z.string(),
      argv: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      cwd: z.string(),
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
    }).strict(),
  },
  // The integration gate runs on the project's host (a project on another machine has no path on the hub): both are job kinds.
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
  // A scheduled script (schedule board): runs as a host job so a reload of the hub loses the poll, not the script.
  runScript: {
    input: z.object({
      requestedHostId: z.string().min(1),
      command: z.string().min(1).max(32_000),
      cwd: z.string().startsWith("/"),
      timeoutSec: z.number().int().min(1).max(10_800),
      /** Env Catalog values for this run (by variable name): in its environment only, masked in the output. */
      env: z.record(secretNameSchema, z.string().max(65_536)).optional(),
      maxOutputBytes: z.number().int().min(1024).max(512 * 1024).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string(),
      truncated: z.boolean(), timedOut: z.boolean(), durationMs: z.number().int().nonnegative(),
    }).strict(),
  },
  runCommand: {
    input: z.object({
      requestedHostId: z.string().min(1),
      command: z.string().min(1),
      cwd: z.string().startsWith("/"),
      timeoutSec: z.number().int().min(1).max(7200).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(),
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
    }).strict(),
  },
  // One goal in the owner's own Chrome on the browser machine through jev-ultrafast (the computer-use runner).
  browserGoal: {
    input: z.object({
      requestedHostId: z.string().min(1),
      url: z.string().url(),
      goal: z.string().min(1).max(2000),
      timeoutSec: z.number().int().min(10).max(600).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(), exitCode: z.number().int(), status: z.string(), url: z.string().nullable(), actions: z.number().int().nullable(),
      // The visible text of the page it reached (jev keeps up to 6000 characters); null from an older launcher.
      title: z.string().nullable(), text: z.string().nullable(),
      log: z.string(),
    }).strict(),
  },
  runSandboxedCommand: {
    input:z.object({
      requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),cwd:z.string().startsWith("/"),
      backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),
      command:z.string().min(1).max(32_000),timeoutSec:z.number().int().min(1).max(7200).optional(),
      /** Secret values for this one command (Env Catalog, J2): they go into the sandbox's environment only, and the host masks them in the output. */
      env:z.record(secretNameSchema,z.string().max(65_536)).optional(),
      /** The strict worker: run as this OS user (worker.strict_user on). */
      asUser:z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
    }).strict(),
    output:z.object({
      hostId:z.string(),backend:z.enum(["macos-seatbelt","linux-bubblewrap"]),workspacePath:z.string(),cwd:z.string(),
      exitCode:z.number().int(),policySha256:z.string().regex(/^[a-f0-9]{64}$/),stdout:z.string(),stderr:z.string(),
    }).strict(),
  },
  sandboxCommandLine: {
    input:z.object({
      requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),cwd:z.string().startsWith("/"),
      backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),command:z.string().min(1).max(32_000),
      passEnv:z.array(z.string().max(128)).max(500).optional(),
    }).strict(),
    output:z.object({
      hostId:z.string(),backend:z.enum(["macos-seatbelt","linux-bubblewrap"]),workspacePath:z.string(),cwd:z.string(),
      policySha256:z.string().regex(/^[a-f0-9]{64}$/),commandLine:z.string(),
      cleanup:z.object({tempPath:z.string(),created:z.array(z.string())}).strict(),
    }).strict(),
  },
  sandboxRelease: {
    input:z.object({requestedHostId:z.string().min(1),tempPath:z.string().startsWith("/"),created:z.array(z.string())}).strict(),
    output:z.object({hostId:z.string(),released:z.boolean()}).strict(),
  },
  runBrowserQa: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), url:z.string().url(),
      slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
      envClass:z.enum(["local","staging","preview","production","unknown"]), viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/),
      authorized:z.boolean(), provider:z.enum(["jev","codex"]), model:z.string().max(120).optional(),
      reasoningEffort:z.enum(["low","medium","high","xhigh","max"]).optional(),
      backend:z.enum(["live-chrome","chrome-qa","headless"]), timeoutSec:z.number().int().min(30).max(1800),
    }).strict(),
    output:z.object({
      hostId:z.string(), provider:z.enum(["jev","codex"]), runner:z.string(), exitCode:z.number().int(),
      verdict:z.enum(["passed","failed","blocked"]), reportPath:z.string().nullable(), reportSha256:z.string().nullable(),
      actualModel:z.string().nullable(),actualReasoningEffort:z.string().nullable(),actualBackend:z.string().nullable(),
      reportText:z.string().nullable(), artifacts:z.array(z.object({path:z.string(),sha256:z.string(),size:z.number().int().nonnegative()}).strict()),
      stdout:z.string(), stderr:z.string(), reason:z.string().nullable(),
      processPid:z.number().int().nullable(), runnerPath:z.string().nullable(),
    }).strict(),
  },
  vpnAddress: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), address:z.string().nullable(), interface:z.string().nullable() }).strict(),
  },
  probeBrowserQaTarget: {
    input: z.object({
      requestedHostId:z.string().min(1), workspacePath:z.string().startsWith("/"), url:z.string().url(),
    }).strict(),
    output:z.object({
      hostId:z.string(), workspaceRealPath:z.string(), url:z.string(), processHostId:z.string(),
    }).strict(),
  },
  classifyPlan: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), plan:z.string().min(1) }).strict(),
    output: z.object({
      hostId:z.string(), status:z.enum(["ok","disabled","timeout","error"]),
      effort:z.string().nullable(), reason:z.string().nullable(), planSha256:z.string(), sentPlanSha256:z.string().nullable(),
      sourceLength:z.number().int().nonnegative(), sentLength:z.number().int().nonnegative().nullable(),
    }).strict(),
  },
  councilJudge: {
    input: z.object({
      requestedHostId: z.string().min(1),
      jevApiKey: z.string().max(4096).optional(), jevProvider: z.enum(["openlux", "typesafe"]).optional(),
      /** The wait for System One's answer before the call counts as a timeout; the handler's own 4 s (plus the provider's pad) when absent. */
      timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      state: z.string().min(1).max(60_000),
      questions: z.record(z.string().min(1).max(40), z.object({
        instructions: z.string().min(1).max(2000),
        criteria: z.record(z.string().min(1).max(40), z.string().min(1).max(500)),
      }).strict()).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8, "1 to 8 questions"),
    }).strict(),
    output: z.object({
      hostId: z.string(), status: z.enum(["ok", "disabled", "timeout", "error"]),
      answers: z.record(z.string(), z.string()), confidence: z.record(z.string(), z.number()).optional(),
      // Per question, the probability of each criterion; `confidence` is not the probability of the chosen answer.
      probabilities: z.record(z.string(), z.record(z.string(), z.number())).optional(), reason: z.string().nullable(),
    }).strict(),
  },
  inspectCritiqueCoverage: {
    input:z.object({requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),plan:z.string().max(100_000),
      tasks:z.array(z.object({id:z.string().max(128),lane:z.string().max(64),ownsPaths:z.array(z.string()).max(128),hasVerification:z.boolean(),
        verification:z.array(z.object({command:z.string().max(4096),timeoutSec:z.number().int().nonnegative().max(7200).optional()}).strict()).max(32)}).strict()).max(64)}).strict(),
    output:z.object({hostId:z.string(),status:z.enum(["complete","truncated"]),pathCount:z.number().int().nonnegative(),
      findings:z.array(z.object({code:z.enum(["plan_path_unowned","owns_gap","coverage_scan_truncated","owns_overlap","verify_missing","verify_heavy","owns_empty","plan_missing","no_tasks","caller_unowned","task_placeholder","output_unowned","output_binary","verify_filter_ignored","depends_cycle","depends_self"]),path:z.string(),
        severity:z.enum(["error","warning","info"]),finding:z.string()}).strict()).max(10)}).strict(),
  },
  writePmSettings: {
    input: z.object({
      requestedHostId: z.string().min(1),
      pmWorkspacePath: z.string().startsWith("/"),
    }).strict(),
    output: z.object({
      hostId: z.string(),
      settingsPath: z.string(),
      guardPath: z.string(),
    }).strict(),
  },
  session_inventory: {
    input: z.object({ cwd: z.string().nullable() }).strict(),
    output: z.object({
      mcpServers: z.array(z.object({ name: z.string(), sources: z.array(z.enum(["claude", "codex", "opencode"])) }).strict()),
      nativePlugins: z.array(z.object({ name: z.string(), sources: z.array(z.enum(["claude", "codex", "opencode"])) }).strict()),
    }).strict(),
  },
  discoverClaudeAgents: {
    input: z.object({ cwd: z.string().startsWith("/") }).strict(),
    output: z.object({
      agents: z.array(z.object({ id: z.string(), source: z.string() }).strict()),
      version: z.string(),
      sessionAgents: z.boolean(),
      pluginDir: z.boolean(),
      supported: z.boolean(),
    }).strict(),
  },
  /** The directory of guard wrappers (bb, ssh, scp, sftp) for Codex, OpenCode and Cursor helpers (see src/bb-shim.ts) and the PATH that puts it first. */
  /** A fresh codex home per task (worker.strict_user on): ~/.lane-pilot/codex-homes/<key>/ seeded with the machine's codex config and login. */
  prepareWorkerHome: {
    input: z.object({ requestedHostId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }).strict(),
    output: z.object({ codexHome: z.string(), seeded: z.array(z.string()) }).strict(),
  },
  prepareBbShim: {
    input: z.object({ requestedHostId: z.string().min(1) }).strict(),
    output: z.object({ dir: z.string(), path: z.string() }).strict(),
  },
  prepareNativeClaude: {
    input: z.object({
      cwd: z.string().startsWith("/").optional(),
      agentId: z.string().min(1).max(200),
      agentsJson: z.string().max(200_000).nullable(),
    }).strict(),
    output: z.object({
      env: z.array(z.object({ name: z.string(), value: z.string(), reason: z.string() }).strict()),
      agentId: z.string(),
      claudePath: z.string(),
      sessionAgents: z.boolean(),
    }).strict(),
  },
});
