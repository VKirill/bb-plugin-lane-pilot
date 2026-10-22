import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { STAGE_PROOF } from "@lane-pilot/contracts";
import { COVERAGE } from "../src/rooms/coverage/registry";
import { rpcContract } from "../src/rooms/contracts";
import { MEMORY_PATHS } from "../src/rooms/memory/memory-paths";
import { TRANSITION_TABLE } from "../src/rooms/runs/state-machine";
import type { AtlasInput } from "../src/rooms/atlas";

/** The atlas's input read from the checkout: the rooms on disk and the registries in code. */
export function collectAtlasInput(root: string): AtlasInput {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" || name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
  const lines = (path: string) => readFileSync(path, "utf8").split("\n").length;
  const roomsDir = join(root, "src/rooms");
  const rooms = readdirSync(roomsDir).filter((name) => statSync(join(roomsDir, name)).isDirectory()).sort().map((name) => {
    const own = files(join(roomsDir, name));
    let index = "";
    try { index = readFileSync(join(roomsDir, name, "index.ts"), "utf8"); } catch { /* a room without a public index */ }
    const publicExports = [...index.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)].flatMap((hit) => hit[1]!.split(",").map((item) => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim()).filter(Boolean)).sort();
    const coverage = COVERAGE.filter((entry) => entry.kind === "room" && entry.ids.includes(name)).map((entry) => entry.live?.length ? `drill: ${entry.live.join(", ")}` : `tests (${entry.tests?.length ?? 0})`).join("; ");
    return { name, files: own.length, lines: own.reduce((sum, path) => sum + lines(path), 0), publicExports, coverage };
  });
  const all = [...files(roomsDir), ...files(join(root, "packages"))];
  return {
    rooms,
    stages: Object.entries(STAGE_PROOF).map(([id, proof]) => ({ id, kind: proof.kind, what: "check" in proof ? proof.check : proof.reason })),
    transitions: TRANSITION_TABLE.map((row) => ({ from: row.from, event: row.event, to: row.to })),
    memoryPaths: MEMORY_PATHS.map((path) => ({ id: path.id, consumer: path.consumer, carries: path.carries })),
    rpc: Object.keys(rpcContract),
    largestFiles: all.map((path) => ({ path: relative(root, path), lines: lines(path) })).sort((a, b) => b.lines - a.lines).slice(0, 25),
  };
}
