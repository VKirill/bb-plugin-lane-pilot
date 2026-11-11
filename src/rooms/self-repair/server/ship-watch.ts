import { switchOn } from "@lane-pilot/models";
import type Database from "better-sqlite3";
import { bindingSettingValue, listProjectsWithBindingSettings, loadPrototypeConfig } from "../../storage";
import { closeOwnerItemsByPrefix, postOwnerItem } from "../../owner-waiting";

/** Ship lanes cadence (SMA k_lib_shiplane): commits and days a checkout may sit unshipped before the owner hears of it. */
export const SHIP_MAX_BATCH_COMMITS = 25;
export const SHIP_MAX_BATCH_DAYS = 3;
const WATCH_KEY = "ship-watch:";

function settingCap(db: Database.Database, projectId: string, key: string, fallback: number): number {
  const raw = bindingSettingValue(db as never, projectId, key);
  let parsed = NaN;
  try { parsed = raw ? Number(JSON.parse(raw)) : NaN; } catch { parsed = NaN; }
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** ship.watch is a switch: the sweep acts on a project only where it is "on"; unset, off or an unreadable value mean off. */
function watchIsOn(db: Database.Database, projectId: string): boolean {
  const raw = bindingSettingValue(db as never, projectId, "ship.watch");
  try { return switchOn({ "ship.watch": raw ? JSON.parse(raw) : undefined }, "ship.watch"); } catch { return false; }
}

/** Runs one shell command in a project's checkout on the machine that holds it: the hub never opens a project path itself. */
export type PileRun = (at: { hostId: string; cwd: string }, command: string) => Promise<{ exitCode: number; stdout: string }>;
const PILE_COMMAND = `tag=$(git describe --tags --abbrev=0 2>/dev/null) || exit 3; printf '%s\\n' "$tag"; git rev-list --count "$tag..HEAD"; git log -1 --format=%ct "$tag"`;

/** Commits and days since the checkout's last tag; null when it is no git repository, has no tag (nothing to measure) or its machine did not answer. */
export async function batchPile(run: PileRun, at: { hostId: string; cwd: string }, now = Date.now()): Promise<{ commits: number; days: number; tag: string } | null> {
  const out = await run(at, PILE_COMMAND);
  if (out.exitCode !== 0) return null;
  const [tag, commits, tagTime] = out.stdout.trim().split("\n");
  if (!tag || !/^\d+$/.test(commits ?? "") || !/^\d+$/.test(tagTime ?? "")) return null;
  return { commits: Number(commits), days: Math.floor((now / 1000 - Number(tagTime)) / 86400), tag };
}

/**
 * The daily background watch: for every project checkout, on the machine that holds it, it counts commits and days since the last tag
 * and (only where ship.watch is "on") posts one owner item per project whose pile passed ship.max_batch_commits / ship.max_batch_days; the item is
 * closed when the count falls (SMA k_lib_shiplane).
 */
export async function shipWatchSweep(db: Database.Database, run: PileRun, now = Date.now()): Promise<{ checked: number; flagged: string[] }> {
  const flagged: string[] = [];
  let checked = 0;
  for (const projectId of listProjectsWithBindingSettings(db)) {
    // One project with an unreadable row or a broken checkout must not end the sweep for the rest.
    try {
      if (!watchIsOn(db, projectId)) continue;
      const config = loadPrototypeConfig(db, projectId);
      const cwd = config?.pmWorkspacePath;
      if (!cwd || !config.hostId) continue;
      // An untagged checkout would count every commit since the first: no tag, nothing to measure.
      const pile = await batchPile(run, { hostId: config.hostId, cwd }, now).catch(() => null);
      if (!pile) continue;
      checked += 1;
      const maxCommits = settingCap(db, projectId, "ship.max_batch_commits", SHIP_MAX_BATCH_COMMITS);
      const maxDays = settingCap(db, projectId, "ship.max_batch_days", SHIP_MAX_BATCH_DAYS);
      const over = [pile.commits > maxCommits ? `${pile.commits} commits over ${maxCommits}` : "", pile.days > maxDays ? `${pile.days} days over ${maxDays}` : ""].filter(Boolean);
      if (!over.length) {
        closeOwnerItemsByPrefix(db, `${WATCH_KEY}${projectId}:`, "janitor: ship pile fell under the cap", now);
        continue;
      }
      flagged.push(projectId);
      postOwnerItem(db, { key: `${WATCH_KEY}${projectId}:`, source: "ship-watch", kind: "ship_batch", projectId, wake: false,
        what: `В проекте накопилось невыложенное: ${over.join(", ")} с ${pile.tag}. Выложите партию (sma batch или ship-lane).`,
        why: "Полоса отгрузки держит партии маленькими: сотня коммитов за раз — это риск, а не релиз.",
        evidence: [{ kind: "file", ref: cwd }] });
    } catch { continue; }
  }
  return { checked, flagged };
}
