/** @vitest-environment jsdom */
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { CONSOLE_SECTIONS, SYSTEM_PAGES } from "../src/rooms/pages/models";
import { LanePilotPage } from "../src/rooms/pages";
import { boardFixture, cardFixture, screenFixture } from "./ui-harness";

type LanePilotScope = ComponentProps<typeof LanePilotPage>["scope"];

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

const PROJECTS = [
  { id: "proj_ui", name: "UI test" },
  { id: "proj_alpha", name: "Alpha app" },
];

const SECTIONS_BY_PROJECT: Record<string, Array<{ id: string; parentId: string | null; name: string; path: string; kind: "folder" | "group" }>> = {
  proj_ui: [{ id: "sec_web", parentId: null, name: "Web", path: "apps/web", kind: "folder" }],
  proj_alpha: [{ id: "sec_api", parentId: null, name: "API", path: "services/api", kind: "folder" }],
};

const NOW = 1_800_000_000_000;

function waitingFixture(now = 2) {
  return {
    generatedAt: NOW,
    now,
    counts: { night: 2, deferral_term: 1 },
    overnight: { windowMs: 86_400_000, red: [], accepted: 1, rulesAdopted: 0, rulesConfirmed: 0 },
    answered: { owner: 0, agent: 0, lead: 0, janitor: 0 },
    items: [
      {
        key: "night:1",
        source: "night",
        kind: "proposal",
        projectId: "proj_ui",
        what: "Approve night proposal 1",
        why: "Owner decision required",
        since: NOW - 1_000,
        wake: true,
        tier: "now",
        evidence: [],
        actions: [],
      },
      {
        key: "night:2",
        source: "night",
        kind: "proposal",
        projectId: "proj_alpha",
        what: "Approve night proposal 2",
        why: "Owner decision required",
        since: NOW - 2_000,
        wake: true,
        tier: "now",
        evidence: [],
        actions: [],
      },
      {
        key: "deferral:3",
        source: "deferral_term",
        kind: "deferral_skipped_test",
        projectId: null,
        what: "Later item",
        why: "Waits folded",
        since: NOW - 3_000,
        wake: false,
        tier: "later",
        evidence: [],
        actions: [],
      },
    ],
  };
}

function defaultProviders() {
  return {
    status: "ready",
    providers: [{
      id: "codex",
      displayName: "Codex",
      available: true,
      capabilities: {
        modelCatalogScope: "host",
        permissionModes: [],
        supportsFork: false,
        supportsNativeUserQuestion: false,
        supportsServiceTier: true,
        supportsSessionRewind: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
      },
      serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
    }],
  } as never;
}

function defaultRpc(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const baseScreen = screenFixture();
  return {
    get_preferences: (input: unknown) => ({
      locale: (input as { suggestedLocale: "en" | "ru" }).suggestedLocale,
      preference: "auto",
      lastProjectId: null,
    }),
    set_locale: (input: unknown) => ({
      locale: (input as { locale: "auto" | "en" | "ru"; suggestedLocale: "en" | "ru" }).locale === "auto"
        ? (input as { suggestedLocale: "en" | "ru" }).suggestedLocale
        : (input as { locale: "en" | "ru" }).locale,
      preference: (input as { locale: "auto" | "en" | "ru" }).locale,
    }),
    remember_project: () => ({ ok: true }),
    list_projects: () => ({ projects: PROJECTS, lastProjectId: "proj_ui" }),
    list_sections: (input: unknown) => ({
      sections: SECTIONS_BY_PROJECT[(input as { projectId?: string }).projectId ?? ""] ?? [],
    }),
    get_routing_hint: () => ({ current: null, stats: [] }),
    get_screen: (input: unknown) => {
      const pid = (input as { projectId?: string }).projectId ?? "proj_ui";
      return { ...baseScreen, projectId: pid };
    },
    task_board: () => boardFixture(),
    task_card: () => cardFixture(),
    work_graph_strips: () => ({}),
    specialist_overview: () => ({ breakers: [], pendingIntents: 0, dispatchedCount: 0, openQuestionsCount: 0, artifactsCount: 0, spend30dUsd: 0 }),
    owner_waiting: () => waitingFixture(2),
    owner_waiting_config: () => ({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" }),
    helper_access_view: () => ({ mode: "roles", modeOrigin: null, roles: [], catalog: { bbPlugins: [], skills: [] }, mandatory: { bbPlugins: [], mcpServers: [] }, providers: {} }),
    get_role_models: () => ({ roles: [] }),
    workflow_model_catalog: () => ({ providers: [] }),
    list_agents: () => ({ agents: [] }),
    get_globals: () => ({ defaults: {}, revision: 0, agents: [] }),
    token_usage: () => ({
      byModel: [],
      series: [],
      byProject: [],
      months: [],
      lastSyncAt: null,
      noDataProviders: [],
      diagnostics: { threadsSeen: 0, threadsWithUsage: 0, threadsFailed: 0, lastError: null },
      costUsd: null,
    }),
    ...overrides,
  };
}

async function mountConsole({
  subPath = "",
  scope,
  projectId = null,
  rpc = {},
}: {
  subPath?: string;
  scope?: LanePilotScope;
  projectId?: string | null;
  rpc?: Record<string, (input: unknown) => unknown>;
} = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const options = {
    context: { projectId, threadId: null },
    providers: defaultProviders(),
    rpc: defaultRpc(rpc),
  };
  if (scope !== undefined) {
    return renderSlot(
      { component: () => <LanePilotPage subPath={subPath} scope={scope} /> },
      {},
      options,
    );
  }
  return renderSlot(app.navPanels[0]!, { subPath }, options);
}

describe("console shell", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
  });

  it("renders 6 sections and 6 system pages by default with Overview active", async () => {
    const slot = await mountConsole();
    await slot.findByTestId("console-shell");

    const nav = slot.getByTestId("console-nav");
    const sysGroup = slot.getByTestId("console-nav-system-group");
    expect(nav.querySelectorAll("button")).toHaveLength(6);
    expect(sysGroup.querySelectorAll("button")).toHaveLength(6);
    for (const section of CONSOLE_SECTIONS) {
      expect(slot.getByTestId(`console-nav-${section}`)).toBeTruthy();
    }
    for (const page of SYSTEM_PAGES) {
      expect(slot.getByTestId(`console-nav-system-${page}`)).toBeTruthy();
    }
    expect(slot.getByTestId("console-nav-overview").getAttribute("aria-current")).toBe("page");
    await slot.findByTestId("console-overview");
    slot.lifecycle.unmount();
  });

  it("mounts the waiting board when clicking «Решения»", async () => {
    const slot = await mountConsole({
      rpc: {
        get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
      },
    });
    const decisionsBtn = await slot.findByRole("button", { name: /Решения/ });
    expect(decisionsBtn.getAttribute("data-testid")).toBe("console-nav-decisions");
    fireEvent.click(decisionsBtn);

    await slot.findByTestId("owner-waiting");
    expect(decisionsBtn.getAttribute("aria-current")).toBe("page");
    slot.lifecycle.unmount();
  });

  it("resolves legacy subPath and legacy scope to their new console pages", async () => {
    const agentsSlot = await mountConsole({ subPath: "proj_ui/team" });
    await agentsSlot.findByTestId("system-agents");
    expect(agentsSlot.getByTestId("console-nav-system-agents").getAttribute("aria-current")).toBe("page");
    agentsSlot.lifecycle.unmount();

    const costsSlot = await mountConsole({ scope: "tokens" });
    await costsSlot.findByTestId("token-usage");
    expect(costsSlot.getByTestId("console-nav-system-costs").getAttribute("aria-current")).toBe("page");
    costsSlot.lifecycle.unmount();
  });

  it("calls remember_project with the chosen project id from the scope switcher", async () => {
    const rememberProject = vi.fn(() => ({ ok: true }));
    const listSections = vi.fn((input: unknown) => ({
      sections: SECTIONS_BY_PROJECT[(input as { projectId?: string }).projectId ?? ""] ?? [],
    }));
    const slot = await mountConsole({
      rpc: {
        remember_project: rememberProject,
        list_sections: listSections,
      },
    });

    const switcher = await slot.findByTestId("scope-switcher");
    fireEvent.click(switcher);
    const alphaOption = await slot.findByTestId("scope-project-proj_alpha");
    fireEvent.click(alphaOption);

    await waitFor(() => expect(rememberProject).toHaveBeenCalledWith({ projectId: "proj_alpha" }));
    await waitFor(() => expect(listSections).toHaveBeenCalledWith({ projectId: "proj_alpha" }));
    await slot.findByTestId("console-overview");
    await waitFor(() => expect(slot.getByTestId("scope-switcher").textContent).toContain("Alpha app"));
    slot.lifecycle.unmount();
  });

  it("shows the `now` count from the owner_waiting fixture on the Decisions badge", async () => {
    const slot = await mountConsole({
      rpc: {
        // 3 total items, 2 marked `now` — badge must display 2, not 3.
        owner_waiting: () => waitingFixture(2),
      },
    });

    const badge = await slot.findByTestId("decisions-badge");
    expect(badge.textContent).toBe("2");
    slot.lifecycle.unmount();
  });
});
