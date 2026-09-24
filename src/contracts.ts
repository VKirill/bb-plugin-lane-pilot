import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { stageReceiptSchema } from "./stages/contract";

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

const coexistenceManager = z.enum(["agents-marker", "managed-checkout", "claude-cache", "claude-settings", "opencode-config", "opencode-plugin"]);
const coexistenceOperation = z.enum(["install", "connect", "update", "reload", "disconnect", "rollback"]);
const coexistenceEvidence = z.object({
  kind: z.string(), path: z.string().nullable(), sha256: z.string().nullable(), detail: z.string(),
}).strict();
const coexistenceManagerState = z.object({
  manager: coexistenceManager, path: z.string(), installed: z.boolean(), configured: z.boolean(),
  loaded: z.boolean().nullable(), compatible: z.boolean().nullable(), modified: z.boolean().nullable(),
  version: z.string().nullable(), sourceSha: z.string().nullable(), sha256: z.string().nullable(),
  owner: z.enum(["lane-pilot", "user", "upstream", "unknown"]),
  decision: z.enum(["reuse", "install", "upgrade", "conflict", "skip", "disconnect-owned"]),
  capabilities: z.array(z.string()), missingCapabilities: z.array(z.string()), evidence: z.array(coexistenceEvidence),
}).strict();
const coexistenceInventory = z.object({
  schemaVersion: z.literal(1), hostId: z.string(), targetSha: z.string(), managers: z.array(coexistenceManagerState),
}).strict();
const coexistenceOperationResult = z.object({
  schemaVersion: z.literal(1), hostId: z.string(), operation: coexistenceOperation, manager: coexistenceManager,
  path: z.string(), status: z.enum(["ok", "conflict", "blocked", "failed", "skipped", "rolled_back"]),
  beforeSha256: z.string().nullable(), afterSha256: z.string().nullable(), snapshotId: z.string().nullable(),
  owner: z.enum(["lane-pilot", "user", "upstream", "unknown"]), evidence: z.array(coexistenceEvidence), reason: z.string().nullable(),
}).strict();

export const hostContract = defineRpcContract({
  gitOwnershipBase: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), baseRef:z.string().min(1).max(240).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","invalid-ref","failed"]), branch:z.string().nullable(), headSha:z.string().nullable(), baseRef:z.string().nullable(), baseSha:z.string().nullable(), compareCommitted:z.boolean(), reason:z.string().nullable() }).strict(),
  },
  gitOwnershipChanges: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), baseSha:z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), compareCommitted:z.boolean() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), headSha:z.string().nullable(), paths:z.array(z.string()), reason:z.string().nullable() }).strict(),
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
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/") }).strict(),
    output: z.object({hostId:z.string(), pages:z.array(z.object({path:z.string(),modifiedAt:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),content:z.string()}).strict())}).strict(),
  },
  applyOnboardingPages: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), confirmed:z.literal(true),
      previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(8_000)}).strict()).min(1).max(8),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
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
  runSandboxedCommand: {
    input:z.object({
      requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),cwd:z.string().startsWith("/"),
      backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),
      command:z.string().min(1).max(32_000),timeoutSec:z.number().int().min(1).max(7200).optional(),
    }).strict(),
    output:z.object({
      hostId:z.string(),backend:z.enum(["macos-seatbelt","linux-bubblewrap"]),workspacePath:z.string(),cwd:z.string(),
      exitCode:z.number().int(),policySha256:z.string().regex(/^[a-f0-9]{64}$/),stdout:z.string(),stderr:z.string(),
    }).strict(),
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
    }).strict(),
  },
  classifyPlan: {
    input: z.object({ requestedHostId:z.string().min(1), plan:z.string().min(1) }).strict(),
    output: z.object({
      hostId:z.string(), status:z.enum(["ok","disabled","timeout","error"]),
      effort:z.string().nullable(), reason:z.string().nullable(), planSha256:z.string(), sentPlanSha256:z.string().nullable(),
      sourceLength:z.number().int().nonnegative(), sentLength:z.number().int().nonnegative().nullable(),
    }).strict(),
  },
  inspectCritiqueCoverage: {
    input:z.object({requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),plan:z.string().max(100_000),
      tasks:z.array(z.object({id:z.string().max(128),lane:z.string().max(64),ownsPaths:z.array(z.string()).max(128),hasVerification:z.boolean(),
        verification:z.array(z.object({command:z.string().max(4096),timeoutSec:z.number().int().nonnegative().max(7200).optional()}).strict()).max(32)}).strict()).max(64)}).strict(),
    output:z.object({hostId:z.string(),status:z.enum(["complete","truncated"]),pathCount:z.number().int().nonnegative(),
      findings:z.array(z.object({code:z.enum(["plan_path_unowned","owns_gap","coverage_scan_truncated","owns_overlap","verify_missing","verify_heavy","owns_empty","plan_missing","no_tasks","caller_unowned","task_placeholder"]),path:z.string(),
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
});

export const rpcContract = defineRpcContract({
  get_preferences: {
    input: z.object({ suggestedLocale: z.enum(["en", "ru"]) }).strict(),
    output: z.object({ locale: z.enum(["en", "ru"]), preference: z.enum(["auto", "en", "ru"]), lastProjectId: z.string().nullable() }).strict(),
  },
  set_locale: {
    input: z.object({ locale: z.enum(["auto", "en", "ru"]), suggestedLocale: z.enum(["en", "ru"]) }).strict(),
    output: z.object({ locale: z.enum(["en", "ru"]), preference: z.enum(["auto", "en", "ru"]) }).strict(),
  },
  remember_project: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  list_projects: {
    input: z.object({}).strict(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()), lastProjectId: z.string().nullable() }).strict(),
  },
  finish_run: {
    input: z.object({ projectId: z.string().min(1), runId: z.string().min(1) }).strict(),
    output: z.object({ projectId: z.string(), finishedRunIds: z.array(z.string()), closed: z.boolean() }).strict(),
  },
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
        stages: z.array(stageReceiptSchema).optional(),
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
      cliPreview: z.object({
        argv: z.array(z.string()),
        env: z.record(z.string(), z.string()),
        applied: z.array(z.string()),
        unapplied: z.array(z.object({ key:z.string(), reason:z.string() }).strict()),
      }).strict(),
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
  save_settings: {
    input: z.object({
      projectId: z.string().min(1),
      changes: z.array(z.object({
        key: z.string().min(1),
        value: z.unknown(),
        expectedVersion: z.number().int().min(0),
      }).strict()).min(1).superRefine((changes, context) => {
        const seen = new Set<string>();
        for (const change of changes) {
          if (seen.has(change.key)) {
            context.addIssue({ code: "custom", message: `duplicate setting key: ${change.key}` });
          }
          seen.add(change.key);
        }
      }),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: z.object({
        code: z.enum(["invalid_choice", "incompatible_setting"]),
        key: z.string(),
        params: z.array(z.string()),
      }).strict().optional(),
    }).strict(),
  },
  save_writer_selection: {
    input: z.object({
      projectId: z.string().min(1),
      providerId: z.string().min(1),
      model: z.string().min(1),
      reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
      serviceTier: z.enum(["default", "fast"]).nullable(),
      expectedVersions: z.object({
        "writer.provider": z.number().int().min(0),
        "writer.model": z.number().int().min(0),
        "writer.reasoning_effort": z.number().int().min(0),
        "writer.service_tier": z.number().int().min(0),
      }).strict(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: z.object({
        code: z.enum(["invalid_choice", "incompatible_setting"]),
        key: z.string(),
        params: z.array(z.string()),
      }).strict().optional(),
    }).strict(),
  },
  save_memory_selection: {
    input: z.object({
      projectId: z.string().min(1),
      providerId: z.string().min(1),
      model: z.string().min(1),
      reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
      serviceTier: z.enum(["default", "fast"]).nullable(),
      expectedVersions: z.object({
        "memory.provider": z.number().int().min(0),
        "memory.model": z.number().int().min(0),
        "memory.reasoning_effort": z.number().int().min(0),
        "memory.service_tier": z.number().int().min(0),
      }).strict(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: z.object({code:z.enum(["invalid_choice","incompatible_setting"]),key:z.string(),params:z.array(z.string())}).strict().optional(),
    }).strict(),
  },
  save_night_review_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"night_review.provider":z.number().int().min(0),"night_review.model":z.number().int().min(0),"night_review.reasoning_effort":z.number().int().min(0),"night_review.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:z.object({code:z.enum(["invalid_choice","incompatible_setting"]),key:z.string(),params:z.array(z.string())}).strict().optional()}).strict(),
  },
  save_docs_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"docs.provider":z.number().int().min(0),"docs.model":z.number().int().min(0),"docs.reasoning_effort":z.number().int().min(0),"docs.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:z.object({code:z.enum(["invalid_choice","incompatible_setting"]),key:z.string(),params:z.array(z.string())}).strict().optional()}).strict(),
  },
  save_onboarding_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"onboarding.provider":z.number().int().min(0),"onboarding.model":z.number().int().min(0),"onboarding.reasoning_effort":z.number().int().min(0),"onboarding.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:z.object({code:z.enum(["invalid_choice","incompatible_setting"]),key:z.string(),params:z.array(z.string())}).strict().optional()}).strict(),
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
    input: z.object({ projectId: z.string().min(1), snapshotPath: z.string().startsWith("/").optional() }).strict(),
    output: z.unknown(),
  },
});
