import { useRef, type ReactNode } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import {
  Badge,
  Button,
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

const SECTION_ICONS: Record<ConsoleSection, BuiltinIconName> = {
  overview: "Target",
  decisions: "MessageQuestion",
  staff: "Bot",
  work: "ListTodo",
  memory: "Archive",
  system: "Workflow",
};

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
  graphs: "GitBranch",
  agents: "UserRoundPlus",
  schedules: "Clock",
  costs: "Zap",
  health: "CircleCheck",
  settings: "Code",
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
        className={`flex h-full min-h-0 min-w-0 flex-1 overflow-hidden ${compactNav ? "flex-col" : "flex-row"}`}
        data-testid="console-shell"
        data-lp-chrome={compactNav ? "compact" : "rail"}
        data-lp-stack={stackControls ? "1" : "0"}
        data-bb-ru-skip
      >
        {!compactNav ? (
          <nav
            className="flex w-[14.5rem] shrink-0 flex-col gap-3 overflow-y-auto border-r border-[var(--lp-hairline)] bg-[var(--lp-well)]/40 px-3 py-4"
            aria-label={t("consoleNavAria")}
            data-testid="console-sidebar"
          >
            <div className="flex flex-col gap-0.5" data-testid="console-nav">
              {CONSOLE_SECTIONS.map((section) => {
                const active =
                  section === "system"
                    ? route.section === "system" && !route.page
                    : route.section === section;
                return (
                  <Button
                    key={section}
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-current={active ? "page" : undefined}
                    data-testid={`console-nav-${section}`}
                    className="lp-nav-item h-8 w-full justify-start gap-2 px-2.5 text-sm hover:bg-state-hover"
                    onClick={() => goSection(section)}
                  >
                    <Icon name={SECTION_ICONS[section]} className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-left">{t(SECTION_LABELS[section])}</span>
                    {section === "decisions" && waitingBadge ? (
                      <Badge
                        variant="destructive"
                        className="ml-auto px-1.5 py-0 text-[11px] leading-5"
                        data-testid="decisions-badge"
                        aria-label={t("consoleDecisionsBadgeAria").replace("{n}", String(waitingBadge.count))}
                      >
                        {waitingBadge.label}
                      </Badge>
                    ) : null}
                  </Button>
                );
              })}
            </div>
            <div className="border-t border-[var(--lp-hairline)] pt-3" data-testid="console-nav-system-group">
              <div className="px-2.5 pb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("consoleNavSystem")}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {SYSTEM_PAGES.map((sysPage) => {
                  const active = route.section === "system" && route.page === sysPage;
                  return (
                    <Button
                      key={sysPage}
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-current={active ? "page" : undefined}
                      data-testid={`console-nav-system-${sysPage}`}
                      className="lp-nav-item h-8 w-full justify-start gap-2 px-2.5 text-sm hover:bg-state-hover"
                      onClick={() => goSystemPage(sysPage)}
                    >
                      <Icon name={SYSTEM_PAGE_ICONS[sysPage]} className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-left">{t(SYSTEM_PAGE_LABELS[sysPage])}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </nav>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--lp-hairline)] px-4 py-2.5 sm:px-6"
            data-testid="console-topbar"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {compactNav ? (
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
              ) : null}
              <ScopeSwitcher route={route} go={go} />
            </div>
            <div className="flex shrink-0 items-center gap-2" data-testid="console-header-extras">
              {headerExtras}
            </div>
          </header>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div ref={contentRef} className="w-full min-w-0 space-y-6 px-6 py-5" data-testid="console-content">
              {children}
            </div>
          </div>
        </div>
      </div>
    </PanelLayoutContext.Provider>
  );
}
