/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const evidence = (text: string, ok: boolean, code: string, note: string) => ({ evidence: text, kind: text.startsWith("cmd:") ? "command" : "file", ok, code, note });
const card = (extra: Record<string, unknown> = {}) => ({
  contract: { objective: "Save the form", acceptance: ["the form saves", "errors are shown", "docs mention it"], ownsPaths: ["src/form/**"] },
  risk: "high",
  base: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567", branch: "lp/t1", compareCommitted: true },
  receipts: [
    { stageId: "writer-agent", state: "passed", proof: "code", proofKind: "gate", reason: null, model: "gpt-6-luna", updatedAt: 1 },
    { stageId: "code-critique", state: "passed", proof: "advisory", proofKind: "advisory", reason: null, model: "opus", updatedAt: 2 },
    { stageId: "plan-fact", state: "failed", proof: "code", proofKind: "file", reason: "plan_fact_unproven: acceptance item 2 has no evidence that holds in the diff", model: null, updatedAt: 3 },
  ],
  gates: [{ gate: "owns-paths", status: "passed", attempt: 1, at: 1 }, { gate: "accept", status: "rejected", attempt: 1, at: 2 }],
  planFact: {
    state: "failed", table: "ok", reason: null, mode: "record", extraRows: [7], notChecked: ["line ranges: the diff against the task's base could not be read, so only the files were checked"],
    wires: [{ chain: ["form.retry", "saveForm"], broken: null }, { chain: ["saveForm", "ErrorBanner"], broken: { from: "saveForm", to: "ErrorBanner" } }],
    items: [
      { item: 1, acceptance: "the form saves", claimed: "done", verdict: "proven", severity: "ok", why: null, evidence: [evidence("src/form/save.ts:10-24", true, "lines_changed", "overlaps a changed hunk"), evidence("cmd:npm test", true, "command_passed", "ran, exit code 0")] },
      { item: 2, acceptance: "errors are shown", claimed: "done", verdict: "unproven", severity: "blocking", why: null, evidence: [evidence("src/form/errors.ts:300", false, "lines_not_changed", "lines 300-300 of src/form/errors.ts are not in a changed hunk")] },
      { item: 3, acceptance: "docs mention it", claimed: "not_done", verdict: "declared_not_done", severity: "blocking", why: "no docs folder", evidence: [] },
    ],
  },
  notRun: [{ stageId: "specialist-review", why: "no receipt: no specialist review was asked for" }, { stageId: "pm-read", why: "disabled_by_project_setting" }, { stageId: "plan-fact", why: "line ranges: the diff against the task's base could not be read, so only the files were checked" }],
  cost: { state: "not_measured", usd: null, tokens: null, note: "acp-cursor reports no token usage", attempts: 2, measured: 0 },
  ...extra,
});

async function mount(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { AcceptanceCard } = await import("../src/rooms/acceptance/ui");
  return renderSlot({ component: () => <AcceptanceCard runId="run" taskId="t1" refreshKey={1} finished={false} fallback={{ objective: "Save the form", acceptance: ["the form saves"] }} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("the acceptance card", () => {
  it("shows the contract, the blind check's verdict per item, stage receipts with their proof kind, gates, what did not run, risk, base and an unmeasured cost", async () => {
    const slot = await mount({ task_acceptance_card: () => card() });
    await slot.findByTestId("acceptance-card");
    const text = (id: string) => slot.getByTestId(id).textContent ?? "";
    expect(text("acc-risk")).toContain("high");
    expect(text("acc-base")).toContain("01234567");
    expect(text("acc-base")).toContain("lp/t1");
    expect(text("acc-cost")).toContain("not measured");
    expect(text("acc-cost")).not.toMatch(/\$0/);
    expect(text("acc-objective")).toBe("Save the form");
    expect(slot.getByTestId("acc-item-1").getAttribute("data-verdict")).toBe("proven");
    expect(slot.getByTestId("acc-item-2").getAttribute("data-verdict")).toBe("unproven");
    expect(text("acc-item-2")).toContain("claimed done, no evidence in the diff (blocking)");
    expect(text("acc-item-2")).toContain("not in a changed hunk");
    expect(text("acc-item-3")).toContain("the writer says it is not done");
    expect(text("acc-item-3")).toContain("no docs folder");
    expect(text("acc-item-1")).toContain("cmd:npm test");
    expect(text("acc-planfact")).toContain("Record only");
    expect(text("acc-planfact")).toContain("Rows for items the contract does not have: 7");
    expect(text("acc-owns")).toContain("src/form/**");
    // A model's opinion is labelled as one, a code check says what kind of check it is.
    expect(slot.getByTestId("acc-receipt-code-critique").getAttribute("data-proof")).toBe("advisory");
    expect(text("acc-receipt-code-critique")).toContain("model's opinion");
    expect(slot.getByTestId("acc-receipt-writer-agent").getAttribute("data-proof")).toBe("code");
    expect(text("acc-receipt-writer-agent")).toContain("code · gate");
    expect(text("acc-receipt-plan-fact")).toContain("plan_fact_unproven");
    expect(text("acc-gates")).toMatch(/owns-paths[\s\S]*passed[\s\S]*accept[\s\S]*rejected/);
    expect(text("acc-notrun")).toContain("Not run is not «no findings»");
    expect(text("acc-notrun")).toContain("Specialist review");
    expect(text("acc-notrun")).toContain("only the files were checked");
    expect(text("acc-wires")).toContain("form.retry → saveForm");
    expect(text("acc-wires")).toContain("broken between «saveForm» and «ErrorBanner»");
    expect(text("acc-notrun")).toContain("turned off in the project's settings");
    expect(text("acc-notrun")).not.toContain("disabled_by_project_setting");
  });

  it("says NOT RUN, not «all clear», when the writer gave no table, and prints a partial cost with its count", async () => {
    const slot = await mount({ task_acceptance_card: () => card({
      planFact: { state: "skipped", table: "missing", reason: "plan_fact_table_missing: the writer's answer has no plan-fact block, so no acceptance item was checked against the diff", mode: "gate", items: [], extraRows: [], notChecked: [] },
      cost: { state: "partial", usd: 0.114, tokens: 1_100_000, note: null, attempts: 2, measured: 1 },
      base: null,
    }) });
    await slot.findByTestId("acceptance-card");
    expect(slot.getByTestId("acc-planfact-notrun").textContent).toContain("NOT RUN.");
    expect(slot.getByTestId("acc-planfact-notrun").textContent).toContain("plan_fact_table_missing");
    expect(slot.getByTestId("acc-planfact").textContent).toContain("Gate:");
    expect(slot.getByTestId("acc-item-1").getAttribute("data-verdict")).toBe("not_checked");
    expect(slot.getByTestId("acc-cost").textContent).toContain("$0.114, 1 of 2 attempts measured");
    expect(slot.getByTestId("acc-base").textContent).toContain("not recorded");
  });

  it("shows the checks that already passed on the base («already built»), the ones that were red, and what turned red after the merge", async () => {
    const baseline = (extra: Record<string, unknown>) => ({ state: "ran", verdict: "partial", action: "proceed", mode: "notify", summary: "1 green, 1 red", baseSha: "0123456789abcdef", at: 1, turnedRed: null,
      checks: [{ command: "npm test", status: "green", note: "", cached: false }, { command: "npm run lint", status: "red", note: "", cached: true }, { command: "npm run e2e", status: "skipped", note: "too slow for this pass (about 400s, cap 300s)", cached: false }], ...extra });
    const slot = await mount({ task_acceptance_card: () => card({ baseline: baseline({ turnedRed: ["npm test"] }) }) });
    await slot.findByTestId("acceptance-card");
    const text = slot.getByTestId("acc-baseline").textContent ?? "";
    expect(text).toContain("npm test");
    expect(text).toContain("green on the base");
    expect(text).toContain("red on the base · known from an earlier baseline");
    expect(text).toContain("not run · too slow for this pass");
    expect(slot.getByTestId("acc-baseline-turned").textContent).toContain("Green on the base, red on main after the change: npm test");
    cleanup();
    const built = await mount({ task_acceptance_card: () => card({ baseline: baseline({ verdict: "already_built", turnedRed: [], checks: [{ command: "npm test", status: "green", note: "", cached: false }] }) }) });
    await built.findByTestId("acceptance-card");
    expect(built.getByTestId("acc-baseline-summary").getAttribute("data-verdict")).toBe("already_built");
    expect(built.getByTestId("acc-baseline-summary").textContent).toContain("may be already done");
    expect(built.getByTestId("acc-baseline-turned").textContent).toContain("Nothing that was green on the base turned red");
    cleanup();
    const none = await mount({ task_acceptance_card: () => card({ baseline: null }) });
    await none.findByTestId("acceptance-card");
    expect(none.queryByTestId("acc-baseline")).toBeNull();
  });

  it("falls back to the contract's own lines when the card cannot be read", async () => {
    const slot = await mount({ task_acceptance_card: () => { throw new Error("rpc down"); } });
    await waitFor(() => expect(slot.getByTestId("acceptance-card-fallback").textContent).toContain("the form saves"));
    expect(slot.queryByTestId("acceptance-card")).toBeNull();
  });

  it("fits a phone: the card is one column and its text wraps instead of widening the page", async () => {
    const slot = await mount({ task_acceptance_card: () => card() });
    const root = await slot.findByTestId("acceptance-card");
    expect(root.className).not.toMatch(/\bgrid-cols-/);
    for (const id of ["acc-receipts", "acc-gates"]) expect(slot.getByTestId(id).className).toContain("min-w-0");
  });
});
