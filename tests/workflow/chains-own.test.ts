import { describe, expect, it } from "vitest";
import { finding, firstInput, modeOf, out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * The owner's own chains: x-to-telegram-digest, insights-post, reels, seo-cocoon, web-research, deploy. They need tools the
 * test machine does not have (X in a browser, Telegram, ffmpeg, a server), so every outside action answers from a stub and the
 * chains stay `tested`; the live run is each chain's `test.live` note.
 */

const posts = (count: number, dupes = 0) => Array.from({ length: count }, (_, index) => ({ url: `https://x.example/p/${index % Math.max(1, count - dupes)}`, text: `post number ${index} about design systems` }));

describe("x-to-telegram-digest", () => {
  const input = { query: "дизайн-системы", period: "7d", limit: 30, chat: "me", language: "ru" };
  const base = (collected: unknown[]) => ({ collect: { items: collected, count: collected.length, status: "done" }, summarize: { summary_md: "# Digest", top: [], themes: ["a", "b"], quote_count: 3 }, check: { ok: true, violations: [], parts: 1 },
    send: { message_id: "stub-1", status: "ok" }, archive: { archive_path: ".lane-pilot/digests/x" } });

  it("the spec's case through the real dedupe and reducer: 34 posts, 3 duplicates, 4 batches, one message", async () => {
    const r = await runSim("x-to-telegram-digest", { input, stubs: { ...base(posts(34, 3)), "score:child": ((ctx: { input: { item?: unknown } }) => ({ scores: (ctx.input.item as unknown[]).map((item) => ({ item, keep: true, topic: "tokens" })) })) as never, check: undefined as never } });
    expect(r.summary.status).toBe("succeeded");
    expect(out(r)).toMatchObject({ status: "sent", items_count: 31, kept_count: 31, message_id: "stub-1", thin: false });
    expect(r.called("score:child")).toHaveLength(4);
    // The digest check is code: a summary that quotes nothing and links nothing passes it.
    expect(r.called("send")).toHaveLength(1);
  });

  it("the check is code: an invented link in the summary stops the send", async () => {
    const r = await runSim("x-to-telegram-digest", { input, stubs: { ...base(posts(34, 3)), summarize: { summary_md: "see https://evil.example/x" }, check: undefined as never } });
    expect(r.called("send")).toHaveLength(0);
    expect(pathOf(r)).not.toContain("send");
  });
});

describe("insights-post", () => {
  const input = { topic: "выгорание", platform: "threads", posts_count: 2, post_urls: ["fixtures/post-a", "fixtures/post-b"] };
  const base = () => ({ pick: { picked: ["fixtures/post-a", "fixtures/post-b"], picked_count: 2 }, "ins.post": { status: "ok", post_folder: "p", summary_path: "fixtures/summary.md" }, aggregate: { ok: true, index_path: "i" },
    enrich: { ready: true, dossier_path: "d.md", writing_pack_path: "pack.md" }, ready_check: { ok: true } });

  it("the spec's case: given links skip the search; every post runs ins.post; the dossier is validated; no draft unless asked", async () => {
    const r = await runSim("insights-post", { input, stubs: base() });
    expect(pathOf(r)).toBe("discover pick posts aggregate enrich ready_check draft_post done");
    expect(r.skipped).toEqual(["discover", "draft_post"]);
    expect(out(r)).toMatchObject({ status: "done", posts: ["p", "p"], summary_paths: ["fixtures/summary.md", "fixtures/summary.md"], writing_pack_path: "pack.md" });
    expect(out(r)!.draft_path ?? "").toBe("");
    expect(r.called("posts:child").map((call) => call.input)).toEqual([expect.objectContaining({ post_url: "fixtures/post-a", topic: "выгорание" }), expect.objectContaining({ post_url: "fixtures/post-b" })]);
  });

  it("the search finds nothing: the owner gives links or retries once, or the run is blocked", async () => {
    const stubs = () => ({ ...base(), discover: { candidates: [], count: 0, status: "done" } });
    const noLinks = { ...input, post_urls: [] };
    const retry = await runSim("insights-post", { input: noLinks, stubs: stubs(), humans: { ask_none: { answer_kind: "retry" } } });
    expect(pathOf(retry)).toBe("discover ask_none pick posts aggregate enrich ready_check draft_post done");
    expect(pathOf(await runSim("insights-post", { input: noLinks, stubs: stubs(), humans: { ask_none: { answer_kind: "abort" } } }))).toBe("discover ask_none blocked");
  });

  it("a post that fails its analysis is dropped; all posts failing is blocked; a dossier that is not ready ends partial", async () => {
    const partial = await runSim("insights-post", { input, stubs: { ...base(), "ins.post": [{ status: "ok", post_folder: "p1", summary_path: "s1" }, { status: "rework_failed", post_folder: "p2" }] } });
    expect(out(partial)).toMatchObject({ status: "done", posts: ["p1"] });
    expect(pathOf(await runSim("insights-post", { input, stubs: { ...base(), "ins.post": { status: "blocked" } } }))).toBe("discover pick posts blocked");
    const notReady = await runSim("insights-post", { input, stubs: { ...base(), ready_check: { ok: false } } });
    expect(pathOf(notReady)).toBe("discover pick posts aggregate enrich ready_check enrich ready_check partial");
    expect(out(notReady)).toMatchObject({ status: "partial" });
  });

  it("a post run that crashes does not take the others down (the join takes the posts that finished)", async () => {
    const crash = ((ctx: { input: { item?: unknown } }) => { if (ctx.input.item === "fixtures/post-a") throw new Error("thread died"); return { status: "ok", post_folder: "p2", summary_path: "s2" }; }) as never;
    const r = await runSim("insights-post", { input, stubs: { ...base(), "ins.post": crash } });
    // The join of this chain is `all`: one failed post run ends the run, and says which.
    expect(r.summary.status).toBe("failed");
    expect(r.summary.error).toContain("thread died");
  });

  it("with draft=true the copy lead writes a draft from the allowed claims", async () => {
    const r = await runSim("insights-post", { input: { ...input, draft: true }, stubs: { ...base(), draft_post: { draft_path: "draft.md", claims_used: 4 } } });
    expect(r.skipped).toEqual(["discover"]);
    expect(out(r)).toMatchObject({ draft_path: "draft.md" });
  });
});

describe("reels", () => {
  const clips = { clips: [{ id: "c1", start: 1, end: 31 }, { id: "c2", start: 40, end: 80 }], clip_count: 2 };
  const base = () => ({ ingest: { ok: true, duration_s: 300, folder: "reels/x" }, transcribe: { ok: true, transcript_path: "t.json" }, select: clips, prepare: { ok: true },
    "render:child": ((ctx: { input: { item?: unknown } }) => ({ clip_id: (ctx.input.item as { id: string }).id, file: `${(ctx.input.item as { id: string }).id}.mp4`, duration_s: 30, ok: true })) as never,
    "verify:child": ((ctx: { input: { item?: unknown } }) => ({ clip_file: String(ctx.input.item), ok: true, issues: [] })) as never, deliver: { folder: "reels/x/delivery" } });
  const video = { source: "fixtures/interview-5min.mp4", count: 2, language: "ru", quality_mode: "standard" };

  it("the spec's case: a video becomes 2 clips: transcript, selection, edit plan, render, verification, captions, delivery", async () => {
    const r = await runSim("reels", { input: video, stubs: base() });
    expect(pathOf(r)).toBe("ingest transcribe select approve_clips edit_plan prepare render verify publish_text deliver done");
    expect(r.skipped).toEqual(["approve_clips"]);
    expect(out(r)).toMatchObject({ status: "done", clips: ["c1.mp4", "c2.mp4"], folder: "reels/x/delivery", captions_ok: true });
  });

  it("full mode asks the owner to approve the clip list; a change goes back to the selection in the same session", async () => {
    const r = await runSim("reels", { input: { ...video, quality_mode: "full" }, stubs: base(), humans: { approve_clips: [{ answer_kind: "change", answer: "shorter" }, { answer_kind: "ok" }] } });
    expect(pathOf(r)).toBe("ingest transcribe select approve_clips select approve_clips edit_plan prepare render verify publish_text deliver done");
  });

  it("missing tools or a failed transcript block before anything is made", async () => {
    const r = await runSim("reels", { input: video, stubs: { ...base(), ingest: { ok: false, missing_tools: ["ffmpeg"], reason: "missing_tools" } } });
    expect(pathOf(r)).toBe("ingest blocked");
    expect(pathOf(await runSim("reels", { input: video, stubs: { ...base(), transcribe: { ok: false } } }))).toBe("ingest transcribe blocked");
  });

  it("a failed timeline preparation goes back to the edit plan up to 3 times", async () => {
    const r = await runSim("reels", { input: video, stubs: { ...base(), prepare: [{ ok: false }, { ok: true }] } });
    expect(pathOf(r)).toBe("ingest transcribe select approve_clips edit_plan prepare edit_plan prepare render verify publish_text deliver done");
    const dead = await runSim("reels", { input: video, stubs: { ...base(), prepare: { ok: false } } });
    expect(pathOf(dead)).toBe("ingest transcribe select approve_clips edit_plan prepare edit_plan prepare edit_plan prepare blocked");
  });

  it("clips that fail verification are rendered again once; then the run is partial with what rendered", async () => {
    const bad = ((ctx: { input: { item?: unknown } }) => ({ clip_file: String(ctx.input.item), ok: ctx.input.item !== "c2.mp4", issues: ctx.input.item === "c2.mp4" ? ["audio dropout"] : [] })) as never;
    const r = await runSim("reels", { input: video, stubs: { ...base(), "verify:child": bad } });
    expect(pathOf(r)).toBe("ingest transcribe select approve_clips edit_plan prepare render verify render verify partial");
    expect(out(r)).toMatchObject({ status: "partial", clips: ["c1.mp4", "c2.mp4"] });
  });

  it("quick mode has no caption text for publishing", async () => {
    const r = await runSim("reels", { input: { ...video, quality_mode: "quick" }, stubs: base() });
    expect(r.skipped).toEqual(expect.arrayContaining(["publish_text"]));
    expect(modeOf(r)).toBe("quick");
  });

  it("without a video it is a film: the style is asked, a script is written, rendered by code and checked", async () => {
    const film = { subject: "How a browser renders a page", quality_mode: "standard" };
    const r = await runSim("reels", { input: film, stubs: { script: { script_path: "s.md", scene_count: 6 }, build_film: { film_path: "films/x/film.mp4", ok: true }, verify_film: { ok: true }, deliver: { folder: "films/x" } }, humans: { style_pick: { answer_kind: "chosen", answer: "chalk" } } });
    expect(pathOf(r)).toBe("ingest style_pick script build_film verify_film deliver done_film");
    expect(out(r)).toMatchObject({ status: "done", film_path: "films/x/film.mp4", folder: "films/x" });
    expect(r.skipped).toEqual(["ingest"]);
    const styled = await runSim("reels", { input: { ...film, style: "watercolor" }, stubs: { script: {}, build_film: { ok: true }, verify_film: { ok: true } } });
    expect(styled.skipped).toEqual(expect.arrayContaining(["style_pick"]));
  });

  it("a film that fails its check is built once more, then ends partial", async () => {
    const r = await runSim("reels", { input: { subject: "s", style: "chalk" }, stubs: { build_film: { film_path: "f.mp4", ok: true }, verify_film: { ok: false, issues: ["no subtitles"] } } });
    expect(pathOf(r)).toBe("ingest style_pick script build_film verify_film build_film verify_film partial");
  });
});

describe("seo-cocoon", () => {
  const input = { topic: "кофемашины для дома", geo: "RU", language: "ru", site_goal: "интернет-магазин", use_seo_tools: false, max_pages: 12 };
  const pages = Array.from({ length: 10 }, (_unused, at) => ({ slug: `page-${at}`, intent: "buy" }));
  const brief = ((ctx: { input: { item?: unknown } }) => ({ slug: (ctx.input.item as { slug: string }).slug, brief_path: `briefs/${(ctx.input.item as { slug: string }).slug}.md` })) as never;
  const base = () => ({ chainsmith: { ok: true }, "evidence:child": ((ctx: { input: { item?: unknown } }) => ({ branch: String(ctx.input.item), findings_path: `${String(ctx.input.item)}.md`, sources: [], skipped: ctx.input.item === "frequency" })) as never,
    architecture: { page_count: 10, clusters: [{ name: "выбор" }, { name: "уход" }], pages }, "briefs:child": brief, package: { folder: ".agents/seo/kofemashiny", handoff_path: ".agents/seo/kofemashiny/handoff.md" } });

  it("the spec's case: a rework of the audit goes back to the architecture and the briefs once, then the package", async () => {
    const r = await runSim("seo-cocoon", { input, stubs: { ...base(), audit: [{ status: "rework", cannibal_count: 1 }, { status: "pass" }] } });
    expect(pathOf(r)).toBe("ask_brief chainsmith evidence architecture briefs audit architecture briefs audit package done");
    expect(r.skipped).toEqual(["ask_brief"]);
    expect(out(r)).toMatchObject({ status: "done", page_count: 10, audit_status: "pass", folder: ".agents/seo/kofemashiny", handoff_path: ".agents/seo/kofemashiny/handoff.md" });
    expect(r.called("briefs:child")).toHaveLength(20);
    // The evidence branch that had no data is named, not silently dropped.
    const evidence = r.db.prepare("SELECT output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='evidence' LIMIT 1").get(r.summary.runId) as { output_json: string };
    expect(JSON.parse(evidence.output_json)).toMatchObject({ skipped_branches: ["frequency"], findings_paths: ["audience.md", "external.md"] });
  });

  it("30 pages fit: the briefs run three at a time, not 5 in total", async () => {
    const many = Array.from({ length: 30 }, (_unused, at) => ({ slug: `p${at}` }));
    const r = await runSim("seo-cocoon", { input, stubs: { ...base(), architecture: { page_count: 30, pages: many }, audit: { status: "pass" } } });
    expect(out(r)).toMatchObject({ status: "done" });
    expect(r.called("briefs:child")).toHaveLength(30);
  });

  it("the brief is asked first when the geo or the site goal is missing; the chainsmith can refuse", async () => {
    const r = await runSim("seo-cocoon", { input: { topic: "кофе" }, stubs: { ...base(), audit: { status: "pass" } }, humans: { ask_brief: { answer_kind: "answered", answer: "RU, shop" } } });
    expect(pathOf(r).startsWith("ask_brief chainsmith")).toBe(true);
    expect(r.skipped).not.toContain("ask_brief");
    expect(pathOf(await runSim("seo-cocoon", { input, stubs: { chainsmith: { ok: false } } }))).toBe("ask_brief chainsmith blocked");
  });

  it("a second failed audit is a partial result with the audit status; quick has no audit", async () => {
    const r = await runSim("seo-cocoon", { input, stubs: { ...base(), audit: { status: "rework" } } });
    expect(pathOf(r)).toBe("ask_brief chainsmith evidence architecture briefs audit architecture briefs audit package partial");
    expect(out(r)).toMatchObject({ status: "partial", audit_status: "rework" });
    const quick = await runSim("seo-cocoon", { input, mode: "quick", stubs: base() });
    expect(quick.skipped).toEqual(expect.arrayContaining(["audit"]));
    expect(out(quick)).toMatchObject({ status: "done" });
  });
});

describe("web-research", () => {
  const input = { question: "What changed in the React 19 compiler?", depth: "quick", language: "en" };
  const source = (n: number) => ({ url: `https://s${n}.example`, title: `Source ${n}` });
  const found = ((ctx: { input: { item?: unknown } }) => ({ subquestion: String(ctx.input.item), sources: ctx.input.item === "q2" ? [] : [source(1), source(2), source(3)] })) as never;
  const base = () => ({ frame: { subquestions: ["q1", "q2"], sub_count: 2, needs_clarification: false }, "search:child": found, claims: { claim_count: 4, unverified: ["benchmark numbers"], claims: [], counter: [] }, deliver: { report_path: "reports/research-1.md" } });

  it("the spec's case: frame, parallel search, claims, report, the citation check is code, delivery", async () => {
    const r = await runSim("web-research", { input, stubs: { ...base(), report: { report_md: "A [1]. B [2]. C [3].", cited_ids: ["1", "2", "3"] } } });
    expect(pathOf(r)).toBe("frame search claims report check deliver done");
    expect(out(r)).toMatchObject({ status: "done", citation_ok: true, unverified: ["benchmark numbers"], report_path: "reports/research-1.md" });
    expect((out(r)!.sources as unknown[]).length).toBe(3);
    expect(firstInput(r, "claims")).toBeDefined();
  });

  it("a report that cites a source that does not exist goes back to the writer once; still wrong, the run is partial", async () => {
    const bad = { report_md: "A [1]. B [9]." };
    const fixed = await runSim("web-research", { input, stubs: { ...base(), report: [bad, { report_md: "A [1]. B [2]. C [3]." }] } });
    expect(pathOf(fixed)).toBe("frame search claims report check report check deliver done");
    const still = await runSim("web-research", { input, stubs: { ...base(), report: bad } });
    expect(pathOf(still)).toBe("frame search claims report check report check deliver partial");
    expect(out(still)).toMatchObject({ status: "partial", citation_ok: false });
  });

  it("an unclear question is asked back; no sources at all is blocked", async () => {
    const asked = await runSim("web-research", { input, stubs: { ...base(), frame: [{ needs_clarification: true, clarification: "which compiler?", subquestions: [] }, { needs_clarification: false, subquestions: ["q1"] }], report: { report_md: "A [1]. B [2]. C [3]." } }, humans: { ask: { answer_kind: "answered", answer: "the React one" } } });
    expect(pathOf(asked)).toBe("frame ask frame search claims report check deliver done");
    const none = await runSim("web-research", { input, stubs: { ...base(), "search:child": ((ctx: { input: { item?: unknown } }) => ({ subquestion: String(ctx.input.item), sources: [] })) as never } });
    expect(pathOf(none)).toBe("frame search blocked");
  });
});

describe("deploy", () => {
  const input = { target: "lane-pilot-plugin", environment: "prod", incident: "" };
  const ready = { clean: true, pushed: true, running_attempts: 0, gate_ok: true, deployed_today: false, last_version: "0.1.182" };
  const base = () => ({ preflight: ready, tests: { ok: true }, push_plugin: { ok: true, version: "0.1.183", log_path: "deploys.log" }, post_check: { ok: true }, record: { staged: 1 } });

  it("the spec's case: preflight, tests skipped for the plugin, approval, push, post-check, record, deployed", async () => {
    const r = await runSim("deploy", { input, stubs: base(), humans: { approve: { answer_kind: "deploy" } } });
    expect(pathOf(r)).toBe("preflight tests approve push_plugin post_check record deployed");
    expect(out(r)).toMatchObject({ status: "deployed", deployed_version: "0.1.183", post_check_ok: true, rollback_needed: false });
    expect(r.called("push_plugin")).toHaveLength(1);
  });

  it("a failed post-check asks whether to roll back; a rollback ends rolled_back", async () => {
    const r = await runSim("deploy", { input, stubs: { ...base(), post_check: { ok: false }, rollback: { ok: true } }, humans: { approve: { answer_kind: "deploy" }, ask_rollback: { answer_kind: "rollback" } } });
    expect(pathOf(r)).toBe("preflight tests approve push_plugin post_check ask_rollback rollback rolled_back");
    expect(out(r)).toMatchObject({ status: "rolled_back" });
    const left = await runSim("deploy", { input, stubs: { ...base(), post_check: { ok: false } }, humans: { approve: { answer_kind: "deploy" }, ask_rollback: { answer_kind: "leave" } } });
    expect(out(left)).toMatchObject({ status: "failed", rollback_needed: true });
  });

  it("an owner who does not approve stops the deploy before any push (the timeout is an abort)", async () => {
    const r = await runSim("deploy", { input, stubs: base(), humans: { approve: { answer_kind: "timeout" } } });
    expect(pathOf(r)).toBe("preflight tests approve aborted");
    expect(out(r)).toMatchObject({ status: "aborted" });
    expect(r.called("push_plugin")).toHaveLength(0);
  });

  it("a dirty tree, an unpushed head, running attempts or a red gate block the preflight", async () => {
    for (const bad of [{ clean: false }, { pushed: false }, { running_attempts: 2 }, { gate_ok: false }]) {
      const r = await runSim("deploy", { input, stubs: { ...base(), preflight: { ...ready, ...bad } } });
      expect(pathOf(r), JSON.stringify(bad)).toBe("preflight blocked");
    }
  });

  it("a second deploy of the plugin in a day needs a stated incident; staging skips the owner's approval", async () => {
    const again = { ...base(), preflight: { ...ready, deployed_today: true } };
    const asked = await runSim("deploy", { input, stubs: again, humans: { ask_incident: { answer_kind: "reason", answer: "hotfix" }, approve: { answer_kind: "deploy" } } });
    expect(pathOf(asked)).toBe("preflight ask_incident tests approve push_plugin post_check record deployed");
    expect(pathOf(await runSim("deploy", { input, stubs: again, humans: { ask_incident: { answer_kind: "abort" } } }))).toBe("preflight ask_incident aborted");
    const withIncident = await runSim("deploy", { input: { ...input, incident: "hotfix" }, stubs: again, humans: { approve: { answer_kind: "deploy" } } });
    expect(pathOf(withIncident)).toBe("preflight tests approve push_plugin post_check record deployed");
    const staging = await runSim("deploy", { input: { ...input, environment: "staging" }, stubs: base() });
    expect(staging.skipped).toEqual(expect.arrayContaining(["approve"]));
  });

  it("another target deploys through an errand with the accounts the owner named, then checks and records", async () => {
    const r = await runSim("deploy", { input: { target: "ssh", environment: "staging", accounts: ["PROD_SSH"], deploy_steps: "rsync dist/ to /var/www" }, stubs: { preflight: ready, tests: { ok: true }, run_deploy: { ok: true, version: "v7", log_path: "l", backup_path: "/b" }, post_check: { ok: true }, record: { staged: 0 } } });
    expect(pathOf(r)).toBe("preflight tests approve run_deploy post_check record deployed_other");
    expect(out(r)).toMatchObject({ status: "deployed", deployed_version: "v7" });
    void finding;
  });
});
