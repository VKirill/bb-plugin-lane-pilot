/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountPage, missingStack, screenFixture } from "../ui-harness";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";
import { openRole, useMatrixHooks } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("Lane Pilot UI", () => {
  useMatrixHooks();

  it("shows a CAS conflict instead of silently overwriting", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: true, version: 3, value: "other" }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const sw = openRole(slot, "writer").querySelector("[data-testid='jev-settings'] [role='switch']") as HTMLButtonElement;
    fireEvent.click(sw);
    await slot.findByTestId("cas-conflict");
    slot.lifecycle.unmount();
  });

  it("keeps the writer selection in one native catalog picker", async () => {
    const slot = await mountPage();
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    // Every model picker sits in the Team table, one row per role; the Work tab keeps the policies and no picker.
    const team = slot.getByTestId("team-panel");
    const work = slot.getByTestId("work-panel");
    expect(team.querySelector("[data-testid='writer-picker'] [data-testid='bb-provider-model-picker']")).not.toBeNull();
    expect(openRole(slot, "writer").querySelector("[data-testid='writer-effort-mode']")).not.toBeNull();
    expect(team.querySelector("[data-testid='access-role-writer'] [data-testid='browser-qa-host']")).toBeNull();
    expect(team.querySelector("[data-testid='access-role-browser_qa'] [data-testid='browser-qa-host']")).not.toBeNull();
    expect(team.querySelector("[data-testid='access-role-night_reviewer'] [data-testid='night-review-settings']")).not.toBeNull();
    expect(work.querySelector("[data-testid='bb-provider-model-picker']")).toBeNull();
    expect(work.querySelector("[data-testid='writer-picker']")).toBeNull();
    expect(work.querySelector("[data-testid='browser-qa-host']")).toBeNull();
    expect(work.querySelector("[data-testid='night-review-settings']")).toBeNull();
    expect(slot.container.querySelector("[data-testid='field-s004']")).toBeNull();
    expect(slot.container.querySelector("[data-testid='field-s022']")).toBeNull();
    expect(slot.container.querySelector("[data-testid='field-s023']")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("asks for confirmation before external install operations", async () => {
    const slot = await mountPage({ stack_detect: missingStack });
    openTab(slot, "service");
    fireEvent.click(await slot.findByTestId("stack-detect"));
    fireEvent.click(await slot.findByTestId("install-stack"));
    const dialog = await slot.findByTestId("external-ops-dialog");
    expect(dialog.textContent).toContain("npm install -g @rama_nigg/open-cursor");
    expect(dialog.textContent).toContain(en.confirmBody);
    expect(dialog.className).toMatch(/overflow-x-hidden/);
    expect(dialog.className).toMatch(/max-w-\[359px\]/);
    expect(dialog.className).toMatch(/min-w-0/);
    expect(dialog.className).toMatch(/!max-w-\[359px\]/);
    slot.lifecycle.unmount();
  });

  it("shows writer output and installation receipts only in Maintenance technical details", async () => {
    const slot = await mountPage({}, { projectId:"proj_ui", threadId:null }, "", false);
    openTab(slot, "monitor");
    expect(slot.queryByTestId("writer-result")).toBeNull();
    openTab(slot, "service");
    const preview = await slot.findByTestId("cli-preview");
    const previewJson = JSON.parse(preview.querySelector("code")!.textContent!) as { argv:string[] };
    expect(previewJson.argv.filter((arg) => arg === "--provider")).toHaveLength(1);
    expect(previewJson.argv).toContain("fast");
    const writer = await slot.findByTestId("writer-result");
    expect(writer.textContent).toContain("hello from writer");
    expect(slot.getByTestId("diagnostics-panel").textContent).toContain("\"action\":\"install\"");
    // Maintenance keeps the technical details folded under the install actions.
    expect(slot.getByTestId("diagnostics-disclosure").hasAttribute("open")).toBe(false);
    const install = await slot.findByTestId("install-receipt");
    expect(install.textContent).toContain("\"action\":\"install\"");
    expect(install.textContent).not.toContain("hello from writer");
    slot.lifecycle.unmount();
  });

  it("renders host coexistence inventory with owner, capability, and evidence", async () => {
    const slot = await mountPage({
      stack_detect: () => ({
        hostId:"host_ui", laneStack:{ present:true, version:"custom", sourceSha:"other" },
        openCode:{ present:true, version:"1.18.30" }, workspace:{ path:"/tmp/work", present:true },
        targetSha:"dd77", matchesTarget:false, scenario:"S2",
        coexistence:{ managers:[{
          manager:"managed-checkout", path:"/opt/engine", installed:true, configured:true, loaded:null,
          compatible:true, modified:true, version:"custom", sourceSha:"abc", sha256:"a".repeat(64),
          owner:"user", decision:"reuse", missingCapabilities:[],
          evidence:[{ kind:"capability", path:"/opt/engine", sha256:"a".repeat(64), detail:"required interface listAgentRuns available" }],
        }] },
      }),
    });
    openTab(slot, "service");
    fireEvent.click(await slot.findByTestId("stack-detect"));
    const inventory = await slot.findByTestId("coexistence-inventory");
    const checkout = slot.getByTestId("coex-managed-checkout");
    expect(inventory.textContent).toContain(en.coexInventory);
    expect(checkout.textContent).toContain(en.coexDecisionReuse);
    expect(checkout.textContent).toContain(en.coexOwnerUser);
    expect(checkout.textContent).toContain(en.coexRuntimeUnverified);
    expect(checkout.textContent).toContain(en.coexCompatible);
    expect(checkout.textContent).toContain("required interface listAgentRuns available");
    expect(slot.getByTestId("stack-detect-result").textContent).toContain(en.targetMatchInformational);
    slot.lifecycle.unmount();
  });

  it("opens each CLI receipt only in Diagnostics", async () => {
    const base = screenFixture();
    const slot = await mountPage({
      get_screen: () => ({
        ...base,
        runs: [
          {
            id: "lprun_a",
            state: "accepted",
            kind: "cli",
            created_at: 1,
            updated_at: 2,
            cliReceiptJson: "{\"lanePilotRunId\":\"lprun_a\",\"mark\":\"first\"}",
            attempts: [{
              id: "lpattempt_a",
              state: "accepted",
              attempt_no: 1,
              thread_id: null,
              reason: null,
              task_id: "task_a",
              cliReceiptJson: "{\"lanePilotRunId\":\"lprun_a\",\"mark\":\"first\"}",
            }],
          },
          {
            id: "lprun_b",
            state: "accepted",
            kind: "cli",
            created_at: 2,
            updated_at: 3,
            cliReceiptJson: "{\"lanePilotRunId\":\"lprun_b\",\"mark\":\"second\"}",
            attempts: [{
              id: "lpattempt_b",
              state: "accepted",
              attempt_no: 1,
              thread_id: null,
              reason: null,
              task_id: "task_b",
              cliReceiptJson: "{\"lanePilotRunId\":\"lprun_b\",\"mark\":\"second\"}",
            }],
          },
        ],
      }),
    }, { projectId:"proj_ui", threadId:null }, "", false);
    openTab(slot, "monitor");
    expect(slot.queryByTestId("cli-receipt-lpattempt_a")).toBeNull();
    openTab(slot, "service");
    expect((await slot.findByTestId("cli-receipt-lpattempt_a")).textContent).toContain("first");
    expect((await slot.findByTestId("cli-receipt-lpattempt_b")).textContent).toContain("second");
    slot.lifecycle.unmount();
  });

  it("shows the legacy fast-mode mapping in Diagnostics instead of a separate switch", async () => {
    const slot = await mountPage();
    openTab(slot, "service");
    const migration = await slot.findByTestId("field-s024");
    expect(migration.textContent).toContain(en.legacyFastModeExplanation);
    expect(migration.querySelector("[role='switch']")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps the latest numeric value across deferred saves from 1 to 10", async () => {
    const deferred: Array<{
      value: unknown;
      expectedVersion: number;
      resolve: (result: { ok: boolean; conflict: boolean; version: number; value: unknown }) => void;
    }> = [];
    const slot = await mountPage({
      save_setting: (input: unknown) => {
        const { value, expectedVersion } = input as { value: unknown; expectedVersion: number };
        return new Promise((resolve) => {
          deferred.push({ value, expectedVersion, resolve });
        });
      },
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const input = slot.getByTestId("night-review-policy").querySelector("[data-testid='field-s006'] input[type='number']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    await waitFor(() => expect(deferred.length).toBe(1));
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    expect(input.value).toBe("10");
    deferred[0]!.resolve({ ok: true, conflict: false, version: 2, value: deferred[0]!.value });
    await waitFor(() => expect(deferred.some((item) => item.value === 10)).toBe(true));
    expect(input.value).toBe("10");
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    for (const item of deferred) item.resolve({ ok: true, conflict: false, version: item.expectedVersion + 1, value: item.value });
    await waitFor(() => expect(input.value).toBe("10"));
    expect(deferred.at(-1)?.value).toBe(10);
    slot.lifecycle.unmount();
  });

  it("switches the new settings chrome in Russian", async () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "ru-RU" });
    setLocaleOverride(null);
    document.documentElement.lang = "ru";
    const slot = await mountPage({
      get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
    });
    openTab(slot, "work");
    expect(slot.getByTestId("settings-depth").textContent).toContain(ru.settingsBasic);
    expect(slot.getByTestId("settings-depth").textContent).toContain(ru.settingsAdvanced);
    slot.lifecycle.unmount();
  });
});
