import { homedir } from "node:os";
import { join } from "node:path";
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

export function pluginRootFromModule(moduleUrl: string): string {
  const here = fileURLToPath(new URL(".", moduleUrl));
  if (here.endsWith("/src/") || here.endsWith("/src")) return join(here, "..");
  if (here.endsWith("/dist/") || here.endsWith("/dist")) return join(here, "..");
  return here;
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
