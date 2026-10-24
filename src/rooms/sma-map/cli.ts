import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { brokenProof, isDone, smaCounts, smaDonePercent, smaHoles, smaRows, type ProofRoots, type SmaRow } from "./model";
import { SMA_REGIONS } from "./graph";

export const SMA_MAP_USAGE = "bb lane-pilot sma-map [--json] [--region <number|name>] [--status have|partial|missing|skip|unproven] [--check-proofs]   the SMA product map node by node: what Lane Pilot has for each node, the proof in the code, and the share done";

type Result = { exitCode: number; stdout?: string; stderr?: string };
const flag = (argv: readonly string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

/** Where the sibling repositories usually are; a proof into a missing one is not judged. */
export function defaultProofRoots(cwd: string): ProofRoots {
  const laneStack = join(cwd, "..", "claude-lane-stack");
  const core = join(homedir(), ".local", "share", "bb-source-vk");
  const telegram = join(cwd, "..", "bb-plugin-telegram-projects");
  return { lanePilot: cwd, ...(existsSync(laneStack) ? { laneStack } : {}), ...(existsSync(core) ? { core } : {}), ...(existsSync(telegram) ? { telegram } : {}) };
}

export function renderSmaMap(all: readonly SmaRow[], listed: readonly SmaRow[] = []): string {
  const c = smaCounts(all);
  const lines = [`SMA map: ${c.total} nodes — done ${smaDonePercent(all)}% (proven ${c.proven}); have without proof ${c.have - c.proven}, partial ${c.partial}, missing ${c.missing}.`, "", "region                                   done   have partial missing skip"];
  SMA_REGIONS.forEach((region, index) => {
    const part = all.filter((row) => row.region === region);
    const n = smaCounts(part);
    lines.push(`${String(index).padStart(2)} ${region.slice(0, 37).padEnd(37)} ${`${smaDonePercent(part)}%`.padStart(6)} ${String(n.have).padStart(6)} ${String(n.partial).padStart(7)} ${String(n.missing).padStart(7)} ${String(n.skip).padStart(4)}`);
  });
  if (listed.length) {
    lines.push("");
    for (const row of listed) lines.push(`${row.status.padEnd(7)} ${row.id.padEnd(6)} [${row.kind}] ${row.label}${row.ours ? ` — ${row.ours}` : ""}${row.proof ? `  (${row.proof})` : ""}`);
  }
  return lines.join("\n");
}

export function runSmaMapCli(argv: string[], cwd: string = process.cwd()): Result {
  const all = smaRows();
  const regionArg = flag(argv, "--region"), status = flag(argv, "--status");
  const region = regionArg === undefined ? undefined : /^\d+$/.test(regionArg) ? SMA_REGIONS[Number(regionArg)] : SMA_REGIONS.find((name) => name.toLowerCase().includes(regionArg.toLowerCase()));
  if (regionArg !== undefined && !region) return { exitCode: 2, stderr: `no region ${regionArg}; regions: ${SMA_REGIONS.map((name, index) => `${index} ${name}`).join("; ")}` };
  const rows = all.filter((row) => (!region || row.region === region) && (!status || (status === "unproven" ? row.status === "have" && !row.proof : row.status === status)));
  const holes = smaHoles();
  const broken = argv.includes("--check-proofs") ? all.flatMap((row) => (row.proof ? [brokenProof(row.proof, defaultProofRoots(cwd))] : [])).filter((x): x is string => !!x) : [];
  if (argv.includes("--json")) return { exitCode: holes.length || broken.length ? 1 : 0, stdout: JSON.stringify({ done: smaDonePercent(all), counts: smaCounts(all), rows, holes, broken, notDone: all.filter((row) => !isDone(row)).length }, null, 2) };
  const out = [renderSmaMap(all, region || status ? rows : [])];
  if (holes.length) out.push("", `Registry holes (${holes.length}):`, ...holes.map((hole) => `  ${hole}`));
  if (broken.length) out.push("", `Broken proofs (${broken.length}):`, ...broken.map((line) => `  ${line}`));
  return { exitCode: holes.length || broken.length ? 1 : 0, stdout: out.join("\n") };
}
