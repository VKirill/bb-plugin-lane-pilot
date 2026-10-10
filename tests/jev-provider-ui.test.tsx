/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";
import { mountPage, screenFixture } from "./ui-harness";
import { openTab } from "./ui-tabs";
import { useMatrixHooks } from "./ui-matrix/helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

type Id = "openlux" | "typesafe";
const SECRET = "sk-never-shown-1234567890";

/** The Jev provider RPCs on a small in-memory state: the stored setting, which providers have a key. */
function jevRpc(state: { chosen: Id; keys: Record<Id, boolean> }) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const status = () => ({
    chosen: state.chosen,
    effective: state.keys[state.chosen] ? state.chosen : state.keys.typesafe ? "typesafe" : null,
    catalog: "ok",
    providers: [
      { id: "typesafe", keyName: "TYPESAFE_API_KEY", model: "jev-latest", hasKey: state.keys.typesafe },
      { id: "openlux", keyName: "OPENLUX_API_KEY", model: "jev-1.13.0:stable", hasKey: state.keys.openlux },
    ],
  });
  return {
    calls,
    rpc: {
      get_screen: ({ projectId }: any) => {
        const payload = screenFixture();
        return { ...payload, projectId, values: { ...payload.values, "jev.provider": state.chosen }, versions: { ...payload.versions, "jev.provider": 1 } };
      },
      save_setting: (input: any) => {
        calls.push({ method: "save_setting", input });
        if (input.key === "jev.provider") state.chosen = input.value;
        return { ok: true, conflict: false, version: 2, value: input.value };
      },
      jev_provider_status: () => { calls.push({ method: "jev_provider_status", input: {} }); return status(); },
      jev_provider_save_key: (input: any) => {
        calls.push({ method: "jev_provider_save_key", input });
        state.keys[input.provider as Id] = true;
        return status();
      },
      jev_provider_test: () => {
        calls.push({ method: "jev_provider_test", input: {} });
        return state.chosen === "openlux"
          ? { ok: true, provider: "openlux", model: "jev-1.13.0:stable", latencyMs: 812, error: null }
          : { ok: false, provider: "typesafe", model: null, latencyMs: 40, error: "http 401" };
      },
    },
  };
}

async function openGlobalWork(slot: Awaited<ReturnType<typeof mountPage>>) {
  await slot.findByTestId("status-writer");
  fireEvent.click(slot.getAllByRole("tab", { name: "General settings" })[0]!);
  await waitFor(() => expect(slot.getByTestId("project-settings").querySelector("h1")?.textContent).toBe("General settings"));
  openTab(slot, "work");
  return await slot.findByTestId("jev-provider");
}

describe("Jev block of the global settings", () => {
  useMatrixHooks();

  it("sits at the top of Work with a key status per provider and never shows a key", async () => {
    const { rpc } = jevRpc({ chosen: "openlux", keys: { openlux: true, typesafe: false } });
    const slot = await mountPage(rpc);
    const block = await openGlobalWork(slot);
    expect(slot.getByTestId("work-panel-body").firstElementChild!.contains(block)).toBe(true);
    await waitFor(() => expect(slot.getByTestId("jev-key-state-openlux").textContent).toBe(en.jevKeyHas));
    expect(slot.getByTestId("jev-key-state-typesafe").textContent).toBe(en.jevKeyMissing);
    expect(slot.getByTestId("jev-choose-openlux").getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByTestId("jev-choose-typesafe").getAttribute("aria-pressed")).toBe("false");
    expect(slot.getByTestId("jev-serving").textContent).toContain("OpenLux");
    expect(slot.queryByTestId("jev-warning")).toBeNull();
    for (const id of ["openlux", "typesafe"]) expect((slot.getByTestId(`jev-key-input-${id}`) as HTMLInputElement).type).toBe("password");
    expect(block.textContent).toContain("OPENLUX_API_KEY");
    // The block replaces the plain select: jev.provider is on the page once.
    expect(slot.getAllByTestId("jev-provider")).toHaveLength(1);
    expect(slot.container.querySelectorAll("[data-storage-key='jev.provider']")).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("switches the provider through the setting and warns when the chosen one has no key", async () => {
    const state = { chosen: "openlux" as Id, keys: { openlux: true, typesafe: false } };
    const { rpc, calls } = jevRpc(state);
    const slot = await mountPage(rpc);
    await openGlobalWork(slot);
    fireEvent.click(slot.getByTestId("jev-choose-typesafe"));
    await waitFor(() => expect(calls).toContainEqual({ method: "save_setting", input: expect.objectContaining({ projectId: "*", key: "jev.provider", value: "typesafe" }) }));
    // TypeSafe has no key and OpenLux is not asked: nobody serves Jev.
    const warning = await slot.findByTestId("jev-warning");
    expect(warning.textContent).toBe(en.jevWarnNone);
    expect(slot.getByTestId("jev-choose-typesafe").getAttribute("aria-pressed")).toBe("true");
    // Back to OpenLux after it lost its key: Jev runs on TypeSafe's key, and says so.
    state.keys = { openlux: false, typesafe: true };
    fireEvent.click(slot.getByTestId("jev-choose-openlux"));
    await waitFor(() => expect(slot.getByTestId("jev-warning").textContent).toBe(en.jevWarnFallback.replace("{chosen}", "OpenLux").replace("{name}", "OPENLUX_API_KEY")));
    expect(slot.getByTestId("jev-serving").textContent).toContain("TypeSafe");
    slot.lifecycle.unmount();
  });

  it("saves a key from the password field, clears the field and flips the status", async () => {
    const { rpc, calls } = jevRpc({ chosen: "openlux", keys: { openlux: false, typesafe: false } });
    const slot = await mountPage(rpc);
    const block = await openGlobalWork(slot);
    const save = slot.getByTestId("jev-key-save-openlux") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const input = slot.getByTestId("jev-key-input-openlux") as HTMLInputElement;
    fireEvent.change(input, { target: { value: SECRET } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(slot.getByTestId("jev-key-state-openlux").textContent).toBe(en.jevKeyHas));
    expect(calls).toContainEqual({ method: "jev_provider_save_key", input: { provider: "openlux", key: SECRET } });
    expect(input.value).toBe("");
    expect(slot.getByTestId("jev-key-saved-openlux").textContent).toBe(en.jevKeySaved);
    expect(block.textContent).not.toContain(SECRET);
    expect(slot.container.innerHTML).not.toContain(SECRET);
    slot.lifecycle.unmount();
  });

  it("shows why a refused save failed", async () => {
    const { rpc } = jevRpc({ chosen: "openlux", keys: { openlux: false, typesafe: false } });
    const slot = await mountPage({ ...rpc, jev_provider_save_key: () => { throw new Error("Env Catalog is not available"); } });
    await openGlobalWork(slot);
    fireEvent.change(slot.getByTestId("jev-key-input-openlux"), { target: { value: SECRET } });
    fireEvent.click(slot.getByTestId("jev-key-save-openlux"));
    const failure = await slot.findByTestId("jev-save-error");
    expect(failure.textContent).toContain("Env Catalog is not available");
    // The field keeps what was typed so the owner can retry; the text of the page never carries it.
    expect((slot.getByTestId("jev-key-input-openlux") as HTMLInputElement).value).toBe(SECRET);
    expect(slot.getByTestId("jev-provider").textContent).not.toContain(SECRET);
    slot.lifecycle.unmount();
  });

  it("runs the test request and shows ok with model and latency, or the error", async () => {
    const state = { chosen: "openlux" as Id, keys: { openlux: true, typesafe: true } };
    const { rpc, calls } = jevRpc(state);
    const slot = await mountPage(rpc);
    await openGlobalWork(slot);
    await waitFor(() => expect(slot.getByTestId("jev-key-state-openlux")).toBeTruthy());
    fireEvent.click(slot.getByTestId("jev-test"));
    const ok = await slot.findByTestId("jev-test-result");
    expect(ok.textContent).toBe("Works: OpenLux, model jev-1.13.0:stable, 812 ms");
    expect(ok.getAttribute("data-ok")).toBe("true");
    fireEvent.click(slot.getByTestId("jev-choose-typesafe"));
    await waitFor(() => expect(state.chosen).toBe("typesafe"));
    fireEvent.click(slot.getByTestId("jev-test"));
    await waitFor(() => expect(slot.getByTestId("jev-test-result").textContent).toBe("Failed: http 401 (40 ms)"));
    expect(slot.getByTestId("jev-test-result").getAttribute("data-ok")).toBe("false");
    expect(calls.filter((call) => call.method === "jev_provider_test")).toHaveLength(2);
    slot.lifecycle.unmount();
  });

  it("does not call the service when the chosen provider has no key, and says which key is missing", async () => {
    const { rpc, calls } = jevRpc({ chosen: "openlux", keys: { openlux: false, typesafe: true } });
    const slot = await mountPage(rpc);
    await openGlobalWork(slot);
    await waitFor(() => expect(slot.getByTestId("jev-key-state-openlux").textContent).toBe(en.jevKeyMissing));
    fireEvent.click(slot.getByTestId("jev-test"));
    expect((await slot.findByTestId("jev-test-result")).textContent).toBe(en.jevTestNoKey.replace("{name}", "OPENLUX_API_KEY"));
    expect(calls.some((call) => call.method === "jev_provider_test")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("speaks Russian", async () => {
    setLocaleOverride("ru");
    const { rpc } = jevRpc({ chosen: "openlux", keys: { openlux: false, typesafe: true } });
    const slot = await mountPage({ ...rpc, get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }) });
    await slot.findByTestId("status-writer");
    fireEvent.click(slot.getAllByRole("tab", { name: ru.navGlobals })[0]!);
    await waitFor(() => expect(slot.getByTestId("project-settings").querySelector("h1")?.textContent).toBe(ru.navGlobals));
    openTab(slot, "work");
    await slot.findByTestId("jev-provider");
    await waitFor(() => expect(slot.getByTestId("jev-key-state-openlux").textContent).toBe("Ключ: нет"));
    expect(slot.getByTestId("jev-key-state-typesafe").textContent).toBe("Ключ: есть");
    expect(slot.getByTestId("jev-test").textContent).toBe("Проверить");
    expect(slot.getByTestId("jev-warning").textContent).toContain("Jev работает на TypeSafe");
    slot.lifecycle.unmount();
  });

  it("leaves a project with a note, not a second switch", async () => {
    const { rpc, calls } = jevRpc({ chosen: "typesafe", keys: { openlux: true, typesafe: true } });
    const slot = await mountPage(rpc);
    await slot.findByTestId("status-writer");
    openTab(slot, "work");
    fireEvent.click(slot.getByTestId("settings-depth").querySelectorAll("button")[1]!);
    expect(slot.queryByTestId("jev-provider")).toBeNull();
    expect(slot.getByTestId("jev-provider-note").textContent).toContain("TypeSafe");
    expect(calls.some((call) => call.method === "jev_provider_status")).toBe(false);
    slot.lifecycle.unmount();
  });
});
