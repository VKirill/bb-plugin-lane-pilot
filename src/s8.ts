import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S8_RELATIVE_PATHS } from "./constants";
import { sha256FileOrNull } from "./hash";
import { resolveHome } from "./paths";

export type S8Hashes = Record<string, string | null>;

export async function s8Hashes(homeDir?: string): Promise<S8Hashes> {
  const home = resolveHome(homeDir);
  const result: S8Hashes = {};
  for (const rel of S8_RELATIVE_PATHS) {
    const path = join(home, rel);
    result[path] = await sha256FileOrNull(path);
  }
  return result;
}

export async function hideS8Files(homeDir?: string, stashDir?: string): Promise<string> {
  const home = resolveHome(homeDir);
  const stash = stashDir ?? join(home, ".agents/lane-pilot/s8-stash");
  await mkdir(stash, { recursive: true });
  for (const rel of S8_RELATIVE_PATHS) {
    const src = join(home, rel);
    const dest = join(stash, rel);
    if ((await sha256FileOrNull(src)) === null) continue;
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest);
    await rm(src, { force: true });
  }
  return stash;
}

export async function restoreS8Files(stashDir: string, homeDir?: string): Promise<S8Hashes> {
  const home = resolveHome(homeDir);
  for (const rel of S8_RELATIVE_PATHS) {
    const dest = join(home, rel);
    const src = join(stashDir, rel);
    if ((await sha256FileOrNull(src)) === null) continue;
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { force: true });
    await cp(src, dest);
  }
  await rm(stashDir, { recursive: true, force: true });
  return s8Hashes(home);
}
