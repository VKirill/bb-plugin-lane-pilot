import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { createLearning } from "../../src/rooms/learning/service";
import { insertObservation, projectsWithCandidates, type Observation } from "../../src/rooms/learning/store";
import { memorySettingsFor } from "../../src/rooms/memory/server";
import { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule } from "../../src/rooms/self-repair/server";
import { openDatabase } from "../../src/rooms/plugin-db";

const insights = { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule };

let n = 0;
function plant(db: ReturnType<typeof openDatabase>, projectId: string, text: string, at = Date.now() - 60_000): void {
  const row: Observation = { id: `thr_${projectId}:${++n}:0`, threadId: `thr_${projectId}`, projectId, at, judgedAt: at, source: "live", chars: text.length, excerpt: text, state: "candidate", skipReason: null, sensitive: false, body: text, prev: "ok" };
  insertObservation(db, row);
}

function setup(hosts: Record<string, unknown>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("projects.get", async (args: unknown) => ({ id: (args as { projectId: string }).projectId, name: `Name of ${(args as { projectId: string }).projectId}` }));
  const db = openDatabase(bb);
  const asked: Array<{ threadProject: string; hostId: string }> = [];
  const services = {
    insights, memorySettings: memorySettingsFor,
    resolveProjectWriterHost: async ({ projectId }: { projectId: string }) => hosts[projectId] ?? { status: "missing" },
    ruleScan: {
      analyzerFor: async () => ({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" }),
      runAnalyzer: async (threadProject: string, _title: string, _prompt: string, place: { hostId: string }) => { asked.push({ threadProject, hostId: place.hostId }); return JSON.stringify({ items: [] }); },
    },
  };
  const learning = createLearning(createCore(bb as never, db) as never, services as never);
  return { db, learning, asked };
}

describe("the night run with a project that has no writer host", () => {
  it("runs the analyzer for it on the machine of another project, in that project's hidden thread", async () => {
    const { db, learning, asked } = setup({ proj_a: { status: "resolved", hostId: "host_a", path: "/srv/a" } });
    plant(db, "proj_a", "Always answer in Russian, briefly");
    plant(db, "proj_personal", "Never write long reports to me");
    const report = await learning.nightRun();
    expect(report.projects).toBe(2);
    expect(report.skipped).toBeUndefined();
    expect(report.stopped).toBeUndefined();
    expect(asked).toEqual(expect.arrayContaining([{ threadProject: "proj_a", hostId: "host_a" }]));
    expect(asked).toHaveLength(2);
    expect(projectsWithCandidates(db)).toEqual([]);
  });

  it("skips only that project when no project has a machine, names it, and keeps its candidates waiting", async () => {
    const { db, learning, asked } = setup({});
    plant(db, "proj_personal", "Never write long reports to me");
    plant(db, "proj_personal", "Answer in Russian");
    const report = await learning.nightRun();
    expect(asked).toEqual([]);
    expect(report.stopped).toBeUndefined();
    expect(report.skipped).toEqual([{ projectId: "proj_personal", name: "Name of proj_personal", reason: "no_host", waiting: 2 }]);
    expect(projectsWithCandidates(db).map((row) => [row.projectId, row.waiting])).toEqual([["proj_personal", 2]]);
  });

  it("does not let the project without a machine stop the others", async () => {
    // proj_b resolves; proj_c has no host and no donor can be read once the donor list is empty of resolved ones.
    const { db, learning, asked } = setup({ proj_b: { status: "resolved", hostId: "host_b", path: "/srv/b" } });
    plant(db, "proj_c", "x".repeat(30), Date.now() - 120_000);
    plant(db, "proj_b", "Prefer tabs over spaces in all code");
    const report = await learning.nightRun();
    expect(report.projects).toBe(2);
    expect(asked.map((row) => row.hostId)).toEqual(["host_b", "host_b"]);
  });
});
