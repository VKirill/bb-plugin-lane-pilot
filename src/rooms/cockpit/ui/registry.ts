import type { I18nKey } from "@lane-pilot/i18n";

/**
 * The screen registry (SMA map: Screen registry, Open a screen by event, Placeholder «screen being built», Wide window only): every screen
 * of the cockpit with its title, whether it needs a wide window, and the events that open it. A path `event/<kind>` opens the screen the
 * event belongs to; an unknown screen is the placeholder, never a blank page.
 */
export const SCREENS = [
  { id: "home", title: "ckScreen_home", wide: false, events: [] },
  { id: "phases", title: "ckScreen_phases", wide: false, events: ["phase", "word", "uat"] },
  { id: "today", title: "ckScreen_today", wide: false, events: ["day"] },
  { id: "tasks", title: "ckScreen_tasks", wide: false, events: ["task", "queue", "backlog"] },
  { id: "money", title: "ckScreen_money", wide: false, events: ["money", "window"] },
  { id: "workers", title: "ckScreen_workers", wide: false, events: ["worker", "lane", "designer"] },
  { id: "forge", title: "ckScreen_forge", wide: false, events: ["forge", "helpers"] },
  { id: "memory", title: "ckScreen_memory", wide: false, events: ["memory"] },
  { id: "firstrun", title: "ckScreen_firstrun", wide: false, events: ["onboarding"] },
  { id: "coord", title: "ckScreen_coord", wide: true, events: ["claim"] },
  { id: "ship", title: "ckScreen_ship", wide: false, events: ["ship", "release"] },
  { id: "system", title: "ckScreen_system", wide: false, events: ["fault", "peer", "door"] },
  { id: "registry", title: "ckScreen_registry", wide: false, events: [] },
] as const satisfies ReadonlyArray<{ id: string; title: I18nKey; wide: boolean; events: readonly string[] }>;
export type ScreenId = (typeof SCREENS)[number]["id"];

/** The screen a sub-path opens: `phases`, `event/uat` → phases; anything unknown → the placeholder. */
export function screenFor(subPath: string): { id: ScreenId | "building"; param: string | null } {
  const [head, rest] = subPath.replace(/^\/+/, "").split("/", 2) as [string, string | undefined];
  if (!head) return { id: "home", param: null };
  if (head === "event") {
    const found = SCREENS.find((screen) => (screen.events as readonly string[]).includes(rest ?? ""));
    return found ? { id: found.id, param: null } : { id: "building", param: rest ?? null };
  }
  const found = SCREENS.find((screen) => screen.id === head);
  return found ? { id: found.id, param: rest ?? null } : { id: "building", param: head };
}

/** Reads no screen calls (SMA: Three reads never called): the read RPCs of the contract that no screen of the window uses. */
export function unusedReads(contractNames: readonly string[], used: readonly string[]): string[] {
  const reads = contractNames.filter((name) => /^(get_|list_|cockpit_today|cockpit_workers|cockpit_designer|peers_list|door_audience|actions_recent|phase_list|phase_get|owner_waiting|money_status|first_run_get|helpers_list|coord_status|cockpit_seen_list)/.test(name));
  return reads.filter((name) => !used.includes(name));
}

/** The reads the cockpit's screens call — the registry's side of the «never called» check. */
export const COCKPIT_READS = ["phase_list", "phase_get", "cockpit_today", "cockpit_workers", "cockpit_designer", "cockpit_windows", "money_status", "owner_waiting", "first_run_get",
  "helpers_list", "coord_status", "peers_list", "door_audience", "actions_recent", "cockpit_seen_list", "list_projects", "get_screen", "task_card"] as const;
