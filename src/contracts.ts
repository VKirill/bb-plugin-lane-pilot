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

export const hostContract = defineRpcContract({
  detect: {
    input: z.object({ requestedHostId: z.string().min(1), workspacePath: z.string().startsWith("/") }).strict(),
    output: z.object({
      hostId: z.string(),
      laneStack: z.object({ present: z.boolean(), version: z.string().nullable(), sourceSha: z.string().nullable() }),
      openCode: z.object({ present: z.boolean(), version: z.string().nullable() }),
      workspace: z.object({ path: z.string(), present: z.boolean() }),
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
});

export const rpcContract = defineRpcContract({
  activate_pm: {
    input: z.object({ projectId: z.string().min(1), sourceThreadId: z.string().nullable() }).strict(),
    output: z.object({ threadId: z.string().min(1), runId: z.string().min(1) }).strict(),
  },
});
