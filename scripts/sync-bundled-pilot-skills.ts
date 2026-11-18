/**
 * Bundles the 11 standardized Pilot skills from `skills/<name>/**` and the current `package.json` version
 * into `src/rooms/pilot-panel/bundled-skills.json` so `dist/server.js` ships them self-contained on the hub
 * without touching `node:fs` at runtime.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PILOT_PROJECT_SKILLS } from "../src/rooms/pilot-panel/contract";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "src/rooms/pilot-panel/bundled-skills.json");

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function walkSkillTextFiles(rootDir: string, currentDir = rootDir): Array<{ relPath: string; content: string; sha256: string }> {
  if (!existsSync(currentDir)) return [];
  const out: Array<{ relPath: string; content: string; sha256: string }> = [];
  for (const entry of readdirSync(currentDir).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(currentDir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkSkillTextFiles(rootDir, full));
    } else if (st.isFile()) {
      const content = readFileSync(full, "utf8");
      const relPath = relative(rootDir, full).replaceAll("\\", "/");
      out.push({ relPath, content, sha256: sha256Hex(content) });
    }
  }
  return out;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const skillsRoot = join(ROOT, "skills");
const bundles = PILOT_PROJECT_SKILLS.map((name) => {
  const dir = join(skillsRoot, name);
  const files = walkSkillTextFiles(dir);
  const skillMd = files.find((f) => f.relPath === "SKILL.md");
  if (!skillMd) throw new Error(`Missing SKILL.md in skills/${name}`);
  const treeSha256 = sha256Hex(files.map((f) => `${f.relPath}:${f.sha256}`).join("\n"));
  return { name, skillMdSha256: skillMd.sha256, treeSha256, files };
});

const payload = JSON.stringify({ pluginVersion: pkg.version, skills: bundles }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== payload) {
    console.error("src/rooms/pilot-panel/bundled-skills.json is stale: run npx tsx scripts/sync-bundled-pilot-skills.ts");
    process.exit(1);
  }
  console.log(`bundled-skills.json fresh (${bundles.length} skills, v${pkg.version})`);
  process.exit(0);
}

writeFileSync(OUT, payload, "utf8");
console.log(`wrote src/rooms/pilot-panel/bundled-skills.json (${bundles.length} skills, v${pkg.version})`);
