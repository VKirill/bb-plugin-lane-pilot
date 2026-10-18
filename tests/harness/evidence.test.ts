import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidenceFiles, evidenceLayout, harvestCommand, parseHarvest, treeDiff, writeFilesCommand, type AttemptEvidence,
} from "../../src/rooms/harness/server/evidence";

const attempt = (id: string, extra: Partial<AttemptEvidence> = {}): AttemptEvidence => ({
  attemptId: id, taskId: `task-${id}`, attemptNo: 1, state: "accepted", reason: null, createdAt: 1,
  contract: { title: `Title ${id}` }, dispatch: { rulesText: "rule one", memoryText: "mem one", promptChars: 1234, skills: ["a-skill"] },
  events: null, output: "done", verification: [], critique: null, ...extra,
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("evidenceFiles", () => {
  it("writes task.md with one table row per attempt and per-attempt brief, trajectory and outcome", () => {
    const files = evidenceFiles({
      area: "billing", writerKey: "codex/gpt-6-luna", harness: {}, library: [],
      attempts: [
        attempt("a1", { critique: { decision: "changes_requested", summary: "bad", findings: [{ severity: "blocking", path: "x.ts", line: 3, finding: "wrong" }, { severity: "info", finding: "nit" }] } }),
        attempt("a2", { state: "blocked", reason: "checks failed", attemptNo: 2, verification: [{ command: "npm test", exitCode: 1, stdout: "out", stderr: "err" }] }),
      ],
    });
    const task = files["context/task.md"];
    expect(task).toContain("# Area «billing», writers on codex/gpt-6-luna");
    const rows = task.split("\n").filter((line) => /^\| a\d/.test(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("| a1 | Title a1 | 1 | accepted | 1 | 1234 |");
    expect(rows[1]).toContain("| blocked: checks failed |");
    for (const id of ["a1", "a2"]) {
      for (const name of ["brief.md", "trajectory.md", "outcome.md"]) expect(files).toHaveProperty([`context/attempts/${id}/${name}`]);
    }
    expect(files["context/attempts/a1/brief.md"]).toContain("rule one");
    expect(files["context/attempts/a1/brief.md"]).toContain("## Skills: a-skill");
    expect(files["context/attempts/a1/brief.md"]).toContain("Harness tree: base (empty)");
    expect(files["context/attempts/a1/trajectory.md"]).toContain("could not be read");
    expect(files["context/attempts/a1/outcome.md"]).toContain("[blocking] x.ts:3 wrong");
    expect(files["context/attempts/a2/outcome.md"]).toContain("`npm test` → exit 1");
    expect(files["context/attempts/a2/outcome.md"]).toContain("(no critique)");
  });

  it("names the tree on the brief when the attempt ran under one, and says whole project for an empty area", () => {
    const files = evidenceFiles({
      area: "", writerKey: "*", harness: {}, library: [],
      attempts: [attempt("a1", { dispatch: { harness: { id: "hrn_1", arm: "new" } } })],
    });
    expect(files["context/task.md"]).toContain("# Area «(whole project)», writers on any model");
    expect(files["context/attempts/a1/brief.md"]).toContain("Harness tree: hrn_1 (arm new)");
  });

  it("writes the tree under context/harness, the library index with entries, the pool and the decisions", () => {
    const files = evidenceFiles({
      area: "billing", writerKey: "*", attempts: [],
      harness: { "always-on.md": "be nice", "checks/x.sh": "exit 0" },
      baseHarness: { "always-on.md": "old" },
      library: [{ id: "hrn_old", tree: { "memory.md": "- n" }, experienceMd: "# why", createdAt: 1, state: "adopted" }],
      pool: [{ label: "cand-a", tree: { "always-on.md": "new" }, diff: "", notes: "" }, { label: "cand-b", tree: {}, diff: "-a\n+b", notes: "reasoning" }],
      decisions: { editors: "kept", empty: "" },
    });
    expect(files["context/harness/always-on.md"]).toBe("be nice");
    expect(files["context/harness/checks/x.sh"]).toBe("exit 0");
    expect(files["context/base_harness/always-on.md"]).toBe("old");
    expect(files["context/library/INDEX.md"]).toContain("## `hrn_old/` (adopted)");
    expect(files["context/library/hrn_old/EXPERIENCE.md"]).toBe("# why");
    expect(files["context/library/hrn_old/harness/memory.md"]).toBe("- n");
    expect(files["context/pool/cand-a/harness.diff"]).toBe("(identical to the current harness)");
    expect(files["context/pool/cand-a/notes.md"]).toBe("(no notes)");
    expect(files["context/pool/cand-a/harness/always-on.md"]).toBe("new");
    expect(files["context/pool/cand-b/harness.diff"]).toBe("-a\n+b");
    expect(files["context/pool/cand-b/notes.md"]).toBe("reasoning");
    expect(files["context/decisions/editors.md"]).toBe("kept");
    expect(files["context/decisions/empty.md"]).toBe("No decision notes returned.");
  });

  it("writes no library, pool or decisions files when there are none", () => {
    const files = evidenceFiles({ area: "a", writerKey: "*", attempts: [], harness: {}, library: [] });
    expect(Object.keys(files)).toEqual(["context/task.md"]);
  });
});

describe("evidenceLayout", () => {
  it("names only the sections that exist", () => {
    const minimal = evidenceLayout(evidenceFiles({ area: "a", writerKey: "*", attempts: [], harness: {}, library: [] }));
    expect(minimal).toContain("context/task.md");
    expect(minimal).toContain("context/harness/");
    for (const absent of ["context/attempts/", "context/pool/", "context/decisions/", "context/library/", "context/base_harness/"]) expect(minimal).not.toContain(absent);

    const full = evidenceLayout(evidenceFiles({
      area: "a", writerKey: "*", attempts: [attempt("a1"), attempt("a2")], harness: { "always-on.md": "x" }, baseHarness: {},
      library: [{ id: "h", tree: {}, experienceMd: "e", createdAt: 1, state: "adopted" }],
      pool: [{ label: "c", tree: {}, diff: "d", notes: "n" }], decisions: { e: "n" },
    }));
    expect(full).toContain("2 attempts");
    expect(full).toContain("(1 files;");
    expect(full).toContain("context/pool/<label>/");
    expect(full).toContain("context/decisions/<label>.md");
    expect(full).toContain("context/library/");
  });
});

describe("treeDiff", () => {
  it("shows - and + lines for a changed file, whole files for added and removed ones, and nothing for identical", () => {
    const diff = treeDiff({ "a.md": "one\ntwo", "same.md": "x", "gone.md": "bye" }, { "a.md": "one\nthree", "same.md": "x", "new.md": "hi" });
    expect(diff).toContain("--- current/a.md\n+++ candidate/a.md\n-one\n-two\n+one\n+three");
    expect(diff).toContain("-bye");
    expect(diff).toContain("+hi");
    expect(diff).not.toContain("same.md");
    expect(treeDiff({ "a.md": "x" }, { "a.md": "x" })).toBe("");
  });
});

describe("harvest protocol", () => {
  it("parses files from the marker protocol, base64 split over lines, and trailing text", () => {
    const content = "line one\nline two ✓\n";
    const encoded = b64(content);
    const stdout = ["noise", "@@FILE always-on.md", encoded.slice(0, 8), encoded.slice(8), "@@END", "@@FILE checks/x.sh", b64("exit 0"), "@@END", ""].join("\n");
    expect(parseHarvest(stdout)).toEqual({ "always-on.md": content, "checks/x.sh": "exit 0" });
  });

  it("returns an empty tree for @@EMPTY and for empty output", () => {
    expect(parseHarvest("@@EMPTY\n")).toEqual({});
    expect(parseHarvest("")).toEqual({});
  });

  it("round-trips a real directory through harvestCommand", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-harvest-"));
    try {
      mkdirSync(join(root, "context/harness/checks"), { recursive: true });
      mkdirSync(join(root, "context/harness/node_modules/pkg"), { recursive: true });
      writeFileSync(join(root, "context/harness/always-on.md"), "Run the spec next to the file.\n");
      writeFileSync(join(root, "context/harness/checks/x.sh"), "echo 'quote' \"dq\" $HOME\n");
      writeFileSync(join(root, "context/harness/node_modules/pkg/skip.js"), "skipped");
      const stdout = execSync(harvestCommand(), { cwd: root, shell: "/bin/bash", encoding: "utf8" });
      expect(parseHarvest(stdout)).toEqual({ "always-on.md": "Run the spec next to the file.\n", "checks/x.sh": "echo 'quote' \"dq\" $HOME\n" });
      expect(execSync(harvestCommand("context/missing"), { cwd: root, shell: "/bin/bash", encoding: "utf8" })).toContain("@@EMPTY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writeFilesCommand", () => {
  it("refuses paths with .. and absolute paths, and ends with echo @@WRITTEN", () => {
    const command = writeFilesCommand("dir", { "ok.md": "x", "../escape.md": "y", "a/../b.md": "z", "/abs.md": "w", "..\\win.md": "v" });
    expect(command).not.toContain("escape.md");
    expect(command).not.toContain("b.md");
    expect(command).not.toContain("abs.md");
    expect(command).not.toContain("win.md");
    expect(command).toContain("'ok.md'");
    expect(command.trimEnd().endsWith("echo @@WRITTEN")).toBe(true);
  });

  it("really writes the files, including nested folders and quotes in content", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-write-"));
    try {
      const files = { "a.md": "it's \"quoted\"\n", "checks/x.sh": "exit 0", "skills/s/SKILL.md": "---\nname: s\n---" };
      const out = execSync(writeFilesCommand(join(root, "out"), files), { shell: "/bin/bash", encoding: "utf8" });
      expect(out.trim()).toBe("@@WRITTEN");
      const back = execSync(harvestCommand(join(root, "out")), { shell: "/bin/bash", encoding: "utf8" });
      expect(parseHarvest(back)).toEqual(files);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sliceAttemptEvents", () => {
  const request = (seq: number, text: string) => ({ type: "client/turn/requested", seq, data: { input: [{ type: "text", text }] } });
  const item = (seq: number, text: string) => ({ type: "item/completed", seq, data: { item: { type: "agentMessage", id: `a${seq}`, text } } });
  it("cuts a sticky writer's thread to the turns of one task", async () => {
    const { sliceAttemptEvents } = await import("../../src/rooms/harness/server/evidence");
    const events = [
      request(1, "Lane Pilot task alpha-1: first"), item(2, "did alpha"),
      request(3, 'Next task for you in the same area. Your previous task was accepted.\n\nTask contract:\n{\n "id": "beta-2",\n "title": "second"\n}'), item(4, "did beta"),
      request(5, "fix the check please"), item(6, "fixed beta"),
      request(7, "Lane Pilot task gamma-3: third"), item(8, "did gamma"),
    ];
    expect(sliceAttemptEvents(events, "beta-2").map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(sliceAttemptEvents(events, "alpha-1").map((e) => e.seq)).toEqual([1, 2]);
    expect(sliceAttemptEvents(events, "gamma-3").map((e) => e.seq)).toEqual([7, 8]);
    expect(sliceAttemptEvents(events, "unknown").map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
