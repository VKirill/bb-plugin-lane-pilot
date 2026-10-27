/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { en, ru } from "@lane-pilot/i18n";
import { ROLE_MODEL_OPTIONS, ROLE_TABLE, roleDefaultModel, roleModelKey } from "@lane-pilot/models";
import { mountPage } from "./ui-harness";
import { openTab } from "./ui-tabs";
import { useMatrixHooks } from "./ui-matrix/helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

type Row = { role: string; providerId: string; model: string; effort: string; source: "table" | "stage" | "default"; sourceKey: string | null; own: boolean; version: number; defaultModel: string; defaultEffort: string; offered: boolean | null };

/** The table as the server reads it for a place: every role on its default, except what the test changes. */
function view(changes: Record<string, Partial<Row>> = {}, offered: (id: string) => boolean | null = () => true) {
  const roles: Row[] = ROLE_TABLE.map((row) => {
    const builtin = roleDefaultModel(row.id);
    return { role: row.id, providerId: builtin.providerId, model: builtin.model, effort: builtin.effort, source: "default", sourceKey: null, own: false, version: 0, defaultModel: builtin.model, defaultEffort: builtin.effort, offered: offered(builtin.model), ...changes[row.id] };
  });
  return { roles, options: ROLE_MODEL_OPTIONS.map((option) => ({ id: option.id, providerId: option.providerId, label: option.label, family: option.family, offered: offered(option.id), efforts: ["low", "medium", "high"] })) };
}

function tableRpc(initial: ReturnType<typeof view>) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let current = initial;
  return {
    calls,
    set: (next: ReturnType<typeof view>) => { current = next; },
    rpc: {
      get_role_models: (input: unknown) => { calls.push({ method: "get_role_models", input: input as Record<string, unknown> }); return current; },
      save_setting: (input: unknown) => { calls.push({ method: "save_setting", input: input as Record<string, unknown> }); return { ok: true, conflict: false, version: 1, value: (input as { value: unknown }).value }; },
      reset_project_settings: (input: unknown) => { calls.push({ method: "reset_project_settings", input: input as Record<string, unknown> }); return { ok: true, conflict: false, values: {}, versions: {} }; },
    },
  };
}

async function openTeam(slot: Awaited<ReturnType<typeof mountPage>>) {
  await slot.findByTestId("status-writer");
  openTab(slot, "team");
  return await slot.findByTestId("role-models");
}

async function choose(slot: Awaited<ReturnType<typeof mountPage>>, testId: string, label: string) {
  fireEvent.keyDown(slot.getByTestId(testId), { key: "Enter" });
  fireEvent.click(await slot.findByRole("option", { name: label }));
}

describe("the table «role -> model» on the Team tab", () => {
  useMatrixHooks();

  it("shows every role once, with its model, its effort and why, and says where the writer is picked", async () => {
    const { rpc, calls } = tableRpc(view({ "plan-critic": { source: "stage", sourceKey: "plan_critique.model", model: "gpt-6.1-terra", effort: "medium" }, analyst: { source: "table", own: true, version: 3, model: "claude-sonnet-5-5", effort: "low", sourceKey: "role_model.analyst" } }));
    const slot = await mountPage(rpc);
    const panel = await openTeam(slot);
    await waitFor(() => expect(panel.querySelectorAll("li[data-testid^='role-model-']")).toHaveLength(ROLE_TABLE.length));
    expect(calls[0]).toEqual({ method: "get_role_models", input: { projectId: "proj_ui" } });
    expect(panel.textContent).toContain(en.roleModelsHelp);
    expect(slot.getByTestId("role-models-writers").textContent).toBe(en.roleModelsWriters);
    // One row per role, no role twice.
    expect(new Set(Array.from(panel.querySelectorAll("li[data-testid^='role-model-']")).map((node) => node.getAttribute("data-testid"))).size).toBe(ROLE_TABLE.length);
    expect(slot.getByTestId("role-model-pick-analyst").textContent).toContain("Claude Sonnet 5.5");
    expect(slot.getByTestId("role-effort-pick-analyst").textContent).toBe("low");
    expect(slot.getByTestId("role-model-source-analyst").textContent).toBe(en.roleModelsSource_table);
    expect(slot.getByTestId("role-model-pick-code-critic").textContent).toContain("GPT-6.1 Sol");
    expect(slot.getByTestId("role-model-source-code-critic").textContent).toBe(en.roleModelsSource_default);
    // A model set before the table says which setting it comes from.
    expect(slot.getByTestId("role-model-source-plan-critic").textContent).toBe(en.roleModelsSource_stage.replace("{key}", "plan_critique.model"));
    expect(slot.getByTestId("role-model-code-critic").textContent).toContain(en.roleModelWhy_code_critic);
    slot.lifecycle.unmount();
  });

  it("offers only the six Claude and GPT models, and warns about a light model for a role that judges", async () => {
    const { rpc } = tableRpc(view({ planner: { source: "table", own: true, model: "claude-haiku-5-5", effort: "high", sourceKey: "role_model.planner" } }, (id) => id !== "gpt-6-luna"));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    fireEvent.keyDown(await slot.findByTestId("role-model-pick-analyst"), { key: "Enter" });
    const options = (await slot.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(ROLE_MODEL_OPTIONS.map((option) => (option.id === "gpt-6-luna" ? `${option.label} (${en.roleModelsNotOffered})` : option.label)));
    expect(slot.getByTestId("role-model-light-planner").textContent).toBe(en.roleModelsLight);
    expect(slot.queryByTestId("role-model-light-analyst")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("saves a choice as the setting role_model.<role> at the place shown, with its version, and reads the table again", async () => {
    const { rpc, calls, set } = tableRpc(view({ debugger: { version: 4 } }));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    await slot.findByTestId("role-model-pick-debugger");
    set(view({ debugger: { source: "table", own: true, version: 5, model: "claude-opus-5-5", effort: "high", sourceKey: "role_model.debugger" } }));
    await choose(slot, "role-model-pick-debugger", "Claude Opus 5.5");
    await waitFor(() => expect(calls.filter((call) => call.method === "save_setting")).toHaveLength(1));
    expect(calls.find((call) => call.method === "save_setting")!.input).toEqual({ projectId: "proj_ui", key: roleModelKey("debugger"), value: { model: "claude-opus-5-5", reasoning_effort: "high" }, expectedVersion: 4 });
    await waitFor(() => expect(slot.getByTestId("role-model-pick-debugger").textContent).toContain("Claude Opus 5.5"));
    expect(slot.getByTestId("role-model-source-debugger").textContent).toBe(en.roleModelsSource_table);
    // The effort alone is saved with the model in force.
    await choose(slot, "role-effort-pick-debugger", "low");
    await waitFor(() => expect(calls.filter((call) => call.method === "save_setting")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "save_setting")[1]!.input).toMatchObject({ key: roleModelKey("debugger"), value: { model: "claude-opus-5-5", reasoning_effort: "low" }, expectedVersion: 5 });
    slot.lifecycle.unmount();
  });

  it("«Default» drops the row of this place (the level below shows through) and only a row of this place has the button", async () => {
    const { rpc, calls } = tableRpc(view({ memory: { source: "table", own: true, version: 2, model: "gpt-6-luna", effort: "low", sourceKey: "role_model.memory" } }));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    expect(slot.queryByTestId("role-model-reset-analyst")).toBeNull();
    fireEvent.click(await slot.findByTestId("role-model-reset-memory"));
    await waitFor(() => expect(calls.filter((call) => call.method === "reset_project_settings")).toHaveLength(1));
    expect(calls.find((call) => call.method === "reset_project_settings")!.input).toEqual({ projectId: "proj_ui", keys: [roleModelKey("memory")], expectedVersions: { [roleModelKey("memory")]: 2 } });
    slot.lifecycle.unmount();
  });

  it("says why a save was refused, and keeps the table as it was", async () => {
    const { rpc } = tableRpc(view());
    const refused = { ...rpc, save_setting: () => ({ ok: false, conflict: false, version: 0, value: null, validation: { code: "invalid_choice", key: roleModelKey("analyst"), params: [roleModelKey("analyst"), "model: one of nothing"] } }) };
    const slot = await mountPage(refused);
    await openTeam(slot);
    await slot.findByTestId("role-model-pick-analyst");
    await choose(slot, "role-model-pick-analyst", "Claude Haiku 5.5");
    expect((await slot.findByTestId("role-models-error")).textContent).toBe(en.roleModelsSaveFailed.replace("{error}", "model: one of nothing"));
    expect(slot.getByTestId("role-model-pick-analyst").textContent).toContain("Claude Opus 5.5");
    slot.lifecycle.unmount();
  });

  it("reads in Russian with the word «граф» and no «воркфлоу» or «цепочка»", async () => {
    const { rpc } = tableRpc(view());
    const slot = await mountPage({ ...rpc, get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }) });
    const panel = await openTeam(slot);
    await waitFor(() => expect(panel.textContent).toContain(ru.roleModelsTitle));
    expect(panel.textContent).toContain("в каждом графе");
    expect(panel.textContent).not.toMatch(/воркфлоу|цепочк/i);
    for (const key of Object.keys(ru).filter((name) => name.startsWith("roleModels") || name.startsWith("roleModelName_") || name.startsWith("roleModelWhy_"))) {
      expect((ru as Record<string, string>)[key], key).not.toMatch(/воркфлоу|цепочк/i);
    }
    slot.lifecycle.unmount();
  });
});

describe("the strings of the table", () => {
  it("name every role in both languages", () => {
    for (const row of ROLE_TABLE) {
      for (const dictionary of [en, ru] as Array<Record<string, string>>) {
        expect(dictionary[`roleModelName_${row.id.replace(/-/g, "_")}`], row.id).toBeTruthy();
        expect(dictionary[`roleModelWhy_${row.id.replace(/-/g, "_")}`], row.id).toBeTruthy();
      }
    }
  });
});
