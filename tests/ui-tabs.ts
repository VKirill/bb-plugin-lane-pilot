import { fireEvent } from "@testing-library/react";
import { resolveTab, TAB_IDS } from "../src/rooms/ui-shell/ui/tabs-model";

type TabSlot = { findByTestId: (id: string) => Promise<HTMLElement>; getByTestId: (id: string) => HTMLElement };

/**
 * The page mounts a tab when it is first opened; Radix triggers react to a primary-button mousedown.
 * The id may be one of the six tabs or one of the ten the page had before: an old id opens the tab and the segment where it lives now.
 */
export function openTab(slot: Pick<TabSlot, "getByTestId">, id: string, segment?: string) {
  const target = resolveTab(id);
  const trigger = slot.getByTestId(`tab-${target.tab}`);
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const part = segment ?? target.segment;
  if (part) fireEvent.click(slot.getByTestId(`seg-${target.tab}-${part}`));
}

/** Opens every tab of a project once, as an owner browsing would, and comes back to the overview. */
export async function openAllTabs(slot: TabSlot) {
  await slot.findByTestId("tab-team");
  for (const id of TAB_IDS) fireEvent.mouseDown(slot.getByTestId(`tab-${id}`), { button: 0 });
  fireEvent.mouseDown(slot.getByTestId("tab-overview"), { button: 0 });
}
