import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { brokenProof, isChecked, isDone, smaCheckedPercent, smaCounts, smaDonePercent, smaHoles, smaRows, unjudgedProof, type ProofRoots, type SmaRow } from "./model";
import { SMA_LINKS, SMA_MAP_SHA, SMA_NODES, SMA_REGIONS } from "./graph";

export const SMA_MAP_USAGE = "bb lane-pilot sma-map [--json] [--region <number|name>] [--status have|partial|missing|skip|upstream|unproven|unchecked] [--check-proofs] [--live [--days N]]   the SMA product map node by node: the card, what Lane Pilot has for it, the proof link and the contract tests; mapped is a link, checked is a test of the card's behaviour; --live says which groups left a trace in the window";

import { readSmaLive, renderSmaLive, smaGroups } from "./live";

type Result = { exitCode: number; stdout?: string; stderr?: string };
const flag = (argv: readonly string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

/** Where the sibling repositories usually are; a proof into a missing one is not judged. */
export function defaultProofRoots(cwd: string): ProofRoots {
  // Beside the plugin on a Mac checkout, under ~/tools on the Linux hosts.
  const laneStack = [join(cwd, "..", "claude-lane-stack"), join(homedir(), "tools", "claude-lane-stack")].find((path) => existsSync(path)) ?? join(cwd, "..", "claude-lane-stack");
  const core = join(homedir(), ".local", "share", "bb-source-vk");
  const telegram = join(cwd, "..", "bb-plugin-telegram-projects");
  return { lanePilot: cwd, ...(existsSync(laneStack) ? { laneStack } : {}), ...(existsSync(core) ? { core } : {}), ...(existsSync(telegram) ? { telegram } : {}) };
}

export function renderSmaMap(all: readonly SmaRow[], listed: readonly SmaRow[] = []): string {
  const c = smaCounts(all);
  const lines = [`SMA map (code ${SMA_MAP_SHA}): ${c.total} nodes, ${SMA_LINKS.length} links — checked by a contract test ${c.contract} (${smaCheckedPercent(all)}%); mapped ${smaDonePercent(all)}% (a proof link ${c.proven}, unwired in SMA itself ${c.upstream}); have without proof ${c.have - c.proven}, partial ${c.partial}, missing ${c.missing}.`,
    "A proof link says where our counterpart is, not that it does what the card says: only a contract test checks that.", "", "region                                checked mapped   have partial missing upstream"];
  SMA_REGIONS.forEach((region, index) => {
    const part = all.filter((row) => row.region === region);
    const n = smaCounts(part);
    lines.push(`${String(index).padStart(2)} ${region.slice(0, 34).padEnd(34)} ${`${smaCheckedPercent(part)}%`.padStart(7)} ${`${smaDonePercent(part)}%`.padStart(6)} ${String(n.have).padStart(6)} ${String(n.partial).padStart(7)} ${String(n.missing).padStart(7)} ${String(n.upstream).padStart(8)}`);
  });
  if (listed.length) {
    lines.push("");
    for (const row of listed) lines.push(`${row.status.padEnd(8)} ${row.id.padEnd(6)} ${row.smaId} [${row.kind}] ${row.label}: ${row.detail}${row.ours ? ` — ours: ${row.ours}` : ""}${row.proof ? `  (${row.proof})` : ""}${row.contracts.length ? `  checked by ${row.contracts.length} test(s)` : "  no contract test"}`);
  }
  return lines.join("\n");
}

export function runSmaMapCli(argv: string[], cwd: string = process.cwd()): Result {
  const all = smaRows();
  const regionArg = flag(argv, "--region"), status = flag(argv, "--status");
  const region = regionArg === undefined ? undefined : /^\d+$/.test(regionArg) ? SMA_REGIONS[Number(regionArg)] : SMA_REGIONS.find((name) => name.toLowerCase().includes(regionArg.toLowerCase()));
  if (regionArg !== undefined && !region) return { exitCode: 2, stderr: `no region ${regionArg}; regions: ${SMA_REGIONS.map((name, index) => `${index} ${name}`).join("; ")}` };
  const rows = all.filter((row) => (!region || row.region === region) && (!status || (status === "unproven" ? row.status === "have" && !row.proof : status === "unchecked" ? !isChecked(row) : row.status === status)));
  const holes = smaHoles();
  const roots = defaultProofRoots(cwd);
  const checking = argv.includes("--check-proofs");
  const broken = checking ? all.flatMap((row) => (row.proof ? [brokenProof(row.proof, roots)] : [])).filter((x): x is string => !!x) : [];
  const unjudged = checking ? all.filter((row) => row.proof && unjudgedProof(row.proof, roots)).length : 0;
  if (argv.includes("--json")) return { exitCode: holes.length || broken.length ? 1 : 0, stdout: JSON.stringify({ sha: SMA_MAP_SHA, mapped: smaDonePercent(all), checked: smaCheckedPercent(all), counts: smaCounts(all), rows, holes, broken, unjudged, notMapped: all.filter((row) => !isDone(row)).length }, null, 2) };
  const out = [renderSmaMap(all, region || status ? rows : [])];
  if (holes.length) out.push("", `Registry holes (${holes.length}):`, ...holes.map((hole) => `  ${hole}`));
  if (broken.length) out.push("", `Broken proofs (${broken.length}):`, ...broken.map((line) => `  ${line}`));
  if (unjudged) out.push("", `Proofs not judged: ${unjudged} point into a sibling repository this machine does not have.`);
  return { exitCode: holes.length || broken.length ? 1 : 0, stdout: out.join("\n") };
}

/** `bb lane-pilot sma-map --live [--days N] [--json]`: which groups of the map left a trace in the plugin's database in the window. */
export function runSmaLiveCli(db: Parameters<typeof readSmaLive>[0], argv: string[], now = Date.now()): Result {
  const days = Math.max(1, Math.min(365, Number(flag(argv, "--days") ?? 7) || 7));
  const rows = readSmaLive(db, smaGroups(SMA_NODES as never, SMA_REGIONS), now - days * 86_400_000);
  if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify({ days, rows }, null, 2) };
  return { exitCode: 0, stdout: renderSmaLive(rows, days, now) };
}
