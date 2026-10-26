import { describe, expect, it, vi } from "vitest";
import { getBaseline } from "../../src/rooms/baseline";
import { redOutsideTaskFiles, unrunnableReason, type BaselineCheck } from "../../src/rooms/baseline/logic";
import { classifyFailure } from "../../src/rooms/runs/failure-class";
import { countChargedAttempts, transitionAttempt } from "../../src/rooms/storage";
import { world } from "./world";

vi.setConfig({ testTimeout: 180_000 });

const task = { project_cwd: "/p", owns_paths: ["src/mine/**", "notes/"], expected_outputs: ["scripts/new-check.sh"] };
const red = (command: string, note: string, patch: Partial<BaselineCheck> = {}): BaselineCheck => ({ command, cwd: "/p", status: "red", exitCode: 1, note, ...patch });

describe("a check that cannot run on the base (texts of the writers' needs_human questions)", () => {
  it("names a tool the machine lacks, the prose backtick mistake, a missing package.json, a rejected flag", () => {
    expect(unrunnableReason(red("cargo check", "bash: line 1: cargo: command not found", { exitCode: 127 }), task)).toMatch(/`cargo` is not found/);
    expect(unrunnableReason(red("npm test > /tmp/t1-test.log 2>&1; echo $? prints `0`", "/bin/bash: 0: command not found", { exitCode: 127 }), task)).toMatch(/`0` is not found/);
    expect(unrunnableReason(red("npm install && npm run typecheck", "npm error code ENOENT\nnpm error syscall open\nnpm error path /w/apps/package.json\nnpm error enoent Could not read package.json"), task)).toMatch(/no package.json/);
    expect(unrunnableReason(red("npx vitest run --minWorkers=2 a.test.ts", "CACError: Unknown option `--minWorkers`"), task)).toMatch(/--minWorkers/);
    expect(unrunnableReason(red("cd missing-dir && npm test", "bash: line 1: cd: missing-dir: No such file or directory"), task)).toMatch(/missing-dir/);
  });

  it("leaves alone what the task itself creates, project-local tools, ordinary red checks and green ones", () => {
    // the script is the work: owned by expected_outputs, and a package.json under owns_paths
    expect(unrunnableReason(red("bash scripts/new-check.sh", "bash: scripts/new-check.sh: No such file or directory", { exitCode: 127 }), task)).toBeNull();
    expect(unrunnableReason(red("npm test", "npm error enoent Could not read package.json"), { ...task, owns_paths: ["package.json"] })).toBeNull();
    // a baseline tree that could not link its dependencies misses vitest, the writer's tree has it
    expect(unrunnableReason(red("vitest run", "bash: line 1: vitest: command not found", { exitCode: 127 }), task)).toBeNull();
    // the name in the output is not the command the contract wrote (a script's own failure)
    expect(unrunnableReason(red("npm run build", "sh: 1: rollup-plugin-x: not found", { exitCode: 127 }), task)).toBeNull();
    expect(unrunnableReason(red("npx vitest run a.test.ts", "AssertionError: expected 1 to be 2"), task)).toBeNull();
    expect(unrunnableReason({ ...red("true", ""), status: "green", exitCode: 0 }, task)).toBeNull();
  });
});

describe("a check red on the base outside the task's files", () => {
  const typecheck = (note: string) => red("npm run typecheck", note);

  it("names the files when every one of them is outside owns_paths and the check does not name them", () => {
    const note = "src/sticker-pack/process-sticker-pack-job.ts(41,7): error TS2352: Conversion of type\nsrc/routes/v1/public-stickers/order-service.ts(9,1): error TS2322";
    expect(redOutsideTaskFiles(typecheck(note), task)).toEqual(["src/sticker-pack/process-sticker-pack-job.ts", "src/routes/v1/public-stickers/order-service.ts"]);
    // a check in a package folder: paths are placed from the repository root
    expect(redOutsideTaskFiles(red("npx vitest run tests/fitness/", " FAIL  tests/fitness/container-discipline.test.ts > reads app/pages/index.vue", { cwd: "/p/apps/marketing" }), task))
      .toEqual(["apps/marketing/tests/fitness/container-discipline.test.ts", "apps/marketing/app/pages/index.vue"]);
  });

  it("claims nothing when a file is the task's, the check names it, the output names none, or a path cannot be placed", () => {
    expect(redOutsideTaskFiles(typecheck("src/mine/a.ts(1,1): error TS1\nsrc/other/b.ts(2,2): error TS2"), task)).toEqual([]);
    expect(redOutsideTaskFiles(red("npx vitest run tests/new.test.ts", "FAIL tests/new.test.ts"), task)).toEqual([]);
    expect(redOutsideTaskFiles(typecheck("Test Files  1 failed (1)\n Tests  2 failed"), task)).toEqual([]);
    expect(redOutsideTaskFiles(typecheck("/home/ubuntu/w/src/other/b.ts:2 error"), task)).toEqual([]);
    expect(redOutsideTaskFiles(typecheck("at run (node_modules/vitest/dist/chunk.js:12:3)"), task)).toEqual([]);
    expect(redOutsideTaskFiles({ ...typecheck("src/other/b.ts error"), status: "green" }, task)).toEqual([]);
  });
});

describe("the baseline stops the attempt before any writer", () => {
  const at = (input: ReturnType<Awaited<ReturnType<typeof world>>["pendingTask"]>, patch: Record<string, unknown>) => ({ ...input, task: { ...(input.task as object), ...patch } as never });

  it("stops a check that cannot run, for a fix as for a feature, tells the PM which check and what to change, and spends no attempt", async () => {
    for (const kind of ["fix", "feature"]) {
      const w = await world();
      const input = at(w.pendingTask(`t-${kind}`, ["no-such-tool-xyz --version"]), { kind, risk: "low" });
      const result = await w.services.baseline.preflight(input);
      expect(result.stop).toMatch(/^verdict_block: check_cannot_run: no-such-tool-xyz --version: exit 127/);
      expect(classifyFailure("blocked", result.stop).cls).toBe("contract");
      expect(getBaseline(w.db, "run1", `t-${kind}`)).toMatchObject({ action: "stopped" });
      const text = (w.send.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text;
      expect(text).toContain(`задача t-${kind} не запущена`);
      expect(text).toContain("no-such-tool-xyz --version");
      expect(text).toContain("Исправьте команду или cwd");
      transitionAttempt(w.db, `att_t-${kind}`, "blocked", { reason: result.stop! });
      expect(countChargedAttempts(w.db, "run1", `t-${kind}`)).toBe(0);
      await w.dispose();
    }
  });

  it("stops a feature whose check is red in files it does not own, but not a fix, and not when the task owns them", async () => {
    const w = await world();
    // the file name is split in the command so that the command does not name it; the output does
    const red = "printf 'FAIL %s\\n' src/oth''er/legacy.test.ts >&2; exit 1";
    const owned = { owns_paths: ["src/mine/**"] };
    const stopped = await w.services.baseline.preflight(at(w.pendingTask("feat", [red]), { ...owned, kind: "feature" }));
    expect(stopped.stop).toMatch(/^verdict_block: red_outside_task: .*red in src\/other\/legacy\.test\.ts/);
    expect((w.send.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text).toContain("Сузьте проверку");
    expect((await w.services.baseline.preflight(at(w.pendingTask("fixed", [red]), { ...owned, kind: "fix" }))).stop).toBeNull();
    expect((await w.services.baseline.preflight(at(w.pendingTask("nokind", [red]), owned))).stop).toBeNull();
    expect((await w.services.baseline.preflight(at(w.pendingTask("mine", [red]), { owns_paths: ["src/other/**"], kind: "feature" }))).stop).toBeNull();
    await w.dispose();
  });
});
