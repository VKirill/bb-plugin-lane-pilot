#!/usr/bin/env node
// Foreign-table SQL ratchet: raw `.prepare(` call sites whose SQL names a lane_pilot_* table owned by another
// room. Owner = the room whose migrations create the table (storage for the composed src/rooms/migrations.ts,
// with overrides for the tables it holds for other owners: memory, usage, stability).
// `node scripts/foreign-sql.mjs` (root resolved from this file, not cwd); also exported for
// tests/architecture/foreign-sql.test.ts.
// What it does NOT see: prepared SQL built by helper wrappers (`count(sql)` in owner-waiting/items.ts),
// `.exec(`/`.transaction(` bodies, and dynamically composed SQL.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TABLE_RE = /lane_pilot_\w+/g;
const CREATE_RE = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(lane_pilot_\w+)/gi;

const isTs = (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n);

function* walk(dir) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (isTs(n)) yield p;
  }
}

export function foreignSql(root) {
  const roomsDir = join(root, "src", "rooms");
  const roomDirs = new Set(readdirSync(roomsDir).filter((n) => statSync(join(roomsDir, n)).isDirectory()));

  const roomOf = (abs) => {
    const rel = relative(roomsDir, abs);
    if (!rel.startsWith("..")) {
      const parts = rel.split(sep);
      return parts.length > 1 && roomDirs.has(parts[0]) ? parts[0] : `@${parts[0]}`;
    }
    if (relative(root, abs) === "server.ts") return "^server.ts";
    const pkg = /packages\/([^/]+)\/src\//.exec(abs);
    if (pkg) return `pkg:${pkg[1]}`;
    return `^${relative(root, abs)}`;
  };

  const files = [
    join(root, "server.ts"),
    ...walk(join(root, "src")),
    ...walk(join(root, "packages")),
  ].filter((p) => statSync(p).isFile());

  // table -> owner room. src/rooms/migrations.ts holds the storage room's schema; the two tables it creates
  // for other owners are overridden.
  const owner = new Map();
  for (const file of files) {
    const room = roomOf(file) === "@migrations.ts" ? "storage" : roomOf(file);
    for (const m of readFileSync(file, "utf8").matchAll(CREATE_RE)) {
      const table = m[1];
      if (!owner.has(table)) owner.set(table, room);
    }
  }
  // Tables src/rooms/migrations.ts holds for other owners, and the memory corpus that both the memory room and
  // packages/memory-core own (the package is the table's engine, the room its service).
  for (const table of [...owner.keys()]) {
    if (table === "lane_pilot_token_daily" || table === "lane_pilot_token_cursor") owner.set(table, new Set(["usage"]));
    else if (table.startsWith("lane_pilot_memory")) owner.set(table, new Set(["memory", "pkg:memory-core"]));
    else if (!(owner.get(table) instanceof Set)) owner.set(table, new Set([owner.get(table)]));
  }

  const sites = [];
  for (const file of files) {
    const room = roomOf(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\.prepare\(/g)) {
      const start = m.index;
      // The SQL literal ends where the prepared call is consumed or the statement closes.
      const end = text.slice(start, start + 4000).search(/\)\s*\.\s*(?:get|all|run|pluck|iterate)|\)\s*;/);
      const sql = text.slice(start, end === -1 ? start + 4000 : start + end);
      if (sql.length > 4000) continue;
      const tables = [...sql.matchAll(TABLE_RE)].map((t) => t[0]);
      const foreign = [...new Set(tables)].filter((table) => !owner.get(table)?.has(room));
      if (foreign.length) {
        const line = text.slice(0, start).split("\n").length;
        sites.push({ file: relative(root, file), line, tables: foreign });
      }
    }
  }
  const byOwner = {};
  for (const site of sites) for (const table of site.tables) byOwner[table] = (byOwner[table] ?? 0) + 1;
  return { count: sites.length, sites, byOwner };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const out = foreignSql(new URL("..", import.meta.url).pathname);
  console.log(JSON.stringify({ count: out.count, byOwner: out.byOwner }, null, 2));
}
