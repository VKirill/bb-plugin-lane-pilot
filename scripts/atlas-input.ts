import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { STAGE_PROOF } from "@lane-pilot/contracts";
import { COVERAGE } from "../src/rooms/coverage/registry";
import { rpcContract } from "../src/rooms/contracts";
import { MEMORY_PATHS } from "../src/rooms/memory/memory-paths";
import { TRANSITION_TABLE } from "../src/rooms/contracts/state-machine";
import { SETTING_CATALOG } from "../packages/settings-catalog/src/channels";
import { featureRegistry } from "../src/rooms/native-install";
import type { AtlasInput } from "./atlas";

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
  const all = [...files(roomsDir), ...files(join(root, "packages"))].filter((path) => !path.includes("/node_modules/"));
  const cliSource = readFileSync(join(root, "src/rooms/tools/server/cli.ts"), "utf8");
  const cli = [...cliSource.matchAll(/\{ name:"([a-z0-9-]+)", summary:"((?:[^"\\]|\\.)*)"/g)].map((hit) => ({ name: hit[1]!, summary: hit[2]!.replace(/\\"/g, '"') }));
  const graphs = readdirSync(join(root, "workflows")).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const graph = JSON.parse(readFileSync(join(root, "workflows", name), "utf8")) as { id: string; name?: { en?: string } | string; status?: string; description?: { en?: string } | string };
    const en = (value: { en?: string } | string | undefined) => typeof value === "string" ? value : value?.en ?? "";
    return { id: graph.id, name: en(graph.name), status: graph.status ?? "—", description: en(graph.description) };
  });
  const packages = readdirSync(join(root, "packages")).filter((name) => statSync(join(root, "packages", name)).isDirectory()).sort();
  const tests = (dir: string): number => readdirSync(dir).reduce((sum, name) => {
    const path = join(dir, name);
    if (name === "node_modules") return sum;
    return sum + (statSync(path).isDirectory() ? tests(path) : /\.test\.tsx?$/.test(name) ? 1 : 0);
  }, 0);
  const sourceFiles = [...all, ...["server.ts", "host.ts", "app.tsx"].map((name) => join(root, name))];
  // The registry is built at runtime from the bundled agents and the hook streams: ask the function, never the source text.
  const capabilities = featureRegistry().map((row) => ({
    id: row.id,
    runtimes: (["claude", "opencode"] as const).filter((runtime) => [row.agents, row.skills, row.hooks].some((part) => (part[runtime] ?? []).length > 0)).length,
    agents: Object.values(row.agents).flat().length, skills: Object.values(row.skills).flat().length, hooks: Object.values(row.hooks).flat().length,
  }));
  return {
    rooms,
    capabilities,
    stages: Object.entries(STAGE_PROOF).map(([id, proof]) => ({ id, kind: proof.kind, what: "check" in proof ? proof.check : proof.reason })),
    transitions: TRANSITION_TABLE.map((row) => ({ from: row.from, event: row.event, to: row.to })),
    memoryPaths: MEMORY_PATHS.map((path) => ({ id: path.id, consumer: path.consumer, carries: path.carries })),
    rpc: Object.keys(rpcContract),
    cli,
    graphs,
    packages,
    size: {
      version: (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version,
      settings: Object.keys(SETTING_CATALOG).length,
      testFiles: ["tests", "src", "packages"].reduce((sum, dir) => sum + tests(join(root, dir)), 0),
      sourceLines: sourceFiles.reduce((sum, path) => sum + lines(path), 0),
    },
    largestFiles: all.map((path) => ({ path: relative(root, path), lines: lines(path) })).sort((a, b) => b.lines - a.lines).slice(0, 25),
  };
}
