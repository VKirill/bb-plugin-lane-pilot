import { z } from "zod";
import { coexistenceInventory, coexistenceManager, coexistenceOperation, coexistenceOperationResult, hostBaseFields, hostBaseInput, installReceiptSchema } from "@lane-pilot/contracts";

/** What is installed on this machine: the lane stack itself, coexisting agent managers, and native-agent preparation. */
export const stackHostMethods = {
  nativeInstall: {
    input: z.object({ requestedHostId: z.string().min(1), action: z.enum(["install", "enable", "disable", "remove", "status"]) }).strict(),
    output: z.object({ status: z.enum(["absent", "prepared", "enabled", "disabled"]), sourceSha: z.string().nullable(), ownedFiles: z.number(), preservedFiles: z.number() }).strict(),
  },
  removeClaudeLaneLeftovers: {
    input: z.object({ requestedHostId: z.string().min(1), apply: z.boolean().optional() }).strict(),
    output: z.object({
      apply: z.boolean(),
      changed: z.boolean(),
      settings: z.array(z.string()),
      codex: z.array(z.string()),
      moved: z.array(z.string()),
      backupDir: z.string().nullable(),
    }).strict(),
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
  connectOpencode: {
    input: hostBaseInput,
    output: installReceiptSchema,
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
  /** Bundled claude guard launcher for a Lane Pilot thread that is not a native session. (2026-10-29 claude-guard) */
  prepareClaudeGuard: {
    input: z.object({
      role: z.string().min(1).max(80),
      cwd: z.string().startsWith("/").optional(),
    }).strict(),
    output: z.object({
      env: z.array(z.object({ name: z.string(), value: z.string(), reason: z.string() }).strict()),
    }).strict(),
  },
};
