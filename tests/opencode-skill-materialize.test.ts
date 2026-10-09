import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillMaterializer, OPENCODE_SKILLS_EXCLUDE, parseMaterialized, recordedMaterializedSkills,
} from "../src/rooms/writer/server/skill-materialize";
import { WORKSPACE_DIRT_COMMAND } from "../src/rooms/verification/workspace-dirt";

type Call = { command: string; cwd: string };

/** A machine that runs each command with sh in its folder, as the BB host would. */
function localHost(calls: Call[] = [], override?: (command: string) => { exitCode: number; stderr: string } | null) {
  return {
    call: async (method: string, input: Call) => {
      if (method !== "runCommand") throw new Error(`unexpected host call ${method}`);
      calls.push({ command: input.command, cwd: input.cwd });
      const failed = override?.(input.command);
      if (failed) return { hostId: "h", exitCode: failed.exitCode, stdout: "", stderr: failed.stderr };
      const ran = spawnSync("sh", ["-c", input.command], { cwd: input.cwd, encoding: "utf8" });
      return { hostId: "h", exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
    },
  };
}

let base: string;
let worktree: string;
let skillSource: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "lp-skill-materialize-"));
  worktree = join(base, "worktree");
  mkdirSync(worktree);
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  writeFileSync(join(worktree, "app.ts"), "export {};\n");
  skillSource = join(base, "catalog", "tavily");
  mkdirSync(skillSource, { recursive: true });
  writeFileSync(join(skillSource, "SKILL.md"), "---\nname: tavily\ndescription: Web search\n---\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const picked = { attemptId: "a1", hostId: "h", workspacePath: "", live: false, providerId: "acp-opencode", skills: ["tavily"], sources: {} as Record<string, string> };

describe("OpenCode writer skills", () => {
  it("links the picked skills under .opencode/skills before the writer starts, excluded from git", async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const materializer = createSkillMaterializer({ host: localHost(calls) }, (message) => logs.push(message));
    const result = await materializer.materialize({ ...picked, workspacePath: worktree, sources: { tavily: skillSource } });

    expect(result).toEqual({ linked: ["tavily"], kept: [], missing: [], reason: null });
    expect(lstatSync(join(worktree, ".opencode/skills/tavily")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(worktree, ".opencode/skills/tavily/SKILL.md"))).toBe(true);
    expect(readFileSync(join(worktree, ".git/info/exclude"), "utf8")).toContain(OPENCODE_SKILLS_EXCLUDE);
    expect(calls[0]!.command).toContain("info/exclude");
    expect(logs.join("\n")).toContain("\"linked\":[\"tavily\"]");
  });

  it("gives a writer of any other provider no links and no host call", async () => {
    for (const providerId of ["codex", "claude-code"]) {
      const calls: Call[] = [];
      const materializer = createSkillMaterializer({ host: localHost(calls) }, () => undefined);
      const result = await materializer.materialize({ ...picked, providerId, workspacePath: worktree, sources: { tavily: skillSource } });
      expect(result.linked, providerId).toEqual([]);
      expect(calls, providerId).toEqual([]);
      expect(existsSync(join(worktree, ".opencode")), providerId).toBe(false);
    }
  });

  it("skips a live folder, which has no git to exclude from, and says so in the log", async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const materializer = createSkillMaterializer({ host: localHost(calls) }, (message) => logs.push(message));
    const result = await materializer.materialize({ ...picked, live: true, workspacePath: base, sources: { tavily: skillSource } });
    expect(result.reason).toBe("live_folder");
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("the OpenCode guard will block tavily");
  });

  it("keeps the links out of git status, the untracked listing and the dirt snapshot", async () => {
    const materializer = createSkillMaterializer({ host: localHost() }, () => undefined);
    await materializer.materialize({ ...picked, workspacePath: worktree, sources: { tavily: skillSource } });

    const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: worktree, encoding: "utf8" });
    const untracked = execFileSync("git", ["ls-files", "-o", "--exclude-standard", "-z"], { cwd: worktree, encoding: "utf8" });
    expect(status).toContain("app.ts");
    expect(status).not.toContain(".opencode");
    expect(untracked.split("\0")).not.toContain(".opencode/skills/tavily");
    const dirt = spawnSync("sh", ["-c", WORKSPACE_DIRT_COMMAND], { cwd: worktree, encoding: "utf8" });
    expect(JSON.parse(dirt.stdout).map((row: { path: string }) => row.path)).toEqual(["app.ts"]);
  });

  it("keeps a real folder already at that path, and reports a folder without SKILL.md as missing", async () => {
    const own = join(worktree, ".opencode/skills/tavily");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "project's own\n");
    const bare = join(base, "catalog", "bare");
    mkdirSync(bare);
    const materializer = createSkillMaterializer({ host: localHost() }, () => undefined);

    const kept = await materializer.materialize({ ...picked, workspacePath: worktree, sources: { tavily: skillSource } });
    expect(kept.kept).toEqual(["tavily"]);
    expect(lstatSync(own).isSymbolicLink()).toBe(false);

    const missing = await materializer.materialize({ ...picked, skills: ["bare"], workspacePath: worktree, sources: { bare } });
    expect(missing.missing).toEqual(["bare"]);
    expect(existsSync(join(worktree, ".opencode/skills/bare"))).toBe(false);
  });

  it("links nothing when the exclude line cannot be written, so the links never show as dirt", async () => {
    const logs: string[] = [];
    const host = localHost([], (command) => (command.includes("info/exclude") ? { exitCode: 2, stderr: "git exploded" } : null));
    const materializer = createSkillMaterializer({ host }, (message) => logs.push(message));
    const result = await materializer.materialize({ ...picked, workspacePath: worktree, sources: { tavily: skillSource } });
    expect(result.reason).toBe("exclude_failed");
    expect(existsSync(join(worktree, ".opencode"))).toBe(false);
    expect(logs.join("\n")).toContain("git exploded");
  });

  it("links nothing in a folder that is not a git repository", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    const materializer = createSkillMaterializer({ host: localHost() }, () => undefined);
    const result = await materializer.materialize({ ...picked, workspacePath: plain, sources: { tavily: skillSource } });
    expect(result.reason).toBe("not_git");
    expect(existsSync(join(plain, ".opencode"))).toBe(false);
  });

  it("lowercases the name the guard looks up, and leaves out a name that is not a plain skill name", async () => {
    const logs: string[] = [];
    const materializer = createSkillMaterializer({ host: localHost() }, (message) => logs.push(message));
    const result = await materializer.materialize({ ...picked, skills: ["Tavily", "bad name;rm"], workspacePath: worktree, sources: { Tavily: skillSource, "bad name;rm": skillSource } });
    expect(result.linked).toEqual(["tavily"]);
    expect(existsSync(join(worktree, ".opencode/skills/tavily/SKILL.md"))).toBe(true);
    expect(logs.join("\n")).toContain("not materialized: bad name;rm");
  });

  it("removes exactly the links of the attempt at its end, and keeps the project's own skills", async () => {
    const materializer = createSkillMaterializer({ host: localHost() }, () => undefined);
    await materializer.materialize({ ...picked, workspacePath: worktree, sources: { tavily: skillSource } });
    const own = join(worktree, ".opencode/skills/mine");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "mine\n");

    await materializer.remove({ attemptId: "a1", hostId: "h", workspacePath: worktree, names: ["tavily"] });

    expect(existsSync(join(worktree, ".opencode/skills/tavily"))).toBe(false);
    expect(existsSync(join(own, "SKILL.md"))).toBe(true);
  });

  it("calls nothing at the end of an attempt that linked nothing", async () => {
    const calls: Call[] = [];
    const materializer = createSkillMaterializer({ host: localHost(calls) }, () => undefined);
    await materializer.remove({ attemptId: "a1", hostId: "h", workspacePath: worktree, names: [] });
    await materializer.remove({ attemptId: "a1", hostId: "h", workspacePath: null, names: ["tavily"] });
    expect(calls).toEqual([]);
  });

  it("reads the linked names from the attempt's dispatch, and the lines the command prints", () => {
    expect(recordedMaterializedSkills({ skillPick: { materialized: ["tavily", 3] } })).toEqual(["tavily"]);
    expect(recordedMaterializedSkills({ skillPick: {} })).toEqual([]);
    expect(recordedMaterializedSkills(undefined)).toEqual([]);
    expect(parseMaterialized("lp:linked tavily\nlp:kept own\nlp:missing bare\n")).toEqual({ linked: ["tavily"], kept: ["own"], missing: ["bare"] });
  });
});
