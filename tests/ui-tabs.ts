import { fireEvent } from "@testing-library/react";

type TabSlot = { findByTestId: (id: string) => Promise<HTMLElement>; getByTestId: (id: string) => HTMLElement };

/** The page mounts a tab when it is first opened; Radix triggers react to a primary-button mousedown. */
export function openTab(slot: Pick<TabSlot, "getByTestId">, id: string) {
  const trigger = slot.getByTestId(`tab-${id}`);
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
}

/** Opens every tab of a project once, as an owner browsing would, and comes back to the overview. */
export async function openAllTabs(slot: TabSlot) {
  await slot.findByTestId("tab-settings");
  for (const id of ["settings", "checks", "council", "memory", "access", "rules", "workflows", "monitor", "service"]) fireEvent.mouseDown(slot.getByTestId(`tab-${id}`), { button: 0 });
  fireEvent.mouseDown(slot.getByTestId("tab-overview"), { button: 0 });
}
