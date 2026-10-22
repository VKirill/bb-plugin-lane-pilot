/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { HUB_SPECS, PROJECT_DEFAULT_KEYS } from "../../src/rooms/improvement";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const NOW = 1_800_000_000_000;
const view = (extra: Record<string, unknown> = {}) => ({
  generatedAt: NOW,
  values: {
    "wall.enabled": true, "wall.max_classes_per_night": 3, "wall.rounds_per_night": 2, "wall.recurrence_floor": 3, "wall.walks": 2, "wall.hunters": 3,
    "wall.hunter_provider": "codex", "wall.hunter_model": "gpt-6.1-sol", "wall.hunter_reasoning_effort": "medium", "wall.night_token_cap": 20_000_000,
    "wall.hunt_share_percent": 25, "wall.assumed_repair_tokens": 4_000_000, "wall.bench_subset": 8, "wall.rerun_sandbox_only": true,
    "bench.budget_tokens": 120_000_000, "bench.budget_hours": 6, "harness.adopt_by": "bench",
    "owner_push.enabled": true, "owner_push.quiet": "23:00-08:00", "owner_push.timezone": "Europe/Madrid",
    "baseline.already_built": null, "baseline.time_cap_sec": null, "regress.nightly": null, "regress.last_n": null, "regress.last_days": null,
    "regress.check_cap_sec": null, "regress.budget_sec": null, "regress.bisect_steps": null, "plan_fact.mode": null, "critic.code.default_for_risk": null, "memory.note_budget": null,
  },
  versions: { "wall.hunters": 4 },
  status: {
    night: { enabled: true, hour: 3, lastRunAt: NOW - 20 * 3_600_000, lastDryRun: false, lastSpend: 1_000_000, lastCap: 20_000_000, nextRunAt: NOW + 4 * 3_600_000, openClasses: 2 },
    bench: { version: "v1", tasks: 24, candidates: 60, createdAt: NOW - 86_400_000, sets: 1 },
    policy: { version: 3, frozenAt: "2026-10-22T14:14:50Z", unseen: 0, needed: 20, enough: false, passed: false },
    waiting: { total: 4, wake: 1 },
  },
  policy: {
    version: 3, frozenAt: "2026-10-22T14:14:50Z", minAccuracy: 0.8, verdict: "x", accuracy: null, inSplit: 0, seenExcluded: 0, lastRun: null,
    tiers: [
      { tier: "night_decides", entries: [{ id: "lp_fault_repair", description: "Repair" }] },
      { tier: "night_proposes", entries: [{ id: "rule_trial_apply", description: "Rule" }, { id: "brand_new_entry", description: "A thing the page has no title for" }] },
      { tier: "owner_only", entries: [{ id: "judge_gates", description: "Gates" }] },
    ],
    prohibitions: [{ id: "never_acp_opencode", description: "acp" }],
  },
  deferrals: { open: 5, overdue: 1, needsTerm: 21 },
  ...extra,
});

async function mount(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../../app"));
  const { ImprovementScreen } = await import("../../src/rooms/improvement/ui");
  return renderSlot({ component: () => <ImprovementScreen locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}
const ok = { ok: true, conflict: false, version: 5 };

describe("the Self-improvement page", () => {
  it("shows the status strip: the next and the last night, the bench set, the exam progress and what waits", async () => {
    const slot = await mount({ improvement_view: () => view() });
    await slot.findByTestId("improvement-status");
    expect(slot.getByTestId("status-night").textContent).toContain("Next:");
    expect(slot.getByTestId("status-night").textContent).toContain("Last run");
    expect(slot.getByTestId("status-bench").textContent).toContain("24 tasks");
    expect(slot.getByTestId("status-policy").textContent).toContain("0 of 20 decisions");
    expect(slot.getByTestId("status-waiting").textContent).toContain("4 to decide");
  });

  it("says the night is switched off and the bench set is not built", async () => {
    const base = view();
    const slot = await mount({ improvement_view: () => view({ status: { ...base.status, night: { ...base.status.night, enabled: false, nextRunAt: null, lastRunAt: null }, bench: null, waiting: { total: 0, wake: 0 } } }) });
    await slot.findByTestId("improvement-status");
    expect(slot.getByTestId("status-night").textContent).toContain("Switched off");
    expect(slot.getByTestId("status-night").textContent).toContain("Has not run yet");
    expect(slot.getByTestId("status-bench").textContent).toContain("Not built yet");
    expect(slot.getByTestId("status-waiting").textContent).toContain("Nothing");
  });

  it("saves a changed number on the global level with the version it was read at, once, on blur", async () => {
    const save = vi.fn().mockResolvedValue({ ...ok, version: 5 });
    const slot = await mount({ improvement_view: () => view(), save_setting: save });
    await slot.findByTestId("improvement-night");
    // The hunters are in the first block of the hunt group.
    const field = slot.getByTestId("night-hunt").querySelector("[data-storage-key='wall.hunters'] input") as HTMLInputElement;
    expect(field.value).toBe("3");
    fireEvent.change(field, { target: { value: "4" } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.blur(field);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ projectId: "*", key: "wall.hunters", value: 4, expectedVersion: 4 }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not save a field that was only visited", async () => {
    const save = vi.fn().mockResolvedValue(ok);
    const slot = await mount({ improvement_view: () => view(), save_setting: save });
    await slot.findByTestId("improvement-night");
    const field = slot.getByTestId("night-hunt").querySelector("[data-storage-key='wall.hunters'] input") as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.blur(field);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(save).not.toHaveBeenCalled();
  });

  it("shows the reason when the server refuses a value, and reloads on a conflict", async () => {
    let reads = 0;
    const save = vi.fn().mockResolvedValueOnce({ ok: false, conflict: false, version: 4, value: 3, validation: { code: "invalid_choice", key: "wall.hunters", params: ["wall.hunters", "integer 1-5"] } })
      .mockResolvedValueOnce({ ok: false, conflict: true, version: 6, value: 5 });
    const slot = await mount({ improvement_view: () => { reads += 1; return view(); }, save_setting: save });
    await slot.findByTestId("improvement-night");
    const field = () => slot.getByTestId("night-hunt").querySelector("[data-storage-key='wall.hunters'] input") as HTMLInputElement;
    fireEvent.change(field(), { target: { value: "9" } });
    fireEvent.blur(field());
    await waitFor(() => expect(slot.getByTestId("improvement-save-error").textContent).toContain("integer 1-5"));
    fireEvent.change(field(), { target: { value: "2" } });
    fireEvent.blur(field());
    await waitFor(() => expect(slot.getByTestId("improvement-save-error").textContent).toContain("changed elsewhere"));
    expect(reads).toBeGreaterThan(1);
  });

  it("the dry run asks the night what it would pick and keeps nothing", async () => {
    const night = vi.fn().mockResolvedValue({ night: "2026-10-22", dryRun: true, classesSeen: 7, picked: [{ classKey: "validation_failed:x", why: "3 in 7 days", round: 1 }], morning: [], hunts: [], backlog: ["b"], stoppedBy: null });
    const slot = await mount({ improvement_view: () => view(), wall_night: night });
    fireEvent.click(await slot.findByTestId("dry-run-button"));
    await waitFor(() => expect(night).toHaveBeenCalledWith({ dryRun: true }));
    const result = await slot.findByTestId("dry-run-result");
    expect(result.textContent).toContain("Looked at 7 classes");
    expect(result.textContent).toContain("validation_failed:x");
  });

  it("walks through the six sections; each has its controls", async () => {
    const slot = await mount({ improvement_view: () => view() });
    await slot.findByTestId("improvement-night");
    const open = async (id: string, panel: string) => { fireEvent.click(slot.getByTestId(`seg-improvement-${id}`)); await slot.findByTestId(panel); };
    await open("bench", "improvement-bench");
    expect(slot.getByTestId("bench-set-line").textContent).toContain("24 tasks from 60 candidates");
    for (const key of ["bench.budget_tokens", "bench.budget_hours", "harness.adopt_by"]) expect(slot.container.querySelector(`[data-storage-key='${key}']`), key).not.toBeNull();
    await open("checks", "improvement-checks");
    for (const key of ["baseline.already_built", "baseline.time_cap_sec", "plan_fact.mode", "critic.code.default_for_risk", "regress.nightly", "regress.last_n", "regress.bisect_steps"]) expect(slot.container.querySelector(`[data-storage-key='${key}']`), key).not.toBeNull();
    expect(slot.getByTestId("checks-default-note").textContent).toContain("defaults for all projects");
    await open("waiting", "improvement-waiting");
    for (const key of ["owner_push.enabled", "owner_push.quiet", "owner_push.timezone"]) expect(slot.container.querySelector(`[data-storage-key='${key}']`), key).not.toBeNull();
    expect(slot.getByTestId("deferral-counts").textContent).toBe("Open: 5. Overdue: 1. Without a term: 21.");
    await open("memory", "improvement-memory");
    expect(slot.container.querySelector("[data-storage-key='memory.note_budget']")).not.toBeNull();
  });

  it("shows every control of the flow once across the sections: nothing is left to the command line that has a setting", async () => {
    const slot = await mount({ improvement_view: () => view() });
    await slot.findByTestId("improvement-night");
    const seen = new Set<string>();
    for (const id of ["night", "bench", "policy", "checks", "waiting", "memory"]) {
      fireEvent.click(slot.getByTestId(`seg-improvement-${id}`));
      await slot.findByTestId(`improvement-${id}`);
      slot.container.querySelectorAll("[data-storage-key]").forEach((el) => seen.add(el.getAttribute("data-storage-key")!));
    }
    const wanted = [...HUB_SPECS.map((spec) => spec.key), ...PROJECT_DEFAULT_KEYS, "plan_fact.mode", "critic.code.default_for_risk", "memory.note_budget"];
    expect(wanted.filter((key) => !seen.has(key))).toEqual([]);
    expect([...seen].filter((key) => !wanted.includes(key))).toEqual([]);
  });

  it("the night policy is read only and says why; the exam is 0 of 20", async () => {
    const slot = await mount({ improvement_view: () => view() });
    await slot.findByTestId("improvement-night");
    fireEvent.click(slot.getByTestId("seg-improvement-policy"));
    const panel = await slot.findByTestId("improvement-policy");
    expect(panel.querySelector("input, select, button[role='switch'], [data-storage-key]")).toBeNull();
    expect(slot.getByTestId("policy-readonly-why").textContent).toContain("Read only on purpose");
    expect(slot.getByTestId("policy-exam-line").textContent).toBe("Exam: 0 of 20 of your decisions made after the freeze");
    expect(slot.getByTestId("policy-exam-bar").getAttribute("aria-valuemax")).toBe("20");
    expect(slot.getByTestId("policy-items-night_decides").textContent).toContain("Repair of a failure that is Lane Pilot's own fault");
    // An entry the dictionary has no title for shows the description the policy file carries.
    expect(slot.getByTestId("policy-items-night_proposes").textContent).toContain("A thing the page has no title for");
    expect(slot.getByTestId("policy-list-prohibitions").textContent).toContain("Standing prohibitions · 1");
  });

  it("speaks Russian", async () => {
    setLocaleOverride("ru");
    const slot = await mount({ improvement_view: () => view() });
    await slot.findByTestId("improvement-status");
    expect(slot.getByTestId("improvement-screen").textContent).toContain("Самоулучшение");
    expect(slot.getByTestId("status-policy").textContent).toContain("0 из 20 решений");
    expect(slot.getByTestId("status-bench").textContent).toContain("24 задач");
    fireEvent.click(slot.getByTestId("seg-improvement-policy"));
    expect((await slot.findByTestId("policy-exam-line")).textContent).toBe("Экзамен: 0 из 20 ваших решений, принятых после заморозки");
  });
});
