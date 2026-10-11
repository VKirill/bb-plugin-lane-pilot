import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { commonTaskFolder, isTaskBase, ownsFromOuterBase, parseRepoTop, planWithOutsideReads, repoTopCommand, rerootTask } from "../src/rooms/tasks";
import { runCommandOnHost } from "../src/rooms/writer/cli-run";

const U = "/Users/me/BB-сервис";

/** The agency task of 2026-10-10 as the PM wrote it, from the umbrella folder. */
const agency = (): TaskV2 => ({
  schema_version: 2, id: "jev-openlux-agency", title: "OpenLux for Jev in agency", risk: "medium", lane: "writer", project_cwd: U,
  read_first: ["plugins/bb-plugin-agency/AGENTS.md", "plugins/bb-plugin-agency/src/shared/decisions.ts", "plugins/bb-plugin-lane-pilot/packages/jev/src/provider.ts"],
  interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"],
  expected_outputs: ["plugins/bb-plugin-agency/src/shared/decisions.ts", "plugins/bb-plugin-agency/tests/decisions.test.ts"],
  owns_paths: ["plugins/bb-plugin-agency/src/", "plugins/bb-plugin-agency/server.ts", "plugins/bb-plugin-agency/README.md"],
  never_touch: ["plugins/bb-plugin-lane-pilot/", "plugins/bb-plugin-agency/dist/"], depends_on: [],
  objective: "o", acceptance: ["a"], verify: "tests",
  verification: [{ command: "npx tsc --noEmit", cwd: `${U}/plugins/bb-plugin-agency`, timeout_sec: 600 }],
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("a task's base inside the run folder", () => {
  it("is the run folder or a folder inside it, never one beside or above it", () => {
    expect(isTaskBase(U, U)).toBe(true);
    expect(isTaskBase(U, `${U}/plugins/a`)).toBe(true);
    expect(isTaskBase(U, "/Users/me/other")).toBe(false);
    expect(isTaskBase(U, `${U}-copy`)).toBe(false);
    expect(isTaskBase(`${U}/plugins/a`, U)).toBe(false);
  });

  it("finds the folder every path of the task lies in: owned paths, path outputs and the folders of the checks", () => {
    expect(commonTaskFolder(agency())).toBe("plugins/bb-plugin-agency");
    // The computer-use task of the same day spanned two repositories: they share only «plugins», no repository.
    expect(commonTaskFolder({ ...agency(), owns_paths: ["plugins/jev-ultrafast/jev_ultrafast/", "plugins/typesafe-computer-use/tests/"], expected_outputs: [], verification: [] })).toBe("plugins");
    expect(commonTaskFolder({ ...agency(), owns_paths: ["src/**", "README.md"], expected_outputs: [], verification: [] })).toBeNull();
    expect(commonTaskFolder({ ...agency(), verification: [{ command: "make", cwd: "/elsewhere", timeout_sec: 60 }] })).toBeNull();
  });

  it("moves the task into the repository: paths relative to it, never_touch outside dropped, reads outside kept by absolute path", () => {
    const moved = rerootTask(agency(), "plugins/bb-plugin-agency");
    expect(moved?.task).toMatchObject({
      project_cwd: `${U}/plugins/bb-plugin-agency`,
      owns_paths: ["src/", "server.ts", "README.md"],
      expected_outputs: ["src/shared/decisions.ts", "tests/decisions.test.ts"],
      never_touch: ["dist/"],
      read_first: ["AGENTS.md", "src/shared/decisions.ts"],
      verification: [{ command: "npx tsc --noEmit", cwd: `${U}/plugins/bb-plugin-agency` }],
    });
    expect(moved?.outsideReads).toEqual([`${U}/plugins/bb-plugin-lane-pilot/packages/jev/src/provider.ts`]);
    expect(planWithOutsideReads("Do it.", moved!.outsideReads)).toContain(`- ${U}/plugins/bb-plugin-lane-pilot/packages/jev/src/provider.ts`);
    expect(planWithOutsideReads("Do it.", [])).toBe("Do it.");
  });

  it("does not move a task with an owned path, an output or a check outside the repository", () => {
    expect(rerootTask({ ...agency(), owns_paths: [...agency().owns_paths, "plugins/other/x.ts"] }, "plugins/bb-plugin-agency")).toBeNull();
    expect(rerootTask({ ...agency(), expected_outputs: ["plugins/other/x.ts"] }, "plugins/bb-plugin-agency")).toBeNull();
    expect(rerootTask({ ...agency(), verification: [{ command: "make", cwd: U, timeout_sec: 60 }] }, "plugins/bb-plugin-agency")).toBeNull();
    // Owning the whole repository folder leaves nothing to own inside it.
    expect(rerootTask({ ...agency(), owns_paths: ["plugins/bb-plugin-agency"] }, "plugins/bb-plugin-agency")).toBeNull();
  });

  it("reads two tasks' owned paths from the outer of their bases, and not at all for unrelated folders", () => {
    expect(ownsFromOuterBase(U, ["plugins/p/src/**"], `${U}/plugins/p`, ["src/**"])).toEqual([["plugins/p/src/**"], ["plugins/p/src/**"]]);
    expect(ownsFromOuterBase(`${U}/plugins/p`, ["README.md"], U, ["notes/**"])).toEqual([["plugins/p/README.md"], ["notes/**"]]);
    expect(ownsFromOuterBase(U, ["a/**"], U, ["b/**"])).toEqual([["a/**"], ["b/**"]]);
    expect(ownsFromOuterBase(`${U}/plugins/p`, ["src/**"], `${U}/plugins/q`, ["src/**"])).toBeNull();
  });

  it("asks the folder's host for the repository: nearest existing folder, real paths, nothing for the run folder or a plain folder", async () => {
    const umbrella = mkdtempSync(join(tmpdir(), "lane-pilot-umbrella-"));
    roots.push(umbrella);
    mkdirSync(join(umbrella, "plugins", "a", "src"), { recursive: true });
    writeFileSync(join(umbrella, "plugins", "a", "src", "x.ts"), "x\n");
    execFileSync("git", ["init", "-q"], { cwd: join(umbrella, "plugins", "a") });
    const top = async (folder: string) => parseRepoTop(await runCommandOnHost({ requestedHostId: "h", cwd: umbrella, command: repoTopCommand(folder, umbrella) }));
    // A folder the task will create still finds its repository; tmp is /var on the outside and /private/var to git.
    expect(await top(join(umbrella, "plugins", "a", "src", "new", "deep"))).toBe("plugins/a");
    expect(await top(join(umbrella, "plugins"))).toBeNull();
    expect(await top(umbrella)).toBeNull();
    expect(parseRepoTop(null)).toBeNull();
    expect(parseRepoTop({ exitCode: 0, stdout: "/a/b\n/a/b\n" })).toBeNull();
    expect(parseRepoTop({ exitCode: 0, stdout: "/x/y\n/a/b\n" })).toBeNull();
  });
});
