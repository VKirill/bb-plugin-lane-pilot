import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Buffer } from "./hash";
import { resolveHome } from "./paths";

export type ImportedConfig = {
  routingProfile: { path: string; text: string; sha256: string } | null;
  nightShift: { path: string; text: string; sha256: string } | null;
};

async function readOptional(path: string): Promise<{ path: string; text: string; sha256: string } | null> {
  try {
    const text = await readFile(path, "utf8");
    return { path, text, sha256: sha256Buffer(text) };
  } catch {
    return null;
  }
}

export async function readImportConfig(input: {
  homeDir?: string;
  workspacePath?: string;
}): Promise<ImportedConfig> {
  const home = resolveHome(input.homeDir);
  const roots = [join(home, ".agents")];
  if (input.workspacePath) roots.push(join(input.workspacePath, ".agents"));
  let routingProfile: ImportedConfig["routingProfile"] = null;
  let nightShift: ImportedConfig["nightShift"] = null;
  for (const root of roots) {
    routingProfile ??= await readOptional(join(root, "routing.profile.yaml"));
    nightShift ??= await readOptional(join(root, "night-shift.yaml"));
  }
  return { routingProfile, nightShift };
}
