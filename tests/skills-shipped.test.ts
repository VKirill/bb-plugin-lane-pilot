import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintSkillDir, readSkillDir } from "../src/rooms/forge/skill-lint";
import { parseFrontmatter } from "../src/rooms/docs";
import { EMPLOYEES } from "../src/rooms/contracts/native-agent-static";
import { ROLE_PROFILES } from "../src/rooms/contracts/helper-context";
import bundledAgents from "../src/rooms/contracts/bundled-agents.json";

// The skill standard (docs/skill-standard.md) held over the whole skills/ folder: every shipped skill is valid, and every skill
// name the code, the graphs and the prompts load exists in skills/ or in the declared external list (policy/external-skills.json).

const SKILLS_DIR = "skills";
const NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;
const SKILL_MD_MAX_BYTES = 8_192;
const SKILL_MD_MAX_LINES = 500;
const DESCRIPTION_MAX = 1024;

const shipped = readdirSync(SKILLS_DIR).filter((name) => statSync(join(SKILLS_DIR, name)).isDirectory()).sort();
const external = JSON.parse(readFileSync("policy/external-skills.json", "utf8")) as { hub: string[]; plugin: string[]; provider: string[]; children: Record<string, string> };
const externalNames = new Set([...external.hub, ...external.plugin, ...external.provider, ...Object.keys(external.children)]);

describe("shipped skills", () => {
  it("has the skills it should", () => expect(shipped.length).toBeGreaterThan(15));

  for (const name of shipped) {
    describe(name, () => {
      const files = readSkillDir(join(SKILLS_DIR, name));
      const skill = files.find((file) => file.path === "SKILL.md");

      it("has a valid front matter, name = folder, a description with «Use when»", () => {
        expect(skill, "SKILL.md").toBeDefined();
        const data = parseFrontmatter(skill!.text)?.data ?? {};
        const scalar = (value: unknown) => (Array.isArray(value) ? value.join(" ") : String(value ?? ""));
        expect(scalar(data.name)).toBe(name);
        expect(name).toMatch(NAME_RE);
        const description = scalar(data.description);
        expect(description.length).toBeGreaterThan(40);
        expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
        expect(description).toMatch(/use when/i);
      });

      it("front matter values are valid YAML scalars (the hub publisher parses them strictly)", () => {
        const head = skill!.text.split("\n---")[0]!.split("\n").slice(1);
        for (const line of head) {
          const match = /^([a-z][\w-]*):\s(.+)$/.exec(line);
          if (!match) continue;
          const value = match[2]!.trim();
          if (/^[>|][-+]?$/.test(value)) continue; // block scalar: the text follows on indented lines
          if (value.startsWith('"')) expect(() => JSON.parse(value), `${match[1]} is a double-quoted YAML string`).not.toThrow();
          else if (value.startsWith("'")) expect(value.endsWith("'") && !/[^']'[^']/.test(value.slice(1, -1)), `${match[1]} single-quoted`).toBe(true);
          else expect(/: | #|^[[{&*!|>%@`]/.test(value), `${match[1]} needs quotes: plain YAML cannot hold ": "`).toBe(false);
        }
      });

      it("keeps SKILL.md within the size limits", () => {
        expect(Buffer.byteLength(skill!.text, "utf8")).toBeLessThan(SKILL_MD_MAX_BYTES);
        expect(skill!.text.split("\n").length).toBeLessThanOrEqual(SKILL_MD_MAX_LINES);
      });

      it("passes the skill lint with no error", () => expect(lintSkillDir(files).errors).toEqual([]));

      it("links references one level deep, and every one exists", () => {
        const named = [...skill!.text.matchAll(/references\/[A-Za-z0-9_@.+~/-]+/g)].map((m) => m[0].replace(/[.,;:!?)\]]+$/, ""));
        for (const path of named) expect(existsSync(join(SKILLS_DIR, name, path)), `${path} is named but missing`).toBe(true);
        // A file in references/ does not send the reader on to another references/ file.
        const nested = files
          .filter((file) => file.path.startsWith("references/") && /\.md$/.test(file.path))
          .flatMap((file) => [...file.text.matchAll(/\]\(((?:\.\/)?(?:references\/)?[A-Za-z0-9_.-]+\.md)\)|references\/[A-Za-z0-9_.-]+\.md/g)].map((m) => `${file.path} -> ${m[0]}`));
        expect(nested).toEqual([]);
      });
    });
  }
});

/** Names of skills loaded by name, with the place that loads them. */
function referencedSkills(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (skill: string, where: string) => found.set(skill, [...(found.get(skill) ?? []), where]);
  const walk = (node: unknown, where: string) => {
    if (Array.isArray(node)) return node.forEach((item) => walk(item, where));
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "skill" && typeof value === "string") add(value, where);
      else if (key === "skills" && Array.isArray(value)) value.forEach((item) => typeof item === "string" && add(item, where));
      else walk(value, where);
    }
  };
  for (const file of readdirSync("workflows").filter((f) => f.endsWith(".json"))) walk(JSON.parse(readFileSync(join("workflows", file), "utf8")), `workflows/${file}`);
  for (const [role, profile] of Object.entries(ROLE_PROFILES)) profile.skills.forEach((skill) => add(skill, `ROLE_PROFILES.${role}`));
  for (const [id, employee] of Object.entries(EMPLOYEES)) employee.coreSkills.forEach((skill) => add(skill, `EMPLOYEES.${id}`));
  for (const [id, agent] of Object.entries(bundledAgents as Record<string, { skills?: string[]; prompt?: string }>)) {
    (agent.skills ?? []).forEach((skill) => add(skill, `bundled-agents.json#${id}`));
    for (const match of (agent.prompt ?? "").matchAll(/load the skill `([a-z0-9-]+)`|[Ll]oad `([a-z0-9-]+)` first/g)) add(match[1] ?? match[2]!, `bundled-agents.json#${id} prompt`);
  }
  for (const file of ["src/rooms/native-agent/native-agent-overlay.ts", "src/rooms/native-agent/workflow-architect.ts"]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/load the skill \\`([a-z0-9-]+)\\`|[Ll]oad \\`([a-z0-9-]+)\\` first/g)) add(match[1] ?? match[2]!, file);
  }
  return found;
}

describe("skill names the code loads", () => {
  const referenced = referencedSkills();

  it("finds the references it checks", () => expect(referenced.size).toBeGreaterThan(60));

  it("exist in skills/ or in policy/external-skills.json", () => {
    const missing = [...referenced].filter(([skill]) => !shipped.includes(skill) && !externalNames.has(skill)).map(([skill, where]) => `${skill} (${[...new Set(where)].slice(0, 3).join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("does not list in the external file a skill that ships in skills/", () => {
    expect([...externalNames].filter((name) => shipped.includes(name))).toEqual([]);
  });

  it("points every sp.run_script at a script the skill carries", () => {
    const broken: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) return node.forEach((item) => walk(item, where));
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.action === "sp.run_script" && typeof record.skill === "string" && typeof record.script === "string"
        && !existsSync(join(SKILLS_DIR, record.skill, "scripts", record.script))) broken.push(`${where}: ${record.skill}/${record.script}`);
      Object.values(record).forEach((value) => walk(value, where));
    };
    for (const file of readdirSync("workflows").filter((f) => f.endsWith(".json"))) walk(JSON.parse(readFileSync(join("workflows", file), "utf8")), file);
    expect(broken).toEqual([]);
  });
});
