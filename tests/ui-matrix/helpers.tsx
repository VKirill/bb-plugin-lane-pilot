import { afterEach, beforeEach, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { cleanup, configure, fireEvent } from "@testing-library/react";
import { setLocaleOverride } from "@lane-pilot/i18n";

// Shared setup of the ui-matrix parts. Each part keeps its own vi.mock("sonner") (hoisted per file).

// Heavy UI files: under a loaded machine single tests passed 20 s (2026-10-07), like agent-access-ui.
vi.setConfig({ testTimeout: 60_000 });

// Under load React updates and debounced saves settle after the 1 s default; await the real condition instead.
configure({ asyncUtilTimeout: 10_000 });

// Each test mounts the whole settings page (about 0.8 s of jsdom rendering alone, 1-5 s with its waits; the first import of
// the app is 1.3 s). The per-test budget is the file's 60 s above: a describe-level `timeout: 20_000` used to override it,
// and under a parallel run (load 18-20) a different one of the 36 tests crossed 20 s each time. A test that times out keeps
// running and mounts its page into the next test's DOM, so the DOM is emptied before each test as well as after.
/** Registers the DOM clean-up hooks of the current describe block. */
export function useMatrixHooks() {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
  });
}

/** Opens the Team tab and the drawer of one role row; returns the drawer. */
export function openRole(slot: { getByTestId: (id: string) => HTMLElement }, role: string) {
  openTab(slot, "team");
  const opener = slot.getByTestId(`role-open-${role}`);
  if (opener.getAttribute("aria-expanded") !== "true") fireEvent.click(opener);
  return slot.getByTestId(`role-drawer-${role}`);
}
