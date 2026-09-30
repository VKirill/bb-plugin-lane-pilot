import { parseExecutionLineWindows, type PathWindows } from "../upstream-adapter/capabilities";

export type ReadFirstHint = PathWindows;

export function parseReadFirstHints(rawHints:string[]):ReadFirstHint[] {
  return rawHints.map((raw) => {
    const hint = parseExecutionLineWindows(raw);
    const path = hint.path.replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || /^[A-Za-z]:/.test(path)) {
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
