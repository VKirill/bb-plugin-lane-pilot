// Model-free observations for the phase-trace cards.  These call the same phase
// logic, phase driver, workflow helpers and critique packet used by the SMA tests;
// the only stateful host is an in-memory fake database.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { blindVerdict, designGate, issuable, nextAction, pieceLines, pieceSha, waveLines } from "../../../src/rooms/phase/logic";
import { uiContractGap } from "../../../src/rooms/phase/stages";
import { sha256Hex } from "@lane-pilot/kit";
import { postOwnerItem } from "../../../src/rooms/owner-waiting";
import { decideTaskWord } from "../../../src/rooms/lead/server/surfaces";
import { taskWordItemPrefix } from "../../../src/rooms/contracts";
import { buildCandidateEvidence, codeCritiquePrompt } from "../../../src/rooms/critique/code-critique";
import { registerProjectActions } from "../../../src/rooms/workflow/server/workflow-project-actions";
import { createCore } from "../../../src/rooms/core/server/core";
import { createAttempt, createRun, createTask, openDatabase } from "../../../src/rooms/plugin-db";
import { getPhase, listParts } from "../../../src/rooms/phase/store";
import { observe as r00b } from "../../../tests/sma/r00-world-b";
import { observe as r00c, admitted, drv, piece, fact } from "../../../tests/sma/r00-world-c";
import { observeCritic } from "../../../tests/sma/r01-world-d";


const item = (id: string, over: Record<string, unknown> = {}) => piece(id, 1, over);
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

async function phaseControl() {
  const f = await drv();
  try {
    const a = item("a"), b = item("b");
    f.seed("execution", { ...admitted([a, b]), execution: { issued: { a: "a", b: "b" }, issuedSha: { a: pieceSha(a), b: pieceSha(b) } } });
    const paused = f.phases.setState({ phaseId: f.id, state: "pause", by: "pm" });
    const resumed = f.phases.setState({ phaseId: f.id, state: "resume", by: "pm" });
    return { paused: paused.state, resumed: resumed.state, phase: resumed.stage };
  } finally { f.restore(); }
}

async function withdrawObservations() {
  const f = await drv();
  try {
    const a = item("a"), b = item("b");
    f.seed("execution", { ...admitted([a, b]), execution: { issued: { a: "a", b: "b" }, issuedSha: { a: pieceSha(a), b: pieceSha(b) } } });
    let refused = "not refused";
    try { await f.phases.decide({ phaseId: f.id, piece: "a", choice: "skip" }); } catch (e) { refused = String(e); }
    createTask(f.db, { id: "a", runId: "run1", kind: "bb", contract: a.task });
    createAttempt(f.db, { id: "att-a", runId: "run1", taskId: "a" });
    f.db.prepare("UPDATE lane_pilot_attempt SET state='blocked' WHERE id='att-a'").run();
    const skipped = await f.phases.decide({ phaseId: f.id, piece: "a", choice: "skip", note: "not worth it" });
    return { refused: refused.split("\n")[0], skipped: skipped.record.plan?.items.map((row) => row.id), withdrawn: skipped.record.scope?.withdrawn, parts: f.parts("scope_withdrawn") };
  } finally { f.restore(); }
}

async function scopeOnlyWithdraw() {
  const f = await drv({ words: true });
  try {
    const a = item("a"), b = item("b");
    f.seed("execution", { ...admitted([a, b]), words: [{ turn: "issue", decision: "yes", by: "owner", text: "yes", at: 1 }], execution: { issued: {}, issuedSha: {} } });
    const after = f.phases.withdraw({ phaseId: f.id, pieces: ["b"], note: "cut it", by: "pm" });
    return { remaining: after.record.plan?.items.map((row) => row.id), withdrawn: after.record.scope?.withdrawn, parts: f.parts("scope_withdrawn") };
  } finally { f.restore(); }
}

async function scopeWithdraw() {
  const f = await drv({ words: true });
  try {
    const a = item("a"), b = item("b");
    f.seed("execution", { ...admitted([a, b]), words: [{ turn: "issue", decision: "yes", by: "owner", text: "yes", at: 1 }, { turn: "wave", decision: "yes", wave: 1, by: "owner", text: "yes", at: 1 }], execution: { issued: {}, issuedSha: {} } });
    const after = f.phases.withdraw({ phaseId: f.id, pieces: ["b"], note: "cut it", by: "pm" });
    return { issueWord: after.record.words?.some((word) => word.turn === "issue") ?? false, action: nextAction(after, new Map()).key, parts: f.parts("scope_withdrawn") };
  } finally { f.restore(); }
}

async function waveStop() {
  const f = await drv();
  try {
    const rows = ["landed", "open", "queued"].map((id) => item(id));
    for (const id of ["landed", "open", "queued"]) { createTask(f.db, { id, runId: "run1", kind: "bb", contract: item(id).task }); createAttempt(f.db, { id: `${id}-a`, runId: "run1", taskId: id }); }
    f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='landed-a'").run();
    f.db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='open-a'").run();
    f.seed("execution", { ...admitted(rows), execution: { issued: { landed: "landed", open: "open", queued: "queued" }, startedAt: 1 } });
    const held = await f.phases.stopWave({ phaseId: f.id, by: "pm" });
    return { canceled: held.canceled, state: held.phase.state, parts: f.parts("wave_stopped") };
  } finally { f.restore(); }
}

async function holdRegistry() {
  const f = await drv();
  try {
    f.seed("execution", admitted([item("a")]));
    const stopped = await f.phases.stopWave({ phaseId: f.id, by: "pm" });
    const afterReload = f.phases.status(f.id).phase;
    return { stopped: stopped.phase.state, reloaded: afterReload.state, rows: listParts(f.db, f.id).filter((part) => part.kind === "wave_stopped").length };
  } finally { f.restore(); }
}

async function approvingObservation() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  try {
    createRun(db, "approve-run", "p");
    const key = `${taskWordItemPrefix("approve-run", "piece")}att1`;
    postOwnerItem(db as never, { key, source: "writer", kind: "task_word", projectId: "p", what: "land", why: "verified" }, 1);
    const first = decideTaskWord(db as never, "approve-run", "piece", "yes", "screen", 2);
    const second = decideTaskWord(db as never, "approve-run", "piece", "no", "screen", 3, "att1");
    const row = db.prepare("SELECT state,closed_by FROM lane_pilot_owner_item WHERE key=?").get(key);
    return { first, second, row };
  } finally { await harness.lifecycle.dispose(); }
}

async function projectProfileObservation() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const path = "/repo/.agents/planning/PROJECT.md", original = "# Project\n\n## Vision\nKeep the owner content.\n";
  const files = new Map<string,string>([[path, original]]);
  const writes: Array<{ path:string; expectedSha256?:string|null }> = [];
  harness.sdk.stub("threads.get", async () => ({ id:"pm", environmentId:"env" }));
  harness.sdk.stub("environments.get", async () => ({ id:"env", hostId:"host", path:"/repo" }));
  harness.sdk.stub("files.write", async (input: { path:string; content:string; expectedSha256?:string|null }) => {
    const old = files.get(input.path);
    if (input.expectedSha256 === null ? old !== undefined : input.expectedSha256 !== sha256Hex(old ?? "")) return { outcome:"conflict" };
    files.set(input.path, input.content); writes.push(input); return { outcome:"written" };
  });
  bb.hosts.experimental_client = (() => ({ call: async () => ({ content: files.get(path), sha256: sha256Hex(files.get(path)!), truncated:false }) })) as never;
  const ctx = createCore(bb, db), actions = new Map<string, (c: any, rt: any) => Promise<Record<string, unknown>>>();
  registerProjectActions({} as never, ctx, { action: (key, fn) => actions.set(key, fn), planHome: async () => null, flagOf: () => false });
  const fn = actions.get("lp.profile_write")!, rt = { ctx, services: {}, pmThreadId:"pm", projectId:"p", runId:null };
  const input = { node: { params: { profile: { stack:"ts", test_command:"npm test", token:"do-not-log" } } }, template: (x: unknown) => x };
  try {
    const row = await fn(input, rt), once = files.get(path);
    await fn(input, rt);
    return { row, profile: (db.prepare("SELECT key FROM lane_pilot_project_settings WHERE project_id='p' AND binding_id='' AND key LIKE 'profile.%'").all() as Array<{ key:string }>).map(x => x.key).sort(),
      project: { original, content:files.get(path), unchangedOnRepeat: once === files.get(path), writes:writes.filter(x => x.path === path).length, expectedSha256:writes.find(x => x.path === path)?.expectedSha256, originalSha:sha256Hex(original) } };
  } finally { await harness.lifecycle.dispose(); }
}

async function main() {
  const evidence = buildCandidateEvidence({ produced: ["src/reset.ts"], hashes: { "src/reset.ts": "a".repeat(64) }, verification: [{ command: "npm test", exitCode: 0, stdout: "1 passed", stderr: "" }], files: [{ path: "src/reset.ts", content: "export const reset = () => true;" }], output: "writer says trust me", ownsPaths: ["src/**"], neverTouch: [], dirtOk: true });
  const drawingRecord = { design: { decision: "needed", why: "screens", requirements: ["actions", "accessibility"], drawing: { paths: [".agents/phases/p/design/UI-SPEC.md"], sha256: "h", designer: "design-lead", reviewer: "critic", feasible: true } } } as never;
  const pieces = [item("a"), item("b")];
  const facts = new Map([["a", fact("a")], ["b", fact("b")]]);
  const profile = await projectProfileObservation();
  const out: Record<string, unknown> = {
    n264: await observeCritic().then((x) => json(x)),
    n324: await approvingObservation(),
    n327: await phaseControl(),
    n347: json(blindVerdict(pieces as never, new Map([["a", fact("a")]]), { state: "failed", detail: "a: npm test", mainSha: null } as never, 1)),
    n350: json(nextAction({ id: "p", projectId: "p", pmThreadId: "t", runId: "r", title: "x", goal: "x", stage: "execution", state: "active", record: { ownerWords: true, plan: { items: pieces, contextSha: "c", sha: "s" }, execution: { issued: {} }, wordTurns: { issue: { asks: true } } }, edition: 1, createdAt: 0, updatedAt: 0 } as never, new Map())),
    n356: await r00b.edition(),
    n357: await r00b.designWord(),
    n359: issuable(pieces as never, {}, new Map()).map((x) => x.id),
    n361: await r00c.binding(),
    n367: await withdrawObservations(),
    n368: await scopeOnlyWithdraw(),
    n371: await waveStop(),
    n372: await scopeWithdraw(),
    n381: waveLines(pieces as never, facts as never).map((line) => ({ id: line.id, ok: line.ok })),
    n382: await r00c.waveIn(),
    n1128: await holdRegistry(),
    n1590: profile.project,
    n1606: designGate(drawingRecord),
    n1607: { complete:uiContractGap(drawingRecord, "# UI\n## Actions\n## Accessibility\n"), missing:uiContractGap(drawingRecord, "# UI\n## Actions\n") },
    n1624: profile,
    n1684: codeCritiquePrompt({ evidence, task: { id: "reset", acceptance: ["User can recover a forgotten password"] } }),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
void main();
