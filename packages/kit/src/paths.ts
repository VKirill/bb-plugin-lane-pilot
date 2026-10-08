import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveHome(homeDir?: string): string {
  return homeDir ?? process.env.HOME ?? homedir();
}

export function expandHomePath(path: string, homeDir?: string): string {
  const home = resolveHome(homeDir);
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path.replaceAll("$HOME", home);
}

export function agentsDir(homeDir?: string): string {
  return join(resolveHome(homeDir), ".agents");
}

export function lanePilotRoot(homeDir?: string): string {
  return join(agentsDir(homeDir), "lane-pilot");
}

export function upstreamDir(sha: string, homeDir?: string): string {
  return join(lanePilotRoot(homeDir), "upstream", sha);
}

export function managedEngineDir(sha: string, homeDir?: string): string {
  return join(lanePilotRoot(homeDir), "engines", sha);
}

/** The plugin root above the nearest src/ or dist/ folder of a module (dist/host.js, src/x.ts, src/rooms/<room>/x.ts); the folder itself when there is none. */
export function pluginRootFromModule(moduleUrl: string): string {
  const here = fileURLToPath(new URL(".", moduleUrl));
  for (let dir = here.replace(/[\\/]$/, ""); ; dir = dirname(dir)) {
    if (basename(dir) === "src" || basename(dir) === "dist") return dirname(dir);
    if (dirname(dir) === dir) return here;
  }
}

export function defaultLocalFallback(moduleUrl: string): string {
  return join(
    pluginRootFromModule(moduleUrl),
    ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack",
  );
}

export function defaultGuardSource(moduleUrl: string): string {
  return join(pluginRootFromModule(moduleUrl), "lane-stack/hooks/guard_shell.py");
}
