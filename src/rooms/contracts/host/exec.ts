import { z } from "zod";
import { secretNameSchema } from "@lane-pilot/contracts";

/** Commands the hub runs on the host: plain, scheduled-script, and sandboxed with a policy. */
export const execHostMethods = {
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
  runSandboxedCommand: {
    input:z.object({
      requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),cwd:z.string().startsWith("/"),
      backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),
      command:z.string().min(1).max(32_000),timeoutSec:z.number().int().min(1).max(7200).optional(),
      /** Secret values for this one command (Env Catalog, J2): they go into the sandbox's environment only, and the host masks them in the output. */
      env:z.record(secretNameSchema,z.string().max(65_536)).optional(),
      /** The strict worker: run as this OS user (worker.strict_user on). */
      asUser:z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
      /** Hash .git/.agents/.cls before and after the command (the check-measure path only). */
      protectedRoots:z.boolean().optional(),
      /** Leave ~/.ssh readable for this command (the project's verification.ssh_keys is on). */
      sshKeys:z.boolean().optional(),
    }).strict(),
    output:z.object({
      hostId:z.string(),backend:z.enum(["macos-seatbelt","linux-bubblewrap"]),workspacePath:z.string(),cwd:z.string(),
      exitCode:z.number().int(),policySha256:z.string().regex(/^[a-f0-9]{64}$/),stdout:z.string(),stderr:z.string(),
      maskedSsh:z.boolean().optional(),
      rootsManifest:z.object({before:z.string(),after:z.string(),changed:z.boolean(),partial:z.boolean().optional(),git:z.enum(["covered","worktree-gitdir","uncovered","absent"]).optional()}).optional(),
    }).strict(),
  },
  sandboxCommandLine: {
    input:z.object({
      requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),cwd:z.string().startsWith("/"),
      backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),command:z.string().min(1).max(32_000),
      passEnv:z.array(z.string().max(128)).max(500).optional(),
      sshKeys:z.boolean().optional(),
      /** Hash .git/.agents/.cls before the terminal runs; sandboxRelease returns the after manifest (additive). */
      protectedRoots:z.boolean().optional(),
    }).strict(),
    output:z.object({
      hostId:z.string(),backend:z.enum(["macos-seatbelt","linux-bubblewrap"]),workspacePath:z.string(),cwd:z.string(),
      policySha256:z.string().regex(/^[a-f0-9]{64}$/),commandLine:z.string(),maskedSsh:z.boolean().optional(),
      cleanup:z.object({tempPath:z.string(),created:z.array(z.string())}).strict(),
      rootsBefore:z.object({sha256:z.string(),partial:z.boolean(),git:z.enum(["covered","worktree-gitdir","uncovered","absent"]).optional()}).optional(),
    }).strict(),
  },
  sandboxRelease: {
    input:z.object({requestedHostId:z.string().min(1),tempPath:z.string().startsWith("/"),created:z.array(z.string()),
      /** With rootsBefore: hash the roots again and return the before/after manifest (additive). */
      workspacePath:z.string().startsWith("/").optional(),
      rootsBefore:z.object({sha256:z.string(),partial:z.boolean(),git:z.enum(["covered","worktree-gitdir","uncovered","absent"]).optional()}).optional(),
    }).strict(),
    output:z.object({hostId:z.string(),released:z.boolean(),
      rootsManifest:z.object({before:z.string(),after:z.string(),changed:z.boolean(),partial:z.boolean().optional(),git:z.enum(["covered","worktree-gitdir","uncovered","absent"]).optional()}).optional(),
    }).strict(),
  },
  openCodeLimitProbe: {
    input: z.object({ requestedHostId:z.string().min(1), sessionId:z.string().regex(/^ses_[A-Za-z0-9]{1,80}$/), sinceMs:z.number().int().nonnegative() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["limit","none"]), providerId:z.string().nullable(), model:z.string().nullable(), resetAt:z.number().nullable(), reason:z.string().nullable() }).strict(),
  },
  inspectCritiqueCoverage: {
    input:z.object({requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),plan:z.string().max(100_000),
      tasks:z.array(z.object({id:z.string().max(128),lane:z.string().max(64),ownsPaths:z.array(z.string()).max(128),hasVerification:z.boolean(),
        verification:z.array(z.object({command:z.string().max(4096),timeoutSec:z.number().int().nonnegative().max(7200).optional()}).strict()).max(32)}).strict()).max(64)}).strict(),
    output:z.object({hostId:z.string(),status:z.enum(["complete","truncated"]),pathCount:z.number().int().nonnegative(),
      findings:z.array(z.object({code:z.enum(["plan_path_unowned","owns_gap","coverage_scan_truncated","owns_overlap","verify_missing","verify_heavy","owns_empty","plan_missing","no_tasks","caller_unowned","task_placeholder","output_unowned","output_binary","verify_filter_ignored","depends_cycle","depends_self"]),path:z.string(),
        severity:z.enum(["error","warning","info"]),finding:z.string()}).strict()).max(10)}).strict(),
  },
};
