import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { LEGACY_TABS, SEGMENTS, TAB_IDS, resolveTab, type SegmentedTab, type TabId } from "./tabs-model";

/** Top-level owner console sections. */
export const CONSOLE_SECTIONS = ["overview", "decisions", "staff", "work", "memory", "system"] as const;
export type ConsoleSection = (typeof CONSOLE_SECTIONS)[number];

/** Pages nested under the System section. */
export const SYSTEM_PAGES = ["graphs", "agents", "schedules", "costs", "health", "settings"] as const;
export type SystemPage = (typeof SYSTEM_PAGES)[number];

/** Sub-views within sections that expose tabs/segments. */
export const SECTION_VIEWS = {
  decisions: ["waiting", "desk", "autonomous"],
  work: ["tasks", "projects", "errands"],
  memory: ["records", "history"],
} as const;

/** Tabs inside an individual staff member view. */
export const STAFF_TABS = ["charter", "shifts", "autonomy", "loadout", "costs"] as const;
export type StaffTab = (typeof STAFF_TABS)[number];

export type ConsoleRoute = {
  section: ConsoleSection;
  view?: string;
  page?: SystemPage;
  projectId?: string;
  sectionId?: string;
  taskRef?: { runId: string; taskId: string };
  staffRef?: { projectId: string; domain: string };
};

/** Mapping from pre-redesign panel `scope` props to console routes. */
export const LEGACY_SCOPES: Record<string, ConsoleRoute> = {
  waiting: { section: "decisions", view: "waiting" },
  tasks: { section: "work", view: "tasks" },
  errands: { section: "work", view: "errands" },
  schedule: { section: "system", page: "schedules" },
  globals: { section: "system", page: "settings", projectId: GLOBAL_SETTINGS_PROJECT_ID },
  agents: { section: "system", page: "agents" },
  workflows: { section: "system", page: "graphs" },
  tokens: { section: "system", page: "costs" },
  projects: { section: "overview" },
};

const SYSTEM_PAGE_SET = new Set<string>(SYSTEM_PAGES);
const STAFF_TAB_SET = new Set<string>(STAFF_TABS);
const SECTION_VIEW_SETS = {
  decisions: new Set<string>(SECTION_VIEWS.decisions),
  work: new Set<string>(SECTION_VIEWS.work),
  memory: new Set<string>(SECTION_VIEWS.memory),
};

function isKnownLegacyTabId(id: string): boolean {
  return (TAB_IDS as readonly string[]).includes(id) || id in LEGACY_TABS;
}

function isSegmentOf(tab: TabId, segment: string): boolean {
  return tab in SEGMENTS && (SEGMENTS[tab as SegmentedTab] as readonly string[]).includes(segment);
}

function mapLegacyTab(tab: TabId, segment?: string, projectId?: string): ConsoleRoute {
  const withProject = projectId ? { projectId } : {};
  switch (tab) {
    case "overview":
      return { section: "overview", ...withProject };
    case "team":
      return { section: "system", page: "agents", ...withProject };
    case "work":
      return { section: "system", page: "settings", ...withProject };
    case "knowledge":
      return segment === "docs"
        ? { section: "system", page: "settings", ...withProject, view: "docs" }
        : { section: "memory", view: "records", ...withProject };
    case "automation":
      return segment === "schedule"
        ? { section: "system", page: "schedules", ...withProject }
        : { section: "system", page: "graphs", ...withProject };
    case "runs":
      if (segment === "analytics") return { section: "system", page: "costs", ...withProject, view: "quality" };
      if (segment === "service") return { section: "system", page: "health", ...withProject };
      return { section: "work", view: "tasks", ...withProject };
  }
}

/**
 * Resolves a pre-redesign route (`<tab>`, `<tab>/<segment>`, or `<projectId>/<tab>[/<segment>]`)
 * to its new `ConsoleRoute`, or `null` when the path does not match any known legacy route.
 */
export function resolveLegacyRoute(subPath: string): ConsoleRoute | null {
  const parts = subPath.trim().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;

  if (parts.length === 1) {
    const token = parts[0]!;
    if (!isKnownLegacyTabId(token)) return null;
    const resolved = resolveTab(token);
    return mapLegacyTab(resolved.tab, resolved.segment);
  }

  if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    // Handle `<segmentedTab>/<segment>` without a project prefix before `<projectId>/<tab>`.
    if ((TAB_IDS as readonly string[]).includes(first) && isSegmentOf(first as TabId, second)) {
      return mapLegacyTab(first as TabId, second);
    }
    if (!isKnownLegacyTabId(second)) return null;
    const resolved = resolveTab(second);
    return mapLegacyTab(resolved.tab, resolved.segment, first);
  }

  const [projectId, rawTab, segment] = parts as [string, string, string];
  if (!isKnownLegacyTabId(rawTab)) return null;
  const resolved = resolveTab(rawTab);
  if (!isSegmentOf(resolved.tab, segment)) return null;
  return mapLegacyTab(resolved.tab, segment, projectId);
}

/** Parses a console sub-path into a `ConsoleRoute`, falling back to legacy routes and then overview. */
export function parseConsoleRoute(subPath: string): ConsoleRoute {
  const parts = subPath.trim().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length === 0) return { section: "overview" };

  const [first, second, third, fourth] = parts;
  switch (first) {
    case "overview":
      return { section: "overview" };
    case "decisions":
      return second && SECTION_VIEW_SETS.decisions.has(second)
        ? { section: "decisions", view: second }
        : { section: "decisions" };
    case "staff":
      if (second === "hire") return { section: "staff", view: "hire" };
      if (second && third) {
        return fourth && STAFF_TAB_SET.has(fourth)
          ? { section: "staff", staffRef: { projectId: second, domain: third }, view: fourth }
          : { section: "staff", staffRef: { projectId: second, domain: third } };
      }
      return { section: "staff" };
    case "work":
      if (second === "task" && third && fourth) {
        return { section: "work", taskRef: { runId: third, taskId: fourth } };
      }
      return second && SECTION_VIEW_SETS.work.has(second)
        ? { section: "work", view: second }
        : { section: "work" };
    case "memory":
      return second && SECTION_VIEW_SETS.memory.has(second)
        ? { section: "memory", view: second }
        : { section: "memory" };
    case "system": {
      if (!second || !SYSTEM_PAGE_SET.has(second)) return { section: "system" };
      const page = second as SystemPage;
      const rest = parts.slice(2).join("/");
      return rest ? { section: "system", page, view: rest } : { section: "system", page };
    }
    default:
      return resolveLegacyRoute(subPath) ?? { section: "overview" };
  }
}

/** Serializes a `ConsoleRoute` back into its canonical sub-path string. */
export function buildConsolePath(route: ConsoleRoute): string {
  switch (route.section) {
    case "overview":
      return "overview";
    case "decisions":
      return route.view && SECTION_VIEW_SETS.decisions.has(route.view)
        ? `decisions/${route.view}`
        : "decisions";
    case "staff":
      if (route.view === "hire") return "staff/hire";
      if (route.staffRef) {
        const base = `staff/${route.staffRef.projectId}/${route.staffRef.domain}`;
        return route.view && STAFF_TAB_SET.has(route.view) ? `${base}/${route.view}` : base;
      }
      return "staff";
    case "work":
      if (route.taskRef) return `work/task/${route.taskRef.runId}/${route.taskRef.taskId}`;
      return route.view && SECTION_VIEW_SETS.work.has(route.view)
        ? `work/${route.view}`
        : "work";
    case "memory":
      return route.view && SECTION_VIEW_SETS.memory.has(route.view)
        ? `memory/${route.view}`
        : "memory";
    case "system": {
      if (!route.page || !SYSTEM_PAGE_SET.has(route.page)) return "system";
      const rest = route.view?.replace(/^\/+|\/+$/g, "");
      return rest ? `system/${route.page}/${rest}` : `system/${route.page}`;
    }
  }
}
