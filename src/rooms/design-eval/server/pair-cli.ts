import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { appendDesignPair, designPairOf } from "../journal";
import { pairUrlRefusal, type PairUrlOptions } from "../url-guard";

export const DESIGN_PAIR_USAGE = "bb lane-pilot design-pair <phaseId> <url-a> <url-b> [--again] [--local]   |   bb lane-pilot design-pair-answer <phaseId> <a|b|tie>   (owner at a terminal, or the project's PM chat)";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
type CliResult = { exitCode: number; stdout?: string; stderr?: string };

export type DesignPairCliDeps = {
  kv: Kv;
  /** The thread that called the CLI; absent = the owner at a terminal (or an automation). */
  threadId?: string | null;
  /** The thread's project and plugin role, or null when the thread is unknown. */
  thread: (threadId: string) => Promise<{ projectId: string | null; role: string | null } | null>;
  /** The project a phase belongs to, or null when no such phase is stored. */
  phaseProject: (phaseId: string) => string | null;
  /** Runs the measuring script; resolves with its stdout. */
  measure: (script: string, args: string[]) => Promise<string>;
  script: string;
  scriptExists?: (path: string) => boolean;
  ownerItem: { post(item: { key: string; projectId: string | null; what: string; why: string; basis: string }): void; close(key: string, by: string): void };
  hubPorts: readonly number[];
  lookup?: (host: string) => Promise<string[]>;
  ownAddresses?: () => string[];
};

const hostLookup = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((row) => row.address);
const machineAddresses = (): string[] => ["127.0.0.1", "::1", ...Object.values(networkInterfaces()).flatMap((rows) => (rows ?? []).map((row) => row.address))];

/** Why a pair may not open these URLs (the table in url-guard.ts, plus what each host name resolves to), or null. */
export async function pairUrlsRefusal(urls: readonly string[], options: { local?: boolean; hubPorts?: readonly number[]; lookup?: (host: string) => Promise<string[]>; ownAddresses?: () => string[] } = {}): Promise<string | null> {
  for (const raw of urls) {
    const bare = pairUrlRefusal(raw, { local: options.local, hubPorts: options.hubPorts });
    if (bare) return bare;
    if (options.local) continue;
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    let resolved: string[] = [host];
    // A host name is looked up; an address literal is its own answer. A name that does not resolve is left to the browser to fail on.
    if (!/^[0-9.]+$/.test(host) && !host.includes(":")) resolved = await (options.lookup ?? hostLookup)(host).catch(() => []);
    const full: PairUrlOptions = { hubPorts: options.hubPorts, resolved, ownAddresses: (options.ownAddresses ?? machineAddresses)() };
    const refusal = pairUrlRefusal(raw, full);
    if (refusal) return refusal;
  }
  return null;
}

/** The verbs design-pair and design-pair-answer. The CLI is a door any agent thread can reach, so who is calling decides what is allowed. */
export async function runDesignPairCli(deps: DesignPairCliDeps, command: "design-pair" | "design-pair-answer", argv: string[]): Promise<CliResult> {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const [phaseId, ...rest] = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = flags.filter((flag) => !(command === "design-pair" && (flag === "--again" || flag === "--local")));
  if (unknown.length) return { exitCode: 1, stderr: `unknown flag ${unknown[0]}\n${DESIGN_PAIR_USAGE}` };
  const local = flags.includes("--local"), again = flags.includes("--again");
  const answer = command === "design-pair-answer";
  if (!phaseId || (answer ? !["a", "b", "tie"].includes(rest[0] ?? "") || rest.length !== 1 : rest.length !== 2)) return { exitCode: 1, stderr: DESIGN_PAIR_USAGE };

  // No thread = the owner at a terminal. A thread is an agent: only the project's PM chat, in its own project, and never --local.
  const project = deps.phaseProject(phaseId);
  if (deps.threadId) {
    if (local) return { exitCode: 1, stderr: "refused: --local (opening this machine's own pages) is for the owner at a terminal, not for an agent thread" };
    const caller = await deps.thread(deps.threadId);
    if (project === null) return { exitCode: 1, stderr: `refused: ${command} from a thread needs a phase of its own project, and phase ${phaseId} is unknown` };
    if (!caller || caller.projectId !== project) return { exitCode: 1, stderr: `refused: ${command} from a thread reaches only that thread's own project (${caller?.projectId ?? "unknown"}), not ${project}` };
    if (caller.role !== "pm") return { exitCode: 1, stderr: `refused: ${command} is not for a ${caller.role ? `${caller.role} thread` : "thread whose role is unknown"}; ask the PM or the owner` };
  }
  const by = deps.threadId ? `pm:${deps.threadId}` : "owner";

  if (answer) {
    const pick = rest[0] as "a" | "b" | "tie";
    const pair = await designPairOf(deps.kv, phaseId);
    if (!pair) return { exitCode: 1, stderr: `refused: no design pair was started for ${phaseId}; run design-pair first` };
    // The order is the one the pair was shown in: an answer never rewrites it.
    await appendDesignPair(deps.kv, { phaseId, order: pair.order, model: null, person: pick });
    deps.ownerItem.close(`design-pair:${phaseId}`, `${by}:design-pair-answer`);
    return { exitCode: 0, stdout: JSON.stringify({ recorded: { phaseId, person: pick, order: pair.order } }) };
  }

  const [urlA, urlB] = rest as [string, string];
  const refused = await pairUrlsRefusal([urlA, urlB], { local, hubPorts: deps.hubPorts, ...(deps.lookup ? { lookup: deps.lookup } : {}), ...(deps.ownAddresses ? { ownAddresses: deps.ownAddresses } : {}) });
  if (refused) return { exitCode: 1, stderr: refused };
  if ((await designPairOf(deps.kv, phaseId)) && !again) return { exitCode: 1, stderr: `refused: ${phaseId} already has a design pair (each one costs a browser run); pass --again to ask once more` };
  if (!(deps.scriptExists ?? existsSync)(deps.script)) return { exitCode: 1, stderr: `design-pair cannot run: ${deps.script} is not in this plugin's directory` };

  let measured: string;
  try { measured = await deps.measure(deps.script, ["design-pair", urlA, urlB, ...(local ? ["--local"] : [])]); }
  catch (cause) { return { exitCode: 1, stderr: `the pair measure failed: ${cause instanceof Error ? cause.message : String(cause)}` }; }
  const pair = JSON.parse(measured) as { order: "ab" | "ba"; basis: string; shots: { a: string | null; b: string | null } };
  deps.ownerItem.post({ key: `design-pair:${phaseId}`, projectId: project, what: `Какой дизайн лучше? Ответьте: bb lane-pilot design-pair-answer ${phaseId} a|b|tie`, why: pair.basis.slice(0, 550), basis: pair.basis.slice(0, 300) });
  await appendDesignPair(deps.kv, { phaseId, order: pair.order, model: null, person: null });
  return { exitCode: 0, stdout: JSON.stringify({ phaseId, order: pair.order, model: null, asked: true }) };
}
