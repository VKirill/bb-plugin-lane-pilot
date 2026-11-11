import { join } from "node:path";
import type { ServerCore } from "../../contracts/server";

export type MergedTaskInfo = {
  taskId: string;
  commitSha: string;
  threadId: string | null;
  attemptId: string | null;
  produced: string[];
};

/**
 * Parses static imports from file content to trace dependency to changed files.
 */
export function extractStaticImports(source: string): string[] {
  const imported = new Set<string>();
  const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    if (match[1]) imported.add(match[1]);
  }
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(source)) !== null) {
    if (match[1]) imported.add(match[1]);
  }
  return [...imported];
}

/**
 * Reads a file of the project checkout, relative to its root, on the machine that holds it; null when it cannot be read.
 * The project may live on another host: the hub never opens its path.
 */
export type ProjectFileReader = (relativePath: string) => Promise<string | null>;

/**
 * Checks if a failing file is related to a merged task by checking:
 * 1. Did the task touch/produce this file directly?
 * 2. Did the task touch/produce a file imported by this failing file?
 */
export async function isFileRelatedToTask(
  failingFile: string,
  taskProduced: string[],
  readProjectFile: ProjectFileReader
): Promise<boolean> {
  const norm = (p: string) => p.replace(/^\.\//, "").trim();
  const failingNorm = norm(failingFile);
  const taskProducedSet = new Set(taskProduced.map(norm));

  if (taskProducedSet.has(failingNorm)) return true;

  // Check imports in failingFile if it can be read
  try {
    const content = await readProjectFile(failingNorm);
    if (content === null) throw new Error("unreadable");
    const rawImports = extractStaticImports(content);
    for (const imp of rawImports) {
      if (imp.startsWith(".")) {
        // Resolve relative to failingNorm
        const failingDir = failingNorm.includes("/") ? failingNorm.slice(0, failingNorm.lastIndexOf("/")) : "";
        const candidateBase = join(failingDir, imp).replace(/^\.\//, "");
        for (const prod of taskProducedSet) {
          const prodNoExt = prod.replace(/\.[^/.]+$/, "");
          if (candidateBase === prod || candidateBase === prodNoExt || prod.startsWith(candidateBase)) {
            return true;
          }
        }
      } else {
        for (const prod of taskProducedSet) {
          if (prod.includes(imp)) return true;
        }
      }
    }
  } catch {
    // Cannot read file, check basic substring/basename relation
    for (const prod of taskProducedSet) {
      if (prod.includes(failingNorm) || failingNorm.includes(prod)) return true;
    }
  }

  return false;
}

export async function findCulpritByFiles(
  failingFiles: string[],
  mergedTasks: MergedTaskInfo[],
  readProjectFile: ProjectFileReader
): Promise<MergedTaskInfo | null> {
  if (mergedTasks.length === 0) return null;
  if (failingFiles.length === 0) return null;

  const matchingTasks = new Set<MergedTaskInfo>();

  for (const task of mergedTasks) {
    for (const file of failingFiles) {
      if (await isFileRelatedToTask(file, task.produced, readProjectFile)) {
        matchingTasks.add(task);
        break;
      }
    }
  }

  if (matchingTasks.size === 1) {
    return [...matchingTasks][0]!;
  }
  return null;
}

/**
 * Fallback: bisect over the commits of mergedTasks with the gate command, as one host job on the project's machine (a
 * scratch worktree there; the checkout itself is not moved). Null when the host cannot name a first bad commit.
 */
export async function bisectCulprit(
  host: ServerCore["host"],
  hostId: string,
  gateCommand: string,
  goodSha: string,
  badSha: string,
  basePath: string,
  mergedTasks: MergedTaskInfo[],
  timeoutMs = 30 * 60_000
): Promise<MergedTaskInfo | null> {
  try {
    const found = await host.call("gateBisect", {
      requestedHostId: hostId, basePath, command: gateCommand, goodSha, badSha, timeoutSec: Math.ceil(timeoutMs / 1000),
    }, { hostId, timeoutMs: timeoutMs + 60_000 });
    if (found.status !== "found" || !found.commit) return null;
    const badCommit = found.commit;
    return mergedTasks.find((t) => t.commitSha.startsWith(badCommit) || badCommit.startsWith(t.commitSha)) ?? null;
  } catch {
    return null;
  }
}
