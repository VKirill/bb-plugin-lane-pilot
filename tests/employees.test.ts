import { describe, expect, it } from "vitest";
import { pickWriterSkills, type SkillAsk } from "@lane-pilot/jev/judgments/skill-pick";
import { BB_AGENT_SESSIONS, LANE_PILOT_PM_SESSION, lanePmOverlayPrompt, laneSessionOverlayPrompt } from "../src/rooms/native-agent/native-agent-overlay";
import { EMPLOYEES, coreSkillsOf, isEmployeeSpecialist } from "../src/rooms/native-agent/employee-manifest";
import { SKILL_CATALOG_BLOCK, SKILL_CATALOG_LIMIT, SKILL_CATALOG_LINE } from "../src/rooms/native-agent/skill-catalog";
import { chooseEmployeePlace } from "../src/rooms/native-agent/employee-place";
import { parseAgentFile } from "../src/rooms/native-agent/custom-agent";
import { roleSpec } from "../src/rooms/workflow/server/workflow-agent";
import { errandPrompt } from "../src/rooms/qa/server/errands";
import { writerBriefSegments } from "../src/rooms/writer/server/writer-task";
import { candidateNames, resetSkillTreeCache, skillTreeCached, type SkillTree } from "../src/rooms/writer/server/skill-tree";
import type { TaskV2 } from "../src/rooms/contracts";

const tree: SkillTree = {
  sections: [{
    id: "development",
    title: "Разработка",
    titleEn: "Development",
    subsections: [{ id: "development-games", title: "Игры", titleEn: "Games", description: "Roblox, Godot, Unity and three.js" }],
  }, {
    id: "business",
    title: "Бизнес и документы",
    subsections: [{ id: "billing", title: "Бухгалтерия и ЭДО", description: "invoices and Diadoc" }],
  }],
  skills: [
    { name: "roblox-build", category: { sectionId: "development", subsectionId: "development-games" } },
    { name: "kontur-elba", category: { sectionId: "business", subsectionId: "billing" } },
  ],
};

describe("employee manifest", () => {
  it("gives every employee sections, and at most three core skills", () => {
    expect(isEmployeeSpecialist("roblox-dev")).toBe(false);
    expect(EMPLOYEES["game-dev"]!.skillSections).toEqual([
      "Разработка/Игры",
      "Разработка/3D в браузере",
      "3D и Blender/Жанры игр",
      "3D и Blender/Пайплайн и экспорт",
    ]);
    expect(EMPLOYEES["game-dev"]!.machineAffinity).toBe("mac-mini");
    for (const [id, row] of Object.entries(EMPLOYEES)) {
      expect(row.coreSkills.length, id).toBeLessThanOrEqual(3);
      expect(row.skillSections.length, id).toBeGreaterThan(0);
    }
  });

  it("reads an old skills field as core skills", () => {
    expect(coreSkillsOf({ skills: ["copywriter", "ru-check"] })).toEqual(["copywriter", "ru-check"]);
    expect(coreSkillsOf({ coreSkills: ["a", "b", "c", "d"], skills: ["z"] })).toEqual(["a", "b", "c"]);
    const parsed = parseAgentFile(["---", "skills:", "  - copywriter", "  - ru-check", "---", "Write the page."].join("\n"));
    expect(parsed.coreSkills).toEqual(["copywriter", "ru-check"]);
    expect(parsed.skills).toEqual(["copywriter", "ru-check"]);
  });
});

describe("skill catalog note", () => {
  it("fits the block, and every role overlay carries it (the PM, one line)", () => {
    expect(SKILL_CATALOG_BLOCK.length).toBeLessThanOrEqual(SKILL_CATALOG_LIMIT);
    expect(LANE_PILOT_PM_SESSION).toContain(SKILL_CATALOG_LINE);
    expect(LANE_PILOT_PM_SESSION).not.toContain("## Skill catalog");
    expect(LANE_PILOT_PM_SESSION.length).toBeLessThanOrEqual(20_000);
    expect(lanePmOverlayPrompt("dev-orchestrator")).toContain(SKILL_CATALOG_LINE);
    for (const id of Object.keys(BB_AGENT_SESSIONS)) {
      if (id === "dev-orchestrator") continue;
      expect(laneSessionOverlayPrompt(id), id).toContain("## Skill catalog");
      expect(BB_AGENT_SESSIONS[id]!.length, id).toBeLessThanOrEqual(id === "workflow-architect" ? 12_000 : 2_000);
    }
    const brief = writerBriefSegments({ title: "t", objective: "o", owns_paths: [], expected_outputs: [], acceptance: [], verification: [] } as unknown as TaskV2);
    expect(brief.map((segment) => segment.text).join("\n")).toContain("## Skill catalog");
    expect(errandPrompt({ task: "check the mailbox", browserHostId: null, authorized: false })).toContain("## Skill catalog");
  });
});

describe("writer skill pick from a section", () => {
  it("asks only the skill from the matching section of a fixture tree", async () => {
    const names = candidateNames(tree, "Build a Roblox obby");
    expect(names).toEqual(["roblox-build"]);
    const seen: string[] = [];
    const ask: SkillAsk = async (_state, questions) => {
      for (const question of Object.values(questions)) seen.push(question.instructions);
      return Object.fromEntries(Object.keys(questions).map((id) => [id, { domain: 0.99, yes: 0.9, craft: 0.01, no: 0.01 }]));
    };
    const pick = await pickWriterSkills({
      enabled: true,
      catalog: [
        { name: "roblox-build", description: "Build a Roblox place" },
        { name: "kontur-elba", description: "Invoices in Elba" },
      ],
      hints: [],
      task: { title: "Build a Roblox obby", objective: "A Roblox game", owns_paths: ["src/game.ts"], expected_outputs: [], acceptance: [], verification_commands: [] },
      plan: "obby",
      projectCwd: "/tmp/work",
      ask,
      kindCache: { get: async () => undefined, set: async () => undefined },
      candidates: names,
    });
    expect(pick.skills).toContain("roblox-build");
    expect(pick.skills).not.toContain("kontur-elba");
    expect(seen.join("\n")).toContain("roblox-build");
    expect(seen.join("\n")).not.toContain("kontur-elba");
  });

  it("keeps the old catalog when the tree cannot be read", async () => {
    resetSkillTreeCache();
    let calls = 0;
    const read = async () => { calls += 1; throw new Error("bb down"); };
    expect(await skillTreeCached(read)).toBeNull();
    expect(await skillTreeCached(read)).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("employee machine", () => {
  it("uses the project folder on the affinity host", () => {
    expect(chooseEmployeePlace({
      affinity: "mac-mini",
      agentId: "game-dev",
      sources: [{ hostId: "host_7sea4qaad8", path: "/Users/me/game" }],
      hostHome: "/Users/me",
    })).toEqual({ mode: "folder", hostId: "host_7sea4qaad8", path: "/Users/me/game", created: false });
  });

  it("makes a work folder when that host has no project folder", () => {
    expect(chooseEmployeePlace({
      affinity: "mac-mini",
      agentId: "game-dev",
      sources: [{ hostId: "host_rwrxyi39aw", path: "/srv/app" }],
      hostHome: "/Users/me",
    })).toEqual({ mode: "folder", hostId: "host_7sea4qaad8", path: "/Users/me/LanePilot/employees/game-dev", created: true });
  });

  it("stays on the current environment when affinity is empty, and falls back when the host has no home", () => {
    expect(chooseEmployeePlace({ affinity: "any", agentId: "copy-lead", sources: [], hostHome: "/Users/me" })).toEqual({ mode: "inherit" });
    expect(chooseEmployeePlace({ affinity: null, agentId: "copy-lead", sources: [], hostHome: null })).toEqual({ mode: "inherit" });
    expect(chooseEmployeePlace({ affinity: "mac-mini", agentId: "game-dev", sources: [], hostHome: null })).toMatchObject({ mode: "fallback", hostId: "host_7sea4qaad8" });
  });

  it("treats a bare graph role as that employee", () => {
    expect(roleSpec("game-dev").specialist).toBe("game-dev");
    expect(roleSpec("game-dev").readOnly).toBe(false);
    expect(roleSpec("game-dev").editable(".agents/games/model.rbxm")).toBe(true);
  });
});
