import { useRef, type ReactNode } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import {
  Badge,
  CONTROL_H,
  Icon,
  PanelLayoutContext,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  contentStacksControls,
  useObservedWidth,
  type BuiltinIconName,
} from "@lane-pilot/ui-kit";
import { useOwnerWaitingBadge } from "../../ui-shell/ui";
import {
  CONSOLE_SECTIONS,
  SYSTEM_PAGES,
  type ConsoleRoute,
  type ConsoleSection,
  type SystemPage,
} from "../models/nav-model";
import { ScopeSwitcher } from "./scope-switcher";

const SECTION_LABELS: Record<ConsoleSection, I18nKey> = {
  overview: "consoleNavOverview",
  decisions: "consoleNavDecisions",
  staff: "consoleNavStaff",
  work: "consoleNavWork",
  memory: "consoleNavMemory",
  system: "consoleNavSystem",
};

/** The System landing is the caption of the bottom group, not a row of the main list, so it has no icon here. */
const SECTION_ICONS: Record<Exclude<ConsoleSection, "system">, BuiltinIconName> = {
  overview: "Dashboard",
  decisions: "Inbox",
  staff: "Users",
  work: "FolderKanban",
  memory: "Library",
};

const MAIN_SECTIONS = CONSOLE_SECTIONS.filter(
  (section): section is Exclude<ConsoleSection, "system"> => section !== "system",
);

const SYSTEM_PAGE_LABELS: Record<SystemPage, I18nKey> = {
  automation: "consoleSysAutomation",
  graphs: "consoleSysGraphs",
  agents: "consoleSysAgents",
  schedules: "consoleSysSchedules",
  costs: "consoleSysCosts",
  health: "consoleSysHealth",
  settings: "consoleSysSettings",
};

const SYSTEM_PAGE_ICONS: Record<SystemPage, BuiltinIconName> = {
  automation: "Workflow",
  graphs: "GitFork",
  agents: "Cpu",
  schedules: "CalendarClock",
  costs: "Wallet",
  health: "Activity",
  settings: "Settings",
};

/** Breakpoint below which left console navigation collapses into a compact Select. */
const SHELL_NAV_COMPACT_BELOW = 900;

export interface ConsoleShellProps {
  route: ConsoleRoute;
  go: (next: ConsoleRoute) => void;
  headerExtras?: ReactNode;
  children: ReactNode;
}

/** Owner console frame: left navigation (or compact Select below 900 px), Decisions badge, System group, ScopeSwitcher, and header extras slot. */
export function ConsoleShell({ route, go, headerExtras, children }: ConsoleShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shellWidth = useObservedWidth(shellRef);
  const contentWidth = useObservedWidth(contentRef);
  // Observe the outer shell rather than contentRef so toggling the sidebar does not oscillate across 900 px.
  const compactNav = shellWidth > 0 && shellWidth < SHELL_NAV_COMPACT_BELOW;
  const stackControls = contentStacksControls(contentWidth);
  const waitingBadge = useOwnerWaitingBadge();

  const goSection = (section: ConsoleSection) => {
    go({
      section,
      projectId: route.projectId,
      sectionId: route.sectionId,
    });
  };

  const goSystemPage = (page: SystemPage) => {
    go({
      section: "system",
      page,
      projectId: route.projectId,
      sectionId: route.sectionId,
    });
  };

  const compactNavValue =
    route.section === "system" && route.page ? `system:${route.page}` : `section:${route.section}`;

  const handleCompactNavChange = (next: string) => {
    if (next.startsWith("system:")) {
      goSystemPage(next.slice("system:".length) as SystemPage);
    } else if (next.startsWith("section:")) {
      goSection(next.slice("section:".length) as ConsoleSection);
    }
  };

  return (
    <PanelLayoutContext.Provider value={{ compactChrome: compactNav, stackControls }}>
      <div
        ref={shellRef}
        className={`lp-console flex h-full min-h-0 min-w-0 flex-1 overflow-hidden ${compactNav ? "flex-col" : "flex-row"}`}
        data-testid="console-shell"
        data-lp-chrome={compactNav ? "compact" : "rail"}
        data-lp-stack={stackControls ? "1" : "0"}
        data-bb-ru-skip
      >
        {!compactNav ? (
          <nav className="lp-side" aria-label={t("consoleNavAria")} data-testid="console-sidebar">
            <div className="lp-side-brand">
              <span className="lp-side-logo" aria-hidden>
                <Icon name="Workflow" className="size-4" />
              </span>
              <span className="lp-side-name">Lane Pilot</span>
            </div>
            <ScopeSwitcher route={route} go={go} variant="sidebar" />
            <div className="mt-3.5 flex flex-col gap-1" data-testid="console-nav">
              {MAIN_SECTIONS.map((section) => (
                <button
                  key={section}
                  type="button"
                  className="lp-side-item"
                  aria-current={route.section === section ? "page" : undefined}
                  data-testid={`console-nav-${section}`}
                  onClick={() => goSection(section)}
                >
                  <Icon name={SECTION_ICONS[section]} className="size-[17px] shrink-0" aria-hidden />
                  <span className="min-w-0 truncate text-left">{t(SECTION_LABELS[section])}</span>
                  {section === "decisions" && waitingBadge ? (
                    <Badge
                      variant="accent"
                      className="px-[7px] py-0.5 text-[11px] leading-[1.2]"
                      data-testid="decisions-badge"
                      aria-label={t("consoleDecisionsBadgeAria").replace("{n}", String(waitingBadge.count))}
                    >
                      {waitingBadge.label}
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="mt-auto flex flex-col gap-3 pt-4">
              {headerExtras ? (
                <div className="lp-side-extras" data-testid="console-header-extras">
                  {headerExtras}
                </div>
              ) : null}
              <div className="lp-side-system" data-testid="console-nav-system-group">
                <button
                  type="button"
                  className="lp-side-caption lp-side-caption-link"
                  aria-current={route.section === "system" && !route.page ? "page" : undefined}
                  data-testid="console-nav-system"
                  onClick={() => goSection("system")}
                >
                  {t(SECTION_LABELS.system)}
                </button>
                {SYSTEM_PAGES.map((sysPage) => (
                  <button
                    key={sysPage}
                    type="button"
                    className="lp-side-item"
                    data-system
                    aria-current={route.section === "system" && route.page === sysPage ? "page" : undefined}
                    data-testid={`console-nav-system-${sysPage}`}
                    onClick={() => goSystemPage(sysPage)}
                  >
                    <Icon name={SYSTEM_PAGE_ICONS[sysPage]} className="size-[15px] shrink-0" aria-hidden />
                    <span className="min-w-0 truncate text-left">{t(SYSTEM_PAGE_LABELS[sysPage])}</span>
                  </button>
                ))}
              </div>
            </div>
          </nav>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {compactNav ? (
            <header
              className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--lp-hairline)] px-4 py-2.5"
              data-testid="console-topbar"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Select value={compactNavValue} onValueChange={handleCompactNavChange}>
                  <SelectTrigger
                    aria-label={t("consoleNavAria")}
                    className={`${CONTROL_H} w-auto min-w-[10rem] max-w-[14rem]`}
                    data-testid="console-nav-mobile"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {CONSOLE_SECTIONS.map((section) => (
                        <SelectItem
                          key={section}
                          value={`section:${section}`}
                          data-testid={`console-mobile-nav-${section}`}
                        >
                          {t(SECTION_LABELS[section])}
                          {section === "decisions" && waitingBadge ? ` (${waitingBadge.label})` : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>{t("consoleNavSystem")}</SelectLabel>
                      {SYSTEM_PAGES.map((sysPage) => (
                        <SelectItem
                          key={sysPage}
                          value={`system:${sysPage}`}
                          data-testid={`console-mobile-system-${sysPage}`}
                        >
                          {t(SYSTEM_PAGE_LABELS[sysPage])}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <ScopeSwitcher route={route} go={go} />
              </div>
              <div className="flex shrink-0 items-center gap-2" data-testid="console-header-extras">
                {headerExtras}
              </div>
            </header>
          ) : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div
              ref={contentRef}
              className={`w-full min-w-0 space-y-5 ${compactNav ? "px-4 py-4" : "px-9 py-7"}`}
              data-testid="console-content"
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </PanelLayoutContext.Provider>
  );
}
