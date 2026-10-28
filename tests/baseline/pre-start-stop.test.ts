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
    // Docker without its compose plugin in the check sandbox (T8 of a bot project, 2026-10-28)
    expect(unrunnableReason(red("docker compose config -q", "docker: unknown command: docker compose\n\nRun 'docker --help' for more information", { exitCode: 125 }), task)).toMatch(/`docker compose` is not available/);
    expect(unrunnableReason(red("docker buildx build .", "docker: 'buildx' is not a docker command.\nSee 'docker --help'", { exitCode: 1 }), task)).toMatch(/`docker buildx` is not available/);
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
    // the project's own CLI that does not have the command yet: that is the work, not the machine
    expect(unrunnableReason(red("node cli.js deploy", "mycli: unknown command: deploy"), task)).toBeNull();
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
    // the runtime's own banner after an uncaught Node error is not a file
    expect(redOutsideTaskFiles(red("node checks/a.mjs", "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/w/src/a.js'\n\nNode.js v26.3.1"), task)).toEqual([]);
    expect(redOutsideTaskFiles(typecheck("at run (node_modules/vitest/dist/chunk.js:12:3)"), task)).toEqual([]);
    expect(redOutsideTaskFiles({ ...typecheck("src/other/b.ts error"), status: "green" }, task)).toEqual([]);
  });

  it("claims nothing from the files a passing step lists: a build's outputs before a silent red grep (image-studio 2026-10-27)", () => {
    // baseline 539 on the hub: tsc, 275 tests and the build passed; `grep -q` on the version the task bumps was red with no output
    const note = "✔ the gallery keeps the newest 80 (106.834084ms)\n✔ long prompts never push a gallery list past the plugin KV size limit (1093.894917ms)\n"
      + "ℹ tests 275\nℹ suites 0\nℹ pass 275\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 13641.784292\n"
      + "dist/server.js\ndist/server.js.map\ndist/server.meta.json\ndist/app.js\ndist/app.css\ndist/app.meta.json\ndist/host.js\ndist/host.js.map\ndist/host.meta.json";
    const command = "npx tsc --noEmit && node --test --experimental-strip-types tests/*.test.ts && bb plugin build && grep -q '\"version\": \"0.8.15\"' package.json";
    expect(redOutsideTaskFiles(red(command, note), { project_cwd: "/p", owns_paths: ["src/models/**", "tests/model-guidefix.test.ts"], expected_outputs: [] })).toEqual([]);
    // a passing test whose title names a file, and a file whose name holds «error», are not failures either
    expect(redOutsideTaskFiles(typecheck("✔ src/other/b.ts fails over to the cache (3ms)\nsrc/other/errors.ts"), task)).toEqual([]);
  });

  it("still names a file the line after it reports as failing (eslint names the file, then its errors)", () => {
    expect(redOutsideTaskFiles(red("npx eslint .", "src/other/b.ts\n  3:5  error  'x' is never used  no-unused-vars\n\n✖ 1 problem"), task)).toEqual(["src/other/b.ts"]);
    expect(redOutsideTaskFiles(red("python -m pytest", "  File \"src/other/c.py\", line 3, in <module>\nNameError: name 'x' is not defined"), task)).toEqual(["src/other/c.py"]);
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
