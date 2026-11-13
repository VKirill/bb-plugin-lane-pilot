import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROLE_ID_ALIASES, ROLE_NAMES, ROLE_NAME_IDS, canonicalRoleId, en, ru, roleDisplayName, roleLabel,
} from "@lane-pilot/i18n";
import { COUNCIL_SEATS, ROLE_IDS, ROLE_SPECS, ROLE_TABLE, WRITER_FALLBACK_SLOTS, roleModelOption } from "@lane-pilot/models";
import { CODEX_LEAN_PROFILES } from "../src/rooms/contracts/codex-lean";
import { HELPER_ROLES, HELPER_SPAWN_ROLES } from "../src/rooms/contracts/helper-context";
import { STOCK_AGENT_SEED_DESCRIPTIONS } from "../src/rooms/contracts/agent-display";
import { ERRAND_KINDS, errandKindRole } from "../src/rooms/schedule/errand-kinds";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const doc = read("docs/agents.md");

/** Roles in graph steps that are not agents: the owner's own step and a template placeholder. */
const NOT_AN_AGENT = new Set(["owner", "string"]);

function graphRoles(): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "role" && typeof inner === "string" && !inner.includes("{{") && !NOT_AN_AGENT.has(inner)) found.add(inner);
      else walk(inner);
    }
  };
  for (const file of readdirSync(new URL("../workflows/", import.meta.url)).filter((name) => name.endsWith(".json"))) walk(JSON.parse(read(`workflows/${file}`)));
  return [...found].sort();
}

/** Every id of an agent, judge or profile the code knows, from the tables the code itself reads. */
function knownIds(): string[] {
  return [...new Set([
    ...ROLE_IDS,
    ...HELPER_ROLES,
    ...HELPER_SPAWN_ROLES,
    ...ROLE_SPECS.flatMap((spec) => [spec.accessRole, spec.tableRole].filter((id): id is string => Boolean(id))),
    ...COUNCIL_SEATS.map((seat) => `council.${seat}`),
    ...WRITER_FALLBACK_SLOTS.map((slot) => `writer.fallback${slot}`),
    ...ERRAND_KINDS.map((kind) => errandKindRole(kind)),
    ...CODEX_LEAN_PROFILES.map((name) => `codex-profile:${name}`),
    ...Object.keys(STOCK_AGENT_SEED_DESCRIPTIONS),
    ...graphRoles(),
    // Thread roles the code writes that are not in a table above.
    "emergency-writer", "project-life-maintainer", "memory-maintainer", "gate-triage", "night-reviewer",
    "memory-judge", "jev",
  ])].sort();
}

describe("the one map of agent names", () => {
  it("gives every id the code knows a name", () => {
    const missing = knownIds().filter((id) => canonicalRoleId(id) === null);
    expect(missing).toEqual([]);
  });

  it("never gives two entries one name, in either language", () => {
    for (const lang of ["ru", "en"] as const) {
      const seen = new Map<string, string>();
      for (const id of ROLE_NAME_IDS) {
        const name = ROLE_NAMES[id][lang].trim().toLowerCase();
        expect(name, `${lang} name of ${id}`).not.toBe("");
        expect(seen.get(name), `${lang} name «${ROLE_NAMES[id][lang]}» of ${id} is also the name of ${seen.get(name)}`).toBeUndefined();
        seen.set(name, id);
      }
    }
  });

  it("keeps aliases apart from entries and pointing at a real entry", () => {
    for (const [alias, target] of Object.entries(ROLE_ID_ALIASES)) {
      expect(Object.prototype.hasOwnProperty.call(ROLE_NAMES, alias), `${alias} is both an alias and an entry`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(ROLE_NAMES, target), `${alias} points at ${target}`).toBe(true);
    }
  });

  it("marks a Codex config profile as a profile, never as an agent", () => {
    for (const profile of CODEX_LEAN_PROFILES) expect(ROLE_NAMES[`codex-profile:${profile}` as keyof typeof ROLE_NAMES].kind).toBe("profile");
    const writer = ROLE_NAMES.writer;
    expect(writer.kind).toBe("agent");
    expect(ROLE_NAMES["codex-profile:code"].ru).not.toBe(writer.ru);
    expect(ROLE_NAMES["codex-profile:code"].ru).not.toMatch(/писател/i);
  });

  it("answers by name, with the id kept for a command line", () => {
    expect(roleDisplayName("writer")).toBe("Исполнитель кода");
    expect(roleDisplayName("specialist:design-lead")).toBe("Дизайнер");
    expect(roleDisplayName("gate-triage", "en")).toBe("Failure triager");
    expect(roleDisplayName("a-role-nobody-named")).toBe("a-role-nobody-named");
    expect(roleLabel("council.chair")).toBe("Председатель совета (council.chair)");
    expect(roleLabel("council")).toBe("Председатель совета (council)");
  });

  it("is what the dictionaries show for a role", () => {
    const ruNames = new Set(ROLE_NAME_IDS.map((id) => ROLE_NAMES[id].ru));
    const enNames = new Set(ROLE_NAME_IDS.map((id) => ROLE_NAMES[id].en));
    const prefixes = ["accessName_", "roleModelName_", "settingCouncilSeat_"];
    for (const key of Object.keys(en).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))) {
      expect(enNames.has((en as Record<string, string>)[key]!), `en ${key}`).toBe(true);
      expect(ruNames.has((ru as Record<string, string>)[key]!), `ru ${key}`).toBe(true);
    }
    // The writer is one name on every screen.
    expect(ru.accessName_writer).toBe(ROLE_NAMES.writer.ru);
    expect(ru.helperRole_writer).toBe(ROLE_NAMES.writer.ru);
    expect(ru.agentDisplayDevOrchestrator).toBe(ROLE_NAMES["dev-orchestrator"].ru);
  });
});

describe("docs/agents.md", () => {
  it("lists every id of the map and every alias", () => {
    const missing = [...ROLE_NAME_IDS, ...Object.keys(ROLE_ID_ALIASES)].filter((id) => !doc.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  it("lists every id the code knows", () => {
    expect(knownIds().filter((id) => !doc.includes(`\`${id}\``))).toEqual([]);
  });

  it("gives every display name once in the table «who is who»", () => {
    const table = doc.slice(doc.indexOf("## Таблица: кто есть кто"), doc.indexOf("### Другие id"));
    for (const id of ROLE_NAME_IDS) {
      const row = table.split("\n").find((line) => line.includes(`| \`${id}\` |`));
      expect(row, `row of ${id}`).toBeDefined();
      expect(row!.startsWith(`| ${ROLE_NAMES[id].ru}`), `name of ${id}`).toBe(true);
    }
  });

  it("shows the built-in model of every row of the role table", () => {
    const table = doc.slice(doc.indexOf("## Таблица: кто есть кто"), doc.indexOf("### Другие id"));
    for (const row of ROLE_TABLE) {
      const id = canonicalRoleId(row.id)!;
      const line = table.split("\n").find((entry) => entry.includes(`| \`${id}\` |`));
      expect(line, `row of ${row.id}`).toBeDefined();
      const option = roleModelOption(row.default.model)!;
      expect(line!, `${row.id} default`).toContain(`${option.label} ${row.default.effort}`);
      if (row.fallback) expect(line!, `${row.id} fallback`).toContain(`${roleModelOption(row.fallback.model)!.label} ${row.fallback.effort}`);
    }
  });

  it("names every graph of the night table that exists", () => {
    const graphs = readdirSync(new URL("../workflows/", import.meta.url)).map((file) => file.replace(/\.json$/, ""));
    const named = [...doc.matchAll(/^\| `((?:lp\.|sp-|lead-)[^`]+)` \|/gm)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(8);
    for (const graph of named) expect(graphs, graph).toContain(graph);
  });

  it("is linked from the README and the docs index", () => {
    expect(read("README.md")).toContain("docs/agents.md");
    expect(read("docs/index.md")).toContain("(agents.md)");
  });
});
