import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { createWorktree, integrateWorktree, removeLaneWorktree } from "../../src/rooms/verification/git-integrate";
import { worktreeState } from "../../src/rooms/verification/git-rollback";
import fixture from "../fixtures/docs-missing-worktrees.json";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
let dispose: (() => Promise<void> | void) | undefined;
let root: string | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function replay(incident: typeof fixture.incidents[number], state: "missing" | "ready" | "failed" | "offline" | "create-failed" | "create-offline" = "missing") {
  const input = incident.input;
  root = await mkdtemp(join(tmpdir(), "lp-docs-recovery-"));
  const base = join(root, "main", basename(input.basePath));
  const work = join(root, "work", basename(input.worktreePath));
  const name = `docs-${hash(input.basePath)}`;
  await mkdir(base, { recursive: true });
  git(base, "init", "-q", "-b", "main");
  await mkdir(join(base, "docs"));
  await writeFile(join(base, "docs/overview.md"), "base docs\n");
  git(base, "add", "."); git(base, "commit", "-qm", "base");
  expect(await createWorktree({ basePath: base, targetPath: work, name })).toMatchObject({ status: "ready" });
  await writeFile(join(work, "docs/overview.md"), "unmerged docs from the earlier pass\n");
  git(work, "add", "."); git(work, "commit", "-qm", "earlier docs");
  const earlierHead = git(work, "rev-parse", "HEAD");
  if (state === "missing" || state.startsWith("create-")) {
    // A removed folder with its branch still present: the durable KV marker outlives the folder.
    git(base, "worktree", "remove", "--force", work);
    expect({ hostId: input.requestedHostId, ...await integrateWorktree({ ...input, basePath: base, worktreePath: work }) }).toMatchObject(incident.result.value);
  }
  const calls: Array<{ method: string; input: Record<string, any> }> = [];
  const projectId = "proj_ejbam66722";
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      projects: { get: async () => ({ id: projectId, sources: [{ hostId: input.requestedHostId, path: input.basePath }] }) as never },
      plugins: { callRpc: async () => ({ sections: [] }) },
    },
    experimental_callHostRpc: async (call) => {
      const args = call.input as Record<string, any>;
      calls.push({ method: call.method, input: args });
      const hostId = input.requestedHostId;
      if (call.method === "gitWorktreeState") {
        expect(args).toMatchObject({ requestedHostId: hostId, basePath: input.basePath, worktreePath: input.worktreePath });
        if (state === "offline") throw new Error("host offline");
        if (state === "failed") return { hostId, status: "failed", head: null, base: null, dirty: 0, ahead: 0, changed: [], reason: "git unavailable" };
        return { hostId, ...await worktreeState({ basePath: base, worktreePath: work }) };
      }
      if (call.method === "gitCreateWorktree") {
        if (state === "create-offline") throw new Error("host offline during recovery");
        if (state === "create-failed") return { hostId, status: "failed", path: null, branch: null, reason: "recovery failed" };
        return { hostId, ...await createWorktree({ basePath: base, targetPath: work, name: args.name }), path: input.worktreePath };
      }
      if (call.method === "gitIntegrate") {
        const result = await integrateWorktree({ ...input, basePath: base, worktreePath: work });
        // The RPC adds hostId; the integration helper itself does not.
        return { hostId, ...result };
      }
      if (call.method === "gitRemoveWorktree") return { hostId, ...await removeLaneWorktree({ basePath: base, worktreePath: work }) };
      if (call.method === "gitDocsScope") return { hostId, status: "ready", isRepoRoot: true, hasDocs: true, changed: [], dirty: [], base: null, workspaces: [], localDate: "2026-11-02", localHour: 4, reason: null };
      if (call.method === "listDocsPages") return { hostId, pages: args.roots.includes(".agents/decisions") ? [] : [{ path: "docs/overview.md", modifiedAt: 1, sha256: "a".repeat(64), content: "base docs\n" }], oversized: [] };
      if (call.method === "docsFlows") return { hostId, flows: [], routes: 0, jev: "disabled", briefPath: "/tmp/flows.md" };
      if (call.method === "gateRun") return { hostId, exitCode: 0, stdout: `${git(base, "rev-parse", "HEAD")}\n`, stderr: "" };
      throw new Error(`unexpected host RPC ${call.method}`);
    },
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  saveProjectSetting(openDatabase(bb), projectId, "docs.enabled", true);
  const key = `docs-worktree:${input.requestedHostId}:${name}`;
  await bb.storage.kv.set(key, { path: input.worktreePath });
  const result = await harness.behavior.runCli(["docs-nightly", projectId]) as { stdout: string };
  return { bb, harness, calls, key, rows: JSON.parse(result.stdout), base, earlierHead };
}

describe("docs worktree recovery from the six MAC Mini merge incidents", () => {
  it.each(fixture.incidents)("recreates a missing saved worktree before merging: $jobId", async (incident) => {
    const { bb, harness, calls, key, rows, base, earlierHead } = await replay(incident);
    expect(rows).toEqual([expect.objectContaining({ state: "skipped", reason: "no code changes" })]);
    expect(calls.filter((call) => call.method === "gitIntegrate").map((call) => call.input.message)).not.toContain("docs: earlier pass");
    expect(harness.logEntries.filter((entry) => entry.level === "warn" && entry.message.includes("docs"))).toEqual([]);
    expect(await bb.storage.kv.get(key)).toBeUndefined();
    expect(await readFile(join(base, "docs/overview.md"), "utf8")).toBe("unmerged docs from the earlier pass\n");
    expect(git(base, "merge-base", "--is-ancestor", earlierHead, "HEAD")).toBe("");
  });

  it("still merges an existing leftover before creating the next pass's worktree", async () => {
    const { calls, base } = await replay(fixture.incidents[0]!, "ready");
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf("gitWorktreeState")).toBeLessThan(methods.indexOf("gitIntegrate"));
    expect(methods.indexOf("gitIntegrate")).toBeLessThan(methods.indexOf("gitCreateWorktree"));
    expect(await readFile(join(base, "docs/overview.md"), "utf8")).toBe("unmerged docs from the earlier pass\n");
  });

  it.each(["failed", "offline"] as const)("keeps the marker and work when inspection is %s", async (state) => {
    const { bb, calls, key, rows, base } = await replay(fixture.incidents[0]!, state);
    expect(rows).toEqual([expect.objectContaining({ state: "failed", reason: expect.stringContaining(state === "offline" ? "host offline" : "git unavailable") })]);
    expect(await bb.storage.kv.get(key)).toEqual({ path: fixture.incidents[0]!.input.worktreePath });
    expect(calls.some((call) => ["gitIntegrate", "gitRemoveWorktree", "gitCreateWorktree"].includes(call.method))).toBe(false);
    expect(await readFile(join(base, "docs/overview.md"), "utf8")).toBe("base docs\n");
  });

  it.each(["create-failed", "create-offline"] as const)("keeps the recovery marker and branch without writing in base when %s", async (state) => {
    const incident = fixture.incidents[0]!;
    const { bb, calls, key, rows, base, earlierHead } = await replay(incident, state);
    expect(rows).toEqual([expect.objectContaining({ state: "failed", reason: expect.stringContaining(state === "create-offline" ? "host offline during recovery" : "recovery failed") })]);
    expect(await bb.storage.kv.get(key)).toEqual({ path: incident.input.worktreePath });
    expect(calls.some((call) => ["gitIntegrate", "gitRemoveWorktree", "listDocsPages"].includes(call.method))).toBe(false);
    expect(git(base, "rev-parse", `lane/docs-${hash(incident.input.basePath)}`)).toBe(earlierHead);
    expect(await readFile(join(base, "docs/overview.md"), "utf8")).toBe("base docs\n");
  });
});
