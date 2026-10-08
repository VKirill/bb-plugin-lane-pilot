import { describe, expect, it } from "vitest";
import {
  PROJECT_LIFE_DEFAULT_WRITER,
  projectLifeWriterSelection,
  findOutOfScopeProjectLifeWrites,
  foldCoveredTaskIds,
  isAllowedProjectLifePath,
  parseProjectLifeFinalMessage,
  parseProjectLifeSettings,
  projectLifePrompt,
  shouldTriggerProjectLife,
} from "../../src/rooms/project-life/project-life";

describe("project-life settings", () => {
  it("defaults enabled to true and parses booleans", () => {
    expect(parseProjectLifeSettings({})).toEqual({ enabled: true });
    expect(parseProjectLifeSettings({ "project_life.enabled": false })).toEqual({ enabled: false });
    expect(parseProjectLifeSettings({ "project_life.enabled": "false" })).toEqual({ enabled: false });
  });

  it("defaults the writer to codex/gpt-6-luna/high/fast", () => {
    expect(PROJECT_LIFE_DEFAULT_WRITER).toEqual({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "fast" });
    expect(projectLifeWriterSelection({ "writer.provider": "acp-cursor", "writer.model": "grok-4.6" })).toEqual({ providerId: "codex", model: "gpt-6-luna" });
    expect(projectLifeWriterSelection({ "project_life.provider": "qwen", "project_life.model": "qwen-max" })).toEqual({ providerId: "qwen", model: "qwen-max" });
  });
});

describe("project-life trigger", () => {
  it("triggers only when the run has no other open attempts", () => {
    expect(shouldTriggerProjectLife([], "run-1")).toBe(true);
    expect(shouldTriggerProjectLife(["run-2"], "run-1")).toBe(true);
    expect(shouldTriggerProjectLife(["run-1"], "run-1")).toBe(false);
    expect(shouldTriggerProjectLife(["run-1", "run-1"], "run-1")).toBe(false);
  });
});

describe("project-life covered-task folding", () => {
  it("folds tasks accepted in parallel into a single update", () => {
    expect(foldCoveredTaskIds(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("excludes tasks already covered by an earlier passed receipt", () => {
    expect(foldCoveredTaskIds(["a", "b", "c"], ["a"])).toEqual(["b", "c"]);
  });

  it("returns nothing new once every accepted task is covered", () => {
    expect(foldCoveredTaskIds(["a"], ["a"])).toEqual([]);
  });
});

describe("project-life allowed write paths", () => {
  it("allows PROGRESS.md, plans/** and todos/**", () => {
    expect(isAllowedProjectLifePath(".agents/PROGRESS.md")).toBe(true);
    expect(isAllowedProjectLifePath(".agents/CHANGELOG.md")).toBe(true);
    expect(isAllowedProjectLifePath(".agents/plans/ROADMAP.md")).toBe(true);
    expect(isAllowedProjectLifePath(".agents/plans/items/foo/PLAN.md")).toBe(true);
    expect(isAllowedProjectLifePath(".agents/todos/INDEX.md")).toBe(true);
  });

  it("rejects code, LESSONS.md and docs/decisions.md", () => {
    expect(isAllowedProjectLifePath("src/server.ts")).toBe(false);
    expect(isAllowedProjectLifePath(".agents/LESSONS.md")).toBe(false);
    expect(isAllowedProjectLifePath("docs/decisions.md")).toBe(false);
  });

  it("flags every out-of-scope path in a changed-paths list", () => {
    expect(findOutOfScopeProjectLifeWrites([".agents/PROGRESS.md", "src/server.ts", ".agents/plans/ROADMAP.md", "LESSONS.md"]))
      .toEqual(["src/server.ts", "LESSONS.md"]);
    expect(findOutOfScopeProjectLifeWrites([".agents/PROGRESS.md", ".agents/todos/INDEX.md"])).toEqual([]);
  });
});

describe("project-life final message", () => {
  it("parses the last JSON line", () => {
    expect(parseProjectLifeFinalMessage('some log line\n{"status":"updated","commit":"abc123","files":[".agents/PROGRESS.md"]}'))
      .toEqual({ status: "updated", commit: "abc123", files: [".agents/PROGRESS.md"] });
    expect(parseProjectLifeFinalMessage('{"status":"no_change","commit":null,"files":[]}'))
      .toEqual({ status: "no_change", commit: null, files: [] });
  });

  it("rejects empty, non-JSON, or malformed final messages", () => {
    expect(() => parseProjectLifeFinalMessage("")).toThrow();
    expect(() => parseProjectLifeFinalMessage("not json")).toThrow();
    expect(() => parseProjectLifeFinalMessage('{"status":"maybe","commit":null,"files":[]}')).toThrow();
    expect(() => parseProjectLifeFinalMessage('{"status":"updated","commit":1,"files":[]}')).toThrow();
    expect(() => parseProjectLifeFinalMessage('{"status":"updated","commit":null,"files":"x"}')).toThrow();
  });
});

describe("project-life prompt", () => {
  it("includes workspace, run id, artifact dirs, tasks and the required final-line contract", () => {
    const prompt = projectLifePrompt({
      workspace: "/repo",
      runId: "run-1",
      artifactDirs: ["/repo/.agents/runs/run-1/artifacts/task-1"],
      tasks: [{ id: "task-1", title: "Add feature", objective: "Ship it", acceptanceSummary: "done" }],
      nowIso: "2026-09-27T00:00:00.000Z",
    });
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("run-1");
    expect(prompt).toContain("/repo/.agents/runs/run-1/artifacts/task-1");
    expect(prompt).toContain("2026-09-27T00:00:00.000Z");
    expect(prompt).toContain("task-1");
    expect(prompt).toContain(".agents/PROGRESS.md");
    expect(prompt).toContain("keep every line that is still true");
    expect(prompt).toContain("by capability");
    expect(prompt).toContain("Pointers is rebuilt from the files every time");
    expect(prompt).toContain("Append exactly one line to .agents/CHANGELOG.md");
    for (const stale of ["run-finalize", "run.yaml", ".agents/runs/<slug>", "claude-lane-stack"]) expect(prompt).not.toContain(stale);
    expect(prompt).toContain("Lane Pilot rejects the run on any other changed path");
    expect(prompt).toContain("LESSONS.md");
    expect(prompt).toContain(".agents/decisions/");
    expect(prompt).toContain('{"status":"updated"|"no_change","commit":"<full 40-char sha from git rev-parse HEAD, or null>","files":[...]}');
  });

  it("shows 'none' when there are no artifact dirs", () => {
    const prompt = projectLifePrompt({ workspace: "/repo", runId: "run-1", artifactDirs: [], tasks: [], nowIso: "2026-09-27T00:00:00.000Z" });
    expect(prompt).toContain("none");
  });
});
