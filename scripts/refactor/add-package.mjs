// Register a hand-written workspace package: package-lock entries and the node_modules link of this checkout.
//   node scripts/refactor/add-package.mjs <name>
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const name = process.argv[2];
if (!name) throw new Error("usage: add-package.mjs <name>");
const pj = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
const lockPath = join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
let entries = Object.entries(lock.packages);
for (const [key, value] of [
  [`node_modules/@lane-pilot/${name}`, { resolved: `packages/${name}`, link: true }],
  [`packages/${name}`, { name: pj.name, version: pj.version, ...(pj.license ? { license: pj.license } : {}) }],
]) {
  if (key in lock.packages) continue;
  const at = entries.findIndex(([k]) => k !== "" && k > key && k.startsWith("packages/") === key.startsWith("packages/"));
  const pos = at === -1 ? (key.startsWith("packages/") ? entries.length : entries.findIndex(([k]) => k.startsWith("packages/"))) : at;
  entries = [...entries.slice(0, pos), [key, value], ...entries.slice(pos)];
}
lock.packages = Object.fromEntries(entries);
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
const link = join(root, "node_modules/@lane-pilot", name);
if (existsSync(join(root, "node_modules/@lane-pilot")) && !existsSync(link)) symlinkSync(`../../packages/${name}`, link);
console.log("registered @lane-pilot/" + name);
