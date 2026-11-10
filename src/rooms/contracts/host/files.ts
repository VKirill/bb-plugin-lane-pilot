import { z } from "zod";

/** Reads and compare-and-swap writes into the project's own folders on the host. */
export const fileHostMethods = {
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
  /** The file names in each folder (sorted, at most 500 per folder), for the contract lint's tests next to owned code; a folder that is not there has none. */
  listFolders: {
    input: z.object({ requestedHostId:z.string().min(1), paths:z.array(z.string().startsWith("/")).max(64) }).strict(),
    output: z.object({ hostId:z.string(), entries:z.array(z.object({ path:z.string(), names:z.array(z.string()), truncated:z.boolean() }).strict()) }).strict(),
  },
  /** The phase book and the phase's documents, written only under the project's `.agents/phases/<phase-id>/`, and the marks in `.agents/planning/STATE.md` / `ROADMAP.md` (src/rooms/phase). */
  writePhaseBook: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), previewSha256:z.string().regex(/^[a-f0-9]{64}$/), planningDir:z.string().min(1).max(120).optional(),
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
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), id:z.string().regex(/^[a-z0-9][a-z0-9.-]{0,47}$/),
      content:z.string().min(2).max(400_000), expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict(),
    output:z.object({hostId:z.string(), status:z.enum(["applied","conflict"]), path:z.string(), beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(), afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(), reason:z.string().nullable()}).strict(),
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
};
