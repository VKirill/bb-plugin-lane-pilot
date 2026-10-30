import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRepoPath } from "../../src/rooms/bench/repos";
import { insertSet } from "../../src/rooms/bench/store";
import { runSeries } from "../../src/rooms/bench/runner";
import type { HostPort, PipelinePort } from "../../src/rooms/bench/ports";
import type { ManifestTask } from "../../src/rooms/bench/types";
import { benchWorld } from "./helpers";

const MAC = "/Users/vechkasov/Documents/BB-сервис/plugins/bb-plugin-lane-pilot";
const ROOT = "/home/ubuntu/lp-bench/repos";

describe("bench repo root", () => {
  it("maps a stored checkout onto the configured root by its folder name", () => {
    expect(resolveRepoPath(MAC, ROOT)).toBe(`${ROOT}/bb-plugin-lane-pilot`);
    expect(resolveRepoPath(`${ROOT}/bb-plugin-lane-pilot`, `${ROOT}/`)).toBe(`${ROOT}/bb-plugin-lane-pilot`);
    expect(resolveRepoPath(MAC, "  ")).toBe(MAC);
    expect(resolveRepoPath(MAC, null)).toBe(MAC);
  });

  it("clones the series from the mapped path, not the Mac path stored in the set", async () => {
    const w = benchWorld();
    const task: ManifestTask = {
      taskId: "task-a", position: 1, projectId: "proj_ejbam66722", projectName: "BB-сервис", hostId: "host_7sea4qaad8", repoPath: MAC,
      stratum: "bb-service", hard: false, risk: "low", area: "x", initialHeadSha: "a".repeat(40), solutionCommit: "b".repeat(40), solutionPatchSha256: "c".repeat(64),
      contract: { verification: [], read_first: [] }, warm: { base: [], solution: [], discriminating: [], applied: "apply", files: [] },
    };
    insertSet(w.db as never, { version: "v1", tasks: [task], rejected: [], candidateCount: 1, config: {} });
    const commands: string[] = [];
    const host: HostPort = {
      run: async (_id, _cwd, command) => {
        commands.push(command);
        if (command.includes("df ")) return { exitCode: 0, stdout: "100\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const project = { projectId: "proj_bench", name: "LP bench BB-сервис", hostId: "host_rwrxyi39aw", path: "/tmp/lp-bench-wt" };
    const pipeline: PipelinePort = {
      findProject: async () => project,
      configure: async () => undefined,
      startRun: async () => ({ pmThreadId: "pm", runId: "run" }),
      dispatch: async () => ({ ok: false, detail: "stop" }),
      outcome: async () => ({ latestState: null, attempts: 0 }),
      metrics: async () => [],
      cancel: async () => undefined,
      finishRun: async () => undefined,
    };
    await runSeries({ db: w.db as never, host, pipeline, clock: { now: () => 1, sleep: async () => undefined }, projectNameFor: () => project.name, log: () => undefined },
      { version: "v1", arm: "map", minFreeGb: 0, pollMs: 1, reposRoot: ROOT });
    const checkout = commands.find((command) => command.includes("git clone"));
    expect(checkout).toContain(`${ROOT}/bb-plugin-lane-pilot`);
    expect(checkout).not.toContain("/Users/vechkasov/");
  });
});

describe("bench-sync-repos.sh", () => {
  it("clones from origin into the root and lists a path that has no remote", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-bench-sync-"));
    const bare = join(dir, "origin.git");
    const src = join(dir, "src");
    const root = join(dir, "repos");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", src]);
    writeFileSync(join(src, "README.md"), "x\n");
    execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "add", "README.md"]);
    execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    execFileSync("git", ["-C", src, "remote", "add", "origin", bare]);
    execFileSync("git", ["-C", src, "push", "-q", "origin", "main"]);
    const missing = join(dir, "no-git");
    mkdirSync(missing);
    const list = join(dir, "paths.txt");
    writeFileSync(list, `${src}\n${missing}\n`);
    let out = "";
    try {
      out = execFileSync("bash", ["scripts/bench-sync-repos.sh", list], {
        cwd: join(import.meta.dirname, "../.."),
        env: { ...process.env, BENCH_REPOS_ROOT: root },
        encoding: "utf8",
      });
    } catch (cause) {
      const error = cause as { stdout?: string; status?: number };
      out = error.stdout ?? "";
      expect(error.status).toBe(2);
    }
    expect(out).toContain(`cloned ${join(root, "src")}`);
    expect(out).toContain(`no remote: ${missing}`);
    const readme = execFileSync("git", ["-C", join(root, "src"), "log", "-1", "--format=%s"], { encoding: "utf8" });
    expect(readme.trim()).toBe("base");
  });
});
