import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultGuardSource } from "./paths";

export async function applyInstalledGuard(input: {
  homeDir: string;
  guardSourcePath?: string;
  moduleUrl?: string;
  pmWorkspacePath?: string;
}): Promise<{ guardPath: string; settingsPath: string | null }> {
  const source = input.guardSourcePath
    ?? (input.moduleUrl ? defaultGuardSource(input.moduleUrl) : "");
  if (!source) throw new Error("guard source path is required");
  const guardPath = join(input.homeDir, ".agents/hooks/guard_shell.py");
  await mkdir(dirname(guardPath), { recursive: true });
  await cp(source, guardPath);
  const libSource = join(dirname(source), "lib_payload.py");
  const libDest = join(dirname(guardPath), "lib_payload.py");
  try {
    await cp(libSource, libDest);
  } catch {
    /* upstream install.sh already copied lib_payload */
  }
  let settingsPath: string | null = null;
  if (input.pmWorkspacePath) {
    settingsPath = join(input.pmWorkspacePath, ".claude/settings.json");
    try {
      const raw = await readFile(settingsPath, "utf8");
      const next = raw.replace(
        /\/[^\s"]+\/lane-stack\/hooks\/guard_shell\.py/g,
        guardPath,
      );
      if (next !== raw) await writeFile(settingsPath, next);
    } catch {
      settingsPath = null;
    }
  }
  return { guardPath, settingsPath };
}
