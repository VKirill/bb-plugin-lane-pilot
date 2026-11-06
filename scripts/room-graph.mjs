#!/usr/bin/env node
// Room-level import graph of src/rooms: largest strongly connected component,
// mutual room pairs, fan-in/out. `node scripts/room-graph.mjs [--json] [--room x]`.
// The computation is exported for tests/architecture/room-graph.test.ts (the ratchet).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function roomGraph(root) {
  const roomsDir = join(root, "src", "rooms");
  const rooms = readdirSync(roomsDir).filter((n) => statSync(join(roomsDir, n)).isDirectory());

  function* files(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) yield* files(p);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) yield p;
    }
  }
  const roomOf = (abs) => {
    const rel = relative(roomsDir, abs);
    return rel.startsWith("..") ? null : rel.split(sep)[0];
  };

  const edges = new Map(rooms.map((r) => [r, new Set()]));
  const importRe = /(?:import|export)\s[^'";]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  for (const room of rooms) for (const f of files(join(roomsDir, room))) {
    for (const m of readFileSync(f, "utf8").matchAll(importRe)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith(".")) continue;
      const to = roomOf(resolve(dirname(f), spec));
      if (to && to !== room && edges.has(to)) edges.get(room).add(to);
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
