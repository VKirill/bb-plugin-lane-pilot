/** @vitest-environment jsdom */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { roleModelKey } from "@lane-pilot/models";
import type { AgentLoadoutOutput } from "../src/rooms/contracts";
import { listRecentDrills } from "../src/rooms/coverage/drills";
import { room as coverageRoom } from "../src/rooms/coverage/server";
import { CriticValue } from "../src/rooms/critique/ui";
import { insertOutage, room as outageRoom } from "../src/rooms/outage/server";
import { HealthScreen } from "../src/rooms/pages/ui/screens/health-screen";
import { SystemHome } from "../src/rooms/pages/ui/screens/system-home";
import type { LpPage } from "../src/rooms/pages/ui/use-lp-page";
import { openDatabase } from "../src/rooms/plugin-db";
import { AcceptanceStats } from "../src/rooms/runs/ui";
import { AgentsLoadout } from "../src/rooms/settings/ui";
import { CostsScreen } from "../src/rooms/usage/ui";
import { WriterReuse } from "../src/rooms/writer/ui";
import { screenFixture } from "./ui-harness";
import { choosePickerValue, type PickerNode, type PickerValue } from "./ui-settings-integration/helpers";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

function installPickerDriver() {
  installTestPluginRuntime();
  const sdk = (globalThis as typeof globalThis & { __bbPluginRuntime: { pluginSdkApp: Record<string, unknown> } })
    .__bbPluginRuntime.pluginSdkApp;
  sdk.experimental_ProviderModelPicker = (props: { value: PickerValue; onChange: (next: PickerValue) => void }) =>
    React.createElement("div", {
      "data-testid": "bb-provider-model-picker",
      "data-provider": props.value.providerId,
      "data-model": props.value.model,
      "data-effort": props.value.reasoningLevel,
      ref: (node: PickerNode | null) => {
        if (node) {
          node.__pickerValue = props.value;
          node.__pickerOnChange = props.onChange;
        }
      },
    });
}

function loadoutFixture(): AgentLoadoutOutput {
  return {
    roles: [
      {
        role: "writer",
        kind: "pipeline",
        model: { provider: "codex", model: "gpt-6-luna", from: "project" },
        items: [
          { type: "skill", name: "lp-writer", from: "profile", missing: true },
          { type: "skill", name: "karpathy-guidelines", from: "profile", missing: false },
          { type: "plugin", name: "environment-project-checkout", from: "required", missing: false },
          { type: "mcp", name: "gitnexus", from: "profile", missing: false },
        ],
        contextMode: "roles",
        machine: null,
        note: null,
      },
      {
        role: "analyst",
        kind: "pipeline",
        model: { provider: "claude-code", model: "claude-opus-5-5", from: "builtin" },
        items: [
          { type: "plugin", name: "environment-project-checkout", from: "required", missing: false },
          { type: "mcp", name: "bb-bridge", from: "required", missing: false },
        ],
        contextMode: "roles",
        machine: null,
        note: null,
      },
      {
        role: "seo-specialist",
        kind: "specialist",
        model: { provider: "claude-code", model: "claude-sonnet-5-5", from: "project" },
        items: [
          { type: "skill", name: "seo-drmax-orchestrator", from: "profile", missing: false },
          { type: "skill", name: "missing-seo-skill", from: "domain_pack", missing: true },
          { type: "plugin", name: "env-catalog", from: "profile", missing: false },
          { type: "mcp", name: "bb-bridge", from: "required", missing: false },
        ],
        contextMode: "roles",
        machine: null,
        note: "в шаге графа пакета нет",
      },
      {
        role: "browser-qa",
        kind: "pipeline",
        model: { provider: "claude-code", model: "claude-sonnet-5-5", from: "builtin" },
        items: [
          { type: "plugin", name: "browser-automation", from: "profile", missing: true },
          { type: "mcp", name: "bb-bridge", from: "required", missing: false },
        ],
        contextMode: "roles",
        machine: "mac-mini",
        note: null,
      },
      {
        role: "dev-orchestrator",
        kind: "pm",
        model: { provider: "claude-code", model: "claude-opus-5-5", from: "project" },
        items: [{ type: "plugin", name: "lane-pilot", from: "profile", missing: false }],
        contextMode: "roles",
        machine: null,
        note: "плюс весь каталог BB",
      },
    ],
  };
}

const CATALOG_FIXTURE = {
  hosts: [{ id: "mini", name: "Mac mini", connected: true }],
  providers: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      logoUrl: null,
      family: null,
      supportsServiceTier: false,
      serviceTiers: [],
      hostIds: ["mini"],
      models: [
        { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "high", isDefault: true, hostIds: ["mini"] },
        { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, hostIds: ["mini"] },
      ],
    },
    {
      id: "codex",
      displayName: "Codex",
      logoUrl: null,
      family: null,
      supportsServiceTier: false,
      serviceTiers: [],
      hostIds: ["mini"],
      models: [
        { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", efforts: ["medium", "high"], defaultEffort: "high", isDefault: true, hostIds: ["mini"] },
        { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, hostIds: ["mini"] },
      ],
    },
  ],
  runHostId: "mini",
};

function accessFixture() {
  return {
    mode: "roles",
    modeOrigin: null,
    roles: [
      {
        role: "writer",
        key: "helper.access.writer",
        version: 2,
        value: null,
        inherited: false,
        origin: "project",
        originBelow: null,
        groups: {
          bbPlugins: { names: ["environment-project-checkout"], source: "role" },
          skills: { names: ["lp-writer", "karpathy-guidelines"], source: "role" },
          mcpServers: { names: ["gitnexus", "bb-bridge"], source: "role" },
          nativePlugins: { names: [], source: "role" },
        },
        switches: {
          userInstructions: { include: false, source: "role" },
          projectInstructions: { include: true, source: "role" },
        },
      },
      {
        role: "analyst",
        key: "helper.access.analyst",
        version: 0,
        value: null,
        inherited: false,
        origin: null,
        originBelow: null,
        groups: {
          bbPlugins: { names: ["environment-project-checkout"], source: "role" },
          skills: { names: [], source: "role" },
          mcpServers: { names: ["bb-bridge"], source: "role" },
          nativePlugins: { names: [], source: "role" },
        },
        switches: {
          userInstructions: { include: false, source: "role" },
          projectInstructions: { include: true, source: "role" },
        },
      },
    ],
    catalog: { bbPlugins: [], skills: [] },
    mandatory: { bbPlugins: ["environment-project-checkout", "project-folders"], mcpServers: ["bb-bridge"] },
    providers: {},
  };
}

describe("SystemHome (P9)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
  });

  it("renders six tiles with live status lines and navigates on click", async () => {
    const go = vi.fn();
    const slot = renderSlot(
      {
        component: () => (
          <SystemHome route={{ section: "system" }} go={go} projectId="proj_ui" sectionId={null} />
        ),
      },
      {},
      {
        context: { projectId: "proj_ui", threadId: null },
        rpc: {
          workflow_list: () => ({ workflows: [{ id: "w1" }, { id: "w2" }, { id: "w3" }], problems: [], project: "ok" }),
          workflow_evolution_list: () => ({ items: [], autoPublishedCount: 0, pendingApprovalCount: 2 }),
          agent_loadout: () => loadoutFixture(),
          schedule_list: () => ({ schedules: [{ state: "active" }, { state: "active" }, { state: "paused" }], hosts: [], now: 0, errandDefault: {} }),
          money_status: () => ({ monthUsd: 12.5, cap: 50, left: 37.5 }),
          brakes_get: () => ({ brakes: [{ id: "schedules", paused: true, since: 1, reason: "test", impact: { label: "s", count: 1 } }] }),
          canary_status: () => ({ tripped: false, green: true }),
          owner_waiting: () => ({ items: [{ source: "outage" }], counts: { outage: 1 } }),
          get_screen: () => ({ ...screenFixture(), explicitKeys: ["a", "b", "c", "d"] }),
        },
      },
    );

    await slot.findByTestId("console-system-hub");
    await waitFor(() => expect(slot.getByTestId("system-tile-status-graphs").textContent).toContain("3"));

    expect(slot.getByTestId("system-tile-status-graphs").textContent).toContain("2 ждут");
    expect(slot.getByTestId("system-tile-status-agents").textContent).toContain("5 ролей · 3 с нехваткой");
    expect(slot.getByTestId("system-tile-status-schedules").textContent).toContain("2 активных · 1 на паузе");
    expect(slot.getByTestId("system-tile-status-costs").textContent).toContain("$");
    expect(slot.getByTestId("system-tile-status-health").textContent).toContain("Простои: 1");
    expect(slot.getByTestId("system-tile-status-health").textContent).toContain("1 на паузе");
    expect(slot.getByTestId("system-tile-status-settings").textContent).toContain("4");

    fireEvent.click(slot.getByTestId("system-tile-agents"));
    expect(go).toHaveBeenCalledWith({ section: "system", page: "agents" });
    slot.lifecycle.unmount();
  });
});

describe("AgentsLoadout (P13)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
  });

  it("renders roles from agent_loadout, flags missing hub items, saves role_model.<role>, resets overrides, and shows details", async () => {
    installPickerDriver();
    const saves: Array<Record<string, unknown>> = [];
    const resets: Array<Record<string, unknown>> = [];
    const onScopeChange = vi.fn();

    const slot = renderSlot(
      {
        component: () => (
          <AgentsLoadout
            projectId="proj_ui"
            sectionId={null}
            locale="ru"
            projects={[{ id: "proj_ui", name: "UI test" }]}
            sections={[{ id: "sec_web", name: "Web" }]}
            onScopeChange={onScopeChange}
            renderWriterDetail={() => <div data-testid="writer-detail">writer detail</div>}
            renderBrowserDetail={() => <div data-testid="browser-qa-detail">browser detail</div>}
          />
        ),
      },
      {},
      {
        context: { projectId: "proj_ui", threadId: null },
        rpc: {
          agent_loadout: () => loadoutFixture(),
          get_role_models: () => ({
            roles: [
              {
                role: "analyst",
                providerId: "claude-code",
                model: "claude-opus-5-5",
                effort: "high",
                source: "default",
                sourceKey: null,
                own: false,
                version: 3,
                defaultModel: "claude-opus-5-5",
                defaultEffort: "high",
                offered: true,
                pool: [],
              },
              {
                role: "seo-specialist",
                providerId: "claude-code",
                model: "claude-sonnet-5-5",
                effort: "high",
                source: "table",
                sourceKey: "role_model.seo-specialist",
                own: true,
                version: 5,
                defaultModel: "claude-sonnet-5-5",
                defaultEffort: "high",
                offered: true,
                pool: [{ providerId: "codex", model: "gpt-6.1-sol", effort: "high" }],
              },
            ],
            options: [],
          }),
          workflow_model_catalog: () => CATALOG_FIXTURE,
          helper_access_view: () => accessFixture(),
          get_globals: () => ({ defaults: {}, revision: 0, agents: [] }),
          get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: "proj_ui" }),
          get_agent_inventory: () => ({
            skills: { status: "ready", items: [] },
            mcpServers: { status: "unavailable", items: [] },
            tools: { status: "ready", items: [] },
            disallowedTools: { status: "ready", items: [] },
          }),
          save_setting: (input: unknown) => {
            saves.push(input as Record<string, unknown>);
            return { ok: true, conflict: false, version: 4, value: (input as { value: unknown }).value };
          },
          reset_project_settings: (input: unknown) => {
            resets.push(input as Record<string, unknown>);
            return { ok: true, conflict: false, values: {}, versions: {} };
          },
        },
      },
    );

    await slot.findByTestId("loadout-missing-banner");
    expect(slot.getByTestId("loadout-missing-banner").textContent).toContain("3");

    // Matrix renders roles from fixture and marks missing hub items.
    const writerRow = await slot.findByTestId("access-role-writer");
    expect(writerRow.textContent).toContain("нет на хабе");
    expect(slot.getByTestId("loadout-skills-writer").textContent).toContain("2");
    expect(slot.getByTestId("loadout-skills-writer").textContent).toContain("нет на хабе");
    expect(slot.getByTestId("loadout-plugins-browser_qa").textContent).toContain("нет на хабе");

    // Project scope does not render ModelOverridesPanel (system-only).
    expect(slot.queryByTestId("model-overrides")).toBeNull();
    // OwnedSettings scope="agents" is rendered below.
    await slot.findByTestId("owned-settings");

    // Changing analyst model calls save_setting with role_model.analyst.
    const analystPickerWrap = await slot.findByTestId("loadout-model-pick-analyst");
    const analystPicker = analystPickerWrap.querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    await choosePickerValue({ providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" }, analystPicker);
    await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(1));
    expect(saves[0]).toEqual({
      projectId: "proj_ui",
      key: roleModelKey("analyst"),
      value: { provider: "codex", model: "gpt-6.1-sol", reasoning_effort: "high" },
      expectedVersion: 3,
    });

    // Pool editing: remove pool entry on seo-specialist calls save_setting with role_model.seo-specialist without pool.
    fireEvent.click(slot.getByTestId("loadout-pool-remove-seo-specialist-gpt-6.1-sol"));
    await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(2));
    expect(saves[1]).toEqual({
      projectId: "proj_ui",
      key: roleModelKey("seo-specialist"),
      value: { provider: "claude-code", model: "claude-sonnet-5-5", reasoning_effort: "high" },
      expectedVersion: 5,
    });

    // Expanding writer row shows loadout items + WriterDetail + RoleAccessBody.
    fireEvent.click(slot.getByTestId("role-open-writer"));
    const writerDrawer = await slot.findByTestId("role-drawer-writer");
    expect(within(writerDrawer).getByTestId("loadout-item-writer-skill-lp-writer").textContent).toContain("нет на хабе");
    expect(within(writerDrawer).getByTestId("writer-detail")).toBeTruthy();
    expect(within(writerDrawer).getByTestId("access-body-writer")).toBeTruthy();

    // Expanding browser-qa row shows BrowserDetail.
    fireEvent.click(slot.getByTestId("role-open-browser_qa"));
    const browserDrawer = await slot.findByTestId("role-drawer-browser_qa");
    expect(within(browserDrawer).getByTestId("browser-qa-detail")).toBeTruthy();

    // «Как у уровня выше» resets own overrides at project level.
    fireEvent.click(slot.getByTestId("loadout-reset-specialist_seo_specialist"));
    await waitFor(() => expect(resets).toHaveLength(1));
    expect(resets[0]).toMatchObject({
      projectId: "proj_ui",
      keys: [roleModelKey("seo-specialist")],
      expectedVersions: { [roleModelKey("seo-specialist")]: 5 },
    });

    // Level picker triggers scope change to system.
    const levelPicker = slot.getByTestId("seg-loadout-level-picker");
    fireEvent.click(within(levelPicker).getByRole("button", { name: "Система" }));
    expect(onScopeChange).toHaveBeenCalledWith({});

    slot.lifecycle.unmount();
  });

  it("renders ModelOverridesPanel at system level and mounts SystemHome + AgentsLoadout inside ConsoleRoutes", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "system" },
      {
        context: { projectId: null, threadId: null },
        rpc: {
          get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
          list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI test" }], lastProjectId: null }),
          list_sections: () => ({ sections: [] }),
          get_screen: () => ({ ...screenFixture(), projectId: "*", explicitKeys: ["k1"] }),
          owner_waiting: () => ({ generatedAt: 1, items: [], counts: {}, overnight: { windowMs: 1, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 }, now: 0, answered: { owner: 0, agent: 0, lead: 0, janitor: 0 } }),
          workflow_list: () => ({ workflows: [{ id: "wf1" }], problems: [], project: "ok" }),
          workflow_evolution_list: () => ({ items: [], autoPublishedCount: 0, pendingApprovalCount: 0 }),
          agent_loadout: () => loadoutFixture(),
          schedule_list: () => ({ schedules: [], hosts: [], now: 0, errandDefault: {} }),
          money_status: () => ({ monthUsd: 0, cap: null, left: null }),
          brakes_get: () => ({ brakes: [] }),
          canary_status: () => ({ tripped: false, green: true }),
          get_role_models: () => ({ roles: [], options: [] }),
          workflow_model_catalog: () => CATALOG_FIXTURE,
          helper_access_view: () => accessFixture(),
          get_globals: () => ({ defaults: {}, revision: 0, agents: [] }),
          get_agent_inventory: () => ({
            skills: { status: "ready", items: [] },
            mcpServers: { status: "unavailable", items: [] },
            tools: { status: "ready", items: [] },
            disallowedTools: { status: "ready", items: [] },
          }),
          list_model_overrides: () => ({ levels: [] }),
        },
      },
    );

    await slot.findByTestId("console-system-hub");
    await waitFor(() => expect(slot.getByTestId("system-tile-status-agents").textContent).toContain("5 ролей"));
    fireEvent.click(slot.getByTestId("system-tile-agents"));

    await slot.findByTestId("system-agents");
    await slot.findByTestId("model-overrides");
    await slot.findByTestId("owned-settings");
    slot.lifecycle.unmount();
  });
});

describe("CostsScreen (P14)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
  });

  it("shows money_status cap, spend, left, 14-day bars, TokenUsage, and project-scoped Quality tab", async () => {
    const onViewChange = vi.fn();
    const moneyTable = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-11-${String(i + 10).padStart(2, "0")}`,
      usd: i === 13 ? 12.5 : i * 0.5,
    }));

    const sysSlot = renderSlot(
      {
        component: () => (
          <CostsScreen
            projectId={null}
            projects={[{ id: "proj_ui", name: "UI test" }]}
            locale="ru"
            onViewChange={onViewChange}
            WriterReuse={WriterReuse}
            CriticValue={CriticValue}
            AcceptanceStats={AcceptanceStats}
          />
        ),
      },
      {},
      {
        context: { projectId: null, threadId: null },
        rpc: {
          money_status: () => ({
            monthUsd: 18.75,
            estimatedUsd: 1.25,
            cap: 50,
            left: 31.25,
            table: moneyTable,
          }),
          token_usage: () => ({
            byModel: [],
            series: [],
            byProject: [],
            months: ["2026-11"],
            lastSyncAt: null,
            noDataProviders: [],
            diagnostics: { threadsSeen: 0, threadsWithUsage: 0, threadsFailed: 0, lastError: null },
            costUsd: 0,
          }),
        },
      },
    );

    await sysSlot.findByTestId("costs-money-status");
    await waitFor(() => expect(sysSlot.getByTestId("costs-kpi-month-spend").textContent).toContain("18,75"));
    expect(sysSlot.getByTestId("costs-kpi-cap").textContent).toContain("50,00");
    expect(sysSlot.getByTestId("costs-kpi-left").textContent).toContain("31,25");
    expect(sysSlot.getByTestId("costs-money-bar-2026-11-23")).toBeTruthy();
    expect(sysSlot.getByTestId("token-usage")).toBeTruthy();

    fireEvent.click(sysSlot.getByTestId("seg-costs-view-quality"));
    expect(onViewChange).toHaveBeenCalledWith("quality");
    sysSlot.lifecycle.unmount();

    const sysQuality = renderSlot(
      {
        component: () => (
          <CostsScreen
            projectId={null}
            projects={[{ id: "proj_ui", name: "UI test" }]}
            view="quality"
            locale="ru"
            WriterReuse={WriterReuse}
            CriticValue={CriticValue}
            AcceptanceStats={AcceptanceStats}
          />
        ),
      },
      {},
      { context: { projectId: null, threadId: null }, rpc: {} },
    );
    await sysQuality.findByTestId("costs-quality-select-project");
    sysQuality.lifecycle.unmount();

    const projQuality = renderSlot(
      {
        component: () => (
          <CostsScreen
            projectId="proj_ui"
            projects={[{ id: "proj_ui", name: "UI test" }]}
            view="quality"
            locale="ru"
            WriterReuse={WriterReuse}
            CriticValue={CriticValue}
            AcceptanceStats={AcceptanceStats}
          />
        ),
      },
      {},
      {
        context: { projectId: "proj_ui", threadId: null },
        rpc: {
          writer_reuse_stats: () => ({
            days: 7,
            stats: { tasks: 0, accepted: 0, coldThreads: 0, continued: 0, coldPerAccepted: null, areaShare: null, tasksPerArea: null, medianMinutesToAccept: null },
          }),
          critic_stats: () => ({ days: 7, stats: [] }),
          acceptance_stats: () => ({
            days: 28,
            totals: { dispatched: 0, firstTryAccepted: 0, eventuallyAccepted: 0, attempts: 0, attemptsPerAccepted: null, heldShare: null, redispatched: 0, families: 0, causes: {} },
            projects: [],
          }),
        },
      },
    );
    await projQuality.findByTestId("costs-quality");
    expect(projQuality.getByTestId("writer-reuse")).toBeTruthy();
    expect(projQuality.getByTestId("critic-value")).toBeTruthy();
    expect(projQuality.getByTestId("acceptance-stats")).toBeTruthy();
    projQuality.lifecycle.unmount();
  });
});

describe("HealthScreen (P15)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
  });

  function fakePage(): LpPage {
    return {
      rpc: { call: vi.fn() } as unknown as LpPage["rpc"],
      load: vi.fn(async () => undefined),
      projectId: "proj_ui",
      nativeState: { status: "enabled", error: null },
      data: {
        ...screenFixture(),
        unapplied: [],
        legacyStack: false,
      } as unknown as LpPage["data"],
      confirmOpen: false,
      setConfirmOpen: vi.fn(),
      pendingOp: null,
      setPendingOp: vi.fn(),
      snapshotPath: "",
      setSnapshotPath: vi.fn(),
      detectResult: null,
      resultPatch: null,
      resultSource: null,
      stackControls: false,
      diagnosticsGrouped: [],
      writeDraft: vi.fn(),
      applySetting: vi.fn(async () => undefined),
      displayedValue: vi.fn(() => undefined),
      runStack: vi.fn(async () => undefined),
      hostLabel: vi.fn(() => "Mac mini"),
      nativeHostId: "host_ui",
      installNative: vi.fn(async () => undefined),
    } as unknown as LpPage;
  }

  it("renders canary block, outages, last drills, and ServiceSegment", async () => {
    const page = fakePage();
    const slot = renderSlot(
      { component: () => <HealthScreen page={page} locale="ru" /> },
      {},
      {
        context: { projectId: "proj_ui", threadId: null },
        rpc: {
          canary_status: () => ({
            version: "0.1.611",
            since: 1_800_000_000_000,
            window: { open: true, attempts: 12, minutes: 30, maxAttempts: 20, maxMinutes: 120 },
            faults: 3,
            rate: 0.25,
            tripped: true,
            rollback: "bash scripts/lp-canary.sh --rollback 0.1.610",
            green: false,
            pool: { works: false, held: ["codex/gpt-6-luna"], enabled: 2, blocked: [{ key: "codex/gpt-6-luna", projectIds: ["proj_ui"], reason: "limit" }] },
          }),
          outages_list: () => ({
            outages: [
              { id: 1, fromAt: 1_800_000_000_000, toAt: 1_800_000_600_000, minutes: 10, cause: "hub restart", noticedAt: 1_800_000_600_000 },
            ],
          }),
          drills_list: () => ({
            drills: [
              {
                file: "2026-11-24.json",
                date: "2026-11-24",
                stamp: "20261124-164536",
                finishedAt: 1_800_000_100_000,
                durationSec: 23,
                mode: "quick",
                result: "pass",
                passedCount: 5,
                totalCount: 5,
                problems: [],
              },
            ],
          }),
        },
      },
    );

    await slot.findByTestId("service-panel");
    const canaryCard = await slot.findByTestId("health-canary");
    await waitFor(() => expect(canaryCard.textContent).toContain("Сработала"));
    expect(canaryCard.textContent).toContain("v0.1.611");
    expect(canaryCard.textContent).toContain("scripts/lp-canary.sh --rollback 0.1.610");
    expect(canaryCard.textContent).toContain("codex/gpt-6-luna");

    const outagesCard = await slot.findByTestId("health-outages");
    await waitFor(() => expect(outagesCard.textContent).toContain("hub restart"));
    expect(outagesCard.textContent).toContain("10 мин");

    const drillsCard = await slot.findByTestId("health-drills");
    await waitFor(() => expect(drillsCard.textContent).toContain("20261124-164536"));
    expect(drillsCard.textContent).toContain("5/5");
    expect(slot.getByTestId("native-install")).toBeTruthy();
    expect(slot.getByTestId("runs-resume")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("reads outages from the outage service and drill receipts from .agents/runs/drills", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = Date.now();
    insertOutage(db, { fromAt: now - 600_000, toAt: now, minutes: 10 }, "deploy gap", now);

    const outageHandlers = outageRoom.rpc!({ bb, db, log: bb.log } as never, {} as never) as {
      outages_list: (input: { days: number }) => Promise<{ outages: Array<{ minutes: number; cause: string | null }> }>;
    };
    const outageResult = await outageHandlers.outages_list({ days: 7 });
    expect(outageResult.outages).toHaveLength(1);
    expect(outageResult.outages[0]).toMatchObject({ minutes: 10, cause: "deploy gap" });

    const tmpRoot = mkdtempSync(join(tmpdir(), "lp-drills-reader-"));
    try {
      const drillsPath = join(tmpRoot, ".agents", "runs", "drills");
      mkdirSync(drillsPath, { recursive: true });
      writeFileSync(
        join(drillsPath, "2026-11-27.json"),
        JSON.stringify({
          date: "2026-11-27",
          stamp: "20261127-120000",
          durationSec: 19,
          mode: "quick",
          result: "pass",
          scenarios: [{ name: "guard_hash", result: "pass" }, { name: "checkers", result: "pass" }],
          problems: [],
        }),
      );
      const drills = listRecentDrills(tmpRoot, 5);
      expect(drills).toHaveLength(1);
      expect(drills[0]).toMatchObject({
        file: "2026-11-27.json",
        mode: "quick",
        result: "pass",
        passedCount: 2,
        totalCount: 2,
      });
      const covHandlers = coverageRoom.rpc!({} as never, {} as never) as {
        drills_list: (input: { limit: number }) => Promise<{ drills: unknown[] }>;
      };
      const covRes = await covHandlers.drills_list({ limit: 3 });
      expect(Array.isArray(covRes.drills)).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("SettingsScreen (P16)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
  });

  it("renders 4 groups without Basic/Advanced toggle, switches levels, reveals rare fields under «Ещё», shows inheritance, and saves settings", async () => {
    const saves: Array<Record<string, unknown>> = [];
    const resets: Array<Record<string, unknown>> = [];
    const setLocales: Array<Record<string, unknown>> = [];
    const pushSaves: Array<Record<string, unknown>> = [];

    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "system/settings" },
      {
        context: { projectId: "proj_ui", threadId: null },
        rpc: {
          get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: "proj_ui" }),
          set_locale: (input: unknown) => {
            setLocales.push(input as Record<string, unknown>);
            const { locale } = input as { locale: string };
            return { locale: locale === "auto" ? "ru" : locale, preference: locale };
          },
          list_projects: () => ({ projects: [{ id: "proj_ui", name: "SelfyStudio" }], lastProjectId: "proj_ui" }),
          list_sections: () => ({ sections: [{ id: "sec_web", parentId: null, name: "Web", path: "apps/web", kind: "folder" }] }),
          get_screen: (input: unknown) => {
            const { projectId, sectionId } = input as { projectId: string; sectionId?: string };
            const base = screenFixture();
            return {
              ...base,
              projectId,
              sectionId: sectionId ?? null,
              values: {
                ...base.values,
                quality_mode: "full",
                "adoc.040": "worktree",
                "helper.placement": "plugin",
              },
              explicitKeys: projectId === "*" ? ["quality_mode"] : sectionId ? ["adoc.040"] : ["quality_mode"],
              inheritedKeys: projectId === "*" ? [] : sectionId ? ["quality_mode", "helper.placement"] : ["adoc.040", "helper.placement"],
            };
          },
          save_setting: (input: unknown) => {
            saves.push(input as Record<string, unknown>);
            return { ok: true, conflict: false, version: 2, value: (input as { value: unknown }).value };
          },
          reset_project_settings: (input: unknown) => {
            resets.push(input as Record<string, unknown>);
            return { ok: true, conflict: false, values: {}, versions: {} };
          },
          docs_overview: () => ({ places: [] }),
          owner_waiting: () => ({ generatedAt: 1, items: [], counts: {}, overnight: { windowMs: 1, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 }, now: 0, answered: { owner: 0, agent: 0, lead: 0, janitor: 0 } }),
          owner_waiting_config: (input: unknown) => {
            const patch = (input as { patch?: Record<string, string> })?.patch;
            if (patch) pushSaves.push(patch);
            return { enabled: patch?.enabled === "on" || !patch, quiet: patch?.quiet ?? "23:00-08:00", timezone: patch?.timezone ?? "Europe/Madrid" };
          },
          get_routing_hint: () => ({ current: null, stats: [] }),
        },
      },
    );

    await slot.findByTestId("settings-screen");
    // Old ProjectHeader and Basic/Advanced toggle are removed.
    expect(slot.queryByTestId("settings-depth")).toBeNull();
    expect(slot.queryByTestId("project-header")).toBeNull();

    // Project level active by default when context has proj_ui; inherited field shows «Наследуется от системы».
    const screenEl = slot.getByTestId("settings-screen");
    expect(within(slot.getByTestId("seg-settings-level-picker")).getByRole("button", { name: "Проект" }).getAttribute("aria-pressed")).toBe("true");
    expect(screenEl.textContent).toContain("SelfyStudio");
    expect(slot.getByTestId("field-s040").textContent).toContain("Наследуется от системы");
    expect(slot.getByTestId("field-s423").textContent).toContain("Задано в этом проекте");

    // «Ещё» inside Work starts collapsed and reveals former advanced fields when clicked.
    const workMore = slot.getByTestId("settings-more-work");
    expect(workMore.hasAttribute("open")).toBe(false);
    fireEvent.click(workMore.querySelector("summary")!);
    expect(workMore.hasAttribute("open")).toBe(true);
    const placementField = within(workMore).getByTestId("field-s371");
    expect(placementField.textContent).toContain("Наследуется от системы");

    // Saving a setting calls save_setting.
    fireEvent.click(placementField.querySelector("button[role='combobox']")!);
    fireEvent.click(await slot.findByRole("option", { name: "В дереве проекта" }));
    await waitFor(() =>
      expect(saves).toContainEqual(expect.objectContaining({ projectId: "proj_ui", key: "helper.placement", value: "project_tree" })),
    );

    // Switching level to Раздел shows «Наследуется от проекта».
    fireEvent.click(within(slot.getByTestId("seg-settings-level-picker")).getByRole("button", { name: "Раздел" }));
    await waitFor(() => expect(slot.getByTestId("field-s423").textContent).toContain("Наследуется от проекта"));

    // Switching level to Система queries projectId "*".
    fireEvent.click(within(slot.getByTestId("seg-settings-level-picker")).getByRole("button", { name: "Система" }));
    await waitFor(() =>
      expect(within(slot.getByTestId("seg-settings-level-picker")).getByRole("button", { name: "Система" }).getAttribute("aria-pressed")).toBe("true"),
    );

    // Memory group «Ещё» reveals memory advanced settings.
    fireEvent.click(slot.getByTestId("settings-nav-memory"));
    const memoryMore = slot.getByTestId("settings-more-memory");
    expect(memoryMore.hasAttribute("open")).toBe(false);
    fireEvent.click(memoryMore.querySelector("summary")!);
    expect(memoryMore.hasAttribute("open")).toBe(true);
    expect(within(memoryMore).getByTestId("field-s104")).toBeTruthy();

    // Docs group shows docs.enabled and «Ещё» reveals onboarding.depth.
    fireEvent.click(slot.getByTestId("settings-nav-docs"));
    expect(slot.getByTestId("field-s115")).toBeTruthy();
    const docsMore = slot.getByTestId("settings-more-docs");
    expect(docsMore.hasAttribute("open")).toBe(false);
    fireEvent.click(docsMore.querySelector("summary")!);
    expect(docsMore.querySelector("[data-storage-key='onboarding.depth']")).toBeTruthy();

    // Language & notifications group wires LocaleControls -> set_locale and PushSettings -> owner_waiting_config.
    fireEvent.click(slot.getByTestId("settings-nav-notifications"));
    const localeGroup = slot.getByTestId("settings-locale");
    fireEvent.click(within(localeGroup).getByRole("button", { name: "EN" }));
    await waitFor(() => expect(setLocales).toContainEqual(expect.objectContaining({ locale: "en" })));
    const pushBlock = await slot.findByTestId("owner-push");
    fireEvent.click(within(pushBlock).getByTestId("owner-push-enabled"));
    await waitFor(() => expect(pushSaves.length).toBeGreaterThanOrEqual(1));

    slot.lifecycle.unmount();
  });
});
