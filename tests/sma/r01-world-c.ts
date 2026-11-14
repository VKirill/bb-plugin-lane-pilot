// Region 1 · Task graph, batch c: shared fixtures of the four-proofs-r01-c tests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";

export const HOST = "host_c";
export const WS = "/ws";
export const config: PrototypeConfig = { projectId: "proj1", hostId: HOST, pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
export const taskOf = (id: string, over: Partial<TaskV2> = {}): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WS, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`src/${id}.ts`], owns_paths: ["src/"], never_touch: [], depends_on: [],
  objective: "do it", acceptance: ["done"], verify: "tests", verification: [{ command: "true", cwd: WS }], ...over,
});

export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

/** A scratch repository `app` on main with two commits; `first` is the older one. */
export function scratchRepo(): { dir: string; base: string; first: string; second: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sma-r01-c-")));
  const base = join(dir, "app");
  mkdirSync(base, { recursive: true });
  git(base, "init", "-q", "-b", "main");
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  writeFileSync(join(base, "a.txt"), "a\n");
  git(base, "add", ".");
  git(base, "commit", "-qm", "first");
  const first = git(base, "rev-parse", "HEAD");
  writeFileSync(join(base, "b.txt"), "b\n");
  git(base, "add", ".");
  git(base, "commit", "-qm", "second");
  return { dir, base, first, second: git(base, "rev-parse", "HEAD") };
}

export function fakeDb() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, harness, db: openDatabase(bb) };
}
