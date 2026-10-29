import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname, join } from "node:path";
import { cp, lstat, mkdir } from "node:fs/promises";
import { defaultGuardSource } from "@lane-pilot/kit";
import { ownedPmGuardPath } from "./guard-apply";
import { materializeAgentTrash } from "../writer";

const execute = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function which(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return execute("/bin/sh", ["-c", `command -v ${name}`], { env }).then((result) => Boolean(result.stdout.trim()), () => false);
}

/** The host daemon may run with a bare PATH; Lane Pilot's bins live under the user's home. */
export function lanePilotEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bins = [join(home, ".local/bin"), join(home, ".agents/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return { ...base, HOME: home, PATH: [...bins, base.PATH ?? "/usr/bin:/bin"].join(delimiter) };
}

/** Lane Pilot's own tools in ~/.agents/lane-pilot/bin (agent-trash). No Claude Lane checkout and no install.sh. (2026-10-30) */
export async function materializeOwnTools(home: string): Promise<void> {
  await materializeAgentTrash({ homeDir: home, moduleUrl: import.meta.url });
}

/** Copies Lane Pilot's guard into its own directory. Does not register a machine-wide hook. */
export async function placeLanePilotGuard(home: string): Promise<void> {
  const source = defaultGuardSource(import.meta.url);
  if (!await exists(source)) return;
  const dest = ownedPmGuardPath(home);
  if (!await exists(dest)) {
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest);
  }
  const libSource = join(dirname(source), "lib_payload.py");
  const libDest = join(dirname(dest), "lib_payload.py");
  if (await exists(libSource) && !await exists(libDest)) await cp(libSource, libDest);
}

/**
 * Installed when Lane Pilot's own guard is on disk.
 * The OpenCode plugin is required only when this home already has an OpenCode config and the opencode2 binary.
 */
export async function detectOwnInstall(home: string, env: NodeJS.ProcessEnv = lanePilotEnv(home)): Promise<{ guard: true; openCode: boolean } | null> {
  if (!await exists(ownedPmGuardPath(home))) return null;
  const openCodeDir = join(home, ".config/opencode");
  const hasConfig = await exists(join(openCodeDir, "opencode.jsonc")) || await exists(join(openCodeDir, "opencode.json"));
  const plugin = await exists(join(openCodeDir, "plugins/opencode-lane.ts"));
  if (hasConfig && await which("opencode2", env) && !plugin) return null;
  return { guard: true, openCode: plugin };
}
