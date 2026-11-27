import { fireEvent } from "@testing-library/react";
import { CONSOLE_SECTIONS, SYSTEM_PAGES, resolveLegacyRoute } from "../src/rooms/pages/models/nav-model";

type TabSlot = {
  findByTestId: (id: string) => Promise<HTMLElement>;
  getByTestId: (id: string) => HTMLElement;
  queryByTestId?: (id: string) => HTMLElement | null;
};

/**
 * Resolves a legacy tab/segment id via `resolveLegacyRoute` and clicks the matching console navigation entry
 * (plus any project scope or sub-view segment needed to reach the same component in the new console).
 */
export function openTab(slot: Pick<TabSlot, "getByTestId"> & Partial<Pick<TabSlot, "queryByTestId">>, id: string, segment?: string) {
  const subPath = segment ? `${id}/${segment}` : id;
  const route = resolveLegacyRoute(subPath) ?? { section: "overview" as const };
  if (route.projectId) {
    const switcher = slot.queryByTestId?.("scope-switcher");
    if (switcher) {
      fireEvent.click(switcher);
      const option = slot.queryByTestId?.(`scope-project-${route.projectId}`);
      if (option) fireEvent.click(option);
    }
  }
  const navId =
    route.section === "system" && route.page
      ? `console-nav-system-${route.page}`
      : `console-nav-${route.section}`;
  fireEvent.click(slot.getByTestId(navId));

  if (route.section === "work" && route.view) {
    const seg = slot.queryByTestId?.(`seg-work-view-${route.view}`);
    if (seg) fireEvent.click(seg);
  } else if (route.section === "decisions" && route.view) {
    const seg = slot.queryByTestId?.(`seg-decisions-view-${route.view}`);
    if (seg) fireEvent.click(seg);
  } else if (route.section === "system" && route.page === "settings" && route.view === "docs") {
    fireEvent.click(slot.getByTestId("seg-knowledge-docs"));
  }
}

/** Visits every console section and system page once, as an owner browsing would, and comes back to the overview. */
export async function openAllTabs(slot: TabSlot) {
  await slot.findByTestId("console-shell");
  for (const section of CONSOLE_SECTIONS) fireEvent.click(slot.getByTestId(`console-nav-${section}`));
  for (const page of SYSTEM_PAGES) fireEvent.click(slot.getByTestId(`console-nav-system-${page}`));
  fireEvent.click(slot.getByTestId("console-nav-overview"));
}
