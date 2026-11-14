// Region 6 · Conversation and intake, batch b: the four proofs per node. Each test runs the real code of the node on the scratch worlds of
// tests/sma/r06-world-b.ts (the scene probe reads the same worlds) and checks the result the card names, not that a function was called.
import { describe, expect, it } from "vitest";
import {
  observeActivation, observeAskKinds, observeBacklogRules, observeBoardBlock, observeBoardScope, observeBook, observeBoundary, observeCadence, observeClarify, observeClose,
  observeHandOver, observeParkedQa, observeParse, observePlan, observePlanningHome, observeRead, observeScan, observeSecret, observeSpendBooked, observeSpendModel,
  observeTurnWatch, observeValidate, observeWords,
} from "./r06-world-b";

describe("region 6 b: the backlog", () => {
  it("[sma:m_in_scan] the board fetches before it reads, and tells the data's age and how far behind it is", async () => {
    const seen = await observeScan();
    expect(seen).toMatchObject({ fetchFirst: true, fetched: true, behind: 3, issuable: ["x1"], readAtFresh: true });
    // A fetch that fails is told as such (fetched false, no «behind»), and the board is still read.
    expect(seen).toMatchObject({ failedFetched: false, failedBehind: null, failedStillRead: ["x1"] });
  });

  it("[sma:m_in_parse] only the lines under the backlog marker are read, and the parser never throws", () => {
    const seen = observeParse();
    expect(seen).toMatchObject({ junk: [], thrown: false, noId: 0, afterNoise: ["a"], two: ["a:ready", "b:open"] });
    expect(seen.command).toContain(".agents/todos/items/*/meta.yaml");
  });

  it("[sma:m_in_verdict] [sma:m_in_no_sp] [sma:m_in_too_big] [sma:m_in_deps] [sma:m_in_to_task] a ready line is issuable at 13 with closed dependencies, shown with its reason otherwise", () => {
    const seen = observeBacklogRules();
    // 13 is the last issuable size, 14 waits for decomposition, no estimate waits for one, an open dependency blocks, a done one does not.
    expect(seen.issuable).toEqual(["1", "5"]);
    expect(seen.needsEstimate).toEqual(["2"]);
    expect(seen.decompose).toEqual(["3"]);
    expect(seen.blocked).toEqual(["4"]);
    // Title, estimate and priority come from the line itself.
    expect(seen.message.split("\n")[0]).toBe("Lane Pilot: из беклога проекта готова к работе задача «Item 1» (1, оценка 13, приоритет high).");
    expect(seen.message.split("\n")[1]).toContain(".agents/todos/items/1/AGENT.md");
  });

  it("[sma:m_in_priority] the urgency band is the first queue key, the size the second", () => {
    // high 2, high 8, medium 5, low 1: the band decides, then the smaller job.
    expect(observeBacklogRules().order).toEqual(["3", "2", "4", "1"]);
  });

  it("[sma:m_sg_breakdown] a phrase that repeats an open backlog line is matched, a done line and a stranger are not", () => {
    const seen = observeBacklogRules();
    expect(seen.matches).toEqual(["csv-export"]);
    expect(seen.noMatch).toEqual([]);
  });

  it("[sma:m_in_cadence] a project scans only once its own interval has passed since the last scan, and the scan writes that time", async () => {
    expect(await observeCadence()).toEqual({ youngScanned: false, keptStamp: true, oldScanned: true, newStamp: true, hourScanned: true, underHourScanned: false });
  });

  it("[sma:m_in_planning_home] the todo items are read where the project's planning lives, the checkout when none is set; the issued message names that home", async () => {
    const seen = await observePlanningHome();
    expect(seen.plain).toEqual({ ids: ["in-checkout"], readFrom: "checkout" });
    expect(seen.set).toEqual({ ids: ["in-home"], readFrom: "home" });
    expect(seen.message.split("\n")[1]).toContain("/home/owner/plans/.agents/todos/items/1/AGENT.md");
    expect(seen.plainMessage.split("\n")[1]).toMatch(/^Описание и подход: \.agents\/todos\/items\/1\/AGENT\.md/);
  });

  it("[sma:m_in_close_line] one status line becomes done and the other lines stay; only an accepted task of the run closes its own line", async () => {
    const seen = await observeClose();
    expect(seen).toMatchObject({ first: "closed", after: "id: t-door\nstatus: done\nestimate: 2\n", again: "already", two: "refused", twoText: "status: open\nstatus: blocked\n", missing: "refused" });
    expect(seen).toMatchObject({ queued: "not_accepted", other: "not_issued", closedBefore: 0, own: "closed", closedAfter: 1 });
  });
});

describe("region 6 b: the conversation engine", () => {
  it("[sma:m_ce_claim_proposal] the owner's «да» goes down the intake road once: a repeat of the same key starts nothing new, another key starts its own", async () => {
    const seen = await observeHandOver();
    expect(seen.starts.map((row) => row.requestId)).toEqual(["lead:road1", "lead:road2"]);
    expect(seen.one).toEqual({ started: true, via: "issue-quick", id: "wf_1" });
    expect(seen.two).toEqual(seen.one);
    expect(seen.three).toEqual(seen.one);
  });

  it("[sma:m_ce_boundary] the line under the input follows the project's owner.words and is shown in PM chats only", () => {
    expect(observeBoundary()).toEqual({ pmOn: "composerBoundary", pmRisky: "composerBoundaryRisky", pmSensitive: "composerBoundarySensitive", pmUnset: "composerBoundarySensitive", pmOff: null,
      writer: null, helper: null, none: null });
  });

  it("[sma:m_ce_validate] a task contract is shape-checked before any task row exists: the missing field is refused, an output outside owns_paths is a named finding", () => {
    const seen = observeValidate();
    expect(seen).toMatchObject({ missingRefused: true, goodOk: true });
    expect(seen.missingErrors).toHaveLength(1);
    expect(seen.outsideCodes).toContain("output_unowned");
    expect(seen.insideCodes).not.toContain("output_unowned");
    expect(seen.neverCodes).toContain("output_never_touch");
    expect(seen.neverCodes).not.toContain("output_unowned");
  });

  it("[sma:m_cf_dispatch] a PM turn's spend is booked under the PM thread's own id and takes no seat: one cursor row, the day's book, no attempt, no receipt", async () => {
    const seen = await observeSpendBooked();
    expect(seen).toEqual({ cursors: ["thr_pm"], cursorTotal: 14, daily: [{ project_id: "projA", total_tokens: 14 }], attempts: 0, receipts: 0 });
  });

  it("[sma:m_cf_voice] [sma:m_cf_ensure] [sma:m_cf_seed] the PM is spawned on the configured PM provider with explicit inputs, with its compiled profile laid in before launch; a writer thread cannot activate one", async () => {
    const seen = await observeActivation();
    // voice: the PM provider and model, never the writer's.
    expect(seen).toMatchObject({ threadId: "pm-main", spawnProvider: "pm-prov", spawnModel: "pm-model", pmRow: { pm_thread_id: "pm-main", kind: "bb" } });
    expect(seen.sources).toMatchObject({ providerId: "explicit", model: "explicit" });
    expect(seen.metadata).toMatchObject({ role: "pm" });
    // ensure: an ordinary chat enables a PM, a writer thread is refused and spawns nothing.
    expect(seen.userOk).toBe(true);
    expect(seen.writerError).toBe("Lane Pilot writer threads cannot activate a PM");
    expect(seen.writerSpawns).toBe(0);
    // seed: with the capability the profile and its tools ride the spawn; without it a profile that needs it stops before a run row exists.
    expect(seen).toMatchObject({ boundTools: true, boundPersist: "dev-orchestrator", plainHasBinding: false, missingError: true, missingSpawns: 0, runsBefore: 0, runsAfter: 0 });
  });

  it("[sma:m_cf_settings] [sma:m_cf_timeout] the turn watch cuts a PM turn at the owner's limits read at turn start, names the outcome in words, and ignores a writer thread", async () => {
    const seen = await observeTurnWatch();
    // settings: pm.max_turns 3 read at turn/started: three tool items pass, the fourth cuts and names the cap.
    expect(seen.stoppedAtThree).toEqual([]);
    expect(seen.cutAtFour).toEqual({ stopped: ["thr_pm"], outcome: "предел ходов: 3" });
    // A change to 5 mid-turn is not this turn's cap (cut at its 4th item); the next turn takes 5: five pass, the sixth cuts.
    expect(seen.sameTurn).toEqual(["thr_pm"]);
    expect(seen.nextAtFive).toEqual([]);
    expect(seen.nextAtSix).toEqual({ stopped: ["thr_pm"], outcome: "предел ходов: 5" });
    expect(seen.writerOpen).toBe(true);
    // timeout: 4 minutes — nothing at 3, a cut at 5 with the stop sent, and the outcomes of an empty answer and a vendor refusal in words; a spoken answer names nothing.
    expect(seen.at3).toEqual([]);
    expect(seen.at5).toEqual(["thr_pm"]);
    expect(seen.timedStops).toEqual(["timed:thr_pm"]);
    expect(seen.named).toEqual(["ход не уложился в 4 минут", "пустой ответ", "отказ вендора: quota exceeded", "отказ вендора: model overloaded"]);
    expect(seen.spoke).toBe(true);
  });

  it("[sma:m_cf_prompt] a resumed PM session gets its run's board: every task with its state, the live phase with its stage's rubric; nothing for an unknown run", async () => {
    const seen = await observeBoardBlock();
    expect(seen.block).toMatch(/^Board now:\nTasks: /);
    expect(seen.tasks).toEqual(["t1 accepted", "t2 ?"]);
    expect(seen.none).toBeNull();
    expect(seen.withPhase.stage).toBe("discussion");
    expect(seen.withPhase.block).toBe(`Board now:\nPhase ${seen.withPhase.id} — discussion. ${seen.withPhase.rubric}`);
  });

  it("[sma:m_cf_tools] the PM reads project files only through the granted reader: a path outside the workspace is refused before any host read, the root is the run's own", async () => {
    const seen = await observeRead();
    expect(Object.values(seen.errors)).toEqual(Array(4).fill("lane_pilot_read_path_escaped_workspace"));
    expect(seen.callsAfterRefusals).toBe(0);
    expect(seen.ok).toBe("read");
    expect(seen.firstCall).toEqual({ requestedHostId: "host_read", projectCwd: "/work/proj", relativePath: "src/door.ts", offset: 0, maxLines: 40 });
    expect(seen.writer).toBe("caller is not a Lane Pilot PM thread");
    expect(seen.otherProject).toBe("run does not belong to this PM thread and project");
    expect(seen.callsTotal).toBe(1);
  });

  it("[sma:m_cf_observe] the board observation reads only the caller's own run", async () => {
    const seen = await observeBoardScope();
    expect(seen).toEqual({ aRun: "runA", aTasks: ["ta"], bRun: "runB", bTasks: ["tb"], noneTasks: [], kind: "board" });
  });

  it("[sma:m_cf_book_usage] spend is booked under the model the turn really ran on, and the mismatch with the chosen model is named to the reader", async () => {
    const seen = await observeSpendModel();
    expect(seen.fallback).toEqual({ models: ["sonnet:14"], day: ["sonnet"], mismatches: ["opus->sonnet:14"] });
    // Without a fallback there is nothing to name.
    expect(seen.plain.mismatches).toEqual([]);
  });
});

describe("region 6 b: the questions", () => {
  it("[sma:m_q_engine] a question to the owner and its answer land in the phase folder's BOOK.md, written to the project", async () => {
    const seen = await observeBook();
    expect(seen.path).toBe(`.agents/phases/${seen.id}/BOOK.md`);
    expect(seen.afterQuestion).toContain("**question** — q1: which locale?");
    expect(seen.afterQuestion).not.toContain("**answer**");
    expect(seen.book).toContain("**question** — q1: which locale?");
    expect(seen.book).toContain("**answer** — q1: ru");
    expect(seen.answered).toEqual(["q1:ru:owner"]);
  });

  it("[sma:m_q_exec_ckpt] a writer parked mid-execution leaves an open entry in its attempt's QA.md, the answer lands under it; a task on the old layout keeps its own QA.md", async () => {
    const seen = await observeParkedQa();
    expect(seen.home1).toBe(true);
    expect(seen.open).toMatch(/^# Q&A — t-qa\n\n## \S+\nQ \(writer\): which locale\?\nA: open — the writer is parked here\n\n$/);
    expect(seen.answered).toContain("A: open — the writer is parked here");
    expect(seen.answered).toMatch(/Q \(writer\): which locale\?\nA \(PM\): ru\n\n$/);
    expect(seen.oldPaths).toEqual(["/.agents/plans/items/t-old/QA.md", "/.agents/plans/items/t-old2/QA.md"]);
    expect(seen.oldText).toContain("Q (writer): which port?\nA: open — the writer is parked here");
  });

  it("[sma:m_q_kinds] [sma:m_q_free_text] a stop to the owner carries one of five kinds, and the kind decides free text: a budget or pause stop is a pick, the rest take words", () => {
    const seen = observeAskKinds();
    expect(seen.kinds).toEqual(["checkpoint", "budget", "pause", "decision", "worker"]);
    expect(seen.carried).toEqual(seen.kinds);
    expect(seen.allow).toEqual({ checkpoint: true, budget: false, pause: false, decision: true, worker: true });
    // With nothing to pick every kind takes words.
    expect(seen.noOptions).toEqual({ checkpoint: true, budget: true, pause: true, decision: true, worker: true });
    expect(seen.defaultKind).toBe("decision");
    expect(seen.unknownKind).toBeNull();
  });

  it("[sma:m_q_secret] a secret-shaped answer is refused before any writer thread or file sees it; a plain answer goes through", async () => {
    const seen = await observeSecret();
    expect(seen.outcomes).toEqual(["secret_shaped_answer", "secret_shaped_answer", "secret_shaped_answer"]);
    expect(seen.leaked).toBe(false);
    expect(seen.sentBeforePlain).toBe("");
    expect(seen.plain).toBe("sent");
  });
});

describe("region 6 b: suggestions from a phrase", () => {
  it("[sma:m_sg_words] a phrase becomes a proposed title, description and promise by fixed rules; a dot inside a file name does not end the title", () => {
    const seen = observeWords();
    expect(seen.full).toEqual({ title: "Кнопка оплаты в корзине", description: "", promise: ["Then покупатель видел итог до оплаты"] });
    expect(seen.whenThen.promise).toEqual(["When покупатель платит, then заказ закрывается"]);
    expect(seen.path).toEqual({ title: "Починить экспорт отчётов", description: "Второй кусок", promise: [] });
    expect(seen.lines.promise).toEqual(["Then пользователь видит имя"]);
    expect(seen.longTitle).toBe(60);
    expect(seen.hints).toEqual(["Опишите, что изменится для человека", "без путей и id: что увидит человек", null, "короче: Очень длинное название задачи, которое явно не помещается в…"]);
  });

  it("[sma:m_sg_clarify] the clarification graph, run through the real engine on its own test case, has one analyst who reads, hands the questions on and writes nothing", async () => {
    const seen = await observeClarify();
    expect(seen).toMatchObject({ id: "lp.clarify", status: "published", nodes: ["analyst:agent:analyst", "done:action:emit"], green: true, runStatus: "succeeded", path: ["analyst", "done"], stubbed: ["analyst:agent"], writesOrTasks: 0 });
    expect(seen.output).toEqual({ questions: [{ task: "reports", question: "в каком формате?" }] });
  });

  it("[sma:m_sg_batch_draft] a plan's pieces carry their links: waves come from depends_on, a cycle gets none, and each piece's kind gives its lane", async () => {
    const seen = await observePlan();
    expect(seen.waves).toEqual({ c: 3, a: 1, b: 2, d: 1, e: 2 });
    expect(seen.lanes).toEqual({ c: "write", a: "write", b: "write", d: "docs", e: "check" });
    expect(seen.cycWaves).toEqual({ x: 0, y: 0, z: 1 });
    expect(seen.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});
