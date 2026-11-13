import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, statfs } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { isFsAbsent, orMiss, readTextOrNull } from "@lane-pilot/kit";
import { hostContract } from "../../contracts";
import { readMachineFacts, userToolBins } from "../../verification";
import { runStabilityDrill } from "../../stability";
import { writePmSettingsOnHost } from "../../writer";

/** Free space for whoever decides before a spawn: a full disk (OVH, 2026-10-03) killed the BB host daemon. With `machine`: the host's load and memory too, the reading taken before a check. */
export const diskFree: ExperimentalHostRpcHandlers<typeof hostContract>["diskFree"] = async (input) => {
  const fs = await statfs(input.path);
  return { hostId:process.env.BB_HOST_ID??input.requestedHostId, path:input.path, freeBytes:Number(fs.bavail)*Number(fs.bsize), totalBytes:Number(fs.blocks)*Number(fs.bsize),
    ...(input.machine ? { machine:await readMachineFacts() } : {}) };
};

export const stabilityDrill: ExperimentalHostRpcHandlers<typeof hostContract>["stabilityDrill"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  checks:await runStabilityDrill(),
});

/** A ticket stands unanswered for ten minutes, then a late answer cannot authorise the call (SMA wb_ticket). */
export const PERMIT_TTL_S = 600;

/** The permit channel on this machine: every live ticket a writer filed that has no answer yet. */
export const listPermitTickets: ExperimentalHostRpcHandlers<typeof hostContract>["listPermitTickets"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const root = join(homedir(), ".agents", "permits");
  const tickets: Array<{ session: string; ticket: string; category: string; command: string; cwd: string; at: number }> = [];
  for (const session of await orMiss(readdir(root), [] as string[], isFsAbsent)) {
    try {
      for (const name of await orMiss(readdir(join(root, session)), [] as string[], isFsAbsent)) {
        if (!name.endsWith(".ticket.json")) continue;
        const id = name.slice(0, -".ticket.json".length);
        if (await stat(join(root, session, `${id}.answer.json`)).then(() => true, () => false)) continue;
        const raw = await readFile(join(root, session, name), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
        // An expired ticket waits for nobody: the writer's next run files a fresh one.
        if (raw && Number(raw.at ?? 0) > Date.now() / 1000 - PERMIT_TTL_S) tickets.push({ session, ticket: id, category: String(raw.category ?? ""), command: String(raw.command ?? "").slice(0, 2000), cwd: String(raw.cwd ?? ""), at: Number(raw.at ?? 0) });
      }
    } catch (cause) {
      console.warn(`lane-pilot: permit tickets unreadable in ${join(root, session)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { hostId, tickets: tickets.slice(0, 100) };
};

/** The PM's answer to one permit ticket. */
export const answerPermit: ExperimentalHostRpcHandlers<typeof hostContract>["answerPermit"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const folder = join(homedir(), ".agents", "permits", input.session);
  const ticketPath = join(folder, `${input.ticket}.ticket.json`);
  if (!await stat(ticketPath).then(() => true, () => false)) return { hostId, written: false };
  const filed = await readFile(ticketPath, "utf8").then((text) => Number((JSON.parse(text) as Record<string, unknown>).at ?? 0), () => 0);
  if (filed <= Date.now() / 1000 - PERMIT_TTL_S) return { hostId, written: false, expired: true };
  const temp = join(folder, `.${input.ticket}.${randomUUID().slice(0, 8)}`);
  const handle = await open(temp, "w");
  try { await handle.writeFile(JSON.stringify({ decision: input.decision, why: input.why, at: Date.now() / 1000 })); } finally { await handle.close(); }
  await rename(temp, join(folder, `${input.ticket}.answer.json`));
  return { hostId, written: true };
};

/** The subscription windows the statusline cached on this machine: five hours, seven days, seven days of Opus (utilization in percent). */
export const readUsageWindows: ExperimentalHostRpcHandlers<typeof hostContract>["readUsageWindows"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const file = join(process.env.LANE_STATUSLINE_CACHE ?? join(homedir(), ".agents", "statusline"), "last_usage.json");
  const raw = await readFile(file, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
  const usage = (raw?.usage ?? {}) as Record<string, { utilization?: unknown; resets_at?: unknown }>;
  const windows: Record<string, { utilization: number; resetsAt: string | null }> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value?.utilization === "number") windows[key] = { utilization: value.utilization, resetsAt: typeof value.resets_at === "string" ? value.resets_at : null };
  }
  return { hostId, at: typeof raw?.at === "string" ? raw.at : null, windows };
};

/** The hub's latest usage snapshot for this machine's session guard (~/.lane-pilot/usage-snapshot.json). */
export const writeUsageSnapshot: ExperimentalHostRpcHandlers<typeof hostContract>["writeUsageSnapshot"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const dir = join(homedir(), ".lane-pilot");
  const file = join(dir, "usage-snapshot.json");
  const temp = `${file}.${randomUUID().slice(0, 8)}`;
  await mkdir(dir, { recursive: true });
  const handle = await open(temp, "w");
  try { await handle.writeFile(JSON.stringify(input.snapshot)); } finally { await handle.close(); }
  await rename(temp, file);
  return { hostId, written: true };
};

/** Close exactly that line: the backlog item's meta.yaml gets `status: done`; a file with no or two status lines is refused, not guessed. */
export const closeBacklogItem: ExperimentalHostRpcHandlers<typeof hostContract>["closeBacklogItem"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const file = join(await realpath(input.projectCwd), ".agents", "todos", "items", input.id, "meta.yaml");
  const text = await readTextOrNull(file);
  if (text === null) return { hostId, status: "refused", reason: `no ${relative(input.projectCwd, file)}` };
  const lines = text.split("\n");
  const at = lines.flatMap((line, index) => (/^status\s*:/.test(line) ? [index] : []));
  if (at.length !== 1) return { hostId, status: "refused", reason: `${at.length} status lines in meta.yaml; expected exactly one` };
  if (/^status\s*:\s*done\s*$/.test(lines[at[0]!]!)) return { hostId, status: "already", reason: null };
  lines[at[0]!] = "status: done";
  const temp = `${file}.lp-${randomUUID().slice(0, 8)}`;
  const handle = await open(temp, "w");
  try { await handle.writeFile(lines.join("\n")); } finally { await handle.close(); }
  await rename(temp, file);
  return { hostId, status: "closed", reason: null };
};

/** Is the check command runnable: each program found on PATH, among the user's tool bins, or in the check folder's node_modules/.bin. */
export const whichPrograms: ExperimentalHostRpcHandlers<typeof hostContract>["whichPrograms"] = async (input) => {
  const dirs = [join(input.cwd, "node_modules", ".bin"), ...userToolBins(), ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean);
  const found: Record<string, boolean> = {};
  for (const program of input.programs) {
    let hit = false;
    for (const dir of dirs) {
      if (await access(join(dir, program), fsConstants.X_OK).then(() => true, () => false)) { hit = true; break; }
    }
    found[program] = hit;
  }
  return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, found };
};

/**
 * Codex keeps its own memory store (`~/.codex/memories`); Lane Pilot memory lives in one place, the hub DB. A task's config.toml gets
 * `[features] memories = false` and `[memories] generate_memories = false`, whatever the owner's file said. Other keys stay as they were.
 */
export function disableCodexMemories(toml: string): string {
  const want: Record<string, string> = { features: "memories", memories: "generate_memories" };
  const done = new Set<string>();
  const out: string[] = [];
  let table = "";
  let headerAt = -1;
  // End of a wanted table without its key: add the key right after the header.
  const flush = () => {
    if (!want[table] || done.has(table)) return;
    out.splice(headerAt + 1, 0, `${want[table]} = false`);
    done.add(table);
  };
  for (const line of toml.split("\n")) {
    const header = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) { flush(); table = header[1]!.trim(); headerAt = out.length; }
    else if (want[table] && new RegExp(`^\\s*${want[table]}\\s*=`).test(line)) { out.push(`${want[table]} = false`); done.add(table); continue; }
    out.push(line);
  }
  flush();
  const base = out.join("\n");
  const missing = Object.keys(want).filter((t) => !done.has(t));
  return missing.length ? `${base}${base === "" || base.endsWith("\n") ? "" : "\n"}${missing.map((t) => `\n[${t}]\n${want[t]} = false\n`).join("")}` : base;
}

/**
 * Fresh codex home per task, seeded (SMA: Fresh codex home per task, Seed the codex home): a writer of the strict worker mode gets its own
 * CODEX_HOME, so no task reads another task's sessions and history; config.toml and AGENTS.md are copied, auth.json is linked (one login
 * that refreshes in one place).
 */
export const prepareWorkerHome: ExperimentalHostRpcHandlers<typeof hostContract>["prepareWorkerHome"] = async (input) => {
  const { mkdir: mk, copyFile, symlink: link, access: can } = await import("node:fs/promises");
  const { homedir: home } = await import("node:os");
  const { join: at } = await import("node:path");
  const source = process.env.CODEX_HOME?.trim() || at(home(), ".codex");
  const codexHome = at(home(), ".lane-pilot", "codex-homes", input.key);
  await mk(codexHome, { recursive: true });
  const seeded: string[] = [];
  for (const name of ["config.toml", "AGENTS.md"]) {
    if (await can(at(source, name)).then(() => true, () => false) && !await can(at(codexHome, name)).then(() => true, () => false)) { await copyFile(at(source, name), at(codexHome, name)); seeded.push(name); }
  }
  // One memory place (the hub DB): the task's config turns Codex's own memory store off, whatever the owner's file says.
  const { writeFile } = await import("node:fs/promises");
  const cfg = at(codexHome, "config.toml");
  await writeFile(cfg, disableCodexMemories(await readFile(cfg, "utf8").catch(() => "")), "utf8");
  if (await can(at(source, "auth.json")).then(() => true, () => false) && !await can(at(codexHome, "auth.json")).then(() => true, () => false)) { await link(at(source, "auth.json"), at(codexHome, "auth.json")); seeded.push("auth.json"); }
  return { codexHome, seeded };
};

/** The throwaway half of the per-task codex home (SMA m_ac_codex_home): confined to ~/.lane-pilot/codex-homes/<key>,
 * key validated by the contract exactly as prepareWorkerHome's; rm -rf removes the auth.json link, never follows it. */
export const removeWorkerHome: ExperimentalHostRpcHandlers<typeof hostContract>["removeWorkerHome"] = async (input) => {
  const { rm, realpath } = await import("node:fs/promises");
  const { homedir: home } = await import("node:os");
  const { join: at, resolve, sep } = await import("node:path");
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  // The handler is reached by the contract's regex, but it checks the key itself: "." would resolve to the root and remove every home.
  if (input.key === "" || input.key.startsWith(".") || input.key.includes("/") || input.key.includes("\\")) return { hostId, removed: false };
  const root = at(home(), ".lane-pilot", "codex-homes");
  const target = at(root, input.key);
  const exists = await lstat(target).then(() => true, () => false);
  if (!exists) return { hostId, removed: false };
  // Confinement: the real path must stay under codex-homes even if the home itself is a link.
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  const resolvedTarget = await realpath(target).catch(() => resolve(target));
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(resolvedRoot + sep)) return { hostId, removed: false };
  await rm(target, { recursive: true, force: true });
  return { hostId, removed: true };
};

/**
 * This machine's address in the private WireGuard network (wg*, utun*, tun*, tailscale*): another machine's browser
 * reaches a dev server here at that address, without a public tunnel.
 */
export const vpnAddress: ExperimentalHostRpcHandlers<typeof hostContract>["vpnAddress"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!/^(wg|utun|tun|tailscale)/.test(name)) continue;
    const ipv4 = entries?.find((entry) => entry.family === "IPv4" && !entry.internal
      && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(entry.address));
    if (ipv4) return { hostId, address:ipv4.address, interface:name };
  }
  return { hostId, address:null, interface:null };
};

export const writePmSettings: ExperimentalHostRpcHandlers<typeof hostContract>["writePmSettings"] = async (input) => (
  writePmSettingsOnHost(input)
);
