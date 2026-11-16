import { describe, expect, it } from "vitest";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { loadWorkflowStore } from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { stepPacket } from "../../src/rooms/workflow/server/workflow-agent-packet";
import { runSim } from "./chain-harness";
import { out, pathOf } from "./chain-helpers";

describe("U1 graph contract fixes", () => {
  it("hands the owner's supplied links through the normalized engine into pick", async () => {
    const ownerAnswer = "https://threads.example/p/one\nhttps://threads.example/p/two";
    const result = await runSim("insights-post", {
      input: { topic: "выгорание", platform: "threads", posts_count: 2, post_urls: [] },
      stubs: {
        discover: { candidates: [], count: 0, status: "done" },
        pick: ((ctx: { input: { with: Record<string, unknown> } }) => {
          expect(ctx.input.with).toMatchObject({ owner_answer: ownerAnswer, owner_answer_kind: "links" });
          return { picked: ["https://threads.example/p/one", "https://threads.example/p/two"], picked_count: 2 };
        }) as never,
        "ins.post": { status: "ok", post_folder: "posts/p", summary_path: "posts/p/summary.md" },
        aggregate: { ok: true, index_path: "posts/index.json" },
        enrich: { ready: true, dossier_path: "research/dossier.json", writing_pack_path: "research/writing-pack.md" },
        ready_check: { ok: true },
        goal_check: { ok: true, verdict: "pass", reason: "", details: {} },
      },
      humans: { ask_none: { answer: ownerAnswer, answer_kind: "links" } },
    });

    expect(pathOf(result)).toBe("discover ask_none pick posts aggregate enrich ready_check goal_check done");
    expect(out(result)).toMatchObject({ status: "done", posts: ["posts/p", "posts/p"] });
  });

  it("puts the producer's owner answer in the actual pick step packet", async () => {
    const ownerAnswer = "https://threads.example/p/one\nhttps://threads.example/p/two";
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES });
    const workflow = store.get("insights-post")!.workflow;
    const node = workflow.nodes.find((candidate) => candidate.id === "pick")!;
    const ctx = {
      runId: "wfrun_u1_packet",
      stepKey: "pick",
      nodeId: "pick",
      node,
      workflow,
      attempt: 1,
      input: {
        with: { owner_answer: ownerAnswer, owner_answer_kind: "links" },
        via: { mode: "fresh", fromStep: null, fromThreadId: null, handoff: null },
      },
      runtime: undefined,
      mode: "standard",
      goals: [],
      reground: false,
      inputs: { topic: "выгорание", platform: "threads", posts_count: 2, post_urls: [] },
      spawnKey: "pick",
      signal: new AbortController().signal,
      resolve: (ref: string) => ({ "ask_none.answer": ownerAnswer, "ask_none.answer_kind": "links" })[ref],
      render: (text: string) => text,
      value: (spec: unknown) => spec,
      template: (value: unknown) => value,
      effect: async (_key: string, _kind: string, fn: () => Promise<unknown>) => fn(),
    } as unknown as StepContext<ChainRuntime>;

    const packet = stepPacket(ctx, node as never).packet;
    expect(packet).toContain("owner_answer: https://threads.example/p/one https://threads.example/p/two");
    expect(packet).toContain("owner_answer_kind: links");
  });

  it("asks for links after an empty pick and uses only those links on the bounded second pick", async () => {
    const ownerAnswer = "https://threads.example/p/owner";
    const result = await runSim("insights-post", {
      input: { topic: "выгорание", platform: "threads", posts_count: 1, post_urls: [] },
      stubs: {
        discover: { candidates: [{ url: "https://threads.example/p/discovered", comments: 41 }], count: 1, status: "done" },
        pick: [
          { picked: [], picked_count: 0 },
          { picked: [ownerAnswer], picked_count: 1 },
        ],
        "ins.post": { status: "ok", post_folder: "posts/p", summary_path: "posts/p/summary.md" },
        aggregate: { ok: true, index_path: "posts/index.json" },
        enrich: { ready: true, dossier_path: "research/dossier.json", writing_pack_path: "research/writing-pack.md" },
        ready_check: { ok: true },
        goal_check: { ok: true, verdict: "pass", reason: "", details: {} },
      },
      humans: { ask_none: { answer: ownerAnswer, answer_kind: "links" } },
    });

    expect(pathOf(result)).toBe("discover pick ask_none pick posts aggregate enrich ready_check goal_check done");
    expect(result.called("posts:child").map((call) => call.input.post_url)).toEqual([ownerAnswer]);
  });

  it("runs one bounded retry with the owner's changed request and preserves the selected URL", async () => {
    const change = "Keep the topic, but search VK instead of Threads";
    const retryUrl = "https://vk.com/wall-1_2";
    const result = await runSim("insights-post", {
      input: { topic: "выгорание", platform: "threads", posts_count: 1, post_urls: [] },
      stubs: {
        discover: { candidates: [], count: 0, status: "done" },
        discover_retry: ((ctx: { input: { with: Record<string, unknown> } }) => {
          expect(ctx.input.with).toMatchObject({ owner_answer: change, owner_answer_kind: "retry" });
          return { candidates: [{ url: retryUrl, comments: 52 }], count: 1, status: "done" };
        }) as never,
        pick: { picked: [retryUrl], picked_count: 1 },
        "ins.post": { status: "ok", post_folder: "posts/p", summary_path: "posts/p/summary.md" },
        aggregate: { ok: true, index_path: "posts/index.json" },
        enrich: { ready: true, dossier_path: "research/dossier.json", writing_pack_path: "research/writing-pack.md" },
        ready_check: { ok: true },
        goal_check: { ok: true, verdict: "pass", reason: "", details: {} },
      },
      humans: { ask_none: { answer: change, answer_kind: "retry" } },
    });

    expect(pathOf(result)).toBe("discover ask_none discover_retry pick posts aggregate enrich ready_check goal_check done");
    expect(result.called("posts:child").map((call) => call.input.post_url)).toEqual([retryUrl]);
  });

  it("blocks an exhausted retry or an owner abort/timeout without fabricating URLs", async () => {
    const base = {
      input: { topic: "выгорание", platform: "threads", posts_count: 1, post_urls: [] },
      stubs: { discover: { candidates: [], count: 0, status: "done" } },
    };
    const exhausted = await runSim("insights-post", {
      ...base,
      stubs: {
        ...base.stubs,
        discover_retry: { candidates: [], count: 0, status: "done" },
      },
      humans: { ask_none: { answer: "try again", answer_kind: "retry" } },
    });
    expect(exhausted.summary.status).toBe("succeeded");
    expect(pathOf(exhausted)).toBe("discover ask_none discover_retry blocked");
    expect(out(exhausted)).toMatchObject({ status: "blocked" });
    expect(exhausted.called("posts:child")).toHaveLength(0);

    for (const answer_kind of ["abort", "timeout"] as const) {
      const result = await runSim("insights-post", { ...base, humans: { ask_none: { answer: "", answer_kind } } });
      expect(pathOf(result)).toBe("discover ask_none blocked");
      expect(out(result)).toMatchObject({ status: "blocked" });
      expect(result.called("posts:child")).toHaveLength(0);
    }
  });

  it.each(["held", "trial", "skipped", "retired"] as const)(
    "emits the critic-edit gate status %s through the normalized output contract",
    async (status) => {
      const result = await runSim("lp.critic-edit", {
        input: { project_id: "proj-1", bench: "" },
        stubs: {
          prepare: { status: "ready", detail: "proposal", proposal: "candidate" },
          gate: { status, detail: `${status} detail` },
        },
      });

      expect(pathOf(result)).toBe("prepare gate done");
      expect(out(result)).toMatchObject({ status, detail: `${status} detail` });
    },
  );
});
