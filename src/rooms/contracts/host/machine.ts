import { z } from "zod";

/** This machine's own state: its disks, permit tickets, usage windows, backlog items and tool bins. */
export const machineHostMethods = {
  diskFree: {
    // `machine`: also answer with the host's load, CPU count and memory, for the reading taken before a check (additive; an older host rejects the flag, and the caller then has no reading).
    input: z.object({ requestedHostId:z.string().min(1), path:z.string().startsWith("/"), machine:z.boolean().optional() }).strict(),
    output: z.object({ hostId:z.string(), path:z.string(), freeBytes:z.number().nonnegative(), totalBytes:z.number().nonnegative(),
      machine:z.object({ load1:z.number().nonnegative().nullable(), cpuCount:z.number().int().positive().nullable(), memFreeBytes:z.number().nonnegative().nullable(), memTotalBytes:z.number().nonnegative().nullable() }).strict().optional() }).strict(),
  },
  stabilityDrill: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), checks:z.array(z.object({ name:z.string(), ok:z.boolean(), detail:z.string().nullable() }).strict()) }).strict(),
  },
  /** SMA «Permit channel»: the permit tickets writers filed on this machine (~/.agents/permits/<session>/<ticket>.ticket.json) and not yet answered. */
  listPermitTickets: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), tickets:z.array(z.object({ session:z.string(), ticket:z.string(), category:z.string(), command:z.string(), cwd:z.string(), at:z.number() }).strict()) }).strict(),
  },
  /** SMA «Approve or deny the call»: the PM's answer to a permit ticket, written next to it; a grant is used once by the same command. */
  answerPermit: {
    input: z.object({ requestedHostId:z.string().min(1), session:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), ticket:z.string().regex(/^[a-f0-9]{16}$/), decision:z.enum(["allow","deny"]), why:z.string().max(600) }).strict(),
    output: z.object({ hostId:z.string(), written:z.boolean(), expired:z.boolean().optional() }).strict(),
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
  /** A fresh codex home per task (worker.strict_user on): ~/.lane-pilot/codex-homes/<key>/ seeded with the machine's codex config and login. */
  prepareWorkerHome: {
    input: z.object({ requestedHostId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }).strict(),
    output: z.object({ codexHome: z.string(), seeded: z.array(z.string()) }).strict(),
  },
  /** SMA «Stream: spend»: the session guard's spend stream reads ~/.lane-pilot/usage-snapshot.json, written by the hub's scheduled pass. */
  writeUsageSnapshot: {
    input: z.object({ requestedHostId:z.string().min(1),
      snapshot:z.object({ at:z.string(), windows:z.array(z.object({ label:z.string(), usedPercent:z.number(), resetsAt:z.string().nullable() }).strict()), skipPercent:z.number(), skipSetByHuman:z.boolean() }).strict() }).strict(),
    output: z.object({ hostId:z.string(), written:z.boolean() }).strict(),
  },
  vpnAddress: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), address:z.string().nullable(), interface:z.string().nullable() }).strict(),
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
};
