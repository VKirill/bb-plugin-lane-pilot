import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { filterSkillHub, firstSentence, formatSkillList, parseSkillHub, type SkillHub } from "../src/rooms/writer/server/skill-tree";
import { pmSkillName, pmSkillUseCounts, recordPmSkillUse, runPmSkillsCli, runPmSkillUseCli } from "../src/rooms/native-agent/server/pm-skill-use";
import { pmSkillUseOf } from "../src/rooms/session-hooks/logic";
import { openDatabase } from "../src/rooms/storage/database";

const HUB: SkillHub = {
  sections: [
    {
      id: "development", title: "Разработка", titleEn: "Development",
      subsections: [
        { id: "dev-web", title: "Веб-фронтенд и UI", titleEn: "Web front end and UI" },
        { id: "dev-mobile", title: "Мобильные приложения", titleEn: "Mobile apps" },
      ],
    },
    {
      id: "marketing", title: "Маркетинг", titleEn: "Marketing",
      subsections: [{ id: "mk-seo", title: "SEO", titleEn: "SEO" }],
    },
  ],
  skills: [
    { name: "expo-router", description: "Navigation and routing for Expo Router. More detail here.", category: { sectionId: "development", subsectionId: "dev-mobile" } },
    { name: "threejs-fundamentals", description: "Three.js scene setup: scenes and fog, cameras.", category: { sectionId: "development", subsectionId: "dev-web" } },
    { name: "ru-check", description: "Вычитка русского текста по корпусу.", category: null },
    { name: "seo-agent", description: "SEO expert agent: technical SEO audit.", category: { sectionId: "marketing", subsectionId: "mk-seo" } },
  ],
};

describe("pm skill list filter", () => {
  it("matches a section by id, title or subsection name, case-insensitive", () => {
    expect(filterSkillHub(HUB, { section: "development" }).map((sk) => sk.name)).toEqual(["expo-router", "threejs-fundamentals"]);
    expect(filterSkillHub(HUB, { section: "Mobile apps" }).map((sk) => sk.name)).toEqual(["expo-router"]);
    expect(filterSkillHub(HUB, { section: "dev-web" }).map((sk) => sk.name)).toEqual(["threejs-fundamentals"]);
    expect(filterSkillHub(HUB, { section: "nonexistent" })).toEqual([]);
  });

  it("keeps a skill only when every query word hits name, description or section", () => {
    expect(filterSkillHub(HUB, { query: "expo" }).map((sk) => sk.name)).toEqual(["expo-router"]);
    expect(filterSkillHub(HUB, { query: "EXPO navigation" }).map((sk) => sk.name)).toEqual(["expo-router"]);
    expect(filterSkillHub(HUB, { query: "seo" }).map((sk) => sk.name)).toEqual(["seo-agent"]);
    expect(filterSkillHub(HUB, { query: "expo seo" })).toEqual([]);
    const hub = { ...HUB, skills: [{ name: "a-helper", description: "talks to telegram" }, { name: "telegram-user", description: "user account" }] } as typeof HUB;
    expect(filterSkillHub(hub, { query: "telegram" }).map((sk) => sk.name)).toEqual(["telegram-user", "a-helper"]);
  });

  it("formats one line per skill with the first sentence of the description", () => {
    const lines = formatSkillList(filterSkillHub(HUB, {})).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("expo-router — Navigation and routing for Expo Router.");
    expect(firstSentence("No full stop")).toBe("No full stop");
  });

  it("parses the hub shape with the tree nested under `tree`", () => {
    const hub = parseSkillHub(JSON.stringify({ tree: { sections: HUB.sections }, skills: HUB.skills }));
    expect(hub.skills).toHaveLength(4);
    expect(hub.sections[0]!.id).toBe("development");
  });
});

describe("pm skill use", () => {
  it("maps a Skill hook payload to a row and refuses every other tool", () => {
    const env = { LANE_PILOT_PM_THREAD_ID: "thr_pm", LANE_PILOT_PM_PROJECT_ID: "proj" };
    expect(pmSkillUseOf("Skill", { skill: "lane-pilot-ops" }, env)).toEqual({ skill: "lane-pilot-ops", thread: "thr_pm", project: "proj" });
    expect(pmSkillUseOf("Read", { skill: "lane-pilot-ops" }, env)).toBeNull();
    expect(pmSkillUseOf("Skill", { skill: "lane-pilot-ops" }, {})).toBeNull();
    expect(pmSkillUseOf("Skill", {}, env)).toBeNull();
  });

  it("folds the scoped spelling bb-global-skills:name into name", () => {
    expect(pmSkillName("bb-global-skills:lane-pilot-ops")).toBe("lane-pilot-ops");
    expect(pmSkillName("lane-pilot-ops")).toBe("lane-pilot-ops");
  });

  it("records one row per Skill call and counts both spellings as one skill", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const realNow = Date.now();
    recordPmSkillUse(db, { threadId: "thr_a", projectId: "proj", skill: "bb-global-skills:lane-pilot-ops", at: realNow - 1000 });
    recordPmSkillUse(db, { threadId: "thr_b", projectId: "proj", skill: "lane-pilot-ops", at: realNow - 2000 });
    recordPmSkillUse(db, { threadId: "thr_a", projectId: "proj", skill: "ru-check", at: realNow - 20 * 86_400_000 });
    const counts = pmSkillUseCounts(db, { days: 14, now: realNow });
    expect(counts).toEqual([{ skill: "lane-pilot-ops", uses: 2, threads: 2 }]);
    const viaWrite = runPmSkillUseCli(db, ["lane-pilot-ops", "--thread", "thr_a", "--project", "proj"]);
    expect(viaWrite.exitCode).toBe(0);
    expect(runPmSkillUseCli(db, ["--thread", "thr_a"]).exitCode).toBe(1);
    const viaRead = runPmSkillsCli(db, ["--days", "14"]);
    expect(viaRead.stdout).toContain("lane-pilot-ops — 3 (2 threads)");
  });
});

import { parseSkillTree } from "../src/rooms/writer/server/skill-tree";
describe("parseSkillTree", () => {
  it("reads the core's { tree: { sections }, skills } and the old flat shape", () => {
    const skills = [{ name: "a" }];
    expect(parseSkillTree(JSON.stringify({ tree: { sections: [{ id: "dev" }] }, skills })).sections).toEqual([{ id: "dev" }]);
    expect(parseSkillTree(JSON.stringify({ sections: [{ id: "dev" }], skills })).sections).toEqual([{ id: "dev" }]);
    expect(() => parseSkillTree(JSON.stringify({ skills }))).toThrow("skill_tree_shape");
  });
});
