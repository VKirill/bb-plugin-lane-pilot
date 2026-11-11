/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, waitFor, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { createFront } from "../../src/rooms/front/server/index";
import { parseHelper, peerLine } from "../../src/rooms/front/logic";
import { hostActivityToday, createRun, createTask, createAttempt, transitionAttempt, openDatabase } from "../../src/rooms/plugin-db";
import { creatorBrief, readForgeReceipts } from "../../src/rooms/forge";
import { forgeToolParameters } from "../../src/rooms/forge/server";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import { planBellNotice, ackDigest, savePushConfig, loadPushConfig } from "../../src/rooms/owner-waiting/push";
import { postOwnerItem } from "../../src/rooms/owner-waiting/items";
import { discussionLines } from "../../src/rooms/cockpit/ui/screens-work";

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" } as never); return { bb, harness, db: openDatabase(bb) }; };
const front = (db: never, bb: never) => createFront({ db, bb, log: () => undefined, isDisposed: () => false } as never).front;

installTestPluginRuntime();

afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.useRealTimers(); setLocaleOverride(null); });

describe("window parity d6 wave 2", () => {
  it("[sma:m_mc_poll] with two connected hosts, one answering readUsageWindows and one throwing, pollPeers stores the windows of the first, marks the second answered:false and does not throw", async () => {
    const { bb, harness, db } = open();
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", name: "one", status: "connected" }, { id: "h2", name: "two", status: "connected" }]);
    bb.hosts.experimental_client = (() => ({ call: async (method: string, input: { requestedHostId: string }) => { if (input.requestedHostId === "h2") throw new Error("down"); return { windows: [{ used: 1 }] }; } })) as never;
    const rows = await front(db as never, bb as never).pollPeers();
    const h1 = rows.find((row) => row.hostId === "h1")!;
    const h2 = rows.find((row) => row.hostId === "h2")!;
    expect(h1.windows).toEqual({ windows: [{ used: 1 }] });
    expect(h1.answered).toBe(true);
    expect(h2.answered).toBe(false);
  });

  it("[sma:m_mc_snapshot] a new createFront over the same kv starts with no peers, and a host that left BB's list disappears at the next poll", async () => {
    const { bb, harness, db } = open();
    let hosts: Array<{ id: string; name?: string; status: string }> = [{ id: "h1", status: "connected" }, { id: "h2", status: "connected" }];
    harness.sdk.stub("hosts.list", async () => hosts);
    bb.hosts.experimental_client = (() => ({ call: async () => ({ windows: [] }) })) as never;
    const api = front(db as never, bb as never);
    await api.pollPeers();
    hosts = [{ id: "h1", status: "connected" }];
    const rows = await api.pollPeers();
    expect(rows.map((row) => row.hostId)).toEqual(["h1"]);
    const fresh = front(db as never, bb as never);
    await bb.storage.kv.set("lp.front.peers", { stale: { hostId: "stale", online: true, at: 1, lastOnlineAt: 1 } } as never);
    expect(await fresh.peers()).toEqual([]);
  });

  it("[sma:m_sw_machine_row] with a stored snapshot for host B and a BB list that now has only A the next poll keeps only A; with an empty BB list nothing is dropped", async () => {
    const { bb, harness, db } = open();
    let hosts: Array<{ id: string; status: string }> = [{ id: "a", status: "connected" }, { id: "b", status: "connected" }];
    harness.sdk.stub("hosts.list", async () => hosts);
    bb.hosts.experimental_client = (() => ({ call: async () => ({ windows: [] }) })) as never;
    const api = front(db as never, bb as never);
    await api.pollPeers();
    hosts = [{ id: "a", status: "connected" }];
    expect((await api.pollPeers()).map((row) => row.hostId)).toEqual(["a"]);
    hosts = [];
    expect((await api.pollPeers()).map((row) => row.hostId)).toEqual(["a"]);
  });

  it("[sma:m_sw_machines] attempts of two projects on host H1 (accepted and blocked today) and none on H2: peers() returns projects and counts for H1 and an empty today for H2", async () => {
    const { bb, harness, db } = open();
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }, { id: "h2", status: "connected" }]);
    bb.hosts.experimental_client = (() => ({ call: async () => ({ windows: [] }) })) as never;
    createRun(db, "r1", "pa", "bb", "/ws", "none", undefined as never, "h1");
    createRun(db, "r2", "pb", "bb", "/ws", "none", undefined as never, "h1");
    createTask(db, { id: "t1", runId: "r1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "r1", taskId: "t1" });
    transitionAttempt(db, "a1", "accepted");
    createTask(db, { id: "t2", runId: "r2", kind: "bb", contract: {} });
    createAttempt(db, { id: "a2", runId: "r2", taskId: "t2" });
    transitionAttempt(db, "a2", "blocked", { reason: "x" });
    const api = front(db as never, bb as never);
    await api.pollPeers();
    const rows = await api.peers();
    const h1 = rows.find((row) => row.hostId === "h1")!;
    const h2 = rows.find((row) => row.hostId === "h2")!;
    expect(h1.today).toEqual({ projects: ["pa", "pb"], accepted: 1, blocked: 1, running: 0 });
    expect(h2.today).toEqual({ projects: [], accepted: 0, blocked: 0, running: 0 });
    expect(h1.line).toContain("проекты: pa, pb");
    expect(h1.line).toContain("принято 1");
    expect(hostActivityToday(db, "h1", Date.now() - 86_400_000).accepted).toBe(1);
  });

  it("[sma:m_im_scan] a project tree with .claude/skills/x/SKILL.md and .claude/agents/y.md lists both, the skill as kind skill, and importing the skill never overwrites an existing draft", async () => {
    const skill = parseHelper(".claude/skills/pick/SKILL.md", "---\nname: pick\ndescription: Use when picking.\n---\n\nDo the pick.\n");
    const agent = parseHelper(".claude/agents/yard.md", "---\nname: yard\ndescription: A yard agent.\n---\n\nBody.\n");
    expect(skill).toMatchObject({ name: "pick", kind: "skill", format: "claude" });
    expect(agent).toMatchObject({ name: "yard", kind: "agent" });
    const { bb, db } = open();
    const calls: Array<{ edits: Array<{ path: string }> }> = [];
    bb.hosts.experimental_client = (() => ({ call: async (method: string, input: { edits?: Array<{ path: string }> }) => {
      if (method === "listDocsPages") return { pages: [{ path: ".claude/skills/pick/SKILL.md", content: "---\nname: pick\ndescription: Use when picking.\n---\n\nDo.\n" }] };
      calls.push(input as never);
      return { status: calls.length > 1 ? "conflict" : "applied" };
    } })) as never;
    createRun(db, "r1", "p1", "bb", "/ws", "none", undefined as never, "h1");
    const api = front(db as never, bb as never);
    const found = await api.helpers("r1");
    expect(found[0]).toMatchObject({ name: "pick", kind: "skill" });
    const first = await api.importHelpers("r1", ["pick"]);
    const second = await api.importHelpers("r1", ["pick"]);
    expect(calls[0]!.edits[0]!.path).toBe(".agents/forge/skills/pick/SKILL.md");
    expect(first[0]!.status).toBe("applied");
    expect(second[0]!.status).toContain("kept");
  });

  it("[sma:m_sw_create_dialog] creatorBrief with body contains it verbatim and the keep instruction; without body it equals today's text; the schema refuses a body over 20000", () => {
    const body = "## My own skill text\n\ndo exactly this";
    const withBody = creatorBrief("skill", "mine", "a brief that is long enough");
    expect(withBody).not.toContain(body);
    const kept = creatorBrief("skill", "mine", "a brief that is long enough", body);
    expect(kept).toContain(body);
    expect(kept).toContain("word for word");
    expect(kept.startsWith(withBody)).toBe(true);
    expect(forgeToolParameters.safeParse({ action: "draft", kind: "skill", name: "ok-name", brief: "x".repeat(20), body: "y".repeat(20_001) }).success).toBe(false);
    expect(forgeToolParameters.safeParse({ action: "draft", kind: "skill", name: "ok-name", brief: "x".repeat(20), body: "y".repeat(100) }).success).toBe(true);
  });

  it("[sma:m_sw_agents] cockpit_forge_list returns the project's receipts and cockpit_forge_order passes body into the PM's order", async () => {
    const { bb, harness, db } = open();
    await bb.storage.kv.set("lp.forge.receipts", { "p1:skill:one": { kind: "skill", name: "one", path: "p", sha256: "s", ok: true, findings: [], at: 1 }, "p2:skill:other": { kind: "skill", name: "other", path: "p", sha256: "s", ok: false, findings: [{ code: "c", message: "m" }], at: 2 } } as never);
    createRun(db, "r1", "p1", "bb", "/ws");
    const { setRunThread } = await import("../../src/rooms/plugin-db");
    setRunThread(db, "r1", "thr_pm");
    const sent: string[] = [];
    harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
    const rpc = cockpitRpc({ db, bb, log: () => undefined } as never, { front: front(db as never, bb as never) } as never) as Record<string, (i: never) => Promise<unknown>>;
    expect(await readForgeReceipts(bb.storage.kv as never, "p1")).toHaveLength(1);
    const list = await rpc.cockpit_forge_list!({ projectId: "p1" } as never) as Array<{ name: string; ok: boolean }>;
    expect(list).toEqual([{ kind: "skill", name: "one", ok: true, findings: [] }]);
    await rpc.cockpit_forge_order!({ projectId: "p1", kind: "skill", name: "mine", brief: "b".repeat(30), body: "own text" } as never);
    expect(sent[0]).toContain("own text");
  });

  it("[sma:sc_phase_disc] discussionLines puts appetite, no-gos and the feasibility risk under the right labels and «не названо» for the empty ones", () => {
    const lines = discussionLines({ plan: { items: [{ title: "A" }] }, context: { appetite: "a week", noGos: ["no auth", "no payments"], risks: { feasibility: "the wall may fall", value: "v" } } });
    const by = (label: string) => lines.find((line) => line.label === label)!.text;
    expect(by("Аппетит")).toBe("a week");
    expect(by("Не делаем")).toBe("no auth; no payments");
    expect(by("Подводные камни")).toBe("the wall may fall");
    expect(by("Риски")).toBe("v");
    expect(by("Проблема")).toBe("не названо");
  });

  it("[sma:m_sw_batch_hold] at the wave turn the phase card shows the wave number, its acceptance lines and the review summary, and the buttons say «Принять волну» / «Задержать волну»", async () => {
    const rpc = { call: async (name: string) => {
      if (name === "phase_list") return [{ id: "ph1", title: "P", goal: "g", stage: "execution", state: "active" }];
      if (name !== "phase_get") return {};
      return {
        phase: {
          id: "ph1", title: "P", goal: "g", stage: "execution", state: "active",
          record: { ownerWords: true, execution: { issued: {}, waves: {
            "2": { packageSha: "s", lines: [{ id: "t1", ok: true, detail: "saw it" }], review: { state: "passed", by: "opus", summary: "wave is fine", at: 1 }, at: 1 },
          } } },
        },
        next: { text: "word", key: "exec:word:wave:2" }, gates: {}, book: "", facts: {},
      };
    } } as never;
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    setLocaleOverride("ru");
    render(createElement(PhasesScreen, { rpc, projectId: "p1" }));
    await waitFor(() => fireEvent.click(document.querySelector("[data-testid='ck-phase-ph1'] button")!));
    await waitFor(() => expect(document.querySelector("[data-testid='ck-wave-question']")).toBeTruthy());
    const q = document.querySelector("[data-testid='ck-wave-question']")!;
    expect(q.textContent).toContain("Волна 2 готова");
    expect(q.textContent).toContain("✓ t1: saw it");
    expect(q.textContent).toContain("opus: wave is fine");
    expect(document.body.textContent).toContain("Принять волну");
    expect(document.body.textContent).toContain("Задержать волну");
  });

  it("[sma:sc_phase_card] a record with design.drawing, lessons.analysis and observation shows the three sections; without them none", async () => {
    const full = { drawing: { paths: ["ui.md"], sha256: "abcd1234ef", designer: "des", reviewer: "rev", feasible: true }, lessons: { analysis: "went well" }, observation: { outcome: "failure", reverted: ["abc"], until: 1_800_000_000_000 } };
    const rpc = { call: async (name: string) => {
      if (name === "phase_list") return [{ id: "ph1", title: "P", goal: "g", stage: "closed", state: "closed" }];
      if (name !== "phase_get") return {};
      return {
        phase: { id: "ph1", title: "P", goal: "g", stage: "closed", state: "closed", record: { design: { drawing: full.drawing, archived: [{}] }, lessons: full.lessons, observation: full.observation } },
        next: { text: "done" }, gates: {}, book: "", facts: {},
      };
    } } as never;
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    render(createElement(PhasesScreen, { rpc, projectId: "p1" }));
    await waitFor(() => fireEvent.click(document.querySelector("[data-testid='ck-phase-ph1'] button")!));
    await waitFor(() => expect(document.querySelector("[data-testid='ck-drawing']")).toBeTruthy());
    expect(document.querySelector("[data-testid='ck-drawing']")!.textContent).toContain("ui.md");
    expect(document.querySelector("[data-testid='ck-drawing']")!.textContent).toContain("abcd1234");
    expect(document.querySelector("[data-testid='ck-lessons']")!.textContent).toContain("went well");
    expect(document.querySelector("[data-testid='ck-observation']")!.textContent).toContain("abc");
    cleanup();
    const none = { call: async (name: string) => name === "phase_list" ? [{ id: "ph2", title: "Q", goal: "g", stage: "closed", state: "closed" }] : name === "phase_get" ? ({ phase: { id: "ph2", title: "Q", goal: "g", stage: "closed", state: "closed", record: {} }, next: { text: "done" }, gates: {}, book: "", facts: {} }) : ({}) } as never;
    render(createElement(PhasesScreen, { rpc: none, projectId: "p1" }));
    await waitFor(() => fireEvent.click(document.querySelector("[data-testid='ck-phase-ph2'] button")!));
    await waitFor(() => expect(document.querySelector("[data-testid='ck-phase-card']")).toBeTruthy());
    expect(document.querySelector("[data-testid='ck-drawing']")).toBeNull();
    expect(document.querySelector("[data-testid='ck-observation']")).toBeNull();
  });

  const item = (key: string) => ({ key, source: "inbox", kind: "decision", what: "w", why: "y", actions: [{ id: "a", label: "a", cli: "bb lane-pilot waiting" }] }) as never;

  it("[sma:m_ws_notify] planBellNotice, bell unset (on): two new wake items return one notice with count 2 and no item text; after ackDigest a second call returns nothing; quiet hours or disabled return nothing", () => {
    const { db } = open();
    savePushConfig(db, { quiet: "00:00-00:00" });
    const sweep: never[] = [];
    // Nothing stored: the bell is on. The first tick only learns the empty install; items that arrive later are announced.
    expect(loadPushConfig(db).bell).toBe(true);
    expect(planBellNotice(db, Date.now(), sweep).reason).toBe("nothing_new");
    postOwnerItem(db, item("k1"));
    postOwnerItem(db, item("k2"));
    const one = planBellNotice(db, Date.now(), sweep);
    expect(one.send).toBe(true);
    expect(one.title).toContain("2");
    expect(one.text).not.toContain("k1");
    ackDigest(db, one.keys);
    expect(planBellNotice(db, Date.now(), sweep).send).toBe(false);
    // A mark older than a month is removed, so the table does not grow without end.
    db.prepare("UPDATE lane_pilot_owner_push SET pushed_at=? WHERE key LIKE 'bell:%'").run(Date.now() - 31 * 86_400_000);
    planBellNotice(db, Date.now(), sweep);
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_owner_push WHERE pushed_at < ?").get(Date.now() - 30 * 86_400_000) as { n: number }).n).toBe(0);
    ackDigest(db, one.keys);
    savePushConfig(db, { quiet: "00:00-23:59", timezone: "UTC" });
    expect(planBellNotice(db, Date.now(), sweep).reason).toBe("quiet_hours");
    savePushConfig(db, { enabled: "off" });
    expect(planBellNotice(db, Date.now(), sweep).reason).toBe("disabled");
  });

  it("[sma:m_ws_notify] a stored bell=off keeps the bell silent and writes nothing; switching it back on works", () => {
    const { db } = open();
    savePushConfig(db, { quiet: "00:00-00:00", bell: "off" });
    expect(loadPushConfig(db).bell).toBe(false);
    postOwnerItem(db, item("k1"));
    expect(planBellNotice(db, Date.now(), []).reason).toBe("disabled");
    expect(planBellNotice(db, Date.now(), []).send).toBe(false);
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_owner_push").get() as { n: number }).n).toBe(0);
    // On again: the first tick marks what is there without a notice, the next new item is announced.
    savePushConfig(db, { bell: "on" });
    expect(planBellNotice(db, Date.now(), []).send).toBe(false);
    postOwnerItem(db, item("k2"));
    expect(planBellNotice(db, Date.now(), []).send).toBe(true);
  });

  it("[sma:m_ws_notify] no burst on the first tick after an upgrade: items that already exist are marked announced without a notice", () => {
    const { db } = open();
    savePushConfig(db, { quiet: "00:00-00:00" });
    for (const key of ["a1", "a2", "a3"]) postOwnerItem(db, item(key));
    const first = planBellNotice(db, Date.now(), []);
    expect(first.send).toBe(false);
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_owner_push WHERE key LIKE 'bell:%'").get() as { n: number }).n).toBe(3);
    expect(planBellNotice(db, Date.now(), []).send).toBe(false);
    postOwnerItem(db, item("a4"));
    const next = planBellNotice(db, Date.now(), []);
    expect(next.send).toBe(true);
    expect(next.keys).toEqual(["bell:a4"]);
  });

  it("[sma:m_ws_notify] no double push: an item the Telegram digest announced (a non-bell row for its key) is skipped by the bell", () => {
    const { db } = open();
    savePushConfig(db, { quiet: "00:00-00:00" });
    planBellNotice(db, Date.now(), []);
    postOwnerItem(db, item("d1"));
    postOwnerItem(db, item("d2"));
    ackDigest(db, ["d1"]);
    const notice = planBellNotice(db, Date.now(), []);
    expect(notice.send).toBe(true);
    expect(notice.keys).toEqual(["bell:d2"]);
    ackDigest(db, notice.keys);
    ackDigest(db, ["d2"]);
    expect(planBellNotice(db, Date.now(), []).send).toBe(false);
  });

  it("[sma:d_search] the memory screen calls session_memory_search with the project and query, lists the record kind, text and concepts, and shows the nothing note on nothingRelevant", async () => {
    let asked: unknown = null;
    const rpc = { call: async (name: string, input: unknown) => {
      if (name !== "session_memory_search") return {};
      asked = input;
      return { records: [{ id: "m1", kind: "fact", content: "the db is postgres", concepts: ["db"] }] };
    } } as never;
    const { MemoryScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    setLocaleOverride("ru");
    render(createElement(MemoryScreen, { rpc, runId: null, projectId: "p1" }));
    fireEvent.change(document.querySelector("[data-testid='ck-memory'] input")!, { target: { value: "postgres" } });
    fireEvent.click(Array.from(document.querySelectorAll("[data-testid='ck-memory'] button")).find((b) => b.textContent === "Найти")!);
    await waitFor(() => expect(document.querySelector("[data-testid='ck-memory-found']")).toBeTruthy());
    expect(asked).toEqual({ projectId: "p1", query: "postgres", limit: 8 });
    expect(document.querySelector("[data-testid='ck-memory-found']")!.textContent).toContain("the db is postgres");
    expect(document.querySelector("[data-testid='ck-memory-found']")!.textContent).toContain("db");
    cleanup();
    const empty = { call: async () => ({ records: [], nothingRelevant: true, message: "Ничего подходящего в памяти." }) } as never;
    render(createElement(MemoryScreen, { rpc: empty, runId: null, projectId: "p1" }));
    fireEvent.change(document.querySelector("[data-testid='ck-memory'] input")!, { target: { value: "x" } });
    fireEvent.click(Array.from(document.querySelectorAll("[data-testid='ck-memory'] button")).find((b) => b.textContent === "Найти")!);
    await waitFor(() => expect(document.querySelector("[data-testid='ck-memory-nothing']")!.textContent).toContain("Ничего подходящего в памяти"));
  });

  it("[sma:m_sw_skills] the team block lists each skill with its store, and the empty list names the two places it looked", async () => {
    const { SkillsBlock } = await import("../../src/rooms/pages/tab-team");
    setLocaleOverride("ru");
    const view = { catalog: { skills: [{ name: "pick", description: "Use when picking.", store: "навыки проекта «p1»" }, { name: "gen", description: "General.", store: "общие BB" }], skillsLooked: ["общие навыки BB", "навыки проекта «p1»"] } };
    render(createElement(SkillsBlock, { access: { view } as never }));
    expect(document.querySelector("[data-testid='team-skill-pick']")!.textContent).toContain("навыки проекта «p1»");
    expect(document.querySelector("[data-testid='team-skill-gen']")!.textContent).toContain("общие BB");
    cleanup();
    render(createElement(SkillsBlock, { access: { view: { catalog: { skills: [], skillsLooked: ["общие навыки BB", "навыки проекта «p1»"] } } } as never }));
    expect(document.querySelector("[data-testid='team-skills-empty']")!.textContent).toContain("общие навыки BB");
    expect(document.querySelector("[data-testid='team-skills-empty']")!.textContent).toContain("навыки проекта «p1»");
  });

  it("[sma:m_sw_machines] peerLine renders the Russian line with projects and today's counts", () => {
    const line = peerLine({ hostId: "h", name: "mini", online: true, at: 1, lastOnlineAt: 1, today: { projects: ["a", "b"], accepted: 3, blocked: 1, running: 0 } });
    expect(line).toBe("mini: на связи · проекты: a, b · сегодня: принято 3, стоит 1, идёт 0");
  });
});
