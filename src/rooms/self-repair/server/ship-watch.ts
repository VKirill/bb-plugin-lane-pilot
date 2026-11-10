import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { bindingSettingValue, listProjectsWithBindingSettings, loadPrototypeConfig } from "../../storage";
import { closeOwnerItemsByPrefix, postOwnerItem } from "../../owner-waiting";

/** Ship lanes cadence (SMA k_lib_shiplane): commits and days a checkout may sit unshipped before the owner hears of it. */
export const SHIP_MAX_BATCH_COMMITS = 25;
export const SHIP_MAX_BATCH_DAYS = 3;
const WATCH_KEY = "ship-watch:";

function settingCap(db: Database.Database, projectId: string, key: string, fallback: number): number {
  const raw = bindingSettingValue(db as never, projectId, key);
  const parsed = raw ? Number(JSON.parse(raw)) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Commits and days since the checkout's last tag; null when the path is not a git repository on this machine. */
export function batchPile(cwd: string, now = Date.now()): { commits: number; days: number; tag: string | null } | null {
  if (!existsSync(join(cwd, ".git"))) return null;
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
  let tag: string | null = null;
  try { tag = git("describe", "--tags", "--abbrev=0"); } catch { tag = null; }
  const commits = Number(git("rev-list", "--count", tag ? `${tag}..HEAD` : "HEAD"));
  const tagTime = tag ? Number(git("log", "-1", "--format=%ct", tag)) : Number(git("log", "--format=%ct", "--reverse").split("\n")[0] || "0");
  return { commits, days: Math.floor((now / 1000 - tagTime) / 86400), tag };
}

/**
 * The daily background watch: for every project checkout on this machine it counts commits and days since the last tag
 * and posts one owner item per project whose pile passed ship.max_batch_commits / ship.max_batch_days; the item is
 * closed when the count falls (SMA k_lib_shiplane).
 */
export function shipWatchSweep(db: Database.Database, now = Date.now()): { checked: number; flagged: string[] } {
  const flagged: string[] = [];
  let checked = 0;
  for (const projectId of listProjectsWithBindingSettings(db)) {
    const config = loadPrototypeConfig(db, projectId);
    const cwd = config?.pmWorkspacePath;
    if (!cwd) continue;
    let pile: ReturnType<typeof batchPile> = null;
    try { pile = batchPile(cwd, now); } catch { pile = null; }
    if (!pile) continue;
    checked += 1;
    const maxCommits = settingCap(db, projectId, "ship.max_batch_commits", SHIP_MAX_BATCH_COMMITS);
    const maxDays = settingCap(db, projectId, "ship.max_batch_days", SHIP_MAX_BATCH_DAYS);
    const over = [pile.commits > maxCommits ? `${pile.commits} commits over ${maxCommits}` : "", pile.days > maxDays ? `${pile.days} days over ${maxDays}` : ""].filter(Boolean);
    if (!over.length) {
      closeOwnerItemsByPrefix(db, `${WATCH_KEY}${projectId}`, "janitor: ship pile fell under the cap", now);
      continue;
    }
    flagged.push(projectId);
    postOwnerItem(db, { key: `${WATCH_KEY}${projectId}`, source: "ship-watch", kind: "ship_batch", projectId, wake: false,
      what: `В проекте накопилось невыложенное: ${over.join(", ")} с ${pile.tag ?? "начала"}. Выложите партию (sma batch или ship-lane).`,
      why: "Полоса отгрузки держит партии маленькими: сотня коммитов за раз — это риск, а не релиз.",
      evidence: [{ kind: "file", ref: cwd }] });
  }
  return { checked, flagged };
}
