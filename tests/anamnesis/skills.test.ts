import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnamnesisCli } from "../../src/anamnesis/cli";
import { anamnesisHandler } from "../../src/anamnesis/host";
import { createHub } from "../../src/anamnesis/hub";
import type { AnamnesisRecord } from "../../src/anamnesis/model";
import { currentLevel, levelAt, levelFor, skillSeries, stepsOf } from "../../src/anamnesis/skills";
import { scanGit } from "../../src/anamnesis/sources/git";
import { renderWhoami, type WhoamiRecord } from "../../src/anamnesis/whoami";
import { renderYearReview } from "../../src/anamnesis/year-review";

const NOW = Date.UTC(2026, 9, 8);

describe("skill levels from commit counts (A7)", () => {
  it("needs enough commits, months and repositories for each level", () => {
    expect(levelFor({ commits: 2, months: 1, repos: 1 })).toBeNull();
    expect(levelFor({ commits: 3, months: 1, repos: 1 })).toBe("familiar");
    expect(levelFor({ commits: 100, months: 1, repos: 1 })).toBe("familiar");   // one burst in one month is not mastery
    expect(levelFor({ commits: 15, months: 2, repos: 1 })).toBe("applies");
    expect(levelFor({ commits: 60, months: 3, repos: 1 })).toBe("applies");     // one repository caps it
    expect(levelFor({ commits: 60, months: 3, repos: 2 })).toBe("confident");
    expect(levelFor({ commits: 250, months: 6, repos: 3 })).toBe("expert");
  });

  it("builds a series that only goes up and records the month each level was reached", () => {
    const steps = skillSeries({ "2026-01": 2, "2026-02": 2, "2026-03": 12, "2026-04": 0, "2026-05": 50, "2026-06": 1 }, 2);
    expect(steps.map((s) => [s.month, s.level])).toEqual([["2026-02", "familiar"], ["2026-03", "applies"], ["2026-05", "confident"]]);
    expect(currentLevel(steps)).toBe("confident");
    expect(levelAt(steps, "2026-01")).toBeNull();
    expect(levelAt(steps, "2026-04")).toBe("applies");
    expect(levelAt(steps, "2027-01")).toBe("confident");
    expect(skillSeries({}, 1)).toEqual([]);
  });

  it("reads stored levels and ignores anything malformed", () => {
    expect(stepsOf({ levels: [{ month: "2026-03", level: "applies", commits: 15 }, { month: 5 }, { month: "2026-04", level: "wizard" }, null] })).toEqual([{ month: "2026-03", level: "applies", commits: 15 }]);
    expect(stepsOf({})).toEqual([]);
  });

  it("the source reads the commits of a repository into months and a level series, and keeps no commit text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anamnesis-skill-"));
    const repo = join(dir, "proj");
    mkdirSync(repo, { recursive: true });
    const run = (args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env }, stdio: "pipe" });
    run(["init", "-q"]);
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(repo, `f${i}.ts`), `export const v${i} = ${i};`);
      run(["add", "-A"]);
      const date = new Date(Date.UTC(2026, i < 8 ? 2 : 4, 1 + i, 12)).toISOString();
      run(["-c", "commit.gpgsign=false", "commit", "-q", "-m", `secret message ${i}`], { GIT_AUTHOR_NAME: "O", GIT_AUTHOR_EMAIL: "owner@example.com", GIT_COMMITTER_NAME: "O", GIT_COMMITTER_EMAIL: "owner@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    }
    const scan = await scanGit({ roots: [dir], authors: ["owner@example.com"], since: 0, until: NOW, home: dir });
    const skill = scan.records.find((record) => record.kind === "skill")!;
    expect(skill.attributes).toMatchObject({ byMonth: { "2026-03": 8, "2026-05": 12 }, level: "applies", levels: [{ month: "2026-03", level: "familiar", commits: 8 }, { month: "2026-05", level: "applies", commits: 20 }] });
    expect(JSON.stringify(scan.records)).not.toContain("secret message");
  });
});

let n = 0;
const rec = (over: Partial<AnamnesisRecord> & { evidence?: WhoamiRecord["evidence"] }): WhoamiRecord => ({
  id: `x:${++n}`, kind: "fact", title: `title ${n}`, statement: "", attributes: {}, sensitivity: "private", confidence: 0.9, status: "confirmed",
  firstSeen: Date.UTC(2026, 1, 1), lastSeen: Date.UTC(2026, 8, 1), manualAt: 0, createdAt: NOW, updatedAt: NOW, evidenceCount: 3, ...over,
});

describe("the year review", () => {
  const SET: WhoamiRecord[] = [
    rec({ kind: "skill", title: "TypeScript", attributes: { level: "expert", levels: [{ month: "2025-06", level: "applies", commits: 20 }, { month: "2026-04", level: "confident", commits: 80 }, { month: "2026-08", level: "expert", commits: 260 }] } }),
    rec({ kind: "skill", title: "Python", attributes: { level: "familiar", levels: [{ month: "2026-05", level: "familiar", commits: 4 }] } }),
    rec({ kind: "skill", title: "Rust", attributes: { level: "applies", levels: [{ month: "2024-02", level: "applies", commits: 30 }] } }),
    rec({ kind: "skill", title: "Blender", attributes: {}, firstSeen: Date.UTC(2026, 6, 3) }),
    rec({ kind: "project", title: "Lane Pilot", statement: "Orchestrator", firstSeen: Date.UTC(2026, 2, 1), lastSeen: Date.UTC(2026, 9, 1), attributes: { origin: "git", byMonth: { "2025-12": 90, "2026-03": 40, "2026-09": 120 } } }),
    rec({ kind: "project", title: "SelfyStudio (messages)", firstSeen: Date.UTC(2026, 4, 1), lastSeen: Date.UTC(2026, 5, 1), attributes: { byMonth: { "2026-05": 999 } } }),
    rec({ kind: "project", title: "Old thing", firstSeen: Date.UTC(2023, 0, 1), lastSeen: Date.UTC(2024, 0, 1) }),
    rec({ kind: "event", title: "First release", firstSeen: Date.UTC(2026, 8, 20) }),
    rec({ kind: "event", title: "Last year's event", firstSeen: Date.UTC(2025, 8, 20) }),
    rec({ kind: "project", title: "Client site", sensitivity: "sensitive" }),
    rec({ kind: "event", title: "Public launch", sensitivity: "public", firstSeen: Date.UTC(2026, 9, 2) }),
    rec({ kind: "skill", title: "Rejected skill", status: "rejected", attributes: { levels: [{ month: "2026-01", level: "expert", commits: 999 }] } }),
  ];

  it("lists skills that grew in the year with both ends, new ones, projects, activity from git only and milestones of that year", () => {
    const { text } = renderYearReview(SET, { year: 2026 });
    expect(text).toContain("Year in review 2026");
    expect(text).toContain("- TypeScript: applies → expert");
    expect(text).toContain("- Python: new, reached familiar");
    expect(text).toContain("- Blender: new (first seen 2026-07)");
    expect(text).not.toContain("Rust");                      // no change in 2026
    expect(text).not.toContain("Rejected skill");
    expect(text).toContain("Lane Pilot (started, 2026-03…2026-10)");
    expect(text).toContain("SelfyStudio (messages)");
    expect(text).not.toContain("Old thing");
    expect(text).toContain("160 commits in 2 active months; busiest 2026-09 (120)");   // the 999 BB messages are not commits, December 2025 is another year
    expect(text).toContain("2026-09-20 First release");
    expect(text).not.toContain("Last year's event");
  });

  it("hides sensitive records and says how many; the public view keeps only what the owner marked public", () => {
    const normal = renderYearReview(SET, { year: 2026 });
    expect(normal.text).not.toContain("Client site");
    expect(normal.hiddenSensitive).toBe(1);
    expect(normal.text).toContain("1 sensitive records are not shown");
    expect(renderYearReview(SET, { year: 2026, includeSensitive: true }).text).toContain("Client site");
    const publicOnly = renderYearReview(SET, { year: 2026, publicOnly: true });
    expect(publicOnly.text).toContain("Public launch");
    expect(publicOnly.text).not.toMatch(/TypeScript|Lane Pilot|sensitive records/);
  });

  it("defaults to the current year and says plainly when a year is empty", () => {
    expect(renderYearReview(SET, { now: NOW }).text).toContain("Year in review 2026");
    expect(renderYearReview(SET, { year: 2019 }).text).toContain("Nothing recorded for this year yet.");
  });

  it("who am I shows the level of a skill", () => {
    const { text } = renderWhoami([SET[0]!], { sections: ["skills"] });
    expect(text).toContain("TypeScript");
    expect(text).toContain("level expert");
  });
});

describe("through the hub, the host and the command", () => {
  const previous = process.env.LANE_PILOT_ANAMNESIS_DIR;
  let hub: ReturnType<typeof createHub>;
  beforeEach(async () => {
    process.env.LANE_PILOT_ANAMNESIS_DIR = mkdtempSync(join(tmpdir(), "anamnesis-year-"));
    hub = createHub({
      hostCall: async (hostId, request) => (await anamnesisHandler({ requestedHostId: hostId, request })).response,
      listHosts: async () => [{ id: "mini", name: "Mac mini", connected: true }], kv: { get: async () => null, set: async () => undefined },
    });
    await hub.ask({ op: "upsert", actor: "auto:git", reason: "t", records: [
      { kind: "skill", key: "lang:Go", title: "Go", attributes: { level: "applies", levels: [{ month: "2026-03", level: "applies", commits: 20 }] }, evidence: [{ source: "git", ref: "a@1", at: Date.UTC(2026, 2, 3) }] },
    ] });
  });
  afterEach(() => { if (previous === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previous; });
  const cli = (argv: string[]) => runAnamnesisCli(argv, { hub, deny: async () => null });

  it("`whoami --year` answers with the review and rejects a bad year", async () => {
    expect((await cli(["whoami", "--year", "2026"])).stdout).toContain("- Go: new, reached applies");
    expect((await cli(["whoami", "--year", "26"])).stderr).toMatch(/calendar year/);
  });
});
