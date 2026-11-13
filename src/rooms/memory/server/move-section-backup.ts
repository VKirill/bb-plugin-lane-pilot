import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where `memory move-section --apply` leaves the rows it is about to change: next to the plugin's database on the machine that runs the command. */
export const moveSectionBackupDir = (): string => process.env.LANE_PILOT_BACKUP_DIR || join(homedir(), ".bb", "plugins", "lane-pilot", "backups");

/** Writes the backup JSON (mode 0600: it holds note text) and returns its path. */
export function writeMoveSectionBackup(json: string, dir = moveSectionBackupDir(), now = Date.now()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `move-section-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, json, { mode: 0o600 });
  return path;
}
