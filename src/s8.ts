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

export type S8Stash = { dir: string; existed: string[] };

export async function hideS8Files(homeDir?: string, stashDir?: string): Promise<S8Stash> {
  const home = resolveHome(homeDir);
  const stash = stashDir ?? join(home, ".agents/lane-pilot/s8-stash");
  await mkdir(stash, { recursive: true });
  const existed: string[] = [];
  for (const rel of S8_RELATIVE_PATHS) {
    const src = join(home, rel);
    const dest = join(stash, rel);
    if ((await sha256FileOrNull(src)) === null) continue;
    existed.push(rel);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest);
    await rm(src, { force: true });
  }
  return { dir: stash, existed };
}

export async function restoreS8Files(stash: S8Stash | string, homeDir?: string): Promise<S8Hashes> {
  const home = resolveHome(homeDir);
  const dir = typeof stash === "string" ? stash : stash.dir;
  const existed = typeof stash === "string" ? null : stash.existed;
  for (const rel of S8_RELATIVE_PATHS) {
    const dest = join(home, rel);
    const src = join(dir, rel);
    const hadFile = existed ? existed.includes(rel) : (await sha256FileOrNull(src)) !== null;
    if (hadFile) {
      await mkdir(dirname(dest), { recursive: true });
      await rm(dest, { force: true });
      await cp(src, dest);
    } else {
      await rm(dest, { force: true });
    }
  }
  await rm(dir, { recursive: true, force: true });
  return s8Hashes(home);
}
