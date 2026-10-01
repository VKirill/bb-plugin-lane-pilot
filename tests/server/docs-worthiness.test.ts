import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/database";

const projectId = "docs-auto-project";
const factsFor = (path: string) => path.includes("ads")
  ? { status: "ready", trackedFiles: 210, codeFiles: 0, testFiles: 0, contentFiles: 200, languages: [], commits30d: 4, manifests: [], deploy: false, docsPages: 0, reason: null }
  : path.includes("scripts")
    ? { status: "ready", trackedFiles: 90, codeFiles: 15, testFiles: 1, contentFiles: 68, languages: [{ ext: "js", files: 15 }], commits30d: 30, manifests: [], deploy: true, docsPages: 0, reason: null }
    : { status: "ready", trackedFiles: 400, codeFiles: 236, testFiles: 120, contentFiles: 10, languages: [{ ext: "ts", files: 236 }], commits30d: 80, manifests: ["package.json"], deploy: true, docsPages: 0, reason: null };

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("docs in auto mode", () => {
  it("judges each folder on each machine: content gets no docs, a codebase does, System One settles the borderline one", async () => {
    const judged: string[] = [];
    const scoped: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async () => ({ id: projectId, name: "Auto docs", sources: [
            { hostId: "mac-mini", path: "/Users/me/project/ads", isDefault: true },
            { hostId: "ovh", path: "/home/ubuntu/project", isDefault: false },
            { hostId: "ovh", path: "/home/ubuntu/scripts", isDefault: false },
          ] }) as never,
          list: async () => [{ id: projectId }] as never,
        },
      },
      experimental_callHostRpc: (call) => {
        const input = call.input as { projectCwd?: string; state?: string };
        if (call.method === "docsWorthinessFacts") return { hostId: "h", ...factsFor(input.projectCwd!) };
        if (call.method === "councilJudge") { judged.push(input.state!); return { hostId: "h", status: "ok", answers: { worth: "needed" }, confidence: { worth: 0.82 }, reason: null }; }
        if (call.method === "gitDocsScope") {
          scoped.push(input.projectCwd!);
          return { hostId: "h", status: "ready", isRepoRoot: true, hasDocs: false, changed: [], dirty: [], base: null, workspaces: [], localDate: "2026-10-05", localHour: 5, reason: null };
        }
        throw new Error(`stop at ${call.method}`);
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "ovh", pmWorkspacePath: "/home/ubuntu/project", writerWorkspacePath: "/home/ubuntu/project", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });

    const overview = await harness.behavior.callRpc("docs_overview", { projectId }) as { places: Array<Record<string, any>> };
    const byPath = Object.fromEntries(overview.places.map((place) => [place.path, place]));
    expect(byPath["/Users/me/project/ads"]).toMatchObject({ hostId: "mac-mini", mode: "auto", verdict: { need: false, reason: "no_code" } });
    expect(byPath["/home/ubuntu/project"]).toMatchObject({ hostId: "ovh", mode: "auto", verdict: { need: true, reason: "code_project" }, cadence: "nightly", lastReadAt: null });
    expect(byPath["/home/ubuntu/scripts"]).toMatchObject({ verdict: { need: true, reason: "jev_needed", confidence: 0.82 } });
    expect(judged).toHaveLength(1);
    expect(JSON.parse(judged[0]!)).toMatchObject({ code_files: 15, content_files: 68 });
    // A stored verdict is reused while the folder looks the same: no second question.
    await harness.behavior.callRpc("docs_overview", { projectId });
    expect(judged).toHaveLength(1);

    const result = await harness.behavior.runCli(["docs-nightly", projectId]) as { stdout: string };
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/Users/me/project/ads", state: "skipped", reason: "docs_not_needed:no_code" })]));
    expect(rows.find((row) => row.path === "/home/ubuntu/project")?.reason).not.toMatch(/^docs_not_needed/);

    // «Always» bypasses the verdict; «Never» drops the folder before any fact is read.
    saveProjectSetting(db, projectId, "docs.enabled", true);
    const always = await harness.behavior.callRpc("docs_overview", { projectId }) as { places: Array<Record<string, any>> };
    expect(always.places.every((place) => place.mode === "on" && place.verdict === null)).toBe(true);
    saveProjectSetting(db, projectId, "docs.enabled", false);
    scoped.length = 0;
    await harness.behavior.runCli(["docs-nightly", projectId]);
    expect(scoped).toEqual([]);
  });
});
