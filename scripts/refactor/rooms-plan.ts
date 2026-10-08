// Print what is not mapped to a room yet, find name clashes, and write a move map for a list of rooms.
//   npx tsx scripts/refactor/rooms-plan.ts                       report only
//   npx tsx scripts/refactor/rooms-plan.ts out.json room1 room2  write the move map of these rooms
import { readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { ROOT } from "./graph";
import { ROOM_OF, target } from "./rooms";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "rooms") continue;
    const rel = posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const [out, ...rooms] = process.argv.slice(2);
const files = walk("src");
const unmapped: string[] = [];
const byTarget = new Map<string, string[]>();
const moves: { from: string; to: string }[] = [];
for (const f of files) {
  const t = target(f);
  if (!t) { unmapped.push(f); continue; }
  byTarget.set(t.to, [...(byTarget.get(t.to) ?? []), f]);
  if (rooms.length === 0 || rooms.includes(t.room)) moves.push({ from: f, to: t.to });
}
const clashes = [...byTarget].filter(([, from]) => from.length > 1);
console.log(`${files.length} files in src, ${files.length - unmapped.length} mapped, ${unmapped.length} unmapped`);
if (unmapped.length) console.log("unmapped:\n  " + unmapped.join("\n  "));
if (clashes.length) console.log("clashes:\n  " + clashes.map(([to, from]) => `${to} <- ${from.join(", ")}`).join("\n  "));
const known = new Set(files.map((f) => f.replace(/^src\//, "").replace(/\.(ts|tsx)$/, "")));
const missing = [...ROOM_OF.keys()].filter((k) => !known.has(k) && !files.includes(`src/${k}`));
if (missing.length) console.log("listed but not found:\n  " + missing.join("\n  "));
if (out) {
  writeFileSync(join(ROOT, out), JSON.stringify({ moves }, null, 1) + "\n");
  console.log(`wrote ${moves.length} moves to ${out}`);
}
