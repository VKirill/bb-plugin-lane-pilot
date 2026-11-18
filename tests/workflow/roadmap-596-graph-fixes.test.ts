import { describe, expect, it } from "vitest";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

const sourceOf = (name: string) => BUILTIN_SOURCES.find((s) => s.name === name)?.value as Record<string, unknown>;

describe("0.1.596 workflow handoffs, requires hygiene, and zero lane-plan CLI references (P04 / P07.07)", () => {
  it("reels film branch delivers style_pick.answer and subject to script and build_film and confines helper writes to .bb/chats/", async () => {
    const raw = sourceOf("reels.json") as { nodes: Array<{ id: string; prompt?: string; child?: { prompt?: string } }> };
    for (const id of ["ingest", "transcribe", "select", "edit_plan", "script", "build_film"]) {
      const node = raw.nodes.find((n) => n.id === id);
      expect(node?.prompt, id).toContain(".bb/chats/reels/{{run_id}}/");
    }
    const renderChild = raw.nodes.find((n) => n.id === "render")?.child;
    expect(renderChild?.prompt).toContain(".bb/chats/reels/{{run_id}}/");

    const sim = await runSim("reels", {
      input: { source: "", subject: "Как работает кэш", style: "" },
      humans: { style_pick: { answer: "chalk", answer_kind: "chosen" } },
      stubs: {
        script: { script_path: ".bb/chats/reels/r1/film/script.md", scene_count: 4 },
        build_film: { film_path: ".bb/chats/reels/r1/films/cache/film.mp4", ok: true },
        verify_film: { ok: true, issues: [] },
        deliver_film: { folder: "reels/2026-11-18-cache-r1/delivery/" },
        goal_check_film: { ok: true, verdict: "pass", reason: "", details: {} },
      },
    });
    expect(pathOf(sim)).toBe("ingest style_pick script build_film verify_film deliver_film goal_check_film done_film");
    expect(sim.called("script")[0]?.input).toMatchObject({ chosen_style: "chalk", subject: "Как работает кэш" });
    expect(sim.called("build_film")[0]?.input).toMatchObject({
      chosen_style: "chalk",
      subject: "Как работает кэш",
      script_path: ".bb/chats/reels/r1/film/script.md",
    });
    expect(out(sim)).toMatchObject({ status: "done", film_path: ".bb/chats/reels/r1/films/cache/film.mp4" });
  });

  it("ins.post forwards init.post_folder across lenses, psychology, critic, rework, and digest", async () => {
    const sim = await runSim("ins.post", {
      input: { post_url: "https://threads.net/p/1", topic: "burnout", root: "/tmp/ins" },
      stubs: {
        collect: { post_json: "/tmp/p.json", replies_json: "/tmp/r.json", comments: 25, status: "done" },
        init: { post_folder: "/tmp/ins/burnout/post-1", ok: true },
        lenses: { lenses_done: ["pains"], analysis_dir: "/tmp/ins/burnout/post-1/analysis" },
        psychology: { needs_ok: true },
        critic: { rejects_open: 0, review_path: "/tmp/ins/burnout/post-1/review.yaml" },
        renorm: { ok: true },
        validate: { ok: true, errors: [] },
        digest: { summary_path: "/tmp/ins/burnout/post-1/summary.md" },
        goal_check: { ok: true, verdict: "pass", reason: "", details: {} },
      },
    });
    expect(pathOf(sim)).toBe("collect init lenses psychology critic renorm validate digest goal_check ok");
    for (const nodeId of ["lenses", "psychology", "critic", "digest"]) {
      expect(sim.called(nodeId)[0]?.input, nodeId).toMatchObject({ post_folder: "/tmp/ins/burnout/post-1" });
    }
  });

  it("insights-post forwards enrich.writing_pack_path and dossier_path into draft_post when draft=true", async () => {
    const sim = await runSim("insights-post", {
      input: { topic: "выгорание", post_urls: ["https://threads.net/p/1"], draft: true },
      stubs: {
        pick: { picked: ["https://threads.net/p/1"], picked_count: 1 },
        "ins.post": { status: "ok", post_folder: "/tmp/ins/p1", summary_path: "/tmp/ins/p1/summary.md" },
        aggregate: { index_path: "/tmp/ins/index.json", ok: true },
        enrich: { dossier_path: "/tmp/ins/dossier.json", writing_pack_path: "/tmp/ins/writing-pack.md", ready: true },
        ready_check: { ok: true, errors: [] },
        draft_post: { draft_path: "/tmp/ins/draft.md", claims_used: 3 },
        goal_check: { ok: true, verdict: "pass", reason: "", details: {} },
      },
    });
    expect(pathOf(sim)).toBe("discover pick posts aggregate enrich ready_check draft_post goal_check done");
    expect(sim.called("draft_post")[0]?.input).toMatchObject({
      writing_pack_path: "/tmp/ins/writing-pack.md",
      dossier_path: "/tmp/ins/dossier.json",
    });
    expect(out(sim)).toMatchObject({ status: "done", draft_path: "/tmp/ins/draft.md", writing_pack_path: "/tmp/ins/writing-pack.md" });
  });

  it("roadmap-driven demands goals on each session item and forwards goals + $mode into analyze-plan-execute", async () => {
    const raw = sourceOf("roadmap-driven.json") as { nodes: Array<{ id: string; prompt?: string }> };
    const roadmapNode = raw.nodes.find((n) => n.id === "roadmap");
    expect(roadmapNode?.prompt).toContain("goals (Goal[]");

    const rd = await runSim("roadmap-driven", {
      input: { goal: "Billing", requirements: "Login + invoices", mode: "auto" },
      humans: { approve: { answer_kind: "approve" } },
      stubs: {
        "lp.analyze": { scope_verdict: "medium" },
        roadmap: {
          sessions: [{ id: "s1", intent: "login", scope: "src/auth", goals: [{ id: "g1", done_when: "login works", evidence: "test" }], depends_on: [] }],
          session_count: 1,
          mode: "single",
        },
        validate: { ok: true, errors: [], cycles: [] },
        "analyze-plan-execute": { status: "done", merged_commits: ["c1"] },
        "lp.close": { status: "closed", report_path: "reports/close.md" },
      },
    });
    expect(rd.called("sessions:child")[0]?.input).toMatchObject({
      goal: "login",
      scope: "src/auth",
      goals: [{ id: "g1", done_when: "login works", evidence: "test" }],
      quality_mode: "standard",
    });
  });

  it("removes non-existent lane-plan shell invocations from shipped workflow definitions and keeps requires.tools restricted to real executables", () => {
    for (const entry of BUILTIN_SOURCES) {
      const text = JSON.stringify(entry.value);
      if (entry.name === "project-start.json") {
        expect(text).not.toContain("lane-plan profile --set");
        continue;
      }
      expect(text, entry.name).not.toMatch(/lane-plan\s+(?:render-hooks|audit-uat|profile|phase\s+add)/);
    }

    const asset3d = sourceOf("3d-asset.json") as { requires: { plugins: string[]; tools: string[] } };
    expect(asset3d.requires.plugins).toContain("image-studio");
    expect(asset3d.requires.tools).not.toContain("image-studio");

    const roblox = sourceOf("roblox-asset.json") as { requires: { mcp: string[]; tools: string[] } };
    expect(roblox.requires.mcp).toContain("studio-mcp");
    expect(roblox.requires.tools).not.toContain("studio-mcp");

    const ship = sourceOf("ship.json") as { requires: { tools: string[] } };
    expect(ship.requires.tools).toContain("gh");

    const cleanup = sourceOf("cleanup.json") as { requires: { tools: string[] } };
    expect(cleanup.requires.tools).toContain("~/.agents/lane-pilot/bin/agent-trash");
  });
});
