import { parseExecutionLineWindows, type PathWindows } from "../../contracts";

export type ReadFirstHint = PathWindows;

export type ReadFirstScope = "workspace" | "repo";
export const READ_FIRST_REPO_SELECTOR = "repo:";
const READ_FIRST_PROTECTED = new Set([".git", ".agents", ".bb"]);

/** Splits the canonical `repo:` selector off a stored read_first path; the remainder resolves against the repository root. */
export function parseReadFirstSelector(path: string): { scope: ReadFirstScope; path: string } {
  path=path.trim().replace(/^\.\//, "");
  return path.startsWith(READ_FIRST_REPO_SELECTOR)
    ? { scope: "repo", path: path.slice(READ_FIRST_REPO_SELECTOR.length) }
    : { scope: "workspace", path };
}

function safeHintPath(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !/^[A-Za-z]:/.test(path);
}

export function parseReadFirstHints(rawHints:string[]):ReadFirstHint[] {
  return rawHints.map((raw) => {
    const text=raw.trim().replace(/^\.\//, "");
    const repo=text.startsWith(READ_FIRST_REPO_SELECTOR);
    // The line-window parser trims trailing colons: keep an empty repo: selector distinguishable from a file named repo.
    const hint = parseExecutionLineWindows(repo?text.slice(READ_FIRST_REPO_SELECTOR.length):raw);
    const path = hint.path.replace(/^\.\//, "");
    if (repo) {
      const rel = path;
      if (!safeHintPath(rel) || rel.split("/").some((part)=>!part||part===".") || rel.startsWith(READ_FIRST_REPO_SELECTOR)) {
        throw new Error(`read_first repo: source must be a repository-relative path with optional line windows: ${raw}`);
      }
      if (rel.split("/").some((segment) => READ_FIRST_PROTECTED.has(segment.toLowerCase()))) {
        throw new Error(`read_first repo: source must not cross protected folders (.git, .agents, .bb): ${raw}`);
      }
      return { ...hint, path: `${READ_FIRST_REPO_SELECTOR}${rel}` };
    }
    if (!safeHintPath(path)) {
      throw new Error(`read_first must be a project-relative path with optional line windows: ${raw}`);
    }
    return { ...hint, path };
  });
}

export function kindForReadFirstPath(
  hintPath: string,
  entries: Array<{ path: string; kind: "file" | "directory" }>,
): "file" | "directory" | undefined {
  const normalized = hintPath.replace(/^\.\//, "");
  return entries.find((row) => row.path.replace(/^\.\//, "") === normalized)?.kind;
}

export function readFirstKindError(
  path: string,
  kind: "file" | "directory" | undefined,
): string | undefined {
  if (kind === "file") return undefined;
  if (kind === "directory") return `read_first is a directory, not a file: ${path}`;
  return `read_first source is missing: ${path}`;
}

export function renderReadFirstInstructions(rawHints:string[]):string {
  const hints = parseReadFirstHints(rawHints);
  return [
    "Before editing, inspect the listed files. A path with line windows limits the initial read to those 1-based inclusive ranges; open surrounding context only when required by the task.",
    JSON.stringify(hints, null, 2),
  ].join("\n");
}
