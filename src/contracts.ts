import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const prototypeConfigSchema = z.object({
  projectId: z.string().min(1),
  hostId: z.string().min(1),
  pmWorkspacePath: z.string().startsWith("/"),
  writerWorkspacePath: z.string().startsWith("/"),
  pmProviderId: z.string().min(1),
  pmModel: z.string().min(1),
  writerProviderId: z.string().min(1),
  writerModel: z.string().min(1),
}).strict();

export type PrototypeConfig = z.infer<typeof prototypeConfigSchema>;

export const taskV2Schema = z.object({
  schema_version: z.literal(2),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  title: z.string().min(1),
  risk: z.enum(["low", "medium", "high", "critical"]),
  lane: z.string().min(1),
  project_cwd: z.string().startsWith("/"),
  read_first: z.array(z.string().min(1)),
  interfaces: z.array(z.string().min(1)),
  invariants: z.array(z.string().min(1)),
  out_of_scope: z.array(z.string().min(1)),
  expected_outputs: z.array(z.string().min(1)).min(1),
  owns_paths: z.array(z.string().min(1)).min(1),
  never_touch: z.array(z.string().min(1)),
  depends_on: z.array(z.string().min(1)),
  objective: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  verify: z.enum(["none", "smoke", "tests"]),
  verification: z.array(z.object({
    command: z.string().min(1),
    cwd: z.string().startsWith("/"),
    timeout_sec: z.number().int().min(1).max(7200).optional(),
  }).strict()),
}).strict();

export type TaskV2 = z.infer<typeof taskV2Schema>;

const hostBaseFields = {
  requestedHostId: z.string().min(1),
  workspacePath: z.string().startsWith("/").optional(),
  threadStoragePath: z.string().startsWith("/").optional(),
  receiptDir: z.string().startsWith("/").optional(),
  confirmExternalOps: z.boolean().optional(),
  localFallbackPath: z.string().startsWith("/").optional(),
  guardSourcePath: z.string().startsWith("/").optional(),
  pmWorkspacePath: z.string().startsWith("/").optional(),
  projectId: z.string().min(1).optional(),
  snapshotPath: z.string().startsWith("/").optional(),
};

const hostBaseInput = z.object(hostBaseFields).strict();

const fileChangeSchema = z.object({
  path: z.string(),
  sha256Before: z.string().nullable(),
  sha256After: z.string().nullable(),
}).strict();

export const installReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.string(),
  scenario: z.string().nullable(),
  status: z.enum(["ok", "failed", "rolled_back"]).optional(),
  filesChanged: z.array(fileChangeSchema),
  externalOpsBefore: z.record(z.string(), z.string().nullable()),
  externalOpsAfter: z.record(z.string(), z.string().nullable()),
  skippedExternalOps: z.array(z.string()),
  warning: z.string().nullable(),
  exitCode: z.number().int(),
  receiptPath: z.string().nullable(),
  snapshotPath: z.string().nullable(),
  sourceSha: z.string().nullable(),
  notes: z.array(z.string()),
}).strict();

export const hostContract = defineRpcContract({
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
});

export const rpcContract = defineRpcContract({
  activate_pm: {
    input: z.object({ projectId: z.string().min(1), sourceThreadId: z.string().nullable() }).strict(),
    output: z.object({ threadId: z.string().min(1), runId: z.string().min(1) }).strict(),
  },
  get_screen: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      projectId: z.string(),
      hostId: z.string().nullable(),
      workspacePath: z.string().nullable(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number()),
      importSource: z.object({
        completed: z.boolean(),
        at: z.number().nullable(),
        routingPath: z.string().nullable(),
        nightPath: z.string().nullable(),
      }).strict(),
      runs: z.array(z.object({
        id: z.string(),
        state: z.string(),
        kind: z.string(),
        created_at: z.number(),
        updated_at: z.number(),
        cliReceiptJson: z.string().nullable(),
        attempts: z.array(z.object({
          id: z.string(),
          state: z.string(),
          attempt_no: z.number(),
          thread_id: z.string().nullable(),
          reason: z.string().nullable(),
          task_id: z.string(),
          cliReceiptJson: z.string().nullable(),
        }).strict()),
      }).strict()),
      unapplied: z.array(z.object({ key: z.string(), reason: z.string() }).strict()),
      lastSnapshotPath: z.string().nullable(),
      lastReceiptJson: z.string().nullable(),
      writerResultJson: z.string().nullable(),
      writerResultPatch: z.string().nullable(),
      cliReceiptJson: z.string().nullable(),
    }).strict(),
  },
  save_setting: {
    input: z.object({
      projectId: z.string().min(1),
      key: z.string().min(1),
      value: z.unknown(),
      expectedVersion: z.number().int().min(0),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      version: z.number().int(),
      value: z.unknown(),
      validation: z.object({
        code: z.enum(["invalid_choice", "incompatible_setting"]),
        key: z.string(),
        params: z.array(z.string()),
      }).strict().optional(),
    }).strict(),
  },
  cancel_attempt: {
    input: z.object({ attemptId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), state: z.string(), reason: z.string().nullable() }).strict(),
  },
  retry_attempt: {
    input: z.object({ attemptId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), state: z.string(), attemptId: z.string(), reason: z.string().nullable() }).strict(),
  },
  resume_runs: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      resumed: z.array(z.string()),
      skipped: z.array(z.string()),
      finished: z.array(z.string()),
    }).strict(),
  },
  stack_detect: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.unknown(),
  },
  stack_install: {
    input: z.object({ projectId: z.string().min(1), confirmExternalOps: z.boolean() }).strict(),
    output: z.unknown(),
  },
  stack_connect: {
    input: z.object({ projectId: z.string().min(1), confirmExternalOps: z.boolean() }).strict(),
    output: z.unknown(),
  },
  stack_rollback: {
    input: z.object({ projectId: z.string().min(1), snapshotPath: z.string().min(1) }).strict(),
    output: z.unknown(),
  },
});
