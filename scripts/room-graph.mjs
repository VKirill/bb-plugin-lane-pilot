#!/usr/bin/env node
// Granularity: room-level. Room-level import graph of src/rooms: largest strongly connected component,
// mutual room pairs, fan-in/out. Used by tests/architecture/room-graph.test.ts (the ratchet).
// `node scripts/room-graph.mjs [--json] [--room x]`. The computation is exported for that test.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function roomGraph(root) {
  const roomsDir = join(root, "src", "rooms");
  const entries = readdirSync(roomsDir);
  const isTs = (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n);
  // Loose files directly under src/rooms/ are graph nodes of their own, named @<file>:
  // a cycle through them (e.g. storage -> ../migrations -> owner rooms -> storage) must show up.
  const looseFiles = new Set(entries.filter((n) => statSync(join(roomsDir, n)).isFile() && isTs(n)));
  const rooms = [
    ...entries.filter((n) => statSync(join(roomsDir, n)).isDirectory()),
    ...[...looseFiles].map((n) => `@${n}`),
  ];
  const nodeNames = new Set(rooms);
  const roomDirs = new Set(rooms.filter((r) => !r.startsWith("@")));

  function* files(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) yield* files(p);
      else if (isTs(n)) yield p;
    }
  }
  const roomOf = (abs) => {
    const rel = relative(roomsDir, abs);
    if (rel.startsWith("..")) return null;
    const parts = rel.split(sep);
    if (parts.length > 1) return parts[0];
    const base = parts[0];
    if (roomDirs.has(base)) return base;
    for (const cand of [base, `${base}.ts`, `${base}.tsx`]) {
      if (looseFiles.has(cand)) return `@${cand}`;
    }
    return null;
  };

  const edges = new Map(rooms.map((r) => [r, new Set()]));
  const importRe = /(?:import|export)\s[^'";]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  // A code file outside src/rooms that a room imports (server.ts, plugin-contracts.ts, scripts/*) is a node
  // of its own, named ^<path>, scanned like a room: a room reaching up into the composition root through it
  // (even type-only) must show up, not vanish.
  const codeFile = (abs) => {
    for (const cand of [abs, `${abs}.ts`, `${abs}.tsx`, join(abs, "index.ts")]) {
      try { if (statSync(cand).isFile() && isTs(cand)) return cand; } catch {}
    }
    return null;
  };
  const scannedOf = new Map(rooms.map((r) => [r, r.startsWith("@") ? [join(roomsDir, r.slice(1))] : [...files(join(roomsDir, r))]]));
  const queue = [...rooms];
  while (queue.length) {
    const node = queue.shift();
    for (const f of scannedOf.get(node)) {
      for (const m of readFileSync(f, "utf8").matchAll(importRe)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!spec.startsWith(".")) continue;
        const abs = resolve(dirname(f), spec);
        let to = roomOf(abs);
        if (!to) {
          const file = codeFile(abs);
          if (!file || relative(root, file).startsWith("..") || file.includes(`${sep}node_modules${sep}`)) continue;
          to = `^${relative(root, file).split(sep).join("/")}`;
          if (!nodeNames.has(to)) { nodeNames.add(to); rooms.push(to); edges.set(to, new Set()); scannedOf.set(to, [file]); queue.push(to); }
        }
        if (to !== node && nodeNames.has(to)) edges.get(node).add(to);
      }
    }
  }

  let n = 0;
  const idx = new Map(), low = new Map(), stack = [], on = new Set(), sccs = [];
  const visit = (v) => {
    idx.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const w of edges.get(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = []; let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      sccs.push(c);
    }
  };
  for (const r of rooms) if (!idx.has(r)) visit(r);

  const biggest = sccs.sort((a, b) => b.length - a.length)[0] ?? [];
  const mutual = [];
  for (const [a, tos] of edges) for (const b of tos) if (a < b && edges.get(b).has(a)) mutual.push([a, b]);
  const fanIn = new Map(rooms.map((r) => [r, 0]));
  for (const tos of edges.values()) for (const t of tos) fanIn.set(t, fanIn.get(t) + 1);
  const summary = { rooms: rooms.length, largestScc: biggest.length, mutualPairs: mutual.length,
    edges: [...edges.values()].reduce((s, e) => s + e.size, 0) };
  return { summary, scc: biggest.sort(), mutual, rooms, edges, fanIn };
}

const entry = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (entry) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { summary, scc, mutual, rooms, edges, fanIn } = roomGraph(root);
  const args = process.argv.slice(2);
  const one = args.includes("--room") ? args[args.indexOf("--room") + 1] : null;
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...summary, scc, mutual,
      rooms: Object.fromEntries(rooms.map((r) => [r, { out: [...edges.get(r)].sort(), fanIn: fanIn.get(r) }])) }, null, 2));
  } else if (one) {
    console.log(`${one} imports: ${[...edges.get(one)].sort().join(", ")}`);
    console.log(`imported by: ${rooms.filter((r) => edges.get(r).has(one)).join(", ")}`);
  } else {
    console.log(summary);
    const top = rooms.map((r) => [r, edges.get(r).size, fanIn.get(r)]).sort((a, b) => b[1] + b[2] - a[1] - a[2]).slice(0, 12);
    for (const [r, o, i] of top) console.log(`${r.padEnd(22)} out ${String(o).padStart(3)}  in ${String(i).padStart(3)}`);
  }
}
