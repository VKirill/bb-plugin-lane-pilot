// Probe of scenes/sma_r01_a.py (region 1, batch a): runs the real pure checks of THIS checkout on scratch values and a scratch database and prints what
// they returned as one JSON line. It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { validateDocsEdits } from "../../../src/rooms/docs/docs";
import type { DocsPage } from "../../../src/rooms/contracts/docs-page";
import { failureClass, failureClassCooldownMs, FREE_CLASSES, classifyFailure } from "../../../src/rooms/contracts/failure-class";
import { designGate, type PhaseRecord } from "../../../src/rooms/phase";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createAttempt } from "../../../src/rooms/storage/attempts-store/lifecycle";
import { createRun } from "../../../src/rooms/storage/runs-store";
import { createTask } from "../../../src/rooms/storage/tasks-store";
import type { TaskV2 } from "../../../src/rooms/contracts";
import { spendReserve } from "../../../src/rooms/tasks";
import { writerPermit } from "../../../src/rooms/writer/server/start-admission";

const contract = (id: string, patch: Partial<TaskV2> = {}): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [], ...patch,
});

const message = (run: () => unknown): string | null => { try { run(); return null; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };

async function main() {
  const out: Record<string, unknown> = {};
  // n161 / n162: the permit and the reserve on a run with a token budget; t2 holds 200 of the 1000 with an open attempt, 100 are spent.
  {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    for (const [id, appetite] of [["t1", 50], ["t2", 200], ["t3", undefined]] as const) createTask(db, { id, runId: "run1", kind: "bb", contract: contract(id, appetite ? { appetite: { tokens: appetite } } as never : {}) });
    createAttempt(db, { id: "t2-a1", runId: "run1", taskId: "t2" });
    createAttempt(db, { id: "t1-a1", runId: "run1", taskId: "t1" });
    const state = (maxTokens: number | null, tokens: number) => ({ budget: { snapshot: () => ({ limits: { maxTokens }, tokens }) } }) as never;
    const input = (taskId: string, appetite?: number) => ({ runId: "run1", taskId, task: { appetite: appetite ? { tokens: appetite } : undefined } }) as never;
    const deps = { ctx: { db } } as never;
    out.n161 = { noBudgetNoPrice: writerPermit(deps, state(null, 999), input("t3")), priced: writerPermit(deps, state(1000, 100), input("t1", 50)), unpriced: writerPermit(deps, state(1000, 100), input("t3")),
      fits700: writerPermit(deps, state(1000, 100), input("t1", 700)), over701: writerPermit(deps, state(1000, 100), input("t1", 701)) };
    await harness.lifecycle.dispose();
  }
  out.n162 = { unknownBudget: spendReserve({ budgetTokens: null, spentTokens: 40, openAppetites: [30], appetite: 1000 }), fits: spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [30], appetite: 20 }),
    refused: spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [30], appetite: 31 }) };
  // n176: the pause after a repeated failure of the same class.
  out.n176 = { merge: [1, 2, 3].map((streak) => failureClassCooldownMs("merge", {}, streak)), infra: [1, 2, 3].map((streak) => failureClassCooldownMs("infra", {}, streak)), capped: failureClassCooldownMs("merge", { "writer.cooldown_max_ms": 90_000 }, 3),
    provider: failureClassCooldownMs("provider", {}, 5) };
  // n184: the four infrastructure stops of the card are free of the task's retries.
  out.n184 = { vendorAbort: classifyFailure("provider_error", "the provider aborted the stream"), contextOverflow: classifyFailure("validation_failed", "prompt is too long: 210000 tokens"), backgroundTail: classifyFailure("empty_output", "writer_background_tail: npm run dev"),
    turnCeiling: classifyFailure("blocked", "error_max_turns"), free: { provider: FREE_CLASSES.has("provider"), infra: FREE_CLASSES.has("infra") }, taskRed: failureClass("validation_failed", "verification failed (npm test): boom") };
  // n187: a drawing step needs a feasible drawing reviewed by someone else.
  {
    const record: PhaseRecord = { design: { decision: "needed", why: "screens", drawing: { paths: ["d.png"], sha256: "x", designer: "design-lead", feasible: true, reviewer: "design-lead" } } };
    const sameRole = designGate(record);
    record.design!.drawing!.reviewer = "ui-review";
    record.design!.drawing!.paths = ["d.png", ".agents/phases/ph_sma/design/UI-SPEC.md"];
    const separate = designGate(record);
    record.design!.drawing!.feasible = false;
    record.design!.drawing!.contradiction = "the plan has no screen";
    out.n187 = { none: designGate({}).ok, notNeeded: designGate({ design: { decision: "not_needed", why: "no screens" } }).ok, sameRole: [sameRole.ok, sameRole.ok ? [] : sameRole.why], separate: separate.ok, infeasible: designGate(record).ok };
  }
  // n189: a docs edit is taken only for the selected page and its hash.
  {
    const sha = "a".repeat(64);
    const page: DocsPage = { path: "docs/a.md", modifiedAt: 1, sha256: sha, content: "hello" };
    const edit = (path: string, expectedSha256: string) => () => validateDocsEdits([{ path, expectedSha256, content: "x" }], [page], 10);
    out.n189 = { ok: validateDocsEdits([{ path: "docs/a.md", expectedSha256: sha, content: "# A\n" }], [page], 10).length, wrongHash: message(edit("docs/a.md", "b".repeat(64))), otherPage: message(edit("docs/other.md", sha)), notDocs: message(edit("src/a.ts", sha)) };
  }
  console.log(JSON.stringify(out)); // guardian: allow
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
