import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const HOST_GLOBAL_PREFIXES = ["/opt/homebrew", "/usr/local"];

const SAFE_TOOLS = ["python3", "rsync", "git", "bash", "node", "flock"] as const;

export type GlobalOpenCursorState = {
  prefix: string;
  packageDir: string;
  packageExists: boolean;
  packageJsonSha256: string | null;
  bins: Record<string, boolean>;
};

export function hostGlobalPrefixes(): string[] {
  return HOST_GLOBAL_PREFIXES.filter((prefix) => existsSync(join(prefix, "lib/node_modules")) || existsSync(join(prefix, "bin")));
}

export function hostHasOpenCursorPackage(): boolean {
  return HOST_GLOBAL_PREFIXES.some((prefix) => existsSync(join(prefix, "lib/node_modules/@rama_nigg/open-cursor")));
}

export function snapshotGlobalOpenCursor(): GlobalOpenCursorState {
  const prefix = hostGlobalPrefixes()[0] ?? "/opt/homebrew";
  const packageDir = join(prefix, "lib/node_modules/@rama_nigg/open-cursor");
  const packageJson = join(packageDir, "package.json");
  let packageJsonSha256: string | null = null;
  if (existsSync(packageJson)) {
    packageJsonSha256 = execFileSync("shasum", ["-a", "256", packageJson], {
      encoding: "utf8",
    }).split(/\s+/)[0] ?? null;
  }
  return {
    prefix,
    packageDir,
    packageExists: existsSync(packageDir),
    packageJsonSha256,
    bins: {
      "open-cursor": existsSync(join(prefix, "bin/open-cursor")),
      "cursor-discover": existsSync(join(prefix, "bin/cursor-discover")),
      mcptool: existsSync(join(prefix, "bin/mcptool")),
    },
  };
}

export function isolatedTestPath(dirs: string[]): string {
  return [...dirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function linkSafeTools(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const tool of SAFE_TOOLS) {
    const real = findOnPath(tool);
    if (!real) continue;
    const dest = join(dir, tool);
    if (existsSync(dest)) continue;
    symlinkSync(real, dest);
  }
}
