import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EXTERNAL_OPS } from "./constants";

const execFileAsync = promisify(execFile);

export type ExternalOpsSnapshot = Record<string, string | null>;

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, { encoding: "utf8", timeout: 15_000, env });
    return result.stdout.trim() || result.stderr.trim() || "";
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; message?: string };
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    return text || err.message || "unavailable";
  }
}

export async function observeExternalOps(homeDir?: string): Promise<ExternalOpsSnapshot> {
  const env = { ...process.env, ...(homeDir ? { HOME: homeDir } : {}) };
  const npm = await run("npm", ["ls", "-g", "@rama_nigg/open-cursor", "--json"], env);
  const plugins = await run("claude", ["plugin", "list"], env);
  const markets = await run("claude", ["plugin", "marketplace", "list"], env);
  return {
    [EXTERNAL_OPS[0]]: npm,
    [EXTERNAL_OPS[1]]: npm,
    [EXTERNAL_OPS[2]]: markets,
    [EXTERNAL_OPS[3]]: plugins,
    [EXTERNAL_OPS[4]]: plugins,
  };
}
