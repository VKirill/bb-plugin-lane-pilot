import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";
import { buildGraph, findCycles, roomOf, runtimeClosure, type Graph } from "../../scripts/refactor/graph";

/**
 * Import boundaries of the plugin, checked on every `npx vitest run` (the deploy gate runs it too).
 * The graph is built with the TypeScript API from scripts/refactor/graph.ts; no new dependency.
 * ALLOW_* lists only shrink: every entry names the cleanup that removes it.
 */

const graph: Graph = buildGraph();
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const isNode = (spec: string) => spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0]!);

/** Value-level import cycles that still exist. Empty since the two known ones were cut. */
const ALLOW_CYCLES = new Set<string>([]);

const production = (file: string) => !file.startsWith("tests/") && !file.startsWith("scripts/");

describe("import boundaries", () => {
  it("has no value-level import cycles beyond the allowlist", () => {
    const cycles = findCycles(graph, production).filter((c) => !ALLOW_CYCLES.has(c.join(">")));
    expect(cycles.map((c) => c.join(" > "))).toEqual([]);
  });

  it("keeps packages free of the plugin sources", () => {
    const bad: string[] = [];
    for (const file of graph.files) {
      if (!file.startsWith("packages/") || file.includes("/tests/")) continue;
      const self = roomOf(file);
      for (const ref of graph.refs.get(file) ?? []) {
        if (!ref.to) continue;
        const target = roomOf(ref.to);
        if (!target || !target.startsWith("@")) bad.push(`${file} -> ${ref.to}`);
        else if (target !== self && ref.spec.startsWith(".")) bad.push(`${file} -> ${ref.to} (reach into another package by path, use @lane-pilot/${target.slice(1)})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps node: builtins out of the UI bundle", () => {
    const closure = runtimeClosure(graph, "app.tsx");
    const bad: string[] = [];
    for (const file of closure) {
      for (const ref of graph.refs.get(file) ?? []) if (!ref.typeOnly && !ref.to && isNode(ref.spec)) bad.push(`${file} imports ${ref.spec}`);
    }
    expect(bad).toEqual([]);
    expect(closure.size).toBeGreaterThan(50);
  });

  it("keeps the UI and the server from importing each other", () => {
    const bad: string[] = [];
    for (const file of graph.files) {
      if (!production(file)) continue;
      const ui = /(^|\/)ui\//.test(file) && !file.startsWith("components/") && !file.startsWith("packages/");
      const server = /(^|\/)server\//.test(file);
      for (const ref of graph.refs.get(file) ?? []) {
        if (!ref.to || ref.typeOnly) continue;
        if (ui && /^src\/(rooms\/[^/]+\/)?server\//.test(ref.to)) bad.push(`${file} -> ${ref.to}`);
        if (server && /^src\/(rooms\/[^/]+\/)?ui\//.test(ref.to)) bad.push(`${file} -> ${ref.to}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("builds the three entries from files that exist and import something", () => {
    for (const entry of ["server.ts", "host.ts", "app.tsx"]) {
      expect(graph.files, entry).toContain(entry);
      expect(runtimeClosure(graph, entry).size, entry).toBeGreaterThan(20);
    }
  });
});
