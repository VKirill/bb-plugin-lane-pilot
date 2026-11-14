import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SMA_ENTRIES } from "./entries";
import { relocateAnchor } from "./exports";
import { brokenProof, isChecked, isDone, proofDrift, smaCheckedPercent, smaCounts, smaDonePercent, smaHoles, smaRows, smaStateCounts, unjudgedProof, type ProofRoots, type SmaRow } from "./model";
import { SMA_LINKS, SMA_MAP_SHA, SMA_NODES, SMA_REGIONS } from "./graph";

export const SMA_MAP_USAGE = "bb lane-pilot sma-map [--json] [--region <number|name>] [--status have|partial|missing|skip|upstream|void|deviation|deviation-data|unproven|unchecked] [--check-proofs] [--live [--days N]] [--states | --gaps | --hollow]   the SMA product map node by node: the card, what Lane Pilot has for it, the proof link and the contract tests; mapped is a link, checked is a test of the card's behaviour; --live says which groups left a trace in the window; --states counts the four proofs per node (checked, mutated, reachable, outcome-verified; sma-parity-tz.md §4), --gaps lists per node which proof is missing, --hollow lists the hollow findings (§4а); with --live they read the hub's settings and node-level traces";

import { readSmaLive, renderSmaLive, smaGroups } from "./live";
import { runProofCli, wantsProofs } from "./cli-proofs";

type Result = { exitCode: number; stdout?: string; stderr?: string };
const flag = (argv: readonly string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

/** Where the sibling repositories usually are; a proof into a missing one is not judged. */
export function defaultProofRoots(cwd: string): ProofRoots {
  // Beside the plugin on a Mac checkout, under ~/tools on the Linux hosts.
  const laneStack = [join(cwd, "..", "claude-lane-stack"), join(homedir(), "tools", "claude-lane-stack")].find((path) => existsSync(path)) ?? join(cwd, "..", "claude-lane-stack");
  // The BB core sources (vk layer): the Mac/hub checkout first, else the sibling bb-core repository on the Linux hosts.
  const core = [join(homedir(), ".local", "share", "bb-source-vk"), join(cwd, "..", "bb-core", "vk"), join(cwd, "..", "..", "..", "..", "bb-core", "vk")].find((path) => existsSync(path)) ?? join(homedir(), ".local", "share", "bb-source-vk");
  const telegram = join(cwd, "..", "bb-plugin-telegram-projects");
  // Sources, not a built copy: the hub's install has no src/, and a proof cannot be judged there.
  return { lanePilot: existsSync(join(cwd, "src/rooms/sma-map/entries.ts")) ? cwd : "", ...(existsSync(laneStack) ? { laneStack } : {}), ...(existsSync(core) ? { core } : {}), ...(existsSync(telegram) ? { telegram } : {}) };
}

export function renderSmaMap(all: readonly SmaRow[], listed: readonly SmaRow[] = []): string {
  const c = smaCounts(all);
  const lines = [`SMA map (code ${SMA_MAP_SHA}): ${c.total} nodes, ${SMA_LINKS.length} links — checked by a contract test ${c.contract} (${smaCheckedPercent(all)}%); mapped ${smaDonePercent(all)}% (a proof link ${c.proven}, unwired in SMA itself ${c.upstream}, no subject here ${c.void}); have without proof ${c.have - c.proven}, partial ${c.partial}, missing ${c.missing}.`,
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

/**
 * `--fix-proofs`: every broken local `path#anchor` proof whose anchor lives in exactly one file now (an exporting
 * module for identifier anchors, a text carrier otherwise) gets its path rewritten in entries.ts. A deleted or
 * ambiguous anchor stays broken — it needs a human, not a pointer update.
 */
export function fixProofsInFile(entriesFile: string, proofs: readonly string[], root: string): { fixed: Array<{ from: string; to: string }>; unfixable: string[] } {
  const roots = { lanePilot: root };
  const fixed: Array<{ from: string; to: string }> = [];
  const unfixable: string[] = [];
  let text = readFileSync(entriesFile, "utf8");
  for (const proof of new Set(proofs)) {
    if (/^(lane-stack|core|telegram):/.test(proof) || !proof.includes("#")) continue;
    const [where, anchor] = proof.split("#", 2) as [string, string];
    if (!brokenProof(proof, roots)) continue;
    const at = relocateAnchor(root, anchor);
    if (!at || at === where || at === proof) { unfixable.push(proof); continue; }
    text = text.split(JSON.stringify(proof)).join(JSON.stringify(at));
    fixed.push({ from: proof, to: at });
  }
  if (fixed.length) writeFileSync(entriesFile, text);
  return { fixed, unfixable };
}

export function runSmaMapCli(argv: string[], cwd: string = process.cwd()): Result {
  if (argv.includes("--fix-proofs")) {
    const { fixed, unfixable } = fixProofsInFile(join(cwd, "src/rooms/sma-map/entries.ts"), Object.values(SMA_ENTRIES).flatMap((e) => (e[2] ? [e[2]] : [])), cwd);
    const lines = fixed.map((f) => `  ${f.from} -> ${f.to}`);
    if (unfixable.length) lines.push("", `still broken (${unfixable.length}) — anchor deleted or ambiguous:`, ...unfixable.map((p) => `  ${p}`));
    return { exitCode: unfixable.length ? 1 : 0, stdout: `Fixed ${fixed.length} proof path(s).\n${lines.join("\n")}` };
  }
  // The four proofs (sma-parity-tz.md §4): without a database the registry defaults decide reachability.
  if (wantsProofs(argv) && !argv.includes("--check-proofs")) return runProofCli(argv, defaultProofRoots(cwd), null, cwd);
  const all = smaRows();
  const regionArg = flag(argv, "--region"), status = flag(argv, "--status");
  const region = regionArg === undefined ? undefined : /^\d+$/.test(regionArg) ? SMA_REGIONS[Number(regionArg)] : SMA_REGIONS.find((name) => name.toLowerCase().includes(regionArg.toLowerCase()));
  if (regionArg !== undefined && !region) return { exitCode: 2, stderr: `no region ${regionArg}; regions: ${SMA_REGIONS.map((name, index) => `${index} ${name}`).join("; ")}` };
  const rows = all.filter((row) => (!region || row.region === region) && (!status || (status === "unproven" ? row.status === "have" && !row.proof : status === "unchecked" ? !isChecked(row) : row.status === status)));
  const holes = smaHoles();
  const roots = defaultProofRoots(cwd);
  const checking = argv.includes("--check-proofs");
  const broken = checking ? all.flatMap((row) => (row.proof ? [brokenProof(row.proof, roots)] : [])).filter((x): x is string => !!x) : [];
  const drifted = checking ? all.flatMap((row) => (row.proof ? [proofDrift(row.proof, roots)] : [])).filter((x): x is string => !!x) : [];
  const unjudged = checking ? all.filter((row) => row.proof && unjudgedProof(row.proof, roots)).length : 0;
  const states = argv.includes("--states") ? smaStateCounts(all, roots) : null;
  if (argv.includes("--json")) return { exitCode: holes.length || broken.length ? 1 : 0, stdout: JSON.stringify({ sha: SMA_MAP_SHA, mapped: smaDonePercent(all), checked: smaCheckedPercent(all), counts: smaCounts(all), ...(states ? { states } : {}), rows, holes, broken, unjudged, notMapped: all.filter((row) => !isDone(row)).length }, null, 2) };
  const out = [renderSmaMap(all, region || status ? rows : [])];
  if (states) out.push("", `Proof links (X-2): available ${states.available}, resolved ${states.proofResolved} (${states.proofBroken} broken, ${states.proofUnjudged} unjudged), checked by a contract test ${states.checked}; the four proofs: sma-map --states without --check-proofs.`);
  if (holes.length) out.push("", `Registry holes (${holes.length}):`, ...holes.map((hole) => `  ${hole}`));
  if (broken.length) out.push("", `Broken proofs (${broken.length}):`, ...broken.map((line) => `  ${line}`));
  if (drifted.length) out.push("", `Drifted proofs (${drifted.length}) — they resolve, but no longer where the entry points:`, ...drifted.map((line) => `  ${line}`));
  if (unjudged) out.push("", `Proofs not judged: ${unjudged} point into a repository whose sources this machine does not have${roots.lanePilot ? "" : " (this one included: run the check in a source checkout)"}.`);
  return { exitCode: holes.length || broken.length ? 1 : 0, stdout: out.join("\n") };
}

/** `bb lane-pilot sma-map --live [--days N] [--json]`: which groups of the map left a trace in the plugin's database in the window. */
export function runSmaLiveCli(db: Parameters<typeof readSmaLive>[0], argv: string[], now = Date.now(), cwd: string = process.cwd()): Result {
  // --states / --gaps / --hollow with --live: the hub's settings, node-level traces and the live hollow signs. The
  // group-level trace below stays a separate, weaker signal (groupObserved), never node evidence.
  if (wantsProofs(argv)) return runProofCli(argv, defaultProofRoots(cwd), db as never, cwd, now);
  const days = Math.max(1, Math.min(365, Number(flag(argv, "--days") ?? 7) || 7));
  const rows = readSmaLive(db, smaGroups(SMA_NODES as never, SMA_REGIONS), now - days * 86_400_000);
  if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify({ days, rows }, null, 2) };
  return { exitCode: 0, stdout: renderSmaLive(rows, days, now) };
}
