import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { archiveDrawing, conclusionText, coverageGaps, designMode, markRoadmap, motionRows, nextRoadmapRow, stateText, threatGap, uatState, uatText, uiContractGap, validationGaps } from "../src/rooms/phase/stages";
import type { PhaseRecord, PlanItem } from "../src/rooms/phase";
import { landingWordGap, ownerWordFindings } from "../src/rooms/tasks";
import { critiqueProblems, readinessWords, roleLine, trainedConditions, trainingRatios, type DesignJournalLine } from "../src/rooms/design-eval";
import { answerFirstRun, firstRunNeeded, firstRunSettings, helperDraft, MUTATING_RPC, parseHelper, peerLine } from "../src/rooms/front";
import { FORBIDDEN_GRANTS, draftFile, enabledPath, lintDraft } from "../src/rooms/forge";
import { capOf, moneyHold, spendBook, windowHold } from "../src/rooms/money";
import { approvalSuggestions, excavate, htmlReport } from "../src/rooms/self-improve";
import { taskEventBody } from "../src/rooms/outbound";
import { screenFor, unusedReads } from "../src/rooms/cockpit/ui/registry";
import { manifest, preship, receiptChain, verifyChain } from "../src/rooms/receipts";
import { createRun, openDatabase } from "../src/rooms/storage/database";

const item = (id: string, extra: Partial<PlanItem> = {}, task: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], ...task }, ...extra,
});

describe("phase stages", () => {
  it("coverage, threat model and validation gaps hold the plan", () => {
    const record: PhaseRecord = { context: { docs: [], sha: "s", signedAt: 1, requirements: ["R1", "R2"], decisions: ["D1"], risks: { security: "tokens in logs" } }, plan: { items: [item("a", { covers: ["R1"] })], sha: "x", contextSha: "s" } };
    expect(coverageGaps(record).join(" ")).toMatch(/R2.*D1/s);
    expect(threatGap(record)).toContain("SECURITY.md");
    expect(threatGap({ ...record, context: { ...record.context!, risks: { security: "none" } } })).toBeNull();
    expect(validationGaps([item("a", {}, { verification: [{ command: "test -f src/a.ts" }] }), item("b")])).toEqual([expect.stringContaining("a:")]);
  });

  it("design mode, motion rows, the UI contract and the archived drawing", () => {
    expect(designMode([item("a", {}, { owns_paths: ["src/pages/Home.tsx"] })])).toBe("screens");
    expect(designMode([item("a", {}, { owns_paths: ["src/theme/tokens.ts", "src/pages/Home.tsx"] })])).toBe("mixed");
    expect(motionRows([item("a", { title: "page transition" }), item("b")])).toEqual(["a"]);
    const drawn: PhaseRecord = { design: { decision: "needed", why: "", drawing: { paths: ["d.png"], sha256: "1", designer: "d" } } };
    expect(uiContractGap(drawn)).toContain("UI-SPEC.md");
    expect(archiveDrawing(drawn, { paths: ["e.png"], sha256: "2", designer: "d" })).toHaveLength(1);
  });

  it("UAT lines, the conclusion, the roadmap row and STATE", () => {
    const phase = { id: "ph_1", title: "Sum", goal: "sums", record: { plan: { items: [item("a")], sha: "x", contextSha: "s" } } as PhaseRecord };
    const text = uatText(phase);
    expect(uatState(text)).toMatchObject({ lines: 1, open: [expect.stringContaining("a:")] });
    expect(uatState(text.replace("- [ ]", "- [x]"))).toMatchObject({ lines: 1, passed: 1, open: [] });
    expect(conclusionText(phase, [], new Map())).toContain("## What was built");
    const roadmap = "# Roadmap\n\n## Phases\n\n- [ ] 1 Login — sign in\n- [ ] 2 Billing\n";
    expect(markRoadmap(roadmap, "1")).toContain("- [x] 1 Login");
    expect(nextRoadmapRow(markRoadmap(roadmap, "1"))).toEqual({ n: "2", name: "Billing", goal: "" });
    const state = stateText("---\nphase: \"1\"\n---\n\n# State\n", { phase: "2", stage: "closed" });
    expect(state).toContain('phase: "2"');
    expect(state).toContain("# State");
  });
});

describe("the owner's word on tasks", () => {
  it("off nothing waits; on a landing waits for a yes, a no blocks", () => {
    expect(landingWordGap(false, undefined)).toBeNull();
    expect(landingWordGap(true, undefined)).toContain("owner_word");
    expect(landingWordGap(true, [{ turn: "land", decision: "yes", text: "да", at: 1 }])).toBeNull();
    expect(landingWordGap(true, [{ turn: "land", decision: "no", text: "not now", at: 1 }])).toContain("said no");
  });
  it("with owner.words on a clarification needs the owner's answer", () => {
    const task = { clarify: { questions: [], answers: [{ question: "colour?", by: "pm" }] } } as never;
    expect(ownerWordFindings(task, false)).toEqual([]);
    expect(ownerWordFindings(task, true)[0]?.code).toBe("clarify_needs_owner");
  });
});

describe("design training", () => {
  const line = (over: Partial<DesignJournalLine>): DesignJournalLine => ({ at: 1, projectId: "p", phaseId: "ph", designer: "d", reviewer: "r", drawingSha: "s", firstPass: true, critique: { scores: {}, verdict: "pass", notes: "" }, codeScore: 80, ownerWord: "yes", ...over });
  it("the critique form, the ratios, the conditions and the readiness words", () => {
    expect(critiqueProblems({ scores: { hierarchy: 2 }, verdict: "rework", notes: "" })).toHaveLength(2);
    expect(critiqueProblems({ scores: { hierarchy: 2, spacing: 3, contrast: 2, states: 1 }, verdict: "pass", notes: "" })).toEqual([]);
    const lines = Array.from({ length: 8 }, () => line({}));
    expect(trainingRatios(lines)).toMatchObject({ drawings: 8, firstPass: 1, critiquePass: 1, codeScore: 80, ownerYes: 1 });
    expect(trainedConditions(lines).every((row) => row.ok)).toBe(true);
    expect(readinessWords(lines)).toContain("обучен");
    expect(readinessWords([...lines, line({ ownerWord: "no" })])).toContain("учится");
    expect(roleLine("  keep   the grid  ", new Date("2026-10-24T00:00:00Z"))).toBe("2026-10-24 keep the grid");
  });
});

describe("the front", () => {
  it("first run: needed, a secret is refused, the settings it writes", () => {
    expect(firstRunNeeded({}, null)).toBe(true);
    expect(firstRunNeeded({ "writer.provider": "codex" }, null)).toBe(false);
    const draft = { projectId: "p", answers: {}, at: 0 };
    expect(() => answerFirstRun(draft, "goal", "sk-abcdefghijklmnopqrstuvwxyz123456")).toThrow(/key or a password/);
    const done = ["writer:codex / gpt-6-luna", "quality:full", "words:да"].reduce((acc, row) => answerFirstRun(acc, row.split(":")[0] as never, row.split(":")[1]!), draft);
    expect(firstRunSettings(done)).toEqual({ "writer.provider": "codex", "writer.model": "gpt-6-luna", quality_mode: "full", "owner.words": "on" });
  });
  it("own helpers: Claude Code and Codex formats, a forge draft, peers, the journal's verbs", () => {
    const claude = parseHelper(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews the diff. Use when a PR is ready.\n---\nRead the diff.");
    expect(claude).toMatchObject({ name: "reviewer", format: "claude", body: "Read the diff." });
    expect(parseHelper(".codex/agents/x.toml", 'name = "fixer"\ndescription = "Fixes it"\n')).toMatchObject({ name: "fixer", format: "codex" });
    expect(parseHelper("README.md", "x")).toBeNull();
    expect(helperDraft(claude!)).toContain("name: reviewer");
    expect(peerLine({ hostId: "h", name: "mini", online: false, at: 2, lastOnlineAt: 2 - 5 * 60_000 }, 2)).toContain("5 min");
    expect(MUTATING_RPC.test("save_setting")).toBe(true);
    expect(MUTATING_RPC.test("get_screen")).toBe(false);
  });
});

describe("the forge", () => {
  it("lints a draft: shape, trigger, forbidden grants", () => {
    const good = "---\nname: lazy-images\ndescription: Lazy-load product photos so switching stays fast. Use when photos load slowly.\n---\nsteps\n";
    expect(lintDraft("skill", "lazy-images", good)).toEqual([]);
    expect(lintDraft("skill", "lazy-images", good.replace("steps", "run with --dangerously-skip-permissions")).map((row) => row.code)).toContain("forbidden_grant");
    expect(lintDraft("skill", "lazy-images", "---\nname: x\ndescription: short\n---\n").map((row) => row.code)).toEqual(expect.arrayContaining(["name", "description", "trigger"]));
    expect(lintDraft("workflow", "w", '{"id":"w","nodes":[1],"entry":"a","description":"d"}')).toEqual([]);
    expect(FORBIDDEN_GRANTS.length).toBeGreaterThanOrEqual(5);
    expect(draftFile("role", "fixer")).toBe(".agents/forge/roles/fixer/fixer.md");
    expect(enabledPath("skill", "x")).toBe(".claude/skills/x/SKILL.md");
  });
});

describe("money", () => {
  it("the cap of paid lanes, the subscription window, the spend book", () => {
    expect(capOf("50")).toBe(50);
    expect(capOf("")).toBeNull();
    expect(moneyHold("openlux", 60, 50)).toBeTruthy();
    expect(moneyHold("claude-code", 60, 50)).toBeNull();
    expect(windowHold({ five_hour: { utilization: 99, resetsAt: null } }, "claude-sonnet-5-5", 0)).toContain("five-hour");
    expect(windowHold({ five_hour: { utilization: 40, resetsAt: null } }, "claude-sonnet-5-5", 0)).toBeNull();
    expect(spendBook([], Date.UTC(2026, 9, 24)).series).toHaveLength(14);
  });
});

describe("self-improvement and the outbound voice", () => {
  it("excavates fixes, suggests approvals, escapes the report, keeps nine event fields", () => {
    expect(excavate("\u0001abc123\u0002fix: crash on save\nsrc/a.ts\n\n\u0001def456\u0002docs: readme\nREADME.md\n")).toEqual([{ commit: "abc123", subject: "fix: crash on save", files: ["src/a.ts"] }]);
    expect(approvalSuggestions(Array.from({ length: 3 }, () => ({ descriptor: { kind: "merge" }, expected: "yes" })))).toHaveLength(1);
    expect(htmlReport({ title: "<x>", sections: [] })).not.toContain("<x>");
    expect(Object.keys(taskEventBody({ event: "e", projectId: "p", extra: "dropped" }))).toHaveLength(9);
  });
});

describe("the cockpit's screen registry", () => {
  it("a path, an event, the placeholder; reads nobody calls", () => {
    expect(screenFor("")).toEqual({ id: "home", param: null });
    expect(screenFor("phases/ph_1")).toEqual({ id: "phases", param: "ph_1" });
    expect(screenFor("event/uat").id).toBe("phases");
    expect(screenFor("nope").id).toBe("building");
    expect(unusedReads(["get_screen", "list_runs", "save_setting"], ["get_screen"])).toEqual(["list_runs"]);
  });
});

describe("receipts", () => {
  it("the chain of a task's receipts, its verification, the manifest and preship", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run_r", "proj", "bb", "/s");
    const empty = receiptChain(db, "run_r", "t1");
    expect(empty.links).toEqual([]);
    expect(verifyChain(db, "run_r", "t1", empty.tip)).toBe(true);
    expect(manifest(db).tables).toBeGreaterThan(10);
    expect(preship(db, "proj")).toMatchObject({ clear: true, items: [] });
  });
});

describe("the cockpit's reads on the real schema", () => {
  it("today, workers and a task answer from an empty project without an error", async () => {
    const { cockpitRpc } = await import("../src/rooms/cockpit");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run_c", "proj_c", "bb", "/s");
    const rpc = cockpitRpc({ db, bb, log: () => undefined } as never, { front: { actions: async () => [] } } as never);
    expect(await rpc.cockpit_today({ projectId: "proj_c" })).toMatchObject({ kpi: { accepted: 0, blocked: 0, running: 0, tokens: 0, actions: 0 }, feed: [] });
    expect(await rpc.cockpit_workers({ projectId: "proj_c" })).toEqual([]);
    expect(await rpc.cockpit_task({ runId: "run_c", taskId: "none" })).toBeNull();
    expect(await rpc.cockpit_queue({ runId: "run_c", taskIds: ["none"], action: "hold" })).toEqual({ changed: ["none"] });
    expect((await rpc.cockpit_designer({})).readiness).toContain("учится");
    expect(await rpc.cockpit_seen({ screen: "today", ms: 1000 })).toEqual({ ok: true });
    expect((await rpc.cockpit_seen_list()).seen).toHaveProperty("today");
  });
});

describe("permits: the ticket channel on a machine", () => {
  it("lists an unanswered ticket, writes the PM's answer once, then the ticket is no longer listed", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { listPermitTickets, answerPermit } = await import("../src/rooms/host-worker/host-handlers");
    const home = mkdtempSync(join(tmpdir(), "lp-permits-"));
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, ".agents", "permits", "sess1"), { recursive: true });
      writeFileSync(join(home, ".agents", "permits", "sess1", "a1b2c3d4e5f60718.ticket.json"), JSON.stringify({ category: "delete", command: "rm -rf build", cwd: "/w", at: 1 }));
      const listed = await listPermitTickets({ requestedHostId: "h" } as never, {} as never);
      expect(listed.tickets).toEqual([expect.objectContaining({ session: "sess1", ticket: "a1b2c3d4e5f60718", category: "delete" })]);
      expect((await answerPermit({ requestedHostId: "h", session: "sess1", ticket: "a1b2c3d4e5f60718", decision: "allow", why: "build output" } as never, {} as never)).written).toBe(true);
      expect(JSON.parse(readFileSync(join(home, ".agents", "permits", "sess1", "a1b2c3d4e5f60718.answer.json"), "utf8")).decision).toBe("allow");
      expect((await listPermitTickets({ requestedHostId: "h" } as never, {} as never)).tickets).toEqual([]);
      expect((await answerPermit({ requestedHostId: "h", session: "sess1", ticket: "ffffffffffffffff", decision: "deny", why: "x" } as never, {} as never)).written).toBe(false);
    } finally { process.env.HOME = before; }
  });
});

describe("permits: the PM's tool", () => {
  it("mounts the sweep and registers lane_pilot_permit", async () => {
    const { mountPermits } = await import("../src/rooms/permits");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const names: string[] = [];
    const agents = { ...bb.agents, registerTool: (tool: { name: string }) => { names.push(tool.name); return (bb.agents as unknown as { registerTool: (t: unknown) => unknown }).registerTool(tool); } };
    mountPermits({ db, bb: { ...bb, agents }, isDisposed: () => true, log: () => undefined } as never);
    expect(names).toContain("lane_pilot_permit");
  });
});
